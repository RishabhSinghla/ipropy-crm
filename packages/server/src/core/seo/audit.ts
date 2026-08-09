/**
 * Daily SEO / AEO / GEO audit of the public website.
 *
 * Three different audiences read the same pages and want different things:
 *
 *  * **SEO** — classic crawlers: a unique title of sensible length, a meta
 *    description, one h1, a canonical, an OG image.
 *  * **AEO** (answer engines) — structured data they can quote: JSON-LD, and
 *    for articles a FAQ block and a self-contained answer sentence.
 *  * **GEO** (generative engines) — an llms.txt map and content that states
 *    facts plainly enough to be lifted.
 *
 * This checks what is actually served, by fetching the live pages. Auditing our
 * own templates would only ever confirm that the template is what we wrote; it
 * would not catch a post published with an empty excerpt, a listing whose title
 * runs to 90 characters, or a sitemap that has quietly stopped including blog
 * routes — which are the failures that really happen.
 *
 * Findings are stored, not emailed: a score that moves is the useful signal,
 * and a daily mail nobody reads is not.
 */
import { db } from '../../db/pool.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';

export interface SeoFinding {
  url: string;
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}

export interface SeoAuditResult {
  siteUrl: string;
  pagesChecked: number;
  score: number;
  findings: SeoFinding[];
  checkedAt: string;
}

/** Google truncates around 60 characters; under 30 is usually a stub. */
const TITLE_MIN = 25;
const TITLE_MAX = 60;
const DESC_MIN = 70;
const DESC_MAX = 160;

function textBetween(html: string, pattern: RegExp): string | null {
  const m = pattern.exec(html);
  return m ? m[1].trim() : null;
}

