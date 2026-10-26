import { type JSX, useEffect, useState } from 'react';
import { formatIndianPrice } from '@ipropy/shared';
import { parseTypedAmount, sliderStep } from '../lib/quickFilters';

const THUMB = 'pointer-events-none absolute inset-x-0 top-1/2 h-1 w-full -translate-y-1/2 appearance-none bg-transparent '
  + '[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-brand-600 [&::-webkit-slider-thumb]:shadow '
  + '[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:bg-brand-600';

/** A two-ended range control with numeric fields for exact values. */
export function RangeSlider({ low, high, money, min, max, onChange }: {
  low: number; high: number; money: boolean; min?: number; max?: number;
  onChange: (min: number | undefined, max: number | undefined) => void;
}): JSX.Element {
  const step = sliderStep(low, high);
  const clamp = (value: number): number => Math.min(high, Math.max(low, value));
  const [from, setFrom] = useState(clamp(min ?? low));
  const [to, setTo] = useState(clamp(max ?? high));
  const [minText, setMinText] = useState(min != null ? String(min) : '');
  const [maxText, setMaxText] = useState(max != null ? String(max) : '');
  useEffect(() => {
    setFrom(clamp(min ?? low)); setTo(clamp(max ?? high));
    setMinText(min != null ? String(min) : ''); setMaxText(max != null ? String(max) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [min, max, low, high]);
  const show = (value: number): string => (money ? formatIndianPrice(value) : value.toLocaleString('en-IN'));
  const commit = (): void => onChange(from > low ? from : undefined, to < high ? to : undefined);
  const commitTyped = (): void => {
    let typedMin = parseTypedAmount(minText);
    let typedMax = parseTypedAmount(maxText);
    if (typedMin != null && typedMax != null && typedMin > typedMax) [typedMin, typedMax] = [typedMax, typedMin];
    if (typedMin === min && typedMax === max) return;
    onChange(typedMin, typedMax);
  };
  const percent = (value: number): number => ((value - low) / (high - low)) * 100;
  const typedHint = (text: string): string | null => {
    const value = parseTypedAmount(text);
    if (!text.trim()) return null;
    return value == null ? 'Not a number' : show(value);
  };
  const box = (label: string, text: string, setText: (value: string) => void, placeholder: string): JSX.Element => (
    <label className="min-w-0 flex-1">
      <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</span>
      <input type="text" inputMode="decimal" value={text} placeholder={placeholder} aria-label={`${label} ${money ? 'amount' : 'size'}`}
        onChange={(event) => setText(event.target.value)} onBlur={commitTyped}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitTyped(); } }}
        className="input mt-0.5 h-7 w-full px-2 py-0 text-[11px] tabular-nums" />
      <span className="mt-0.5 block h-3.5 truncate text-[10px] text-muted">{typedHint(text)}</span>
    </label>
  );
  return (
    <div className="px-4 pb-1 pt-2" data-testid="range-slider">
      <div className="relative h-5">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-slate-200 dark:bg-slate-700" />
        <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-brand-600" style={{ left: `${percent(from)}%`, right: `${100 - percent(to)}%` }} />
        <input type="range" min={low} max={high} step={step} value={from} aria-label="Lowest" className={THUMB}
          onChange={(event) => { const value = Math.min(Number(event.target.value), to); setFrom(value); setMinText(value > low ? String(value) : ''); }} onPointerUp={commit} onKeyUp={commit} />
        <input type="range" min={low} max={high} step={step} value={to} aria-label="Highest" className={THUMB}
          onChange={(event) => { const value = Math.max(Number(event.target.value), from); setTo(value); setMaxText(value < high ? String(value) : ''); }} onPointerUp={commit} onKeyUp={commit} />
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] font-semibold tabular-nums text-slate-700 dark:text-slate-200"><span>{show(from)}</span><span className="text-muted">to</span><span>{show(to)}</span></div>
      <div className="mt-1.5 flex items-start gap-2">{box('Min', minText, setMinText, money ? 'e.g. 50 lakh' : show(low))}<span className="mt-5 text-[11px] text-muted">–</span>{box('Max', maxText, setMaxText, money ? 'e.g. 1.5 cr' : show(high))}</div>
      {(min != null || max != null) && <button type="button" onClick={() => { setFrom(low); setTo(high); setMinText(''); setMaxText(''); onChange(undefined, undefined); }} className="mt-1 text-[10px] font-semibold text-brand-700 hover:underline dark:text-brand-300">Any {money ? 'amount' : 'size'}</button>}
    </div>
  );
}
