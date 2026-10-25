import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

/**
 * Fixture databases for the vehicle-setup chain.
 *
 * `SetupService.java` and `SvmExporter.java` only ever touch one table - their SQL is
 * `SELECT key, value FROM metadata` (MetadataReader.java). The `Setup` table that the
 * name suggests belongs to the telemetry/fusion chain and is deliberately not created
 * here, so nothing in this fixture depends on the fusion port.
 *
 * The CarSetup blob below is written as raw JSON text (not `JSON.stringify`) because the
 * literal form is what Java's Jackson parser types and renders: `1.0` becomes a double
 * printed as `1.0`, `100` an integer printed as `100`, `1e2` a double printed as `100.0`,
 * `2.665000` a double printed as `2.665`. Every entry therefore pins one formatting
 * case: integral, trailing-zero float, exponent literal, negative, zero, `-0.0`, the
 * plain/scientific boundaries at 10^-3 and 10^7, values beyond 2^53, non-numeric value
 * nodes (bool/string/array/object), a null value, a missing `stringValue`, blank and
 * `N/A` stringValues, `available` false/missing/non-boolean, and non-ASCII text.
 */
export const CAR_SETUP_JSON = `{
 "VM_WEIGHT_WEDGE": {"available": true, "value": 3, "stringValue": "3 clicks"},
 "VM_FUEL_LEVEL": {"available": true, "value": 78.5, "stringValue": "78.50 l"},
 "VM_FUEL_CAPACITY": {"available": true, "value": 1.0, "stringValue": "110.00 l"},
 "VM_VIRTUAL_ENERGY": {"available": true, "value": 100, "stringValue": "100"},
 "VM_NUM_PITSTOPS": {"available": true, "value": 2.665000, "stringValue": "2.665"},
 "VM_PITSTOP_1": {"available": true, "value": 10000000.0, "stringValue": "10000000.0"},
 "VM_PITSTOP_2": {"available": true, "value": 0.0001, "stringValue": "0.0001"},
 "VM_PITSTOP_3": {"available": true, "value": null, "stringValue": "null value"},
 "VM_LEFT_FENDER_FLARE": {"available": false, "value": 1, "stringValue": "Off"},
 "VM_RIGHT_FENDER_FLARE": {"available": true, "value": -0.0, "stringValue": "-0"},
 "VM_FRONT_WING": {"available": true, "value": 12, "stringValue": "12"},
 "VM_REAR_WING": {"available": true, "value": 7.500000, "stringValue": "7.5"},
 "VM_WATER_RADIATOR": {"available": true, "value": 1e2, "stringValue": "100.0"},
 "VM_OIL_RADIATOR": {"available": true, "value": 9007199254740993, "stringValue": "2^53+1"},
 "VM_BRAKE_DUCTS": {"available": true, "value": 12345678901234567890, "stringValue": "big int"},
 "VM_BRAKE_DUCTS_REAR": {"available": "true", "value": 2, "stringValue": "2"},
 "VM_FRONT_WHEEL_TRACK": {"available": true, "value": 1.5, "stringValue": "1.500 mm"},
 "VM_REAR_WHEEL_TRACK": {"available": true, "value": 0.500000, "stringValue": "0.5"},
 "VM_FRONT_ANTISWAY": {"available": true, "value": 30, "stringValue": "30 N/mm"},
 "VM_REAR_ANTISWAY": {"available": 0, "value": 40, "stringValue": "40 N/mm"},
 "VM_FRONT_TOEIN": {"available": true, "value": 0, "stringValue": "0.00"},
 "VM_FRONT_TOEOFFSET": {"available": true, "value": 0.0, "stringValue": "0.00"},
 "VM_REAR_TOEIN": {"available": true, "value": 0.0625},
 "VM_REAR_TOEOFFSET": {"available": true, "value": 0.001, "stringValue": "0.001"},
 "VM_LEFT_CASTER": {"available": true, "value": true, "stringValue": "12.50 deg"},
 "VM_RIGHT_CASTER": {"available": true, "value": "abc", "stringValue": "12.50 deg"},
 "VM_LEFT_TRACK_BAR": {"available": true, "value": [1.0, 2], "stringValue": "array"},
 "VM_RIGHT_TRACK_BAR": {"available": true, "value": {"a": 1.0, "b": 2}, "stringValue": "object"},
 "VM_FRONT_3RD_PACKERS": {"available": true, "value": 2.675, "stringValue": "2.675"},
 "VM_FRONT_3RD_SPRING": {"available": true, "value": 45000.0, "stringValue": "45000.0"},
 "VM_FRONT_3RD_TENDERSPRING": {"available": true, "value": 123456789.0, "stringValue": "big"},
 "VM_FRONT_3RD_TENDERSPRINGTRAVEL": {"available": true, "value": 0.0009999, "stringValue": "tiny"},
 "VM_FRONT_3RD_SLOWBUMP": {"available": true, "value": 10, "stringValue": "1"},
 "VM_FRONT_3RD_FASTBUMP": {"available": true, "value": 20, "stringValue": "2"},
 "VM_FRONT_3RD_SLOWREBOUND": {"available": true, "value": 30, "stringValue": "3"},
 "VM_FRONT_3RD_FASTREBOUND": {"available": true, "value": 40.0, "stringValue": "4"},
 "VM_REAR_3RD_PACKERS": {"available": true, "value": -3.75, "stringValue": "-3.75"},
 "VM_REAR_3RD_SPRING": {"available": true, "value": 52000.0, "stringValue": "52000.0"},
 "VM_REAR_3RD_TENDERSPRING": {"available": true, "value": 1.0000001, "stringValue": "1.0000001"},
 "VM_REAR_3RD_TENDERSPRINGTRAVEL": {"available": true, "value": 0.1, "stringValue": "0.1"},
 "VM_REAR_3RD_SLOWBUMP": {"available": true, "value": 11, "stringValue": "11"},
 "VM_REAR_3RD_FASTBUMP": {"available": true, "value": 21, "stringValue": "21"},
 "VM_REAR_3RD_SLOWREBOUND": {"available": true, "value": 31, "stringValue": "31"},
 "VM_REAR_3RD_FASTREBOUND": {"available": true, "value": 41, "stringValue": "41"},
 "VM_CHASSIS_ADJ_00": {"available": true, "value": 5, "stringValue": "5"},
 "VM_CHASSIS_ADJ_03": {"available": true, "value": 0.5, "stringValue": "0.50"},
 "VM_CHASSIS_ADJ_11": {"available": true, "value": 1.0, "stringValue": "1.0"},
 "VM_STEER_LOCK": {"available": true, "value": 450.0, "stringValue": "450\u00b0"},
 "VM_BRAKE_BALANCE": {"available": true, "value": 0.5625, "stringValue": "56.25 %"},
 "VM_BRAKE_MIGRATION": {"available": true, "value": 1.7976931348623157E308, "stringValue": "max"},
 "VM_BRAKE_PRESSURE": {"available": true, "value": 100.0, "stringValue": "100.0 %"},
 "VM_HANDBRAKE_PRESSURE": {"available": true, "value": 1.0E7, "stringValue": "1.0E7"},
 "VM_TRACTION_CONTROL": {"available": true, "value": 9, "stringValue": "9"},
 "VM_ANTILOCK_BRAKES": {"available": true, "value": 8.0, "stringValue": "8"},
 "VM_TRACTIONCONTROLMAP": {"available": true, "value": false, "stringValue": "1"},
 "VM_TRACTIONCONTROLPOWERCUTMAP": {"available": true, "value": 2, "stringValue": "N/A"},
 "VM_TRACTIONCONTROLSLIPANGLEMAP": {"available": true, "value": 3, "stringValue": "   "},
 "VM_ANTILOCKBRAKESYSTEMMAP": {"available": true, "value": 4, "stringValue": "4"},
 "VM_REV_LIMITER": {"available": true, "value": 9500, "stringValue": "9500 rpm"},
 "VM_ENGINE_BOOST": {"available": true, "value": 1.420000, "stringValue": "1.42 bar"},
 "VM_REGEN_LEVEL": {"available": true, "value": 3},
 "VM_ELECTRIC_MOTOR_MAP": {"available": true, "value": "3 clicks", "stringValue": "Tier 3"},
 "VM_ENGINE_MIXTURE": {"available": true, "value": 1, "stringValue": "   "},
 "VM_ENGINE_BRAKEMAP": {"available": false, "value": 6, "stringValue": "6"},
 "VM_GEAR_FINAL": {"available": true, "value": 3.7, "stringValue": "3.70"},
 "VM_GEAR_REVERSE": {"available": true, "value": 4.0, "stringValue": "4.0"},
 "VM_GEAR_1": {"available": true, "value": 2.665000, "stringValue": "2.665"},
 "VM_GEAR_2": {"available": true, "value": 14, "stringValue": "14"},
 "VM_GEAR_3": {"available": true, "value": 1.5e1, "stringValue": "15.0"},
 "VM_GEAR_5": {"available": true, "value": 2.5, "stringValue": "2.50"},
 "VM_GEAR_7": {"available": true, "value": 7, "stringValue": "N/A"},
 "VM_RATIO_SET": {"available": true, "value": 2, "stringValue": "2"},
 "VM_DIFF_POWER": {"available": true, "value": 50.0, "stringValue": "50.0 %"},
 "VM_DIFF_COAST": {"available": true, "value": 70, "stringValue": "70 %"},
 "VM_DIFF_PRELOAD": {"available": true, "value": 0, "stringValue": "0 Nm"},
 "VM_FRONT_DIFF_POWER": {"available": true, "value": 40, "stringValue": "40 %"},
 "VM_FRONT_DIFF_COAST": {"available": true, "value": 60.0, "stringValue": "60 %"},
 "VM_FRONT_DIFF_PRELOAD": {"available": true, "value": 10, "stringValue": "10 Nm"},
 "VM_TORQUE_SPLIT": {"available": true, "value": 0.5, "stringValue": "50.0 %"},
 "VM_WEIGHT_VERTICAL": "not an object",
 "VM_WEIGHT_LATERAL": null,
 "VM_WEIGHT_DISTRIB": {"available": false, "value": 48.5, "stringValue": "48.5 %"},
 "WM_COMPOUND-W_FL": {"available": true, "value": null, "stringValue": "Medium"},
 "WM_COMPOUND-W_FR": {"available": true, "value": null, "stringValue": "Medium"},
 "WM_COMPOUND-W_RL": {"available": true, "value": 1, "stringValue": "Soft"},
 "WM_PRESSURE-W_FL": {"available": true, "value": 2.665000, "stringValue": "2.665 bar"},
 "WM_PRESSURE-W_FR": {"available": true, "value": 2.665000, "stringValue": "2.665 bar"},
 "WM_PRESSURE-W_RR": {"available": true, "value": 2.75, "stringValue": "2.75 bar"},
 "WM_CAMBER-W_FL": {"available": true, "value": -3.75, "stringValue": "-3.75 deg"},
 "WM_CAMBER-W_FR": {"available": true, "value": -3.75, "stringValue": "-3.75 deg"},
 "WM_CAMBER-W_RR": {"available": true, "value": -5.0, "stringValue": "-5.00 deg"},
 "WM_PACKERS-W_FL": {"available": true, "value": 1.0, "stringValue": "1.0 mm"},
 "WM_PACKERS-W_FR": {"available": true, "value": 1.0, "stringValue": "1.0 mm"},
 "WM_SPRING-W_FL": {"available": true, "value": 45000.0, "stringValue": "45000.0 N/mm"},
 "WM_SPRING-W_FR": {"available": true, "value": 45000.0, "stringValue": "45000.0 N/mm"},
 "WM_SPRING-W_RL": {"available": true, "value": 52000.0, "stringValue": "52000.0 N/mm"},
 "WM_TENDERSPRING-W_FL": {"available": true, "value": 15000.0, "stringValue": "15000.0"},
 "WM_TENDERSPRING-W_FR": {"available": true, "value": 15000.0, "stringValue": "15000.0"},
 "WM_TENDERSPRING-W_RL": {"available": true, "value": 18000.0, "stringValue": "18000.0"},
 "WM_TENDERSPRING-W_RR": {"available": true, "value": 18000.0, "stringValue": "18000.0"},
 "WM_TENDERSPRINGTRAVEL-W_FL": {"available": true, "value": 0.03, "stringValue": "0.03"},
 "WM_SRUBBER-W_FL": {"available": true, "value": 1.25, "stringValue": "1.25 mm"},
 "WM_SRUBBER-W_FR": {"available": true, "value": 1.25, "stringValue": "1.25 mm"},
 "WM_SRUBBER-W_RR": {"available": true, "value": 1.5, "stringValue": "1.50 mm"},
 "WM_RIDEHEIGHT-W_FL": {"available": true, "value": 55.5, "stringValue": "55.5 mm"},
 "WM_RIDEHEIGHT-W_FR": {"available": true, "value": 55.5, "stringValue": "55.5 mm"},
 "WM_SLOWBUMP-W_FL": {"available": true, "value": 12, "stringValue": "12"},
 "WM_SLOWBUMP-W_FR": {"available": true, "value": 12, "stringValue": "12"},
 "WM_SLOWBUMP-W_RL": {"available": true, "value": 13, "stringValue": "13"},
 "WM_FASTBUMP-W_FL": {"available": true, "value": 3.0, "stringValue": "3"},
 "WM_FASTBUMP-W_RR": {"available": true, "value": 4, "stringValue": "4"},
 "WM_SLOWREBOUND-W_FL": {"available": true, "value": 60, "stringValue": "60"},
 "WM_SLOWREBOUND-W_RL": {"available": true, "value": 62, "stringValue": "62"},
 "WM_FASTREBOUND-W_FR": {"available": true, "value": 7.0, "stringValue": "7"},
 "WM_BRAKEDISC-W_FL": {"available": true, "value": 2, "stringValue": "Steel"},
 "WM_BRAKEPAD-W_FL": {"available": true, "value": 1, "stringValue": "HP"},
 "WM_BRAKEPAD-W_RL": {"available": true, "value": 1, "stringValue": "HP"},
 "VM_FRONT_TIRE_COMPOUND": {"available": true, "value": null, "stringValue": "Medium"},
 "VM_REAR_TIRE_COMPOUND": {"available": true, "value": 2, "stringValue": "Hard"}
}`;

