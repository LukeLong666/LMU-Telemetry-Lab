/**
 * Ports ElevationFusion.java — turns the track's reference elevation profile into a
 * `WorldPosZ` channel by re-scaling the per-lap distance onto the profile, anchoring the
 * first sample to the profile's start altitude and de-trending the residual drift, then
 * moving-average and spike-filtering the result.
 *
 * This runs on the *normalised* Lap Dist, which is why the engine calls it after the
 * distance build, and it is synchronous: the registry lookup and every arithmetic step
 * are pure CPU, exactly like the Java version.
 */
import type { TrackDefinition } from '../../domain/types.js';
import type { TrackRegistry } from '../track/track-registry.js';
import { interp, uniqueFirst } from './fusion-math.js';

export function computeZ(
  lat: Float64Array | null,
  /** Java never reads `lon`; it is only part of the signature. Kept for parity. */
  lon: Float64Array | null,
  distance: Float64Array | null,
  trackName: string | null,
  trackLayout: string | null,
  registry: TrackRegistry,
): Float64Array {
  const size = lat === null || lat === undefined ? 0 : lat.length;
  if (size === 0 || distance === null || distance === undefined || distance.length === 0) {
    return new Float64Array(size);
  }
  const trackMatch = registry.findTrack(trackName);
  if (trackMatch === null) {
    return new Float64Array(size);
  }
  const track: TrackDefinition = trackMatch.definition;
  const layoutMatch = registry.findLayout(track, trackLayout, trackMatch.key);
  if (layoutMatch === null || layoutMatch.layout.ref_points.length === 0) {
    return new Float64Array(size);
  }
  const layout = layoutMatch.layout;
  const xp = new Float64Array(layout.ref_points.length);
  const fp = new Float64Array(layout.ref_points.length);
  for (let i = 0; i < xp.length; i++) {
    xp[i] = layout.ref_points[i].dist;
    fp[i] = layout.ref_points[i].alt;
  }

  const cleaned = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    cleaned[i] = Number.isNaN(distance[i]) ? 0.0 : distance[i];
  }
  const cd = uniqueFirst(cleaned);
  if (cd.length < 2) {
    return new Float64Array(size);
  }
  const telD = new Float64Array(cd.length);
  for (let i = 0; i < cd.length; i++) {
    telD[i] = cd[i] - cd[0];
  }
  // Java `Arrays.stream(telD).max().orElse(0.0)`; empty input would yield 0.0.
  let maxTelD = telD.length === 0 ? 0.0 : telD[0];
  for (let i = 1; i < telD.length; i++) {
    maxTelD = Math.max(maxTelD, telD[i]);
  }
  if (!(maxTelD > 1.0)) {
    return new Float64Array(size);
  }
  const refMax = xp[xp.length - 1];
  const zRaw = new Float64Array(cd.length);
  for (let i = 0; i < cd.length; i++) {
    const normalized = (telD[i] / maxTelD) * refMax;
    zRaw[i] = interp(xp, fp, Math.max(0.0, Math.min(refMax, normalized)));
  }
  const offset = fp[0] - zRaw[0];
  const error = fp[fp.length - 1] - zRaw[zRaw.length - 1];
  const zCorrected = new Float64Array(zRaw.length);
  for (let i = 0; i < zRaw.length; i++) {
    const fraction = zRaw.length === 1 ? 0.0 : i / (zRaw.length - 1);
    zCorrected[i] = zRaw[i] + offset + (error - offset) * fraction;
  }

  const zFull = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    zFull[i] = interp(cd, zCorrected, cleaned[i]);
  }

  const window = Math.min(40, size);
  let smoothed: Float64Array;
  if (window > 1) {
    const pad = Math.trunc(window / 2);
    // Edge-replicated padding: Java clamped the source index instead of using np.pad.
    const padded = new Float64Array(size + pad * 2);
    for (let i = 0; i < padded.length; i++) {
      const source = Math.max(0, Math.min(size - 1, i - pad));
      padded[i] = zFull[source];
    }
    smoothed = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      let sum = 0.0;
      for (let j = 0; j < window; j++) {
        sum += padded[i + j];
      }
      smoothed[i] = sum / window;
    }
  } else {
    smoothed = zFull;
  }

  return spikeFilter(smoothed);
}

/** Drops single-sample dips more than 5 m below both neighbours (GPS noise, not a hill). */
function spikeFilter(z: Float64Array): Float64Array {
  const safe = z.slice();
  const n = safe.length;
  if (n > 2) {
    if (safe[0] < safe[1] - 5.0) {
      safe[0] = safe[1];
    }
    for (let i = 1; i < n - 1; i++) {
      const average = (safe[i - 1] + safe[i + 1]) / 2.0;
      if (safe[i] < average - 5.0) {
        safe[i] = average;
      }
    }
    if (safe[n - 1] < safe[n - 2] - 5.0) {
      safe[n - 1] = safe[n - 2];
    }
  }
  return safe;
}
