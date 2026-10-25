import type { DuckDbConnectionFactory } from '../infra/duckdb/connection.js';
import type { MetadataReader } from '../infra/duckdb/metadata.js';
import { ApiException } from '../api/error.js';
import {
  CarSetupNode,
  javaIsBlank,
  isObjectNode,
  nodeAsBoolean,
  nodeAsText,
  nodePath,
  padTwo,
  parseCarSetup,
} from './svm-exporter.js';

/**
 * Port of `SetupService.java`.
 *
 * Reads the flat `CarSetup` JSON blob out of a session database and re-assembles it as
 * the nested tree the frontend consumes. The key order below is the contract (Java
 * builds every group as a `LinkedHashMap`, Python as a dict literal, and both emit the
 * same order): group order, entry order inside a group, and the `L`/`3rd`/`R` order of
 * a wheel entry all matter. Plain objects are safe here because no key is an
 * array-index-like string (`"3rd"` has a letter, `"Gear 1"` a space), so V8 keeps the
 * insertion order that `JSON.stringify` then writes out.
 *
 * Unset entries stay explicit `null` - never `undefined` - so that a serializer emits
 * `"key": null` the way Jackson does for a `LinkedHashMap` null value.
 */

/** A setup leaf: the `stringValue` of an available entry, or null when unusable. */
export type SetupLeaf = string | null;

/** Left/right pair, e.g. the two front wheels. */
export interface WheelPair {
  L: SetupLeaf;
  R: SetupLeaf;
}

/** Left / third-element / right triple used by suspension and damper rows. */
export interface WheelTriple {
  L: SetupLeaf;
  '3rd': SetupLeaf;
  R: SetupLeaf;
}

export type SetupLeafGroup = Record<string, SetupLeaf>;
export type SetupPairGroup = Record<string, WheelPair>;
export type SetupTripleGroup = Record<string, WheelTriple>;

export interface Powertrain {
  engine: SetupLeafGroup;
  electronics: SetupLeafGroup;
  differential: SetupLeafGroup;
  gearing: SetupLeafGroup;
}

export interface WheelsAndBrakes {
  frontWheels: SetupPairGroup;
  rearWheels: SetupPairGroup;
  brakes: SetupLeafGroup;
}

export interface Suspension {
  front: SetupTripleGroup;
  rear: SetupTripleGroup;
}

export interface Dampers {
  front: SetupTripleGroup;
  rear: SetupTripleGroup;
}

export interface ChassisAndAero {
  frontChassis: SetupLeafGroup;
  rearChassis: SetupLeafGroup;
  weight: SetupLeafGroup;
  advancedChassis: SetupLeafGroup;
}

export interface SetupGroups {
  powertrain: Powertrain;
  wheelsAndBrakes: WheelsAndBrakes;
  suspension: Suspension;
  dampers: Dampers;
  chassisAndAero: ChassisAndAero;
}

/** Java `getSetup` returns `{"setup": {...}}`. */
export interface SetupResponse {
  setup: SetupGroups;
}

/**
 * Port of the slice of `SessionService` this service uses; `SessionService.resolve`
 * (and `SessionRepository.resolve`) satisfy it structurally.
 */
export interface SessionResolver {
  resolve(profileId: string, sessionId: string): Promise<string>;
}

export class SetupService {
  constructor(
    private readonly sessionService: SessionResolver,
    private readonly connections: DuckDbConnectionFactory,
    private readonly metadataReader: MetadataReader,
  ) {}

  async getSetup(profileId: string, sessionId: string): Promise<SetupResponse> {
    const database = await this.sessionService.resolve(profileId, sessionId);
    const setup = await this.readSetup(database);
    if (setup === null) {
      throw new ApiException(404, 'CarSetup not found in metadata');
    }

    const result: SetupGroups = {
      powertrain: this.powertrain(setup),
      wheelsAndBrakes: this.wheelsAndBrakes(setup),
      suspension: this.suspension(setup),
      dampers: this.dampers(setup),
      chassisAndAero: this.chassisAndAero(setup),
    };
    return { setup: result };
  }