/** Metadata rows every session database carries; mirrors a real LMU header. */
export const BASE_METADATA: readonly (readonly [string, string])[] = [
  ['TrackName', 'Autodromo Nazionale Monza'],
  ['TrackLayout', 'Circuit de Barcelona-Catalunya - 1A'],
  ['CarName', 'Porsche 963 (LMDh)'],
  ['CarClass', 'Hypercar'],
  ['RecordingTime', '2025-06-01_14_30_05'],
  ['SetupName', 'Baseline'],
];

export interface SetupFixture {
  readonly dir: string;
  /** Session with a full CarSetup blob and CarClass = Hypercar. */
  readonly database: string;
  /** Session whose metadata has no CarSetup row at all. */
  readonly noSetupDatabase: string;
  /** Session whose CarSetup row is blank (`"   "`). */
  readonly blankSetupDatabase: string;
  /** Session whose CarSetup row is not valid JSON. */
  readonly brokenSetupDatabase: string;
  /** Session with a CarClass row whose value is SQL NULL. */
  readonly nullClassDatabase: string;
  /** Session with a CarSetup row but no CarClass row. */
  readonly noClassDatabase: string;
  /** Session database without a `metadata` table at all. */
  readonly noMetadataTableDatabase: string;
  dispose(): void;
}

