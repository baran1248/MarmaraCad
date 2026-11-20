import type { EdgeInfo, FaceInfo, MeshData, Vec3 } from "../model/types";

function computeBounds(positions: Float32Array): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let d = 0; d < 3; d++) {
      const v = positions[i + d];
      if (v < min[d]) min[d] = v;
      if (v > max[d]) max[d] = v;
    }
  }
  if (!Number.isFinite(min[0])) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }
  return { min, max };
}

export function finishMesh(positions: Float32Array, normals?: Float32Array): MeshData {
  const triCount = Math.floor(positions.length / 9);
  const idx = new Uint32Array(triCount * 3);
  for (let i = 0; i < triCount * 3; i++) idx[i] = i;
  const norm = normals && normals.length === positions.length ? normals.slice() : new Float32Array(positions.length);
  let volume = 0;
  let area = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  const edgeNormals = new Map<string, { normals: Vec3[]; a: Vec3; b: Vec3 }>();
  const keyOf = (p: Vec3) => `${Math.round(p[0] * 1e3)},${Math.round(p[1] * 1e3)},${Math.round(p[2] * 1e3)}`;
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const a: Vec3 = [positions[o], positions[o + 1], positions[o + 2]];
    const b: Vec3 = [positions[o + 3], positions[o + 4], positions[o + 5]];
    const c: Vec3 = [positions[o + 6], positions[o + 7], positions[o + 8]];
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n: Vec3 = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    const triArea = len * 0.5;
    area += triArea;
    volume +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    if (len > 1e-12) {
      const un: Vec3 = [n[0] / len, n[1] / len, n[2] / len];
      cx += ((a[0] + b[0] + c[0]) / 3) * triArea;
      cy += ((a[1] + b[1] + c[1]) / 3) * triArea;
      cz += ((a[2] + b[2] + c[2]) / 3) * triArea;
      if (!normals) {
        for (let k = 0; k < 3; k++) {
          norm[o + k * 3] = un[0];
          norm[o + k * 3 + 1] = un[1];
          norm[o + k * 3 + 2] = un[2];
        }
      }
    }
    // Feature edges: collect unique geometric edges and compare triangle normals.
    const verts = [a, b, c];
    for (let k = 0; k < 3; k++) {
      const p = verts[k];
      const q = verts[(k + 1) % 3];
      const kp = keyOf(p);
      const kq = keyOf(q);
      const key = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
      const entry = edgeNormals.get(key);
      if (entry) entry.normals.push(n);
      else edgeNormals.set(key, { normals: [n], a: p, b: q });
    }
  }
  if (volume < 0) {
    // Flip winding and normals for outward orientation.
    for (let t = 0; t < triCount; t++) {
      const o = t * 9;
      for (let k = 0; k < 3; k++) {
        const tmp = positions[o + 3 + k];
        positions[o + 3 + k] = positions[o + 6 + k];
        positions[o + 6 + k] = tmp;
      }
      for (let k = 0; k < 9; k++) norm[o + k] = -norm[o + k];
    }
    volume = -volume;
  }
  const center: Vec3 = area > 0 ? [cx / area, cy / area, cz / area] : [0, 0, 0];
  const edges: EdgeInfo[] = [];
  let edgeIndex = 0;
  const cosSharp = Math.cos((28 * Math.PI) / 180);
  for (const entry of edgeNormals.values()) {
    if (entry.normals.length > 2) continue;
    let sharp = entry.normals.length === 1;
    if (entry.normals.length === 2) {
      const n0 = entry.normals[0];
      const n1 = entry.normals[1];
      const l0 = Math.hypot(n0[0], n0[1], n0[2]);
      const l1 = Math.hypot(n1[0], n1[1], n1[2]);
      const dot = (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) / (l0 * l1 || 1);
      sharp = Math.abs(dot) < cosSharp;
    }
    if (!sharp) continue;
    edges.push({
      index: edgeIndex++,
      points: [entry.a, entry.b],
      length: Math.hypot(entry.b[0] - entry.a[0], entry.b[1] - entry.a[1], entry.b[2] - entry.a[2]),
      closed: false,
    });
  }
  const faces: FaceInfo[] = [
    { index: 0, surface: "other", point: center, normal: [0, 0, 1], triStart: 0, triCount },
  ];
  return {
    positions,
    normals: norm,
    indices: idx,
    triFaceIds: new Uint32Array(triCount),
    faces,
    edges,
    volume: Math.abs(volume),
    area,
    bbox: computeBounds(positions),
    shapeType: "mesh",
    warnings: [],
  };
}

export function parseSTL(buffer: ArrayBuffer): MeshData {
  const bytes = new Uint8Array(buffer);
  let ascii = "";
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512)));
  const looksAscii = /^\s*solid\b/i.test(head) && /facet\s+normal/i.test(new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096))));
  if (!looksAscii && bytes.length >= 84) {
    const view = new DataView(buffer);
    const count = view.getUint32(80, true);
    if (84 + count * 50 <= bytes.length) {
      const positions = new Float32Array(count * 9);
      for (let i = 0; i < count; i++) {
        let o = 84 + i * 50 + 12;
        for (let k = 0; k < 9; k++) {
          positions[i * 9 + k] = view.getFloat32(o, true);
          o += 4;
        }
      }
      return finishMesh(positions);
    }
  }
  ascii = new TextDecoder().decode(bytes);
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  const values: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(ascii))) values.push(Number(m[1]), Number(m[2]), Number(m[3]));
  while (values.length % 9 !== 0) values.pop();
  if (values.length === 0) throw new Error("No triangles were found in this STL file.");
  return finishMesh(new Float32Array(values));
}

