/* Technical drawing generator.
 *
 * The drawing is vector-first: every view is projected from the model's
 * feature edges onto a paper-space canvas, dimensioned and framed with a title
 * block. The same SVG is then rasterised once for the PDF export, so both
 * outputs always match. */
import type { MeshData, Vec3 } from "../model/types";
import { escapeHtml, safeFilename } from "../utils/misc";
import { jpegToPdf } from "../io/pdf";

export interface DrawingInfo {
  partName: string;
  material: string;
  scale: string;
  units: string;
  document: string;
  date?: string;
}

type Proj = (p: Vec3) => { x: number; y: number };

const W = 1240;
const H = 860;

function bboxOf(segments: { x: number; y: number }[][]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const poly of segments) {
    for (const p of poly) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, maxX: 1, minY: 0, maxY: 1 };
  return { minX, maxX, minY, maxY };
}

function fitTransform(
  segments: { x: number; y: number }[][],
  box: { x: number; y: number; w: number; h: number },
  target: { x: number; y: number; w: number; h: number },
): (p: { x: number; y: number }) => { x: number; y: number } {
  const b = bboxOf(segments);
  const sx = target.w / Math.max(1e-6, b.maxX - b.minX);
  const sy = target.h / Math.max(1e-6, b.maxY - b.minY);
  const scale = Math.min(sx, sy);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return (p) => ({
    x: target.x + target.w / 2 + (p.x - cx) * scale,
    y: target.y + target.h / 2 - (p.y - cy) * scale,
  });
}

function polylineD(points: { x: number; y: number }[], f: (p: { x: number; y: number }) => { x: number; y: number }): string {
  if (points.length < 2) return "";
  return points
    .map((p, i) => {
      const q = f(p);
      return `${i === 0 ? "M" : "L"}${q.x.toFixed(2)} ${q.y.toFixed(2)}`;
    })
    .join(" ");
}

