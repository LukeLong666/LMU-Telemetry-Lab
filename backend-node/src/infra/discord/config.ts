import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Discord configuration — port of `infra/discord/DiscordConfig.java`.
 *
 * Parity notes that must not drift:
 *  - lookup order is `<appHome>/discord_config.json` then `<dataRoot>/discord_config.json`;
 *  - the on-disk JSON field names are frozen (`bot_token`, `guild_id`, `invite_url`, `channels`);
 *  - `DISCORD_BOT_TOKEN` overrides the file token;
 *  - a missing/blank string field becomes `null`, NOT the default value. The default invite URL is
 *    only used when no config file could be read at all (same as Java);
 *  - the bot token is never logged.
 */

export const DISCORD_CONFIG_FILE_NAME = 'discord_config.json';
export const DISCORD_CONFIG_TEMPLATE_FILE_NAME = 'discord_config.template.json';
export const DEFAULT_INVITE_URL = 'https://discord.gg/your-invite-code';
export const DISCORD_BOT_TOKEN_ENV = 'DISCORD_BOT_TOKEN';
/** Placeholder shipped in `discord_config.template.json` (mirrors backend/discord_config.template.json). */
export const TEMPLATE_BOT_TOKEN_PLACEHOLDER = 'YOUR_DISCORD_BOT_TOKEN_HERE';

/** The slice of `AppPaths` this module needs, kept structural so tests can pass a plain object. */
export interface DiscordConfigPaths {
  readonly appHome: string;
  readonly dataRoot: string;
}

