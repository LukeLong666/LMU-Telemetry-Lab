/**
 * Ports CarCatalog.java — car lookup seeded with the standard team/car mapping from
 * the Python backend. Like the Java version there is no CSV layer wired in: the
 * title-cased fallback below IS the current behaviour (CarCatalogTest's
 * `fallsBackToTitleCasedNameWithoutCsv`), and a CSV can be layered in later without
 * changing callers.
 *
 * Java -> JS details that were checked one by one:
 * - `Pattern(":\\w+")` / `Pattern("(\\d+)")`: `\w` and `\d` are ASCII-only in Java's
 *   default regex mode, which is also what JS `\w`/`\d` mean.
 * - `Matcher.replaceAll("")` replaces every match -> `/…/g` + replaceAll.
 * - `String.replace(CharSequence, CharSequence)` replaces every occurrence too, so the
 *   abbreviation fix-ups and `_` -> ' ' use `replaceAll`, not `replace`.
 * - `String.trim()` -> javaTrim (code units <= U+0020), `String.isBlank()` -> isBlank
 *   (Java's whitespace set, which excludes U+00A0).
 * - `toLowerCase(Locale.ROOT)` -> `toLowerCase()` (both locale-independent).
 */
import { isBlank, javaTrim } from '../track/track-names.js';

/** `\\w` as Java defines it (ASCII alphanumeric + underscore). */
const TECHNICAL_SUFFIX = /:[a-zA-Z0-9_]+/g;
const FIRST_NUMBER = /(\d+)/;

export interface CarSpec {
  readonly modelName: string;
  readonly category: string;
  readonly steeringLock: number;
}

export class CarCatalog {
  private readonly standardMapping = new Map<string, CarSpec>();

  constructor() {
    this.standardMapping.set('united autosports', {
      modelName: 'McLaren 720S GT3 Evo',
      category: 'LMGT3',
      steeringLock: 540,
    });
    this.standardMapping.set('manthey', {
      modelName: 'Porsche 911 GT3 R (992)',
      category: 'LMGT3',
      steeringLock: 540,
    });
    this.standardMapping.set('iron dames', {
      modelName: 'Porsche 911 GT3 R (992)',
      category: 'LMGT3',
      steeringLock: 540,
    });
    this.standardMapping.set("d'station", {
      modelName: 'Aston Martin Vantage AMR GT3 Evo',
      category: 'LMGT3',
      steeringLock: 540,
    });
    this.standardMapping.set('tf sport', {
      modelName: 'Corvette Z06 GT3.R',
      category: 'LMGT3',
      steeringLock: 540,
    });
    this.standardMapping.set('akkodis', {
      modelName: 'Lexus RC F GT3',
      category: 'LMGT3',
      steeringLock: 540,
    });
    this.standardMapping.set('toyota gazoo', {
      modelName: 'Toyota GR010 Hybrid',
      category: 'Hypercar',
      steeringLock: 480,
    });
    this.standardMapping.set('porsche penske', {
      modelName: 'Porsche 963',
      category: 'Hypercar',
      steeringLock: 480,
    });
    this.standardMapping.set('cadillac', {
      modelName: 'Cadillac V-Series.R',
      category: 'Hypercar',
      steeringLock: 480,
    });
    this.standardMapping.set('peugeot', {
      modelName: 'Peugeot 9X8',
      category: 'Hypercar',
      steeringLock: 480,
    });
    this.standardMapping.set('alpine endurance', {
      modelName: 'Alpine A424',
      category: 'Hypercar',
      steeringLock: 480,
    });
    this.standardMapping.set('oreca', {
      modelName: 'Oreca 07 Gibson',
      category: 'LMP2',
      steeringLock: 480,
    });
  }

