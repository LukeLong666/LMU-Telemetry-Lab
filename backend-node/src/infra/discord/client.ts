import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
// Type-only: discord.js is loaded at runtime exclusively inside createDiscordJsGateway().
import type { Client as DiscordJsClient } from 'discord.js';
import { ApiException } from '../../api/error.js';
import type { DiscordLogSink, DiscordSettings } from './config.js';
import { DiscordConfig } from './config.js';

/**
 * Discord transport — port of `infra/discord/DiscordClient.java`.
 *
 * The public method set is exactly what `application/DiscordService.java` and
 * `infra/fs/SessionRepository.java` call, and every returned value is a plain DTO defined below:
 * no discord.js object (Client/Guild/ThreadChannel/Message/Attachment) ever crosses this boundary,
 * so the HTTP JSON contract stays byte-identical to the Java backend.
 *
 * Java -> discord.js mapping (see §6.2 of NODEJS_BACKEND_REWRITE_PLAN.md):
 *   GET /guilds/{id}/members/search   -> guild.members.search({query, limit})
 *   GET /guilds/{id}/members/{user}   -> guild.members.fetch(user)
 *   GET /channels/{id} (available_tags)-> guild.channels.fetch(id) + channel.availableTags
 *   POST /channels/{id}/threads        -> forumChannel.threads.create({name, message:{files}, appliedTags})
 *   GET /guilds/{id}/threads/active    -> forumChannel.threads.fetchActive()
 *   GET /channels/{id}/threads/archived/public -> forumChannel.threads.fetchArchived()
 *   GET /channels/{t}/messages/{t}     -> threadChannel.messages.fetch(t)
 *   manual 429 retry / connect timeout -> @discordjs/rest queue + rest.timeout
 *   CDN download                       -> Node fetch (unchanged: not a gateway concern)
 */

const SHARES_TTL_MS = 60_000;
const MEMBER_TTL_MS = 15 * 60_000;
/** Java truncates the thread list with `subList(0, min(20, size))`. */
const SHARE_LIMIT = 20;
/** Java's member search used `limit=100`. */
const MEMBER_SEARCH_LIMIT = 100;
const USER_AGENT = 'LMU-Telemetry-Lab/1.5.3';
/** Java used a 5 minute timeout on the CDN download. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const ALLOWED_DOWNLOAD_PREFIXES: readonly string[] = [
  'https://cdn.discordapp.com/',
  'https://media.discordapp.net/',
];
/** Java's `DiscordService.share(...)` wording for a missing token; reused so texts stay identical. */
const TOKEN_MISSING_MESSAGE = 'Discord Bot is not configured. Please check discord_config.json';
const USER_MENTION = /<@(\d+)>/;
const AUTH_HEADER_LEAK = /\b(?:Bot|Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** Same five entries as `Map.of(...)` in DiscordClient.matchTag(). */
const TRACK_TAG_ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['algarve', ['portimao', 'portimão']],
  ['sarthe', ['le mans', 'lemans']],
  ['americas', ['cota']],
  ['losail', ['lusail']],
  ['spa-francorchamps', ['spa']],
];

// ---------------------------------------------------------------------------
// Public DTOs — these are the JSON shapes the api layer serialises.
// ---------------------------------------------------------------------------

/** `Map` produced by `attachment(...)`: `{filename, url, size}`. */
export interface DiscordAttachmentInfo {
  filename: string;
  url: string;
  size: number;
}

/** `getThreadAttachments`: always both keys, values nullable (Java LinkedHashMap). */
export interface DiscordThreadAttachments {
  telemetry: DiscordAttachmentInfo | null;
  setup: DiscordAttachmentInfo | null;
}

/** `share.author`: `{id, username, display_name, avatar_url}`. */
export interface DiscordShareAuthor {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
}

/** One entry of `listSharedLaps`. Key order matches Java's LinkedHashMap. */
export interface DiscordSharedLap {
  thread_id: string;
  title: string;
  author: DiscordShareAuthor;
  content: string;
  telemetry: DiscordAttachmentInfo;
  setup: DiscordAttachmentInfo | null;
  created_at: string;
}

