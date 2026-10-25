import type { DuckDbConnectionFactory } from '../infra/duckdb/connection.js';
import type { MetadataReader } from '../infra/duckdb/metadata.js';
import { ApiException } from '../api/error.js';

/**
 * Port of `SvmExporter.java`.
 *
 * Java reads the `CarSetup` metadata blob with Jackson (`tools.jackson.databind`) and
 * writes the SVM text straight out of the parsed tree. Two consequences drive the
 * machinery at the bottom of this file:
 *
 * 1. the number that lands in the file is whatever Jackson's `JsonNode.toString()`
 *    produces for the stored literal, which is Java's `Double.toString` / integer
 *    rendering - NOT `Number.prototype.toFixed`, and NOT `String(number)` either
 *    (Java always keeps a fractional digit for integral doubles and switches to
 *    `E`-notation outside [10^-3, 10^7));
 * 2. `JSON.parse` throws away the literal text, so an integral token (`45000`) and a
 *    floating token (`45000.0`) - which Jackson renders as `45000` and `45000.0` -
 *    would become indistinguishable, and integers beyond 2^53 would lose digits.
 *
 * So the setup JSON is parsed by a local scanner that remembers the raw number
 * token, and rendered by `javaDoubleToString`, both exported for `setup-service.ts`.
 */

const CAR_SETUP_KEY = 'CarSetup';
const CAR_CLASS_KEY = 'CarClass';

/** One `[section, entries]` pair of the SVM layout; entries are `[svmKey, setupKey]`. */
type SvmEntry = readonly [svmKey: string, source: string];
type SvmSection = readonly [name: string, entries: readonly SvmEntry[]];

function entry(svmKey: string, source: string): SvmEntry {
  return [svmKey, source];
}

function wheelSection(name: string, suffix: 'FL' | 'FR' | 'RL' | 'RR'): SvmSection {
  return [
    name,
    [
      entry('CamberSetting', `WM_CAMBER-W_${suffix}`),
      entry('PressureSetting', `WM_PRESSURE-W_${suffix}`),
      entry('PackerSetting', `WM_PACKERS-W_${suffix}`),
      entry('SpringSetting', `WM_SPRING-W_${suffix}`),
      entry('TenderSpringSetting', `WM_TENDERSPRING-W_${suffix}`),
      entry('TenderTravelSetting', `WM_TENDERSPRINGTRAVEL-W_${suffix}`),
      entry('SpringRubberSetting', `WM_SRUBBER-W_${suffix}`),
      entry('RideHeightSetting', `WM_RIDEHEIGHT-W_${suffix}`),
      entry('SlowBumpSetting', `WM_SLOWBUMP-W_${suffix}`),
      entry('FastBumpSetting', `WM_FASTBUMP-W_${suffix}`),
      entry('SlowReboundSetting', `WM_SLOWREBOUND-W_${suffix}`),
      entry('FastReboundSetting', `WM_FASTREBOUND-W_${suffix}`),
      entry('BrakeDiscSetting', `WM_BRAKEDISC-W_${suffix}`),
      entry('BrakePadSetting', `WM_BRAKEPAD-W_${suffix}`),
      entry('CompoundSetting', suffix.startsWith('F') ? 'VM_FRONT_TIRE_COMPOUND' : 'VM_REAR_TIRE_COMPOUND'),
    ],
  ];
}

/**
 * Java `SvmExporter.mapping()`: a `LinkedHashMap` built in this exact order; the
 * section order and the entry order inside a section are part of the file format.
 */
