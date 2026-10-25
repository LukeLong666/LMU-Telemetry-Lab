import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, GatewayIntentBits } from 'discord.js';
import { createDiscordJsGateway } from '../../../src/infra/discord/client.js';

/**
 * Offline check of the discord.js adapter: a real discord.js `Client` with a stubbed REST layer.
 * Nothing here talks to Discord — it proves the API surface `createDiscordJsGateway()` calls
 * (guilds/members search/member fetch/forum tags/thread create/forum threads/starter message)
 * really exists in v14 ESM and that the mapping into our plain snapshots is correct.
 */

const GUILD = '1496410659557081098';
const CHANNEL = '1505950451114311730';
const THREAD = '1509000000000000001';
const MEMBER = '758452175975940097';
const DUCKDB_URL = 'https://cdn.discordapp.com/attachments/1505950451114311730/1/Session.duckdb';

type RestMethod = (route: string, options?: { query?: URLSearchParams; body?: unknown; files?: unknown[]; reason?: string }) => Promise<unknown>;

interface Recorded {
  get: { route: string; query?: string }[];
  post: { route: string; body: Record<string, unknown> | undefined; files: { name?: string; description?: string; data: Uint8Array }[] }[];
}

const rawUser = (id: string, username: string, globalName: string | null, avatar: string | null) => ({
  id,
  username,
  discriminator: '0',
  public_flags: 0,
  flags: 0,
  global_name: globalName,
  avatar,
  bot: false,
});

const rawMember = (id: string, username: string, extras: { globalName?: string | null; nick?: string | null; avatar?: string | null } = {}) => ({
  user: rawUser(id, username, extras.globalName ?? null, extras.avatar ?? null),
  nick: extras.nick ?? null,
  roles: [],
  joined_at: '2024-01-01T00:00:00.000000+00:00',
  pending: false,
});

const rawThread = (id: string, name: string, locked: boolean) => ({
  id,
  guild_id: GUILD,
  parent_id: CHANNEL,
  type: 11,
  name,
  owner_id: MEMBER,
  message_count: 1,
  member_count: 1,
  create_reason: null,
  auto_archive_duration: 1440,
  archived: false,
  archived_id: '',
  archive_timestamp: '2025-02-01T00:00:00.000000+00:00',
  locked,
  invitable: null,
  flags: 0,
  thread_metadata: {
    archived: false,
    archive_timestamp: '2025-02-01T00:00:00.000000+00:00',
    auto_archive_duration: 1440,
    locked,
    create_reason: null,
    invitable: null,
  },
});

const rawMessage = () => ({
  id: THREAD,
  channel_id: THREAD,
  guild_id: GUILD,
  author: rawUser(MEMBER, 'driver', 'Global Driver', 'ab12cd'),
  content: '<@758452175975940097> header\n---\n**Track:** Portimao',
  timestamp: '2025-02-01T00:00:00.123456+00:00',
  edited_timestamp: null,
  type: 0,
  flags: 0,
  tts: false,
  mention_everyone: false,
  mentions: [],
  mention_roles: [],
  mention_channels: [],
  attachments: [
    {
      id: '1700000000000000001',
      filename: 'Session.duckdb',
      description: 'Uploaded file: Session.duckdb',
      content_type: 'application/octet-stream',
      size: 2048,
      url: DUCKDB_URL,
      proxy_url: DUCKDB_URL,
      height: null,
      width: null,
      ephemeral: false,
    },
  ],
  embeds: [],
  reactions: [],
  pinned: false,
  referenced_message: null,
});

