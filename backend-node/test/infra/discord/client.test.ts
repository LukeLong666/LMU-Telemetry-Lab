import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiException } from '../../../src/api/error.js';
import {
  DiscordClient,
  createDiscordJsGateway,
  type DiscordGateway,
  type GatewayAttachmentSnapshot,
  type GatewayForumPostRequest,
  type GatewayForumSnapshot,
  type GatewayMemberSnapshot,
  type GatewayMessageSnapshot,
  type GatewayThreadSnapshot,
  type GatewayUserSummary,
} from '../../../src/infra/discord/client.js';
import {
  DEFAULT_INVITE_URL,
  DISCORD_CONFIG_FILE_NAME,
  DiscordConfig,
  type DiscordLogSink,
} from '../../../src/infra/discord/config.js';

const FAKE_TOKEN = 'mtI3NzQyNTYyODI0MzYwNjI3MQ.GaBcDe.fGenoIjKlMnOpQrStUvWxYz1234567890abcde';
const CHANNEL = '1505950451114311730';
const CAR_CLASS = 'lmgt3-telemetry-sharing';
const GUILD = '1496410659557081098';
const DUCKDB_URL = 'https://cdn.discordapp.com/attachments/1505950451114311730/1/Session.duckdb';
const SVM_URL = 'https://media.discordapp.net/attachments/1505950451114311730/1/setup.svm';

const VALID_CONFIG = {
  bot_token: FAKE_TOKEN,
  guild_id: GUILD,
  invite_url: 'https://discord.gg/zNPehXA3jK',
  channels: { [CAR_CLASS]: CHANNEL },
};

// ---------------------------------------------------------------------------
// Fake gateway: stands in for discord.js, so no test reaches the network.
// ---------------------------------------------------------------------------

class FakeGateway implements DiscordGateway {
  searchCalls: { guildId: string; query: string; limit: number }[] = [];
  memberCalls: string[] = [];
  forumCalls: string[] = [];
  postCalls: GatewayForumPostRequest[] = [];
  activeCalls = 0;
  archivedCalls = 0;
  starterCalls: string[] = [];
  closeCalls = 0;

  members: GatewayMemberSnapshot[] = [];
  member: GatewayMemberSnapshot | null = null;
  membersById = new Map<string, GatewayMemberSnapshot | null>();
  memberError: Error | null = null;
  forumTags: { id: string; name: string }[] = [];
  forumError: Error | null = null;
  postId = '1509000000000000001';
  postError: Error | null = null;
  activeThreads: GatewayThreadSnapshot[] = [];
  archivedThreads: GatewayThreadSnapshot[] = [];
  activeError: Error | null = null;
  archivedError: Error | null = null;
  messages = new Map<string, GatewayMessageSnapshot | null>();
  messageError: Error | null = null;

  async searchGuildMembers(guildId: string, query: string, limit: number): Promise<GatewayMemberSnapshot[]> {
    this.searchCalls.push({ guildId, query, limit });
    return this.members;
  }

  async fetchGuildMember(_guildId: string, userId: string): Promise<GatewayMemberSnapshot | null> {
    this.memberCalls.push(userId);
    if (this.memberError !== null) throw this.memberError;
    if (this.membersById.has(userId)) return this.membersById.get(userId) ?? null;
    return this.member;
  }

  async fetchForum(_guildId: string, channelId: string): Promise<GatewayForumSnapshot> {
    this.forumCalls.push(channelId);
    if (this.forumError !== null) throw this.forumError;
    return { id: channelId, availableTags: this.forumTags };
  }

  async createForumPost(request: GatewayForumPostRequest): Promise<string> {
    this.postCalls.push(request);
    if (this.postError !== null) throw this.postError;
    return this.postId;
  }

  async fetchActiveThreads(): Promise<GatewayThreadSnapshot[]> {
    this.activeCalls += 1;
    if (this.activeError !== null) throw this.activeError;
    return this.activeThreads;
  }

  async fetchArchivedThreads(): Promise<GatewayThreadSnapshot[]> {
    this.archivedCalls += 1;
    if (this.archivedError !== null) throw this.archivedError;
    return this.archivedThreads;
  }