  /**
   * Java had two overloads: `getCarInfo(name, cls)` (CarCatalog.java:38-57) and
   * `getCarInfo(name, cls, Integer overrideSteerLock)` (CarCatalog.java:59-65); the optional
   * third argument covers both call shapes. The Java three-argument form resolves the car with
   * the two-argument one FIRST and only then replaces the steering lock, so the override also
   * applies to seeded-mapping hits — which is what LapService.java:183 relies on.
   */
  getCarInfo(carNameMeta: string | null, carClassMeta: string | null, overrideSteerLock?: number | null): CarSpec {
    const spec = this.resolveCarInfo(carNameMeta, carClassMeta);
    if (overrideSteerLock === null || overrideSteerLock === undefined) {
      return spec;
    }
    return {
      modelName: spec.modelName,
      category: spec.category,
      steeringLock: overrideSteerLock,
    };
  }

  private resolveCarInfo(carNameMeta: string | null, carClassMeta: string | null): CarSpec {
    const carName = cleanTechnicalSuffixes(
      carNameMeta === null || carNameMeta === undefined ? '' : carNameMeta,
    );
    const clean = javaTrim(carName.toLowerCase());

    for (const [key, spec] of this.standardMapping) {
      if (clean.includes(key)) {
        return spec;
      }
    }

    let name = titleCase(clean.replaceAll('_', ' '));
    // `.replaceAll('F1', 'F1')` is a no-op in Java too; kept so the chain stays 1:1.
    name = name
      .replaceAll('Gt3', 'GT3')
      .replaceAll('Gte', 'GTE')
      .replaceAll('Bmw', 'BMW')
      .replaceAll('Amg', 'AMG')
      .replaceAll('Lmh', 'LMH')
      .replaceAll('Lmdh', 'LMDh')
      .replaceAll('F1', 'F1');
    return {
      modelName: name,
      category: carClassMeta === null || carClassMeta === undefined ? '' : carClassMeta,
      steeringLock: 540,
    };
  }

  /** First integer in the raw steer-lock string, or null when there is none. */
  parseSteerLock(value: string | null): number | null {
    if (value === null || value === undefined || isBlank(value)) {
      return null;
    }
    const match = FIRST_NUMBER.exec(value);
    if (match === null) {
      return null;
    }
    const digits = match[1];
    const parsed = Number.parseInt(digits, 10);
    // Integer.parseInt() rejects anything outside the signed 32-bit range; keep that
    // contract instead of silently widening to a JS double.
    if (!Number.isInteger(parsed) || parsed < -2147483648 || parsed > 2147483647) {
      throw new Error(`NumberFormatException: For input string: "${digits}"`);
    }
    return parsed;
  }
}

function cleanTechnicalSuffixes(value: string): string {
  return javaTrim(value.replace(TECHNICAL_SUFFIX, ''));
}

function titleCase(value: string): string {
  let result = '';
  let capitalizeNext = true;
  // Loop over UTF-16 code units, exactly like Java's `charAt(i)` loop: a surrogate pair
  // fails `Character.isLetter` unit by unit and is appended unchanged.
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    if (isJavaLetter(ch)) {
      result += capitalizeNext ? toUpperCaseChar(ch) : toLowerCaseChar(ch);
      capitalizeNext = false;
    } else {
      result += ch;
      capitalizeNext = true;
    }
  }
  return result;
}

/** Character.isLetter(char) — category Lu/Ll/Lt/Lm/Lo, which `\p{L}` covers. */
function isJavaLetter(ch: string): boolean {
  return /\p{L}/u.test(ch);
}

/**
 * Character.toUpperCase(char) is a 1:1 mapping: when JS applies a full (1:n) mapping
 * instead — 'ss' -> 'SS' — Java leaves the char untouched, so drop the expansion.
 */
function toUpperCaseChar(ch: string): string {
  const upper = ch.toUpperCase();
  return upper.length === 1 ? upper : ch;
}

/** Same guard for Character.toLowerCase(char) (only U+0130 expands in practice). */
function toLowerCaseChar(ch: string): string {
  const lower = ch.toLowerCase();
  return lower.length === 1 ? lower : ch;
}