export function parseOBJ(text: string): MeshData {
  const verts: number[] = [];
  const norms: number[] = [];
  const positions: number[] = [];
  const outNormals: number[] = [];
  let anyNormals = false;
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === "v" && parts.length >= 4) {
      verts.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    } else if (parts[0] === "vn" && parts.length >= 4) {
      norms.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    } else if (parts[0] === "f" && parts.length >= 4) {
      const corners = parts.slice(1).map((tok) => {
        const bits = tok.split("/");
        let vi = parseInt(bits[0], 10);
        if (vi < 0) vi = verts.length / 3 + vi + 1;
        const ni = bits[2] ? parseInt(bits[2], 10) : 0;
        return { vi, ni };
      });
      for (let k = 1; k < corners.length - 1; k++) {
        const tri = [corners[0], corners[k], corners[k + 1]];
        for (const corner of tri) {
          const vi = (corner.vi - 1) * 3;
          if (vi < 0 || vi + 2 >= verts.length) continue;
          positions.push(verts[vi], verts[vi + 1], verts[vi + 2]);
          if (corner.ni > 0 && (corner.ni - 1) * 3 + 2 < norms.length) {
            outNormals.push(norms[(corner.ni - 1) * 3], norms[(corner.ni - 1) * 3 + 1], norms[(corner.ni - 1) * 3 + 2]);
            anyNormals = true;
          } else {
            outNormals.push(0, 0, 0);
          }
        }
      }
    }
  }
  if (positions.length === 0) throw new Error("No faces were found in this OBJ file.");
  return finishMesh(new Float32Array(positions), anyNormals ? new Float32Array(outNormals) : undefined);
}

export function writeSTL(meshes: { name: string; mesh: MeshData }[]): Uint8Array {
  let count = 0;
  for (const entry of meshes) count += Math.floor(entry.mesh.positions.length / 9);
  const buffer = new ArrayBuffer(84 + count * 50);
  const view = new DataView(buffer);
  const header = "MarmaraCad binary STL";
  for (let i = 0; i < Math.min(79, header.length); i++) view.setUint8(i, header.charCodeAt(i));
  view.setUint32(80, count, true);
  let offset = 84;
  for (const entry of meshes) {
    const p = entry.mesh.positions;
    const triCount = Math.floor(p.length / 9);
    for (let t = 0; t < triCount; t++) {
      const o = t * 9;
      const ax = p[o], ay = p[o + 1], az = p[o + 2];
      const bx = p[o + 3], by = p[o + 4], bz = p[o + 5];
      const cx = p[o + 6], cy = p[o + 7], cz = p[o + 8];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      const vals = [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz];
      for (const v of vals) {
        view.setFloat32(offset, v, true);
        offset += 4;
      }
      view.setUint16(offset, 0, true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}

export function writeOBJ(meshes: { name: string; mesh: MeshData }[]): string {
  const out: string[] = ["# MarmaraCad OBJ export", `# ${new Date().toISOString()}`, ""];
  let offset = 1;
  for (const entry of meshes) {
    const mesh = entry.mesh;
    out.push(`o ${entry.name.replace(/\s+/g, "_")}`);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      out.push(`v ${fmt(mesh.positions[i])} ${fmt(mesh.positions[i + 1])} ${fmt(mesh.positions[i + 2])}`);
    }
    for (let i = 0; i < mesh.normals.length; i += 3) {
      out.push(`vn ${fmt(mesh.normals[i])} ${fmt(mesh.normals[i + 1])} ${fmt(mesh.normals[i + 2])}`);
    }
    const triCount = Math.floor(mesh.positions.length / 9);
    for (let t = 0; t < triCount; t++) {
      const a = offset + t * 3;
      out.push(`f ${a}//${a} ${a + 1}//${a + 1} ${a + 2}//${a + 2}`);
    }
    offset += mesh.positions.length / 3;
    out.push("");
  }
  return out.join("\n");
}

function fmt(v: number): string {
  return Number.isFinite(v) ? (Math.abs(v) < 1e-6 ? "0" : v.toFixed(6)) : "0";
}

/** Sum triangle-based mass properties (volume, area) of a mesh. */
export function meshMass(mesh: MeshData): { volume: number; area: number; centroid: Vec3 } {
  let volume = 0;
  let area = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  const p = mesh.positions;
  const triCount = triCountOf(mesh);
  for (let t = 0; t < triCount; t++) {
    const a = mesh.indices[t * 3] * 3;
    const b = mesh.indices[t * 3 + 1] * 3;
    const c = mesh.indices[t * 3 + 2] * 3;
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cx0 = p[c], cy0 = p[c + 1], cz0 = p[c + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx0 - ax, vy = cy0 - ay, vz = cz0 - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const triArea = Math.hypot(nx, ny, nz) * 0.5;
    area += triArea;
    volume += (ax * (by * cz0 - bz * cy0) - ay * (bx * cz0 - bz * cx0) + az * (bx * cy0 - by * cx0)) / 6;
    cx += ((ax + bx + cx0) / 3) * triArea;
    cy += ((ay + by + cy0) / 3) * triArea;
    cz += ((az + bz + cz0) / 3) * triArea;
  }
  return {
    volume: Math.abs(volume),
    area,
    centroid: area > 0 ? [cx / area, cy / area, cz / area] : [0, 0, 0],
  };
}

export function triCountOf(mesh: MeshData): number {
  return Math.floor(mesh.indices.length / 3);
}
