/**
 * Tests for `application/discord-service.ts` (port of `DiscordService.java`).
 *
 * Nothing here touches the network: the Discord transport is the *real* `DiscordClient` with an
 * injected fake `DiscordGateway` (the same seam `test/infra/discord/client.test.ts` uses) and an
 * injected `fetch` for the CDN downloads. The heavier DuckDB-facing collaborators
 * (`SessionService` / `LapService` / `LapExportService` / `SetupService` / `SvmExporter`) are the
 * ports this service declares, so the orchestration — argument pass-through, call order, the
 * response JSON, the temp-file lifecycle and the error mapping — is what gets asserted.
 * `AppPaths`, `DiscordConfig` and `CarCatalog` stay real: they are cheap, and the file-name and
 * token-leak assertions are only meaningful against them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { LapInfo, LapsResponse, SessionMetadata } from '../../src/domain/types.js';
import {
  DiscordService,
  type DiscordCarCatalog,
  type DiscordLapExporter,
  type DiscordLapHeader,
  type DiscordMetadataReader,
  type DiscordSvmGenerator,
} from '../../src/application/discord-service.js';
import { ApiException } from '../../src/api/error.js';
import type { DiscordDownloadRequest, DiscordShareRequest } from '../../src/api/dto.js';
import { CarCatalog } from '../../src/infra/car/car-catalog.js';
import {
  DiscordClient,
  type DiscordGateway,
  type DiscordGatewayFactory,
  type GatewayAttachmentSnapshot,
  type GatewayForumPostRequest,
  type GatewayMemberSnapshot,
  type GatewayMessageSnapshot,
  type GatewayThreadSnapshot,
  type GatewayUserSummary,
} from '../../src/infra/discord/client.js';
import {
  DEFAULT_INVITE_URL,
  DISCORD_CONFIG_FILE_NAME,
  DiscordConfig,
} from '../../src/infra/discord/config.js';
import type { AppPaths } from '../../src/infra/fs/app-paths.js';
import { SessionRepository } from '../../src/infra/fs/session-repository.js';
import type { Logger } from '../../src/lib/log.js';
import type { ExportResult } from '../../src/application/lap-export-service.js';
import { cleanupLapFixtures, fixturePaths } from './fixtures.js';

const FAKE_TOKEN = 'mtI3NzQyNTYyODI0MzYwNjI3MQ.GaBcDe.fGenoIjKlMnOpQrStUvWxYz1234567890abcde';
const GUILD = '1496410659557081098';
const CHANNEL = '1505950451114311730';
const CAR_CLASS = 'lmgt3-telemetry-sharing';
const TAG_ID = '2001';
const DUCKDB_URL = 'https://cdn.discordapp.com/attachments/1505950451114311730/1/Session.duckdb';
const SVM_URL = 'https://media.discordapp.net/attachments/1505950451114311730/1/setup.svm';
const SESSION_ID = 'main-session.duckdb';
/** The Java file-name rule for the generated setup file, with this fixture's metadata. */
const SETUP_FILE = 'Default_McLaren-720S-GT3-Evo_Session-42_setup.svm';
/** `DiscordClient`'s gateway is lazy; a fixed clock keeps the 60 s shares cache deterministic. */
const NOW = 1_000_000;

const VALID_CONFIG_FILE = {
  bot_token: FAKE_TOKEN,
  guild_id: GUILD,
  invite_url: 'https://discord.gg/zNPehXA3jK',
  channels: { [CAR_CLASS]: CHANNEL },
};

// ---------------------------------------------------------------------------
// Fake gateway + fake fetch
// ---------------------------------------------------------------------------

/** What the service handed to the upload, observed at the moment Discord would read the files. */
interface PostedFile {
  path: string;
  filename: string;
  description: string;
  existed: boolean;
}

/** The upload request as the gateway received it: `files` observed at call time, not afterwards. */
interface PostedRequest extends Omit<GatewayForumPostRequest, 'files'> {
  files: PostedFile[];
}

class FakeGateway implements DiscordGateway {
  searchCalls: { guildId: string; query: string; limit: number }[] = [];
  memberCalls: string[] = [];
  forumCalls: string[] = [];
  postCalls: PostedRequest[] = [];
  starterCalls: string[] = [];
  activeCalls = 0;
  archivedCalls = 0;

  members: GatewayMemberSnapshot[] = [];
  member: GatewayMemberSnapshot | null = null;
  forumTags: { id: string; name: string }[] = [{ id: TAG_ID, name: 'Sebring' }];
  forumError: Error | null = null;
  postId = '1509000000000000001';
  postError: Error | null = null;
  activeThreads: GatewayThreadSnapshot[] = [];
  archivedThreads: GatewayThreadSnapshot[] = [];
  messages = new Map<string, GatewayMessageSnapshot | null>();

  constructor(private readonly order: string[]) {}

