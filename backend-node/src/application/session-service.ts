/**
 * Port of backend-java/src/main/java/com/lmutl/application/SessionService.java (178 lines).
 *
 * Service layer behind `/api/v1/sessions`: it turns every `.duckdb` file of a profile into
 * one `SessionInfo` row for the frontend workbench. Nothing here re-derives lap or track
 * facts — `LapService.header()` already does the track matching, the metadata assembly and
 * the lap parsing, so this service only adds the best-lap selection, the display fields and
 * the scan cache on top of it.
 *
 * Rules kept exactly as the Java version settled them (STATUS.md:112-113 records both):
 * - best-lap selection (SessionService.java:71-84), condition by condition:
 *   valid laps first, out-laps excluded (except in a single-lap session), `duration > 0`,
 *   then the minimum duration; when no valid lap qualifies the same scan repeats WITHOUT
 *   the validity requirement and `bestLapValid` comes back false. `bestValid` is decided
 *   before the fallback, so it is exactly "the winner came from the valid pass".
 * - the track display fields come from `TrackRegistry.tracks()` keyed on the metadata's
 *   `commonTrackName`; a session whose track did not match keeps only the raw name fields.
 * - the list order is whatever `SessionRepository.listFiles()` produced (mtime descending),
 *   because the scan is a plain sequential loop that appends in that order.
 * - one broken file never breaks the list: the read failure is logged and the row keeps only
 *   `id` / `name` / `created` / `size`, exactly like Java's catch-all (SessionService.java:111-115).
 * - the scan cache is in-process, keyed per file and invalidated by mtime + size
 *   (SessionService.java:34, 61-64, 109). A failed scan is NOT cached, so a file that is
 *   fixed later is re-read on the next `/sessions`.
 *
 * Java -> TypeScript notes:
 * - `ConcurrentHashMap<Path, CacheEntry>` becomes a `Map` keyed `profile\u0000path`. Java keys
 *   on the path alone; the profile dimension is added so this cache and `LapService`'s header
 *   cache carry the same identity (see `LapCacheIdentity`) and a `/sessions` scan plus a
 *   `/laps` request for one profile hit or drop together. `SessionInfo` depends only on the
 *   file, so this changes cache cost, never output.
 * - `scan(Path)` takes the file as a string plus the owning profile; the profile only feeds
 *   the cache key and the identity, and defaults to the same `"guest"` normalisation `list()`
 *   applies. It stays public because Java's is, though nothing outside calls it today.
 * - Java's sequential `for` loop over the files stays a sequential `for ... await`.
 * - `Files.getLastModifiedTime / Files.size` become one async `fs.stat` per file, with the
 *   same fallbacks (now-epoch-seconds / 0 / 0) when the file vanished in between.
 * - `@JsonInclude(NON_NULL)` on `SessionInfo` means every Java `null` field is simply absent
 *   from the JSON, so the TypeScript side writes `undefined` rather than `null`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LapInfo, SessionInfo, SessionMetadata, TrackDefinition } from '../domain/types.js';
import { isBlank } from '../infra/track/track-names.js';
import type { TrackRegistry } from '../infra/track/track-registry.js';
import { PathSafety } from '../infra/fs/path-safety.js';
import type { IncomingFile, SessionRepository, UploadedSession } from '../infra/fs/session-repository.js';
import type { Logger } from '../lib/log.js';
import type { LapService } from './lap-service.js';

/** SessionService.java:176 - `record CacheEntry(SessionInfo info, long size, long modified)`. */
interface CacheEntry {
  readonly info: SessionInfo;
  readonly size: number;
  readonly modified: number;
}

/** The three numbers every `SessionInfo` row starts with, read straight off the file. */
interface FileStamp {
  readonly created: number;
  readonly size: number;
  readonly modified: number;
}

/** The winner of the best-lap scan; `valid` is false only for the no-valid-lap fallback. */
interface BestLap {
  readonly lap: LapInfo | null;
  readonly valid: boolean;
}

