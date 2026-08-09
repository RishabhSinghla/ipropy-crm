/**
 * Brochures — a listing becomes a PDF you can send on WhatsApp.
 *
 * The most-requested document on a property desk, and the one that always ends
 * up six months out of date because it lives in someone's Canva account. Here
 * it is generated from the record, so "send me the brochure" is a button and
 * the price on it is the price in the CRM.
 *
 * Pages are laid out in SVG and rasterised with sharp, then wrapped by our own
 * image-PDF writer. SVG because the layout logic is then the same shape as the
 * social templates, and because a text layout engine that agrees with itself
 * across three page types is worth more than one that supports selectable text.
 */
import sharp from 'sharp';
import { A4, buildImagePdf, type PdfPage } from './pdf.js';
import { getDriver } from '../storage/index.js';

/** 2× A4 at 72dpi — 150dpi-ish, sharp on a phone and fine for a print shop. */
const PAGE = { width: 1190, height: 1684 };

export interface BrochureSpec {
  title: string;
  subtitle?: string;
  price?: string;
  description?: string;
  facts: { label: string; value: string }[];
  highlights: string[];
  photos: { key: string; caption?: string }[];
  brandColour?: string;
  orgName?: string;
  phone?: string;
  website?: string;
}

export async function renderBrochure(spec: BrochureSpec, jobId: string): Promise<{ key: string; mime: string; pages: number }> {
  const brand = spec.brandColour ?? '#d99b4e';
  const driver = await getDriver();

  const photos: Buffer[] = [];
  for (const photo of spec.photos.slice(0, 7)) {
    const buffer = await loadPhoto(photo, driver);
    if (buffer) photos.push(buffer);
  }

  const pages: PdfPage[] = [];

  pages.push(await rasterise(await coverSvg(spec, brand, photos[0])));
  for (const page of detailsSvgs(spec, brand)) pages.push(await rasterise(page));
  if (photos.length > 1) {
    pages.push(await rasterise(await gallerySvg(photos.slice(1, 5), brand)));
  }
  pages.push(await rasterise(contactSvg(spec, brand)));

  const pdf = buildImagePdf(pages, A4);
  const key = `renders/brochure-${jobId}.pdf`;
  await driver.save(key, pdf, 'application/pdf');

  return { key, mime: 'application/pdf', pages: pages.length };
}

async function rasterise(svg: string): Promise<PdfPage> {
  const jpeg = await sharp(Buffer.from(svg))
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 88, chromaSubsampling: '4:4:4' })
    .toBuffer();
  return { jpeg, width: PAGE.width, height: PAGE.height };
}

async function loadPhoto(
  photo: { key: string },
  driver: Awaited<ReturnType<typeof getDriver>>,
): Promise<Buffer | null> {
  return driver.read(photo.key);
}

/**
 * Photos are inlined as base64 data URIs rather than referenced by path.
 *
 * librsvg (behind sharp) will not follow external hrefs, and enabling it would
 * mean an SVG could be pointed at any file on the host. Embedding keeps the
 * rendering hermetic.
 */
async function embed(buffer: Buffer, width: number, height: number): Promise<string> {
  const resized = await sharp(buffer)
    .resize(width, height, { fit: 'cover', position: 'attention' })
    .jpeg({ quality: 86 })
    .toBuffer();
  return `data:image/jpeg;base64,${resized.toString('base64')}`;
}