/** `searchGuildMember`: `{user_id, username}` or null when the user is not a member. */
export interface DiscordMemberMatch {
  user_id: string;
  username: string;
}

/** `getGuildMember` flattened to the fields the share flow needs. */
export interface DiscordMemberInfo {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  /** Raw `user.avatar` hash ('' when absent); Java handed the raw member node to its callers. */
  avatar_hash: string;
}

/** `shareToForum` result: `{success, thread_id}` / `{success, error}`. */
export type DiscordShareResult =
  | { success: true; thread_id: string }
  | { success: false; error: string };

/** One uploaded file: path plus the multipart `filename`/`description` Java sent. */
export interface DiscordUploadFile {
  path: string;
  filename: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Gateway port — the discord.js surface this client uses, in plain data.
// ---------------------------------------------------------------------------

export interface GatewayUserSummary {
  id: string;
  username: string;
  globalName: string | null;
  avatarHash: string | null;
}

export interface GatewayMemberSnapshot {
  user: GatewayUserSummary;
  nick: string | null;
}

export interface GatewayForumTag {
  id: string;
  name: string;
}

export interface GatewayForumSnapshot {
  id: string;
  availableTags: readonly GatewayForumTag[];
}

export interface GatewayThreadSnapshot {
  id: string;
  name: string;
  locked: boolean;
}

export interface GatewayAttachmentSnapshot {
  filename: string;
  url: string;
  size: number | null;
}

export interface GatewayMessageSnapshot {
  content: string;
  /** Epoch milliseconds, like Java's `Message#timestamp` (ms precision, see report). */
  createdTimestamp: number;
  author: GatewayUserSummary;
  attachments: readonly GatewayAttachmentSnapshot[];
}

export interface GatewayForumPostRequest {
  guildId: string;
  channelId: string;
  name: string;
  content: string;
  appliedTags: readonly string[];
  files: readonly DiscordUploadFile[];
}

export interface DiscordGateway {
  searchGuildMembers(guildId: string, query: string, limit: number): Promise<GatewayMemberSnapshot[]>;
  /** Resolves null for "unknown member" (Discord 100073); other failures reject. */
  fetchGuildMember(guildId: string, userId: string): Promise<GatewayMemberSnapshot | null>;
  fetchForum(guildId: string, channelId: string): Promise<GatewayForumSnapshot>;
  /** Resolves the created thread id. */
  createForumPost(request: GatewayForumPostRequest): Promise<string>;
  fetchActiveThreads(guildId: string, channelId: string): Promise<GatewayThreadSnapshot[]>;
  fetchArchivedThreads(guildId: string, channelId: string): Promise<GatewayThreadSnapshot[]>;
  fetchStarterMessage(guildId: string, threadId: string): Promise<GatewayMessageSnapshot | null>;
  close(): Promise<void>;
}

export type DiscordGatewayFactory = (token: string) => Promise<DiscordGateway>;

export interface DiscordClientOptions {
  /** Replaced in tests; defaults to a lazily logged-in discord.js client. */
  readonly gatewayFactory?: DiscordGatewayFactory;
  readonly logger?: DiscordLogSink;
  /** Replaced in tests; defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

interface CacheEntry<T> {
  value: T;
  storedAt: number;
}

export class DiscordClient {
  private readonly gatewayFactory: DiscordGatewayFactory;
  private readonly logger: DiscordLogSink | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly sharesCache = new Map<string, CacheEntry<DiscordSharedLap[]>>();
  private readonly memberCache = new Map<string, CacheEntry<DiscordMemberInfo>>();
  private gatewayPromise: Promise<DiscordGateway> | null = null;
  private gatewayToken: string | null = null;

  constructor(
    private readonly config: DiscordConfig,
    options: DiscordClientOptions = {},
  ) {
    this.gatewayFactory = options.gatewayFactory ?? createDiscordJsGateway;
    this.logger = options.logger;
    this.fetchImpl = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.now = options.now ?? (() => Date.now());
  }

  public isConfigured(): boolean {
    return this.config.isConfigured();
  }

  public inviteUrl(): string | null {
    return this.config.inviteUrl();
  }

  /** Java's `shareToForum(...)`: forum post with N files, optional track tag. */
  public async shareToForum(
    carClass: string,
    title: string,
    content: string,
    trackTagName: string,
    files: readonly string[],
  ): Promise<DiscordShareResult> {
    const cfg = this.config.load();
    if (cfg.botToken === null) {
      return { success: false, error: 'Discord Bot not configured' };
    }
    const channelId = this.channelOf(cfg, carClass);
    if (channelId === null) {
      return { success: false, error: `No Discord channel ID configured for car class: ${carClass}` };
    }

    const tagId = await this.matchTag(cfg, channelId, trackTagName);
    try {
      const gateway = await this.gateway();
      const threadId = await gateway.createForumPost({
        guildId: cfg.guildId ?? '',
        channelId,
        name: title,
        content,
        appliedTags: tagId === null ? [] : [tagId],
        files: files.map((file) => toUploadFile(file)),
      });
      return { success: true, thread_id: threadId };
    } catch (error) {
      this.logger?.error('Discord share failed', { error: this.describe(error) });
      return { success: false, error: this.describe(error) || 'Discord share failed' };
    }
  }