  /** Java `readSetup(Path)`: the parsed `CarSetup` tree, or null when absent/blank. */
  async readSetup(database: string): Promise<CarSetupNode | null> {
    try {
      const raw = await this.connections.withConnection(database, async (session) => {
        const metadata = await this.metadataReader.read(session.connection);
        return metadata.get('CarSetup') ?? null;
      });
      if (raw === null || javaIsBlank(raw)) return null;
      return parseCarSetup(raw);
    } catch (error) {
      // Java wraps every failure of this method, ApiException included (none occur inside).
      throw new ApiException(500, 'Failed to read CarSetup', { cause: error });
    }
  }

  /** Java `readMetadata(Path)`; used by the export endpoint and by Discord sharing. */
  async readMetadata(database: string): Promise<Map<string, string | null>> {
    try {
      return await this.connections.withConnection(database, (session) =>
        this.metadataReader.read(session.connection),
      );
    } catch (error) {
      throw new ApiException(500, 'Failed to read session metadata', { cause: error });
    }
  }

  private powertrain(setup: CarSetupNode): Powertrain {
    const engine: SetupLeafGroup = {
      'Virtual Energy': this.val(setup, 'VM_VIRTUAL_ENERGY'),
      'Fuel Ratio': this.val(setup, 'VM_FUEL_LEVEL'),
      'Fuel Capacity': this.val(setup, 'VM_FUEL_CAPACITY'),
      'Rev Limiter': this.val(setup, 'VM_REV_LIMITER'),
      'Engine Mixture': this.val(setup, 'VM_ENGINE_MIXTURE'),
      'Water Radiator': this.val(setup, 'VM_WATER_RADIATOR'),
      'Oil Radiator': this.val(setup, 'VM_OIL_RADIATOR'),
    };

    const electronics: SetupLeafGroup = {
      'Onboard TC': this.val(setup, 'VM_TRACTIONCONTROLMAP'),
      'TC Power Cut': this.val(setup, 'VM_TRACTIONCONTROLPOWERCUTMAP'),
      'TC Slip Angle': this.val(setup, 'VM_TRACTIONCONTROLSLIPANGLEMAP'),
      'Regen Level': this.val(setup, 'VM_REGEN_LEVEL'),
      'Electric Motor Map': this.val(setup, 'VM_ELECTRIC_MOTOR_MAP'),
    };

    const differential: SetupLeafGroup = {
      Power: this.val(setup, 'VM_DIFF_POWER'),
      Coast: this.val(setup, 'VM_DIFF_COAST'),
      Preload: this.val(setup, 'VM_DIFF_PRELOAD'),
      'Front Power': this.val(setup, 'VM_FRONT_DIFF_POWER'),
      'Front Coast': this.val(setup, 'VM_FRONT_DIFF_COAST'),
      'Front Preload': this.val(setup, 'VM_FRONT_DIFF_PRELOAD'),
      'Torque Split': this.val(setup, 'VM_TORQUE_SPLIT'),
    };

    const gearing: SetupLeafGroup = {
      'Ratio Set': this.val(setup, 'VM_RATIO_SET'),
      'Gear 1': this.val(setup, 'VM_GEAR_1'),
      'Gear 2': this.val(setup, 'VM_GEAR_2'),
      'Gear 3': this.val(setup, 'VM_GEAR_3'),
      'Gear 4': this.val(setup, 'VM_GEAR_4'),
      'Gear 5': this.val(setup, 'VM_GEAR_5'),
      'Gear 6': this.val(setup, 'VM_GEAR_6'),
      'Gear 7': this.val(setup, 'VM_GEAR_7'),
      'Final Drive': this.val(setup, 'VM_GEAR_FINAL'),
      'Reverse': this.val(setup, 'VM_GEAR_REVERSE'),
    };

    return { engine, electronics, differential, gearing };
  }

