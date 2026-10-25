import { describe, expect, it } from 'vitest';
import { CarCatalog } from '../../../src/infra/car/car-catalog.js';

/**
 * Ported from backend-java/src/test/java/com/lmutl/infra/car/CarCatalogTest.java, plus
 * golden tables captured from the compiled CarCatalog.class (every row is Java's answer;
 * the class argument is part of the row).
 */
const catalog = new CarCatalog();

/** [carNameMeta, carClassMeta, modelName, category, steeringLock] — probed with 'LMGT3'. */
const JAVA_CAR_GOLDENS: ReadonlyArray<readonly [string, string, string, string, number]> = [
  ['Aston Martin Vantage AMR GT3 EVO', 'LMGT3', 'Aston Martin Vantage Amr GT3 Evo', 'LMGT3', 540],
  ['Aston Martin Racing', 'LMGT3', 'Aston Martin Racing', 'LMGT3', 540],
  ['Porsche 911 GT3 R (992) Manthey EMA', 'LMGT3', 'Porsche 911 GT3 R (992)', 'LMGT3', 540],
  ['Corvette Z06 GT3.R TF Sport', 'LMGT3', 'Corvette Z06 GT3.R', 'LMGT3', 540],
  ['BMW M4 GT3 #46', 'LMGT3', 'BMW M4 GT3 #46', 'LMGT3', 540],
  ['Ferrari 296 LMGT3', 'LMGT3', 'Ferrari 296 Lmgt3', 'LMGT3', 540],
  ['McLaren 720S GT3 EVO', 'LMGT3', 'Mclaren 720S GT3 Evo', 'LMGT3', 540],
  ['Mercedes AMG GT3 EVO', 'LMGT3', 'Mercedes AMG GT3 Evo', 'LMGT3', 540],
  ['Lamborghini Huracan GT3 EVO2', 'LMGT3', 'Lamborghini Huracan GT3 Evo2', 'LMGT3', 540],
  ['Ford Mustang GT3', 'LMGT3', 'Ford Mustang GT3', 'LMGT3', 540],
  ['Maserati MC20 GT2', 'LMGT3', 'Maserati Mc20 Gt2', 'LMGT3', 540],
  ['Alpine A110 GT4', 'LMGT3', 'Alpine A110 Gt4', 'LMGT3', 540],
  ['Audi R8 LMS GT3 EVO II', 'LMGT3', 'Audi R8 Lms GT3 Evo Ii', 'LMGT3', 540],
  ['Bentley Continental GT3', 'LMGT3', 'Bentley Continental GT3', 'LMGT3', 540],
  ['Chevrolet Camaro GT4.R', 'LMGT3', 'Chevrolet Camaro Gt4.R', 'LMGT3', 540],
  ['Ginetta G56', 'LMGT3', 'Ginetta G56', 'LMGT3', 540],
  ['KTM X-BOW GT-XR', 'LMGT3', 'Ktm X-Bow Gt-Xr', 'LMGT3', 540],
  ['Nissan GT-R Nismo GT3', 'LMGT3', 'Nissan Gt-R Nismo GT3', 'LMGT3', 540],
  ['Toyota GR Supra GT4', 'LMGT3', 'Toyota Gr Supra Gt4', 'LMGT3', 540],
  ['Pagani Zonda', 'LMGT3', 'Pagani Zonda', 'LMGT3', 540],
  ['Oreca 07', 'LMGT3', 'Oreca 07 Gibson', 'LMP2', 480],
  ['Ligier JS P217', 'LMGT3', 'Ligier Js P217', 'LMGT3', 540],
  ['Dallara P217', 'LMGT3', 'Dallara P217', 'LMGT3', 540],
  ['Cadillac V-SeriesR', 'LMGT3', 'Cadillac V-Series.R', 'Hypercar', 480],
  ['Peugeot 9X8', 'LMGT3', 'Peugeot 9X8', 'Hypercar', 480],
  ['Vanwall Vandervell 680', 'LMGT3', 'Vanwall Vandervell 680', 'LMGT3', 540],
  ['Chaparral 2D', 'LMGT3', 'Chaparral 2D', 'LMGT3', 540],
  ['Glickenhaus 007 LMH', 'LMGT3', 'Glickenhaus 007 LMH', 'LMGT3', 540],
  ['ARCFOXRod', 'LMGT3', 'Arcfoxrod', 'LMGT3', 540],
  ['gt3', 'LMGT3', 'GT3', 'LMGT3', 540],
  ['LMP2:', 'LMGT3', 'Lmp2:', 'LMGT3', 540],
  ['Porsche_963', 'LMGT3', 'Porsche 963', 'LMGT3', 540],
  ['hypercar', 'LMGT3', 'Hypercar', 'LMGT3', 540],
  ['  United   Autosports  ', 'LMGT3', 'United   Autosports', 'LMGT3', 540],
  ['SCORPION LMGT3', 'LMGT3', 'Scorpion Lmgt3', 'LMGT3', 540],
  ['VISTA AF Corse', 'LMGT3', 'Vista Af Corse', 'LMGT3', 540],
  ['Heart of Racing', 'LMGT3', 'Heart Of Racing', 'LMGT3', 540],
  ['AF Corse', 'LMGT3', 'Af Corse', 'LMGT3', 540],
  ['TF SPORT', 'LMGT3', 'Corvette Z06 GT3.R', 'LMGT3', 540],
  ['Manthey PureRxcing', 'LMGT3', 'Porsche 911 GT3 R (992)', 'LMGT3', 540],
  ['Iron Dames', 'LMGT3', 'Porsche 911 GT3 R (992)', 'LMGT3', 540],
  ["D'Station Racing", 'LMGT3', 'Aston Martin Vantage AMR GT3 Evo', 'LMGT3', 540],
  ['Kessel Racing', 'LMGT3', 'Kessel Racing', 'LMGT3', 540],
  ['STR Performance', 'LMGT3', 'Str Performance', 'LMGT3', 540],
];