  /** Exact-match pass first, then the substring pass — same two loops as Java. */
  public async searchGuildMember(username: string | null): Promise<DiscordMemberMatch | null> {
    const cfg = this.config.load();
    if (cfg.botToken === null || cfg.guildId === null) return null;

    const query = (username ?? '').replace(/^@/, '').trim();
    if (query === '') return null;

    try {
      const gateway = await this.gateway();
      const members = await gateway.searchGuildMembers(cfg.guildId, query, MEMBER_SEARCH_LIMIT);
      const lower = query.toLowerCase();
      for (const member of members) {
        if (matchesMember(member, lower, true)) return toMatch(member);
      }
      for (const member of members) {
        if (matchesMember(member, lower, false)) return toMatch(member);
      }
    } catch (error) {
      this.logger?.error(`Failed to search Discord member ${username}`, { error: this.describe(error) });
    }
    return null;
  }

  /** 15 minute cache, like Java's `memberCache`; failures resolve null and are not cached. */
  public async getGuildMember(userId: string): Promise<DiscordMemberInfo | null> {
    const cfg = this.config.load();
    if (cfg.botToken === null || cfg.guildId === null) return null;

    const cached = this.memberCache.get(userId);
    if (cached !== undefined && !expired(cached, MEMBER_TTL_MS, this.now())) return cached.value;

    try {
      const gateway = await this.gateway();
      const member = await gateway.fetchGuildMember(cfg.guildId, userId);
      if (member === null) return null;
      const info = toMemberInfo(member);
      this.memberCache.set(userId, { value: info, storedAt: this.now() });
      return info;
    } catch (error) {
      this.logger?.warn(`Failed to fetch Discord member ${userId}: ${this.describe(error)}`);
      return null;
    }
  }

