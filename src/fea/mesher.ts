/** Voxel-based conforming hexahedral mesher.
 *
 *  Every occupied grid cell becomes one 8-node brick. The structured grid keeps
 *  the mesh conforming (neighbouring cells share whole faces) while trilinear
 *  hexahedra with 2x2x2 Gauss integration represent bending far better than
 *  constant-strain tetrahedra, which is essential for the beam benchmark.
 *
 *  Interior testing uses parity ray casting along +Z with a 2D bucket index. */

export interface MeshBudget {
  /** Element size the user asked for. */
  requested: number;
  /** Element size the mesher used after clamping to the memory budget. */
  effective: number;
  /** "cells" = structured hex grid, "tets" = 24 tets per voxel cell. */
  limitedBy: "cells" | "tets";
  /** Hard element/cell ceiling that protects the tab from the browser OOM. */
  limit: number;
  /** Cells (or tets) the requested size would have produced. */
  wanted: number;
  /** Cells (or tets) actually meshed. */
  actual: number;
  /** Human readable message for the status bar / warnings. */
  message: string;
}

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
  budget?: MeshBudget;
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
  const requested = h;
  const wantedCells = (cellX + 2) * (cellY + 2) * (cellZ + 2);
  while ((cellX + 2) * (cellY + 2) * (cellZ + 2) > maxCells) {
    h *= 1.22;
    cellX = Math.ceil((maxX - minX) / h);
    cellY = Math.ceil((maxY - minY) / h);
    cellZ = Math.ceil((maxZ - minZ) / h);
  }
  cellX = Math.max(2, cellX);
  cellY = Math.max(2, cellY);
  cellZ = Math.max(2, cellZ);
  let budget: MeshBudget | undefined;
  if (h > requested * 1.01) {
    // Never resize the mesh silently: the user must know that the browser RAM
    // budget, not the requested element size, decided the result.
    const message =
      `Mesh size adapted to ${h.toFixed(2)} mm (requested ${requested.toFixed(2)} mm) to stay inside the ` +
      `browser RAM budget: ${wantedCells.toLocaleString()} cells would exceed the ${maxCells.toLocaleString()} cell limit.`;
    warnings.push(message);
    budget = {
      requested,
      effective: h,
      limitedBy: "cells",
      limit: maxCells,
      wanted: wantedCells,
      actual: (cellX + 2) * (cellY + 2) * (cellZ + 2),
      message,
    };
  }

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
    budget,
  };
}

export interface TetMeshData {
  positions: Float32Array;
  /** 4 or 10 node indices per element, depending on `kind`. */
  tets: Uint32Array;
  /** Exterior triangles indexing into positions (corner nodes). */
  surface: Uint32Array;
  h: number;
  nodeCount: number;
  elementCount: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  warnings: string[];
  kind: "tet4" | "tet10";
  metrics: { minAspect: number; avgAspect: number; minJacobian: number; avgJacobian: number };
  budget?: MeshBudget;
}

/** Local mesh sizing zones from the study UI. The mesher uses the smallest
 *  requested size as a seed and keeps the resulting grid conforming. */
export interface LocalSizingSpec {
  faceIndex: number;
  size: number;
}

const HEX_FACE_LOCAL: [number, number, number, number][] = [
  [0, 3, 2, 1],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [1, 2, 6, 5],
  [2, 3, 7, 6],
  [3, 0, 4, 7],
];

const HEX_NEIGHBOUR: [number, number, number][] = [
  [0, 0, -1],
  [0, 0, 1],
  [0, -1, 0],
  [1, 0, 0],
  [0, 1, 0],
  [-1, 0, 0],
];

function signedTetVolume(
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
): number {
  return tetVolume(a, b, c, d);
}

/** Conforming tetrahedral mesh. Every voxel is split into 24 tetrahedra through
 *  its centre and its six shared face centres. Adjacent voxels reuse the same
 *  face-centre node and the same four boundary triangles, so the mesh is
 *  watertight even across the stair-stepped OCCT surface.
 *
 *  `kind` selects linear Tet4 or quadratic Tet10 (mid-edge nodes are shared
 *  between neighbouring elements). */
