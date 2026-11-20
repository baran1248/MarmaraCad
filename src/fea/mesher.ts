/** Voxel-based conforming hexahedral mesher.
 *
 *  Every occupied grid cell becomes one 8-node brick. The structured grid keeps
 *  the mesh conforming (neighbouring cells share whole faces) while trilinear
 *  hexahedra with 2x2x2 Gauss integration represent bending far better than
 *  constant-strain tetrahedra, which is essential for the beam benchmark.
 *
 *  Interior testing uses parity ray casting along +Z with a 2D bucket index. */

export interface VoxelMeshData {
  positions: Float32Array;
  /** Eight node indices per element, bottom ring first (0..3) then top ring (4..7). */
  hexes: Uint32Array;
  /** Boundary triangles for result display and pressure loads. */
  surface: Uint32Array;
  h: number;
  nodeCount: number;
  elementCount: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  warnings: string[];
}

interface FaceRecord {
  tri: [number, number, number, number];
  count: number;
  element: number;
}

/** The six faces of a hexahedron, wound counter-clockwise when seen from outside. */
const HEX_FACES: [number, number, number, number][] = [
  [0, 3, 2, 1], // -Z
  [4, 5, 6, 7], // +Z
  [0, 1, 5, 4], // -Y
  [1, 2, 6, 5], // +X
  [2, 3, 7, 6], // +Y
  [3, 0, 4, 7], // -X
];