  async searchGuildMembers(guildId: string, query: string, limit: number): Promise<GatewayMemberSnapshot[]> {
    this.order.push('searchGuildMembers');
    this.searchCalls.push({ guildId, query, limit });
    return this.members;
  }

  async fetchGuildMember(_guildId: string, userId: string): Promise<GatewayMemberSnapshot | null> {
    this.order.push('fetchGuildMember');
    this.memberCalls.push(userId);
    return this.member;
  }

  async fetchForum(_guildId: string, channelId: string) {
    this.order.push('fetchForum');
    this.forumCalls.push(channelId);
    if (this.forumError !== null) throw this.forumError;
    return { id: channelId, availableTags: this.forumTags };
  }

  async createForumPost(request: GatewayForumPostRequest): Promise<string> {
    this.order.push('createForumPost');
    this.postCalls.push({
      ...request,
      files: request.files.map((file) => ({
        path: file.path,
        filename: file.filename,
        description: file.description,
        existed: fs.existsSync(file.path),
      })),
    });
    if (this.postError !== null) throw this.postError;
    return this.postId;
  }

  async fetchActiveThreads(): Promise<GatewayThreadSnapshot[]> {
    this.order.push('fetchActiveThreads');
    this.activeCalls += 1;
    return this.activeThreads;
  }

  async fetchArchivedThreads(): Promise<GatewayThreadSnapshot[]> {
    this.order.push('fetchArchivedThreads');
    this.archivedCalls += 1;
    return this.archivedThreads;
  }

  async fetchStarterMessage(_guildId: string, threadId: string): Promise<GatewayMessageSnapshot | null> {
    this.order.push('fetchStarterMessage');
    this.starterCalls.push(threadId);
    return this.messages.get(threadId) ?? null;
  }

  async close(): Promise<void> {
    this.order.push('close');
  }
}

// ---------------------------------------------------------------------------
// Collaborator fakes (the ports declared by DiscordService)
// ---------------------------------------------------------------------------

function lapInfo(lap: number, duration: number): LapInfo {
  return {
    lap,
    startTime: 100,
    endTime: 100 + duration,
    duration,
    isValid: true,
    isOutLap: false,
    inPit: false,
    fuelUsed: 1.5,
    s1: 12,
    s2: 8,
    s3: duration - 20,
    stint: 1,
  };
}

/** `DiscordService` only reads `header.laps`; the metadata half of the response is never touched. */
const NO_METADATA = {} as SessionMetadata;

class Fakes {
  readonly order: string[] = [];
  readonly resolveCalls: [string, string][] = [];
  readonly headerCalls: string[] = [];
  readonly metadataCalls: string[] = [];
  readonly exportCalls: [string, string, number, string | null | undefined][] = [];
  readonly generateCalls: string[] = [];

  database = 'C:/fixture/sessions/main-session.duckdb';
  laps: LapInfo[] = [lapInfo(0, 10), lapInfo(1, 30.25)];
  metadata = new Map<string, string | null>([
    ['TrackName', 'Sebring International Raceway'],
    ['TrackLayout', 'Default'],
    ['CarName', 'United Autosports McLaren 720S GT3 Evo'],
    ['CarClass', 'LMGT3'],
    ['RecordingTime', 'Session-42'],
  ]);
  exportError: unknown = null;
  generateError: unknown = null;
  svmText = 'VehicleClassSetting="LMGT3"\nUpgradeSetting=(0,0,0,0)\n';
  /** Path of the file the fake export leaves behind, so the tests can watch it disappear. */
  exported = '';

  constructor(private readonly paths: AppPaths) {}

  sessions() {
    return {
      resolve: async (profileId: string, sessionId: string): Promise<string> => {
        this.order.push('resolve');
        this.resolveCalls.push([profileId, sessionId]);
        return this.database;
      },
    };
  }

  lapService(): DiscordLapHeader {
    return {
      header: async (database: string): Promise<LapsResponse> => {
        this.order.push('header');
        this.headerCalls.push(database);
        return { laps: this.laps, metadata: NO_METADATA };
      },
    };
  }

  setupService(): DiscordMetadataReader {
    return {
      readMetadata: async (database: string) => {
        this.order.push('readMetadata');
        this.metadataCalls.push(database);
        return this.metadata;
      },
    };
  }

  /** `LapExportService.export`: writes a real file into the profile cache, like the real one. */
  exporter(): DiscordLapExporter {
    return {
      export: async (
        profileId: string,
        sessionId: string,
        lapNumber: number,
        customCarModel: string | null | undefined,
      ): Promise<ExportResult> => {
        this.order.push('export');
        this.exportCalls.push([profileId, sessionId, lapNumber, customCarModel]);
        if (this.exportError !== null) throw this.exportError;
        const filename = `Default-McLaren-720S-GT3-Evo-L${lapNumber}-0m30s250_${sessionId}`;
        const target = path.join(this.paths.profileCacheDir(profileId), filename);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'sliced-lap', 'utf8');
        this.exported = target;
        return { path: target, filename };
      },
    };
  }

  svmExporter(): DiscordSvmGenerator {
    return {
      generate: async (database: string): Promise<string> => {
        this.order.push('generate');
        this.generateCalls.push(database);
        if (this.generateError !== null) throw this.generateError;
        return this.svmText;
      },
    };
  }

  catalog(): DiscordCarCatalog {
    // The real catalog: the mapping is `CarCatalog`'s own contract, this service only passes it on.
    return new CarCatalog();
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  service: DiscordService;
  gateway: FakeGateway;
  fakes: Fakes;
  paths: AppPaths;
  logs: string[];
  fetchUrls: string[];
  cacheFiles(profileId?: string): string[];
  dataFiles(profileId?: string): string[];
}