function mapping(): readonly SvmSection[] {
  return [
    [
      'GENERAL',
      [
        entry('Notes', '""'),
        entry('Symmetric', '1'),
        entry('CGHeightSetting', '0//Non-adjustable'),
        entry('CGRightSetting', '0//Non-adjustable'),
        entry('CGRearSetting', '0//Non-adjustable'),
        entry('WedgeSetting', 'VM_WEIGHT_WEDGE'),
        entry('FuelSetting', 'VM_FUEL_LEVEL'),
        entry('FuelCapacitySetting', 'VM_FUEL_CAPACITY'),
        entry('VirtualEnergySetting', 'VM_VIRTUAL_ENERGY'),
        entry('NumPitstopsSetting', 'VM_NUM_PITSTOPS'),
        entry('Pitstop1Setting', 'VM_PITSTOP_1'),
        entry('Pitstop2Setting', 'VM_PITSTOP_2'),
        entry('Pitstop3Setting', 'VM_PITSTOP_3'),
      ],
    ],
    ['LEFTFENDER', [entry('FenderFlareSetting', 'VM_LEFT_FENDER_FLARE')]],
    ['RIGHTFENDER', [entry('FenderFlareSetting', 'VM_RIGHT_FENDER_FLARE')]],
    ['FRONTWING', [entry('FWSetting', 'VM_FRONT_WING')]],
    ['REARWING', [entry('RWSetting', 'VM_REAR_WING')]],
    [
      'BODYAERO',
      [
        entry('WaterRadiatorSetting', 'VM_WATER_RADIATOR'),
        entry('OilRadiatorSetting', 'VM_OIL_RADIATOR'),
        entry('BrakeDuctSetting', 'VM_BRAKE_DUCTS'),
        entry('BrakeDuctRearSetting', 'VM_BRAKE_DUCTS_REAR'),
      ],
    ],
    [
      'SUSPENSION',
      [
        entry('FrontWheelTrackSetting', 'VM_FRONT_WHEEL_TRACK'),
        entry('RearWheelTrackSetting', 'VM_REAR_WHEEL_TRACK'),
        entry('FrontAntiSwaySetting', 'VM_FRONT_ANTISWAY'),
        entry('RearAntiSwaySetting', 'VM_REAR_ANTISWAY'),
        entry('FrontToeInSetting', 'VM_FRONT_TOEIN'),
        entry('FrontToeOffsetSetting', 'VM_FRONT_TOEOFFSET'),
        entry('RearToeInSetting', 'VM_REAR_TOEIN'),
        entry('RearToeOffsetSetting', 'VM_REAR_TOEOFFSET'),
        entry('LeftCasterSetting', 'VM_LEFT_CASTER'),
        entry('RightCasterSetting', 'VM_RIGHT_CASTER'),
        entry('LeftTrackBarSetting', 'VM_LEFT_TRACK_BAR'),
        entry('RightTrackBarSetting', 'VM_RIGHT_TRACK_BAR'),
        entry('Front3rdPackerSetting', 'VM_FRONT_3RD_PACKERS'),
        entry('Front3rdSpringSetting', 'VM_FRONT_3RD_SPRING'),
        entry('Front3rdTenderSpringSetting', 'VM_FRONT_3RD_TENDERSPRING'),
        entry('Front3rdTenderTravelSetting', 'VM_FRONT_3RD_TENDERSPRINGTRAVEL'),
        entry('Front3rdSlowBumpSetting', 'VM_FRONT_3RD_SLOWBUMP'),
        entry('Front3rdFastBumpSetting', 'VM_FRONT_3RD_FASTBUMP'),
        entry('Front3rdSlowReboundSetting', 'VM_FRONT_3RD_SLOWREBOUND'),
        entry('Front3rdFastReboundSetting', 'VM_FRONT_3RD_FASTREBOUND'),
        entry('Rear3rdPackerSetting', 'VM_REAR_3RD_PACKERS'),
        entry('Rear3rdSpringSetting', 'VM_REAR_3RD_SPRING'),
        entry('Rear3rdTenderSpringSetting', 'VM_REAR_3RD_TENDERSPRING'),
        entry('Rear3rdTenderTravelSetting', 'VM_REAR_3RD_TENDERSPRINGTRAVEL'),
        entry('Rear3rdSlowBumpSetting', 'VM_REAR_3RD_SLOWBUMP'),
        entry('Rear3rdFastBumpSetting', 'VM_REAR_3RD_FASTBUMP'),
        entry('Rear3rdSlowReboundSetting', 'VM_REAR_3RD_SLOWREBOUND'),
        entry('Rear3rdFastReboundSetting', 'VM_REAR_3RD_FASTREBOUND'),
        entry('ChassisAdj00Setting', 'VM_CHASSIS_ADJ_00'),
        entry('ChassisAdj01Setting', 'VM_CHASSIS_ADJ_01'),
        entry('ChassisAdj02Setting', 'VM_CHASSIS_ADJ_02'),
        entry('ChassisAdj03Setting', 'VM_CHASSIS_ADJ_03'),
        entry('ChassisAdj04Setting', 'VM_CHASSIS_ADJ_04'),
        entry('ChassisAdj05Setting', 'VM_CHASSIS_ADJ_05'),
        entry('ChassisAdj06Setting', 'VM_CHASSIS_ADJ_06'),
        entry('ChassisAdj07Setting', 'VM_CHASSIS_ADJ_07'),
        entry('ChassisAdj08Setting', 'VM_CHASSIS_ADJ_08'),
        entry('ChassisAdj09Setting', 'VM_CHASSIS_ADJ_09'),
        entry('ChassisAdj10Setting', 'VM_CHASSIS_ADJ_10'),
        entry('ChassisAdj11Setting', 'VM_CHASSIS_ADJ_11'),
      ],
    ],
    [
      'CONTROLS',
      [
        entry('SteerLockSetting', 'VM_STEER_LOCK'),
        entry('RearBrakeSetting', 'VM_BRAKE_BALANCE'),
        entry('BrakeMigrationSetting', 'VM_BRAKE_MIGRATION'),
        entry('BrakePressureSetting', 'VM_BRAKE_PRESSURE'),
        entry('HandfrontbrakePressSetting', 'VM_HANDFRONTBRAKE_PRESSURE'),
        entry('HandbrakePressSetting', 'VM_HANDBRAKE_PRESSURE'),
        entry('TCSetting', 'VM_TRACTION_CONTROL'),
        entry('ABSSetting', 'VM_ANTILOCK_BRAKES'),
        entry('TractionControlMapSetting', 'VM_TRACTIONCONTROLMAP'),
        entry('TCPowerCutMapSetting', 'VM_TRACTIONCONTROLPOWERCUTMAP'),
        entry('TCSlipAngleMapSetting', 'VM_TRACTIONCONTROLSLIPANGLEMAP'),
        entry('AntilockBrakeSystemMapSetting', 'VM_ANTILOCKBRAKESYSTEMMAP'),
      ],
    ],
    [
      'ENGINE',
      [
        entry('RevLimitSetting', 'VM_REV_LIMITER'),
        entry('EngineBoostSetting', 'VM_ENGINE_BOOST'),
        entry('RegenerationMapSetting', 'VM_REGEN_LEVEL'),
        entry('ElectricMotorMapSetting', 'VM_ELECTRIC_MOTOR_MAP'),
        entry('EngineMixtureSetting', 'VM_ENGINE_MIXTURE'),
        entry('EngineBrakingMapSetting', 'VM_ENGINE_BRAKEMAP'),
      ],
    ],
    [
      'DRIVELINE',
      [
        entry('FinalDriveSetting', 'VM_GEAR_FINAL'),
        entry('ReverseSetting', 'VM_GEAR_REVERSE'),
        entry('Gear1Setting', 'VM_GEAR_1'),
        entry('Gear2Setting', 'VM_GEAR_2'),
        entry('Gear3Setting', 'VM_GEAR_3'),
        entry('Gear4Setting', 'VM_GEAR_4'),
        entry('Gear5Setting', 'VM_GEAR_5'),
        entry('Gear6Setting', 'VM_GEAR_6'),
        entry('RatioSetSetting', 'VM_RATIO_SET'),
        entry('DiffPumpSetting', 'VM_DIFF_PUMP'),
        entry('DiffPowerSetting', 'VM_DIFF_POWER'),
        entry('DiffCoastSetting', 'VM_DIFF_COAST'),
        entry('DiffPreloadSetting', 'VM_DIFF_PRELOAD'),
        entry('FrontDiffPumpSetting', 'VM_FRONT_DIFF_PUMP'),
        entry('FrontDiffPowerSetting', 'VM_FRONT_DIFF_POWER'),
        entry('FrontDiffCoastSetting', 'VM_FRONT_DIFF_COAST'),
        entry('FrontDiffPreloadSetting', 'VM_FRONT_DIFF_PRELOAD'),
        entry('RearSplitSetting', 'VM_TORQUE_SPLIT'),
        entry('GearAutoUpShiftSetting', 'VM_GEAR_AUTOUPSHIFT'),
        entry('GearAutoDownShiftSetting', 'VM_GEAR_AUTODOWNSHIFT'),
      ],
    ],
    wheelSection('FRONTLEFT', 'FL'),
    wheelSection('FRONTRIGHT', 'FR'),
    wheelSection('REARLEFT', 'RL'),
    wheelSection('REARRIGHT', 'RR'),
    [
      'BASIC',
      [
        entry('Downforce', '0.500000'),
        entry('Balance', '0.500000'),
        entry('Ride', '0.500000'),
        entry('Gearing', '0.500000'),
        entry('Custom', '1'),
      ],
    ],
  ];
}