/**
 * Non-ASCII rows from CarCatalog.class: they pin the Java per-char
 * Character.toUpperCase/toLowerCase semantics that a plain JS toUpperCase would change
 * ('ss' stays 'ss', 'I' + combining dot is rebuilt from the already lowercased text).
 */
const JAVA_CAR_UNICODE_GOLDENS: ReadonlyArray<readonly [string, string]> = [
  ['Aut\u00f6dromo Racing', 'Aut\u00f6dromo Racing'],
  ['Stra\u00dfe Motorsport', 'Stra\u00dfe Motorsport'],
  ['\u0130stanbul Speed', 'I\u0307Stanbul Speed'],
  ['\ud83d\ude80 Rocket Racing', '\ud83d\ude80 Rocket Racing'],
  ['team\u00a1x', 'Team\u00a1X'],
  ['\u2028gt3\u2029', '\u2028GT3\u2029'],
  ['gt3 evo', 'GT3 Evo'],
  ['LMDh:2024', 'LMDh'],
];

const JAVA_STEER_LOCK_GOLDENS: ReadonlyArray<readonly [string, number | null]> = [
  ['524deg (18.5deg)', 524],
  ['18.5deg', 18],
  ['18.5', 18],
  ['  ', null],
  ['abc', null],
  ['-42', 42],
  ['2147483647', 2147483647],
  ['540', 540],
  ['\u00a0', null],
  ['\u2028', null],
  ['\u001c', null],
  ['\t', null],
  ['18\u00b0', 18],
  ['\uff11\uff12', null],
];

/**
 * [carNameMeta, carClassMeta, overrideSteerLock, modelName, category, steeringLock] — captured
 * from CarCatalog.getCarInfo(String, String, Integer). Both shapes are covered: seeded-mapping
 * hits (the override still replaces the seed lock) and the title-cased fallback.
 */
const JAVA_CAR_OVERRIDE_GOLDENS: ReadonlyArray<
  readonly [string, string, number | null, string, string, number]
