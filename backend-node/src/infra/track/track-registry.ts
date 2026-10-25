/**
 * Ports TrackRegistry.java — loads the bundled tracks.json (the canonical track
 * catalogue the matchers normalise game names into) and exposes the lookup entry
 * points used by the application services.
 *
 * Loading style: a static JSON module import with an import attribute
 * (`with { type: 'json' }`). resolveJsonModule makes `tsc -p tsconfig.build.json`
 * copy tracks.json next to the emitted track-registry.js, so the built dist/ tree
 * keeps working without an extra resource-copy step; Node 22 reads the attribute
 * natively (no flag, no loader).
 *
 * Java's `@PostConstruct load()` runs right after construction; the constructor does
 * the same here, and `load()` stays public/idempotent so a caller can force a reload.
 */
import type { Logger } from '../../lib/log.js';
import type { TrackDefinition, TrackLayout } from '../../domain/types.js';
import tracksJson from './tracks.json' with { type: 'json' };
import { matchLayout, type LayoutMatch } from './layout-matcher.js';
import { matchTrack, type TrackMatch } from './track-matcher.js';

export class TrackRegistry {
  private readonly log?: Logger;
  private trackMap: Map<string, TrackDefinition> = new Map();

  constructor(logger?: Logger) {
    this.log = logger;
    this.load();
  }

  /** Mirrors TrackRegistry.load(): reads tracks.json, refuses an empty catalogue. */
  load(): void {
    try {
      const raw = tracksJson as unknown as Record<string, TrackDefinition>;
      const entries = Object.entries(raw ?? {});
      if (entries.length === 0) {
        throw new Error('tracks.json is empty');
      }
      const loaded = new Map<string, TrackDefinition>();
      for (const [key, definition] of entries) {
        loaded.set(key, normalizeDefinition(definition));
      }
      // Java wraps the map in Collections.unmodifiableMap(new LinkedHashMap<>(...)):
      // declaration order is preserved and the result is treated as read-only. The map
      // is handed out as-is (JS has no unmodifiableMap); callers must not mutate it.
      this.trackMap = loaded;

      let layouts = 0;
      let points = 0;
      for (const definition of this.trackMap.values()) {
        const values = Object.values(definition.layouts);
        layouts += values.length;
        for (const layout of values) {
          points += layout.ref_points.length;
        }
      }
      this.log?.info(
        `Loaded ${this.trackMap.size} tracks, ${layouts} layouts, ${points} elevation points`,
      );
    } catch (error) {
      throw new Error('Failed to load tracks.json', { cause: error });
    }
  }

  tracks(): Map<string, TrackDefinition> {
    return this.trackMap;
  }

  findTrack(trackName: string | null): TrackMatch | null {
    return matchTrack(trackName, this.trackMap);
  }

  findLayout(
    track: TrackDefinition | null | undefined,
    rawLayout: string | null,
    rawTrack: string | null,
  ): LayoutMatch | null {
    return matchLayout(track, rawLayout, rawTrack);
  }
}

/** The Java records default a missing list/map to an empty one; do the same once at load time. */
function normalizeDefinition(definition: TrackDefinition): TrackDefinition {
  const layouts: Record<string, TrackLayout> = {};
  for (const [key, layout] of Object.entries(definition.layouts ?? {})) {
    layouts[key] = { aliases: layout.aliases ?? [], ref_points: layout.ref_points ?? [] };
  }
  return {
    display_name: definition.display_name,
    aliases: definition.aliases ?? [],
    country: definition.country,
    layouts,
  };
}
