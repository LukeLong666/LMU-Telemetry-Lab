/**
 * Ports TrackMatcher.java — fuzzy resolution of a raw game track name against the
 * track registry. Pass order = matching priority: exact normalized key, then declared
 * alias, then the difflib similarity sweep with a 0.6 floor.
 */
import type { TrackDefinition } from '../../domain/types.js';
import { isBlank, normalizeTrack } from './track-names.js';
import { ratio } from './sequence-matcher.js';

export interface TrackMatch {
  readonly key: string;
  readonly definition: TrackDefinition;
}

export function matchTrack(
  searchName: string | null,
  registry: Map<string, TrackDefinition>,
): TrackMatch | null {
  if (searchName === null || searchName === undefined || isBlank(searchName) || registry.size === 0) {
    return null;
  }
  const normalized = normalizeTrack(searchName);

  for (const [key, definition] of registry) {
    if (normalizeTrack(key) === normalized) {
      return { key, definition };
    }
  }

  for (const [key, definition] of registry) {
    for (const alias of aliasesOf(definition)) {
      if (normalizeTrack(alias) === normalized) {
        return { key, definition };
      }
    }
  }

  const candidates = new Map<string, string>();
  for (const [key, definition] of registry) {
    candidates.set(normalizeTrack(key), key);
    for (const alias of aliasesOf(definition)) {
      candidates.set(normalizeTrack(alias), key);
    }
  }

  let bestKey: string | null = null;
  let bestScore = 0.6;
  for (const [candidateKey, trackKey] of candidates) {
    const score = ratio(normalized, candidateKey);
    if (score >= bestScore && (bestKey === null || score > bestScore)) {
      bestScore = score;
      bestKey = trackKey;
    }
  }
  if (bestKey !== null) {
    return { key: bestKey, definition: registry.get(bestKey)! };
  }
  return null;
}

/** TrackDefinition.java's compact constructor normalizes a missing `aliases` to an empty list. */
function aliasesOf(definition: TrackDefinition): string[] {
  return definition.aliases ?? [];
}
