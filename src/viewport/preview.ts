import * as THREE from "three";
import type { EdgeInfo, MeshData, Sketch } from "../model/types";
import { buildProfileGroups } from "../sketch/geometry";

/** Translucent, non-pickable geometry shown while a PropertyManager is open.
 *
 *  The real B-Rep is still produced by OCCT when the user presses OK; these
 *  previews are immediate client-side approximations that make depth, radius,
 *  angle and direction readable before committing. */

export type GhostTone = "add" | "cut" | "fillet" | "chamfer" | "sheet";

function toneColor(tone: GhostTone): number {
  switch (tone) {
    case "cut":
      return 0xe2564a;
    case "fillet":
      return 0xf0a13c;
    case "chamfer":
      return 0x4aa3e8;
    case "sheet":
      return 0x46b3a2;
    default:
      return 0x35b87a;
  }
}

function ghostMaterial(tone: GhostTone, opacity = 0.3): THREE.MeshStandardMaterial {
  const color = new THREE.Color(toneColor(tone));
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.16,
    metalness: 0.08,
    roughness: 0.6,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
  });
}

function finishGroup(group: THREE.Group, tone: GhostTone): THREE.Group {
  group.userData.ghost = true;
  group.userData.tone = tone;
  group.renderOrder = 4;
  group.traverse((child) => {
    child.renderOrder = 4;
    const mesh = child as THREE.Mesh;
    if (mesh.material) {
      const material = mesh.material as THREE.Material;
      material.depthWrite = false;
    }
  });
  return group;
}

/** Extruded profile preview: exact sketch contour, depth and direction. */
export function extrudeGhost(
  sketch: Sketch,
  depth: number,
  options: { direction?: 1 | -1; symmetric?: boolean; tone?: "add" | "cut" } = {},
): THREE.Group | null {
  const { groups } = buildProfileGroups(sketch);
  if (!groups.length || depth <= 0) return null;
  const tone: GhostTone = options.tone ?? "add";
  const group = new THREE.Group();
  const material = ghostMaterial(tone, tone === "cut" ? 0.26 : 0.32);
  const lineMaterial = new THREE.LineBasicMaterial({
    color: toneColor(tone),
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  const plane = sketch.plane;
  const u = new THREE.Vector3(...plane.u).normalize();
  const v = new THREE.Vector3(...plane.v).normalize();
  const n = new THREE.Vector3(...plane.n).normalize();
  const origin = new THREE.Vector3(...plane.origin);
  const direction = options.direction ?? 1;
  const basisN = n.clone().multiplyScalar(direction);
  const matrix = new THREE.Matrix4().makeBasis(u, v, basisN);
  if (options.symmetric) {
    // ExtrudeGeometry grows 0 → +depth along its local +Z; shift by -depth/2
    // along the true normal so the ghost straddles the sketch plane.
    matrix.setPosition(origin.clone().addScaledVector(n, -depth / 2));
  } else {
    matrix.setPosition(origin);
  }
  for (const profile of groups) {
    const shape = new THREE.Shape(profile.outer.points.map((point) => new THREE.Vector2(point.x, point.y)));
    for (const hole of profile.holes) {
      shape.holes.push(new THREE.Path(hole.points.map((point) => new THREE.Vector2(point.x, point.y))));
    }
    let geometry: THREE.ExtrudeGeometry;
    try {
      geometry = new THREE.ExtrudeGeometry(shape, {
        depth,
        steps: 1,
        bevelEnabled: false,
        curveSegments: 10,
      });
    } catch {
      continue;
    }
    geometry.applyMatrix4(matrix);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.raycast = () => undefined;
    group.add(mesh);
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 24), lineMaterial);
    outline.raycast = () => undefined;
    group.add(outline);
  }
  if (!group.children.length) {
    material.dispose();
    lineMaterial.dispose();
    return null;
  }
  return finishGroup(group, tone);
}

/** Collar along the selected edges that shows which edges and what radius. */
export function edgeGhost(mesh: MeshData, edgeIndices: number[], size: number, kind: "fillet" | "chamfer"): THREE.Group | null {
  if (!edgeIndices.length) return null;
  const tone: GhostTone = kind;
  const group = new THREE.Group();
  const material = ghostMaterial(tone, 0.42);
  const lineMaterial = new THREE.LineBasicMaterial({
    color: toneColor(tone),
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  const radius = Math.max(0.05, size) * (kind === "fillet" ? 1 : 0.55);
  for (const index of edgeIndices) {
    const edge = mesh.edges.find((candidate) => candidate.index === index);
    if (!edge || edge.points.length < 2) continue;
    const points = edge.points.map((point) => new THREE.Vector3(...point));
    if (points.length === 2) {
      // A straight edge needs a mid-point for CatmullRom; otherwise the tube
      // collapses to a point.
      points.splice(1, 0, points[0].clone().add(points[1]).multiplyScalar(0.5));
    }
    const curve = new THREE.CatmullRomCurve3(points, Boolean(edge.closed), "centripetal");
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(curve, Math.min(96, Math.max(12, points.length * 4)), radius, 10, Boolean(edge.closed)),
      material,
    );
    tube.raycast = () => undefined;
    group.add(tube);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(edge.points.map((point) => new THREE.Vector3(...point))), lineMaterial);
    line.raycast = () => undefined;
    group.add(line);
  }
  if (!group.children.length) {
    material.dispose();
    lineMaterial.dispose();
    return null;
  }
  return finishGroup(group, tone);
}

/** Ribbon preview for an Edge Flange: direction, angle and length. */
export function edgeFlangeGhost(
  edge: EdgeInfo,
  length: number,
  angleDeg: number,
  planeNormal: [number, number, number],
  bodyCenter: [number, number, number],
): THREE.Group | null {
  if (edge.points.length < 2 || length <= 0) return null;
  const points = edge.points.map((point) => new THREE.Vector3(...point));
  const start = points[0];
  const end = points[points.length - 1];
  const along = end.clone().sub(start);
  if (along.lengthSq() < 1e-8) return null;
  along.normalize();
  const normal = new THREE.Vector3(...planeNormal).normalize();
  const inPlane = new THREE.Vector3().crossVectors(normal, along).normalize();
  const mid = points[Math.floor(points.length / 2)];
  const center = new THREE.Vector3(...bodyCenter);
  if (inPlane.dot(mid.clone().sub(center)) < 0) inPlane.negate();
  const angle = (angleDeg * Math.PI) / 180;
  let direction = inPlane.clone().applyAxisAngle(along, angle);
  if (direction.dot(normal) < 0) {
    direction = inPlane.clone().applyAxisAngle(along, -angle);
  }
  const offset = direction.clone().multiplyScalar(length);
  const positions: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const c = b.clone().add(offset);
    const d = a.clone().add(offset);
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    positions.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, ghostMaterial("sheet", 0.38));
  mesh.raycast = () => undefined;
  const group = new THREE.Group();
  group.add(mesh);
  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry, 20),
    new THREE.LineBasicMaterial({ color: toneColor("sheet"), transparent: true, opacity: 0.9, depthWrite: false }),
  );
  outline.raycast = () => undefined;
  group.add(outline);
  return finishGroup(group, "sheet");
}