async function coverSvg(spec: BrochureSpec, brand: string, photo?: Buffer): Promise<string> {
  const { width: w, height: h } = PAGE;
  const photoHeight = Math.round(h * 0.58);
  const image = photo ? await embed(photo, w, photoHeight) : null;
  const titleLines = fitLines(spec.title, 26, 3);
  const titleStart = photoHeight + 130;
  const titleStep = 78;
  const titleLast = titleStart + (titleLines.length - 1) * titleStep;
  const subtitleY = titleLast + 80;
  const priceY = spec.subtitle ? subtitleY + 115 : titleLast + 115;

  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <rect width="${w}" height="${h}" fill="#ffffff"/>
    <rect width="${w}" height="${photoHeight}" fill="${esc(brand)}"/>
    ${image ? `<image x="0" y="0" width="${w}" height="${photoHeight}" xlink:href="${image}" preserveAspectRatio="xMidYMid slice"/>` : ''}
    <rect x="0" y="${photoHeight - 140}" width="${w}" height="140" fill="rgba(2,6,23,0.55)"/>
    <text x="${w * 0.07}" y="${photoHeight - 60}" font-family="Helvetica, Arial, sans-serif" font-size="34" letter-spacing="8" fill="#ffffff">${esc((spec.orgName ?? 'IPROPY').toUpperCase())}</text>

    ${titleLines.map((line, i) => `<text x="${w * 0.07}" y="${titleStart + i * titleStep}" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="66" fill="#0f172a">${esc(line)}</text>`).join('')}
    ${spec.subtitle ? `<text x="${w * 0.07}" y="${subtitleY}" font-family="Helvetica, Arial, sans-serif" font-size="36" fill="#475569">${esc(spec.subtitle)}</text>` : ''}
    ${spec.price ? `<text x="${w * 0.07}" y="${priceY}" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="72" fill="${esc(brand)}">${esc(spec.price)}</text>` : ''}
    <rect x="${w * 0.07}" y="${h - 130}" width="${w * 0.86}" height="4" fill="${esc(brand)}"/>
    <text x="${w * 0.07}" y="${h - 70}" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#64748b">${esc([spec.phone, spec.website].filter(Boolean).join('   |   '))}</text>
  </svg>`;
}

/** Flow details across as many A4 pages as the record needs; nothing is clipped. */
function detailsSvgs(spec: BrochureSpec, brand: string): string[] {
  const { width: w, height: h } = PAGE;
  const bottom = h - 100;
  const pages: string[][] = [];
  let fragments: string[] = [];
  let cursor = 180;

  const flush = (): void => {
    if (fragments.length) pages.push(fragments);
    fragments = [];
    cursor = 180;
  };
  const ensure = (needed: number): void => {
    if (cursor + needed > bottom && fragments.length) flush();
  };
  const heading = (text: string): void => {
    ensure(90);
    fragments.push(`<text x="${w * 0.07}" y="${cursor + 48}" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="44" fill="#0f172a">${esc(text)}</text>`);
    cursor += 82;
  };

  for (const fact of spec.facts) {
    const valueLines = lines(fact.value, 30);
    const rowHeight = Math.max(62, valueLines.length * 38 + 24);
    ensure(rowHeight);
    fragments.push(
      `<text x="${w * 0.07}" y="${cursor + 32}" font-family="Helvetica, Arial, sans-serif" font-size="30" fill="#64748b">${esc(fitText(fact.label, 28))}</text>`,
      ...valueLines.map((line, index) => `<text x="${w * 0.52}" y="${cursor + 32 + index * 38}" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="30" fill="#0f172a">${esc(line)}</text>`),
      `<rect x="${w * 0.07}" y="${cursor + rowHeight - 8}" width="${w * 0.86}" height="1" fill="#e2e8f0"/>`,
    );
    cursor += rowHeight;
  }

  if (spec.highlights.length) {
    cursor += 30;
    heading('Highlights');
    for (const highlight of spec.highlights) {
      const wrapped = lines(highlight, 58);
      const itemHeight = wrapped.length * 40 + 14;
      ensure(itemHeight);
      fragments.push(`<circle cx="${w * 0.085}" cy="${cursor + 20}" r="7" fill="${esc(brand)}"/>`);
      fragments.push(...wrapped.map((line, index) => `<text x="${w * 0.115}" y="${cursor + 30 + index * 40}" font-family="Helvetica, Arial, sans-serif" font-size="30" fill="#334155">${esc(line)}</text>`));
      cursor += itemHeight;
    }
  }

  if (spec.description?.trim()) {
    cursor += 30;
    heading('About this property');
    for (const line of lines(spec.description, 68)) {
      ensure(44);
      fragments.push(`<text x="${w * 0.07}" y="${cursor + 30}" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#475569">${esc(line)}</text>`);
      cursor += 44;
    }
  }

  flush();
  if (!pages.length) pages.push([]);
  return pages.map((content, index) => `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${w}" height="${h}" fill="#ffffff"/>
    <rect x="0" y="0" width="${w}" height="12" fill="${esc(brand)}"/>
    <text x="${w * 0.07}" y="110" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="52" fill="#0f172a">${index === 0 ? 'Specifications' : 'Property details (continued)'}</text>
    ${content.join('')}
    <text x="${w * 0.93}" y="${h - 45}" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="24" fill="#94a3b8">${index + 1} / ${pages.length}</text>
  </svg>`);
}