/**
 * Literals that Java copies verbatim instead of looking them up in the setup tree:
 * `source.contains("//") || source.equals("\"\"") || source.equals("1") ||
 *  source.equals("0.500000")`.
 */
function isLiteralSource(source: string): boolean {
  return source.includes('//') || source === '""' || source === '1' || source === '0.500000';
}

export class SvmExporter {
  constructor(
    private readonly connections: DuckDbConnectionFactory,
    private readonly metadataReader: MetadataReader,
  ) {}

  /** Java `generate(Path)`: the whole `.svm` body, LF-terminated, no trailing blank lines. */
  async generate(database: string): Promise<string> {
    const { carClass, setup } = await this.readCarClassAndSetup(database);

    const output: string[] = [];
    output.push(`VehicleClassSetting="${carClass ?? 'null'}"\n`);
    output.push('UpgradeSetting=(0,0,0,0)\n');
    output.push('// Generated by LMU Telemetry Lab\n');
    output.push('//Note: settings commented out if using the default\n\n');

    for (const [name, entries] of mapping()) {
      output.push(`[${name}]\n`);
      for (const [svmKey, source] of entries) {
        if (isLiteralSource(source)) {
          output.push(`${svmKey}=${source}\n`);
          continue;
        }
        const node = nodePath(setup, source);
        if (isObjectNode(node) && nodeAsBoolean(nodePath(node, 'available'), false)) {
          const hasValue = nodeHas(node, 'value');
          const valueNode = hasValue ? nodeGet(node, 'value') : MISSING_NODE;
          const valueText = hasValue && !isNullNode(valueNode) ? nodeToString(valueNode) : '0';
          const stringValue = nodeAsText(nodePath(node, 'stringValue'), 'N/A');
          output.push(`${svmKey}=${valueText}//${stringValue}\n`);
        } else {
          output.push(`${svmKey}=0//N/A\n`);
        }
      }
      output.push('\n');
    }
    return javaStrip(output.join('')) + '\n';
  }

