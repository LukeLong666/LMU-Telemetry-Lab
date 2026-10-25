import { describe, expect, it } from 'vitest';
import { matchingBlocks, ratio } from '../../../src/infra/track/sequence-matcher.js';

/**
 * Golden table: every row is the literal `Double.toString` output of
 * `SequenceMatcher.ratio(left, right)` run on the compiled Java class
 * (backend-java/src/main/java/com/lmutl/infra/track/SequenceMatcher.java), so the
 * doubles below are bit-identical expectations, not rounded approximations.
 * Python's difflib was computed for the overlapping subset and agrees on every value,
 * except the `['', '']` guard which Java defines as 1.0 (difflib raises ZeroDivisionError).
 */
const JAVA_RATIO_GOLDENS: ReadonlyArray<readonly [string, string, number]> = [
  ['monza', 'monzaa', 0.9090909090909091],
  ['paul ricard', 'paul riccard', 0.9565217391304348],
  ['abc', 'xyz', 0.0],
  ['equal', 'equal', 1.0],
  ['', '', 1.0],
  ['', 'x', 0.0],
  ['x', '', 0.0],
  ['bahrain', 'bahrain international circuit', 0.3888888888888889],
  ['spa', 'circuit de spa francorchamps', 0.1935483870967742],
  ['cota', 'circuit of the americas', 0.2962962962962963],
  ['austin', 'circuit of the americas', 0.13793103448275862],
  ['sakhir', 'bahrain international circuit', 0.22857142857142856],
  ['portimao', 'algarve international circuit', 0.21621621621621623],
  ['monza', 'autodromo nazionale monza', 0.3333333333333333],
  ['le mans', 'circuit de la sarthe', 0.2962962962962963],
  ['international', 'algarve international circuit', 0.6190476190476191],
  [' - international', 'algarve international circuit', 0.6222222222222222],
  ['MONZA', 'monza', 0.0],
  ['Monza', 'MONZA', 0.2],
  ['daytona', 'daytona international speedway', 0.3783783783783784],
  ['long beach', 'grand prix of long beach', 0.5882352941176471],
  ['road atlanta', 'michelin raceway road atlanta', 0.5853658536585366],
  ['laguna seca', 'weathertech raceway laguna seca', 0.5238095238095238],
  ['imola', 'autodromo internazionale enzo e dino ferrari', 0.16326530612244897],
  ['interlagos', 'autodromo jose carlos pace', 0.3333333333333333],
  ['x', 'x', 1.0],
  ['ab', 'ba', 0.5],
  ['abcde', 'edcba', 0.2],
  ['sebring', 'sebring international raceway', 0.3888888888888889],
  ['lusail', 'lusail international circuit', 0.35294117647058826],
  ['fuji', 'fuji speedway', 0.47058823529411764],
  ['barcelona', 'circuit de barcelona', 0.6206896551724138],
  ['silverstone', 'silverstone', 1.0],
  ['paul ricard 1a', 'layout 1a', 0.43478260869565216],
  ['1a', 'layout 1a', 0.36363636363636365],
  ['abcdefghijklmnopqrstuvwxyz', 'zyxwvutsrqponmlkjihgfedcba', 0.038461538461538464],
  ['aaa', 'aaaa', 0.8571428571428571],
  ['aabaab', 'abaaba', 0.8333333333333334],
  ['mississippi', 'missing', 0.5555555555555556],
];

/**
 * Non-ASCII rows, also captured from the Java class. Java indexes UTF-16 code units
 * (`charAt`), so a surrogate pair counts as 2 on both sides — which is *not* what
 * Python's difflib does for the same input, and is why these rows are pinned to Java.
 */
