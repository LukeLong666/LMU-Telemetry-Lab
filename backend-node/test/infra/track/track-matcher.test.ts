import { beforeAll, describe, expect, it } from 'vitest';
import { TrackRegistry } from '../../../src/infra/track/track-registry.js';
import { matchTrack } from '../../../src/infra/track/track-matcher.js';
import { matchLayout } from '../../../src/infra/track/layout-matcher.js';
import {
  isBlank,
  javaTrim,
  normalizeLayout,
  normalizeTrack,
  stripLeadingNonAlnum,
} from '../../../src/infra/track/track-names.js';
import type { TrackDefinition } from '../../../src/domain/types.js';

/**
 * Ported from backend-java/src/test/java/com/lmutl/infra/track/TrackMatcherTest.java.
 * The extra golden tables were captured from the compiled Java classes (a scratch
 * harness run against backend-java/target/classes), so every expectation is Java's own
 * answer rather than an assumption about what it should do.
 */
let registry: TrackRegistry;

beforeAll(() => {
  registry = new TrackRegistry();
});

/** TrackMatcherTest.matchesKnownTracksAndAliases */
const KNOWN_TRACK_LOOKUPS: ReadonlyArray<readonly [string, string]> = [
  ['Algarve International Circuit', 'Algarve International Circuit'],
  ['Circuit de la Sarthe', 'Circuit de La Sarthe'],
  ['Le Mans', 'Circuit de La Sarthe'],
  ['Monza', 'Autodromo Nazionale Monza'],
  ['Autodromo Nazionale Monza', 'Autodromo Nazionale Monza'],
  ['Spa', 'Circuit de Spa-Francorchamps'],
  ['COTA', 'Circuit of the Americas'],
  ['Austin', 'Circuit of the Americas'],
  ['Sakhir', 'Bahrain International Circuit'],
  ['Portimao', 'Algarve International Circuit'],
];

/** TrackMatcherTest.matchesLayouts */
const PAUL_RICARD_LAYOUTS: ReadonlyArray<readonly [string, string]> = [
  ['Paul Ricard - ELMS', 'Default'],
  ['Paul Ricard - 1A', 'Layout 1A'],
  ['Paul Ricard - 1A-V2', 'Layout 1A-V2'],
  ['Paul Ricard - 1A-V2-Short', 'Layout 1A-V2-Short'],
  ['Paul Ricard - 3A', 'Layout 3A'],
  ['Some Unknown Layout', 'Default'],
  ['Paul Ricard', 'Default'],
];

