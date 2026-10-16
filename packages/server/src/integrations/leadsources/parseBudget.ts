/** Reads a budget a person typed or picked: "1.7 cr to 2 cr", "50L-75L", "85 lakh". */
export function parseBudget(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/_/g, ' ').replace(/[₹,\s]/gi, '').toLowerCase().replace(/(cr|crore|l|lac|lakh)\./g, '$1');
  // Ranges like "50L-75L" — take the upper bound as the ceiling.
  const range = cleaned.match(/([\d.]+)\s*(cr|crore|l|lac|lakh)?\s*[-–to]+\s*([\d.]+)\s*(cr|crore|l|lac|lakh)?/);
  if (range) return toRupees(range[3], range[4] ?? range[2]);
  const single = cleaned.match(/([\d.]+)\s*(cr|crore|l|lac|lakh|k)?/);
  if (single) return toRupees(single[1], single[2]);
  return undefined;
}

function toRupees(num: string, unit?: string): number | undefined {
  const n = Number(num);
  if (!Number.isFinite(n)) return undefined;
  switch (unit) {
    case 'cr': case 'crore': return n * 10_000_000;
    case 'l': case 'lac': case 'lakh': return n * 100_000;
    case 'k': return n * 1000;
    default: return n > 10_000 ? n : n * 100_000; // bare small numbers read as lakhs
  }
}
