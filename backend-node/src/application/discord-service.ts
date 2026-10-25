/**
 * Port of `backend-java/src/main/java/com/lmutl/application/DiscordService.java` (211 lines).
 *
 * Business orchestration on top of `infra/discord`: the transport details (gateway calls, tag
 * matching, member search, forum multipart upload, CDN allow-list, TTL caches) all live in
 * `DiscordClient` / `DiscordConfig`, which are already ported and tested. What lives here is the
 * four controller actions of `DiscordController.java`:
 *
 *   GET  /api/v1/discord/config              -> `config()`
 *   GET  /api/v1/discord/shares              -> `shares(carClass)`
 *   POST /api/v1/discord/shares/download     -> `download(request)`
 *   POST /api/v1/sessions/{id}/discord/share -> `share(profileId, sessionId, request)`
 *
 * JSON contract (the frontend parses Java/Python shapes, so key names, nesting and the
 * unconfigured/empty branches are pinned here and asserted in `discord-service.test.ts`):
 * - `config()`        `{is_configured: boolean, invite_url: string | null}` — the bot token is
 *   never part of it; `invite_url` stays present-and-null when a config file exists without it
 *   (Java puts the key into a `LinkedHashMap` and Jackson emits `null`).
 * - `shares()`        `{shares: DiscordSharedLap[]}` — `[]` when the bot is unconfigured or the
 *   car class has no channel; never an error (`DiscordClient.listSharedLaps` already swallows).
 * - `download()`      `{success: true, telemetry_path: string, setup_downloaded: boolean}`.
 *   `telemetry_path` is the destination file path, which Java echoes back verbatim
 *   (`DiscordService.java:200`); the export file path of the *share* flow never reaches a
 *   response at all — it is uploaded and deleted.
 * - `share()`         `DiscordShareResult`: `{success: true, thread_id}`; the failure variant is
 *   converted into a 500 `{detail}` instead of a 200 body, exactly like Java.
 *
 * Java -> TypeScript notes:
 * - The Java service injects nine concrete beans. The collaborators this service actually calls
 *   are declared as narrow ports below (the same trick `SetupService` uses for `SessionResolver`
 *   and `SessionRepository` for `DiscordSessionGateway`), so the unit tests can observe calls
 *   without DuckDB while the real classes satisfy them structurally at assembly time.
 * - `formatLapTime` is a second private copy, because Java's `DiscordService` has its own
 *   `private static` one (`DiscordService.java:205-210`) identical to `LapExportService`'s.
 * - Cache: **none in this layer**, deliberately. Java's shares cache (60 s) and member cache
 *   (15 min) are fields of `DiscordClient` (`DiscordClient.java:50-51, 169-195`), already ported
 *   to `infra/discord/client.ts`. Caching again here would double it.
 * - `discord__` is *not* a download naming rule: `DiscordService.download` writes the sanitized
 *   Discord attachment filename (`PathSafety.safeFileName`) into the profile `DuckDB_data`
 *   directory, and that is what makes the share show up in `/sessions`. The `discord__` prefix is
 *   a **session id** form (`discord__<threadId>`), recognised by `SessionRepository.resolve`
 *   (`session-repository.ts`, `DISCORD_PREFIX`), which caches the thread's telemetry as
 *   `<dataRoot>/cache/discord_temp/<threadId>.duckdb`. Nothing in this service adds or strips it,
 *   and session display names come from the real filename (`SessionService.scan`), so no layer
 *   "un-prefixes" anything either.
 * - SSRF: user-supplied URLs are handed to `DiscordClient.downloadFile` only — never fetched
 *   here. That method owns the CDN allow-list (`cdn.discordapp.com` / `media.discordapp.net`),
 *   the 5 minute timeout and the `.tmp` + atomic-move write, exactly like `DiscordClient.java:253`.
 * - Error mapping stays Java's, including the asymmetric one: `share()` re-throws `ApiException`
 *   untouched, while `download()` wraps *every* failure of the telemetry download (the client's
 *   own 400 `Unsupported download URL` included) into a 500
 *   `Failed to download telemetry file: <message>` (`DiscordService.java:178-183`).
 * - Temp-file cleanup runs in `finally`, so a failed upload or a member-verification rejection
 *   still removes the exported `.duckdb` and the generated `_setup.svm`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ApiException } from '../api/error.js';
import type { DiscordDownloadRequest, DiscordShareRequest } from '../api/dto.js';
import type { LapInfo, LapsResponse } from '../domain/types.js';
import type { CarSpec } from '../infra/car/car-catalog.js';
import type {
  DiscordMemberMatch,
  DiscordShareResult,
  DiscordSharedLap,
} from '../infra/discord/client.js';
import { PathSafety } from '../infra/fs/path-safety.js';
import { isBlank } from '../infra/track/track-names.js';
import type { Logger } from '../lib/log.js';
import type { ExportResult } from './lap-export-service.js';
import type { SessionResolver } from './setup-service.js';

// ---------------------------------------------------------------------------
// Response shapes (public HTTP contract)
// ---------------------------------------------------------------------------

/** `DiscordService.config()` - the two keys `/discord/config` returns. */
export interface DiscordConfigResponse {
  is_configured: boolean;
  invite_url: string | null;
}