export class SessionService {
  /** SessionService.java:34 - the `ConcurrentHashMap` of scanned files. */
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly repository: SessionRepository,
    private readonly lapService: LapService,
    private readonly trackRegistry: TrackRegistry,
    private readonly logger: Logger,
  ) {}

  /** SessionService.java:44-51 - one row per session file, in `listFiles()` order. */
  async list(profileId: string | null | undefined): Promise<SessionInfo[]> {
    const profile = normalizeProfile(profileId);
    const files = await this.repository.listFiles(profile);
    const result: SessionInfo[] = [];
    // Java: `for (Path file : files) { result.add(scan(file)); }` - sequential, no parallel
    // stream. Node keeps it sequential: opening a DuckDB file per session is heavy on handles
    // and memory, and the order and the per-file error containment are unchanged that way.
    for (const file of files) {
      result.push(await this.scan(file, profile));
    }
    return result;
  }

  /**
   * SessionService.java:53-116 - one row of `/sessions`, served from the cache while the
   * file's mtime and size are unchanged.
   */
  async scan(file: string, profileId: string | null | undefined = null): Promise<SessionInfo> {
    // Java: file.toAbsolutePath().normalize()
    const resolved = path.resolve(file);
    const profile = normalizeProfile(profileId);
    const cacheKey = `${profile}\u0000${resolved}`;
    const fileName = path.basename(resolved);
    const id = fileName;
    const name = PathSafety.stripDuckDb(fileName);
    const stamp = await fileStamp(resolved);

    const cached = this.cache.get(cacheKey);
    if (cached !== undefined && cached.size === stamp.size && cached.modified === stamp.modified) {
      return cached.info;
    }

    try {
      const response = await this.lapService.header(resolved, { profileId: profile, sessionId: id });
      const info = this.toSessionInfo(id, name, stamp, response.metadata, pickBestLap(response.laps));
      this.cache.set(cacheKey, { info, size: stamp.size, modified: stamp.modified });
      return info;
    } catch (error) {
      // SessionService.java:111-115: the session stays in the list with only its file facts,
      // and the failure is NOT cached, so the next request opens the file again.
      this.logger.warn(
        { err: error, file: fileName },
        `Failed to read session metadata for ${fileName}: ${messageOf(error)}`,
      );
      return { id, name, created: stamp.created, size: stamp.size };
    }
  }

  /** SessionService.java:118-122 - the uploaded file may shadow an old name, so all scans drop. */
  async upload(
    profileId: string | null | undefined,
    file: IncomingFile | null | undefined,
  ): Promise<UploadedSession> {
    const uploaded = await this.repository.upload(normalizeProfile(profileId), file);
    this.clearCaches();
    return uploaded;
  }

  /** SessionService.java:124-128 - the renamed file has a new id, so nothing stale may survive. */
  async rename(
    profileId: string | null | undefined,
    sessionId: string | null,
    newName: string | null,
  ): Promise<string> {
    const renamed = await this.repository.rename(normalizeProfile(profileId), sessionId, newName);
    this.clearCaches();
    return renamed;
  }

  /** SessionService.java:130-133 */
  async delete(profileId: string | null | undefined, sessionId: string | null): Promise<void> {
    await this.repository.delete(normalizeProfile(profileId), sessionId);
    this.clearCaches();
  }

  /**
   * SessionService.java:135-137 - the path every other service starts from. Satisfies
   * `SetupService`'s `SessionResolver` port structurally.
   */
  async resolve(profileId: string | null | undefined, sessionId: string | null): Promise<string> {
    return this.repository.resolve(normalizeProfile(profileId), sessionId);
  }

  /**
   * SessionService.java:139-142. Java clears BOTH in-memory caches here and nothing else: the
   * on-disk profile cache (`SessionRepository.clearCache`) is already dropped inside
   * `rename()` / `delete()` themselves, and `upload()` never touches it - in Java either.
   */
  private clearCaches(): void {
    this.cache.clear();
    this.lapService.clearCache();
  }

  /** SessionService.java:86-108 - the metadata -> SessionInfo projection, in Java's field order. */
  private toSessionInfo(
    id: string,
    name: string,
    stamp: FileStamp,
    metadata: SessionMetadata,
    best: BestLap,
  ): SessionInfo {
    const common = emptyToUndefined(metadata.commonTrackName);
    // Java reads the registry map by the matched key instead of re-matching, so a session whose
    // track never matched contributes none of the five registry-derived display fields.
    const track: TrackDefinition | undefined =
      common === undefined ? undefined : this.trackRegistry.tracks().get(common);
    const matched = track !== undefined;
    const officialLength = metadata.officialTrackLength;

    return {
      id,
      name,
      created: stamp.created,
      size: stamp.size,
      trackName: emptyToUndefined(metadata.trackName),
      trackLayout: emptyToUndefined(metadata.trackLayout),
      layoutKey: matched ? emptyToUndefined(metadata.layoutKey) : undefined,
      commonTrackName: matched ? common : undefined,
      displayName: matched ? emptyToUndefined(track?.display_name) : undefined,
      trackAliases: matched ? metadata.trackAliases ?? undefined : undefined,
      carModel: emptyToUndefined(metadata.modelName),
      carClass: emptyToUndefined(metadata.carClass),
      rawCarName: emptyToUndefined(metadata.rawCarName),
      country: emptyToUndefined(metadata.country),
      officialTrackLength:
        officialLength === null || officialLength === undefined || officialLength <= 0
          ? undefined
          : officialLength,
      driverName: emptyToUndefined(metadata.driverName),
      bestLapTime: best.lap === null ? undefined : best.lap.duration,
      bestLapValid: best.lap === null ? undefined : best.valid,
    };
  }
}

