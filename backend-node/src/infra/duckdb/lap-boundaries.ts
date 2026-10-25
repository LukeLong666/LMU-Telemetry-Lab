import type { DuckDBConnection } from '@duckdb/node-api';
import { readEventsOrEmpty, scalarDouble, type Event } from './reads.js';

/** Java `LapBoundaryResolver.Result`. */
export interface LapBoundaries {
  readonly sessionStart: number;
  readonly sessionEnd: number;
  /** Ascending, de-duplicated lap-start times; the session start is prepended when missing. */
  readonly boundaries: number[];
  /** Lap-time events with a positive value, in ts order. */
  readonly lapTimes: Event[];
}

/**
 * Java `LapBoundaryResolver.resolve`: derives the lap boundaries of a session from
 * the `GPS Time`, `Lap` and `Lap Time` tables.
 *
 * Throws when the session has no GPS timestamps (Java threw SQLException, which
 * surfaces as a 500 through the global handler).
 */
export async function resolve(connection: DuckDBConnection): Promise<LapBoundaries> {
  const startValue = await scalarDouble(connection, 'SELECT MIN(value) FROM "GPS Time"');
  const endValue = await scalarDouble(connection, 'SELECT MAX(value) FROM "GPS Time"');
  if (startValue === null || endValue === null) {
    throw new Error('GPS Time table is empty.');
  }
  const sessionStart = startValue;
  const sessionEnd = endValue;

  const lapStartEvents = await readEventsOrEmpty(connection, 'Lap');
  const lapTimeEvents = await readEventsOrEmpty(connection, 'Lap Time');
  const validLapTimes = lapTimeEvents.filter((event) => event.value > 0);

  const boundaries: number[] = [];
  if (lapStartEvents.length === 0) {
    boundaries.push(sessionStart);
  } else {
    const firstLapStart = lapStartEvents[0].ts;
    boundaries.push(firstLapStart);

    if (validLapTimes.length > 0) {
      const firstLapTime = validLapTimes[0];
      const calcStart = firstLapTime.ts - firstLapTime.value;
      if (lapStartEvents.length > 1) {
        const secondLapStart = lapStartEvents[1].ts;
        if (calcStart < secondLapStart - 1.0 && calcStart > boundaries[0] + 1.0) {
          boundaries.push(calcStart);
        }
      } else if (calcStart > boundaries[0] + 1.0) {
        boundaries.push(calcStart);
      }
    }

    for (let index = 1; index < lapStartEvents.length; index += 1) {
      boundaries.push(lapStartEvents[index].ts);
    }
  }

  // Java used a TreeSet: dedup + ascending sort.
  const sorted = [...new Set(boundaries)].sort((left, right) => left - right);
  if (sorted.length === 0 || sorted[0] - sessionStart > 1.0) {
    sorted.unshift(sessionStart);
  }
  return { sessionStart, sessionEnd, boundaries: sorted, lapTimes: [...validLapTimes] };
}