  /** 60 second cache keyed by channel id; newest-20 threads, `thread_id` descending. */
  public async listSharedLaps(carClass: string): Promise<DiscordSharedLap[]> {
    const cfg = this.config.load();
    if (cfg.botToken === null || cfg.guildId === null) return [];

    const channelId = this.channelOf(cfg, carClass);
    if (channelId === null) return [];

    const cached = this.sharesCache.get(channelId);
    if (cached !== undefined && !expired(cached, SHARES_TTL_MS, this.now())) return cached.value;

    try {
      const gateway = await this.gateway();
      const threads = [
        ...(await gateway.fetchActiveThreads(cfg.guildId, channelId)),
        ...(await gateway.fetchArchivedThreads(cfg.guildId, channelId)),
      ];

      // Java: LinkedHashMap dedup (later put wins, first position kept), locked/blank ids dropped.
      const unique = new Map<string, GatewayThreadSnapshot>();
      for (const thread of threads) {
        if (!thread.locked && thread.id.trim() !== '') unique.set(thread.id, thread);
      }

      // Java: `Comparator.comparing(id).reversed()` — plain UTF-16 string ordering.
      const sorted = [...unique.values()].sort((left, right) => compareDesc(left.id, right.id));

      const shares: DiscordSharedLap[] = [];
      for (const thread of sorted.slice(0, SHARE_LIMIT)) {
        const share = await this.fetchThread(gateway, cfg, thread.id, thread.name);
        if (share !== null) shares.push(share);
      }
      this.sharesCache.set(channelId, { value: shares, storedAt: this.now() });
      return shares;
    } catch (error) {
      this.logger?.error(`Failed to list Discord shares for ${carClass}`, { error: this.describe(error) });
      return [];
    }
  }

  /** Used by `discord__<threadId>` session resolution in the session repository. */
  public async getThreadAttachments(threadId: string): Promise<DiscordThreadAttachments | null> {
    const cfg = this.config.load();
    if (cfg.botToken === null) return null;
    try {
      const gateway = await this.gateway();
      const message = await gateway.fetchStarterMessage(cfg.guildId ?? '', threadId);
      if (message === null) return null;
      return {
        telemetry: pickAttachment(message, '.duckdb'),
        setup: pickAttachment(message, '.svm'),
      };
    } catch (error) {
      this.logger?.error(
        `Failed to fetch Discord thread attachments ${threadId}`,
        { error: this.describe(error) },
      );
      return null;
    }
  }