  /**
   * Java's try-with-resources block: read `CarClass` + `CarSetup` from the session
   * database, rethrow `ApiException` untouched and turn anything else into the 500
   * `"Failed to read CarSetup"`.
   */
  private async readCarClassAndSetup(database: string): Promise<{ carClass: string | null; setup: CarSetupNode }> {
    try {
      const read = await this.connections.withConnection(database, async (session) => {
        const metadata = await this.metadataReader.read(session.connection);
        // Java `getOrDefault` only falls back when the key is ABSENT: a row whose
        // value is SQL NULL stays null and the header prints the literal "null".
        const carClassMeta = metadata.has(CAR_CLASS_KEY) ? metadata.get(CAR_CLASS_KEY) ?? null : 'Unknown Class';
        const raw = metadata.get(CAR_SETUP_KEY) ?? null;
        return { carClass: carClassMeta, raw };
      });
      if (read.raw === null || javaIsBlank(read.raw)) {
        throw new ApiException(404, 'CarSetup metadata not found.');
      }
      return { carClass: read.carClass, setup: parseCarSetup(read.raw) };
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw new ApiException(500, 'Failed to read CarSetup', { cause: error });
    }
  }
}

/* --------------------------------------------------------------------------- *
 * Java-compatible JSON tree (the subset of Jackson's JsonNode the two setup
 * services use) and the number rendering it relies on.
 * --------------------------------------------------------------------------- */

