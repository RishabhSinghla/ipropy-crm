export type Instalment = { month: number; opening: number; emi: number; principal: number; interest: number; balance: number };
export type LoanCalculation = { emi: number; principal: number; totalInterest: number; totalPayment: number; schedule: Instalment[] };
const money = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

/** Fixed-rate, monthly reducing balance. The final payment clears rounding residue. */
export function calculateLoan(principal: number, annualRate: number, months: number): LoanCalculation {
  if (!Number.isFinite(principal) || principal <= 0 || principal > 1e12) throw new Error('Enter a loan amount greater than zero and no more than 1 lakh crore.');
  if (!Number.isFinite(annualRate) || annualRate < 0 || annualRate > 100) throw new Error('Annual interest must be between 0 and 100%.');
  if (!Number.isInteger(months) || months < 1 || months > 600) throw new Error('Loan duration must be 1 to 600 whole months.');
  principal = money(principal);
  if (principal <= 0) throw new Error('Loan amount must be at least 0.01.');
  const rate = annualRate / 1200;
  const emi = money(rate ? principal * rate / -Math.expm1(-months * Math.log1p(rate)) : principal / months);
  let balance = principal;
  const schedule: Instalment[] = [];
  for (let month = 1; month <= months; month += 1) {
    const opening = balance;
    const interest = money(opening * rate);
    const payment = month === months ? money(opening + interest) : Math.min(emi, money(opening + interest));
    const paidPrincipal = money(payment - interest);
    balance = Math.max(0, money(opening - paidPrincipal));
    schedule.push({ month, opening, emi: payment, principal: paidPrincipal, interest, balance });
  }
  const totalInterest = money(schedule.reduce((total, row) => total + row.interest, 0));
  return { emi, principal, totalInterest, totalPayment: money(principal + totalInterest), schedule };
}

export type Charge = { id: string; label: string; group: string; rate: number; quantity: number; gst: number; areaBased?: boolean };
/** Reference-sheet defaults, not a claim about current statutory or provider rates. */
export function defaultCharges(): Charge[] {
  return [
    ['water', 'Water connection', 'Water, sewer & mutation', 2500, 1, 18],
    ['water-security', 'Water security', 'Water, sewer & mutation', 2500, 1, 0],
    ['road', 'Road cutting', 'Water, sewer & mutation', 2500, 1, 18],
    ['water-bill', 'Advance water bill', 'Water, sewer & mutation', 600, 3, 0],
    ['sewer', 'Sewer connection (up to 250 sq.yd)', 'Water, sewer & mutation', 2500, 1, 18],
    ['sewer-security', 'Sewer security (up to 250 sq.yd)', 'Water, sewer & mutation', 2500, 1, 0],
    ['mutation', 'Mutation / incidental (per sq.ft)', 'Water, sewer & mutation', 50, 0, 18],
    ['security', 'Security charges', 'Water, sewer & mutation', 100, 72, 18],
    ['electricity-security', 'Electricity security', 'Electricity', 30000, 1, 0],
    ['meter', 'Three-phase meter connection', 'Electricity', 23000, 1, 0],
    ['lift', 'Common lift meter connection', 'Electricity', 25000, 1, 0],
    ['advocate', 'Advocate fee', 'Registration', 12000, 1, 0],
  ].map(([id, label, group, rate, quantity, gst]) => ({ id: String(id), label: String(label), group: String(group), rate: Number(rate), quantity: Number(quantity), gst: Number(gst), areaBased: id === 'mutation' }));
}

export function chargeTotal(charge: Charge, area: number): number {
  const quantity = charge.areaBased ? area : charge.quantity;
  if ([charge.rate, quantity, charge.gst].some((value) => !Number.isFinite(value) || value < 0) || charge.gst > 100) throw new Error('Charge rates and quantities must be non-negative; GST must be 0 to 100%.');
  // The reference sheet rounds each charge to whole rupees before adding subtotals.
  return Math.round(charge.rate * quantity * (1 + charge.gst / 100));
}

export function calculateFloor(input: { flatCost: number; area: number; registryValue: number; stampRate: number; feeBase: number; feeRate: number; charges: Charge[] }) {
  const { flatCost, area, registryValue, stampRate, feeBase, feeRate, charges } = input;
  if ([flatCost, area, registryValue, stampRate, feeBase, feeRate].some((value) => !Number.isFinite(value) || value < 0) || stampRate > 100 || feeRate > 100) throw new Error('Enter non-negative amounts and percentages between 0 and 100.');
  const lines = charges.map((charge) => ({ ...charge, quantity: charge.areaBased ? area : charge.quantity, total: chargeTotal(charge, area) }));
  lines.push({ id: 'stamp', label: 'Stamp duty', group: 'Registration', rate: registryValue, quantity: stampRate / 100, gst: 0, total: Math.round(registryValue * stampRate / 100) });
  lines.push({ id: 'registry', label: 'Registration / stamp fee', group: 'Registration', rate: feeBase, quantity: feeRate / 100, gst: 0, total: Math.round(feeBase * feeRate / 100) });
  const groups: Record<string, number> = {};
  for (const line of lines) groups[line.group] = (groups[line.group] ?? 0) + line.total;
  const additional = lines.reduce((total, line) => total + line.total, 0);
  return { lines, groups, additional, total: money(flatCost + additional) };
}
