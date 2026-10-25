/**
 * Minimal port of Python's difflib.SequenceMatcher ratio() (Ratcliff/Obershelp).
 * Mirrors SequenceMatcher.java line by line: the track registry relies on the exact
 * same similarity metric as the Python backend, so the loops, the boundary
 * comparisons and the queue order must not be "improved".
 *
 * Parity notes:
 * - Indexing uses UTF-16 code units (`s.length`, `charCodeAt`), exactly like Java's
 *   `String.charAt`, so a surrogate pair counts as 2 on both sides.
 * - The work list is FIFO: `ArrayDeque.add` + `removeFirst` in Java == push to the
 *   tail / read from the head here (tracked with `head`, which keeps the pop order
 *   identical while avoiding `Array.shift`).
 * - `blocks.sort(by block[0])` relies on a stable sort; both Java's TimSort and the
 *   ES2019 `Array.prototype.sort` are stable.
 * - `Int32Array` reproduces Java's `int[]` (slots default to 0, never `undefined`).
 */

/** `[aStart, bStart, size]` — same triple shape as Java's `int[]`. */
export type MatchingBlock = readonly [aStart: number, bStart: number, size: number];

/** Mutable working shape of a block; Java mutates `last[2]` while merging. */
type Block = [aStart: number, bStart: number, size: number];

/** Java's `int[]{alo, ahi, blo, bhi}` work-queue entry. */
type Range = [alo: number, ahi: number, blo: number, bhi: number];

export function ratio(left: string | null, right: string | null): number {
  if (left === null || left === undefined || right === null || right === undefined) {
    return 0.0;
  }
  const total = left.length + right.length;
  if (total === 0) {
    return 1.0;
  }
  let matches = 0;
  for (const block of matchingBlocks(left, right)) {
    matches += block[2];
  }
  return (2.0 * matches) / total;
}

/** Package-private in SequenceMatcher.java; exported here so the unit test can pin the block decomposition. */
export function matchingBlocks(a: string, b: string): MatchingBlock[] {
  const blocks: Block[] = [];
  const queue: Range[] = [[0, a.length, 0, b.length]];
  let head = 0;
  while (head < queue.length) {
    const range = queue[head];
    head += 1;
    const alo = range[0];
    const ahi = range[1];
    const blo = range[2];
    const bhi = range[3];
    const match = findLongestMatch(a, b, alo, ahi, blo, bhi);
    if (match[2] > 0) {
      blocks.push(match);
      if (alo < match[0] && blo < match[1]) {
        queue.push([alo, match[0], blo, match[1]]);
      }
      if (match[0] + match[2] < ahi && match[1] + match[2] < bhi) {
        queue.push([match[0] + match[2], ahi, match[1] + match[2], bhi]);
      }
    }
  }
  blocks.sort((block1, block2) => block1[0] - block2[0]);

  const merged: Block[] = [];
  for (const block of blocks) {
    if (merged.length > 0) {
      const last = merged[merged.length - 1];
      if (last[0] + last[2] === block[0] && last[1] + last[2] === block[1]) {
        last[2] += block[2];
        continue;
      }
    }
    merged.push([block[0], block[1], block[2]]);
  }
  merged.push([a.length, b.length, 0]);
  return merged;
}

function findLongestMatch(
  a: string,
  b: string,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
): Block {
  const b2j = new Map<number, number[]>();
  for (let j = blo; j < bhi; j++) {
    const key = b.charCodeAt(j);
    const positions = b2j.get(key);
    if (positions === undefined) {
      b2j.set(key, [j]);
    } else {
      positions.push(j);
    }
  }

  let bestI = alo;
  let bestJ = blo;
  let bestSize = 0;
  let previous = new Int32Array(Math.max(1, bhi - blo + 1));

  for (let i = alo; i < ahi; i++) {
    const current = new Int32Array(previous.length);
    const positions = b2j.get(a.charCodeAt(i));
    if (positions !== undefined) {
      for (const j of positions) {
        if (j < blo) {
          continue;
        }
        if (j >= bhi) {
          break;
        }
        const k = (j > blo ? previous[j - 1 - blo] : 0) + 1;
        current[j - blo] = k;
        if (k > bestSize) {
          bestI = i - k + 1;
          bestJ = j - k + 1;
          bestSize = k;
        }
      }
    }
    previous = current;
  }
  return [bestI, bestJ, bestSize];
}