/** Raw game names -> registry key, as answered by TrackMatcher.java. */
const JAVA_TRACK_GOLDENS: ReadonlyArray<readonly [string, string | null]> = [
  ['Paul Ricarrd', 'Paul Ricard'],
  ['Monda', 'Autodromo Nazionale Monza'],
  ['Autodromo Nazionale Monze', 'Autodromo Nazionale Monza'],
  ['Barcelon', 'Circuit de Barcelona'],
  ['LagunaSeca', 'WeatherTech Raceway Laguna Seca'],
  ['Road Atlantas', 'Michelin Raceway Road Atlanta'],
  ['Sebring Raceway', 'Sebring International Raceway'],
  ['Daytona Speedway', 'Daytona International Speedway'],
  ['Long Beach Grand Prix', 'Grand Prix of Long Beach'],
  ['Bahrain International', 'Bahrain International Circuit'],
  ['Spa-Francorchamps', 'Circuit de Spa-Francorchamps'],
  ['Circuit De Spa', 'Circuit de Spa-Francorchamps'],
  ['Losail', 'Lusail International Circuit'],
  ['Fuji Spedway', 'Fuji Speedway'],
  ['Imola Circuit', 'Autodromo Internazionale Enzo e Dino Ferrari'],
  ['Interlagos', 'Autodromo Jose Carlos Pace'],
  ['Austin Circuit', 'Circuit of the Americas'],
  ['COTA - Grand Prix', 'Circuit of the Americas'],
  ['Silverstone Circuit', 'Silverstone'],
  ['Paul Ricard Circuit', 'Paul Ricard'],
  ['Lusail International', 'Lusail International Circuit'],
  ['Unknown Circuit Name', null],
  ['zzzzzzzzzz', null],
  ['Laguna', 'WeatherTech Raceway Laguna Seca'],
  ['Seca', null],
  ['Montmelo', null],
  ['Portimao - Algarve', 'Algarve International Circuit'],
  ['Sakhir Bahrain', 'Bahrain International Circuit'],
  ['The Raceway', 'Sebring International Raceway'],
  ['algarve international circuit', 'Algarve International Circuit'],
  ['CIRCUIT DE LA SARTHE', 'Circuit de La Sarthe'],
  ['le mans', 'Circuit de La Sarthe'],
  ['LE MANS', 'Circuit de La Sarthe'],
  ['cota', 'Circuit of the Americas'],
  ['C.o.t.a', 'Circuit of the Americas'],
  ['spa-francorchamps', 'Circuit de Spa-Francorchamps'],
  ['monza gp', 'Autodromo Nazionale Monza'],
  ['national monza', null],
  ['Autodromo Internazionale Enzo e Dino Ferrari', 'Autodromo Internazionale Enzo e Dino Ferrari'],
  ['Enzo e Dino Ferrari', 'Autodromo Internazionale Enzo e Dino Ferrari'],
  ['Imola', 'Autodromo Internazionale Enzo e Dino Ferrari'],
  ['Jose Carlos Pace', 'Autodromo Jose Carlos Pace'],
  ['Interlagos Autodromo', 'Autodromo Jose Carlos Pace'],
  ['Road Atlanta Motor Speedway', 'Michelin Raceway Road Atlanta'],
  ['Michelin Raceway', 'Michelin Raceway Road Atlanta'],
  ['WeatherTech Raceway', 'WeatherTech Raceway Laguna Seca'],
  ['Laguna Seca', 'WeatherTech Raceway Laguna Seca'],
  ['Okayama International', null],
  ['Fuji', 'Fuji Speedway'],
  ['Mount Fuji', null],
  ['Barcelona-Catalunya', 'Circuit de Barcelona'],
  ['Catalunya', 'Circuit de Barcelona'],
  ['Daytona', 'Daytona International Speedway'],
  ['Speedway', 'Fuji Speedway'],
  ['Sebring', 'Sebring International Raceway'],
  ['Florida', null],
  ['Donington', null],
  [' Brands Hatch ', null],
  ['Algarve', 'Algarve International Circuit'],
  ['Portimao Circuit', 'Algarve International Circuit'],
  ['Bahrain', 'Bahrain International Circuit'],
  ['Sakhir', 'Bahrain International Circuit'],
  ['Qatar', 'Lusail International Circuit'],
  ['Lusail', 'Lusail International Circuit'],
  ['Austin', 'Circuit of the Americas'],
  ['Texas', null],
  ['Paul Ricard', 'Paul Ricard'],
  ['Le Castellet', 'Paul Ricard'],
  ['Circuit de la Sarthe', 'Circuit de La Sarthe'],
  ['Sarthe', 'Circuit de La Sarthe'],
  ['Monza', 'Autodromo Nazionale Monza'],
  ['Gran Monza', 'Autodromo Nazionale Monza'],
  ['Long Beach', 'Grand Prix of Long Beach'],
  ['Grand Prix of Long Beach', 'Grand Prix of Long Beach'],
  ['Streets of Long Beach', 'Grand Prix of Long Beach'],
  ['Road Atlanta', 'Michelin Raceway Road Atlanta'],
  ["Petty's Warehouse", null],
  ['Bahrain Endurance', null],
  ['Portimao International', 'Algarve International Circuit'],
];

/**
 * [registry key passed as rawTrack, layout as the game wrote it, expected layout key].
 * Two rows are flagged ORDER-SENSITIVE: TrackDefinition.java builds `layouts` with
 * `Map.copyOf(...)`, whose iteration order is unspecified, and on repeated JVM runs those
 * inputs really did resolve differently ("ricard - 1A" came back as Layout 1A / Layout 1A-V2
 * / Layout 1A-V2-Short, "National" as National Circuit / International Circuit). The Node
 * port iterates tracks.json declaration order — what the Python backend does — so it is
 * deterministic and equals what a LinkedHashMap-backed Java registry would return.
 */
