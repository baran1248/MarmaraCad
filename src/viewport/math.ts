import * as THREE from "three";
import type { Vec3 } from "../model/types";

/** Compose a component matrix from a translation and XYZ Euler rotation in degrees. */
export function componentMatrix(position: Vec3, rotation: Vec3, out = new THREE.Matrix4()): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      (rotation[0] * Math.PI) / 180,
      (rotation[1] * Math.PI) / 180,
      (rotation[2] * Math.PI) / 180,
      "XYZ",
    ),
  );
  return out.compose(new THREE.Vector3(...position), q, new THREE.Vector3(1, 1, 1));
}

export function matrixArray(m: THREE.Matrix4): number[] {
  return Array.from(m.elements);
}

export function toVec3(v: THREE.Vector3): Vec3 {
  return [v.x, v.y, v.z];
}

export function rotateVec3(m: THREE.Matrix4, v: Vec3): Vec3 {
  const r = new THREE.Vector3(v[0], v[1], v[2]).applyMatrix4(m);
  return [r.x, r.y, r.z];
}

export function eulerFromQuaternion(q: THREE.Quaternion): Vec3 {
  const e = new THREE.Euler().setFromQuaternion(q, "XYZ");
  return [(e.x * 180) / Math.PI, (e.y * 180) / Math.PI, (e.z * 180) / Math.PI];
}

export function quaternionFromEulerDegrees(rotation: Vec3): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      (rotation[0] * Math.PI) / 180,
      (rotation[1] * Math.PI) / 180,
      (rotation[2] * Math.PI) / 180,
      "XYZ",
    ),
  );
}

export function clampNumber(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