let root = '';
let appHome = '';
let dataRoot = '';
let paths: AppPaths;

function memoryLogger(): { logger: Logger; logs: string[] } {
  const logs: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logs.push(String(chunk));
      callback();
    },
  });
  return { logger: pino({ level: 'trace', base: undefined }, sink), logs };
}

function writeConfigFile(body: Record<string, unknown> | null): void {
  const target = path.join(appHome, DISCORD_CONFIG_FILE_NAME);
  if (body === null) {
    fs.rmSync(target, { force: true });
    return;
  }
  fs.writeFileSync(target, JSON.stringify(body), 'utf8');
}

function build(
  options: { config?: Record<string, unknown> | null; fetchBody?: string; fetchStatus?: number } = {},
): Harness {
  writeConfigFile(options.config === undefined ? VALID_CONFIG_FILE : options.config);
  const config = new DiscordConfig({ appHome, dataRoot }, { env: {} });
  const { logger, logs } = memoryLogger();
  const fakes = new Fakes(paths);
  const gateway = new FakeGateway(fakes.order);
  const fetchUrls: string[] = [];

  const client = new DiscordClient(config, {
    gatewayFactory: (async () => gateway) as DiscordGatewayFactory,
    logger,
    now: () => NOW,
    fetch: (async (input: string | URL | Request) => {
      fetchUrls.push(String(input));
      return new Response(options.fetchBody ?? 'telemetry-bytes', {
        status: options.fetchStatus ?? 200,
      });
    }) as typeof globalThis.fetch,
  });

  const service = new DiscordService(
    config,
    client,
    fakes.sessions(),
    fakes.lapService(),
    fakes.exporter(),
    fakes.svmExporter(),
    fakes.setupService(),
    fakes.catalog(),
    paths,
    logger,
  );

  return {
    service,
    gateway,
    fakes,
    paths,
    logs,
    fetchUrls,
    cacheFiles: (profileId = 'guest') => listDir(paths.profileCacheDir(profileId)),
    dataFiles: (profileId = 'guest') => listDir(paths.profileDataDir(profileId)),
  };
}

