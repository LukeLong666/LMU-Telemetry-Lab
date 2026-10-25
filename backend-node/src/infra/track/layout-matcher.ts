/**
 * Ports LayoutMatcher.java — resolves the layout string the game wrote into a session
 * against the layouts declared by an already-resolved track.
 * The pass order below is the matching priority and must not be re-arranged.
 *
 * One deliberate difference from Java: `TrackDefinition.layouts()` is built with
 * `Map.copyOf(...)`, whose iteration order is unspecified (for Paul Ricard the JVM
 * yields [Layout 3A, Layout 1A, Default, Layout 1A-V2-Short, Layout 1A-V2]). Here the
 * JSON declaration order is kept, which is what the original Python backend does and
 * what makes the result reproducible across platforms.
 */
import type { TrackDefinition, TrackLayout } from '../../domain/types.js';
import { isBlank, javaTrim, normalizeLayout, stripLeadingNonAlnum } from './track-names.js';

export interface LayoutMatch {
  readonly key: string;
  readonly layout: TrackLayout;
}

export function matchLayout(
  track: TrackDefinition | null | undefined,
  rawLayout: string | null,
  rawTrack: string | null,
): LayoutMatch | null {
  if (track === null || track === undefined) {
    return null;
  }
  if (rawLayout === null || rawLayout === undefined || isBlank(rawLayout)) {
    return null;
  }
  const layouts = new Map<string, TrackLayout>(Object.entries(track.layouts ?? {}));
  if (layouts.size === 0) {
    return null;
  }

  const normalizedLayout = normalizeLayout(rawLayout);
  const normalizedTrack = rawTrack === null || rawTrack === undefined ? '' : normalizeLayout(rawTrack);

  for (const [key, layout] of layouts) {
    if (normalizeLayout(key) === normalizedLayout) {
      return { key, layout };
    }
  }

  for (const [key, layout] of layouts) {
    for (const alias of aliasesOf(layout)) {
      if (normalizeLayout(alias) === normalizedLayout) {
        return { key, layout };
      }
    }
  }

  let strippedLayout = normalizedLayout;
  if (normalizedTrack !== '' && normalizedLayout.includes(normalizedTrack)) {
    strippedLayout = javaTrim(normalizedLayout.replaceAll(normalizedTrack, ''));
    strippedLayout = stripLeadingNonAlnum(strippedLayout);
  }

  if (strippedLayout !== '') {
    for (const [key, layout] of layouts) {
      const stripped = strippedKey(key);
      if (stripped === strippedLayout) {
        return { key, layout };
      }
      for (const alias of aliasesOf(layout)) {
        if (stripLeadingNonAlnum(normalizeLayout(alias)) === strippedLayout) {
          return { key, layout };
        }
      }
    }
    for (const [key, layout] of layouts) {
      const stripped = strippedKey(key);
      if (stripped.includes(strippedLayout) || strippedLayout.includes(stripped)) {
        return { key, layout };
      }
      for (const alias of aliasesOf(layout)) {
        const normalizedAlias = normalizeLayout(alias);
        if (normalizedAlias.includes(strippedLayout) || strippedLayout.includes(normalizedAlias)) {
          return { key, layout };
        }
      }
    }
  }

  for (const [key, layout] of layouts) {
    const normalizedKey = normalizeLayout(key);
    if (normalizedKey.includes(normalizedLayout) || normalizedLayout.includes(normalizedKey)) {
      return { key, layout };
    }
  }

  const fallback = layouts.get('Default');
  if (fallback !== undefined) {
    return { key: 'Default', layout: fallback };
  }
  return null;
}

function strippedKey(key: string): string {
  let normalized = normalizeLayout(key);
  // Java's String.replace(CharSequence, CharSequence) replaces *every* occurrence.
  normalized = javaTrim(normalized.replaceAll('layout', ''));
  return stripLeadingNonAlnum(normalized);
}

/** TrackLayout.java's compact constructor normalizes a missing `aliases` to an empty list. */
function aliasesOf(layout: TrackLayout): string[] {
  return layout.aliases ?? [];
}