  /**
   * CDN download with Java's URL allow-list, `<destination>.tmp` scratch file and atomic move.
   * Throws `ApiException(400, "Unsupported download URL")` for anything off the Discord CDNs.
   */
  public async downloadFile(url: string, destination: string): Promise<void> {
    if (!url || !ALLOWED_DOWNLOAD_PREFIXES.some((prefix) => url.startsWith(prefix))) {
      throw new ApiException(400, 'Unsupported download URL');
    }
    const target = path.resolve(destination);
    const parent = path.dirname(target);
    await fs.promises.mkdir(parent, { recursive: true });
    const temp = `${target}.tmp`;

    try {
      const response = await this.fetchImpl(url, {
        redirect: 'follow',
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (response.status !== 200) {
        throw new Error(`Download failed with status ${response.status}`);
      }
      if (!response.body) throw new Error('Download failed with empty body');
      await pipeline(
        Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
        fs.createWriteStream(temp),
      );
      await moveIntoPlace(temp, target);
    } catch (error) {
      throw this.asError(error);
    } finally {
      await fs.promises.rm(temp, { force: true });
    }
  }

  /**
   * Warms the lazy gateway up. Throws the Java wording when no token is available, so the
   * composition root can surface the same message the share endpoint does.
   */
  public async connect(): Promise<void> {
    await this.gateway();
  }

  /** Tears the gateway connection down; call from the Fastify shutdown hook. */
  public async close(): Promise<void> {
    const pending = this.gatewayPromise;
    this.gatewayPromise = null;
    this.gatewayToken = null;
    if (!pending) return;
    try {
      const gateway = await pending;
      await gateway.close();
    } catch (error) {
      this.logger?.warn(`Failed to close Discord gateway: ${this.describe(error)}`);
    }
  }

  private channelOf(cfg: DiscordSettings, carClass: string): string | null {
    const channels = cfg.channels as Record<string, string | undefined>;
    const value = Object.hasOwn(channels, carClass) ? channels[carClass] : undefined;
    return value === undefined ? null : value;
  }

  private async matchTag(
    cfg: DiscordSettings,
    channelId: string,
    trackTagName: string,
  ): Promise<string | null> {
    if (!trackTagName || trackTagName.trim() === '') return null;
    try {
      const gateway = await this.gateway();
      const forum = await gateway.fetchForum(cfg.guildId ?? '', channelId);
      const clean = trackTagName.toLowerCase().trim();
      const potential: string[] = [clean];
      for (const [key, aliases] of TRACK_TAG_ALIASES) {
        if (clean.includes(key)) potential.push(...aliases);
      }
      for (const tag of forum.availableTags) {
        const name = (tag.name ?? '').toLowerCase().trim();
        for (const candidate of potential) {
          if (name.includes(candidate) || candidate.includes(name)) return tag.id;
        }
      }
    } catch (error) {
      this.logger?.warn(`Failed to match Discord tag: ${this.describe(error)}`);
    }
    return null;
  }

  private async fetchThread(
    gateway: DiscordGateway,
    cfg: DiscordSettings,
    threadId: string,
    threadName: string,
  ): Promise<DiscordSharedLap | null> {
    try {
      const message = await gateway.fetchStarterMessage(cfg.guildId ?? '', threadId);
      if (message === null) return null;
      const content = message.content;
      const cleaned = cleanContent(content);

      let authorId: string | null = null;
      let authorName = 'Unknown';
      let authorDisplay = 'Unknown';
      let avatarUrl: string | null = null;

      const mention = USER_MENTION.exec(content);
      if (mention !== null) {
        const mentionId = mention[1] as string;
        const member = await this.getGuildMember(mentionId);
        if (member !== null) {
          authorId = member.id === '' ? mentionId : member.id;
          authorName = member.username;
          authorDisplay = member.display_name;
          // Java recomputed the avatar with `authorId` (user id, else the mention id).
          avatarUrl = avatarUrlFor(authorId, member.avatar_hash === '' ? null : member.avatar_hash);
        }
      }
      if (authorId === null) {
        authorId = message.author.id ?? '';
        authorName = orUnknown(message.author.username);
        authorDisplay =
          message.author.globalName !== null && message.author.globalName !== ''
            ? message.author.globalName
            : authorName;
        avatarUrl = avatarUrlFor(authorId, message.author.avatarHash);
      }

      const telemetry = pickAttachment(message, '.duckdb');
      if (telemetry === null) return null;

      return {
        thread_id: threadId,
        title: threadName,
        author: {
          id: authorId,
          username: authorName,
          display_name: authorDisplay,
          avatar_url: avatarUrl,
        },
        content: cleaned,
        telemetry,
        setup: pickAttachment(message, '.svm'),
        created_at: toIsoTimestamp(message.createdTimestamp),
      };
    } catch (error) {
      this.logger?.warn(`Failed to fetch Discord thread ${threadId}: ${this.describe(error)}`);
      return null;
    }
  }

  /** Lazy, single-flight gateway: nothing connects until the first real Discord call. */
  private async gateway(): Promise<DiscordGateway> {
    const cfg = this.config.load();
    if (cfg.botToken === null || cfg.botToken.trim() === '') {
      throw new Error(TOKEN_MISSING_MESSAGE);
    }
    if (this.gatewayPromise !== null && this.gatewayToken === cfg.botToken) {
      return this.gatewayPromise;
    }

    const stale = this.gatewayPromise;
    const staleToken = this.gatewayToken;
    const pending = this.createGateway(cfg.botToken);
    this.gatewayPromise = pending;
    this.gatewayToken = cfg.botToken;

    if (stale !== null && staleToken !== cfg.botToken) {
      void stale
        .then((gateway) => gateway.close())
        .catch((error: unknown) => this.logger?.warn(`Failed to close stale Discord gateway: ${this.describe(error)}`));
    }
    return pending;
  }

  private async createGateway(token: string): Promise<DiscordGateway> {
    try {
      return await this.gatewayFactory(token);
    } catch (error) {
      // A failed handshake must not be cached: the next call retries.
      if (this.gatewayToken === token) {
        this.gatewayPromise = null;
        this.gatewayToken = null;
      }
      throw this.asError(error);
    }
  }

  /** Error text that can never carry the bot token. */
  private describe(error: unknown): string {
    const raw = error instanceof Error ? (error.message ?? '') : String(error ?? '');
    return this.scrub(raw);
  }

  private asError(error: unknown): Error {
    if (error instanceof ApiException) return error;
    const message = this.describe(error);
    const wrapped = new Error(message === '' ? 'Discord operation failed' : message);
    wrapped.cause = error;
    return wrapped;
  }

  private scrub(text: string): string {
    const token = this.gatewayToken ?? this.config.load().botToken;
    let result = text.replace(AUTH_HEADER_LEAK, 'Bot [redacted]');
    if (token !== null && token !== '' && token !== TEMPLATE_TOKEN_HINT) {
      result = result.split(token).join('[redacted]');
    }
    return result;
  }
}

const TEMPLATE_TOKEN_HINT = 'YOUR_DISCORD_BOT_TOKEN_HERE';

// ---------------------------------------------------------------------------
// Pure helpers — Java semantics kept in one place so the tests can pin them.
// ---------------------------------------------------------------------------

function toUploadFile(file: string): DiscordUploadFile {
  const filename = path.basename(file);
  return { path: file, filename, description: `Uploaded file: ${filename}` };
}

/** `content.contains("---") ? content.split("---", 2)[1].trim() : content` (limit keeps the tail). */
function cleanContent(content: string): string {
  const index = content.indexOf('---');
  return index < 0 ? content : content.slice(index + 3).trim();
}

function orUnknown(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? 'Unknown' : value;
}

function pickAttachment(
  message: GatewayMessageSnapshot,
  extension: string,
): DiscordAttachmentInfo | null {
  for (const attachment of message.attachments) {
    const filename = (attachment.filename ?? '').toLowerCase();
    if (filename.endsWith(extension)) {
      return {
        filename: attachment.filename,
        url: attachment.url,
        size: typeof attachment.size === 'number' ? attachment.size : 0,
      };
    }
  }
  return null;
}

/** Java's `avatarUrl(...)`: explicit hash wins, otherwise the snowflake-derived default. */
function avatarUrlFor(userId: string, avatarHash: string | null): string | null {
  if (avatarHash !== null && avatarHash.trim() !== '') {
    return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png`;
  }
  try {
    const index = Number((BigInt(userId) >> 22n) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
  } catch {
    return null;
  }
}

function toMemberInfo(member: GatewayMemberSnapshot): DiscordMemberInfo {
  const username = orUnknown(member.user.username);
  const globalName = member.user.globalName ?? '';
  const nick = member.nick ?? '';
  const displayName = nick !== '' ? nick : globalName !== '' ? globalName : username;
  return {
    id: member.user.id,
    username,
    display_name: displayName,
    avatar_url: avatarUrlFor(member.user.id, member.user.avatarHash),
    avatar_hash: member.user.avatarHash ?? '',
  };
}

function toMatch(member: GatewayMemberSnapshot): DiscordMemberMatch {
  return { user_id: member.user.id, username: member.user.username };
}

/** `matchesMember(...)`: exact pass then substring pass over username / global_name / nick. */
function matchesMember(member: GatewayMemberSnapshot, query: string, exact: boolean): boolean {
  const username = (member.user.username ?? '').toLowerCase();
  const globalName = (member.user.globalName ?? '').toLowerCase();
  const nick = (member.nick ?? '').toLowerCase();
  if (exact) {
    return username === query || globalName === query || nick === query;
  }
  return (username !== '' && username.includes(query))
    || (globalName !== '' && globalName.includes(query))
    || (nick !== '' && nick.includes(query));
}

/** Java sorts thread ids as strings; snowflakes are ASCII digits so `<`/`>` match `compareTo`. */
function compareDesc(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? 1 : -1;
}

function expired(entry: CacheEntry<unknown>, ttl: number, now: number): boolean {
  return now - entry.storedAt > ttl;
}

/**
 * `message.timestamp` in Java is Discord's ISO string. discord.js exposes the same instant in
 * milliseconds, so it is rendered back into the Discord shape (`+00:00` offset, no `Z`).
 */
function toIsoTimestamp(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return '';
  const iso = new Date(milliseconds).toISOString();
  return `${iso.slice(0, -1)}+00:00`;
}

async function moveIntoPlace(source: string, target: string): Promise<void> {
  try {
    await fs.promises.rename(source, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'ENOTEMPTY' || code === 'EEXIST') {
      await fs.promises.rm(target, { force: true });
      await fs.promises.rename(source, target);
      return;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Default gateway: the only place discord.js is imported.
// Loaded lazily so `import { DiscordClient }` never touches discord.js at module load,
// and no connection is opened until the first share/list/download call.
// ---------------------------------------------------------------------------

export interface DiscordJsGatewayOptions {
  /** Reuse an existing client instead of constructing one (tests). */
  readonly client?: DiscordJsClient;
  /** Open the gateway websocket (default) or only arm the REST token (tests). */
  readonly connect?: boolean;
}

export async function createDiscordJsGateway(
  token: string,
  options: DiscordJsGatewayOptions = {},
): Promise<DiscordGateway> {
  const { Client, GatewayIntentBits, AttachmentBuilder } = await import('discord.js');
  const client: DiscordJsClient = options.client
    ?? new Client({
      intents: [GatewayIntentBits.Guilds],
      rest: { timeout: 30_000, offset: 0 },
    });

  if (options.connect === false) {
    client.rest.setToken(token);
  } else {
    await client.login(token);
  }

  const forumOf = async (guildId: string, channelId: string) => {
    const guild = guildId === '' ? null : await client.guilds.fetch(guildId);
    const channel = guild
      ? await guild.channels.fetch(channelId)
      : await client.channels.fetch(channelId, { allowUnknownGuild: true });
    if (channel === null) throw new Error(`Discord channel ${channelId} not found`);
    return channel;
  };

  return {
    async searchGuildMembers(guildId, query, limit) {
      const guild = await client.guilds.fetch(guildId);
      const members = await post('guild.members.search', () =>
        guild.members.search({ query, limit, cache: false }),
      );
      return [...members.values()].map(toMemberSnapshot);
    },

    async fetchGuildMember(guildId, userId) {
      const guild = await client.guilds.fetch(guildId);
      try {
        const member = await get('guild.members.fetch', () => guild.members.fetch(userId));
        return toMemberSnapshot(member);
      } catch (error) {
        // Discord 100073 (Unknown Member) — Java's getGuildMember returned null for it.
        if (isUnknownMember(error)) return null;
        throw error;
      }
    },

    async fetchForum(guildId, channelId) {
      const channel = await get('channels.fetch', () => forumOf(guildId, channelId));
      const tags = channel && 'isThreadOnly' in channel && channel.isThreadOnly()
        ? channel.availableTags
        : [];
      return {
        id: channel.id,
        availableTags: (tags ?? []).map((tag) => ({ id: tag.id, name: tag.name })),
      };
    },

    async createForumPost(request) {
      const channel = await forumOf(request.guildId, request.channelId);
      if (channel === null || !('isThreadOnly' in channel) || !channel.isThreadOnly()) {
        throw new Error(`Discord channel ${request.channelId} is not a forum channel`);
      }
      const files: InstanceType<typeof AttachmentBuilder>[] = [];
      for (const file of request.files) {
        const bytes = await fs.promises.readFile(file.path);
        files.push(
          new AttachmentBuilder(bytes, { name: file.filename, description: file.description }),
        );
      }
      const thread = await post('threads.create', () =>
        channel.threads.create({
          name: request.name,
          message: { content: request.content, files },
          appliedTags: request.appliedTags.length > 0 ? [...request.appliedTags] : undefined,
        }),
      );
      return thread.id;
    },

    async fetchActiveThreads(guildId, channelId) {
      const channel = await forumOf(guildId, channelId);
      if (channel === null || !('isThreadOnly' in channel) || !channel.isThreadOnly()) return [];
      const result = await get('threads.fetchActive', () => channel.threads.fetchActive());
      return [...result.threads.values()].map(toThreadSnapshot);
    },

    async fetchArchivedThreads(guildId, channelId) {
      const channel = await forumOf(guildId, channelId);
      if (channel === null || !('isThreadOnly' in channel) || !channel.isThreadOnly()) return [];
      const result = await get('threads.fetchArchived', () =>
        channel.threads.fetchArchived({ type: 'public' }),
      );
      return [...result.threads.values()].map(toThreadSnapshot);
    },

    async fetchStarterMessage(guildId, threadId) {
      const channel = guildId === ''
        ? await client.channels.fetch(threadId, { allowUnknownGuild: true })
        : await forumOf(guildId, threadId);
      if (channel === null || !channel.isTextBased()) {
        throw new Error(`Discord thread ${threadId} has no messages`);
      }
      const message = await get('messages.fetch', () => channel.messages.fetch(threadId));
      return {
        content: message.content,
        createdTimestamp: message.createdTimestamp,
        author: toUserSummary(message.author),
        attachments: [...message.attachments.values()].map((attachment) => ({
          filename: attachment.name,
          url: attachment.url,
          size: typeof attachment.size === 'number' ? attachment.size : null,
        })),
      };
    },

    async close() {
      if (client.isReady()) await client.destroy();
    },
  };

  async function get<T>(operation: string, action: () => Promise<T>): Promise<T> {
    return relay(operation, action, 'get');
  }

  async function post<T>(operation: string, action: () => Promise<T>): Promise<T> {
    return relay(operation, action, 'post');
  }

  async function relay<T>(operation: string, action: () => Promise<T>, style: 'get' | 'post'): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw javaStyled(error, style, token);
    }
  }
}

function toThreadSnapshot(thread: {
  id: string;
  name: string;
  locked: boolean | null;
}): GatewayThreadSnapshot {
  return { id: thread.id, name: thread.name ?? '', locked: Boolean(thread.locked) };
}

function toMemberSnapshot(member: {
  user: { id: string; username: string; globalName: string | null; avatar: string | null };
  nickname: string | null;
}): GatewayMemberSnapshot {
  return {
    user: toUserSummary(member.user),
    nick: member.nickname ?? null,
  };
}

function toUserSummary(user: {
  id: string;
  username: string;
  globalName?: string | null;
  avatar?: string | null;
}): GatewayUserSummary {
  return {
    id: user.id,
    username: user.username,
    globalName: user.globalName ?? null,
    avatarHash: user.avatar ?? null,
  };
}

interface DiscordApiErrorLike {
  status?: number;
  rawError?: unknown;
  code?: number;
}

function isDiscordApiError(error: unknown): error is DiscordApiErrorLike {
  return (
    typeof error === 'object'
    && error !== null
    && 'rawError' in error
    && 'status' in error
  );
}

function isUnknownMember(error: unknown): boolean {
  return isDiscordApiError(error) && error.code === 100_073;
}

/** Keeps Java's wire text: `Discord API <status>: <body>` for reads, `Discord API error: <status> - <body>` for the post. */
function javaStyled(error: unknown, style: 'get' | 'post', token: string): Error {
  if (isDiscordApiError(error)) {
    const body = safeStringify(error.rawError);
    const message = style === 'get'
      ? `Discord API ${error.status ?? 0}: ${body}`
      : `Discord API error: ${error.status ?? 0} - ${body}`;
    return new Error(redact(message, token));
  }
  if (error instanceof Error) {
    // Java surfaced `e.getMessage()` verbatim; only discord.js-specific classes add context.
    const message = error.name === 'Error' ? error.message : `${error.name}: ${error.message}`;
    return new Error(redact(message, token), { cause: error });
  }
  return new Error(redact(String(error), token));
}

function safeStringify(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function redact(text: string, token: string): string {
  let result = text.replace(AUTH_HEADER_LEAK, 'Bot [redacted]');
  if (token !== '') result = result.split(token).join('[redacted]');
  return result;
}
