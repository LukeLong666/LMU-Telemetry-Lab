/**
 * Domain types, 1:1 with backend-java/src/main/java/com/lmutl/domain.
 *
 * JSON key casing follows the Java records' effective output (mixed camelCase and
 * snake_case via @JsonProperty) because that is what the Python backend returns and
 * what the frontend consumes. `undefined` means "omit the key" (Java NON_NULL);
 * explicit `null` means "emit null" (SessionMetadata is JsonInclude.ALWAYS).
 */

export class Channel {
  private constructor(
    readonly name: string,
    readonly width: number,
    readonly data: Float64Array,
  ) {}

  static scalar(name: string, values: Float64Array | number[]): Channel {
    return new Channel(name, 1, values instanceof Float64Array ? values : Float64Array.from(values));
  }

  /** Flattens per-frame wheel arrays to width 4, padding missing wheels with NaN. */
  static vector(name: string, values: (number[] | Float64Array)[]): Channel {
    const frames = values.length;
    const flat = new Float64Array(frames * 4);
    for (let frame = 0; frame < frames; frame++) {
      const row = values[frame];
      for (let wheel = 0; wheel < 4; wheel++) {
        flat[frame * 4 + wheel] = wheel < row.length ? row[wheel] : Number.NaN;
      }
    }
    return new Channel(name, 4, flat);
  }

  static fromFlat(name: string, width: number, data: Float64Array): Channel {
    return new Channel(name, width, data);
  }

  valueAt(frame: number, component: number): number {
    return this.data[frame * this.width + component];
  }

  frames(): number {
    return this.width === 0 ? 0 : this.data.length / this.width;
  }
}

export interface FusedFrame {
  frequency: number;
  time: Float64Array;
  /** Insertion-ordered, mirroring Java's LinkedHashMap. */
  channels: Map<string, Channel>;
}

export function channelOf(frame: FusedFrame, name: string): Channel | undefined {
  return frame.channels.get(name);
}

export function hasChannel(frame: FusedFrame, name: string): boolean {
  return frame.channels.has(name);
}

export function scalarChannel(frame: FusedFrame, name: string): Float64Array | null {
  const channel = frame.channels.get(name);
  return channel === undefined || channel.width !== 1 ? null : channel.data;
}

export function channelMap(frame: FusedFrame): Map<string, Channel> {
  return frame.channels;
}

export interface LapInfo {
  lap: number;
  startTime: number;
  endTime: number;
  duration: number;
  isValid: boolean;
  isOutLap: boolean;
  inPit: boolean;
  fuelUsed: number;
  s1: number | null;
  s2: number | null;
  s3: number | null;
  stint: number;
}

export interface LapsResponse {
  laps: LapInfo[];
  metadata: SessionMetadata;
}

export interface Profile {
  id: string;
  name: string;
  created_at: string;
  last_used: string;
  is_default: boolean;
  avatar_url: string;
  session_count?: number;
}

export interface ReferenceLap {
  sessionId: string;
  sessionName: string;
  date: number;
  lap: number;
  stint: number;
  startTime: number;
  endTime: number;
  duration: number;
  isValid: boolean;
  s1: number | null;
  s2: number | null;
  s3: number | null;
  driver: string;
  sessionTime: string;
  carModel: string;
  rawCarName: string;
  totalLaps: number;
  stintCount: number;
  fuelUsed: number;
}

export interface SessionInfo {
  id: string;
  name: string;
  created: number;
  size: number;
  trackName?: string;
  trackLayout?: string;
  layoutKey?: string;
  commonTrackName?: string;
  displayName?: string;
  trackAliases?: string[];
  carModel?: string;
  carClass?: string;
  rawCarName?: string;
  country?: string;
  officialTrackLength?: number | null;
  driverName?: string;
  bestLapTime?: number | null;
  bestLapValid?: boolean | null;
}

export interface TrackSectorPoint {
  lat: number;
  lon: number;
  id: number;
}

export interface SessionMetadata {
  trackName: string | null;
  commonTrackName: string | null;
  trackAliases: string[] | null;
  country: string | null;
  trackLayout: string | null;
  layoutKey: string | null;
  officialTrackLength: number | null;
  carClass: string | null;
  modelName: string | null;
  rawCarName: string | null;
  driverName: string | null;
  sessionTime: string | null;
  sessionDuration: number;
  sessionType: string | null;
  weather: string | null;
  trackSectors: TrackSectorPoint[];
  fuelCapacity: number;
  tyreCompoundMax: number;
  steeringLock: number | null;
  steeringLockString: string | null;
}

export interface Track3DPoint {
  x: number;
  y: number;
  z: number;
  d: number;
  speed: number;
  throttle: number;
  brake: number;
  lat: number;
  width: number;
  in_pits: number;
  raw_lat: number;
  raw_lon: number;
}

export interface Track3DSectorPoint {
  id: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  z: number;
  dist: number;
  lat: number;
  lon: number;
  lateral: number;
  width: number;
}

export interface Track3DCenter {
  lat: number;
  lon: number;
  lonScale: number;
}

export interface Track3DResponse {
  baseMap: Track3DPoint[];
  racingLine: Track3DPoint[];
  trackName: string;
  trackLayout: string;
  layoutKey: string;
  fastestLap: number;
  selectedLapInfo: LapInfo;
  trackSectors: Track3DSectorPoint[];
  center: Track3DCenter;
  zBase: number;
}

export interface ElevationPoint {
  dist: number;
  alt: number;
  corner: string;
}

export interface TrackLayout {
  aliases: string[];
  ref_points: ElevationPoint[];
}

export interface TrackDefinition {
  display_name: string;
  aliases: string[];
  country: string;
  layouts: Record<string, TrackLayout>;
}

export function officialLength(layout: TrackLayout): number {
  return layout.ref_points.length === 0 ? 0 : layout.ref_points[layout.ref_points.length - 1].dist;
}
