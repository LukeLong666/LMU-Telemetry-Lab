/**
 * Ports TrackNames.java (package-private helper in com.lmutl.infra.track).
 * The LMU telemetry files write track names in every conceivable spelling, so this
 * normalization plus the regex definitions below decide which standard track a
 * session is mapped to. Every pattern is kept character-for-character equivalent to
 * the Java `Pattern` it replaces:
 *
 * - Java's regex `\s` is ASCII-only (`[ \t\n\x0B\f\r]`); JS `\s` additionally matches
 *   U+00A0, U+2028, U+202F, U+3000 … so the classes below spell the ASCII set out.
 * - Java's `String.trim()` drops every code unit <= U+0020 (not "unicode whitespace");
 *   `javaTrim` reproduces that, `String.prototype.trim` would not.
 * - `toLowerCase(Locale.ROOT)` maps to JS `toLowerCase()`: both are locale-independent
 *   and both may grow the string (U+0130 -> "i" + U+0307), so they agree.
 * - Java's regex `\b` and JS's `\b` are both defined over `[A-Za-z0-9_]`.
 * - NFD decomposition + dropping Unicode category Mn is Java's
 *   `Normalizer.normalize(NFD)` filtered on `Character.NON_SPACING_MARK`.
 *
 * Functions are exported (Java had them package-private) because layout-matcher,
 * track-matcher and car-catalog all need them.
 */

/** `\\b(circuit de la|circuit de|autodromo nazionale|international|grand prix|circuit|gp|autodromo)\\b` */
const COMMON_NOISE =
  /\b(circuit de la|circuit de|autodromo nazionale|international|grand prix|circuit|gp|autodromo)\b/g;
/** `[-_]` */
const SEPARATORS = /[-_]/g;
/** `^[^a-z0-9]+` */
const LEADING_NON_ALNUM = /^[^a-z0-9]+/;
/** Java regex `\s+`, i.e. `[ \t\n\x0B\f\r]+`. */
const ASCII_WHITESPACE_RUN = /[ \t\n\v\f\r]+/g;
/** `Character.isWhitespace(int)` — note: U+00A0/U+2007/U+202F/U+0085 are NOT whitespace in Java. */
const JAVA_WHITESPACE_CODE_POINT =
    /^[\t\n\v\f\r\u001C-\u001F \u1680\u2000-\u2006\u2008-\u200A\u2028\u2029\u205F\u3000]$/;
const NON_SPACING_MARK = /\p{Mn}/u;

export function normalizeTrack(input: string | null): string {
  if (input === null || input === undefined) {
    return '';
  }
  let value = javaTrim(stripAccents(input).toLowerCase());
  value = value.replace(SEPARATORS, ' ');
  value = value.replace(COMMON_NOISE, '');
  return collapseWhitespace(value);
}

export function normalizeLayout(input: string | null): string {
  if (input === null || input === undefined) {
    return '';
  }
  let value = javaTrim(stripAccents(input).toLowerCase());
  value = value.replace(SEPARATORS, ' ');
  return collapseWhitespace(value);
}

export function stripLeadingNonAlnum(input: string): string {
  return input.replace(LEADING_NON_ALNUM, '');
}

export function stripAccents(input: string): string {
  const decomposed = input.normalize('NFD');
  let builder = '';
  for (const codePoint of decomposed) {
    if (!NON_SPACING_MARK.test(codePoint)) {
      builder += codePoint;
    }
  }
  return builder;
}

export function collapseWhitespace(input: string): string {
  return javaTrim(input).replace(ASCII_WHITESPACE_RUN, ' ');
}

/** Java's `String.trim()`: drop leading/trailing code units <= U+0020. */
export function javaTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) {
    start += 1;
  }
  while (end > start && value.charCodeAt(end - 1) <= 0x20) {
    end -= 1;
  }
  return value.slice(start, end);
}

/** Java's `String.isBlank()`: every code point is `Character.isWhitespace`, empty counts as blank. */
export function isBlank(input: string): boolean {
  for (const codePoint of input) {
    if (!JAVA_WHITESPACE_CODE_POINT.test(codePoint)) {
      return false;
    }
  }
  return true;
}
