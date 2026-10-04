/** Solid score colour: red below 50, yellow through 70, green above 70. */
const LOW = 'var(--strength-low)';
const MID = 'var(--strength-mid)';
const HIGH = 'var(--strength-high)';

/** Where the colour changes, as a share of the whole bar. */
export const STRENGTH_STOPS = { mid: 50, high: 70 } as const;

export function strengthFill(percent: number): string {
  const full = Math.max(0, Math.min(100, Math.round(percent)));
  if (full < STRENGTH_STOPS.mid) return LOW;
  if (full <= STRENGTH_STOPS.high) {
    return MID;
  }
  return HIGH;
}