const JAVA_RATIO_UNICODE_GOLDENS: ReadonlyArray<readonly [string, string, number]> = [
  ['autodromo nazionale monza', 'autodromo nazionale monz\u00e9', 0.96],
  ['caf\u00e9', 'cafe', 0.75],
  ['\u00c9cha\u00eene', 'echaine', 0.7142857142857143],
  ['sp\u00a0a', 'spa', 0.8571428571428571],
  ['\u00fcber', 'uber', 0.75],
  ['\u5c71\u53e3 circuit', 'sakurajima circuit', 0.5714285714285714],
  ['\ud83d\ude80 rocket', 'rocket \ud83d\ude80', 0.6666666666666666],
  ['\ud83d\ude80\ud83d\ude80', '\ud83d\ude80', 0.6666666666666666],
  ['p\u00f4', 'p\u00f4r', 0.8],
  ['Stra\u00dfe', 'strasse', 0.6153846153846154],
  ['stra\u00dfe', 'stra\u00dfe', 1.0],
];

/** difflib.SequenceMatcher(None, a, b).get_matching_blocks() — same triple shape as Java. */
const DIFFLIB_BLOCK_GOLDENS: ReadonlyArray<readonly [string, string, number[][]]> = [
  ['monza', 'monzaa', [[0, 0, 5], [5, 6, 0]]],
  ['paul ricard', 'paul riccard', [[0, 0, 8], [8, 9, 3], [11, 12, 0]]],
  ['abc', 'xyz', [[3, 3, 0]]],
  ['equal', 'equal', [[0, 0, 5], [5, 5, 0]]],
  ['mississippi', 'missing', [[0, 0, 5], [11, 7, 0]]],
  ['aabaab', 'abaaba', [[1, 0, 5], [6, 6, 0]]],
  ['daytona', 'daytona international speedway', [[0, 0, 7], [7, 30, 0]]],
  ['', 'x', [[0, 1, 0]]],
  ['abcde', 'edcba', [[0, 4, 1], [5, 5, 0]]],
  ['cota', 'circuit of the americas', [[0, 0, 1], [1, 8, 1], [2, 11, 1], [3, 15, 1], [4, 23, 0]]],
];