/** Missing node: Jackson's `MissingNode` singleton (`path()` on a miss). */
export const MISSING_NODE: CarSetupNode = { kind: 'missing' };

/** Object/array/string/number/boolean/null nodes, mirroring Jackson's node types. */
export type CarSetupNode =
  | { kind: 'missing' }
  | { kind: 'null' }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'string'; value: string }
  | { kind: 'number'; raw: string; value: number; integral: boolean }
  | { kind: 'array'; items: CarSetupNode[] }
  | { kind: 'object'; props: Map<string, CarSetupNode> };

/** Jackson `JsonNode.path(key)` - never throws, returns MissingNode on a miss. */
export function nodePath(node: CarSetupNode, key: string): CarSetupNode {
  return node.kind === 'object' ? node.props.get(key) ?? MISSING_NODE : MISSING_NODE;
}

/** Jackson `JsonNode.has(key)`. */
export function nodeHas(node: CarSetupNode, key: string): boolean {
  return node.kind === 'object' && node.props.has(key);
}

/** Jackson `JsonNode.get(key)`; callers must have checked `has` first. */
export function nodeGet(node: CarSetupNode, key: string): CarSetupNode {
  return node.kind === 'object' ? node.props.get(key) ?? MISSING_NODE : MISSING_NODE;
}

/** Jackson `JsonNode.isObject()`. */
export function isObjectNode(node: CarSetupNode): boolean {
  return node.kind === 'object';
}

/** Jackson `JsonNode.isNull()`. */
export function isNullNode(node: CarSetupNode): boolean {
  return node.kind === 'null';
}

/**
 * Jackson `JsonNode.asBoolean(default)`: null/missing -> default, boolean -> itself,
 * number -> non-zero, text -> the literal `"true"`/`"True"` (Jackson compares
 * case-sensitively against those two spellings), any other node -> true.
 */
export function nodeAsBoolean(node: CarSetupNode, defaultValue: boolean): boolean {
  switch (node.kind) {
    case 'missing':
    case 'null':
      return defaultValue;
    case 'boolean':
      return node.value;
    case 'number':
      return node.value !== 0;
    case 'string':
      return node.value === 'true' || node.value === 'True';
    default:
      return true;
  }
}

/**
 * Jackson `JsonNode.asText(default)`: missing/null -> default, value nodes -> their
 * text form, containers -> their compact JSON form (`JsonNode.asText()` falls back to
 * `toString()` in Jackson).
 */
export function nodeAsText(node: CarSetupNode, defaultValue: string): string {
  switch (node.kind) {
    case 'missing':
    case 'null':
      return defaultValue;
    case 'string':
      return node.value;
    case 'boolean':
      return node.value ? 'true' : 'false';
    case 'number':
      return numberText(node);
    default:
      return nodeToString(node);
  }
}