const JAVA_LAYOUT_GOLDENS: ReadonlyArray<readonly [string, string, string | null]> = [
  ['Paul Ricard', '1A', 'Layout 1A'],
  ['Paul Ricard', 'Layout-1A', 'Layout 1A'],
  ['Paul Ricard', 'layout 1a v2 short', 'Layout 1A-V2-Short'],
  ['Paul Ricard', 'PAUL RICARD - ELMS', 'Default'],
  ['Paul Ricard', 'ELMS', 'Default'],
  ['Paul Ricard', 'Paul Ricard - Unknown', 'Default'],
  ['Paul Ricard', '', null],
  ['Paul Ricard', '   ', null],
  ['Paul Ricard', '3A', 'Layout 3A'],
  ['Paul Ricard', 'Layout 3', 'Layout 3A'],
  ['Paul Ricard', '1A-V2', 'Layout 1A-V2'],
  ['Paul Ricard', 'ricard - 1A', 'Layout 1A'],
  ['Paul Ricard', 'Endurance', 'Default'],
  ['Paul Ricard', 'Circuit Paul Ricard', 'Default'],
  ['Paul Ricard', 'layout_layout_1a', 'Layout 1A'],
  ['Paul Ricard', 'Short', 'Layout 1A-V2-Short'],
  ['Paul Ricard', '1A_V2_SHORT', 'Layout 1A-V2-Short'],
  ['Silverstone', 'International', 'International Circuit'],
  ['Silverstone', 'National', 'International Circuit'],
  ['Silverstone', 'Grand Prix', 'Default'],
  ['Silverstone', 'Silverstone - International Circuit', 'International Circuit'],
  ['Silverstone', 'Silverstone - National Circuit', 'National Circuit'],
  ['Silverstone', 'Club', 'Default'],
  ['Silverstone', '', null],
  ['Silverstone', 'Intl', 'Default'],
  ['Circuit de La Sarthe', 'Mulsanne', 'Mulsanne Circuit'],
  ['Circuit de La Sarthe', 'Mulsanne Circuit', 'Mulsanne Circuit'],
  ['Circuit de La Sarthe', 'Test', 'Default'],
  ['Circuit de La Sarthe', 'Circuit de la Sarthe - Mulsanne Circuit', 'Mulsanne Circuit'],
  ['Circuit de La Sarthe', 'le mans - mulsanne', 'Default'],
  ['Circuit de La Sarthe', 'Bugatti', 'Default'],
  ['Bahrain International Circuit', 'Paddock', 'Paddock Circuit'],
  ['Bahrain International Circuit', 'Outer', 'Outer Circuit'],
  ['Bahrain International Circuit', 'Endurance', 'Endurance Circuit'],
  ['Bahrain International Circuit', 'Bahrain - Paddock Circuit', 'Paddock Circuit'],
  ['Bahrain International Circuit', 'Grand Prix', 'Default'],
  ['Bahrain International Circuit', 'International', 'Default'],
  ['Bahrain International Circuit', 'WEC', 'Default'],
  ['Sebring International Raceway', 'School', 'School Circuit'],
  ['Sebring International Raceway', 'Sebring - School Circuit', 'School Circuit'],
  ['Sebring International Raceway', 'Full', 'Default'],
  ['Sebring International Raceway', 'Raceway', 'Default'],
  ['Sebring International Raceway', 'Circuit', 'School Circuit'],
  ['Lusail International Circuit', 'Short', 'Short Circuit'],
  ['Lusail International Circuit', 'Lusail - Short Circuit', 'Short Circuit'],
  ['Lusail International Circuit', 'Grand Prix', 'Default'],
  ['Circuit of the Americas', 'National', 'National Circuit'],
  ['Circuit of the Americas', 'COTA - National Circuit', 'National Circuit'],
  ['Circuit of the Americas', 'Grand Prix', 'Default'],
  ['Circuit of the Americas', 'Full', 'Default'],
  ['Fuji Speedway', 'Classic', 'Classic Circuit'],
  ['Fuji Speedway', 'Fuji - Classic Circuit', 'Classic Circuit'],
  ['Fuji Speedway', 'Full', 'Default'],
  ['Autodromo Nazionale Monza', 'Curva Grande', 'Curva Grande Circuit'],
  ['Autodromo Nazionale Monza', 'Monza - Curva Grande Circuit', 'Curva Grande Circuit'],
  ['Autodromo Nazionale Monza', 'Full', 'Default'],
];

/**
 * [input, normalizeTrack, normalizeLayout, stripLeadingNonAlnum(normalizeLayout),
 *  isBlank, javaTrim(input) === ''] — straight from TrackNames.java, including Java's
 * whitespace rules (U+00A0 is not blank and not trimmed, U+001C is blank, U+2028 is not
 * matched by the ASCII `\s` the collapse step uses).
 */
