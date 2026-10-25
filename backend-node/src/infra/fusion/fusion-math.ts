/**
 * Ports FusionMath.java — the numeric primitives the fusion engine is built on.
 *
 * Every series is a `Float64Array`, never `number[]`: Java used `double[]`, which is
 * fixed-length, always holds doubles and has no holes. A JS array would turn a missed
 * assignment into `undefined` (silently poisoning arithmetic with NaN) instead of the
 * out-of-bounds error Java raises.
 */

/**
 * Java `Double.compare`, i.e. the order `Arrays.sort(double[])` establishes:
 * -0.0 sorts before 0.0, and NaN sorts *last*, after +Infinity.
 *
 * `Float64Array.prototype.sort()` without a comparator already matches this ordering,
 * but the comparator is written out so the intent is explicit and so the sort never
 * falls back to JS's lexicographic `Array.prototype.sort()` behaviour.
 */
function compareDoubles(left: number, right: number): number {
  if (Number.isNaN(left)) return Number.isNaN(right) ? 0 : 1;
  if (Number.isNaN(right)) return -1;
  if (left < right) return -1;
  if (left > right) return 1;
  if (left === 0 && right === 0) {
    const leftIsNegativeZero = 1 / left === Number.NEGATIVE_INFINITY;
    const rightIsNegativeZero = 1 / right === Number.NEGATIVE_INFINITY;
    if (leftIsNegativeZero !== rightIsNegativeZero) return leftIsNegativeZero ? -1 : 1;
  }
  return 0;
}

/**
 * Java `Math.round(double)` (= `(long) floor(x + 0.5)`), which differs from
 * `Math.round` in JS on the three inputs `round3` can actually see:
 * NaN (Java 0, JS NaN), +Infinity (Java Long.MAX_VALUE, JS Infinity), -Infinity
 * (Java Long.MIN_VALUE, JS -Infinity) and the sign of a zero result (JS -0, Java 0).
 */
function javaRound(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
  if (value === Number.NEGATIVE_INFINITY) return -Number.MAX_SAFE_INTEGER;
  const rounded = Math.floor(value + 0.5);
  return rounded === 0 ? 0 : rounded;
}

export function masterTimeline(start: number, end: number, frequency: number): Float64Array {
  const dt = 1.0 / frequency;
  // Match numpy.arange(start, end + dt, dt): the count is ceil(ratio) + 1.
  // Java narrowed with `(int)`, which truncates toward zero.
  const count = Math.trunc(Math.ceil((end - start) / dt)) + 1;
  const result = new Float64Array(Math.max(1, count));
  for (let i = 0; i < result.length; i++) {
    // numpy's arange+round lands on the upper millisecond for exact .0005
    // boundaries; the tiny epsilon matches the Python oracle at 10/100 Hz.
    result[i] = Math.floor((start + i * dt) * 1000.0 + 0.5 + 1e-9) / 1000.0;
  }
  return result;
}

/** First index whose value is >= target (target greater than all -> values.length). */
export function lowerBound(values: Float64Array, target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/** First index whose value is > target, so `upperBound(...) - 1` is the as-of match. */
export function upperBound(values: Float64Array, target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] <= target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * Piecewise-linear lookup with clamped edges. `NaN` inside `fp` propagates exactly like
 * Java's arithmetic does; the guards below keep `index` inside both arrays so a JS
 * out-of-range read (undefined -> silent NaN) can never replace Java's array-bounds error.
 */
export function interp(xp: Float64Array, fp: Float64Array, x: number): number {
  if (xp.length === 0 || fp.length === 0) {
    return Number.NaN;
  }
  if (x <= xp[0]) {
    return fp[0];
  }
  if (x >= xp[xp.length - 1]) {
    return fp[fp.length - 1];
  }
  // Here xp.length >= 2 and lowerBound lands in [1, xp.length - 1].
  const index = lowerBound(xp, x);
  if (index <= 0) {
    return fp[0];
  }
  if (xp[index] === x) {
    return fp[index];
  }
  const x0 = xp[index - 1];
  const x1 = xp[index];
  if (x1 === x0) {
    return fp[index];
  }
  const ratio = (x - x0) / (x1 - x0);
  return fp[index - 1] + ratio * (fp[index] - fp[index - 1]);
}

/**
 * Frame tables carry no timestamp, so their row index is mapped linearly onto the GPS
 * timeline (`gpsTimes` being the master index space of the session).
 */
export function mapIndicesToTimes(gpsTimes: Float64Array, sampleCount: number): Float64Array {
  if (sampleCount === 0 || gpsTimes.length === 0) {
    return new Float64Array(0);
  }
  const times = new Float64Array(sampleCount);
  if (sampleCount === 1 || gpsTimes.length === 1) {
    times.fill(gpsTimes[0]);
    return times;
  }
  const step = (gpsTimes.length - 1) / (sampleCount - 1);
  for (let i = 0; i < sampleCount; i++) {
    const position = i * step;
    const index = Math.floor(position);
    if (index >= gpsTimes.length - 1) {
      times[i] = gpsTimes[gpsTimes.length - 1];
    } else {
      const fraction = position - index;
      times[i] = gpsTimes[index] + fraction * (gpsTimes[index + 1] - gpsTimes[index]);
    }
  }
  return times;
}

/** Sorted, de-duplicated copy. NaN lands last (Java's sort order) and is kept as a value. */
export function uniqueFirst(values: Float64Array): Float64Array {
  const copy = values.slice();
  copy.sort(compareDoubles);
  let unique = 0;
  for (let i = 0; i < copy.length; i++) {
    // Java compared with `!=`, which treats -0.0 and 0.0 as the same value.
    if (i === 0 || copy[i] !== copy[i - 1]) {
      copy[unique++] = copy[i];
    }
  }
  return copy.slice(0, unique);
}

export function median(values: Float64Array): number {
  let length = 0;
  for (const value of values) {
    if (!Number.isNaN(value)) length++;
  }
  if (length === 0) {
    return 0.0;
  }
  const copy = new Float64Array(length);
  let at = 0;
  for (const value of values) {
    if (!Number.isNaN(value)) copy[at++] = value;
  }
  copy.sort(compareDoubles);
  // Java divided two ints, i.e. truncated.
  const middle = Math.trunc(length / 2);
  return length % 2 === 0 ? (copy[middle - 1] + copy[middle]) / 2.0 : copy[middle];
}

export function mean(values: Float64Array): number {
  let sum = 0;
  let count = 0;
  for (const value of values) {
    if (!Number.isNaN(value)) {
      sum += value;
      count++;
    }
  }
  return count === 0 ? 0.0 : sum / count;
}

/** Millisecond grid snap; every event timestamp goes through it before alignment. */
export function round3(value: number): number {
  return javaRound(value * 1000.0) / 1000.0;
}