function auditPage(url: string, html: string): SeoFinding[] {
  const findings: SeoFinding[] = [];
  const add = (severity: SeoFinding['severity'], code: string, message: string): void => {
    findings.push({ url, severity, code, message });
  };

  const title = textBetween(html, /<title[^>]*>([^<]*)<\/title>/i);
  if (!title) add('error', 'title_missing', 'No <title>.');
  else if (title.length > TITLE_MAX) add('warning', 'title_long', `Title is ${title.length} characters; search results cut off around ${TITLE_MAX}.`);
  else if (title.length < TITLE_MIN) add('warning', 'title_short', `Title is only ${title.length} characters — likely too thin to rank for anything specific.`);

  const desc = textBetween(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
  if (!desc) add('error', 'description_missing', 'No meta description, so search engines will invent one from the page text.');
  else if (desc.length > DESC_MAX) add('info', 'description_long', `Meta description is ${desc.length} characters; usually truncated after ${DESC_MAX}.`);
  else if (desc.length < DESC_MIN) add('warning', 'description_short', `Meta description is only ${desc.length} characters.`);

  const h1Count = (html.match(/<h1[\s>]/gi) ?? []).length;
  if (h1Count === 0) add('error', 'h1_missing', 'No <h1> — nothing states what this page is about.');
  else if (h1Count > 1) add('warning', 'h1_multiple', `${h1Count} <h1> elements; there should be one.`);

  if (!/rel=["']canonical["']/i.test(html)) {
    add('warning', 'canonical_missing', 'No canonical URL, so query-string variants can be indexed as duplicates.');
  }

  if (!/property=["']og:image["']/i.test(html)) {
    add('info', 'og_image_missing', 'No og:image, so shares on WhatsApp and social render without a preview.');
  }

  // AEO: structured data is what gets quoted rather than merely ranked.
  if (!/application\/ld\+json/i.test(html)) {
    add('warning', 'schema_missing', 'No JSON-LD structured data, so answer engines have nothing precise to quote.');
  }

  // Images without alt text are both an accessibility failure and lost context.
  const imgs = html.match(/<img\b[^>]*>/gi) ?? [];
  const missingAlt = imgs.filter((tag) => !/\balt=/i.test(tag)).length;
  if (missingAlt > 0) {
    add('warning', 'img_alt_missing', `${missingAlt} of ${imgs.length} images have no alt text.`);
  }

  return findings;
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'iPropy-SEO-Audit/1.0' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Audit the site's own key pages plus every published post.
 *
 * `siteUrl` comes from settings so the audit follows the real domain rather
 * than a constant that goes stale the day the site moves.
 */
export async function runSeoAudit(): Promise<SeoAuditResult | null> {
  const setting = await db.queryOne<{ value: string }>(
    `SELECT value #>> '{}' AS value FROM ipy_setting WHERE key = 'seo.site_url'`,
  );
  const siteUrl = (setting?.value || '').replace(/\/+$/, '');
  if (!siteUrl) {
    logger.debug('SEO audit skipped — seo.site_url is not set');
    return null;
  }

  const posts = await db.query<{ slug: string }>(
    `SELECT NULL::text AS slug WHERE false -- blog removed in migration 030
     WHERE r.is_deleted = false AND b.status = 'Published' AND b.slug IS NOT NULL
       AND b.published_at <= now() AND b.noindex = false
     ORDER BY b.published_at DESC LIMIT 40`,
  );

  const paths = ['/', '/projects', '/properties', '/blog', ...posts.rows.map((p) => `/blog/${p.slug}`)];
  const findings: SeoFinding[] = [];
  let checked = 0;

  for (const path of paths) {
    const html = await fetchPage(`${siteUrl}${path}`);
    if (html === null) {
      findings.push({ url: path, severity: 'error', code: 'unreachable', message: 'Page did not respond.' });
      continue;
    }
    checked += 1;
    findings.push(...auditPage(path, html));
  }

  // Site-wide files. Their absence is invisible day to day and expensive.
  for (const [path, code, message] of [
    ['/sitemap.xml', 'sitemap_missing', 'No sitemap.xml — crawlers have to discover every page by following links.'],
    ['/robots.txt', 'robots_missing', 'No robots.txt.'],
    ['/llms.txt', 'llms_missing', 'No llms.txt — AI assistants have no map of what this site covers.'],
  ] as const) {
    const body = await fetchPage(`${siteUrl}${path}`);
    if (body === null) findings.push({ url: path, severity: path === '/llms.txt' ? 'info' : 'error', code, message });
    else if (path === '/sitemap.xml' && posts.rows.length > 0 && !body.includes('/blog/')) {
      findings.push({ url: path, severity: 'warning', code: 'sitemap_missing_blog', message: 'Sitemap does not list any blog posts.' });
    }
  }

  // Errors cost more than warnings, and the floor is zero rather than negative
  // so a bad day still produces a comparable number.
  const penalty = findings.reduce((n, f) => n + (f.severity === 'error' ? 8 : f.severity === 'warning' ? 3 : 1), 0);
  const score = Math.max(0, 100 - penalty);

  const result: SeoAuditResult = {
    siteUrl,
    pagesChecked: checked,
    score,
    findings,
    checkedAt: new Date().toISOString(),
  };

  await db.query(
    `INSERT INTO ipy_seo_audit (site_url, pages_checked, score, findings) VALUES ($1,$2,$3,$4)`,
    [siteUrl, checked, score, JSON.stringify(findings)],
  );
  // 90 days is enough to see a trend and short enough to stay small.
  await db.query(`DELETE FROM ipy_seo_audit WHERE checked_at < now() - interval '90 days'`).catch(() => undefined);

  logger.info({ score, pages: checked, findings: findings.length }, 'SEO audit complete');
  return result;
}

/** Has today's audit already run? The scheduler ticks every minute. */
export async function shouldRunSeoAudit(): Promise<boolean> {
  const row = await db.queryOne<{ checked_at: string }>(
    `SELECT checked_at FROM ipy_seo_audit ORDER BY checked_at DESC LIMIT 1`,
  );
  if (!row) return true;
  const hours = (Date.now() - new Date(row.checked_at).getTime()) / 3_600_000;
  return hours >= 24;
}

export { config as seoConfig };
