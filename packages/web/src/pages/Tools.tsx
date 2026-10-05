import { useMemo, useState, type JSX } from 'react';
import { Calculator, Car, Download, Home, Landmark, Plus, Printer, Trash2 } from 'lucide-react';
import { calculateFloor, calculateLoan, defaultCharges, type Charge } from '../lib/calculators';
import { downloadCalculationPdf } from '../lib/calculatorPdf';
import { cn } from '../lib/utils';

type Tool = 'emi' | 'car' | 'personal' | 'floor';
const choices = [
  { id: 'emi' as const, name: 'EMI calculator', icon: Calculator },
  { id: 'car' as const, name: 'Car loan', icon: Car },
  { id: 'personal' as const, name: 'Personal loan', icon: Landmark },
  { id: 'floor' as const, name: 'Builder floor & charges', icon: Home },
];
const amount = (value: number) => value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pdfAmount = (value: number) => value.toFixed(2).padStart(13);

export default function Tools(): JSX.Element {
  const [tool, setTool] = useState<Tool>('emi');
  const [client, setClient] = useState('');
  const [reference, setReference] = useState('');
  const [exportError, setExportError] = useState('');
  const title = choices.find((choice) => choice.id === tool)!.name;
  const exportPdf = (lines: string[]) => {
    try {
      downloadCalculationPdf(['iPROPY - CLIENT CALCULATION', title, ...(`Client: ${client || '-'}`).match(/.{1,86}/g)!, ...(`Reference: ${reference || '-'}`).match(/.{1,86}/g)!, `Prepared: ${new Date().toLocaleDateString('en-GB')}`, '', ...lines, '', 'Estimate only. Confirm rates, taxes and fees before payment.', 'No bank offer or loan approval is implied.'], `ipropy-${tool}-calculation.pdf`);
      setExportError('');
    } catch (error) { setExportError((error as Error).message); }
  };
  const print = () => {
    const report = document.getElementById('calculator-report');
    const popup = window.open('', '_blank');
    if (!popup || !report) { setExportError('Allow pop-ups to print or save this report as PDF.'); return; }
    popup.document.title = `iPROPY - ${title}`;
    const style = popup.document.createElement('style');
    style.textContent = 'body{font:12px Arial;color:#111;padding:24px}table{border-collapse:collapse;width:100%;font-size:10px}th,td{padding:6px;text-align:left;border-bottom:1px solid #ddd}thead{display:table-header-group}tr{break-inside:avoid}h2{font-size:20px}button{display:none} @page{size:A4;margin:14mm}';
    popup.document.head.append(style);
    const heading = popup.document.createElement('h2'); heading.textContent = `iPROPY - ${title}`;
    const caption = popup.document.createElement('p'); caption.textContent = `Client: ${client || '-'} | Reference: ${reference || '-'} | ${new Date().toLocaleDateString('en-GB')}`;
    popup.document.body.append(heading, caption, popup.document.importNode(report, true));
    popup.focus(); popup.print();
  };
  return <div className="h-full overflow-y-auto bg-slate-50 p-4 dark:bg-slate-950 sm:p-6">
    <div className="mx-auto max-w-6xl space-y-5">
      <header><h1 className="flex items-center gap-2 text-xl font-bold"><Calculator className="h-6 w-6 text-brand-600" />Business tools</h1><p className="mt-1 text-sm text-muted">Calculate, review the full sheet, then download a PDF to share with your client.</p></header>
      <nav aria-label="Calculators" className="flex flex-wrap gap-2">{choices.map((choice) => <button key={choice.id} onClick={() => { setTool(choice.id); setExportError(''); }} aria-pressed={tool === choice.id} className={cn('flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold', tool === choice.id ? 'border-brand-500 bg-brand-100 text-brand-800 dark:bg-brand-950 dark:text-brand-200' : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900')}><choice.icon className="h-4 w-4" />{choice.name}</button>)}</nav>
      <div className="grid gap-4 sm:grid-cols-2"><TextField label="Client name (optional)" value={client} onChange={setClient} /><TextField label="Property / quotation reference (optional)" value={reference} onChange={setReference} /></div>
      <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900 sm:p-6">
        {tool === 'floor' ? <FloorCalculator exportPdf={exportPdf} print={print} /> : <LoanCalculator key={tool} tool={tool} exportPdf={exportPdf} print={print} />}
      </div>
      {exportError && <p role="alert" className="text-sm text-negative">{exportError}</p>}
      <p className="text-xs text-muted">Calculations stay in this browser; they do not change CRM records. PDFs download locally and are not sent automatically. Rates and charges are editable estimates; confirm the applicable terms with the lender or authority.</p>
    </div>
  </div>;
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="block text-sm font-medium">{label}<input className="input mt-1 w-full" maxLength={160} value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}
function NumberField({ label, value, onChange, max }: { label: string; value: number; onChange: (value: number) => void; max?: number }) {
  return <label className="block text-sm font-medium">{label}<input type="number" min="0" max={max} step="any" className="input mt-1 w-full" value={Number.isFinite(value) ? value : ''} onChange={(event) => onChange(event.target.value === '' ? NaN : Number(event.target.value))} /></label>;
}
function Actions({ download, print }: { download: () => void; print: () => void }) {
  return <div className="flex flex-wrap gap-2"><button className="btn-primary flex items-center gap-2" onClick={download}><Download className="h-4 w-4" />Download PDF</button><button className="btn-secondary flex items-center gap-2" onClick={print}><Printer className="h-4 w-4" />Print / Save PDF</button></div>;
}
function Metrics({ items }: { items: Array<[string, number]> }) {
  return <div className="my-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{items.map(([label, value]) => <div key={label} className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800"><p className="text-xs text-muted">{label}</p><p className="mt-1 text-lg font-bold tabular-nums">₹{amount(value)}</p></div>)}</div>;
}

function LoanCalculator({ tool, exportPdf, print }: { tool: Exclude<Tool, 'floor'>; exportPdf: (lines: string[]) => void; print: () => void }) {
  const [principal, setPrincipal] = useState(1000000);
  const [interest, setInterest] = useState(0);
  const [months, setMonths] = useState(tool === 'emi' ? 240 : 60);
  const calculation = useMemo(() => { try { return { result: calculateLoan(principal, interest, months), error: '' }; } catch (error) { return { error: (error as Error).message }; } }, [principal, interest, months]);
  const result = calculation.result;
  return <div className="space-y-4">
    <div className="grid gap-4 sm:grid-cols-3"><NumberField label="Loan principal (₹)" value={principal} onChange={setPrincipal} /><NumberField label="Annual interest (%)" value={interest} onChange={setInterest} max={100} /><NumberField label="Duration (months)" value={months} onChange={setMonths} max={600} /></div>
    <p className="text-xs text-muted">Enter your lender's rate. Fixed-rate monthly reducing balance; fees, insurance and prepayments are not included. The last EMI adjusts for rounding.</p>
    {calculation.error && <p role="alert" className="text-negative">{calculation.error}</p>}
    {result && <>
      <Actions print={print} download={() => exportPdf([`Principal: INR ${amount(result.principal)}`, `Annual interest: ${interest}% | Duration: ${months} months`, `Monthly EMI: INR ${amount(result.emi)}`, `Total interest: INR ${amount(result.totalInterest)}`, `Total repayment: INR ${amount(result.totalPayment)}`, 'Fixed-rate monthly reducing balance; fees and prepayments excluded.', 'Last payment adjusts for rounding.', '', 'Month       Opening           EMI     Principal      Interest       Balance', ...result.schedule.map((row) => `${String(row.month).padStart(5)} ${[row.opening, row.emi, row.principal, row.interest, row.balance].map(pdfAmount).join(' ')}`)])} />
      <div id="calculator-report"><p>Principal: ₹{amount(principal)} | Annual rate: {interest}% | Duration: {months} months</p><Metrics items={[["Monthly EMI", result.emi], ["Principal", result.principal], ["Total interest", result.totalInterest], ["Total repayment", result.totalPayment]]} />
        <h2 className="mb-3 font-semibold">Monthly repayment and balance sheet</h2>
        <div className="max-h-[480px] overflow-auto print:max-h-none"><table className="w-full text-right text-xs tabular-nums"><thead className="sticky top-0 bg-slate-100 dark:bg-slate-800"><tr>{['Month', 'Opening balance', 'EMI', 'Principal', 'Interest', 'Closing balance'].map((label) => <th key={label} className="whitespace-nowrap p-2">{label}</th>)}</tr></thead><tbody>{result.schedule.map((row) => <tr key={row.month} className="border-b border-slate-100 dark:border-slate-800"><td className="p-2">{row.month}</td>{[row.opening, row.emi, row.principal, row.interest, row.balance].map((value, index) => <td key={index} className="whitespace-nowrap p-2">{amount(value)}</td>)}</tr>)}</tbody></table></div>
        <p className="mt-3 text-xs text-muted">Estimate only. Fixed rate; fees and prepayments excluded. Final EMI adjusts for rounding.</p>
      </div>
    </>}
  </div>;
}

function FloorCalculator({ exportPdf, print }: { exportPdf: (lines: string[]) => void; print: () => void }) {
  const [flatCost, setFlatCost] = useState(0);
  const [area, setArea] = useState(0);
  const [registryValue, setRegistryValue] = useState(0);
  const [stampRate, setStampRate] = useState(6);
  const [feeBase, setFeeBase] = useState(0);
  const [feeRate, setFeeRate] = useState(0.5);
  const [charges, setCharges] = useState(defaultCharges);
  const update = (id: string, patch: Partial<Charge>) => setCharges((rows) => rows.map((row) => row.id === id ? { ...row, ...patch } : row));
  const calculation = useMemo(() => { try { return { result: calculateFloor({ flatCost, area, registryValue, stampRate, feeBase, feeRate, charges }), error: '' }; } catch (error) { return { error: (error as Error).message }; } }, [flatCost, area, registryValue, stampRate, feeBase, feeRate, charges]);
  const result = calculation.result;
  return <div className="space-y-5">
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"><NumberField label="Flat cost / deal amount (₹)" value={flatCost} onChange={setFlatCost} /><NumberField label="Calculation area (sq.ft)" value={area} onChange={setArea} /><NumberField label="Registry value for stamp duty (₹)" value={registryValue} onChange={setRegistryValue} /><NumberField label="Stamp duty (%)" value={stampRate} onChange={setStampRate} max={100} /><NumberField label="Registration fee base (₹)" value={feeBase} onChange={setFeeBase} /><NumberField label="Registration fee (%)" value={feeRate} onChange={setFeeRate} max={100} /></div>
    <p className="text-xs text-muted">Charge names and default rates follow your reference sheet, not current legal rates. Enter the exact calculation area (including decimals). Each extra charge rounds to whole rupees. Registry and registration-fee bases are separate, as in your sheet. Review sewer charges for plots over 250 sq.yd.</p>
    <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{['Charge', 'Rate (₹)', 'Quantity', 'GST %', ''].map((label, index) => <th key={index} className="p-2 text-left">{label}</th>)}</tr></thead><tbody>{charges.map((charge) => <tr key={charge.id}><td className="min-w-48 p-2"><input aria-label={`Charge name ${charge.id}`} className="input w-full" value={charge.label} maxLength={80} onChange={(event) => update(charge.id, { label: event.target.value })} /><span className="text-xs text-muted">{charge.group}</span></td>{(['rate', 'quantity', 'gst'] as const).map((field) => <td key={field} className="min-w-24 p-2"><input type="number" step="any" min="0" aria-label={`${charge.label} ${field}`} className="input w-full" value={Number.isFinite(charge.areaBased && field === 'quantity' ? area : charge[field]) ? charge.areaBased && field === 'quantity' ? area : charge[field] : ''} disabled={charge.areaBased && field === 'quantity'} onChange={(event) => update(charge.id, { [field]: event.target.value === '' ? NaN : Number(event.target.value) })} /></td>)}<td><button aria-label={`Remove ${charge.label}`} onClick={() => setCharges((rows) => rows.filter((row) => row.id !== charge.id))}><Trash2 className="h-4 w-4 text-muted" /></button></td></tr>)}</tbody></table></div>
    <button className="btn-secondary flex items-center gap-2" onClick={() => setCharges((rows) => [...rows, { id: crypto.randomUUID(), label: 'Additional charge', group: 'Other', rate: 0, quantity: 1, gst: 0 }])}><Plus className="h-4 w-4" />Add charge</button>
    {calculation.error && <p role="alert" className="text-negative">{calculation.error}</p>}
{result && <><Actions print={print} download={() => exportPdf([`Flat cost: INR ${amount(flatCost)}`, `Calculation area: ${area} sq.ft`, `Registry value: INR ${amount(registryValue)} | Stamp duty: ${stampRate}%`, `Registration fee base: INR ${amount(feeBase)} | Fee: ${feeRate}%`, 'Charge lines rounded to whole rupees. Editable reference-sheet rates.', '', ...result.lines.flatMap((line) => [line.label, `  ${line.rate} x ${line.quantity} + ${line.gst}% GST = INR ${amount(line.total)}`]), '', ...Object.entries(result.groups).map(([group, total]) => `${group}: INR ${amount(total)}`), `Additional charges: INR ${amount(result.additional)}`, `Flat cost + additional charges: INR ${amount(result.total)}`])} />
      <div id="calculator-report"><h2 className="font-semibold">Flat cost & additional charge sheet</h2><p className="mt-2 text-sm">Area: {area} sq.ft | Registry value: ₹{amount(registryValue)} | Stamp duty: {stampRate}% | Fee base: ₹{amount(feeBase)} at {feeRate}%</p><Metrics items={[["Flat cost", flatCost], ["Additional charges", result.additional], ["Total estimated cost", result.total]]} />
        <table className="w-full text-sm"><thead><tr>{['Particulars', 'Rate', 'Quantity / multiplier', 'GST %', 'Total (₹)'].map((label) => <th key={label} className="p-2 text-left">{label}</th>)}</tr></thead><tbody>{result.lines.map((line) => <tr key={line.id} className="border-b border-slate-100 dark:border-slate-800"><td className="p-2">{line.label}</td><td className="p-2">{amount(line.rate)}</td><td className="p-2">{line.quantity}</td><td className="p-2">{line.gst}%</td><td className="p-2 text-right tabular-nums">{amount(line.total)}</td></tr>)}</tbody></table>
        {Object.entries(result.groups).map(([group, total]) => <p key={group} className="mt-2 flex justify-between text-sm font-semibold"><span>{group}</span><span>₹{amount(total)}</span></p>)}<p className="mt-4 text-xs text-muted">Estimate only. Verify taxes, rates and applicable charges before payment.</p>
      </div>
    </>}
  </div>;
}