let client: Client;
let recorded: Recorded;
let tempDir = '';

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmu-discordjs-'));
  client = new Client({ intents: [GatewayIntentBits.Guilds] });
  recorded = { get: [], post: [] };

  const rest = client.rest as unknown as { get: RestMethod; post: RestMethod };
  rest.get = async (route, options) => {
    recorded.get.push({ route, query: options?.query?.toString() });
    if (route === `/guilds/${GUILD}`) {
      return {
        id: GUILD,
        name: 'LMU Telemetry Lab',
        icon: null,
        owner_id: MEMBER,
        member_count: 2,
        unavailable: false,
        large: false,
        joined_at: '2024-01-01T00:00:00.000000+00:00',
        roles: [],
        channels: [],
        members: [],
        emojis: [],
        stickers: [],
        threads: [],
        features: [],
        verification_level: 0,
      };
    }
    if (route === `/channels/${CHANNEL}`) {
      return {
        id: CHANNEL,
        guild_id: GUILD,
        type: 15,
        name: 'LMGT3 Telemetry Sharing',
        topic: null,
        nsfw: false,
        last_message_id: null,
        bitrate: 0,
        user_limit: 0,
        rate_limit_per_user: 0,
        permissions: '0',
        parent_id: null,
        rpc_application_id: null,
        flags: 0,
        available_tags: [
          { id: 'tag-algarve', name: 'Algarve', moderated: false, emoji_id: null, emoji_name: null },
          { id: 'tag-portimao', name: 'Portimão', moderated: false, emoji_id: null, emoji_name: '🏁' },
        ],
        default_auto_archive_duration: 1440,
        default_thread_rate_limit_per_user: 0,
        default_sort_order: null,
        default_reaction_emoji: null,
      };
    }
    if (route === `/guilds/${GUILD}/threads/active`) {
      return { threads: [rawThread(THREAD, 'Portimao GT3', false), rawThread('1509000000000000002', 'Locked', true)], members: [] };
    }
    if (route === `/channels/${CHANNEL}/threads/archived/public`) {
      return { threads: [rawThread('1509000000000000003', 'Archived post', false)], members: [], has_more: false };
    }
    if (route === `/guilds/${GUILD}/members/search`) {
      return [rawMember('1001', 'lukethefirst'), rawMember(MEMBER, 'driver', { globalName: 'Global Driver', nick: 'Pit Nick', avatar: 'ab12cd' })];
    }
    if (route === `/guilds/${GUILD}/members/${MEMBER}`) {
      return rawMember(MEMBER, 'driver', { globalName: 'Global Driver', nick: 'Pit Nick', avatar: 'ab12cd' });
    }
    if (route === `/channels/${THREAD}/messages/${THREAD}`) return rawMessage();
    throw new Error(`unstubbed GET ${route}`);
  };

  rest.post = async (route, options) => {
    const files = (options?.files ?? []) as { name?: string; description?: string; data: Uint8Array }[];
    recorded.post.push({ route, body: options?.body as Record<string, unknown> | undefined, files });
    if (route === `/channels/${CHANNEL}/threads`) {
      return {
        ...rawThread(THREAD, String((options?.body as { name?: string } | undefined)?.name ?? ''), false),
        messages: [rawMessage()],
      };
    }
    throw new Error(`unstubbed POST ${route}`);
  };
});