/** SessionService.java:144-146 - a blank or missing profile id is the guest profile. */
function normalizeProfile(profileId: string | null | undefined): string {
  return profileId === null || profileId === undefined || isBlank(profileId) ? 'guest' : profileId;
}

/**
 * SessionService.java:71-84, one condition at a time:
 * - `singleLap` (line 71): an exported one-lap session flags lap 0 as an out-lap and must
 *   still be able to win.
 * - tier 1 (lines 72-77): valid AND not an out-lap (unless single-lap) AND duration > 0.
 * - `bestValid` (line 78) is decided from tier 1 only, BEFORE the fallback.
 * - tier 2 (lines 79-84): the same scan without the validity requirement.
 * - nothing qualifies in either tier -> no best lap at all (both JSON keys omitted).
 * `Stream.min(comparingDouble(duration))` keeps the first minimum, which the strict `<` below
 * reproduces; a NaN duration fails `> 0` and is dropped, as in Java.
 */
function pickBestLap(laps: readonly LapInfo[]): BestLap {
  const singleLap = laps.length === 1;
  const qualifies = (lap: LapInfo, requireValid: boolean): boolean =>
    (!requireValid || lap.isValid) && (!lap.isOutLap || singleLap) && lap.duration > 0;
  const lowest = (requireValid: boolean): LapInfo | null => {
    let best: LapInfo | null = null;
    for (const lap of laps) {
      if (!qualifies(lap, requireValid)) {
        continue;
      }
      if (best === null || lap.duration < best.duration) {
        best = lap;
      }
    }
    return best;
  };

  const validBest = lowest(true);
  if (validBest !== null) {
    return { lap: validBest, valid: true };
  }
  return { lap: lowest(false), valid: false };
}

/** SessionService.java:148-170 - one stat, then the same three fallbacks Java applies per call. */
async function fileStamp(file: string): Promise<FileStamp> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    // lastModifiedSeconds() falls back to `Instant.now().getEpochSecond()`, the others to 0.
    return { created: Math.floor(Date.now() / 1000), size: 0, modified: 0 };
  }
  // Java's FileTime.toMillis() is integral, while mtimeMs can carry a sub-millisecond fraction.
  const modified = Math.trunc(stat.mtimeMs);
  return { created: modified / 1000, size: stat.size, modified };
}

/** SessionService.java:172-174 - Java's `isBlank` is null-safe, so this one is too. */
function emptyToUndefined(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || isBlank(value) ? undefined : value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
