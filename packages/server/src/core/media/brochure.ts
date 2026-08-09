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
import { logger } from '../../utils/logger.js';

/** 2× A4 at 72dpi — 150dpi-ish, sharp on a phone and fine for a print shop. */
const PAGE = { width: 1190, height: 1684 };

export interface BrochureSpec {
  title: string;
  subtitle?: string;
  price?: string;
  description?: string;
  facts: { label: string; value: string }[];
  highlights: string[];
  photos: { key?: string; url?: string; caption?: string }[];
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
  pages.push(await rasterise(detailsSvg(spec, brand)));
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
  photo: { key?: string; url?: string },
  driver: Awaited<ReturnType<typeof getDriver>>,
): Promise<Buffer | null> {
  try {
    if (photo.key) {
      const buffer = await driver.read(photo.key);
      if (buffer) return buffer;
    }
    if (photo.url && /^https?:\/\//i.test(photo.url)) {
      const res = await fetch(photo.url, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
    }
  } catch (err) {
    logger.warn({ err }, 'brochure: could not load a photo');
  }
  return null;
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
  const photoHeight = Math.round(h * 0.62);
  const image = photo ? await embed(photo, w, photoHeight) : null;

  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <rect width="${w}" height="${h}" fill="#ffffff"/>
    <rect width="${w}" height="${photoHeight}" fill="${esc(brand)}"/>
    ${image ? `<image x="0" y="0" width="${w}" height="${photoHeight}" xlink:href="${image}" preserveAspectRatio="xMidYMid slice"/>` : ''}
    <rect x="0" y="${photoHeight - 140}" width="${w}" height="140" fill="rgba(2,6,23,0.55)"/>
    <text x="${w * 0.07}" y="${photoHeight - 60}" font-family="Helvetica, Arial, sans-serif" font-size="34" letter-spacing="8" fill="#ffffff">${esc((spec.orgName ?? 'IPROPY').toUpperCase())}</text>

    ${lines(spec.title, 26).map((line, i) => `<text x="${w * 0.07}" y="${photoHeight + 130 + i * 78}" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="66" fill="#0f172a">${esc(line)}</text>`).join('')}
    ${spec.subtitle ? `<text x="${w * 0.07}" y="${photoHeight + 240}" font-family="Helvetica, Arial, sans-serif" font-size="36" fill="#475569">${esc(spec.subtitle)}</text>` : ''}
    ${spec.price ? `<text x="${w * 0.07}" y="${photoHeight + 350}" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="72" fill="${esc(brand)}">${esc(spec.price)}</text>` : ''}
    <rect x="${w * 0.07}" y="${h - 130}" width="${w * 0.86}" height="4" fill="${esc(brand)}"/>
    <text x="${w * 0.07}" y="${h - 70}" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#64748b">${esc([spec.phone, spec.website].filter(Boolean).join('   ·   '))}</text>
  </svg>`;
}

function detailsSvg(spec: BrochureSpec, brand: string): string {
  const { width: w, height: h } = PAGE;
  const factRows = spec.facts.slice(0, 10);
  const descriptionLines = lines(spec.description ?? '', 62).slice(0, 8);

  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${w}" height="${h}" fill="#ffffff"/>
    <rect x="0" y="0" width="${w}" height="12" fill="${esc(brand)}"/>
    <text x="${w * 0.07}" y="130" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="52" fill="#0f172a">Specifications</text>

    ${factRows.map((fact, i) => `
      <text x="${w * 0.07}" y="${220 + i * 62}" font-family="Helvetica, Arial, sans-serif" font-size="30" fill="#64748b">${esc(fact.label)}</text>
      <text x="${w * 0.52}" y="${220 + i * 62}" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="30" fill="#0f172a">${esc(fact.value)}</text>
      <rect x="${w * 0.07}" y="${236 + i * 62}" width="${w * 0.86}" height="1" fill="#e2e8f0"/>
    `).join('')}

    ${spec.highlights.length ? `<text x="${w * 0.07}" y="${260 + factRows.length * 62 + 60}" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="44" fill="#0f172a">Highlights</text>` : ''}
    ${spec.highlights.slice(0, 8).map((highlight, i) => `
      <circle cx="${w * 0.085}" cy="${260 + factRows.length * 62 + 115 + i * 52}" r="7" fill="${esc(brand)}"/>
      <text x="${w * 0.115}" y="${260 + factRows.length * 62 + 126 + i * 52}" font-family="Helvetica, Arial, sans-serif" font-size="30" fill="#334155">${esc(highlight)}</text>
    `).join('')}

    ${descriptionLines.map((line, i) => `<text x="${w * 0.07}" y="${h - 300 + i * 42}" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#475569">${esc(line)}</text>`).join('')}
  </svg>`;
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
    <text x="${w * 0.08}" y="${h * 0.53}" font-family="Helvetica, Arial, sans-serif" font-size="34" fill="rgba(255,255,255,0.88)">We will arrange pickup and walk you through every floor.</text>
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

function esc(s: string | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
