/** Small, offline PDF reports. No client information is sent to a third party. */
export function calculationPdf(lines: string[]): Uint8Array {
  if (lines.some((line) => /[^\x20-\x7e]/.test(line))) throw new Error('Use Print / Save PDF for names written in non-Latin scripts.');
  const pages: string[][] = [];
  for (let index = 0; index < lines.length; index += 46) pages.push(lines.slice(index, index + 46));
  if (!pages.length) pages.push([]);
  const escape = (text: string) => text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ];
  pages.forEach((page, index) => {
    const stream = `BT /F1 9 Tf 14 TL 36 800 Td\n${page.map((line) => `(${escape(line)}) Tj T*`).join('\n')}\nET\nBT /F1 9 Tf 36 28 Td (Page ${index + 1} of ${pages.length}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let document = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(document.length); document += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = document.length;
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(document);
}

export function downloadCalculationPdf(lines: string[], filename: string): void {
  const bytes = calculationPdf(lines);
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
