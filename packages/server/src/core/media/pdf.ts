/**
 * A minimal PDF writer for image-only documents.
 *
 * Every brochure page is already a rendered raster — the layout is done in SVG
 * and rasterised by sharp — so the only thing a PDF library would add here is a
 * dependency and a second layout engine to disagree with the first.
 *
 * PDF supports JPEG natively through the `DCTDecode` filter, which means a page
 * is literally the JPEG bytes wrapped in an object header. No re-encoding, no
 * quality loss, no third-party code in the path.
 *
 * The fiddly part is the cross-reference table: it is a list of byte offsets
 * into the file, and a reader will reject the document outright if any of them
 * is wrong by one. That is why this builds an array of chunks and measures as
 * it goes rather than concatenating strings and hoping.
 */

export interface PdfPage {
  /** JPEG bytes. Must be baseline JPEG — sharp's default output is. */
  jpeg: Buffer;
  /** Pixel dimensions of the JPEG, used to keep the aspect ratio honest. */
  width: number;
  height: number;
}

/** A4 at 72dpi, the size every Indian print shop expects. */
export const A4 = { width: 595, height: 842 };

export function buildImagePdf(pages: PdfPage[], pageSize = A4): Buffer {
  if (!pages.length) throw new Error('A PDF needs at least one page');

  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let position = 0;

  const push = (data: Buffer | string): void => {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
    chunks.push(buffer);
    position += buffer.length;
  };

  // Object n is recorded at the byte where its "n 0 obj" begins.
  const beginObject = (n: number): void => {
    offsets[n] = position;
    push(`${n} 0 obj\n`);
  };

  push('%PDF-1.4\n');
  // A binary comment line marks the file as binary for transfer tools that
  // would otherwise mangle line endings and corrupt the JPEG streams.
  push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const pageObjectNumber = (i: number): number => 3 + i * 3;
  const contentObjectNumber = (i: number): number => 4 + i * 3;
  const imageObjectNumber = (i: number): number => 5 + i * 3;

  // 1 — catalogue
  beginObject(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  // 2 — page tree
  beginObject(2);
  const kids = pages.map((_, i) => `${pageObjectNumber(i)} 0 R`).join(' ');
  push(`<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>\nendobj\n`);

  pages.forEach((page, i) => {
    // The image is drawn to fill the page while preserving its aspect ratio,
    // centred. A brochure page rendered at the wrong ratio is the one defect
    // everybody notices immediately.
    const scale = Math.min(pageSize.width / page.width, pageSize.height / page.height);
    const drawWidth = page.width * scale;
    const drawHeight = page.height * scale;
    const offsetX = (pageSize.width - drawWidth) / 2;
    const offsetY = (pageSize.height - drawHeight) / 2;

    beginObject(pageObjectNumber(i));
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageSize.width} ${pageSize.height}] `
      + `/Resources << /XObject << /Im0 ${imageObjectNumber(i)} 0 R >> >> `
      + `/Contents ${contentObjectNumber(i)} 0 R >>\nendobj\n`,
    );

    // `cm` sets the transform: width, 0, 0, height, x, y — the image XObject is
    // always drawn into a 1×1 unit square, so this matrix *is* the placement.
    const content = `q\n${drawWidth.toFixed(2)} 0 0 ${drawHeight.toFixed(2)} ${offsetX.toFixed(2)} ${offsetY.toFixed(2)} cm\n/Im0 Do\nQ\n`;
    beginObject(contentObjectNumber(i));
    push(`<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);

    beginObject(imageObjectNumber(i));
    push(
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} `
      + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
    );
    push(page.jpeg);
    push('\nendstream\nendobj\n');
  });

  const objectCount = 3 + pages.length * 3;
  const xrefOffset = position;

  // The xref table is fixed-width by specification: exactly 20 bytes per entry,
  // "%010d %05d n \n". Padding it any other way produces a file that opens in
  // some readers and silently fails in others.
  push(`xref\n0 ${objectCount}\n`);
  push('0000000000 65535 f \n');
  for (let n = 1; n < objectCount; n++) {
    push(`${String(offsets[n] ?? 0).padStart(10, '0')} 00000 n \n`);
  }

  push(`trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.concat(chunks);
}