async function runStatements(database: string, statements: readonly string[]): Promise<void> {
  const instance = await DuckDBInstance.create(database);
  try {
    const connection = await instance.connect();
    try {
      for (const statement of statements) {
        await connection.run(statement);
      }
    } finally {
      connection.disconnectSync();
    }
  } finally {
    instance.closeSync();
  }
}

async function writeDatabase(database: string, rows: readonly (readonly [string, string | null])[]): Promise<void> {
  const instance = await DuckDBInstance.create(database);
  try {
    const connection = await instance.connect();
    try {
      await connection.run('CREATE TABLE metadata (key VARCHAR, value VARCHAR)');
      for (const [key, value] of rows) {
        await connection.run('INSERT INTO metadata VALUES ($1, $2)', [key, value]);
      }
    } finally {
      connection.disconnectSync();
    }
  } finally {
    instance.closeSync();
  }
}

export async function createSetupFixtures(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmutl-setup-'))): Promise<SetupFixture> {
  const database = path.join(dir, 'session.duckdb');
  const noSetupDatabase = path.join(dir, 'no-setup.duckdb');
  const blankSetupDatabase = path.join(dir, 'blank-setup.duckdb');
  const brokenSetupDatabase = path.join(dir, 'broken-setup.duckdb');
  const nullClassDatabase = path.join(dir, 'null-class.duckdb');
  const noClassDatabase = path.join(dir, 'no-class.duckdb');
  const noMetadataTableDatabase = path.join(dir, 'no-metadata.duckdb');

  await writeDatabase(database, [...BASE_METADATA, ['CarSetup', CAR_SETUP_JSON]]);
  await writeDatabase(noSetupDatabase, BASE_METADATA);
  await writeDatabase(blankSetupDatabase, [...BASE_METADATA, ['CarSetup', '   ']]);
  await writeDatabase(brokenSetupDatabase, [...BASE_METADATA, ['CarSetup', '{"VM_GEAR_FINAL":'], ]);
  await writeDatabase(nullClassDatabase, [
    ['TrackName', 'Monza'],
    ['CarClass', null],
    ['CarSetup', CAR_SETUP_JSON],
  ]);
  await writeDatabase(noClassDatabase, [
    ['TrackName', 'Monza'],
    ['CarSetup', CAR_SETUP_JSON],
  ]);
  await runStatements(noMetadataTableDatabase, ['CREATE TABLE "GPS Time" (value DOUBLE)']);

  return {
    dir,
    database,
    noSetupDatabase,
    blankSetupDatabase,
    brokenSetupDatabase,
    nullClassDatabase,
    noClassDatabase,
    noMetadataTableDatabase,
    dispose(): void {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