/** Build a 4-view (front/top/right/iso) A4-landscape drawing as SVG. */
export function buildDrawingSvg(mesh: MeshData | undefined, info: DrawingInfo): string {
  const edgeD: string[] = [];
  const views: { name: string; proj: Proj; segments: { x: number; y: number }[][] }[] = [];
  if (mesh) {
    const isometric: Proj = (p) => {
      const d = 1 / Math.sqrt(3);
      const x = (p[0] - p[2]) * d;
      const y = p[1] - (p[0] + p[2]) * 0.5 * d;
      return { x, y };
    };
    const defs: { name: string; proj: Proj }[] = [
      { name: "FRONT", proj: (p) => ({ x: p[0], y: p[1] }) },
      { name: "TOP", proj: (p) => ({ x: p[0], y: -p[2] }) },
      { name: "RIGHT", proj: (p) => ({ x: -p[2], y: p[1] }) },
      { name: "ISOMETRIC", proj: isometric },
    ];
    for (const def of defs) {
      const segments = mesh.edges.map((e) => e.points.map(def.proj)).filter((poly) => poly.length > 1);
      views.push({ ...def, segments });
    }
  }

  const slots = [
    { x: 40, y: 96, w: 520, h: 300 },
    { x: 40, y: 420, w: 520, h: 300 },
    { x: 600, y: 96, w: 380, h: 300 },
    { x: 600, y: 420, w: 340, h: 300 },
  ];
  const parts: string[] = [];
  const viewTransforms: ((p: { x: number; y: number }) => { x: number; y: number })[] = [];
  views.forEach((view, i) => {
    const slot = slots[i];
    if (!slot) return;
    const f = fitTransform(view.segments, slot, { x: slot.x + 24, y: slot.y + 30, w: slot.w - 48, h: slot.h - 58 });
    viewTransforms.push(f);
    const d = view.segments.map((poly) => polylineD(poly, f)).filter(Boolean).join(" ");
    edgeD.push(`<path d="${d}" fill="none" stroke="#16212c" stroke-width="1.15" stroke-linejoin="round" stroke-linecap="round"/>`);
    parts.push(`<text x="${slot.x + slot.w / 2}" y="${slot.y + slot.h - 10}" text-anchor="middle" font-size="10.5" letter-spacing="1.1" fill="#5b6b7a">${view.name}</text>`);
    // Hidden-line-free section outline frame.
    parts.push(`<rect x="${slot.x}" y="${slot.y}" width="${slot.w}" height="${slot.h}" fill="none" stroke="#c8d3dd" stroke-width="0.6" stroke-dasharray="3 5"/>`);
  });

  // Overall dimensions from the front view's projected bounds.
  const frontSegments = views[0]?.segments ?? [];
  let dims = "";
  if (frontSegments.length && viewTransforms[0]) {
    const f = viewTransforms[0];
    const b = bboxOf(frontSegments);
    const p0 = f({ x: b.minX, y: b.minY });
    const p1 = f({ x: b.maxX, y: b.maxY });
    const width = Math.round(b.maxX - b.minX);
    const height = Math.round(b.maxY - b.minY);
    const yDim = Math.min(slots[0].y + slots[0].h - 28, p1.y + 32);
    dims += `<line x1="${p0.x}" y1="${yDim}" x2="${p1.x}" y2="${yDim}" stroke="#2f4d68" stroke-width="0.9" marker-start="url(#arrow)" marker-end="url(#arrow)"/>`;
    dims += `<text x="${(p0.x + p1.x) / 2}" y="${yDim - 5}" text-anchor="middle" font-size="10.5" fill="#2f4d68">${width}</text>`;
    dims += `<line x1="${p1.x + 28}" y1="${p0.y}" x2="${p1.x + 28}" y2="${p1.y}" stroke="#2f4d68" stroke-width="0.9" marker-start="url(#arrow)" marker-end="url(#arrow)"/>`;
    dims += `<text x="${p1.x + 34}" y="${(p0.y + p1.y) / 2}" font-size="10.5" fill="#2f4d68">${height}</text>`;
  }

  const title = escapeHtml(info.partName);
  const material = escapeHtml(info.material);
  const today = info.date ?? new Date().toISOString().slice(0, 10);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <marker id="arrow" markerWidth="7" markerHeight="7" refX="3.5" refY="3.5" orient="auto">
      <path d="M0.5,3.5 L6.5,1.2 L6.5,5.8 Z" fill="#2f4d68"/>
    </marker>
  </defs>
  <rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>
  <rect x="16" y="16" width="${W - 32}" height="${H - 32}" fill="none" stroke="#1d2a36" stroke-width="1.6"/>
  <text x="40" y="46" font-family="Segoe UI, Arial, sans-serif" font-size="17" font-weight="700" fill="#172b3d">${title}</text>
  <text x="40" y="66" font-family="Segoe UI, Arial, sans-serif" font-size="10.5" fill="#607588">TECHNICAL DRAWING · THIRD ANGLE · UNITS mm</text>
  <line x1="40" y1="78" x2="${W - 40}" y2="78" stroke="#9fb2c3" stroke-width="1"/>
  ${parts.join("\n")}
  ${dims}
  ${edgeD.join("\n")}
  <g font-family="Segoe UI, Arial, sans-serif">
    <rect x="${W - 430}" y="${H - 156}" width="398" height="124" fill="#fbfdff" stroke="#243b50" stroke-width="1.2"/>
    <line x1="${W - 430}" y1="${H - 116}" x2="${W - 32}" y2="${H - 116}" stroke="#243b50" stroke-width="0.9"/>
    <line x1="${W - 430}" y1="${H - 80}" x2="${W - 32}" y2="${H - 80}" stroke="#243b50" stroke-width="0.9"/>
    <line x1="${W - 220}" y1="${H - 156}" x2="${W - 220}" y2="${H - 32}" stroke="#243b50" stroke-width="0.9"/>
    <text x="${W - 420}" y="${H - 132}" font-size="9" fill="#607588">PART NAME</text>
    <text x="${W - 420}" y="${H - 102}" font-size="13" font-weight="700" fill="#182b3c">${title}</text>
    <text x="${W - 420}" y="${H - 60}" font-size="9" fill="#607588">MATERIAL</text>
    <text x="${W - 420}" y="${H - 42}" font-size="11" fill="#25384a">${material}</text>
    <text x="${W - 210}" y="${H - 132}" font-size="9" fill="#607588">SCALE</text>
    <text x="${W - 210}" y="${H - 110}" font-size="11" fill="#25384a">${escapeHtml(info.scale)}</text>
    <text x="${W - 210}" y="${H - 88}" font-size="9" fill="#607588">UNITS</text>
    <text x="${W - 210}" y="${H - 68}" font-size="11" fill="#25384a">${escapeHtml(info.units)}</text>
    <text x="${W - 210}" y="${H - 50}" font-size="9" fill="#607588">DATE · ${today}</text>
    <text x="${W - 420}" y="${H - 20}" font-size="8.5" fill="#7a8fa3">MarmaraCad · ${escapeHtml(info.document)}</text>
    <text x="${W - 210}" y="${H - 20}" font-size="8.5" fill="#7a8fa3">DO NOT SCALE DRAWING</text>
  </g>
</svg>`;
}

/** Rasterise the drawing SVG and wrap it in a one-page PDF. */
export async function downloadDrawingPdf(svg: string, filename: string): Promise<void> {
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("The drawing could not be rasterised."));
      image.src = url;
    });
    const width = 1240;
    const height = Math.round((width * image.height) / Math.max(1, image.width));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas is unavailable.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    const jpegBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.94));
    if (!jpegBlob) throw new Error("The drawing could not be encoded.");
    const bytes = new Uint8Array(await jpegBlob.arrayBuffer());
    const pdf = jpegToPdf(bytes, width, height, filename);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([pdf as unknown as BlobPart], { type: "application/pdf" }));
    link.download = safeFilename(filename.endsWith(".pdf") ? filename : `${filename}.pdf`);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 4000);
  } finally {
    URL.revokeObjectURL(url);
  }
}
