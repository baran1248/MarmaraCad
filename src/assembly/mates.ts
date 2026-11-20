import * as THREE from "three";
import type { Component, FaceRef, Mate, ProjectDocument, Vec3 } from "../model/types";
import { componentMatrix, eulerFromQuaternion, quaternionFromEulerDegrees } from "../viewport/math";

interface WorldFace {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  axis: THREE.Vector3;
}

function componentOf(doc: ProjectDocument, id: string): Component | undefined {
  return doc.components.find((c) => c.id === id);
}

function worldFace(component: Component, ref: FaceRef): WorldFace {
  const q = quaternionFromEulerDegrees(component.rotation);
  const point = new THREE.Vector3(...ref.point).applyQuaternion(q).add(new THREE.Vector3(...component.position));
  const normal = new THREE.Vector3(...ref.normal).applyQuaternion(q).normalize();
  const axis = new THREE.Vector3(...(ref.axis ?? ref.normal)).applyQuaternion(q).normalize();
  return { point, normal, axis };
}

function almostEqual(a: number, b: number, tol = 1e-4): boolean {
  return Math.abs(a - b) < tol;
}

export interface MateSolveOptions {
  iterations?: number;
}

export interface MateSolveReport {
  changed: boolean;
  errors: number;
}

/** Solve every mate in the document, moving the non-fixed component of each pair. */
export function solveMates(doc: ProjectDocument, options: MateSolveOptions = {}): MateSolveReport {
  const iterations = options.iterations ?? 4;
  let changed = false;
  let errors = 0;
  for (const mate of doc.mates) mate.error = undefined;

  for (let pass = 0; pass < iterations; pass++) {
    for (const mate of doc.mates) {
      const a = componentOf(doc, mate.a.componentId);
      const b = componentOf(doc, mate.b.componentId);
      if (!a || !b) {
        mate.error = "A component used by this mate no longer exists.";
        continue;
      }
      if (a.id === b.id) {
        mate.error = "Both faces belong to the same component.";
        continue;
      }
      if (a.fixed && b.fixed) {
        mate.error = "Both components are fixed. Float one to resolve this mate.";
        continue;
      }
      const moveB = !b.fixed;
      const mover = moveB ? b : a;
      const anchor = moveB ? a : b;
      const moverRef = moveB ? mate.b : mate.a;
      const anchorRef = moveB ? mate.a : mate.b;
      const result = solveOne(mover, moverRef, anchor, anchorRef, mate);
      if (result) {
        if (mover.position[0] !== result.position[0] || mover.position[1] !== result.position[1] || mover.position[2] !== result.position[2]) changed = true;
        mover.position = result.position;
        mover.rotation = result.rotation;
      }
    }
  }

  for (const mate of doc.mates) {
    if (mate.error) {
      errors++;
      continue;
    }
    const a = componentOf(doc, mate.a.componentId);
    const b = componentOf(doc, mate.b.componentId);
    if (!a || !b) {
      mate.error = "Component missing.";
      errors++;
      continue;
    }
    const residual = mateResidual(a, mate.a, b, mate.b, mate);
    if (residual > 0.08) {
      mate.error = "Could not fully satisfy this mate (the assembly may be over-defined).";
      errors++;
    }
  }
  return { changed, errors };
}