/** `DiscordService.shares()` - `/discord/shares`. */
export interface DiscordSharesResponse {
  shares: DiscordSharedLap[];
}

/** `DiscordService.share()` - `/sessions/{id}/discord/share`; the error variant becomes a 500. */
export type DiscordShareResponse = DiscordShareResult;

/** `DiscordService.download()` - `/discord/shares/download`. */
export interface DiscordDownloadResponse {
  success: true;
  telemetry_path: string;
  setup_downloaded: boolean;
}

// ---------------------------------------------------------------------------
// Collaborator ports - subsets of the real classes, satisfied structurally
// ---------------------------------------------------------------------------

/** `DiscordConfig` (only the two reads the controller actions need). */
export interface DiscordConfigReader {
  isConfigured(): boolean;
  inviteUrl(): string | null;
}

/** `DiscordClient` (the four calls this service makes; `connect`/`close` belong to the app boot). */
export interface DiscordShareGateway {
  shareToForum(
    carClass: string | null,
    title: string,
    content: string,
    trackTagName: string | null,
    files: readonly string[],
  ): Promise<DiscordShareResult>;
  searchGuildMember(username: string | null): Promise<DiscordMemberMatch | null>;
  listSharedLaps(carClass: string): Promise<DiscordSharedLap[]>;
  downloadFile(url: string, destination: string): Promise<void>;
}

/** `LapService.header(database)` - Java calls the single-argument overload. */
export interface DiscordLapHeader {
  header(database: string): Promise<LapsResponse>;
}

/** `LapExportService.export(...)`. */
export interface DiscordLapExporter {
  export(
    profileId: string,
    sessionId: string,
    lapNumber: number,
    customCarModel: string | null | undefined,
  ): Promise<ExportResult>;
}

/** `SetupService.readMetadata(database)`. */
export interface DiscordMetadataReader {
  readMetadata(database: string): Promise<Map<string, string | null>>;
}

/** `SvmExporter.generate(database)`. */
export interface DiscordSvmGenerator {
  generate(database: string): Promise<string>;
}

/** `CarCatalog.getCarInfo(name, class)` - the two-argument overload of `DiscordService.java:102`. */
export interface DiscordCarCatalog {
  getCarInfo(carNameMeta: string | null, carClassMeta: string | null): CarSpec;
}

/** `AppPaths` - the two profile directories this service writes into. */
export interface DiscordProfilePaths {
  profileCacheDir(profileId: string): string;
  profileDataDir(profileId: string): string;
}

// ---------------------------------------------------------------------------
// Messages - character-for-character from DiscordService.java
// ---------------------------------------------------------------------------

/** `DiscordService.java:76`. */
const NOT_CONFIGURED = 'Discord Bot is not configured. Please check discord_config.json';
/** `DiscordService.java:83`. */
const HANDLE_REQUIRED = 'Discord username is required for server membership verification.';
/** `DiscordService.java:128`. */
const NOT_A_MEMBER
  = 'You are not a member of our Discord server yet! Please join our server to share telemetry.';
/** `DiscordService.java:170`. */
const DOWNLOAD_REQUIRES_BOTH = 'Telemetry URL and filename are required';
/** `DiscordService.java:175`. */
const BAD_TELEMETRY_TYPE = 'Invalid telemetry file type. Must end in .duckdb';

export class DiscordService {
  constructor(
    private readonly discordConfig: DiscordConfigReader,
    private readonly gateway: DiscordShareGateway,
    private readonly sessions: SessionResolver,
    private readonly lapService: DiscordLapHeader,
    private readonly lapExporter: DiscordLapExporter,
    private readonly svmExporter: DiscordSvmGenerator,
    private readonly setupService: DiscordMetadataReader,
    private readonly carCatalog: DiscordCarCatalog,
    private readonly paths: DiscordProfilePaths,
    private readonly logger: Logger,
  ) {}

  /**
   * `DiscordService.java:60-65` - `GET /api/v1/discord/config`.
   * Synchronous in Java and here: `DiscordConfig.load()` reads the config file with a sync read.
   */
  config(): DiscordConfigResponse {
    return {
      is_configured: this.discordConfig.isConfigured(),
      invite_url: this.discordConfig.inviteUrl(),
    };
  }