function listDir(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

function shareRequest(overrides: Partial<DiscordShareRequest> = {}): DiscordShareRequest {
  return {
    lap_number: 1,
    title: 'Nice lap',
    content: 'brake earlier into T1',
    attach_setup: false,
    car_class: CAR_CLASS,
    custom_car_model: null,
    profile_id: 'guest',
    discord_handle: '@driver',
    ...overrides,
  };
}

/** A `POST /discord/shares/download` body for one of the shares listed above. */
function downloadRequest(overrides: Partial<DiscordDownloadRequest> = {}): DiscordDownloadRequest {
  return {
    profile_id: 'guest',
    telemetry_url: DUCKDB_URL,
    telemetry_filename: 'Session.duckdb',
    setup_url: null,
    setup_filename: null,
    ...overrides,
  };
}

function member(id: string, username: string, extras: { globalName?: string | null; avatar?: string | null } = {}): GatewayMemberSnapshot {
  const user: GatewayUserSummary = {
    id,
    username,
    globalName: extras.globalName ?? null,
    avatarHash: extras.avatar ?? null,
  };
  return { user, nick: null };
}

function attachment(filename: string, url: string, size: number): GatewayAttachmentSnapshot {
  return { filename, url, size };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmu-discord-service-'));
  appHome = path.join(root, 'app');
  dataRoot = path.join(root, 'data');
  fs.mkdirSync(appHome, { recursive: true });
  paths = fixturePaths(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  cleanupLapFixtures();
});

// ---------------------------------------------------------------------------

describe('DiscordService.config - GET /api/v1/discord/config', () => {
  it('returns the two Java keys and never the bot token', () => {
    const { service } = build();
    const body = service.config();
    expect(body).toEqual({
      is_configured: true,
      invite_url: 'https://discord.gg/zNPehXA3jK',
    });
    expect(JSON.stringify(body)).not.toContain(FAKE_TOKEN);
  });

  it('keeps the 200 + defaults when Discord is not configured', () => {
    const { service } = build({ config: null });
    expect(service.config()).toEqual({ is_configured: false, invite_url: DEFAULT_INVITE_URL });
  });

  it('emits an explicit null invite_url when the file has none', () => {
    const { service } = build({ config: { bot_token: FAKE_TOKEN, guild_id: GUILD } });
    const body = service.config();
    expect(body).toEqual({ is_configured: true, invite_url: null });
    expect(JSON.stringify(body)).toContain('"invite_url":null');
  });

  it('never leaks the env-provided token either', () => {
    writeConfigFile({ ...VALID_CONFIG_FILE, bot_token: '' });
    const config = new DiscordConfig({ appHome, dataRoot }, { env: { DISCORD_BOT_TOKEN: 'env-secret-token' } });
    const service = new DiscordService(
      config,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      paths,
      pino({ level: 'silent' }),
    );
    expect(JSON.stringify(service.config())).not.toContain('env-secret-token');
    expect(JSON.stringify(service.config())).toContain('"is_configured":true');
  });
});

describe('DiscordService.shares - GET /api/v1/discord/shares', () => {
  it('wraps the forum threads in {"shares": [...]} with the Java field shape', async () => {
    const harness = build();
    harness.gateway.activeThreads = [{ id: '900', name: 'Nice lap', locked: false }];
    harness.gateway.member = member('777', 'driver', { globalName: 'Driver One', avatar: 'abc' });
    harness.gateway.messages.set('900', {
      content: '<@777> --- my notes',
      createdTimestamp: 1_700_000_000_000,
      author: { id: '1', username: 'starter', globalName: null, avatarHash: null },
      attachments: [
        attachment('Session.duckdb', DUCKDB_URL, 123),
        attachment('setup.svm', SVM_URL, 45),
      ],
    });

    const body = await harness.service.shares(CAR_CLASS);
    expect(body).toEqual({
      shares: [
        {
          thread_id: '900',
          title: 'Nice lap',
          author: {
            id: '777',
            username: 'driver',
            display_name: 'Driver One',
            avatar_url: 'https://cdn.discordapp.com/avatars/777/abc.png',
          },
          content: 'my notes',
          telemetry: { filename: 'Session.duckdb', url: DUCKDB_URL, size: 123 },
          setup: { filename: 'setup.svm', url: SVM_URL, size: 45 },
          created_at: '2023-11-14T22:13:20.000+00:00',
        },
      ],
    });
    expect(Object.keys(body)).toEqual(['shares']);
  });

  it('returns {"shares": []} without a token, and without a gateway', async () => {
    const harness = build({ config: null });
    await expect(harness.service.shares(CAR_CLASS)).resolves.toEqual({ shares: [] });
    expect(harness.gateway.activeCalls).toBe(0);
  });

  it('returns an empty list for an unknown car class', async () => {
    const harness = build();
    await expect(harness.service.shares('lmp2-telemetry-sharing')).resolves.toEqual({ shares: [] });
    expect(harness.gateway.activeCalls).toBe(0);
  });

  it('is cached by the client only - the service adds no second cache', async () => {
    const harness = build();
    harness.gateway.activeThreads = [{ id: '900', name: 'T', locked: false }];
    harness.gateway.messages.set('900', {
      content: 'no separator',
      createdTimestamp: 1_700_000_000_000,
      author: { id: '1', username: 'starter', globalName: null, avatarHash: null },
      attachments: [attachment('S.duckdb', DUCKDB_URL, 1)],
    });

    const first = await harness.service.shares(CAR_CLASS);
    const second = await harness.service.shares(CAR_CLASS);
    // 60 s TTL inside `DiscordClient.listSharedLaps`: one thread fetch for two requests.
    expect(harness.gateway.activeCalls).toBe(1);
    expect(second).toEqual(first);

    // And a write-through is not buffered in this layer either: the list is the client's own array.
    expect(harness.gateway.starterCalls).toEqual(['900']);
  });
});

describe('DiscordService.share - POST /api/v1/sessions/{id}/discord/share', () => {
  it('exports one file, verifies membership and posts the Java content block', async () => {
    const harness = build();
    harness.gateway.members = [member('777', 'driver')];

    const result = await harness.service.share('guest', SESSION_ID, shareRequest());

    expect(result).toEqual({ success: true, thread_id: '1509000000000000001' });
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);

    // Orchestration order: resolve -> header -> metadata -> export -> membership -> tags -> post.
    expect(harness.fakes.order).toEqual([
      'resolve',
      'header',
      'readMetadata',
      'export',
      'searchGuildMembers',
      'fetchForum',
      'createForumPost',
    ]);
    expect(harness.fakes.resolveCalls).toEqual([['guest', SESSION_ID]]);
    expect(harness.fakes.headerCalls).toEqual([harness.fakes.database]);
    expect(harness.fakes.metadataCalls).toEqual([harness.fakes.database]);
    expect(harness.fakes.exportCalls).toEqual([['guest', SESSION_ID, 1, null]]);
    expect(harness.gateway.searchCalls).toEqual([{ guildId: GUILD, query: 'driver', limit: 100 }]);
    expect(harness.gateway.forumCalls).toEqual([CHANNEL]);

    const post = harness.gateway.postCalls[0] as PostedRequest;
    expect(post.guildId).toBe(GUILD);
    expect(post.channelId).toBe(CHANNEL);
    expect(post.name).toBe('Nice lap');
    expect(post.appliedTags).toEqual([TAG_ID]);
    expect(post.content).toBe(
      '### Telemetry Shared by <@777>\n\n'
      + '* **Track:** Sebring International Raceway (Default)\n'
      + '* **Car:** McLaren 720S GT3 Evo\n'
      + '* **Lap Time:** 0m30s250\n\n'
      + '---\n\n'
      + 'brake earlier into T1',
    );
    // attach_setup=false -> exactly the sliced lap, and it still exists while Discord reads it.
    expect(post.files).toHaveLength(1);
    expect(post.files[0]?.existed).toBe(true);
    expect(post.files[0]?.filename).toBe(
      'Default-McLaren-720S-GT3-Evo-L1-0m30s250_main-session.duckdb',
    );
    expect(post.files[0]?.description).toBe(
      'Uploaded file: Default-McLaren-720S-GT3-Evo-L1-0m30s250_main-session.duckdb',
    );
    // `finally` cleanup, and no `.path` in the response.
    expect(harness.fakes.exported).not.toBe('');
    expect(fs.existsSync(harness.fakes.exported)).toBe(false);
    expect(harness.cacheFiles()).toEqual([]);
  });

  it('attach_setup=true adds the _setup.svm file named by the Java rule', async () => {
    const harness = build();
    harness.gateway.members = [member('777', 'driver')];

    await harness.service.share('guest', SESSION_ID, shareRequest({ attach_setup: true }));

    expect(harness.fakes.order).toEqual([
      'resolve',
      'header',
      'readMetadata',
      'export',
      'generate',
      'searchGuildMembers',
      'fetchForum',
      'createForumPost',
    ]);
    expect(harness.fakes.generateCalls).toEqual([harness.fakes.database]);

    const post = harness.gateway.postCalls[0] as PostedRequest;
    expect(post.files.map((file) => file.filename)).toEqual([
      'Default-McLaren-720S-GT3-Evo-L1-0m30s250_main-session.duckdb',
      SETUP_FILE,
    ]);
    expect(post.files.every((file) => file.existed)).toBe(true);
    // The SVM body is written verbatim into the profile cache dir before the upload.
    expect(post.files[1]?.path).toBe(path.resolve(paths.profileCacheDir('guest'), SETUP_FILE));
    expect(harness.cacheFiles()).toEqual([]);
    expect(fs.existsSync(harness.fakes.exported)).toBe(false);
  });

  it('reads the SVM content it wrote, so Discord gets the generated setup', async () => {
    const harness = build();
    harness.gateway.members = [member('777', 'driver')];
    const seen: string[] = [];
    const original = harness.gateway.createForumPost.bind(harness.gateway);
    harness.gateway.createForumPost = async (request) => {
      for (const file of request.files) {
        seen.push(fs.readFileSync(file.path, 'utf8'));
      }
      return original(request);
    };

    await harness.service.share('guest', SESSION_ID, shareRequest({ attach_setup: true }));
    expect(seen).toEqual(['sliced-lap', harness.fakes.svmText]);
  });

  it('keeps sharing when the setup generation fails, and logs it', async () => {
    const harness = build();
    harness.gateway.members = [member('777', 'driver')];
    harness.fakes.generateError = new Error('CarSetup not found');

    await expect(harness.service.share('guest', SESSION_ID, shareRequest({ attach_setup: true })))
      .resolves.toEqual({ success: true, thread_id: '1509000000000000001' });

    const post = harness.gateway.postCalls[0] as PostedRequest;
    expect(post.files.map((file) => file.filename)).toEqual([
      'Default-McLaren-720S-GT3-Evo-L1-0m30s250_main-session.duckdb',
    ]);
    expect(harness.logs.join('')).toContain('Setup generation failed for Discord share');
    expect(harness.logs.join('')).toContain('CarSetup not found');
    expect(fs.existsSync(path.resolve(paths.profileCacheDir('guest'), SETUP_FILE))).toBe(false);
    expect(harness.cacheFiles()).toEqual([]);
  });

  it('uses the custom car model instead of the catalog, and spaces become dashes', async () => {
    const harness = build();
    harness.gateway.members = [member('777', 'driver')];

    await harness.service.share(
      'guest',
      SESSION_ID,
      shareRequest({ attach_setup: true, custom_car_model: 'My Custom Car' }),
    );

    // The raw value is passed to the exporter (it rewrites CarName) and used for both names.
    expect(harness.fakes.exportCalls).toEqual([['guest', SESSION_ID, 1, 'My Custom Car']]);
    const post = harness.gateway.postCalls[0] as PostedRequest;
    expect(post.files[1]?.filename).toBe('Default_My-Custom-Car_Session-42_setup.svm');
    expect(post.content).toContain('* **Car:** My Custom Car\n');
  });

  it('defaults a blank profile to guest, like DiscordService.java:85', async () => {
    const harness = build();
    harness.gateway.members = [member('777', 'driver')];

    await harness.service.share('   ', SESSION_ID, shareRequest({ profile_id: 'ignored-by-controller' }));
    expect(harness.fakes.exportCalls[0]?.[0]).toBe('guest');
    expect(harness.fakes.resolveCalls).toEqual([['guest', SESSION_ID]]);
  });

  it('posts with no tag when the forum has no matching tag', async () => {
    const harness = build();
    harness.gateway.members = [member('777', 'driver')];
    harness.gateway.forumTags = [{ id: '3003', name: 'Monza' }];

    await harness.service.share('guest', SESSION_ID, shareRequest());

    const post = harness.gateway.postCalls[0] as PostedRequest;
    expect(post.appliedTags).toEqual([]);
    expect(post.name).toBe('Nice lap');
  });

  it('posts with no tag when reading the forum is forbidden (no 4xx/5xx, Java swallows it)', async () => {
    const harness = build();
    harness.gateway.members = [member('777', 'driver')];
    harness.gateway.forumError = new Error('Discord API 403: {"code":50013}');

    await expect(harness.service.share('guest', SESSION_ID, shareRequest())).resolves.toEqual({
      success: true,
      thread_id: '1509000000000000001',
    });
    expect(harness.logs.join('')).toContain('Failed to match Discord tag');
    const post = harness.gateway.postCalls[0] as PostedRequest;
    expect(post.appliedTags).toEqual([]);
  });

  it('rejects a non-member with the Java 400 text and still cleans the export up', async () => {
    const harness = build();
    harness.gateway.members = [member('888', 'someone-else')];

    const error = await harness.service
      .share('guest', SESSION_ID, shareRequest())
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).status).toBe(400);
    expect((error as ApiException).message)
      .toBe('You are not a member of our Discord server yet! Please join our server to share telemetry.');

    expect(harness.gateway.postCalls).toEqual([]);
    expect(fs.existsSync(harness.fakes.exported)).toBe(false);
    expect(harness.cacheFiles()).toEqual([]);
  });

  it('turns a forum permission error into the Java 500 text and cleans up', async () => {
    const harness = build();
    harness.gateway.members = [member('777', 'driver')];
    harness.gateway.postError = new Error('Discord API error: 403 - {"message":"Missing Permissions"}');

    const error = await harness.service
      .share('guest', SESSION_ID, shareRequest({ attach_setup: true }))
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).status).toBe(500);
    expect((error as ApiException).message)
      .toBe('Discord API error: 403 - {"message":"Missing Permissions"}');
    expect(JSON.stringify({ detail: (error as ApiException).message })).not.toContain(FAKE_TOKEN);
    // Both temp files (export + setup) are gone even though the upload failed.
    expect(harness.cacheFiles()).toEqual([]);
    expect(fs.existsSync(harness.fakes.exported)).toBe(false);
  });

  it('fails with 400 before touching anything when Discord is not configured', async () => {
    const harness = build({ config: null });
    const error = await harness.service
      .share('guest', SESSION_ID, shareRequest())
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).status).toBe(400);
    expect((error as ApiException).message)
      .toBe('Discord Bot is not configured. Please check discord_config.json');
    expect(harness.fakes.order).toEqual([]);
  });

  it('rejects a missing body and a missing handle', async () => {
    const harness = build();
    await expect(harness.service.share('guest', SESSION_ID, null)).rejects.toMatchObject({
      status: 400,
      message: 'Request body is required',
    });
    await expect(
      harness.service.share('guest', SESSION_ID, shareRequest({ discord_handle: '   ' })),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Discord username is required for server membership verification.',
    });
    expect(harness.fakes.order).toEqual([]);
  });

  it('404s an unknown lap number with the Java text, before exporting', async () => {
    const harness = build();
    harness.gateway.members = [member('777', 'driver')];

    await expect(harness.service.share('guest', SESSION_ID, shareRequest({ lap_number: 42 })))
      .rejects.toMatchObject({ status: 404, message: 'Lap 42 not found' });
    expect(harness.fakes.exportCalls).toEqual([]);
    expect(harness.gateway.postCalls).toEqual([]);
  });

  it('wraps an unexpected export failure as 500 "Discord sharing failed: <message>"', async () => {
    const harness = build();
    harness.gateway.members = [member('777', 'driver')];
    harness.fakes.exportError = new Error('disk on fire');

    const error = await harness.service
      .share('guest', SESSION_ID, shareRequest())
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).status).toBe(500);
    expect((error as ApiException).message).toBe('Discord sharing failed: disk on fire');
    expect(harness.logs.join('')).toContain('Discord sharing failed');
    expect(harness.cacheFiles()).toEqual([]);
  });

  it('re-throws an ApiException from the export untouched (404 lap, session errors)', async () => {
    const harness = build();
    harness.gateway.members = [member('777', 'driver')];
    harness.fakes.exportError = new ApiException(404, 'Lap 3 not found');

    await expect(harness.service.share('guest', SESSION_ID, shareRequest({ lap_number: 3 })))
      .rejects.toMatchObject({ status: 404, message: 'Lap 3 not found' });
  });

  it('keeps the null-metadata rule: a NULL TrackLayout is a 500, not a silent fallback', async () => {
    const harness = build();
    harness.gateway.members = [member('777', 'driver')];
    harness.fakes.metadata.set('TrackLayout', null);

    await expect(harness.service.share('guest', SESSION_ID, shareRequest())).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(harness.fakes.order).toEqual(['resolve', 'header', 'readMetadata']);
  });

  it('falls back to the session id for RecordingTime, like DiscordService.java:104', async () => {
    const harness = build();
    harness.gateway.members = [member('777', 'driver')];
    harness.fakes.metadata.delete('RecordingTime');

    await harness.service.share('guest', SESSION_ID, shareRequest({ attach_setup: true }));
    const post = harness.gateway.postCalls[0] as PostedRequest;
    expect(post.files[1]?.filename).toBe('Default_McLaren-720S-GT3-Evo_main-session_setup.svm');
  });

  it('formats the lap time the Java way, including the sub-second digits', async () => {
    const harness = build();
    harness.gateway.members = [member('777', 'driver')];
    harness.fakes.laps = [lapInfo(1, 95.1234)];

    await harness.service.share('guest', SESSION_ID, shareRequest());
    const post = harness.gateway.postCalls[0] as PostedRequest;
    expect(post.content).toContain('* **Lap Time:** 1m35s123\n');
  });
});