> = [
  ['United Autosports', 'LMGT3', 400, 'McLaren 720S GT3 Evo', 'LMGT3', 400],
  ['manthey', 'LMGT3', 400, 'Porsche 911 GT3 R (992)', 'LMGT3', 400],
  ['Team Manthey', 'LMGT3', 0, 'Porsche 911 GT3 R (992)', 'LMGT3', 0],
  ['Porsche 911 GT3 R (992) Manthey EMA', 'Hypercar', -5, 'Porsche 911 GT3 R (992)', 'LMGT3', -5],
  ['Iron Dames', '', 400, 'Porsche 911 GT3 R (992)', 'LMGT3', 400],
  ["D'Station Racing", 'LMGT3', 2147483647, 'Aston Martin Vantage AMR GT3 Evo', 'LMGT3', 2147483647],
  ['TF SPORT', 'LMP2', 400, 'Corvette Z06 GT3.R', 'LMGT3', 400],
  ['akkodis racing', 'LMGT3', 380, 'Lexus RC F GT3', 'LMGT3', 380],
  ['Toyota Gazoo Racing', 'Hypercar', 0, 'Toyota GR010 Hybrid', 'Hypercar', 0],
  ['porsche penske', 'Hypercar', null, 'Porsche 963', 'Hypercar', 480],
  ['Cadillac V-SeriesR', 'Hypercar', null, 'Cadillac V-Series.R', 'Hypercar', 480],
  ['Peugeot 9X8', 'Hypercar', 480, 'Peugeot 9X8', 'Hypercar', 480],
  ['alpine endurance', 'LMP2', 400, 'Alpine A424', 'Hypercar', 400],
  ['Oreca 07', 'LMP2', null, 'Oreca 07 Gibson', 'LMP2', 480],
  ['oreca', 'gt3', 1, 'Oreca 07 Gibson', 'LMP2', 1],
  ['Ferrari 499P #50', 'Hypercar', 400, 'Ferrari 499P #50', 'Hypercar', 400],
  ['Ferrari 499P', 'Hypercar', null, 'Ferrari 499P', 'Hypercar', 540],
  ['', 'LMGT3', 400, '', 'LMGT3', 400],
  ['Kessel Racing', 'LMGT3', null, 'Kessel Racing', 'LMGT3', 540],
  [':999', 'Hypercar', 400, '', 'Hypercar', 400],
  ['BMW M Hybrid V8:EC', 'Hypercar', 400, 'BMW M Hybrid V8', 'Hypercar', 400],
  ['Porsche_963', 'LMGT3', 400, 'Porsche 963', 'LMGT3', 400],
  ['  United   Autosports  ', 'Hypercar', 400, 'United   Autosports', 'Hypercar', 400],
  ['gt3', 'Hypercar', 400, 'GT3', 'Hypercar', 400],
  ['Maserati MC20 GT2', 'LMGT3', 400, 'Maserati Mc20 Gt2', 'LMGT3', 400],
  ['Heart of Racing', 'LMGT3', 400, 'Heart Of Racing', 'LMGT3', 400],
  ['VISTA AF Corse', 'LMGT3', 400, 'Vista Af Corse', 'LMGT3', 400],
  ['SCORPION LMGT3', 'LMGT3', 400, 'Scorpion Lmgt3', 'LMGT3', 400],
  ['Ligier JS P217', 'LMP2', 400, 'Ligier Js P217', 'LMP2', 400],
  ['Dallara P217', 'LMP2', null, 'Dallara P217', 'LMP2', 540],
  ['Aston Martin Vantage AMR GT3 EVO', 'LMGT3', 400, 'Aston Martin Vantage Amr GT3 Evo', 'LMGT3', 400],
  ['Mercedes AMG GT3 EVO', 'LMGT3', -1, 'Mercedes AMG GT3 Evo', 'LMGT3', -1],
  ['Nissan GT-R Nismo GT3', 'LMGT3', null, 'Nissan Gt-R Nismo GT3', 'LMGT3', 540],
];