export function buildTetMesh(
  sourcePositions: Float32Array,
  sourceIndices: Uint32Array,
  meshSize: number,
  kind: "tet4" | "tet10" = "tet10",
  localSizing: LocalSizingSpec[] = [],
): TetMeshData {
  const warnings: string[] = [];
  let effective = Math.max(0.05, meshSize);
  if (localSizing.length) {
    const smallest = Math.min(...localSizing.map((l) => Math.max(0.05, l.size)));
    if (smallest < effective) {
      effective = smallest;
      warnings.push(`Local sizing applied: the seed element size is ${smallest.toFixed(2)} mm.`);
    }
  }
  const maxTets = 140000;
  const requested = effective;
  let voxel = buildVoxelMesh(sourcePositions, sourceIndices, effective);
  const wantedTets = voxel.elementCount * 24;
  let guard = 0;
  while (voxel.elementCount * 24 > maxTets && guard++ < 12) {
    effective = voxel.h * 1.28;
    voxel = buildVoxelMesh(sourcePositions, sourceIndices, effective);
  }
  warnings.push(...voxel.warnings);
  let budget: MeshBudget | undefined = voxel.budget;
  if (wantedTets > maxTets) {
    const message =
      `Mesh size adapted to ${voxel.h.toFixed(2)} mm (requested ${requested.toFixed(2)} mm) to stay inside the ` +
      `browser RAM budget: ${wantedTets.toLocaleString()} tetrahedra would exceed the ${maxTets.toLocaleString()} tet limit.`;
    // Replace the hex-grid message (if any) with the tetrahedral one.
    for (let i = warnings.length - 1; i >= 0; i--) if (/browser RAM budget/.test(warnings[i])) warnings.splice(i, 1);
    warnings.push(message);
    budget = {
      requested,
      effective: voxel.h,
      limitedBy: "tets",
      limit: maxTets,
      wanted: wantedTets,
      actual: voxel.elementCount * 24,
      message,
    };
  }

  const h = voxel.h;
  const min = voxel.bounds.min;
  const max = voxel.bounds.max;
  const dimX = Math.max(1, Math.round((max[0] - min[0]) / h));
  const dimY = Math.max(1, Math.round((max[1] - min[1]) / h));
  const dimZ = Math.max(1, Math.round((max[2] - min[2]) / h));
  const cellKey = (i: number, j: number, k: number) => (k * dimY + j) * dimX + i;
  const occupied = new Uint8Array(dimX * dimY * dimZ);
  const cellCorners = new Map<number, number[]>();
  const cellIJK = new Map<number, [number, number, number]>();
  const hexCount = voxel.hexes.length / 8;
  for (let e = 0; e < hexCount; e++) {
    const o = e * 8;
    const n0 = voxel.hexes[o];
    const i = Math.round((voxel.positions[n0 * 3] - min[0]) / h);
    const j = Math.round((voxel.positions[n0 * 3 + 1] - min[1]) / h);
    const k = Math.round((voxel.positions[n0 * 3 + 2] - min[2]) / h);
    const key = cellKey(i, j, k);
    occupied[key] = 1;
    cellCorners.set(key, [voxel.hexes[o], voxel.hexes[o + 1], voxel.hexes[o + 2], voxel.hexes[o + 3], voxel.hexes[o + 4], voxel.hexes[o + 5], voxel.hexes[o + 6], voxel.hexes[o + 7]]);
    cellIJK.set(key, [i, j, k]);
  }

  const positions: number[] = [];
  const cornerMap = new Int32Array(voxel.nodeCount).fill(-1);
  const faceCentreMap = new Map<string, number>();
  const cellCentreMap = new Map<number, number>();
  const newNode = (x: number, y: number, z: number): number => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };
  const cornerNode = (id: number): number => {
    let mapped = cornerMap[id];
    if (mapped < 0) {
      mapped = newNode(voxel.positions[id * 3], voxel.positions[id * 3 + 1], voxel.positions[id * 3 + 2]);
      cornerMap[id] = mapped;
    }
    return mapped;
  };
  const faceCentre = (corners: number[]): number => {
    const key = [...corners].sort((a, b) => a - b).join(",");
    const existing = faceCentreMap.get(key);
    if (existing !== undefined) return existing;
    let x = 0, y = 0, z = 0;
    for (const c of corners) {
      x += voxel.positions[c * 3];
      y += voxel.positions[c * 3 + 1];
      z += voxel.positions[c * 3 + 2];
    }
    const id = newNode(x / 4, y / 4, z / 4);
    faceCentreMap.set(key, id);
    return id;
  };
  const cellCentre = (key: number, corners: number[]): number => {
    const existing = cellCentreMap.get(key);
    if (existing !== undefined) return existing;
    let x = 0, y = 0, z = 0;
    for (const c of corners) {
      x += voxel.positions[c * 3];
      y += voxel.positions[c * 3 + 1];
      z += voxel.positions[c * 3 + 2];
    }
    const id = newNode(x / 8, y / 8, z / 8);
    cellCentreMap.set(key, id);
    return id;
  };

  const tetCornerIds: number[] = [];
  const surface: number[] = [];
  const coordOf = (id: number): [number, number, number] => [positions[id * 3], positions[id * 3 + 1], positions[id * 3 + 2]];
  const pushTet = (a: number, b: number, c: number, d: number) => {
    const vol = signedTetVolume(coordOf(a), coordOf(b), coordOf(c), coordOf(d));
    if (Math.abs(vol) < 1e-14) return;
    if (vol > 0) tetCornerIds.push(a, b, c, d);
    else tetCornerIds.push(a, c, b, d);
  };

  for (const [key, localCorners] of cellCorners) {
    const [i, j, k] = cellIJK.get(key)!;
    const corners = localCorners.map(cornerNode);
    const centre = cellCentre(key, localCorners);
    for (let f = 0; f < 6; f++) {
      const local = HEX_FACE_LOCAL[f];
      const ids = [corners[local[0]], corners[local[1]], corners[local[2]], corners[local[3]]];
      const fc = faceCentre(local.map((q) => localCorners[q]));
      for (let t = 0; t < 4; t++) {
        pushTet(centre, fc, ids[t], ids[(t + 1) % 4]);
      }
      const n = HEX_NEIGHBOUR[f];
      const ni = i + n[0], nj = j + n[1], nk = k + n[2];
      const inside = ni >= 0 && nj >= 0 && nk >= 0 && ni < dimX && nj < dimY && nk < dimZ;
      if (!inside || !occupied[cellKey(ni, nj, nk)]) {
        for (let t = 0; t < 4; t++) {
          surface.push(ids[t], ids[(t + 1) % 4], fc);
        }
      }
    }
  }

  let tets: Uint32Array;
  const tet4Count = tetCornerIds.length / 4;
  if (kind === "tet10") {
    const edgeMap = new Map<string, number>();
    const midNode = (a: number, b: number): number => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const existing = edgeMap.get(key);
      if (existing !== undefined) return existing;
      const id = newNode(
        (positions[a * 3] + positions[b * 3]) / 2,
        (positions[a * 3 + 1] + positions[b * 3 + 1]) / 2,
        (positions[a * 3 + 2] + positions[b * 3 + 2]) / 2,
      );
      edgeMap.set(key, id);
      return id;
    };
    tets = new Uint32Array(tet4Count * 10);
    const edges: [number, number][] = [
      [0, 1],
      [1, 2],
      [2, 0],
      [0, 3],
      [1, 3],
      [2, 3],
    ];
    for (let e = 0; e < tet4Count; e++) {
      const o = e * 4;
      const a = tetCornerIds[o], b = tetCornerIds[o + 1], c = tetCornerIds[o + 2], d = tetCornerIds[o + 3];
      const nodes = [a, b, c, d, midNode(a, b), midNode(b, c), midNode(c, a), midNode(a, d), midNode(b, d), midNode(c, d)];
      tets.set(nodes, e * 10);
    }
  } else {
    tets = new Uint32Array(tetCornerIds);
  }

  let minAspect = Infinity;
  let maxAspect = 0;
  let aspectSum = 0;
  let minJacobian = Infinity;
  let jacobianSum = 0;
  for (let e = 0; e < tet4Count; e++) {
    const o = e * 4;
    const ids = [tetCornerIds[o], tetCornerIds[o + 1], tetCornerIds[o + 2], tetCornerIds[o + 3]];
    const pts = ids.map(coordOf);
    let maxEdge = 0;
    let minEdge = Infinity;
    for (let a = 0; a < 4; a++) {
      for (let b = a + 1; b < 4; b++) {
        const len = Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1], pts[a][2] - pts[b][2]);
        if (len > maxEdge) maxEdge = len;
        if (len < minEdge) minEdge = len;
      }
    }
    const volume = Math.abs(signedTetVolume(pts[0], pts[1], pts[2], pts[3]));
    const aspect = minEdge > 1e-12 ? maxEdge / minEdge : Infinity;
    const jacobian = maxEdge > 1e-12 ? (6 * volume) / (maxEdge * maxEdge * maxEdge) : 0;
    minAspect = Math.min(minAspect, aspect);
    maxAspect = Math.max(maxAspect, aspect);
    aspectSum += aspect;
    minJacobian = Math.min(minJacobian, jacobian);
    jacobianSum += jacobian;
  }
  if (!Number.isFinite(minAspect)) minAspect = 0;
  if (!Number.isFinite(minJacobian)) minJacobian = 0;
  const metrics = {
    minAspect,
    avgAspect: tet4Count ? aspectSum / tet4Count : 0,
    minJacobian,
    avgJacobian: tet4Count ? jacobianSum / tet4Count : 0,
  };
  if (metrics.minJacobian < 0.01) warnings.push("Some tetrahedra are badly shaped; refine the mesh or simplify the geometry.");

  return {
    positions: new Float32Array(positions),
    tets,
    surface: new Uint32Array(surface),
    h,
    nodeCount: positions.length / 3,
    elementCount: tet4Count,
    bounds: { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] },
    warnings,
    kind,
    metrics,
    budget,
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