/** Jackson `JsonNode.toString()` - compact JSON, which is what the SVM file embeds. */
export function nodeToString(node: CarSetupNode): string {
  switch (node.kind) {
    case 'missing':
      return '';
    case 'null':
      return 'null';
    case 'boolean':
      return node.value ? 'true' : 'false';
    case 'string':
      return jsonString(node.value);
    case 'number':
      return numberText(node);
    case 'array':
      return `[${node.items.map(nodeToString).join(',')}]`;
    case 'object': {
      const parts: string[] = [];
      for (const [key, value] of node.props) parts.push(`${jsonString(key)}:${nodeToString(value)}`);
      return `{${parts.join(',')}}`;
    }
  }
}

function numberText(node: { raw: string; value: number; integral: boolean }): string {
  // Jackson keeps integral tokens exact (Int/Long/BigIntegerNode) and renders
  // everything else as a double, so the raw literal has to be remembered.
  if (node.integral) return integerText(node.raw);
  return javaDoubleToString(node.value);
}

/** Canonical decimal digits of an integer token, the way `BigInteger.toString()` gives them. */
function integerText(raw: string): string {
  const negative = raw.startsWith('-');
  const digits = negative ? raw.slice(1) : raw;
  const canonical = digits.replace(/^0+/, '');
  if (canonical === '') return '0'; // "-0" is zero, and Java renders it without the sign
  return negative ? `-${canonical}` : canonical;
}

/** Jackson's JSON string writer: `"` and `\` escaped, control chars as `\b \t \n \f \r \u00xx`. */
function jsonString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (char === '"') out += '\\"';
    else if (char === '\\') out += '\\\\';
    else if (code === 0x08) out += '\\b';
    else if (code === 0x09) out += '\\t';
    else if (code === 0x0a) out += '\\n';
    else if (code === 0x0c) out += '\\f';
    else if (code === 0x0d) out += '\\r';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += char;
  }
  return `${out}"`;
}

/**
 * Java `Double.toString(double)` (the rendering Jackson uses for `DoubleNode`).
 *
 * Rules it implements, from the Javadoc contract:
 * - `NaN`, `Infinity`, `-Infinity` spell out exactly like this;
 * - zero is `0.0` / `-0.0`;
 * - for 10^-3 <= |v| < 10^7 the plain form is used, and the fraction part always has
 *   at least one digit (`100.0`, not `100`);
 * - otherwise the `d.dddEnnn` form, single leading digit, at least one fraction digit,
 *   exponent without sign or leading zeros (`1.0E7`, `1.0E-4`);
 * - digits are the shortest that round-trip, so `2.665000` prints as `2.665`.
 *
 * `Number.prototype.toFixed` and `toLocaleString` are deliberately not used anywhere in
 * this file: `toFixed` rounds HALF_UP on a per-call basis and pads zeros, which would
 * change values such as `2.665000` -> `2.67`; locale formatting can swap the decimal
 * separator. The decimal separator here is always `.`.
 */
export function javaDoubleToString(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';

  const sign = value < 0 ? '-' : '';
  const { digits, exponent } = shortestDigits(Math.abs(value));
  if (exponent >= -3 && exponent <= 6) {
    // plain decimal notation
    if (exponent >= 0) {
      const padded = digits.padEnd(exponent + 1, '0');
      const integerPart = padded.slice(0, exponent + 1);
      const fraction = padded.slice(exponent + 1);
      return `${sign}${integerPart}.${fraction === '' ? '0' : fraction}`;
    }
    return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
  }
  // computer scientific notation
  const stripped = digits.replace(/0+$/, '');
  const mantissa = stripped === '' ? '0' : stripped[0];
  const fraction = stripped.length > 1 ? stripped.slice(1) : '0';
  return `${sign}${mantissa}.${fraction}E${exponent}`;
}