  private wheelsAndBrakes(setup: CarSetupNode): WheelsAndBrakes {
    const front: SetupPairGroup = {
      Compound: this.lr(setup, 'WM_COMPOUND-W_FL', 'WM_COMPOUND-W_FR'),
      'Tyre Pressure': this.lr(setup, 'WM_PRESSURE-W_FL', 'WM_PRESSURE-W_FR'),
      Camber: this.lr(setup, 'WM_CAMBER-W_FL', 'WM_CAMBER-W_FR'),
      'Brake Disc': this.lr(setup, 'WM_BRAKEDISC-W_FL', 'WM_BRAKEDISC-W_FR'),
      'Brake Pad': this.lr(setup, 'WM_BRAKEPAD-W_FL', 'WM_BRAKEPAD-W_FR'),
    };

    const rear: SetupPairGroup = {
      Compound: this.lr(setup, 'WM_COMPOUND-W_RL', 'WM_COMPOUND-W_RR'),
      'Tyre Pressure': this.lr(setup, 'WM_PRESSURE-W_RL', 'WM_PRESSURE-W_RR'),
      Camber: this.lr(setup, 'WM_CAMBER-W_RL', 'WM_CAMBER-W_RR'),
      'Brake Disc': this.lr(setup, 'WM_BRAKEDISC-W_RL', 'WM_BRAKEDISC-W_RR'),
      'Brake Pad': this.lr(setup, 'WM_BRAKEPAD-W_RL', 'WM_BRAKEPAD-W_RR'),
    };

    const brakes: SetupLeafGroup = {
      'Brake Bias': this.val(setup, 'VM_BRAKE_BALANCE'),
      'Brake Migration': this.val(setup, 'VM_BRAKE_MIGRATION'),
      'Max Pedal Force': this.val(setup, 'VM_BRAKE_PRESSURE'),
      'Front Brake Duct': this.val(setup, 'VM_BRAKE_DUCTS'),
      'Rear Brake Duct': this.val(setup, 'VM_BRAKE_DUCTS_REAR'),
      ABS: this.val(setup, 'VM_ANTILOCKBRAKESYSTEMMAP'),
    };

    return { frontWheels: front, rearWheels: rear, brakes };
  }

  private suspension(setup: CarSetupNode): Suspension {
    const front: SetupTripleGroup = {
      'Spring Rate': this.lr3(setup, 'WM_SPRING-W_FL', 'VM_FRONT_3RD_SPRING', 'WM_SPRING-W_FR'),
      'Tender Spring': this.lr3(
        setup,
        'WM_TENDERSPRING-W_FL',
        'VM_FRONT_3RD_TENDERSPRING',
        'WM_TENDERSPRING-W_FR',
      ),
      Packers: this.lr3(setup, 'WM_PACKERS-W_FL', 'VM_FRONT_3RD_PACKERS', 'WM_PACKERS-W_FR'),
      'Ride Height': this.lr3(setup, 'WM_RIDEHEIGHT-W_FL', null, 'WM_RIDEHEIGHT-W_FR'),
      'Spring Rubber': this.lr3(setup, 'WM_SRUBBER-W_FL', null, 'WM_SRUBBER-W_FR'),
    };

    const rear: SetupTripleGroup = {
      'Spring Rate': this.lr3(setup, 'WM_SPRING-W_RL', 'VM_REAR_3RD_SPRING', 'WM_SPRING-W_RR'),
      'Tender Spring': this.lr3(
        setup,
        'WM_TENDERSPRING-W_RL',
        'VM_REAR_3RD_TENDERSPRING',
        'WM_TENDERSPRING-W_RR',
      ),
      Packers: this.lr3(setup, 'WM_PACKERS-W_RL', 'VM_REAR_3RD_PACKERS', 'WM_PACKERS-W_RR'),
      'Ride Height': this.lr3(setup, 'WM_RIDEHEIGHT-W_RL', null, 'WM_RIDEHEIGHT-W_RR'),
      'Spring Rubber': this.lr3(setup, 'WM_SRUBBER-W_RL', null, 'WM_SRUBBER-W_RR'),
    };

    return { front, rear };
  }

