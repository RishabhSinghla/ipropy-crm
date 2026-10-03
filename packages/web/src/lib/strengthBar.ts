/**
 * The colour of the completeness bar, by how full it is.
 *
 * **3 October 2026, the owner:** *"in the bar strength we want different colour
 * in whole bar by percentage, if the pecentage below from 40% percentage then
 * the bar colour should be red till 40 %, then in between 40% to 70% the colour
 * will be yellow till 40% 70 % after the percentage of 70% it will be green
 * means All three colour will be there as per percentage."*
 *
 * So the boundaries belong to the **track**, not to the fill: red up to the
 * track's 40% mark, amber to its 70%, green after. A record at 85% therefore
 * shows all three bands, and one at 30% shows red alone — which is the whole
 * point of asking for it this way rather than one colour per grade.
 *
 * The fill is only `percent` of the track wide, so a boundary that sits at 40%
 * of the track is at `40 / percent` of the fill. That one division is the
 * entire trick, and it is here rather than in the component so a `node` test
 * can read it.
 */
const LOW = 'var(--strength-low)';
const MID = 'var(--strength-mid)';
const HIGH = 'var(--strength-high)';

/** Where the colour changes, as a share of the whole bar. */
export const STRENGTH_STOPS = { mid: 40, high: 70 } as const;

export function strengthFill(percent: number): string {
  const full = Math.max(0, Math.min(100, Math.round(percent)));
  if (full <= STRENGTH_STOPS.mid) return LOW;
  // Where each boundary lands inside the fill, which is `full`% of the track.
  const midAt = (STRENGTH_STOPS.mid / full) * 100;
  if (full <= STRENGTH_STOPS.high) {
    return `linear-gradient(to right, ${LOW} 0 ${midAt}%, ${MID} ${midAt}% 100%)`;
  }
  const highAt = (STRENGTH_STOPS.high / full) * 100;
  return `linear-gradient(to right, ${LOW} 0 ${midAt}%, ${MID} ${midAt}% ${highAt}%, ${HIGH} ${highAt}% 100%)`;
}
