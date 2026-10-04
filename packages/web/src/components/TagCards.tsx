/**
 * The few tags worth seeing from anywhere, as cards on the top bar.
 *
 * **3 October 2026, the owner:** *"i need to quick see tags of 'For Sale, For
 * Rent, Visit Done' in the main screen, so please adjust these tags with record
 * count at the top of Main Toolbar after IPROPY Company name, The Tag Designed
 * will be in Card format as per bar size … the Function should be according to
 * data, Click and filter/Show tags Data as per modules accordingly."*
 *
 * **No tag is named in this file.** The three he listed are *his* tags today,
 * and writing them in would mean the first tag an admin adds could never
 * appear here — the exact mistake `useRecordPanes` exists to prevent. The bar
 * shows the tags that are **most used**, which is what makes "For Sale" and
 * "Visit Done" rise to the top of a real database on their own, and what makes
 * a new tag arrive here the moment the team starts using it.
 *
 * The count is the tag's own `usage_count`, which the server already narrows to
 * live records of the module being asked about — the fix of 19 September 2026,
 * when a tag on two records read 229 because it was counting links.
 */
import { type JSX } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useNavigate, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { badgeVars } from '../lib/color';
import { cn } from '../lib/utils';

/**
 * How many cards the bar carries.
 *
 * Three, because that is the shape he drew and because a fourth starts
 * competing with the company name beside it on a 1280px laptop. The rest of
 * the tags are where they have always been: the list's own tag picker.
 */
const ON_THE_BAR = 3;

export function TagCards({ moduleName }: { moduleName?: string }): JSX.Element | null {
  const navigate = useNavigate();
  const location = useLocation();
  const { modules } = useApp();
  const entityModules = modules.filter((module) => module.isEntity && (!moduleName || module.name === moduleName));

  /** Which module this tag's card should open. */
  const moduleFor = (offered: string[]): string | null => {
    // Empty means every module, which is the seeded default.
    const allowed = offered.length ? offered : entityModules.map((module) => module.name);
    // The module already on screen, when the tag is offered there — clicking a
    // card while standing on Inventories should not jump to Contacts.
    const here = location.pathname.split('/')[1] ?? '';
    if (allowed.includes(here)) return here;
    return allowed.find((name) => entityModules.some((module) => module.name === name)) ?? null;
  };

  /*
    **Asked per module, because the number has to be the one the card opens.**

    3 October 2026, the owner: *"The for sale record count is display wrong,
    this should be actual as tagged in inventory."* `GET /api/tags` with no
    module counts every record carrying that tag across the whole CRM, so a
    card that opens Inventories was printing the Contacts rows as well. The
    server already narrows the count when it is told which module to count —
    it simply was never told.

    One small request per module, held for five minutes: tags change about as
    often as the team's vocabulary does.
  */
  const perModule = useQueries({
    queries: entityModules.map((module) => ({
      queryKey: ['tags', module.name],
      queryFn: () => api.tags(module.name),
      staleTime: 5 * 60_000,
    })),
  });

  /*
    One row per tag, counted in the module its card will open. A tag offered on
    both modules appears once — otherwise the bar would carry "For Sale" twice
    with two different numbers, which is worse than one number being wrong.
  */
  const byName = new Map<string, { id: string; name: string; color: string; count: number; module: string }>();
  entityModules.forEach((module, index) => {
    for (const tag of perModule[index]?.data ?? []) {
      if (moduleFor(tag.modules) !== module.name || tag.usage_count <= 0) continue;
      const already = byName.get(tag.name);
      if (!already || tag.usage_count > already.count) {
        byName.set(tag.name, { id: tag.id, name: tag.name, color: tag.color, count: tag.usage_count, module: module.name });
      }
    }
  });

  const cards = [...byName.values()].sort((a, b) => b.count - a.count).slice(0, moduleName ? undefined : ON_THE_BAR);
  if (!cards.length) return null;

  return (
    <div className="flex min-w-0 w-full items-center overflow-x-auto rounded-full border border-brand-200 bg-brand-50 divide-x divide-brand-300" data-testid="tag-cards">
      {cards.map((tag) => {
        const { module } = tag;
        const narrowed = location.pathname.startsWith(`/${module}`)
          && new URLSearchParams(location.search).get('tag') === tag.name;
        return (
          <button
            key={tag.id}
            type="button"
            /*
              A second click clears it. A card that can only ever narrow is one
              a rep has to go and find the toolbar to undo — the dead end the
              queue's own type filter already taught this repo about.
            */
            onClick={() => {
              const params = new URLSearchParams(location.pathname === `/${module}` ? location.search : '');
              if (narrowed) params.delete('tag'); else params.set('tag', tag.name);
              params.delete('page'); params.delete('open');
              navigate(`/${module}${params.size ? `?${params}` : ''}`);
            }}
            aria-pressed={narrowed}
            title={`${tag.name} — ${tag.count.toLocaleString('en-IN')} records${narrowed ? '. Click again to show all.' : ''}`}
            /*
              The colour is the admin's own, through `badgeVars` — which keeps
              the hue and moves lightness until the pair clears AA in both
              themes. A raw `${color}18` as a background with the same hue as
              text lands around 2–3:1, which is the rule this repo writes down
              every time somebody paints a tint by hand.
            */
            style={badgeVars(tag.color)}
            /*
              `.badge-tinted` rather than `bg-[var(--badge-bg)]`: the dark
              theme's values are separate properties, selected in the
              stylesheet. Writing the light one into a class would be perfect
              in light mode and unreadable in dark — which is only ever visible
              in a browser, in dark mode, on the element that has it.
            */
            className={cn(
              'badge-tinted flex shrink-0 items-center gap-2 border-0 px-2.5 py-1.5 text-left transition hover:brightness-95',
              narrowed ? 'font-bold underline underline-offset-4' : '',
            )}
          >
            <span className="min-w-0 truncate text-[11px] font-bold leading-tight">{tag.name}</span>
            <span className="badge-solid shrink-0 rounded-full px-1.5 text-[10px] font-bold leading-[1.1rem] tnum">
              {tag.count > 999 ? `${Math.floor(tag.count / 1000)}k` : tag.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