  async fetchStarterMessage(_guildId: string, threadId: string): Promise<GatewayMessageSnapshot | null> {
    this.starterCalls.push(threadId);
    if (this.messageError !== null) throw this.messageError;
    return this.messages.get(threadId) ?? null;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function user(partial: Partial<GatewayUserSummary> & { id: string }): GatewayUserSummary {
  return { username: 'user', globalName: null, avatarHash: null, ...partial };
}

function member(
  id: string,
  username: string,
  extras: { globalName?: string | null; nick?: string | null; avatar?: string | null } = {},
): GatewayMemberSnapshot {
  return {
    user: user({ id, username, globalName: extras.globalName ?? null, avatarHash: extras.avatar ?? null }),
    nick: extras.nick ?? null,
  };
}

function attachment(filename: string, url: string, size: number): GatewayAttachmentSnapshot {
  return { filename, url, size };
}

function message(partial: Partial<GatewayMessageSnapshot> & { author: GatewayUserSummary }): GatewayMessageSnapshot {
  return { content: '', createdTimestamp: 1_738_368_000_123, attachments: [], ...partial };
}

function thread(id: string, name = `Thread ${id}`, locked = false): GatewayThreadSnapshot {
  return { id, name, locked };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let root = '';
let appHome = '';
let dataRoot = '';
let gateway = new FakeGateway();
let gatewayCreations: string[] = [];
const clock = { value: 1_000_000 };

interface RecordingSink extends DiscordLogSink {
  lines: string[];
}

function recordingSink(): RecordingSink {
  const lines: string[] = [];
  return {
    lines,
    info: (message: string, meta?: Record<string, unknown>) => lines.push(`info ${message} ${JSON.stringify(meta ?? {})}`),
    warn: (message: string, meta?: Record<string, unknown>) => lines.push(`warn ${message} ${JSON.stringify(meta ?? {})}`),
    error: (message: string, meta?: Record<string, unknown>) => lines.push(`error ${message} ${JSON.stringify(meta ?? {})}`),
  };
}

function configWith(body: Record<string, unknown> | null): DiscordConfig {
  const target = path.join(appHome, DISCORD_CONFIG_FILE_NAME);
  if (body === null) {
    fs.rmSync(target, { force: true });
  } else {
    fs.writeFileSync(target, JSON.stringify(body), 'utf8');
  }
  return new DiscordConfig({ appHome, dataRoot }, { env: {} });
}

function build(body: Record<string, unknown> | null, sink?: DiscordLogSink): DiscordClient {
  const config = configWith(body);
  gateway = new FakeGateway();
  gatewayCreations = [];
  clock.value = 1_000_000;
  return new DiscordClient(config, {
    gatewayFactory: async (token: string) => {
      gatewayCreations.push(token);
      return gateway;
    },
    logger: sink,
    now: () => clock.value,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmu-discord-client-'));
  appHome = path.join(root, 'app');
  dataRoot = path.join(root, 'data');
  fs.mkdirSync(appHome, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('DiscordClient laziness', () => {
  it('never opens a gateway for the guarded code paths', async () => {
    const client = build(null);
    expect(client.isConfigured()).toBe(false);
    expect(client.inviteUrl()).toBe(DEFAULT_INVITE_URL);
    await expect(client.listSharedLaps(CAR_CLASS)).resolves.toEqual([]);
    await expect(client.searchGuildMember('someone')).resolves.toBeNull();
    await expect(client.getGuildMember('1')).resolves.toBeNull();
    await expect(client.getThreadAttachments('1')).resolves.toBeNull();
    await expect(client.shareToForum(CAR_CLASS, 't', 'c', 'Track', [])).resolves.toEqual({
      success: false,
      error: 'Discord Bot not configured',
    });
    expect(gatewayCreations).toEqual([]);
  });

  it('logs in once and reuses the gateway until close()', async () => {
    const client = build(VALID_CONFIG);
    gateway.activeThreads = [thread('100')];
    gateway.messages.set(
      '100',
      message({ author: user({ id: '900', username: 'a' }), attachments: [attachment('S.duckdb', DUCKDB_URL, 10)] }),
    );
    await client.listSharedLaps(CAR_CLASS);
    await client.getThreadAttachments('100');
    expect(gatewayCreations).toEqual([FAKE_TOKEN]);
    await client.close();
    expect(gateway.closeCalls).toBe(1);
    expect(gatewayCreations).toHaveLength(1);
  });

  it('connect() throws the Java wording when the token is missing', async () => {
    const client = build(null);
    await expect(client.connect()).rejects.toThrow('Discord Bot is not configured. Please check discord_config.json');
    expect(gatewayCreations).toEqual([]);
  });

  it('exposes a discord.js backed factory that imports cleanly under ESM', async () => {
    expect(typeof createDiscordJsGateway).toBe('function');
    const djs = await import('discord.js');
    expect(typeof djs.Client).toBe('function');
    expect(typeof djs.GatewayIntentBits).toBe('object');
    expect(typeof djs.AttachmentBuilder).toBe('function');
  });
});

describe('DiscordClient.shareToForum', () => {
  it('mirrors Java for an unmapped car class', async () => {
    const client = build(VALID_CONFIG);
    await expect(client.shareToForum('lmp2-telemetry-sharing', 't', 'c', 'Track', [])).resolves.toEqual({
      success: false,
      error: 'No Discord channel ID configured for car class: lmp2-telemetry-sharing',
    });
    expect(gatewayCreations).toEqual([]);
  });

  it('posts the thread with the same file metadata Java sent', async () => {
    const client = build(VALID_CONFIG);
    const result = await client.shareToForum(CAR_CLASS, 'Portimao run', 'body content', '', [
      path.join(root, 'Session_2025-02-01_10-00-00.duckdb'),
      path.join(root, 'Portimao_GT3_10-00-00_setup.svm'),
    ]);

    expect(JSON.stringify(result)).toBe('{"success":true,"thread_id":"1509000000000000001"}');
    expect(gateway.postCalls).toHaveLength(1);
    expect(gateway.postCalls[0]).toEqual({
      guildId: GUILD,
      channelId: CHANNEL,
      name: 'Portimao run',
      content: 'body content',
      appliedTags: [],
      files: [
        {
          path: path.join(root, 'Session_2025-02-01_10-00-00.duckdb'),
          filename: 'Session_2025-02-01_10-00-00.duckdb',
          description: 'Uploaded file: Session_2025-02-01_10-00-00.duckdb',
        },
        {
          path: path.join(root, 'Portimao_GT3_10-00-00_setup.svm'),
          filename: 'Portimao_GT3_10-00-00_setup.svm',
          description: 'Uploaded file: Portimao_GT3_10-00-00_setup.svm',
        },
      ],
    });
  });

  it('applies the matched forum tag, including the Java alias table', async () => {
    const client = build(VALID_CONFIG);

    gateway.forumTags = [
      { id: 'tag-algarve', name: 'Algarve' },
      { id: 'tag-portimao', name: 'Portimão' },
    ];
    await client.shareToForum(CAR_CLASS, 'title', 'content', 'Algarve International Circuit', []);
    expect(gateway.postCalls[0]?.appliedTags).toEqual(['tag-algarve']);

    gateway.postCalls = [];
    gateway.forumTags = [{ id: 'tag-spa', name: 'Spa' }];
    await client.shareToForum(CAR_CLASS, 'title', 'content', 'Spa-Francorchamps (Grand Prix)', []);
    expect(gateway.postCalls[0]?.appliedTags).toEqual(['tag-spa']);

    gateway.postCalls = [];
    gateway.forumTags = [{ id: 'tag-sarthe', name: 'Le Mans' }];
    await client.shareToForum(CAR_CLASS, 'title', 'content', 'Sarthe', []);
    expect(gateway.postCalls[0]?.appliedTags).toEqual(['tag-sarthe']);

    gateway.postCalls = [];
    gateway.forumTags = [{ id: 'tag-cota', name: 'COTA' }];
    await client.shareToForum(CAR_CLASS, 'title', 'content', 'Americas', []);
    expect(gateway.postCalls[0]?.appliedTags).toEqual(['tag-cota']);

    gateway.postCalls = [];
    gateway.forumTags = [{ id: 'tag-monza', name: 'Monza' }];
    await client.shareToForum(CAR_CLASS, 'title', 'content', 'Sepang International', []);
    expect(gateway.postCalls[0]?.appliedTags).toEqual([]);
  });

  it('skips the tag lookup for a blank track name, like Java', async () => {
    const client = build(VALID_CONFIG);
    await client.shareToForum(CAR_CLASS, 'title', 'content', '   ', []);
    expect(gateway.forumCalls).toEqual([]);
    expect(gateway.postCalls[0]?.appliedTags).toEqual([]);
  });

  it('still posts when the tag lookup fails', async () => {
    const sink = recordingSink();
    const client = build(VALID_CONFIG, sink);
    gateway.forumError = new Error('Discord API 403: {"code":50013}');
    const result = await client.shareToForum(CAR_CLASS, 'title', 'content', 'Portimao', []);
    expect(result.success).toBe(true);
    expect(sink.lines.join('\n')).toContain('Failed to match Discord tag');
  });

  it('keeps Java error text for an API rejection', async () => {
    const client = build(VALID_CONFIG);
    gateway.postError = new Error('Discord API error: 400 - {"code":50035,"message":"Invalid Form Body"}');
    await expect(client.shareToForum(CAR_CLASS, 'title', 'content', '', [])).resolves.toEqual({
      success: false,
      error: 'Discord API error: 400 - {"code":50035,"message":"Invalid Form Body"}',
    });
  });

  it('never lets the bot token reach the response or the log', async () => {
    const sink = recordingSink();
    const client = build(VALID_CONFIG, sink);
    gateway.postError = new Error(`Authorization failed for Bot ${FAKE_TOKEN}`);
    const result = await client.shareToForum(CAR_CLASS, 'title', 'content', '', []);
    expect(result).toEqual({ success: false, error: 'Authorization failed for Bot [redacted]' });
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
    expect(sink.lines.join('\n')).not.toContain(FAKE_TOKEN);
  });
});

describe('DiscordClient member lookup', () => {
  it('prefers an exact match over an earlier substring match', async () => {
    const client = build(VALID_CONFIG);
    gateway.members = [member('1001', 'lukethefirst'), member('1002', 'luke')];
    await expect(client.searchGuildMember('@Luke')).resolves.toEqual({ user_id: '1002', username: 'luke' });
    expect(gateway.searchCalls).toEqual([{ guildId: GUILD, query: 'Luke', limit: 100 }]);
  });

  it('matches global_name and nick in the exact pass, then substring in the second pass', async () => {
    const client = build(VALID_CONFIG);
    gateway.members = [member('2001', 'someone', { globalName: 'Race Engineer' })];
    await expect(client.searchGuildMember('race engineer')).resolves.toEqual({
      user_id: '2001',
      username: 'someone',
    });

    gateway.members = [member('2002', 'driver2025', { nick: 'TheDriver' })];
    await expect(client.searchGuildMember('The')).resolves.toEqual({ user_id: '2002', username: 'driver2025' });

    gateway.members = [member('2003', 'totally-other')];
    await expect(client.searchGuildMember('luke')).resolves.toBeNull();
  });

  it('returns null for blank queries', async () => {
    const client = build(VALID_CONFIG);
    await expect(client.searchGuildMember('   ')).resolves.toBeNull();
    await expect(client.searchGuildMember(null)).resolves.toBeNull();
    await expect(client.searchGuildMember('@')).resolves.toBeNull();
    expect(gatewayCreations).toEqual([]);
  });

  it('logs a search failure with the Java message and no credential', async () => {
    const sink = recordingSink();
    const client = build(VALID_CONFIG, sink);
    gateway.searchGuildMembers = async () => {
      throw new Error(`Discord API 401: invalid token ${FAKE_TOKEN}`);
    };
    await expect(client.searchGuildMember('luke')).resolves.toBeNull();
    expect(sink.lines.join('\n')).toContain('Failed to search Discord member luke');
    expect(sink.lines.join('\n')).not.toContain(FAKE_TOKEN);
  });

  it('flattens the member into the Java display-name and avatar rules', async () => {
    const client = build(VALID_CONFIG);
    gateway.membersById = new Map([
      ['758452175975940097', member('758452175975940097', 'driver', { globalName: 'Global Driver', nick: 'Pit Nick', avatar: 'ab12cd' })],
      ['451716747800461327', member('451716747800461327', 'driver', { globalName: 'Global Driver' })],
      ['84484653687267328', member('84484653687267328', 'bare')],
    ]);

    await expect(client.getGuildMember('758452175975940097')).resolves.toEqual({
      id: '758452175975940097',
      username: 'driver',
      display_name: 'Pit Nick',
      avatar_url: 'https://cdn.discordapp.com/avatars/758452175975940097/ab12cd.png',
      avatar_hash: 'ab12cd',
    });

    const withoutNick = await client.getGuildMember('451716747800461327');
    expect(withoutNick?.display_name).toBe('Global Driver');
    expect(withoutNick?.avatar_url).toBe('https://cdn.discordapp.com/embed/avatars/0.png');

    const noNames = await client.getGuildMember('84484653687267328');
    expect(noNames?.display_name).toBe('bare');
    expect(noNames?.avatar_url).toBe('https://cdn.discordapp.com/embed/avatars/4.png');
  });

  it('caches a member for 15 minutes and does not cache an unknown one', async () => {
    const client = build(VALID_CONFIG);
    gateway.member = member('84484653687267328', 'cached');
    await client.getGuildMember('84484653687267328');
    await client.getGuildMember('84484653687267328');
    expect(gateway.memberCalls).toEqual(['84484653687267328']);

    clock.value += 15 * 60_000 + 1;
    await client.getGuildMember('84484653687267328');
    expect(gateway.memberCalls).toHaveLength(2);

    gateway.member = null;
    await expect(client.getGuildMember('999999999999999999')).resolves.toBeNull();
    await expect(client.getGuildMember('999999999999999999')).resolves.toBeNull();
    expect(gateway.memberCalls.filter((id) => id === '999999999999999999')).toHaveLength(2);
  });

  it('swallows a member fetch error like Java did', async () => {
    const sink = recordingSink();
    const client = build(VALID_CONFIG, sink);
    gateway.memberError = new Error('Discord API 404: {"code":100073}');
    await expect(client.getGuildMember('1234567890123456789')).resolves.toBeNull();
    expect(sink.lines.join('\n')).toContain('Failed to fetch Discord member 1234567890123456789');
  });
});

describe('DiscordClient.listSharedLaps', () => {
  it('returns nothing without a full config', async () => {
    await expect(build({ guild_id: GUILD }).listSharedLaps(CAR_CLASS)).resolves.toEqual([]);
    await expect(build({ bot_token: FAKE_TOKEN }).listSharedLaps(CAR_CLASS)).resolves.toEqual([]);
    await expect(build(VALID_CONFIG).listSharedLaps('lmp3-telemetry-sharing')).resolves.toEqual([]);
    expect(gatewayCreations).toEqual([]);
  });

  it('merges active and archived threads, drops locked/blank ids and orders like Java', async () => {
    const client = build(VALID_CONFIG);
    gateway.activeThreads = [
      thread('9'),
      thread('10'),
      thread('20', 'Locked post', true),
      thread('10', 'Later entry wins the slot'),
    ];
    gateway.archivedThreads = [thread('300'), thread('')];
    for (const id of ['9', '10', '300']) {
      gateway.messages.set(
        id,
        message({
          author: user({ id: `author${id}`, username: `driver${id}` }),
          attachments: [attachment('Race.DUCKDB', `${DUCKDB_URL}?x=${id}`, 1024)],
        }),
      );
    }

    const shares = await client.listSharedLaps(CAR_CLASS);
    // Java compares ids as strings: "9" > "300" > "10".
    expect(shares.map((share) => share.thread_id)).toEqual(['9', '300', '10']);
    expect(shares[2]?.title).toBe('Later entry wins the slot');
    expect(gateway.starterCalls).toEqual(['9', '300', '10']);
    expect(gateway.activeCalls).toBe(1);
    expect(gateway.archivedCalls).toBe(1);
  });

  it('caps the list at 20 threads', async () => {
    const client = build(VALID_CONFIG);
    const ids = Array.from({ length: 25 }, (_unused, index) => String(1_000 + index));
    gateway.activeThreads = ids.map((id) => thread(id));
    for (const id of ids) {
      gateway.messages.set(
        id,
        message({ author: user({ id: '700', username: 'a' }), attachments: [attachment('s.duckdb', DUCKDB_URL, 1)] }),
      );
    }
    const shares = await client.listSharedLaps(CAR_CLASS);
    expect(shares).toHaveLength(20);
    expect(gateway.starterCalls).toHaveLength(20);
    expect(shares[0]?.thread_id).toBe('1024');
    expect(shares[19]?.thread_id).toBe('1005');
  });

  it('builds the share JSON exactly like Java, keeping both attachment slots', async () => {
    const client = build(VALID_CONFIG);
    gateway.activeThreads = [thread('500'), thread('501')];
    gateway.messages.set(
      '500',
      message({
        content: '<@758452175975940097> shared a lap\n\n### Header\n---\n**Track:** Portimao\n---\nmore',
        author: user({ id: '999', username: 'starter', globalName: 'Starter' }),
        attachments: [
          attachment('notes.txt', 'https://cdn.discordapp.com/attachments/1/2/notes.txt', 5),
          attachment('Session_A.duckdb', DUCKDB_URL, 2048),
          attachment('second.duckdb', 'https://cdn.discordapp.com/attachments/1/2/second.duckdb', 4096),
          attachment('Setup.SVM', SVM_URL, 77),
        ],
        createdTimestamp: 1_738_368_000_123,
      }),
    );
    gateway.member = member('758452175975940097', 'mentioned', { nick: 'Pit Nick', avatar: 'hash9' });

    const shares = await client.listSharedLaps(CAR_CLASS);
    expect(shares).toHaveLength(1);
    expect(JSON.stringify(shares[0])).toBe(
      JSON.stringify({
        thread_id: '500',
        title: 'Thread 500',
        author: {
          id: '758452175975940097',
          username: 'mentioned',
          display_name: 'Pit Nick',
          avatar_url: 'https://cdn.discordapp.com/avatars/758452175975940097/hash9.png',
        },
        content: '**Track:** Portimao\n---\nmore',
        telemetry: { filename: 'Session_A.duckdb', url: DUCKDB_URL, size: 2048 },
        setup: { filename: 'Setup.SVM', url: SVM_URL, size: 77 },
        created_at: '2025-02-01T00:00:00.123+00:00',
      }),
    );
  });

  it('falls back to the message author when the mention cannot be resolved', async () => {
    const client = build(VALID_CONFIG);
    gateway.activeThreads = [thread('600', 'Mentioned but absent')];
    gateway.member = null;
    gateway.messages.set(
      '600',
      message({
        content: '<@758452175975940097> no header here',
        author: user({ id: '451716747800461327', username: 'fallback', globalName: 'Fallback Name' }),
        attachments: [attachment('s.duckdb', DUCKDB_URL, 1)],
      }),
    );
    const shares = await client.listSharedLaps(CAR_CLASS);
    expect(shares[0]?.author).toEqual({
      id: '451716747800461327',
      username: 'fallback',
      display_name: 'Fallback Name',
      avatar_url: 'https://cdn.discordapp.com/embed/avatars/0.png',
    });
    expect(shares[0]?.content).toBe('<@758452175975940097> no header here');
    expect(shares[0]?.setup).toBeNull();
    expect(shares[0]?.telemetry).toEqual({ filename: 's.duckdb', url: DUCKDB_URL, size: 1 });
  });

  it('uses "Unknown" when the starter author has no name', async () => {
    const client = build(VALID_CONFIG);
    gateway.activeThreads = [thread('700')];
    gateway.messages.set(
      '700',
      message({
        author: user({ id: '800', username: undefined }),
        attachments: [attachment('s.duckdb', DUCKDB_URL, 1)],
      }),
    );
    const shares = await client.listSharedLaps(CAR_CLASS);
    expect(shares[0]?.author.username).toBe('Unknown');
    expect(shares[0]?.author.display_name).toBe('Unknown');
    expect(shares[0]?.author.avatar_url).toBe('https://cdn.discordapp.com/embed/avatars/0.png');
  });

  it('caches per channel for 60 seconds', async () => {
    const client = build(VALID_CONFIG);
    gateway.activeThreads = [thread('800')];
    gateway.messages.set(
      '800',
      message({ author: user({ id: '1', username: 'a' }), attachments: [attachment('s.duckdb', DUCKDB_URL, 1)] }),
    );
    await client.listSharedLaps(CAR_CLASS);
    await client.listSharedLaps(CAR_CLASS);
    expect(gateway.activeCalls).toBe(1);
    expect(gateway.starterCalls).toEqual(['800']);

    clock.value += 60_001;
    await client.listSharedLaps(CAR_CLASS);
    expect(gateway.activeCalls).toBe(2);
  });

  it('returns an empty list and logs when the gateway blows up', async () => {
    const sink = recordingSink();
    const client = build(VALID_CONFIG, sink);
    gateway.activeError = new Error('Discord API 403: {"code":50001}');
    await expect(client.listSharedLaps(CAR_CLASS)).resolves.toEqual([]);
    expect(sink.lines.join('\n')).toContain(`Failed to list Discord shares for ${CAR_CLASS}`);
    expect(sink.lines.join('\n')).not.toContain(FAKE_TOKEN);
  });
});

describe('DiscordClient.getThreadAttachments', () => {
  it('exposes the inputs the discord__<threadId> download path needs', async () => {
    const client = build(VALID_CONFIG);
    gateway.messages.set(
      '900',
      message({
        author: user({ id: '1', username: 'a' }),
        attachments: [attachment('session.duckdb', DUCKDB_URL, 123), attachment('setup.svm', SVM_URL, 45)],
      }),
    );
    expect(JSON.stringify(await client.getThreadAttachments('900'))).toBe(
      `{"telemetry":{"filename":"session.duckdb","url":"${DUCKDB_URL}","size":123},"setup":{"filename":"setup.svm","url":"${SVM_URL}","size":45}}`,
    );
  });

  it('keeps both keys null when nothing matches and the whole result without a token', async () => {
    const client = build(VALID_CONFIG);
    gateway.messages.set(
      '901',
      message({ author: user({ id: '1', username: 'a' }), attachments: [attachment('a.png', 'https://cdn.discordapp.com/a.png', 1)] }),
    );
    await expect(client.getThreadAttachments('901')).resolves.toEqual({ telemetry: null, setup: null });
    await expect(build(null).getThreadAttachments('901')).resolves.toBeNull();
  });

  it('swallows API errors like Java', async () => {
    const sink = recordingSink();
    const client = build(VALID_CONFIG, sink);
    gateway.messageError = new Error('Discord API 403: {"code":50001}');
    await expect(client.getThreadAttachments('902')).resolves.toBeNull();
    expect(sink.lines.join('\n')).toContain('Failed to fetch Discord thread attachments 902');
  });
});

describe('DiscordClient.downloadFile', () => {
  interface FetchCapture {
    url?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal | null;
    redirect?: string;
  }

  function downloadClient(status: number, body: string, capture?: FetchCapture): DiscordClient {
    const config = new DiscordConfig({ appHome, dataRoot }, { env: {} });
    return new DiscordClient(config, {
      gatewayFactory: async () => new FakeGateway(),
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (capture) {
          capture.url = String(input);
          capture.headers = init?.headers as Record<string, string>;
          capture.signal = init?.signal ?? null;
          capture.redirect = init?.redirect;
        }
        return new Response(body, { status });
      }) as typeof globalThis.fetch,
    });
  }

  it('rejects anything outside the Discord CDNs with the Java 400 text', async () => {
    const target = path.join(root, 'downloads', 'x.duckdb');
    const client = downloadClient(200, 'data');
    const error = await client.downloadFile('https://example.com/x.duckdb', target).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).status).toBe(400);
    expect((error as ApiException).message).toBe('Unsupported download URL');
    await expect(client.downloadFile('', target)).rejects.toThrow('Unsupported download URL');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('streams to <destination>.tmp then moves it into place', async () => {
    const capture: FetchCapture = {};
    const target = path.join(root, 'downloads', 'nested', '900.duckdb');
    const client = downloadClient(200, 'telemetry-bytes', capture);
    await client.downloadFile('https://media.discordapp.net/attachments/1/2/session.duckdb', target);

    expect(fs.readFileSync(target, 'utf8')).toBe('telemetry-bytes');
    expect(fs.existsSync(`${target}.tmp`)).toBe(false);
    expect(capture.url).toBe('https://media.discordapp.net/attachments/1/2/session.duckdb');
    expect(capture.headers?.['User-Agent']).toBe('LMU-Telemetry-Lab/1.5.3');
    expect(capture.redirect).toBe('follow');
    expect(capture.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports a bad status the way Java did and cleans the temp file up', async () => {
    const target = path.join(root, 'downloads', 'missing.duckdb');
    const client = downloadClient(404, 'nope');
    await expect(client.downloadFile(DUCKDB_URL, target)).rejects.toThrow('Download failed with status 404');
    expect(fs.existsSync(`${target}.tmp`)).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
  });
});