async function gallerySvg(photos: Buffer[], brand: string): Promise<string> {
  const { width: w, height: h } = PAGE;
  const pad = Math.round(w * 0.06);
  const cellW = Math.round((w - pad * 3) / 2);
  const cellH = Math.round(cellW * 0.75);

  const cells = await Promise.all(photos.slice(0, 4).map((photo) => embed(photo, cellW, cellH)));

  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <rect width="${w}" height="${h}" fill="#ffffff"/>
    <rect x="0" y="0" width="${w}" height="12" fill="${esc(brand)}"/>
    <text x="${pad}" y="130" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="52" fill="#0f172a">Gallery</text>
    ${cells.map((href, i) => {
      const x = pad + (i % 2) * (cellW + pad);
      const y = 200 + Math.floor(i / 2) * (cellH + pad);
      return `<image x="${x}" y="${y}" width="${cellW}" height="${cellH}" xlink:href="${href}" preserveAspectRatio="xMidYMid slice"/>`;
    }).join('')}
  </svg>`;
}

function contactSvg(spec: BrochureSpec, brand: string): string {
  const { width: w, height: h } = PAGE;
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${w}" height="${h}" fill="${esc(brand)}"/>
    <text x="${w * 0.08}" y="${h * 0.34}" font-family="Helvetica, Arial, sans-serif" font-size="34" letter-spacing="8" fill="rgba(255,255,255,0.8)">${esc((spec.orgName ?? 'IPROPY').toUpperCase())}</text>
    <text x="${w * 0.08}" y="${h * 0.45}" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="78" fill="#ffffff">Book a site visit</text>
    <text x="${w * 0.08}" y="${h * 0.53}" font-family="Helvetica, Arial, sans-serif" font-size="34" fill="rgba(255,255,255,0.88)">We will arrange a visit and walk you through every detail.</text>
    ${spec.phone ? `<text x="${w * 0.08}" y="${h * 0.66}" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="60" fill="#ffffff">${esc(spec.phone)}</text>` : ''}
    ${spec.website ? `<text x="${w * 0.08}" y="${h * 0.72}" font-family="Helvetica, Arial, sans-serif" font-size="32" fill="rgba(255,255,255,0.85)">${esc(spec.website)}</text>` : ''}
  </svg>`;
}

function lines(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of String(text ?? '').split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      out.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) out.push(line);
  return out;
}

function fitLines(text: string, maxChars: number, maxLines: number): string[] {
  const wrapped = lines(text, maxChars);
  if (wrapped.length <= maxLines) return wrapped;
  const visible = wrapped.slice(0, maxLines);
  visible[maxLines - 1] = `${visible[maxLines - 1].slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
  return visible;
}

function fitText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function esc(s: string | undefined): string {
  return String(s ?? '')
    .replace(/[\u00ad\u2010-\u2015]/g, '-')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
