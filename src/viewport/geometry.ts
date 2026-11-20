import * as THREE from "three";
import type { EdgeInfo, MeshData } from "../model/types";

/** Indexed display geometry for a tessellated B-Rep body. */
export function bodyGeometry(mesh: MeshData): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/** Geometry containing only the triangles that belong to the requested face ids. */
export function faceGeometry(mesh: MeshData, faceIds: Iterable<number>): THREE.BufferGeometry | null {
  const wanted = new Set<number>(faceIds);
  if (wanted.size === 0) return null;
  const source = mesh.indices;
  const picked: number[] = [];
  const triCount = source.length / 3;
  for (let t = 0; t < triCount; t++) {
    if (!wanted.has(mesh.triFaceIds[t])) continue;
    picked.push(source[t * 3], source[t * 3 + 1], source[t * 3 + 2]);
  }
  if (picked.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  geo.setIndex(picked);
  geo.computeBoundingSphere();
  return geo;
}

/** One merged line-segment geometry for the topological edges of a body. */
export function edgeLineGeometry(edges: EdgeInfo[]): THREE.BufferGeometry {
  const pts: number[] = [];
  for (const edge of edges) {
    for (let i = 0; i < edge.points.length - 1; i++) {
      const a = edge.points[i];
      const b = edge.points[i + 1];
      pts.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  geo.computeBoundingSphere();
  return geo;
}

export function edgePolylineGeometry(edge: EdgeInfo): THREE.BufferGeometry {
  const pts: number[] = [];
  for (const p of edge.points) pts.push(p[0], p[1], p[2]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  geo.computeBoundingSphere();
  return geo;
}

/** Bounding sphere used for camera fitting. */
export function meshBounds(mesh: MeshData): { center: THREE.Vector3; radius: number } {
  const min = new THREE.Vector3(...mesh.bbox.min);
  const max = new THREE.Vector3(...mesh.bbox.max);
  const center = min.clone().add(max).multiplyScalar(0.5);
  const radius = Math.max(1, min.distanceTo(max) * 0.5);
  return { center, radius };
}

export function emptyGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
  return geo;
}

/** Transform every triangle centroid by a matrix (used by STL/OBJ export). */
export function transformMeshData(mesh: MeshData, matrix: THREE.Matrix4): MeshData {
  const positions = new Float32Array(mesh.positions.length);
  const v = new THREE.Vector3();
  for (let i = 0; i < mesh.positions.length; i += 3) {
    v.set(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]).applyMatrix4(matrix);
    positions[i] = v.x;
    positions[i + 1] = v.y;
    positions[i + 2] = v.z;
  }
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
  const normals = new Float32Array(mesh.normals.length);
  for (let i = 0; i < mesh.normals.length; i += 3) {
    v.set(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]).applyMatrix3(normalMatrix).normalize();
    normals[i] = v.x;
    normals[i + 1] = v.y;
    normals[i + 2] = v.z;
  }
  return {
    ...mesh,
    positions,
    normals,
    bbox: {
      min: [0, 0, 0],
      max: [0, 0, 0],
    },
  };
}
