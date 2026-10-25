/**
 * Ports FusionOptions.java (the record `FusionEngine.fuse` is called with).
 *
 * Java exposed the components as accessor methods (`options.targetFreq()`); here they
 * are readonly fields, like every other ported record. `trimStart`/`trimEnd` stay
 * `null` for "no trim" because a `0` trim would be a real timestamp, and the engine
 * uses `trimStart !== null` to decide whether sparse channels need a carry-over value.
 */
export class FusionOptions {
  readonly targetFreq: number;
  readonly trimStart: number | null;
  readonly trimEnd: number | null;

  constructor(targetFreq: number, trimStart?: number | null, trimEnd?: number | null) {
    this.targetFreq = targetFreq;
    this.trimStart = trimStart ?? null;
    this.trimEnd = trimEnd ?? null;
  }

  static of(targetFreq: number): FusionOptions {
    return new FusionOptions(targetFreq, null, null);
  }
}
