import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { transformMeshData } from "../src/viewport/geometry";
import type { MeshData } from "../src/model/types";

function triangleMesh(): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    triFaceIds: new Uint32Array([0]),
    faces: [],
    edges: [],
    volume: 0,
    area: 3,
    bbox: { min: [0, 0, 0], max: [2, 3, 0] },
    shapeType: "plate",
    warnings: [],
  };
}

describe("transformMeshData", () => {
  it("moves the positions and recomputes the bounding box", () => {
    const matrix = new THREE.Matrix4().makeTranslation(10, 5, -2);
    const moved = transformMeshData(triangleMesh(), matrix);
    expect(Array.from(moved.positions.slice(0, 3))).toEqual([10, 5, -2]);
    expect(moved.bbox.min).toEqual([10, 5, -2]);
    expect(moved.bbox.max).toEqual([12, 8, -2]);
  });

  it("keeps the bbox tight for a rotated mesh (interference relies on it)", () => {
    const matrix = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
    const rotated = transformMeshData(triangleMesh(), matrix);
    // (2,0) → (0,2); (0,3) → (-3,0)
    expect(rotated.bbox.min[0]).toBeCloseTo(-3, 6);
    expect(rotated.bbox.max[0]).toBeCloseTo(0, 6);
    expect(rotated.bbox.min[1]).toBeCloseTo(0, 6);
    expect(rotated.bbox.max[1]).toBeCloseTo(2, 6);
  });
});