/** Minimal sink so this layer never depends on a logging framework (pino is wired in `context.ts`). */
export interface DiscordLogSink {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Exactly the JSON that lives in `discord_config.json`. */
export interface DiscordConfigFileShape {
  bot_token?: string | number | null;
  guild_id?: string | number | null;
  invite_url?: string | number | null;
  channels?: Record<string, string | number | boolean | null> | null;
}

/** The loaded, in-memory view Java exposed as `DiscordConfig.Config`. */
export interface DiscordSettings {
  readonly botToken: string | null;
  readonly guildId: string | null;
  readonly inviteUrl: string | null;
  readonly channels: Readonly<Record<string, string>>;
}

export interface DiscordConfigOptions {
  /** Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly logger?: DiscordLogSink;
}

/** Discord bot tokens are three dot-separated base64url segments; scrub any such shape from logs. */
const TOKEN_SHAPED = /\b[A-Za-z0-9_\-.]{16,}\.[A-Za-z0-9_\-.]{4,}\.[A-Za-z0-9_\-.]{4,}\b/g;

function redactSecrets(text: string): string {
  return text.replace(TOKEN_SHAPED, '[redacted]');
}

function emptySettings(): DiscordSettings {
  return { botToken: null, guildId: null, inviteUrl: DEFAULT_INVITE_URL, channels: {} };
}

/** `JsonNode.asText("")` + `isBlank() ? null` from `DiscordConfig.text(...)`. */
function textValue(raw: string | number | boolean | null | undefined): string | null {
  const value = coerceText(raw);
  return value.trim() === '' ? null : value;
}

/** `JsonNode.asText("")`: absent/null become '', scalars become their textual form. */
function coerceText(raw: string | number | boolean | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return '';
}

/**
 * Windows refuses to rename onto an existing file; Java used `REPLACE_EXISTING`.
 * Kept local (instead of importing `infra/fs`) so the discord layer stays independently testable.
 */
async function replace(source: string, target: string): Promise<void> {
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

export class DiscordConfig {
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly logger: DiscordLogSink | undefined;

  constructor(
    private readonly paths: DiscordConfigPaths,
    options: DiscordConfigOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.logger = options.logger;
  }

  /** `<appHome>/discord_config.json` — the file `save()` writes to. */
  public configFile(): string {
    return path.resolve(this.paths.appHome, DISCORD_CONFIG_FILE_NAME);
  }

  /** Second candidate, mirrors the `dataRoot` fallback in Java. */
  public dataRootConfigFile(): string {
    return path.resolve(this.paths.dataRoot, DISCORD_CONFIG_FILE_NAME);
  }

  /** Read order used by `load()`. */
  public candidateFiles(): readonly string[] {
    return [this.configFile(), this.dataRootConfigFile()];
  }

  /** `<appHome>/discord_config.template.json`, the file documented to users beside `discord_config.json`. */
  public templateFile(): string {
    return path.resolve(this.paths.appHome, DISCORD_CONFIG_TEMPLATE_FILE_NAME);
  }

  /**
   * Never throws: an unreadable/corrupt candidate is logged and the next candidate is tried;
   * when nothing can be read the Java defaults are returned.
   */
  public load(): DiscordSettings {
    for (const candidate of this.candidateFiles()) {
      if (!isRegularFile(candidate)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as unknown;
        return this.toSettings(parsed);
      } catch (error) {
        // Only the path is logged, and the parse message is scrubbed: JSON.parse echoes input snippets.
        this.logger?.error(`Failed to load Discord config from ${candidate}`, {
          error: redactSecrets(String(error)),
        });
      }
    }
    return emptySettings();
  }

  private toSettings(root: unknown): DiscordSettings {
    const source = (root !== null && typeof root === 'object' ? root : {}) as DiscordConfigFileShape;
    const channels: Record<string, string> = {};
    const rawChannels = source.channels;
    if (rawChannels !== null && typeof rawChannels === 'object') {
      for (const [key, value] of Object.entries(rawChannels)) {
        channels[key] = coerceText(value);
      }
    }

    const envToken = this.env[DISCORD_BOT_TOKEN_ENV];
    let token = textValue(source.bot_token);
    if (envToken !== undefined && envToken.trim() !== '') {
      token = envToken;
    }

    return {
      botToken: token,
      guildId: textValue(source.guild_id),
      inviteUrl: textValue(source.invite_url),
      channels,
    };
  }

  public isConfigured(): boolean {
    const token = this.load().botToken;
    return token !== null && token.trim() !== '';
  }

  /** `null` when a config file exists but has no `invite_url` (Java returns null there too). */
  public inviteUrl(): string | null {
    return this.load().inviteUrl;
  }

  public guildId(): string | null {
    return this.load().guildId;
  }

  /** `Map.get(...)` semantics: absent key -> null. Own-property only, so `carClass = "constructor"` is safe. */
  public channelId(carClass: string): string | null {
    const channels = this.load().channels;
    return Object.hasOwn(channels, carClass) ? (channels[carClass] as string) : null;
  }

  /**
   * Writes `<appHome>/discord_config.json` atomically using the frozen field names.
   * Absent fields are written as the Java defaults so a partial update stays readable.
   */
  public async save(settings: Partial<DiscordSettings>): Promise<DiscordSettings> {
    const merged: DiscordSettings = { ...this.load(), ...normalise(settings) };
    const file: DiscordConfigFileShape = {
      bot_token: merged.botToken ?? '',
      guild_id: merged.guildId ?? '',
      invite_url: merged.inviteUrl ?? DEFAULT_INVITE_URL,
      channels: { ...merged.channels },
    };
    await this.writeAtomic(this.configFile(), `${JSON.stringify(file, null, 2)}\n`);
    return merged;
  }

  /**
   * Seeds `<appHome>/discord_config.json` from `discord_config.template.json` when the user has no
   * config yet (the layout `backend/discord_config.template.json` documents). Returns the created path
   * or `null` when nothing had to be done / no template is available.
   */
  public async ensureConfigFromTemplate(templateFile?: string): Promise<string | null> {
    if (this.candidateFiles().some((candidate) => isRegularFile(candidate))) return null;
    const template = templateFile ?? this.templateFile();
    if (!isRegularFile(template)) return null;
    await this.writeAtomic(this.configFile(), fs.readFileSync(template, 'utf8'));
    return this.configFile();
  }

  private async writeAtomic(target: string, content: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const temp = path.join(
      path.dirname(target),
      `${path.basename(target)}.${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      await fs.promises.writeFile(temp, content, 'utf8');
      await replace(temp, target);
    } finally {
      await fs.promises.rm(temp, { force: true });
    }
  }
}

type WritablePartial<T> = { -readonly [K in keyof T]?: T[K] };

function normalise(settings: Partial<DiscordSettings>): Partial<DiscordSettings> {
  const result: WritablePartial<DiscordSettings> = {};
  if (settings.botToken !== undefined) result.botToken = blankToNull(settings.botToken);
  if (settings.guildId !== undefined) result.guildId = blankToNull(settings.guildId);
  if (settings.inviteUrl !== undefined) result.inviteUrl = blankToNull(settings.inviteUrl);
  if (settings.channels !== undefined) result.channels = { ...settings.channels };
  return result;
}

function blankToNull(value: string | null): string | null {
  if (value === null) return null;
  return value.trim() === '' ? null : value;
}

function isRegularFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}