/**
 * Shortest round-trip digits of a positive finite number plus the power of ten that
 * puts the decimal point after the first digit (`value = digits * 10^(exponent+1-ish)`,
 * concretely `d.ddd... x 10^exponent`).
 */
function shortestDigits(magnitude: number): { digits: string; exponent: number } {
  const text = String(magnitude);
  const eIndex = text.search(/e/i);
  const mantissa = eIndex < 0 ? text : text.slice(0, eIndex);
  const scale = eIndex < 0 ? 0 : Number(text.slice(eIndex + 1));
  const dot = mantissa.indexOf('.');
  let digits = dot < 0 ? mantissa : mantissa.slice(0, dot) + mantissa.slice(dot + 1);
  let pointPosition = dot < 0 ? mantissa.length : dot;

  const withoutLeading = digits.replace(/^0+/, '');
  pointPosition -= digits.length - withoutLeading.length;
  digits = withoutLeading === '' ? '0' : withoutLeading;
  return { digits, exponent: pointPosition - 1 + scale };
}

/**
 * Java `String.strip()`: strips leading/trailing characters for which
 * `Character.isWhitespace` holds. That set is NOT the JS `\s` set: U+001C..U+001F are
 * whitespace in Java, while the non-breaking spaces U+00A0, U+2007 and U+202F are not.
 */
export function javaStrip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && javaIsWhitespace(text.charCodeAt(start))) start += 1;
  while (end > start && javaIsWhitespace(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/** Java `String.isBlank()` - empty, or only `Character.isWhitespace` characters. */
export function javaIsBlank(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      // a surrogate pair is never whitespace; skip the trail unit
      index += 1;
      continue;
    }
    if (!javaIsWhitespace(code)) return false;
  }
  return true;
}