function solveOne(
  mover: Component,
  moverRef: FaceRef,
  anchor: Component,
  anchorRef: FaceRef,
  mate: Mate,
): { position: Vec3; rotation: Vec3 } | null {
  const aw = worldFace(anchor, anchorRef);
  const bw = worldFace(mover, moverRef);
  const currentQ = quaternionFromEulerDegrees(mover.rotation);
  const localPoint = new THREE.Vector3(...moverRef.point);
  const isCylinder = moverRef.surface === "cylinder" && anchorRef.surface === "cylinder";

  if (mate.type === "concentric" || (mate.type === "coincident" && isCylinder)) {
    if (anchorRef.surface !== "cylinder" || moverRef.surface !== "cylinder") {
      mate.error = "Concentric mates require two cylindrical faces.";
      return null;
    }
    const axisA = aw.axis;
    const axisB = bw.axis.clone();
    // Pick the axis direction that requires the smallest rotation.
    const targetAxis = axisA.clone().multiplyScalar(axisB.dot(axisA) >= 0 ? 1 : -1);
    const qAlign = new THREE.Quaternion().setFromUnitVectors(axisB.normalize(), targetAxis);
    const newQ = qAlign.multiply(currentQ);
    const rotatedPoint = localPoint.clone().applyQuaternion(newQ);
    const worldPoint = rotatedPoint.clone().add(new THREE.Vector3(...mover.position));
    const t = worldPoint.clone().sub(aw.point).dot(targetAxis);
    const targetPoint = aw.point.clone().addScaledVector(targetAxis, t);
    const newPos = targetPoint.clone().sub(rotatedPoint);
    return { position: [newPos.x, newPos.y, newPos.z], rotation: eulerFromQuaternion(newQ) };
  }

  if (moverRef.surface !== "plane" || anchorRef.surface !== "plane") {
    mate.error = "Coincident and distance mates need planar faces (or two cylinders for concentric).";
    return null;
  }

  const gap = mate.type === "distance" ? Math.abs(mate.distance ?? 0) : 0;
  const sign = mate.flipped ? -1 : 1;
  const targetNormal = aw.normal.clone().multiplyScalar(-sign);
  const qAlign = new THREE.Quaternion().setFromUnitVectors(bw.normal, targetNormal);
  const newQ = qAlign.multiply(currentQ);
  const rotatedPoint = localPoint.clone().applyQuaternion(newQ);
  const targetPoint = aw.point.clone().addScaledVector(aw.normal, sign * gap);
  const newPos = targetPoint.clone().sub(rotatedPoint);
  return { position: [newPos.x, newPos.y, newPos.z], rotation: eulerFromQuaternion(newQ) };
}

function mateResidual(a: Component, ar: FaceRef, b: Component, br: FaceRef, mate: Mate): number {
  const aw = worldFace(a, ar);
  const bw = worldFace(b, br);
  if (mate.type === "concentric" || (mate.type === "coincident" && ar.surface === "cylinder" && br.surface === "cylinder")) {
    const cross = new THREE.Vector3().crossVectors(aw.axis, bw.axis);
    const angle = cross.length();
    const delta = bw.point.clone().sub(aw.point);
    const radial = delta.clone().sub(aw.axis.clone().multiplyScalar(delta.dot(aw.axis))).length();
    return radial + angle * 10;
  }
  const normalError = 1 - Math.abs(aw.normal.dot(bw.normal));
  const gap = Math.abs((mate.type === "distance" ? Math.abs(mate.distance ?? 0) : 0));
  const planeDist = Math.abs(bw.point.clone().sub(aw.point).dot(aw.normal)) - gap;
  return Math.abs(planeDist) + normalError * 10;
}

/** Create a world-space face reference for mate creation. */
export function faceRefFromPick(
  component: Component,
  faceIndex: number,
  surface: string,
  point: Vec3,
  normal: Vec3,
  axis?: Vec3,
  radius?: number,
): FaceRef {
  return {
    componentId: component.id,
    faceIndex,
    surface,
    point,
    normal,
    axis,
    radius,
  };
}

export function describeMate(mate: Mate): string {
  const kind = mate.type === "concentric" ? "Concentric" : mate.type === "distance" ? `Distance ${mate.distance ?? 0} mm` : "Coincident";
  return `${kind} · faces ${mate.a.faceIndex + 1} ↔ ${mate.b.faceIndex + 1}`;
}

export function newComponentTransform(): { position: Vec3; rotation: Vec3 } {
  return { position: [0, 0, 0], rotation: [0, 0, 0] };
}

export function mateTypeLabel(type: Mate["type"]): string {
  return type === "concentric" ? "Concentric" : type === "distance" ? "Distance" : "Coincident";
}

export function isNearlyEqualRotation(a: Vec3, b: Vec3): boolean {
  return almostEqual(a[0], b[0], 1e-2) && almostEqual(a[1], b[1], 1e-2) && almostEqual(a[2], b[2], 1e-2);
}
