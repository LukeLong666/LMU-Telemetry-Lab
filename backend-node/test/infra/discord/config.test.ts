import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_INVITE_URL,
  DISCORD_CONFIG_FILE_NAME,
  DISCORD_CONFIG_TEMPLATE_FILE_NAME,
  DiscordConfig,
  TEMPLATE_BOT_TOKEN_PLACEHOLDER,
  type DiscordLogSink,
} from '../../../src/infra/discord/config.js';

const FAKE_TOKEN = 'mtI3NzQyNTYyODI0MzYwNjI3MQ.GaBcDe.fGenoIjKlMnOpQrStUvWxYz1234567890abcde';

interface RecordingSink extends DiscordLogSink {
  readonly lines: string[];
}

function recordingSink(): RecordingSink {
  const lines: string[] = [];
  const push = (level: string, message: string, meta?: Record<string, unknown>): void => {
    lines.push(`${level} ${message} ${JSON.stringify(meta ?? {})}`);
  };
  return {
    lines,
    info: (message, meta) => push('info', message, meta),
    warn: (message, meta) => push('warn', message, meta),
    error: (message, meta) => push('error', message, meta),
  };
}

let root = '';
let appHome = '';
let dataRoot = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmu-discord-config-'));
  appHome = path.join(root, 'app');
  dataRoot = path.join(root, 'data');
  fs.mkdirSync(appHome, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeConfig(where: string, contents: string): string {
  const target = path.join(where, DISCORD_CONFIG_FILE_NAME);
  fs.writeFileSync(target, contents, 'utf8');
  return target;
}

function configFor(env: Record<string, string | undefined> = {}, logger?: DiscordLogSink): DiscordConfig {
  return new DiscordConfig({ appHome, dataRoot }, { env, logger });
}

describe('DiscordConfig.load', () => {
  it('reads the field names the Java backend uses', () => {
    writeConfig(
      appHome,
      JSON.stringify({
        bot_token: FAKE_TOKEN,
        guild_id: '1496410659557081098',
        invite_url: 'https://discord.gg/zNPehXA3jK',
        channels: {
          'lmgt3-telemetry-sharing': '1505950451114311730',
          'hypercar-telemetry-sharing': '1508834645050134691',
        },
      }),
    );

    const settings = configFor().load();
    expect(settings).toEqual({
      botToken: FAKE_TOKEN,
      guildId: '1496410659557081098',
      inviteUrl: 'https://discord.gg/zNPehXA3jK',
      channels: {
        'lmgt3-telemetry-sharing': '1505950451114311730',
        'hypercar-telemetry-sharing': '1508834645050134691',
      },
    });
    expect(configFor().isConfigured()).toBe(true);
    expect(configFor().channelId('lmgt3-telemetry-sharing')).toBe('1505950451114311730');
    expect(configFor().guildId()).toBe('1496410659557081098');
    expect(configFor().inviteUrl()).toBe('https://discord.gg/zNPehXA3jK');
  });

  it('prefers appHome over dataRoot and falls back to dataRoot', () => {
    writeConfig(appHome, JSON.stringify({ bot_token: 'from-app-home', guild_id: '1' }));
    writeConfig(dataRoot, JSON.stringify({ bot_token: 'from-data-root', guild_id: '2' }));
    expect(configFor().load().botToken).toBe('from-app-home');

    fs.rmSync(path.join(appHome, DISCORD_CONFIG_FILE_NAME));
    expect(configFor().load().botToken).toBe('from-data-root');
    expect(configFor().guildId()).toBe('2');
  });

  it('lets DISCORD_BOT_TOKEN override the file', () => {
    writeConfig(appHome, JSON.stringify({ bot_token: FAKE_TOKEN, guild_id: '1496410659557081098' }));
    const settings = configFor({ DISCORD_BOT_TOKEN: 'env-token' }).load();
    expect(settings.botToken).toBe('env-token');
    expect(settings.guildId).toBe('1496410659557081098');
  });

  it('keeps Java defaults only for the "no file at all" case', () => {
    const settings = configFor().load();
    expect(settings).toEqual({
      botToken: null,
      guildId: null,
      inviteUrl: DEFAULT_INVITE_URL,
      channels: {},
    });
    expect(configFor().isConfigured()).toBe(false);
    expect(configFor().channelId('whatever')).toBeNull();
  });

  it('returns null for blank or absent fields instead of the default invite', () => {
    writeConfig(
      appHome,
      JSON.stringify({ bot_token: '   ', guild_id: '', channels: { 'gte-telemetry-sharing': '1508840424951910571' } }),
    );
    const settings = configFor().load();
    expect(settings.botToken).toBeNull();
    expect(settings.guildId).toBeNull();
    expect(settings.inviteUrl).toBeNull();
    expect(settings.channels).toEqual({ 'gte-telemetry-sharing': '1508840424951910571' });
    expect(configFor().isConfigured()).toBe(false);
  });

  it('skips a corrupt file and logs the path without the credential', () => {
    const sink = recordingSink();
    writeConfig(appHome, `{ "bot_token": "${FAKE_TOKEN}", broken`);
    const settings = configFor({ DISCORD_BOT_TOKEN: 'env-token' }, sink).load();
    // Java applies the env override inside the per-file try, so an unparsable file yields the plain defaults.
    expect(settings.botToken).toBeNull();
    expect(settings.guildId).toBeNull();
    expect(settings.inviteUrl).toBe(DEFAULT_INVITE_URL);
    expect(settings.channels).toEqual({});
    expect(sink.lines.join('\n')).toContain(DISCORD_CONFIG_FILE_NAME);
    expect(sink.lines.join('\n')).not.toContain(FAKE_TOKEN);
  });

  it('moves on to the dataRoot candidate when appHome is unparsable', () => {
    const sink = recordingSink();
    writeConfig(appHome, 'not json at all');
    writeConfig(dataRoot, JSON.stringify({ bot_token: 'from-data-root', guild_id: '42' }));
    const settings = configFor({}, sink).load();
    expect(settings.botToken).toBe('from-data-root');
    expect(settings.guildId).toBe('42');
  });

  it('ignores prototype keys when looking a car class up', () => {
    writeConfig(appHome, JSON.stringify({ bot_token: FAKE_TOKEN }));
    expect(configFor().channelId('constructor')).toBeNull();
    expect(configFor().channelId('toString')).toBeNull();
  });
});

describe('DiscordConfig.save', () => {
  it('writes the frozen field names and reloads identically', async () => {
    const config = configFor();
    await config.save({
      botToken: FAKE_TOKEN,
      guildId: '1496410659557081098',
      inviteUrl: 'https://discord.gg/zNPehXA3jK',
      channels: { 'lmp3-telemetry-sharing': '1508840358144901214' },
    });

    const raw = JSON.parse(fs.readFileSync(path.join(appHome, DISCORD_CONFIG_FILE_NAME), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(['bot_token', 'guild_id', 'invite_url', 'channels']);
    expect(raw.bot_token).toBe(FAKE_TOKEN);
    expect(config.load()).toEqual({
      botToken: FAKE_TOKEN,
      guildId: '1496410659557081098',
      inviteUrl: 'https://discord.gg/zNPehXA3jK',
      channels: { 'lmp3-telemetry-sharing': '1508840358144901214' },
    });
  });

  it('leaves no temp file behind and replaces an existing config', async () => {
    const config = configFor();
    await config.save({ botToken: 'first', guildId: '1', inviteUrl: null, channels: {} });
    await config.save({ botToken: 'second' });
    expect(fs.readdirSync(appHome).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const merged = config.load();
    expect(merged.botToken).toBe('second');
    expect(merged.guildId).toBe('1');
  });

  it('treats a blank written value as absent', async () => {
    const config = configFor();
    await config.save({ botToken: FAKE_TOKEN, guildId: '1', inviteUrl: 'https://discord.gg/a', channels: {} });
    await config.save({ guildId: '' });
    expect(config.load().guildId).toBeNull();
    expect(config.load().inviteUrl).toBe('https://discord.gg/a');
  });
});

describe('DiscordConfig template seeding', () => {
  it('copies discord_config.template.json into discord_config.json when nothing is configured', async () => {
    const template = path.join(appHome, DISCORD_CONFIG_TEMPLATE_FILE_NAME);
    fs.writeFileSync(
      template,
      JSON.stringify(
        {
          bot_token: TEMPLATE_BOT_TOKEN_PLACEHOLDER,
          guild_id: '1496410659557081098',
          invite_url: 'https://discord.gg/zNPehXA3jK',
          channels: { 'gte-telemetry-sharing': '1508840424951910571' },
        },
        null,
        2,
      ),
      'utf8',
    );

    const config = configFor();
    const created = await config.ensureConfigFromTemplate();
    expect(created).toBe(path.join(appHome, DISCORD_CONFIG_FILE_NAME));
    expect(fs.readFileSync(created as string, 'utf8')).toContain(TEMPLATE_BOT_TOKEN_PLACEHOLDER);
    expect(config.load().guildId).toBe('1496410659557081098');
    expect(await config.ensureConfigFromTemplate()).toBeNull();
  });

  it('does nothing when a config already exists in either candidate', async () => {
    writeConfig(dataRoot, JSON.stringify({ bot_token: 'existing' }));
    const config = configFor();
    fs.writeFileSync(path.join(appHome, DISCORD_CONFIG_TEMPLATE_FILE_NAME), '{}', 'utf8');
    expect(await config.ensureConfigFromTemplate()).toBeNull();
    expect(fs.existsSync(path.join(appHome, DISCORD_CONFIG_FILE_NAME))).toBe(false);
  });

  it('returns null when no template is shipped', async () => {
    expect(await configFor().ensureConfigFromTemplate()).toBeNull();
  });

  it('exposes the same candidate order the Java loader uses', () => {
    const config = configFor();
    expect(config.candidateFiles()).toEqual([
      path.resolve(appHome, DISCORD_CONFIG_FILE_NAME),
      path.resolve(dataRoot, DISCORD_CONFIG_FILE_NAME),
    ]);
    expect(config.templateFile()).toBe(path.resolve(appHome, DISCORD_CONFIG_TEMPLATE_FILE_NAME));
  });
});