export function buildVoxelMesh(sourcePositions: Float32Array, sourceIndices: Uint32Array, meshSize: number): VoxelMeshData {
  const warnings: string[] = [];
  if (sourcePositions.length === 0) throw new Error("The part has no surface mesh. Rebuild the model first.");
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < sourcePositions.length; i += 3) {
    const x = sourcePositions[i];
    const y = sourcePositions[i + 1];
    const z = sourcePositions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) throw new Error("The part has an empty bounding box.");
  let h = Math.max(0.05, meshSize);
  let cellX = Math.ceil((maxX - minX) / h);
  let cellY = Math.ceil((maxY - minY) / h);
  let cellZ = Math.ceil((maxZ - minZ) / h);
  const maxCells = 120000;
  while ((cellX + 2) * (cellY + 2) * (cellZ + 2) > maxCells) {
    h *= 1.22;
    cellX = Math.ceil((maxX - minX) / h);
    cellY = Math.ceil((maxY - minY) / h);
    cellZ = Math.ceil((maxZ - minZ) / h);
  }
  cellX = Math.max(2, cellX);
  cellY = Math.max(2, cellY);
  cellZ = Math.max(2, cellZ);
  if (h > meshSize * 1.01) warnings.push(`Mesh size increased to ${h.toFixed(2)} mm to keep the model solvable.`);

  const pad = h * 0.02;
  const startX = minX - pad;
  const startY = minY - pad;
  const startZ = minZ - pad;
  const dimX = cellX;
  const dimY = cellY;
  const dimZ = cellZ;
  const gridX = dimX + 1;
  const gridY = dimY + 1;
  const gridNodeCount = gridX * gridY * (dimZ + 1);
  const nodeIndex = (i: number, j: number, k: number) => (k * gridY + j) * gridX + i;

  const triCount = Math.floor(sourceIndices.length / 3);
  const xs = new Float32Array(triCount * 3);
  const ys = new Float32Array(triCount * 3);
  const zs = new Float32Array(triCount * 3);
  const triMinX = new Float32Array(triCount);
  const triMaxX = new Float32Array(triCount);
  const triMinY = new Float32Array(triCount);
  const triMaxY = new Float32Array(triCount);
  for (let t = 0; t < triCount; t++) {
    let tminX = Infinity, tmaxX = -Infinity, tminY = Infinity, tmaxY = -Infinity;
    for (let k = 0; k < 3; k++) {
      const vi = sourceIndices[t * 3 + k] * 3;
      const x = sourcePositions[vi];
      const y = sourcePositions[vi + 1];
      const z = sourcePositions[vi + 2];
      xs[t * 3 + k] = x;
      ys[t * 3 + k] = y;
      zs[t * 3 + k] = z;
      if (x < tminX) tminX = x;
      if (x > tmaxX) tmaxX = x;
      if (y < tminY) tminY = y;
      if (y > tmaxY) tmaxY = y;
    }
    triMinX[t] = tminX;
    triMaxX[t] = tmaxX;
    triMinY[t] = tminY;
    triMaxY[t] = tmaxY;
  }

  // 2D bucket index over XY to accelerate ray casting.
  const bin = h * 2;
  const binX = Math.max(1, Math.ceil((maxX - minX) / bin) + 1);
  const binY = Math.max(1, Math.ceil((maxY - minY) / bin) + 1);
  const buckets: number[][] = new Array(binX * binY);
  for (let t = 0; t < triCount; t++) {
    if (triMaxX[t] - triMinX[t] < 1e-12 && triMaxY[t] - triMinY[t] < 1e-12) continue;
    const ix0 = Math.max(0, Math.floor((triMinX[t] - minX) / bin));
    const ix1 = Math.min(binX - 1, Math.floor((triMaxX[t] - minX) / bin));
    const iy0 = Math.max(0, Math.floor((triMinY[t] - minY) / bin));
    const iy1 = Math.min(binY - 1, Math.floor((triMaxY[t] - minY) / bin));
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const key = iy * binX + ix;
        (buckets[key] ??= []).push(t);
      }
    }
  }

  const occupied = new Uint8Array(dimX * dimY * dimZ);
  const stamp = new Int32Array(triCount).fill(-1);
  const hits: number[] = [];
  // A tiny offset keeps ray origins off shared triangle edges/diagonals:
  // a point exactly on an edge is counted by both neighbouring triangles,
  // which flips the parity and would empty an entire column.
  const jitterX = h * 0.00037;
  const jitterY = h * 0.00061;
  let columnId = 0;
  let cellCount = 0;
  for (let j = 0; j < dimY; j++) {
    const cy = startY + (j + 0.5) * h + jitterY;
    const iy = Math.min(binY - 1, Math.max(0, Math.floor((cy - minY) / bin)));
    for (let i = 0; i < dimX; i++) {
      const cx = startX + (i + 0.5) * h + jitterX;
      const ix = Math.min(binX - 1, Math.max(0, Math.floor((cx - minX) / bin)));
      const list = buckets[iy * binX + ix] ?? [];
      columnId++;
      hits.length = 0;
      for (const t of list) {
        if (stamp[t] === columnId) continue;
        stamp[t] = columnId;
        const ax = xs[t * 3], ay = ys[t * 3];
        const bx = xs[t * 3 + 1], by = ys[t * 3 + 1];
        const qx = xs[t * 3 + 2], qy = ys[t * 3 + 2];
        const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        const d2 = (qx - bx) * (cy - by) - (qy - by) * (cx - bx);
        const d3 = (ax - qx) * (cy - qy) - (ay - qy) * (cx - qx);
        const eps = -1e-9;
        if ((d1 >= eps && d2 >= eps && d3 >= eps) || (d1 <= -eps && d2 <= -eps && d3 <= -eps)) {
          const denom = d1 + d2 + d3;
          if (Math.abs(denom) < 1e-15) continue;
          const za = zs[t * 3], zb = zs[t * 3 + 1], zc = zs[t * 3 + 2];
          const z = (d2 * za + d3 * zb + d1 * zc) / denom;
          hits.push(z);
        }
      }
      hits.sort((a, b) => a - b);
      let pointer = 0;
      for (let k = 0; k < dimZ; k++) {
        const cz = startZ + (k + 0.5) * h;
        while (pointer < hits.length && hits[pointer] <= cz) pointer++;
        if ((hits.length - pointer) % 2 === 1) {
          occupied[(k * dimY + j) * dimX + i] = 1;
          cellCount++;
        }
      }
    }
  }

  if (cellCount === 0) {
    throw new Error("Meshing produced no elements. Try a smaller mesh size or check that the body is closed.");
  }

  // One hexahedron per occupied cell.
  const hexes = new Uint32Array(cellCount * 8);
  let hexCount = 0;
  for (let k = 0; k < dimZ; k++) {
    for (let j = 0; j < dimY; j++) {
      for (let i = 0; i < dimX; i++) {
        if (!occupied[(k * dimY + j) * dimX + i]) continue;
        const o = hexCount * 8;
        hexes[o] = nodeIndex(i, j, k);
        hexes[o + 1] = nodeIndex(i + 1, j, k);
        hexes[o + 2] = nodeIndex(i + 1, j + 1, k);
        hexes[o + 3] = nodeIndex(i, j + 1, k);
        hexes[o + 4] = nodeIndex(i, j, k + 1);
        hexes[o + 5] = nodeIndex(i + 1, j, k + 1);
        hexes[o + 6] = nodeIndex(i + 1, j + 1, k + 1);
        hexes[o + 7] = nodeIndex(i, j + 1, k + 1);
        hexCount++;
      }
    }
  }

  // Compact node numbering.
  const remap = new Int32Array(gridNodeCount).fill(-1);
  const used: number[] = [];
  for (let i = 0; i < hexes.length; i++) {
    const gid = hexes[i];
    if (remap[gid] < 0) {
      remap[gid] = used.length;
      used.push(gid);
    }
  }
  const positions = new Float32Array(used.length * 3);
  for (let n = 0; n < used.length; n++) {
    const gid = used[n];
    const k = Math.floor(gid / (gridX * gridY));
    const rem = gid - k * gridX * gridY;
    const j = Math.floor(rem / gridX);
    const i = rem - j * gridX;
    positions[n * 3] = startX + i * h;
    positions[n * 3 + 1] = startY + j * h;
    positions[n * 3 + 2] = startZ + k * h;
  }
  const compactHexes = new Uint32Array(hexes.length);
  for (let i = 0; i < hexes.length; i++) compactHexes[i] = remap[hexes[i]];

  // Boundary quads (odd incidence) split into outward-wound triangles.
  const faceMap = new Map<number, FaceRecord>();
  const N = used.length;
  const faceKey = (a: number, b: number, c: number, d: number): number => {
    // Sort the four ids so the same face hashes identically from both cells.
    let a0 = a, b0 = b, c0 = c, d0 = d;
    if (a0 > b0) [a0, b0] = [b0, a0];
    if (c0 > d0) [c0, d0] = [d0, c0];
    if (a0 > c0) [a0, c0] = [c0, a0];
    if (b0 > d0) [b0, d0] = [d0, b0];
    if (b0 > c0) [b0, c0] = [c0, b0];
    return ((a0 * N + b0) * N + c0) * N + d0;
  };
  const elementCount = compactHexes.length / 8;
  for (let e = 0; e < elementCount; e++) {
    const o = e * 8;
    for (const face of HEX_FACES) {
      const a = compactHexes[o + face[0]];
      const b = compactHexes[o + face[1]];
      const c = compactHexes[o + face[2]];
      const d = compactHexes[o + face[3]];
      const key = faceKey(a, b, c, d);
      const rec = faceMap.get(key);
      if (rec) rec.count++;
      else faceMap.set(key, { tri: [a, b, c, d], count: 1, element: e });
    }
  }
  const surface: number[] = [];
  for (const rec of faceMap.values()) {
    if (rec.count !== 1) continue;
    const [a, b, c, d] = rec.tri;
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
    const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    // Outward check against the owning element's centroid.
    const eo = rec.element * 8;
    let ex = 0, ey = 0, ez = 0;
    for (let k = 0; k < 8; k++) {
      const n = compactHexes[eo + k];
      ex += positions[n * 3];
      ey += positions[n * 3 + 1];
      ez += positions[n * 3 + 2];
    }
    ex /= 8;
    ey /= 8;
    ez /= 8;
    const mx = (ax + bx + cx) / 3 - ex;
    const my = (ay + by + cy) / 3 - ey;
    const mz = (az + bz + cz) / 3 - ez;
    if (nx * mx + ny * my + nz * mz < 0) surface.push(a, c, b, a, d, c);
    else surface.push(a, b, c, a, c, d);
  }

  if (surface.length === 0) warnings.push("The mesher found no boundary triangles.");
  return {
    positions,
    hexes: compactHexes,
    surface: new Uint32Array(surface),
    h,
    nodeCount: used.length,
    elementCount,
    bounds: { min: [startX, startY, startZ], max: [startX + dimX * h, startY + dimY * h, startZ + dimZ * h] },
    warnings,
  };
}

export function hexVolume(coords: [number, number, number][]): number {
  // Split into five tetrahedra around node 0 and sum absolute volumes.
  const tets: [number, number, number, number][] = [
    [0, 1, 2, 6],
    [0, 2, 3, 6],
    [0, 3, 7, 6],
    [0, 7, 4, 6],
    [0, 4, 5, 6],
  ];
  let total = 0;
  for (const [a, b, c, d] of tets) {
    const ax = coords[b][0] - coords[a][0], ay = coords[b][1] - coords[a][1], az = coords[b][2] - coords[a][2];
    const bx = coords[c][0] - coords[a][0], by = coords[c][1] - coords[a][1], bz = coords[c][2] - coords[a][2];
    const cx = coords[d][0] - coords[a][0], cy = coords[d][1] - coords[a][1], cz = coords[d][2] - coords[a][2];
    total += Math.abs((ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6);
  }
  return total;
}

/** Kept for the tetrahedral unit test and older callers. */
export function tetVolume(
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
): number {
  const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2];
  const bx = c[0] - a[0], by = c[1] - a[1], bz = c[2] - a[2];
  const cx = d[0] - a[0], cy = d[1] - a[1], cz = d[2] - a[2];
  return (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
}