const JAVA_NAME_GOLDENS: ReadonlyArray<readonly [string, string, string, string, boolean, boolean]> = [
  ['Aut\u00f6dromo Nazionale Monza', 'monza', 'autodromo nazionale monza', 'autodromo nazionale monza', false, false],
  ['Circuit de Spa-Francorchamps', 'spa francorchamps', 'circuit de spa francorchamps', 'circuit de spa francorchamps', false, false],
  ['  Autodromo\tNazionale\u00a0Monza  ', 'nazionale\u00a0monza', 'autodromo nazionale\u00a0monza', 'autodromo nazionale\u00a0monza', false, false],
  ['Sakurajima\u5c71\u53e3', 'sakurajima\u5c71\u53e3', 'sakurajima\u5c71\u53e3', 'sakurajima\u5c71\u53e3', false, false],
  ['\u4e01\u4e1e', '\u4e01\u4e1e', '\u4e01\u4e1e', '', false, false],
  ['ISL\u0130', 'isli', 'isli', 'isli', false, false],
  ['\u0130stanbul', 'istanbul', 'istanbul', 'istanbul', false, false],
  [' stra\u00dfe ', 'stra\u00dfe', 'stra\u00dfe', 'stra\u00dfe', false, false],
  ['\u2028circuit\u2029', '\u2028\u2029', '\u2028circuit\u2029', 'circuit\u2029', false, false],
  ['\u001cgp\u001d', '', 'gp', 'gp', false, false],
  ['\ud83d\ude80 rocket gp', '\ud83d\ude80 rocket', '\ud83d\ude80 rocket gp', 'rocket gp', false, false],
  ['Sakhir\t\n', 'sakhir', 'sakhir', 'sakhir', false, false],
  ['  \u00a0 ', '\u00a0', '\u00a0', '', false, false],
];

function trackKey(name: string): string {
  const found = registry.findTrack(name);
  expect(found, `track match for ${name}`).not.toBeNull();
  return found!.key;
}

/** Same shape as TrackMatcherTest.layout(): resolve the track first, then the layout. */
function layoutKey(trackName: string, rawLayout: string): string | null {
  const track = registry.findTrack(trackName);
  expect(track, `track match for ${trackName}`).not.toBeNull();
  const found = registry.findLayout(track!.definition, rawLayout, track!.key);
  return found === null ? null : found.key;
}

describe('TrackRegistry', () => {
  /** TrackMatcherTest.loadsRegistryCounts */
  it('loads the catalogue with the Java counts', () => {
    const tracks = registry.tracks();
    expect(tracks.size).toBe(18);
    let layouts = 0;
    let points = 0;
    for (const track of tracks.values()) {
      const values = Object.values(track.layouts);
      layouts += values.length;
      for (const layout of values) {
        points += layout.ref_points.length;
      }
    }
    expect(layouts).toBe(34);
    expect(points).toBe(469);
  });

  it('keeps tracks.json declaration order (TrackRegistry.java used LinkedHashMap too)', () => {
    expect([...registry.tracks().keys()]).toEqual([
      'Bahrain International Circuit',
      'Circuit de La Sarthe',
      'Paul Ricard',
      'Circuit of the Americas',
      'Fuji Speedway',
      'Autodromo Internazionale Enzo e Dino Ferrari',
      'Autodromo Jose Carlos Pace',
      'Lusail International Circuit',
      'Autodromo Nazionale Monza',
      'Algarve International Circuit',
      'Sebring International Raceway',
      'Silverstone',
      'Circuit de Spa-Francorchamps',
      'Circuit de Barcelona',
      'WeatherTech Raceway Laguna Seca',
      'Daytona International Speedway',
      'Grand Prix of Long Beach',
      'Michelin Raceway Road Atlanta',
    ]);
  });

  it('normalises a layout that declares no aliases instead of blowing up', () => {
    // Spa's "Endurance Circuit" has no `aliases` array in tracks.json; the Java record
    // turned that into an empty list, so the matchers must still see a string[].
    const spa = registry.tracks().get('Circuit de Spa-Francorchamps')!;
    expect(spa.layouts['Endurance Circuit'].aliases).toEqual([]);
  });
});

describe('TrackMatcher', () => {
  /** TrackMatcherTest.matchesKnownTracksAndAliases */
  it('matches known tracks and their declared aliases', () => {
    for (const [name, expected] of KNOWN_TRACK_LOOKUPS) {
      expect(trackKey(name), name).toBe(expected);
    }
  });

  it('reproduces Java for every probed game spelling', () => {
    for (const [name, expected] of JAVA_TRACK_GOLDENS) {
      const found = registry.findTrack(name);
      expect(found === null ? null : found.key, name).toBe(expected);
    }
  });

  it('short-circuits the way TrackMatcher.java does', () => {
    const tracks = registry.tracks();
    expect(matchTrack(null, tracks)).toBeNull();
    expect(matchTrack('', tracks)).toBeNull();
    expect(matchTrack('   ', tracks)).toBeNull();
    expect(matchTrack('\t\n', tracks)).toBeNull();
    expect(matchTrack('Monza', new Map<string, TrackDefinition>())).toBeNull();
  });

  it('lets the similarity sweep pick the candidate that clears the 0.6 floor', () => {
    const found = matchTrack('Monda', registry.tracks());
    expect(found?.key).toBe('Autodromo Nazionale Monza');
    expect(found?.definition.display_name).toBe('Monza');
    expect(matchTrack('zzzzzzzzzz', registry.tracks())).toBeNull();
  });
});

