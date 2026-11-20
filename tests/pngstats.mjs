/* Minimal PNG luminance statistics for screenshot verification.
 * Supports 8-bit RGB/RGBA non-interlaced PNGs, which is what Playwright emits. */
import { inflateSync } from "node:zlib";

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("Not a PNG.");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("Interlaced PNG is not supported.");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`Unsupported bit depth ${bitDepth}.`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}.`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const target = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? target[x - channels] : 0;
      const up = prev ? prev[x] : 0;
      const upLeft = prev && x >= channels ? prev[x - channels] : 0;
      let value = row[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      target[x] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** Return mean luminance, standard deviation and the share of pixels that are
 *  clearly not the flat background colour. */
export function imageStats(buffer, background = [244, 247, 250]) {
  const { width, height, channels, data } = decodePng(buffer);
  const total = width * height;
  let sum = 0;
  let sum2 = 0;
  let varied = 0;
  for (let i = 0; i < total; i++) {
    const o = i * channels;
    const r = data[o];
    const g = channels >= 3 ? data[o + 1] : r;
    const b = channels >= 3 ? data[o + 2] : r;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += lum;
    sum2 += lum * lum;
    const dist = Math.abs(r - background[0]) + Math.abs(g - background[1]) + Math.abs(b - background[2]);
    if (dist > 40) varied++;
  }
  const mean = sum / total;
  return {
    width,
    height,
    mean: Math.round(mean),
    stdDev: Math.round(Math.sqrt(Math.max(0, sum2 / total - mean * mean))),
    nonBackgroundPct: Math.round((varied / total) * 100),
  };
}