describe('DiscordService.download - POST /api/v1/discord/shares/download', () => {
  it('downloads the attachment under its own name and returns the Java three fields', async () => {
    const harness = build();
    const body = await harness.service.download(downloadRequest());

    expect(body).toEqual({
      success: true,
      telemetry_path: path.resolve(paths.profileDataDir('guest'), 'Session.duckdb'),
      setup_downloaded: false,
    });
    expect(Object.keys(body)).toEqual(['success', 'telemetry_path', 'setup_downloaded']);
    expect(harness.fetchUrls).toEqual([DUCKDB_URL]);
    expect(harness.dataFiles()).toEqual(['Session.duckdb']);
    expect(fs.readFileSync(body.telemetry_path, 'utf8')).toBe('telemetry-bytes');
    // Java adds no `discord__` prefix here: the file keeps the attachment name.
    expect(body.telemetry_path).not.toContain('discord__');
    expect(JSON.stringify(body)).not.toContain(FAKE_TOKEN);
  });

  it('downloads the setup file too, when its name ends in .svm', async () => {
    const harness = build();
    const body = await harness.service.download(
      downloadRequest({ setup_url: SVM_URL, setup_filename: 'setup.svm' }),
    );

    expect(body).toEqual({
      success: true,
      telemetry_path: path.resolve(paths.profileDataDir('guest'), 'Session.duckdb'),
      setup_downloaded: true,
    });
    expect(harness.fetchUrls).toEqual([DUCKDB_URL, SVM_URL]);
    expect(harness.dataFiles()).toEqual(['Session.duckdb', 'setup.svm']);
  });

  it('skips a non-.svm setup without fetching it', async () => {
    const harness = build();
    const body = await harness.service.download(
      downloadRequest({ setup_url: SVM_URL, setup_filename: 'notes.txt' }),
    );
    expect(body.setup_downloaded).toBe(false);
    expect(harness.fetchUrls).toEqual([DUCKDB_URL]);
    expect(harness.dataFiles()).toEqual(['Session.duckdb']);
  });

  it('reports the setup failure only in the log', async () => {
    const harness = build();
    // The second download is aimed at a URL the client rejects before any request is made.
    const body = await harness.service.download(
      downloadRequest({ setup_url: 'http://internal.example/setup.svm', setup_filename: 'setup.svm' }),
    );
    expect(body).toEqual({
      success: true,
      telemetry_path: path.resolve(paths.profileDataDir('guest'), 'Session.duckdb'),
      setup_downloaded: false,
    });
    expect(harness.logs.join('')).toContain('Failed to download setup file');
    expect(harness.fetchUrls).toEqual([DUCKDB_URL]);
    expect(harness.dataFiles()).toEqual(['Session.duckdb']);
  });

  it('writes into the requesting profile, not into guest', async () => {
    const harness = build();
    paths.ensureProfileDirs('driver-one');
    const body = await harness.service.download(downloadRequest({ profile_id: 'driver-one' }));
    expect(body.telemetry_path).toBe(
      path.resolve(paths.profileDataDir('driver-one'), 'Session.duckdb'),
    );
    expect(harness.dataFiles('driver-one')).toEqual(['Session.duckdb']);
    expect(harness.dataFiles('guest')).toEqual([]);
  });

  it('strips any path out of the attachment filename, exactly like PathSafety.safeFileName', async () => {
    const harness = build();
    const body = await harness.service.download(
      downloadRequest({ telemetry_filename: `../../etc${path.sep}passwd.duckdb` }),
    );
    expect(body.telemetry_path).toBe(path.resolve(paths.profileDataDir('guest'), 'passwd.duckdb'));
    expect(harness.dataFiles()).toEqual(['passwd.duckdb']);
  });

  it('400s a non-.duckdb telemetry file', async () => {
    const harness = build();
    await expect(harness.service.download(downloadRequest({ telemetry_filename: 'setup.svm' })))
      .rejects.toMatchObject({
        status: 400,
        message: 'Invalid telemetry file type. Must end in .duckdb',
      });
    expect(harness.fetchUrls).toEqual([]);
    expect(harness.dataFiles()).toEqual([]);
  });

  it('400s when the url or the filename is absent', async () => {
    const harness = build();
    for (const request of [
      null,
      undefined,
      downloadRequest({ telemetry_url: null }),
      downloadRequest({ telemetry_filename: null }),
    ] as (DiscordDownloadRequest | null | undefined)[]) {
      await expect(harness.service.download(request)).rejects.toMatchObject({
        status: 400,
        message: 'Telemetry URL and filename are required',
      });
    }
    expect(harness.fetchUrls).toEqual([]);
  });

  it('never fetches a non-Discord URL: the client allow-list still guards SSRF', async () => {
    const harness = build();
    const error = await harness.service
      .download(downloadRequest({ telemetry_url: 'http://169.254.169.254/latest/meta-data/iam/x.duckdb' }))
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).status).toBe(500);
    expect((error as ApiException).message)
      .toBe('Failed to download telemetry file: Unsupported download URL');
    // The validation happens inside DiscordClient.downloadFile, before any request: nothing was
    // fetched and nothing was written, so this layer cannot be used as an SSRF proxy.
    expect(harness.fetchUrls).toEqual([]);
    expect(harness.dataFiles()).toEqual([]);
    expect(fs.existsSync(`${path.resolve(paths.profileDataDir('guest'), 'x.duckdb')}.tmp`)).toBe(false);
  });

  it('wraps a CDN failure in the Java 500 text and leaves no .tmp behind', async () => {
    const harness = build({ fetchStatus: 404 });
    const error = await harness.service
      .download(downloadRequest())
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).status).toBe(500);
    expect((error as ApiException).message)
      .toBe('Failed to download telemetry file: Download failed with status 404');
    expect(harness.fetchUrls).toEqual([DUCKDB_URL]);
    // The client writes to `<target>.tmp` and only moves it into place on a 200.
    expect(harness.dataFiles()).toEqual([]);
    expect(fs.existsSync(`${path.resolve(paths.profileDataDir('guest'), 'Session.duckdb')}.tmp`))
      .toBe(false);
  });

  it('needs no bot token, because the CDN download is unauthenticated', async () => {
    const harness = build({ config: null });
    const body = await harness.service.download(downloadRequest());
    expect(body).toEqual({
      success: true,
      telemetry_path: path.resolve(paths.profileDataDir('guest'), 'Session.duckdb'),
      setup_downloaded: false,
    });
    expect(harness.fetchUrls).toEqual([DUCKDB_URL]);
    expect(harness.gateway.activeCalls).toBe(0);
  });
});