  private dampers(setup: CarSetupNode): Dampers {
    const front: SetupTripleGroup = {
      'Slow Bump': this.lr3(setup, 'WM_SLOWBUMP-W_FL', 'VM_FRONT_3RD_SLOWBUMP', 'WM_SLOWBUMP-W_FR'),
      'Slow Rebound': this.lr3(
        setup,
        'WM_SLOWREBOUND-W_FL',
        'VM_FRONT_3RD_SLOWREBOUND',
        'WM_SLOWREBOUND-W_FR',
      ),
      'Fast Bump': this.lr3(setup, 'WM_FASTBUMP-W_FL', 'VM_FRONT_3RD_FASTBUMP', 'WM_FASTBUMP-W_FR'),
      'Fast Rebound': this.lr3(
        setup,
        'WM_FASTREBOUND-W_FL',
        'VM_FRONT_3RD_FASTREBOUND',
        'WM_FASTREBOUND-W_FR',
      ),
    };

    const rear: SetupTripleGroup = {
      'Slow Bump': this.lr3(setup, 'WM_SLOWBUMP-W_RL', 'VM_REAR_3RD_SLOWBUMP', 'WM_SLOWBUMP-W_RR'),
      'Slow Rebound': this.lr3(
        setup,
        'WM_SLOWREBOUND-W_RL',
        'VM_REAR_3RD_SLOWREBOUND',
        'WM_SLOWREBOUND-W_RR',
      ),
      'Fast Bump': this.lr3(setup, 'WM_FASTBUMP-W_RL', 'VM_REAR_3RD_FASTBUMP', 'WM_FASTBUMP-W_RR'),
      'Fast Rebound': this.lr3(
        setup,
        'WM_FASTREBOUND-W_RL',
        'VM_REAR_3RD_FASTREBOUND',
        'WM_FASTREBOUND-W_RR',
      ),
    };

    return { front, rear };
  }

  private chassisAndAero(setup: CarSetupNode): ChassisAndAero {
    const front: SetupLeafGroup = {
      'Caster L': this.val(setup, 'VM_LEFT_CASTER'),
      'Caster R': this.val(setup, 'VM_RIGHT_CASTER'),
      'Toe-in': this.val(setup, 'VM_FRONT_TOEIN'),
      'Anti-roll Bar': this.val(setup, 'VM_FRONT_ANTISWAY'),
      'Wheel Track': this.val(setup, 'VM_FRONT_WHEEL_TRACK'),
      'Wheel Range': this.val(setup, 'VM_STEER_LOCK'),
      'Front Wing': this.val(setup, 'VM_FRONT_WING'),
    };

    const rear: SetupLeafGroup = {
      'Toe-in': this.val(setup, 'VM_REAR_TOEIN'),
      'Anti-roll Bar': this.val(setup, 'VM_REAR_ANTISWAY'),
      'Wheel Track': this.val(setup, 'VM_REAR_WHEEL_TRACK'),
      'Rear Wing': this.val(setup, 'VM_REAR_WING'),
    };

    const weight: SetupLeafGroup = {
      Vertical: this.val(setup, 'VM_WEIGHT_VERTICAL'),
      Lateral: this.val(setup, 'VM_WEIGHT_LATERAL'),
      'Weight Distribution': this.val(setup, 'VM_WEIGHT_DISTRIB'),
      Wedge: this.val(setup, 'VM_WEIGHT_WEDGE'),
    };

    const advanced: SetupLeafGroup = {};
    for (let i = 0; i < 6; i += 1) {
      // Java: String.format(Locale.ROOT, "VM_CHASSIS_ADJ_%02d", i)
      advanced[`Chassis Adj ${i}`] = this.val(setup, `VM_CHASSIS_ADJ_${padTwo(i)}`);
    }

    return { frontChassis: front, rearChassis: rear, weight, advancedChassis: advanced };
  }

  /**
   * Java `val`: an entry only contributes when it is an object with `available` true and
   * a `stringValue` that is neither blank nor the literal `"N/A"`.
   */
  private val(setup: CarSetupNode, key: string): SetupLeaf {
    const entry = nodePath(setup, key);
    if (!isObjectNode(entry) || !nodeAsBoolean(nodePath(entry, 'available'), false)) {
      return null;
    }
    const value = nodeAsText(nodePath(entry, 'stringValue'), '');
    if (javaIsBlank(value) || value === 'N/A') {
      return null;
    }
    return value;
  }

  private lr(setup: CarSetupNode, left: string, right: string): WheelPair {
    return { L: this.val(setup, left), R: this.val(setup, right) };
  }

  private lr3(setup: CarSetupNode, left: string, third: string | null, right: string): WheelTriple {
    return {
      L: this.val(setup, left),
      '3rd': third === null ? null : this.val(setup, third),
      R: this.val(setup, right),
    };
  }
}