  /** `DiscordService.java:67-71` - `GET /api/v1/discord/shares?car_class=`. */
  async shares(carClass: string): Promise<DiscordSharesResponse> {
    return { shares: await this.gateway.listSharedLaps(carClass) };
  }

  /**
   * `DiscordService.java:73-166` - `POST /api/v1/sessions/{sessionId}/discord/share`.
   *
   * `profileId` is the value `DiscordController.java:45` merged from the `profile_id` query
   * parameter and `request.profile_id`; blank/absent is the guest profile, as in Java:85.
   */
  async share(
    profileId: string | null | undefined,
    sessionId: string,
    request: DiscordShareRequest | null | undefined,
  ): Promise<DiscordShareResponse> {
    if (!this.discordConfig.isConfigured()) {
      throw new ApiException(400, NOT_CONFIGURED);
    }
    if (isMissing(request)) {
      throw new ApiException(400, 'Request body is required');
    }
    if (isBlankValue(request.discord_handle)) {
      throw new ApiException(400, HANDLE_REQUIRED);
    }
    const profile = blankToNull(profileId) ?? 'guest';

    const database = await this.sessions.resolve(profile, sessionId);
    const header = await this.lapService.header(database);
    const lap = findLap(header, request.lap_number);
    if (lap === undefined) {
      throw new ApiException(404, `Lap ${request.lap_number} not found`);
    }

    const metadata = await this.setupService.readMetadata(database);
    const trackName = getOrDefault(metadata, 'TrackName', 'Track');
    const layoutName = requireText(getOrDefault(metadata, 'TrackLayout', 'Layout'), 'TrackLayout')
      .replaceAll(' ', '-')
      .replaceAll(/[\\/*?:"<>|]/g, '');
    const rawCar = getOrDefault(metadata, 'CarName', '');
    const rawClass = getOrDefault(metadata, 'CarClass', '');
    const custom = blankToNull(request.custom_car_model);
    const friendlyCar = custom === null ? this.carCatalog.getCarInfo(rawCar, rawClass).modelName : custom;
    const carModel = friendlyCar.replaceAll(' ', '-');
    const recordingTime = getOrDefault(metadata, 'RecordingTime', PathSafety.stripDuckDb(sessionId));
    const lapTime = formatLapTime(lap.duration);

    const files: string[] = [];
    try {
      const exportResult = await this.lapExporter.export(
        profile,
        sessionId,
        request.lap_number,
        request.custom_car_model,
      );
      files.push(exportResult.path);

      if (request.attach_setup) {
        try {
          const svm = await this.svmExporter.generate(database);
          const setupFile = path.resolve(
            this.paths.profileCacheDir(profile),
            `${layoutName}_${carModel}_${recordingTime}_setup.svm`,
          );
          await fs.promises.writeFile(setupFile, svm);
          files.push(setupFile);
        } catch (error) {
          // Java:120-122 - the share goes on without the setup file; only the log line differs.
          this.logger.error({ err: error }, 'Setup generation failed for Discord share');
        }
      }

      const member = await this.gateway.searchGuildMember(request.discord_handle ?? null);
      if (member === null) {
        throw new ApiException(400, NOT_A_MEMBER);
      }
      const driverMention = `<@${member.user_id}>`;
      const trackDisplay = !isBlank(layoutName) && layoutName !== trackName
        ? `${trackName} (${layoutName})`
        : trackName;
      const headerBlock = `### Telemetry Shared by ${driverMention}\n\n`
        + `* **Track:** ${trackDisplay}\n`
        + `* **Car:** ${friendlyCar}\n`
        + `* **Lap Time:** ${lapTime}\n\n`
        + '---\n\n';
      const fullContent = headerBlock + (request.content ?? '');

      const result = await this.gateway.shareToForum(
        request.car_class ?? null,
        request.title,
        fullContent,
        trackName,
        files,
      );
      if (!result.success) {
        throw new ApiException(500, result.error || 'Discord share failed');
      }
      return result;
    } catch (error) {
      if (error instanceof ApiException) throw error;
      this.logger.error({ err: error }, 'Discord sharing failed');
      throw new ApiException(500, `Discord sharing failed: ${messageOf(error)}`, { cause: error });
    } finally {
      for (const file of files) {
        try {
          await fs.promises.rm(file, { force: true });
        } catch (error) {
          this.logger.warn({ err: error, file }, `Failed to clean up ${file}`);
        }
      }
    }
  }

  /**
   * `DiscordService.java:168-203` - `POST /api/v1/discord/shares/download`.
   *
   * The destination name is the Discord attachment filename, sanitized to a bare name
   * (`PathSafety.safeFileName`) and required to end in `.duckdb`; setup files are only fetched
   * when they end in `.svm`, and a setup failure is logged without failing the request.
   */
  async download(request: DiscordDownloadRequest | null | undefined): Promise<DiscordDownloadResponse> {
    const telemetryUrl = request?.telemetry_url;
    const telemetryNameArg = request?.telemetry_filename;
    if (isMissing(telemetryUrl) || isMissing(telemetryNameArg)) {
      throw new ApiException(400, DOWNLOAD_REQUIRES_BOTH);
    }
    const profile = blankToNull(request?.profile_id) ?? 'guest';
    const telemetryFilename = PathSafety.safeFileName(telemetryNameArg);
    if (!PathSafety.isDuckDb(telemetryFilename)) {
      throw new ApiException(400, BAD_TELEMETRY_TYPE);
    }
    const telemetryPath = path.resolve(this.paths.profileDataDir(profile), telemetryFilename);
    try {
      await this.gateway.downloadFile(telemetryUrl, telemetryPath);
    } catch (error) {
      // Java wraps every exception here - including the client's 400 "Unsupported download URL",
      // which therefore surfaces as a 500 with the Java text. Keeping that, per the parity rule.
      throw new ApiException(500, `Failed to download telemetry file: ${messageOf(error)}`, {
        cause: error,
      });
    }

    const setupUrl = request?.setup_url;
    const setupNameArg = request?.setup_filename;
    let setupDownloaded = false;
    if (!isMissing(setupUrl) && !isMissing(setupNameArg)) {
      const setupFilename = PathSafety.safeFileName(setupNameArg);
      if (setupFilename.toLowerCase().endsWith('.svm')) {
        const setupPath = path.resolve(this.paths.profileDataDir(profile), setupFilename);
        try {
          await this.gateway.downloadFile(setupUrl, setupPath);
          setupDownloaded = true;
        } catch (error) {
          this.logger.error({ err: error }, 'Failed to download setup file');
        }
      }
    }

    return {
      success: true,
      telemetry_path: telemetryPath,
      setup_downloaded: setupDownloaded,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Java's `header.laps().stream().filter(item -> item.lap() == request.lapNumber()).findFirst()`. */
function findLap(header: LapsResponse, lapNumber: number): LapInfo | undefined {
  return header.laps.find((item) => item.lap === lapNumber);
}

/** Java's `x == null`; a key the JSON body omitted is null there, so `undefined` counts too. */
function isMissing(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/** Java's null-safe `value == null || value.isBlank()`. */
function isBlankValue(value: string | null | undefined): boolean {
  return isMissing(value) || isBlank(value);
}

/** The same rule where a blank value means "use the caller's fallback" (`?? 'guest'`). */
function blankToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return isBlank(value) ? null : value;
}

/**
 * Java `Map.getOrDefault` over the `LinkedHashMap` the metadata reader produces: a key mapped to
 * SQL NULL *has* a mapping, so it yields null rather than the fallback (LapExportService.java
 * documents the same rule).
 */
function getOrDefault(
  metadata: Map<string, string | null>,
  key: string,
  fallback: string,
): string | null {
  return metadata.has(key) ? (metadata.get(key) ?? null) : fallback;
}

/** A NULL `TrackLayout` reaches `String.replace` in Java and throws NPE, i.e. HTTP 500. */
function requireText(value: string | null, key: string): string {
  if (value === null) {
    throw new TypeError(
      `Cannot invoke "String.replace(CharSequence, CharSequence)" on the null metadata value "${key}"`,
    );
  }
  return value;
}

/** `DiscordService.java:205-210` - `String.format(Locale.ROOT, "%dm%02ds%03d", ...)`. */
function formatLapTime(seconds: number): string {
  const minutes = javaInt(seconds / 60);
  const wholeSeconds = javaInt(seconds % 60);
  const millis = javaInt((seconds * 1000) % 1000);
  return `${minutes}m${padDigits(wholeSeconds, 2)}s${padDigits(millis, 3)}`;
}

/** `String.format("%0Nd", v)` - digits zero-padded, the sign counts towards the width. */
function padDigits(value: number, width: number): string {
  const text = String(value);
  if (text.length >= width) return text;
  const negative = text.startsWith('-');
  const padding = '0'.repeat(width - text.length);
  return negative ? `-${padding}${text.slice(1)}` : `${padding}${text}`;
}

/** Java's `(int)` narrowing of a double: truncate toward zero, NaN -> 0, saturate at the int range. */
function javaInt(value: number): number {
  if (Number.isNaN(value)) return 0;
  const truncated = Math.trunc(value);
  if (truncated > 2147483647) return 2147483647;
  if (truncated < -2147483648) return -2147483648;
  return truncated;
}

/** Java's `e.getMessage()`, null-safe the way `String.valueOf` is. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message ?? '';
  return String(error ?? '');
}