/** `Character.isWhitespace(int)` (Java SE 21). */
export function javaIsWhitespace(codePoint: number): boolean {
  return (
    codePoint === 0x20 ||
    (codePoint >= 0x09 && codePoint <= 0x0d) ||
    (codePoint >= 0x1c && codePoint <= 0x1f) ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x2006) ||
    (codePoint >= 0x2008 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

/** `String.format(Locale.ROOT, "VM_CHASSIS_ADJ_%02d", i)` - two-digit zero padding. */
export function padTwo(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Strict JSON parser that keeps every number token's literal text. Jackson's defaults
 * are equally strict about comments/trailing commas and reject `NaN`/`Infinity`
 * literals, so a document the game cannot have produced fails here as well and both
 * services turn that into the same 500.
 */
export function parseCarSetup(raw: string): CarSetupNode {
  const parser = new JsonScanner(raw);
  const node = parser.parseValue();
  parser.skipWhitespace();
  // Jackson's readTree stops after the first value and does not mind trailing spaces;
  // trailing content would be a parser difference nobody exercises, so it is tolerated.
  return node;
}

class JsonScanner {
  private position = 0;

  constructor(private readonly text: string) {}

  skipWhitespace(): void {
    while (this.position < this.text.length) {
      const code = this.text.charCodeAt(this.position);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) this.position += 1;
      else break;
    }
  }

  parseValue(): CarSetupNode {
    this.skipWhitespace();
    if (this.position >= this.text.length) throw new SyntaxError('Unexpected end of JSON input');
    const char = this.text[this.position];
    if (char === '{') return this.parseObject();
    if (char === '[') return this.parseArray();
    if (char === '"') return { kind: 'string', value: this.parseString() };
    if (char === 't') return this.expectWord('true', { kind: 'boolean', value: true });
    if (char === 'f') return this.expectWord('false', { kind: 'boolean', value: false });
    if (char === 'n') return this.expectWord('null', { kind: 'null' });
    return this.parseNumber();
  }

  private expectWord(word: string, node: CarSetupNode): CarSetupNode {
    if (!this.text.startsWith(word, this.position)) {
      throw new SyntaxError(`Unexpected token at ${this.position}`);
    }
    this.position += word.length;
    return node;
  }

  private parseObject(): CarSetupNode {
    const props = new Map<string, CarSetupNode>();
    this.position += 1; // '{'
    this.skipWhitespace();
    if (this.text[this.position] === '}') {
      this.position += 1;
      return { kind: 'object', props };
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.position] !== '"') throw new SyntaxError(`Expected key at ${this.position}`);
      const key = this.parseString();
      this.skipWhitespace();
      if (this.text[this.position] !== ':') throw new SyntaxError(`Expected ':' at ${this.position}`);
      this.position += 1;
      props.set(key, this.parseValue()); // duplicate keys: last one wins, like Jackson
      this.skipWhitespace();
      const next = this.text[this.position];
      if (next === ',') {
        this.position += 1;
        continue;
      }
      if (next === '}') {
        this.position += 1;
        return { kind: 'object', props };
      }
      throw new SyntaxError(`Expected ',' or '}' at ${this.position}`);
    }
  }

  private parseArray(): CarSetupNode {
    const items: CarSetupNode[] = [];
    this.position += 1; // '['
    this.skipWhitespace();
    if (this.text[this.position] === ']') {
      this.position += 1;
      return { kind: 'array', items };
    }
    for (;;) {
      items.push(this.parseValue());
      this.skipWhitespace();
      const next = this.text[this.position];
      if (next === ',') {
        this.position += 1;
        continue;
      }
      if (next === ']') {
        this.position += 1;
        return { kind: 'array', items };
      }
      throw new SyntaxError(`Expected ',' or ']' at ${this.position}`);
    }
  }

  private parseString(): string {
    this.position += 1; // opening quote
    let out = '';
    while (this.position < this.text.length) {
      const char = this.text[this.position];
      if (char === '"') {
        this.position += 1;
        return out;
      }
      if (char === '\\') {
        const escape = this.text[this.position + 1];
        switch (escape) {
          case '"':
            out += '"';
            break;
          case '\\':
            out += '\\';
            break;
          case '/':
            out += '/';
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '\t';
            break;
          case 'u': {
            const hex = this.text.slice(this.position + 2, this.position + 6);
            if (hex.length < 4) throw new SyntaxError('Bad unicode escape');
            out += String.fromCharCode(parseInt(hex, 16));
            this.position += 4;
            break;
          }
          default:
            throw new SyntaxError(`Bad escape '\\${escape}'`);
        }
        this.position += 2;
        continue;
      }
      out += char;
      this.position += 1;
    }
    throw new SyntaxError('Unterminated string');
  }

  private parseNumber(): CarSetupNode {
    const start = this.position;
    if (this.text[this.position] === '-') this.position += 1;
    if (this.text[this.position] === 'I') throw new SyntaxError('Non-standard number literal');
    while (this.position < this.text.length && isDigit(this.text[this.position])) this.position += 1;
    let integral = true;
    if (this.text[this.position] === '.') {
      integral = false;
      this.position += 1;
      while (this.position < this.text.length && isDigit(this.text[this.position])) this.position += 1;
    }
    const exponentChar = this.text[this.position];
    if (exponentChar === 'e' || exponentChar === 'E') {
      integral = false;
      this.position += 1;
      if (this.text[this.position] === '+' || this.text[this.position] === '-') this.position += 1;
      while (this.position < this.text.length && isDigit(this.text[this.position])) this.position += 1;
    }
    const raw = this.text.slice(start, this.position);
    if (raw === '' || raw === '-') throw new SyntaxError(`Unexpected token at ${start}`);
    const value = Number(raw);
    if (Number.isNaN(value)) throw new SyntaxError(`Invalid number '${raw}'`);
    // Jackson types a token as an integer only when it has neither a fraction part nor
    // an exponent; `1e2` is a double and prints as `100.0`.
    return { kind: 'number', raw, value, integral };
  }
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}