describe('discord__ naming: the contract this layer must not break', () => {
  it('a downloaded share is reachable as a session by its attachment name', async () => {
    const harness = build();
    const body = await harness.service.download(downloadRequest());
    const repository = new SessionRepository(paths, harnessNoDiscord(), silentLogger());
    // `SessionService.scan` names the row after the file, minus the extension.
    expect(await repository.resolve('guest', 'Session.duckdb')).toBe(body.telemetry_path);
  });

  it('a `discord__` session id is the thread-id form handled by SessionRepository, not a file name', async () => {
    const repository = new SessionRepository(paths, harnessNoDiscord(), silentLogger());
    // Numbers-only thread ids resolve to the shared cache; anything else is the Java 400.
    await expect(repository.resolve('guest', 'discord__abc')).rejects.toMatchObject({
      status: 400,
      message: 'Invalid Discord thread id',
    });
    // So a file that *did* carry the prefix could not be opened by name - which is why the
    // download endpoint keeps the plain attachment filename.
    await expect(repository.resolve('guest', 'discord__7.duckdb')).rejects.toMatchObject({
      status: 400,
      message: 'Invalid Discord thread id',
    });
  });
});

// ---------------------------------------------------------------------------

function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

function harnessNoDiscord() {
  return {
    async getThreadAttachments(): Promise<null> {
      return null;
    },
    async downloadFile(): Promise<void> {
      throw new Error('downloadFile must not be reached by these tests');
    },
  };
}
