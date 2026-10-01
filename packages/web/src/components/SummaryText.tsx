/**
 * An AI record summary, drawn as the three headings and their bullets it is
 * written in — "Who:", "Where it stands:", "Next steps to close:" — so a rep
 * reads it in seconds. A line that is neither a heading nor a bullet is shown
 * as it is, so an older summary written in sentences still reads fine.
 */
import { type JSX } from 'react';

export function SummaryText({ text }: { text: string }): JSX.Element {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  return (
    <div className="space-y-1" data-testid="ai-summary">
      {lines.map((line, index) => {
        const isHeading = /:$/.test(line) && line.length <= 40 && !/^[•\-*]/.test(line);
        const bullet = /^[•\-*]\s*/.exec(line);
        if (isHeading) {
          const closing = /next step/i.test(line);
          return (
            <p key={index} className={`pt-1.5 text-[11px] font-bold uppercase tracking-wide first:pt-0 ${closing ? 'text-emerald-700 dark:text-emerald-400' : 'text-brand-700 dark:text-brand-300'}`}>
              {line.replace(/:$/, '')}
            </p>
          );
        }
        if (bullet) {
          return (
            <p key={index} className="flex gap-2 text-sm leading-6">
              <span aria-hidden className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-50" />
              <span>{line.slice(bullet[0].length)}</span>
            </p>
          );
        }
        return <p key={index} className="text-sm leading-6">{line}</p>;
      })}
    </div>
  );
}
