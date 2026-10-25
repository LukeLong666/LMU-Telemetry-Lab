/**
 * Ports backend-java/src/main/java/com/lmutl/application/ReferenceLapService.java (101 lines).
 *
 * Scans every session of a profile through `LapService.header` (which is cached, so a full
 * scan re-opens each `.duckdb` at most once per mtime/size change) and flattens all their
 * laps into the `ReferenceLap` list `/api/v1/reference-laps` returns for the overlay view.
 *
 * Rules copied verbatim from Java:
 * - the `"guest"` profile default and the `trim()` on the three filter terms (line 33-36);
 * - track must match exactly, while an empty layout term also accepts "no layout" or a
 *   layout equal to the track name (line 46-52);
 * - a session that fails to read is skipped with a warning, never aborts the scan (83-85);
 * - `totalLaps` / `stintCount` (max stint, 0 when there are no laps) per session (57-58);
 * - the sort: date descending, then lap descending, stable for ties (88-90).
 *
 * Java -> TypeScript notes: `Files.getLastModifiedTime` becomes an async `fs.stat`; the
 * blocking `for (Path file : repository.listFiles(...))` loop becomes a sequential
 * `for ... await`, which keeps the same ordering and error handling.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LapInfo, ReferenceLap } from '../domain/types.js';
import type { LapService } from './lap-service.js';
import { PathSafety } from '../infra/fs/path-safety.js';
import type { SessionRepository } from '../infra/fs/session-repository.js';
import { isBlank, javaTrim } from '../infra/track/track-names.js';
import type { Logger } from '../lib/log.js';

export class ReferenceLapService {
  constructor(
    private readonly repository: SessionRepository,
    private readonly lapService: LapService,
    private readonly logger: Logger,
  ) {}

  /** ReferenceLapService.java:32-92. */
  async find(
    profileId: string | null,
    trackName: string | null,
    trackLayout: string | null,
    carClass: string | null,
  ): Promise<ReferenceLap[]> {
    const profile = profileId === null || isBlank(profileId) ? 'guest' : profileId;
    const wantedTrack = trackName === null ? '' : javaTrim(trackName);
    const wantedLayout = trackLayout === null ? '' : javaTrim(trackLayout);
    const wantedClass = carClass === null ? '' : javaTrim(carClass);

    const result: ReferenceLap[] = [];
    for (const file of await this.repository.listFiles(profile)) {
      try {
        const header = await this.lapService.header(file);
        const dbTrack = header.metadata.trackName === null ? '' : javaTrim(header.metadata.trackName);
        const dbLayout = header.metadata.trackLayout === null ? '' : javaTrim(header.metadata.trackLayout);
        const dbClass = header.metadata.carClass === null ? '' : javaTrim(header.metadata.carClass);

        const trackMatches = dbTrack === wantedTrack;
        const layoutMatches =
          dbLayout === wantedLayout ||
          (wantedLayout === '' && (dbLayout === '' || dbLayout === dbTrack));
        const classMatches = dbClass === wantedClass;
        if (!trackMatches || !layoutMatches || !classMatches) {
          continue;
        }

        const sessionId = path.basename(file);
        const sessionName = PathSafety.stripDuckDb(sessionId);
        const date = await lastModifiedSeconds(file);
        const totalLaps = header.laps.length;
        const stintCount = maxStint(header.laps);

        for (const lap of header.laps) {
          // SessionMetadata types these four as `string | null` (Jackson nullability), but
          // LapService always fills them from a metadata fallback or the car catalog, so the
          // `?? ''` below is unreachable and only satisfies `ReferenceLap`'s non-null fields.
          result.push({
            sessionId,
            sessionName,
            date,
            lap: lap.lap,
            stint: lap.stint,
            startTime: lap.startTime,
            endTime: lap.endTime,
            duration: lap.duration,
            isValid: lap.isValid,
            s1: lap.s1,
            s2: lap.s2,
            s3: lap.s3,
            driver: header.metadata.driverName ?? '',
            sessionTime: header.metadata.sessionTime ?? '',
            carModel: header.metadata.modelName ?? '',
            rawCarName: header.metadata.rawCarName ?? '',
            totalLaps,
            stintCount,
            fuelUsed: lap.fuelUsed,
          });
        }
      } catch (error) {
        this.logger.warn(
          `Failed to scan reference laps in ${path.basename(file)}: ${messageOf(error)}`,
        );
      }
    }

    // Comparator.comparingDouble(date).thenComparingInt(lap).reversed() - the reversal
    // negates the comparison, it does not re-order ties: both sorts are stable.
    result.sort((left, right) => compareReferenceLaps(right, left));
    return result;
  }
}

/** ReferenceLapService.java:58 - `mapToInt(LapInfo::stint).max().orElse(0)`. */
function maxStint(laps: LapInfo[]): number {
  let max = 0;
  for (const lap of laps) {
    if (lap.stint > max) {
      max = lap.stint;
    }
  }
  return max;
}

/** `Comparator.comparingDouble(ReferenceLap::date).thenComparingInt(ReferenceLap::lap)`. */
function compareReferenceLaps(left: ReferenceLap, right: ReferenceLap): number {
  const byDate = doubleCompare(left.date, right.date);
  if (byDate !== 0) {
    return byDate;
  }
  return left.lap - right.lap;
}

/** Java's `Comparator.comparingDouble` goes through `Double.compare`: NaN last, -0.0 first. */
function doubleCompare(left: number, right: number): number {
  if (left < right) return -1;
  if (left > right) return 1;
  if (Number.isNaN(left)) return Number.isNaN(right) ? 0 : 1;
  if (Number.isNaN(right)) return -1;
  if (left === 0 && right === 0) {
    const leftNegativeZero = Object.is(left, -0);
    const rightNegativeZero = Object.is(right, -0);
    if (leftNegativeZero === rightNegativeZero) return 0;
    return leftNegativeZero ? -1 : 1;
  }
  return 0;
}

/** ReferenceLapService.java:94-100 - `toMillis() / 1000.0`, or 0.0 when the file is gone. */
async function lastModifiedSeconds(target: string): Promise<number> {
  try {
    // Java's `FileTime.toMillis()` is integral; mtimeMs can carry a sub-millisecond fraction.
    return Math.trunc((await fs.promises.stat(target)).mtimeMs) / 1000.0;
  } catch {
    return 0.0;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