describe('CarCatalog', () => {
  /** CarCatalogTest.matchesStandardTeams */
  it('matches standard teams', () => {
    expect(catalog.getCarInfo('United Autosports', 'LMGT3').modelName).toBe('McLaren 720S GT3 Evo');
    expect(catalog.getCarInfo('United Autosports', 'LMGT3').steeringLock).toBe(540);
    expect(catalog.getCarInfo('Toyota Gazoo Racing', 'Hypercar').modelName).toBe('Toyota GR010 Hybrid');
    expect(catalog.getCarInfo('Toyota Gazoo Racing', 'Hypercar').steeringLock).toBe(480);
  });

  /** CarCatalogTest.fallsBackToTitleCasedNameWithoutCsv */
  it('falls back to the title-cased name when there is no CSV', () => {
    expect(catalog.getCarInfo('Ferrari 499P #50', 'Hypercar').modelName).toBe('Ferrari 499P #50');
    expect(catalog.getCarInfo('mclaren_720s_gt3_evo', 'LMGT3').modelName).toBe('Mclaren 720S GT3 Evo');
    expect(catalog.getCarInfo('BMW M Hybrid V8:EC', 'Hypercar').modelName).toBe('BMW M Hybrid V8');
    expect(catalog.getCarInfo('', 'LMGT3').modelName).toBe('');
  });

  /** CarCatalogTest.parsesSteeringLock */
  it('parses the steering lock', () => {
    expect(catalog.parseSteerLock('524deg (18.5deg)')).toBe(524);
    expect(catalog.parseSteerLock('')).toBeNull();
    expect(catalog.parseSteerLock(null)).toBeNull();
  });

  it('reproduces Java for every probed car name', () => {
    for (const [name, carClass, modelName, category, steeringLock] of JAVA_CAR_GOLDENS) {
      const spec = catalog.getCarInfo(name, carClass);
      expect([spec.modelName, spec.category, spec.steeringLock], name).toEqual([
        modelName,
        category,
        steeringLock,
      ]);
    }
  });

  it('reproduces Java for accented, ligature and non-BMP names', () => {
    for (const [name, modelName] of JAVA_CAR_UNICODE_GOLDENS) {
      expect(catalog.getCarInfo(name, 'Hypercar').modelName, name).toBe(modelName);
    }
  });

  it('maps a null class to an empty string like Java does', () => {
    expect(catalog.getCarInfo('Kessel Racing', null).category).toBe('');
    expect(catalog.getCarInfo(null, null)).toEqual({
      modelName: '',
      category: '',
      steeringLock: 540,
    });
  });

  it('reproduces the three-argument overload, including mapping hits', () => {
    // CarCatalog.java:59-65 resolves the car with the two-argument overload and only then
    // replaces the steering lock, so even a seeded-mapping hit gets the override (this is the
    // form LapService.java:183 calls).
    for (const [name, carClass, override, modelName, category, steeringLock] of JAVA_CAR_OVERRIDE_GOLDENS) {
      const spec = catalog.getCarInfo(name, carClass, override);
      expect([spec.modelName, spec.category, spec.steeringLock], `${name}|${carClass}|${override}`).toEqual([
        modelName,
        category,
        steeringLock,
      ]);
    }
  });

  it('returns the same object identity for a mapping hit, as Java did', () => {
    expect(catalog.getCarInfo('manthey', 'LMGT3')).toBe(catalog.getCarInfo('Team Manthey', 'LMGT3'));
  });

  it('parses steer-lock strings exactly like Java', () => {
    for (const [value, expected] of JAVA_STEER_LOCK_GOLDENS) {
      expect(catalog.parseSteerLock(value), value).toBe(expected);
    }
  });

  it('rejects out-of-int-range digits, like Integer.parseInt does', () => {
    // Java: NumberFormatException. The Node port throws too, so a nonsense telemetry
    // value cannot silently become a double the UI then renders.
    expect(() => catalog.parseSteerLock('2147483648')).toThrow(Error);
    expect(() => catalog.parseSteerLock('99999999999999')).toThrow(/NumberFormatException/);
  });
});