describe('SequenceMatcher.ratio', () => {
  it('reproduces every Java golden bit-for-bit', () => {
    for (const [left, right, expected] of JAVA_RATIO_GOLDENS) {
      expect(ratio(left, right), `${left} vs ${right}`).toBe(expected);
    }
  });

  it('reproduces the four ratios asserted by TrackMatcherTest.java', () => {
    // Java: isCloseTo(0.909091, offset(0.000001)) etc.
    expect(ratio('monza', 'monzaa')).toBeCloseTo(0.909091, 6);
    expect(ratio('paul ricard', 'paul riccard')).toBeCloseTo(0.956522, 6);
    expect(ratio('abc', 'xyz')).toBe(0.0);
    expect(ratio('equal', 'equal')).toBe(1.0);
  });

  it('stays on the Java side of the UTF-16 / code point split for non-ASCII names', () => {
    for (const [left, right, expected] of JAVA_RATIO_UNICODE_GOLDENS) {
      expect(ratio(left, right), `${left} vs ${right}`).toBe(expected);
    }
  });

  it('is 1.0 for identical strings whatever they look like', () => {
    for (const candidate of ['monza', 'silverstone', 'x', 'Paul Ricard - 1A-V2-Short', '  ', 'stra\u00dfe']) {
      expect(ratio(candidate, candidate)).toBe(1.0);
    }
  });

  it('treats case as a different character (no case folding anywhere)', () => {
    expect(ratio('MONZA', 'monza')).toBe(0.0);
    expect(ratio('Monza', 'MONZA')).toBe(0.2);
    expect(ratio('monza', 'monza')).toBe(1.0);
  });

  it('guards the empty-string cases the way Java does', () => {
    expect(ratio('', '')).toBe(1.0);
    expect(ratio('', 'algarve international circuit')).toBe(0.0);
    expect(ratio('algarve international circuit', '')).toBe(0.0);
    expect(ratio(null, 'monza')).toBe(0.0);
    expect(ratio('monza', null)).toBe(0.0);
  });

  it('scores a strict prefix below the 0.6 floor TrackMatcher uses', () => {
    // The registry therefore never relies on raw prefixes: TrackMatcher normalises the
    // noise words first, so these scores are what decides a fuzzy hit.
    expect(ratio('bahrain', 'bahrain international circuit')).toBeLessThan(0.6);
    expect(ratio('sebring', 'sebring international raceway')).toBeLessThan(0.6);
    expect(ratio('daytona', 'daytona international speedway')).toBeLessThan(0.6);
    expect(ratio('lusail', 'lusail international circuit')).toBeLessThan(0.6);
    expect(ratio('fuji', 'fuji speedway')).toBeLessThan(0.6);
  });

  it('scores a bare layout suffix above the 0.6 floor', () => {
    expect(ratio('international', 'algarve international circuit')).toBeGreaterThanOrEqual(0.6);
    expect(ratio(' - international', 'algarve international circuit')).toBeGreaterThanOrEqual(0.6);
    expect(ratio('barcelona', 'circuit de barcelona')).toBeGreaterThanOrEqual(0.6);
  });

  it('scores pure aliases (unrelated words) below the 0.6 floor', () => {
    for (const [alias, canonical] of [
      ['portimao', 'algarve international circuit'],
      ['sakhir', 'bahrain international circuit'],
      ['cota', 'circuit of the americas'],
      ['austin', 'circuit of the americas'],
      ['le mans', 'circuit de la sarthe'],
      ['imola', 'autodromo internazionale enzo e dino ferrari'],
    ] as const) {
      expect(ratio(alias, canonical), `${alias} vs ${canonical}`).toBeLessThan(0.6);
    }
  });

  it('ranks degradation the way Java does (values measured on the JVM, not assumed)', () => {
    expect(ratio('monza', 'monza')).toBe(1.0);
    expect(ratio('monza', 'monzaa')).toBe(0.9090909090909091);
    expect(ratio('monza', 'xyzmonzaq')).toBe(0.7142857142857143);
    expect(ratio('aaa', 'aaaa')).toBe(0.8571428571428571);
    expect(ratio('abab', 'ababab')).toBe(0.8);
    // Splitting a run into [1] + [2] blocks does not lose score: Ratcliff/Obershelp
    // only counts matched characters, so both of these are the same 0.6666666666666666.
    expect(ratio('abc', 'abcxyz')).toBe(0.6666666666666666);
    expect(ratio('abc', 'axbcyz')).toBe(0.6666666666666666);
  });
});

describe('SequenceMatcher.matchingBlocks', () => {
  it('matches difflib get_matching_blocks (including the trailing sentinel triple)', () => {
    for (const [a, b, expected] of DIFFLIB_BLOCK_GOLDENS) {
      expect(matchingBlocks(a, b).map((block) => [...block]), `${a} vs ${b}`).toEqual(expected);
    }
  });

  it('ends with the [a.length, b.length, 0] sentinel like SequenceMatcher.java', () => {
    for (const [a, b] of JAVA_RATIO_GOLDENS) {
      const blocks = matchingBlocks(a, b);
      expect(blocks[blocks.length - 1]).toEqual([a.length, b.length, 0]);
    }
  });

  it('sums the block sizes to the numerator of ratio()', () => {
    for (const [a, b] of [...JAVA_RATIO_GOLDENS, ...JAVA_RATIO_UNICODE_GOLDENS]) {
      if (a.length + b.length === 0) {
        continue;
      }
      const matches = matchingBlocks(a, b).reduce((total, block) => total + block[2], 0);
      expect((2.0 * matches) / (a.length + b.length)).toBe(ratio(a, b));
    }
  });

  it('merges neighbouring blocks instead of reporting them apart', () => {
    // 'paul ricard' vs 'paul riccard': the 8-char and 3-char runs touch on both sides.
    const blocks = matchingBlocks('paul ric', 'paul ricc');
    expect(blocks).toEqual([[0, 0, 8], [8, 9, 0]]);
  });
});