describe('LayoutMatcher', () => {
  /** TrackMatcherTest.matchesLayouts */
  it('resolves the Paul Ricard layouts the game writes', () => {
    for (const [rawLayout, expected] of PAUL_RICARD_LAYOUTS) {
      expect(layoutKey('Paul Ricard', rawLayout), rawLayout).toBe(expected);
    }
  });

  it('reproduces Java across every track/layout probe', () => {
    for (const [trackName, rawLayout, expected] of JAVA_LAYOUT_GOLDENS) {
      expect(layoutKey(trackName, rawLayout), `${trackName} / ${rawLayout}`).toBe(expected);
    }
  });

  it('short-circuits the way LayoutMatcher.java does', () => {
    const track = registry.tracks().get('Paul Ricard')!;
    expect(matchLayout(null, '1A', 'Paul Ricard')).toBeNull();
    expect(matchLayout(undefined, '1A', 'Paul Ricard')).toBeNull();
    expect(matchLayout(track, null, 'Paul Ricard')).toBeNull();
    expect(matchLayout(track, '', 'Paul Ricard')).toBeNull();
    expect(matchLayout(track, '   ', 'Paul Ricard')).toBeNull();

    const empty = matchLayout({ display_name: 'X', aliases: [], country: 'Y', layouts: {} }, '1A', 'X');
    expect(empty).toBeNull();

    // No "Default" declared and nothing matches -> null rather than a guessed layout.
    const noDefault: TrackDefinition = {
      display_name: 'Odd',
      aliases: [],
      country: 'Z',
      layouts: { 'Only Layout': { aliases: [], ref_points: [] } },
    };
    expect(matchLayout(noDefault, 'Totally Different', 'Odd')).toBeNull();
    expect(matchLayout(noDefault, 'only layout', 'Odd')?.key).toBe('Only Layout');
  });

  it('returns the TrackLayout object it matched, not just the key', () => {
    const track = registry.tracks().get('Paul Ricard')!;
    const found = registry.findLayout(track, 'Paul Ricard - 1A-V2', 'Paul Ricard');
    expect(found?.key).toBe('Layout 1A-V2');
    expect(found?.layout).toBe(track.layouts['Layout 1A-V2']);
    expect(found?.layout.aliases).toEqual(['Paul Ricard - 1A-V2']);
  });
});

describe('TrackNames', () => {
  it('reproduces Java normalisation, blank detection and trimming', () => {
    for (const [input, track, layout, stripped, blank, trimmedEmpty] of JAVA_NAME_GOLDENS) {
      expect(normalizeTrack(input), `normalizeTrack ${input}`).toBe(track);
      expect(normalizeLayout(input), `normalizeLayout ${input}`).toBe(layout);
      expect(stripLeadingNonAlnum(normalizeLayout(input)), `stripLeading ${input}`).toBe(stripped);
      expect(isBlank(input), `isBlank ${input}`).toBe(blank);
      expect(javaTrim(input) === '', `javaTrim ${input}`).toBe(trimmedEmpty);
    }
  });

  it('treats only ASCII runs as whitespace and only ASCII as word characters', () => {
    // Java's regex \s is [ \t\n\x0B\f\r]; \b is ASCII-based. U+00A0 survives both.
    expect(normalizeTrack('a\u00a0b')).toBe('a\u00a0b');
    expect(normalizeTrack('a\u2003b')).toBe('a\u2003b');
    expect(normalizeTrack('a \t\n b')).toBe('a b');
    expect(isBlank('\u00a0')).toBe(false);
    expect(isBlank('\u001c\u001d\u001e\u001f \t\n\v\f\r')).toBe(true);
    expect(isBlank('')).toBe(true);
  });

  it('strips the noise words TrackNames.COMMON_NOISE declares, and only those', () => {
    expect(normalizeTrack('Autodromo Nazionale Monza')).toBe('monza');
    expect(normalizeTrack('Circuit de la Sarthe')).toBe('sarthe');
    expect(normalizeTrack('Bahrain International Circuit')).toBe('bahrain');
    expect(normalizeTrack('Grand Prix of Long Beach')).toBe('of long beach');
    expect(normalizeLayout('Bahrain International Circuit')).toBe('bahrain international circuit');
    expect(normalizeTrack(null)).toBe('');
    expect(normalizeLayout(null)).toBe('');
  });
});