afterAll(async () => {
  await client.destroy();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('createDiscordJsGateway against real discord.js structures (stubbed REST)', () => {
  it('reads forum tags through ForumChannel.availableTags', async () => {
    const gateway = await createDiscordJsGateway('token', { client, connect: false });
    const forum = await gateway.fetchForum(GUILD, CHANNEL);
    expect(forum).toEqual({
      id: CHANNEL,
      availableTags: [
        { id: 'tag-algarve', name: 'Algarve' },
        { id: 'tag-portimao', name: 'Portimão' },
      ],
    });
    expect(recorded.get.map((call) => call.route)).toEqual([`/guilds/${GUILD}`, `/channels/${CHANNEL}`]);
  });

  it('maps active and archived threads, keeping the Java parent filter', async () => {
    const gateway = await createDiscordJsGateway('token', { client, connect: false });
    const active = await gateway.fetchActiveThreads(GUILD, CHANNEL);
    expect(active).toEqual([
      { id: THREAD, name: 'Portimao GT3', locked: false },
      // Locked threads are skipped by DiscordClient.listSharedLaps (as in Java), not here.
      { id: '1509000000000000002', name: 'Locked', locked: true },
    ]);

    const archived = await gateway.fetchArchivedThreads(GUILD, CHANNEL);
    expect(archived).toEqual([{ id: '1509000000000000003', name: 'Archived post', locked: false }]);
    const archivedRoute = recorded.get.find((call) => call.route.endsWith('/threads/archived/public'));
    expect(archivedRoute?.route).toBe(`/channels/${CHANNEL}/threads/archived/public`);
    expect(archivedRoute?.query ?? '').not.toContain('before');
  });

  it('maps the starter message into a plain snapshot', async () => {
    const gateway = await createDiscordJsGateway('token', { client, connect: false });
    const snapshot = await gateway.fetchStarterMessage(GUILD, THREAD);
    expect(snapshot?.content).toBe('<@758452175975940097> header\n---\n**Track:** Portimao');
    expect(snapshot?.author).toEqual({ id: MEMBER, username: 'driver', globalName: 'Global Driver', avatarHash: 'ab12cd' });
    expect(snapshot?.attachments).toEqual([{ filename: 'Session.duckdb', url: DUCKDB_URL, size: 2048 }]);
    expect(snapshot?.createdTimestamp).toBeGreaterThan(0);
  });

  it('maps member search and single member fetch results', async () => {
    const gateway = await createDiscordJsGateway('token', { client, connect: false });
    const found = await gateway.searchGuildMembers(GUILD, 'Luke', 100);
    expect(recorded.get.some((call) => call.route === `/guilds/${GUILD}/members/search`)).toBe(true);
    expect(recorded.get.find((call) => call.route.endsWith('members/search'))?.query).toContain('query=Luke');
    expect(found).toHaveLength(2);
    expect(found[1]).toEqual({
      user: { id: MEMBER, username: 'driver', globalName: 'Global Driver', avatarHash: 'ab12cd' },
      nick: 'Pit Nick',
    });

    const single = await gateway.fetchGuildMember(GUILD, MEMBER);
    expect(single?.nick).toBe('Pit Nick');
  });

  it('creates the forum post with Java-equivalent attachment metadata', async () => {
    const gateway = await createDiscordJsGateway('token', { client, connect: false });
    const telemetry = path.join(tempDir, 'Session_2025-02-01_10-00-00.duckdb');
    const setup = path.join(tempDir, 'Portimao_GT3_10-00-00_setup.svm');
    fs.writeFileSync(telemetry, 'duckdb-bytes');
    fs.writeFileSync(setup, 'svm-bytes');

    const created = await gateway.createForumPost({
      guildId: GUILD,
      channelId: CHANNEL,
      name: 'Portimao GT3 1m42s321',
      content: '### Telemetry Shared by <@758452175975940097>',
      appliedTags: ['tag-algarve'],
      files: [
        { path: telemetry, filename: 'Session_2025-02-01_10-00-00.duckdb', description: 'Uploaded file: Session_2025-02-01_10-00-00.duckdb' },
        { path: setup, filename: 'Portimao_GT3_10-00-00_setup.svm', description: 'Uploaded file: Portimao_GT3_10-00-00_setup.svm' },
      ],
    });
    expect(created).toBe(THREAD);

    const post = recorded.post.find((call) => call.route === `/channels/${CHANNEL}/threads`);
    expect(post).toBeDefined();
    const body = post?.body as {
      name: string;
      applied_tags: string[];
      message: { content: string; attachments: { id: string; description?: string }[] };
    };
    expect(body.name).toBe('Portimao GT3 1m42s321');
    expect(body.applied_tags).toEqual(['tag-algarve']);
    expect(body.message.content).toBe('### Telemetry Shared by <@758452175975940097>');
    // discord.js keeps the filename on the multipart part and sends only {id, description, ...}
    // placeholders in the JSON body (MessagePayload#extractFiles); Java set both per part.
    expect(body.message.attachments.map((attachment) => [attachment.id, attachment.description])).toEqual([
      ['0', 'Uploaded file: Session_2025-02-01_10-00-00.duckdb'],
      ['1', 'Uploaded file: Portimao_GT3_10-00-00_setup.svm'],
    ]);
    expect(post?.files.map((file) => file.name)).toEqual([
      'Session_2025-02-01_10-00-00.duckdb',
      'Portimao_GT3_10-00-00_setup.svm',
    ]);
    expect(Buffer.from(post?.files[0]?.data ?? []).toString()).toBe('duckdb-bytes');
    expect(Buffer.from(post?.files[1]?.data ?? []).toString()).toBe('svm-bytes');
  });
});
