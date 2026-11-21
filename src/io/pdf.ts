/* Minimal single-page PDF writer.
 *
 * The drawing is rasterised to a JPEG and embedded as a DCTDecode image XObject,
 * which keeps the writer dependency-free and produces a PDF every viewer opens.
 * The xref table is built from real byte offsets, so the file is valid rather
 * than "mostly valid". */

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Wrap a JPEG in a one-page PDF sized to the image aspect ratio. */
export function jpegToPdf(jpeg: Uint8Array, imageWidth: number, imageHeight: number, title = "MarmaraCad Drawing"): Uint8Array {
  const pageWidth = 842; // A4 landscape, points
  const pageHeight = Math.round((pageWidth * imageHeight) / imageWidth);
  const header = latin1("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const objects: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = header.length;

  const push = (body: Uint8Array) => {
    offsets.push(length);
    objects.push(body);
    length += body.length;
  };

  push(latin1("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"));
  push(latin1("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"));
  push(
    latin1(
      `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
        `/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\nendobj\n`,
    ),
  );
  const content = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ\n`;
  push(latin1(`4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`));
  const imageHeader = latin1(
    `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
  );
  const imageFooter = latin1("\nendstream\nendobj\n");
  push(concat([imageHeader, jpeg, imageFooter]));

  // Document info (title) as object 6.
  push(latin1(`6 0 obj\n<< /Title (${title.replace(/[()\\]/g, " ")}) /Producer (MarmaraCad) >>\nendobj\n`));
  // Re-point the catalog at the info dictionary.
  objects[0] = latin1("1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Metadata 6 0 R >>\nendobj\n");

  const xrefStart = length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return concat([header, ...objects, latin1(xref)]);
}
