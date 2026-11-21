/* MarmaraCad geometry kernel worker — OpenCascade.js (OCCT WASM).
 * All B-Rep modelling, tessellation and STEP/IGES exchange happens here so the
 * UI thread never blocks on the CAD kernel. */
import { getOcct, occtCacheInfo } from "./occt";
import type { ExportRequest, ImportRequest, KernelResponse, RebuildRequest } from "./protocol";
import type { EdgeInfo, FaceInfo, Feature, MeshData, Part, RebuildPart, Sketch, SketchPlane, Vec3 } from "../model/types";
import { buildProfileGroups, planePoint, type ProfileGroup, type ProfileLoop } from "../sketch/geometry";

let oc: any = null;
let bootMs = 0;
const partShapes = new Map<string, any>();
const importedShapes = new Map<string, { rev: string; shape: any }>();

const enumVal = (v: any): number => (typeof v === "number" ? v : v?.value ?? -1);
const DEG = Math.PI / 180;

function post(msg: KernelResponse, transfer?: Transferable[]) {
  (self as any).postMessage(msg, transfer ?? []);
}

function gpPnt(v: Vec3): any {
  return new oc.gp_Pnt_3(v[0], v[1], v[2]);
}
function gpVec(v: Vec3): any {
  return new oc.gp_Vec_4(v[0], v[1], v[2]);
}
function gpDir(v: Vec3): any {
  return new oc.gp_Dir_4(v[0], v[1], v[2]);
}

function applyTrsf(p: Vec3, trsf: any): Vec3 {
  return [
    trsf.Value(1, 1) * p[0] + trsf.Value(1, 2) * p[1] + trsf.Value(1, 3) * p[2] + trsf.Value(1, 4),
    trsf.Value(2, 1) * p[0] + trsf.Value(2, 2) * p[1] + trsf.Value(2, 3) * p[2] + trsf.Value(2, 4),
    trsf.Value(3, 1) * p[0] + trsf.Value(3, 2) * p[1] + trsf.Value(3, 3) * p[2] + trsf.Value(3, 4),
  ];
}

function shiftPlane(plane: SketchPlane, offset: number): SketchPlane {
  return {
    ...plane,
    origin: [
      plane.origin[0] + plane.n[0] * offset,
      plane.origin[1] + plane.n[1] * offset,
      plane.origin[2] + plane.n[2] * offset,
    ],
  };
}

function wireFromLoop(loop: ProfileLoop, plane: SketchPlane, hole: boolean): any {
  if (loop.circleOnly) {
    const seg = loop.segments[0];
    if (seg.kind !== "circle") throw new Error("Invalid circular profile.");
    const center3 = planePoint(plane, seg.center);
    const ax = new oc.gp_Ax2_3(gpPnt(center3), gpDir(plane.n));
    const circ = new oc.gp_Circ_2(ax, Math.max(1e-4, seg.radius));
    let edge = new oc.BRepBuilderAPI_MakeEdge_8(circ).Edge();
    if (hole) edge = oc.TopoDS.Edge_1(edge.Reversed());
    return new oc.BRepBuilderAPI_MakeWire_2(edge).Wire();
  }
  let pts = loop.points;
  if (hole) pts = [...pts].reverse();
  if (pts.length < 3) throw new Error("Sketch profile has fewer than 3 points.");
  const poly = new oc.BRepBuilderAPI_MakePolygon_1();
  for (const p of pts) poly.Add_1(gpPnt(planePoint(plane, p)));
  poly.Close();
  if (!poly.IsDone()) throw new Error("Could not build a closed wire from the sketch profile.");
  return poly.Wire();
}

function facesFromSketch(sketch: Sketch, planeOverride?: SketchPlane): any[] {
  const { groups, openChains } = buildProfileGroups(sketch);
  if (openChains.length > 0) throw new Error("Sketch has an open contour. Close the profile first.");
  if (groups.length === 0) throw new Error("Sketch has no closed profile.");
  const plane = planeOverride ?? sketch.plane;
  const faces: any[] = [];
  for (const group of groups) {
    const outerWire = wireFromLoop(group.outer, plane, false);
    const mf = new oc.BRepBuilderAPI_MakeFace_15(outerWire, true);
    for (const hole of group.holes) {
      try {
        mf.Add(wireFromLoop(hole, plane, true));
      } catch {
        // A bad inner loop should not discard the whole profile; OCCT reports the failure on Face().
      }
    }
    const face = mf.Face();
    if (!face || face.IsNull()) throw new Error("OCCT could not create a face from the sketch.");
    faces.push(face);
  }
  return faces;
}

function fuseShapes(shapes: any[]): any {
  if (shapes.length === 0) return null;
  let out = shapes[0];
  for (let i = 1; i < shapes.length; i++) {
    const fused = new oc.BRepAlgoAPI_Fuse_3(out, shapes[i]);
    fused.Build();
    if (!fused.IsDone()) throw new Error("Boolean union failed.");
    out = fused.Shape();
  }
  return out;
}

function applyBoolean(current: any, tool: any, cut: boolean): any {
  if (!current || current.IsNull()) {
    if (cut) throw new Error("A cut feature needs existing material. Create a boss first.");
    return tool;
  }
  const bool = cut ? new oc.BRepAlgoAPI_Cut_3(current, tool) : new oc.BRepAlgoAPI_Fuse_3(current, tool);
  bool.Build();
  if (!bool.IsDone()) throw new Error(cut ? "Boolean cut failed. Check that the tool intersects the body." : "Boolean union failed.");
  const shape = bool.Shape();
  if (!shape || shape.IsNull()) throw new Error("Boolean operation produced an empty shape.");
  return shape;
}

function extrudeFeature(sketch: Sketch, feature: Feature, shape: any): any {
  const depth = Math.abs(feature.params.depth ?? 10);
  if (depth < 1e-4) throw new Error("Extrude depth must be greater than zero.");
  const direction = feature.params.direction ?? 1;
  const symmetric = feature.params.symmetric ?? false;
  const plane = symmetric ? shiftPlane(sketch.plane, (-depth / 2) * direction) : sketch.plane;
  const faces = facesFromSketch(sketch, plane);
  let vecLen = depth;
  if (symmetric) vecLen = depth;
  const tools = faces.map((face) => {
    const prism = new oc.BRepPrimAPI_MakePrism_1(face, gpVec([
      sketch.plane.n[0] * vecLen * direction,
      sketch.plane.n[1] * vecLen * direction,
      sketch.plane.n[2] * vecLen * direction,
    ]), false, true);
    const s = prism.Shape();
    if (!s || s.IsNull()) throw new Error("Extrude failed.");
    return s;
  });
  const tool = fuseShapes(tools);
  const cut = feature.type === "cut" || feature.params.operation === "cut";
  return applyBoolean(shape, tool, cut);
}

function revolveFeature(sketch: Sketch, feature: Feature, shape: any): any {  const angleDeg = Math.abs(feature.params.angle ?? 360);
  if (angleDeg < 1e-3) throw new Error("Revolve angle must be greater than zero.");
  const angle = angleDeg >= 359.999 ? Math.PI * 2 : angleDeg * DEG;
  let axis: any;
  const mode = feature.params.axisMode ?? "v";
  if (mode === "entity" && feature.params.axisEntityId) {
    const line = sketch.entities.find((e) => e.id === feature.params.axisEntityId);
    if (!line || line.kind !== "line") throw new Error("Select a line in the sketch as the revolve axis.");
    const a = sketch.points.find((p) => p.id === line.p1);
    const b = sketch.points.find((p) => p.id === line.p2);
    if (!a || !b) throw new Error("Revolve axis line is incomplete.");
    const p3 = planePoint(sketch.plane, a);
    const q3 = planePoint(sketch.plane, b);
    const dir: Vec3 = [q3[0] - p3[0], q3[1] - p3[1], q3[2] - p3[2]];
    const len = Math.hypot(...dir) || 1;
    axis = new oc.gp_Ax1_2(gpPnt(p3), gpDir([dir[0] / len, dir[1] / len, dir[2] / len]));
  } else {
    const dir = mode === "u" ? sketch.plane.u : sketch.plane.v;
    axis = new oc.gp_Ax1_2(gpPnt(sketch.plane.origin), gpDir(dir));
  }
  const faces = facesFromSketch(sketch);
  const tools = faces.map((face) => {
    const rev = new oc.BRepPrimAPI_MakeRevol_1(face, axis, angle, false);
    const s = rev.Shape();
    if (!s || s.IsNull()) throw new Error("Revolve failed. The profile must not cross the axis.");
    return s;
  });
  const tool = fuseShapes(tools);
  const cut = feature.type === "cut" || feature.params.operation === "cut";
  return applyBoolean(shape, tool, cut);
}

function makeBoxBetween(min: Vec3, max: Vec3): any {
  const attempts: (() => any)[] = [
    () => new oc.BRepPrimAPI_MakeBox_4(gpPnt(min), gpPnt(max)).Shape(),
    () => new oc.BRepPrimAPI_MakeBox_3(gpPnt(min), gpPnt(max)).Shape(),
    () => new oc.BRepPrimAPI_MakeBox_2(gpPnt(min), gpPnt(max)).Shape(),
    () => new oc.BRepPrimAPI_MakeBox_1(max[0] - min[0], max[1] - min[1], max[2] - min[2]).Shape(),
  ];
  let last: unknown = null;
  for (const make of attempts) {
    try {
      const shape = make();
      if (shape && !shape.IsNull()) return shape;
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`OCCT could not build the shell tool${last ? `: ${String(last)}` : "."}`);
}

function bboxOf(shape: any): { min: Vec3; max: Vec3 } {
  const box = new oc.Bnd_Box_1();
  oc.BRepBndLib.Add(shape, box, true);
  const pmin = box.CornerMin();
  const pmax = box.CornerMax();
  return {
    min: [pmin.X(), pmin.Y(), pmin.Z()],
    max: [pmax.X(), pmax.Y(), pmax.Z()],
  };
}

/** Constant-wall shell. Uses a shrunken bounding box cut through the +Y face,
 *  which is exact for the prismatic parts this course models (box, plate,
 *  enclosure) and keeps the operation inside the OCCT bindings that are
 *  available in opencascade.js. */
function shellFeature(shape: any, feature: Feature): any {
  const t = Math.abs(feature.params.thickness ?? 2);
  if (t < 1e-3) throw new Error("Shell thickness must be greater than zero.");
  const b = bboxOf(shape);
  const min: Vec3 = [b.min[0] + t, b.min[1] + t, b.min[2] + t];
  const max: Vec3 = [b.max[0] - t, b.max[1] + Math.max(1, t), b.max[2] - t];
  if (max[0] <= min[0] || max[1] <= min[1] || max[2] <= min[2]) throw new Error("Shell thickness is too large for this body.");
  const tool = makeBoxBetween(min, max);
  return applyBoolean(shape, tool, true);
}

function mirrorFeature(shape: any, feature: Feature): any {
  const plane = feature.params.mirrorPlane ?? "right";
  const normal: Vec3 = plane === "top" ? [0, 1, 0] : plane === "front" ? [0, 0, 1] : [1, 0, 0];
  const trsf = new oc.gp_Trsf_1();
  trsf.SetMirror_3(new oc.gp_Ax2_3(gpPnt([0, 0, 0]), gpDir(normal)));
  const copy = new oc.BRepBuilderAPI_Transform_2(shape, trsf, true).Shape();
  return applyBoolean(shape, copy, false);
}

function patternFeature(shape: any, feature: Feature): any {
  const count = Math.max(2, Math.round(feature.params.patternCount ?? 2));
  const spacing = Number(feature.params.patternSpacing ?? 10);
  const axis = feature.params.patternAxis ?? "x";
  const dir: Vec3 = axis === "y" ? [0, spacing, 0] : axis === "z" ? [0, 0, spacing] : [spacing, 0, 0];
  const copies: any[] = [shape];
  for (let i = 1; i < count; i++) {
    const trsf = new oc.gp_Trsf_1();
    trsf.SetTranslation_1(gpVec([dir[0] * i, dir[1] * i, dir[2] * i]));
    copies.push(new oc.BRepBuilderAPI_Transform_2(shape, trsf, true).Shape());
  }
  return fuseShapes(copies);
}

/** Unique topological edges of a shape.
 *
 *  TopExp_Explorer visits a shared edge once per adjacent face, so a plain
 *  traversal returns every box edge twice. Deduplicating by the sampled
 *  endpoint/midpoint key keeps picking, highlighting and fillet indices
 *  one-to-one with the edges the user actually sees. */
function collectEdges(shape: any): any[] {
  const edges: any[] = [];
  const seen = new Map<string, any[]>();
  const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while (exp.More()) {
    const edge = oc.TopoDS.Edge_1(exp.Current());
    let key = "";
    try {
      if (oc.BRep_Tool.Degenerated(edge)) {
        exp.Next();
        continue;
      }
      const curve = new oc.BRepAdaptor_Curve_2(edge);
      const first = curve.FirstParameter();
      const last = curve.LastParameter();
      const mid = curve.Value((first + last) / 2);
      const a = curve.Value(first);
      const b = curve.Value(last);
      const round = (v: number) => Math.round(v * 1000) / 1000;
      const pa = [round(a.X()), round(a.Y()), round(a.Z())].join(",");
      const pb = [round(b.X()), round(b.Y()), round(b.Z())].join(",");
      key = [pa < pb ? pa : pb, pa < pb ? pb : pa, round(mid.X()), round(mid.Y()), round(mid.Z()), enumVal(curve.GetType())].join("|");
    } catch {
      key = "";
    }
    if (key && seen.has(key)) {
      const bucket = seen.get(key)!;
      if (bucket.some((other) => other.IsSame(edge))) {
        exp.Next();
        continue;
      }
      bucket.push(edge);
    } else if (key) {
      seen.set(key, [edge]);
    }
    edges.push(edge);
    exp.Next();
  }
  return edges;
}

function filletFeature(shape: any, feature: Feature): any {
  const radius = Math.abs(feature.params.radius ?? 2);
  if (radius < 1e-4) throw new Error("Fillet radius must be greater than zero.");
  const indices = feature.params.edgeIndices ?? [];
  if (indices.length === 0) throw new Error("No edges were selected for the fillet.");
  const edges = collectEdges(shape);
  const fillet = new oc.BRepFilletAPI_MakeFillet(shape, oc.ChFi3d_FilletShape.ChFi3d_Rational);
  for (const idx of indices) {
    if (idx < 0 || idx >= edges.length) throw new Error(`Edge ${idx + 1} no longer exists after the model change.`);
    fillet.Add_2(radius, edges[idx]);
  }
  fillet.Build();
  if (!fillet.IsDone()) throw new Error("Fillet failed. The radius may be too large for the selected edges.");
  return fillet.Shape();
}

function chamferFeature(shape: any, feature: Feature): any {
  const distance = Math.abs(feature.params.distance ?? 1);
  if (distance < 1e-4) throw new Error("Chamfer distance must be greater than zero.");
  const indices = feature.params.edgeIndices ?? [];
  if (indices.length === 0) throw new Error("No edges were selected for the chamfer.");
  const edges = collectEdges(shape);
  const chamfer = new oc.BRepFilletAPI_MakeChamfer(shape);
  for (const idx of indices) {
    if (idx < 0 || idx >= edges.length) throw new Error(`Edge ${idx + 1} no longer exists after the model change.`);
    chamfer.Add_2(distance, edges[idx]);
  }
  chamfer.Build();
  if (!chamfer.IsDone()) throw new Error("Chamfer failed. The distance may be too large for the selected edges.");
  return chamfer.Shape();
}

/** See EXPORT_PATHS: OCCT cannot open FS paths longer than 10 characters in this
 * Emscripten build, so import/rebuild exchange files use short fixed names too. */
const READ_PATHS = { step: "/i.step", iges: "/i.igs" } as const;

async function ensureImport(partId: string, format: "step" | "iges", data: ArrayBuffer, rev: string): Promise<any> {
  const cached = importedShapes.get(partId);
  if (cached && cached.rev === rev) return cached.shape;
  const path = READ_PATHS[format];
  oc.FS.writeFile(path, new Uint8Array(data));
  let shape: any = null;
  try {
    if (format === "step") {
      const reader = new oc.STEPControl_Reader_1();
      const status = reader.ReadFile(path);
      if (enumVal(status) !== 1) throw new Error("STEP reader could not open the file.");
      reader.TransferRoots();
      shape = reader.OneShape();
    } else {
      const reader = new oc.IGESControl_Reader_1();
      const status = reader.ReadFile(path);
      if (enumVal(status) !== 1) throw new Error("IGES reader could not open the file.");
      reader.TransferRoots();
      shape = reader.OneShape();
    }
  } finally {
    try {
      oc.FS.unlink(path);
    } catch {
      /* ignore */
    }
  }
  if (!shape || shape.IsNull()) throw new Error("The file did not contain a transferable solid.");
  importedShapes.set(partId, { rev, shape });
  return shape;
}

function tessellate(shape: any, quality: number): MeshData {
  const linDeflection = Math.max(0.02, quality || 0.12);
  new oc.BRepMesh_IncrementalMesh_2(shape, linDeflection, false, 0.35, true);
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const triFaceIds: number[] = [];
  const faces: FaceInfo[] = [];
  const warnings: string[] = [];
  const bboxMin: Vec3 = [Infinity, Infinity, Infinity];
  const bboxMax: Vec3 = [-Infinity, -Infinity, -Infinity];

  const expFaces = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  let faceIndex = 0;
  const allTris: { a: Vec3; b: Vec3; c: Vec3; faceId: number }[] = [];

  while (expFaces.More()) {
    const face = oc.TopoDS.Face_1(expFaces.Current());
    // The triangulation winds along the underlying surface parameterisation. OCCT
    // stores the solid's outward sense in the face orientation, so reversed faces
    // must have their triangle winding (and normals) flipped.
    const reversed = enumVal(face.Orientation_1()) === 1;
    const loc = new oc.TopLoc_Location_1();
    const triHandle = oc.BRep_Tool.Triangulation(face, loc);
    const triStart = triFaceIds.length;
    const faceTriangles: { a: Vec3; b: Vec3; c: Vec3; n: Vec3 }[] = [];
    let triCount = 0;
    let normalSum: Vec3 = [0, 0, 0];
    let centroidSum: Vec3 = [0, 0, 0];
    let areaSum = 0;
    let smooth = true;

    if (triHandle && !triHandle.IsNull()) {
      const tri = triHandle.get();
      const identity = loc.IsIdentity();
      const trsf = identity ? null : loc.Transformation();
      const nNodes = tri.NbNodes();
      const nTris = tri.NbTriangles();
      const nodes: Vec3[] = new Array(nNodes + 1);
      for (let i = 1; i <= nNodes; i++) {
        const p = tri.Node(i);
        let v: Vec3 = [p.X(), p.Y(), p.Z()];
        if (trsf) v = applyTrsf(v, trsf);
        nodes[i] = v;
        if (v[0] < bboxMin[0]) bboxMin[0] = v[0];
        if (v[1] < bboxMin[1]) bboxMin[1] = v[1];
        if (v[2] < bboxMin[2]) bboxMin[2] = v[2];
        if (v[0] > bboxMax[0]) bboxMax[0] = v[0];
        if (v[1] > bboxMax[1]) bboxMax[1] = v[1];
        if (v[2] > bboxMax[2]) bboxMax[2] = v[2];
      }
      for (let i = 1; i <= nTris; i++) {
        const t = tri.Triangle(i);
        let ia = t.Value(1);
        let ib = t.Value(2);
        let ic = t.Value(3);
        const A = nodes[ia];
        const B0 = nodes[ib];
        const C0 = nodes[ic];
        if (!A || !B0 || !C0) continue;
        const B = reversed ? C0 : B0;
        const C = reversed ? B0 : C0;
        const ab: Vec3 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
        const ac: Vec3 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
        const n: Vec3 = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
        const area = Math.hypot(n[0], n[1], n[2]) * 0.5;
        if (area < 1e-12) continue;
        const inv = 1 / (area * 2);
        n[0] *= inv;
        n[1] *= inv;
        n[2] *= inv;
        faceTriangles.push({ a: A, b: B, c: C, n });
        normalSum = [normalSum[0] + n[0] * area, normalSum[1] + n[1] * area, normalSum[2] + n[2] * area];
        centroidSum = [
          centroidSum[0] + ((A[0] + B[0] + C[0]) / 3) * area,
          centroidSum[1] + ((A[1] + B[1] + C[1]) / 3) * area,
          centroidSum[2] + ((A[2] + B[2] + C[2]) / 3) * area,
        ];
        areaSum += area;
        triCount++;
      }
    }

    // Metadata for planar / cylindrical faces (used by mates and FEA boundary picks).
    let surfaceType = "other";
    let metaPoint: Vec3 = [0, 0, 0];
    let metaNormal: Vec3 = [0, 0, 1];
    let axis: Vec3 | undefined;
    let radius: number | undefined;
    try {
      const ad = new oc.BRepAdaptor_Surface_2(face, true);
      const ty = enumVal(ad.GetType());
      if (ty === 0) {
        surfaceType = "plane";
        const pl = ad.Plane();
        const ax = pl.Axis();
        const p = ax.Location();
        const d = ax.Direction();
        metaPoint = [p.X(), p.Y(), p.Z()];
        metaNormal = [d.X(), d.Y(), d.Z()];
        smooth = false;
      } else if (ty === 1) {
        surfaceType = "cylinder";
        const cyl = ad.Cylinder();
        const ax = cyl.Axis();
        const p = ax.Location();
        const d = ax.Direction();
        metaPoint = [p.X(), p.Y(), p.Z()];
        axis = [d.X(), d.Y(), d.Z()];
        radius = cyl.Radius();
      } else if (ty === 2) {
        surfaceType = "cone";
      } else if (ty === 3) {
        surfaceType = "sphere";
      } else if (ty === 4) {
        surfaceType = "torus";
      }
    } catch (e) {
      if (warnings.length < 3) warnings.push("face metadata error: " + String(e));
    }

    if (areaSum > 0) {
      const cx = centroidSum[0] / areaSum;
      const cy = centroidSum[1] / areaSum;
      const cz = centroidSum[2] / areaSum;
      if (surfaceType === "plane") metaPoint = [cx, cy, cz];
      if (surfaceType === "plane" && Math.hypot(normalSum[0], normalSum[1], normalSum[2]) > 1e-9) {
        const inv = 1 / Math.hypot(normalSum[0], normalSum[1], normalSum[2]);
        metaNormal = [normalSum[0] * inv, normalSum[1] * inv, normalSum[2] * inv];
      }
    }

    // Smooth normals within each face (hard edges are preserved between faces).
    const normalMap = new Map<string, Vec3>();
    const keyOf = (v: Vec3) => `${Math.round(v[0] * 1e4)},${Math.round(v[1] * 1e4)},${Math.round(v[2] * 1e4)}`;
    if (smooth) {
      for (const tri of faceTriangles) {
        for (const v of [tri.a, tri.b, tri.c]) {
          const k = keyOf(v);
          const acc = normalMap.get(k) ?? [0, 0, 0];
          normalMap.set(k, [acc[0] + tri.n[0], acc[1] + tri.n[1], acc[2] + tri.n[2]]);
        }
      }
    }
    for (const tri of faceTriangles) {
      const triNormal = tri.n;
      for (const v of [tri.a, tri.b, tri.c]) {
        const n = smooth ? normalMap.get(keyOf(v)) ?? triNormal : triNormal;
        const len = Math.hypot(n[0], n[1], n[2]) || 1;
        positions.push(v[0], v[1], v[2]);
        normals.push(n[0] / len, n[1] / len, n[2] / len);
        allTris.push({ a: tri.a, b: tri.b, c: tri.c, faceId: faceIndex });
      }
      indices.push(positions.length / 3 - 3, positions.length / 3 - 2, positions.length / 3 - 1);
      triFaceIds.push(faceIndex);
    }

    faces.push({
      index: faceIndex,
      surface: surfaceType as FaceInfo["surface"],
      point: metaPoint,
      normal: metaNormal,
      axis,
      radius,
      triStart,
      triCount,
    });
    faceIndex++;
    expFaces.Next();
  }

  // Divergence-theorem signed volume. A correctly oriented closed mesh yields a
  // positive value; a negative one means the winding is inverted overall.
  let signedVolume = 0;
  for (const tri of allTris) {
    signedVolume +=
      (tri.a[0] * (tri.b[1] * tri.c[2] - tri.b[2] * tri.c[1]) -
        tri.a[1] * (tri.b[0] * tri.c[2] - tri.b[2] * tri.c[0]) +
        tri.a[2] * (tri.b[0] * tri.c[1] - tri.b[1] * tri.c[0])) /
      6;
  }
  if (signedVolume < 0 && indices.length > 0) {
    for (let i = 0; i < normals.length; i++) normals[i] = -normals[i];
    for (let i = 0; i < indices.length; i += 3) {
      const t = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = t;
    }
    for (const f of faces) {
      f.normal = [-f.normal[0], -f.normal[1], -f.normal[2]];
    }
  }

  // Topological edges as smooth polylines for display and picking.
  const edges: EdgeInfo[] = [];
  try {
    const topoEdges = collectEdges(shape);
    for (let edgeIndex = 0; edgeIndex < topoEdges.length; edgeIndex++) {
      const edge = topoEdges[edgeIndex];
      try {
        const curve = new oc.BRepAdaptor_Curve_2(edge);
        const first = curve.FirstParameter();
        const last = curve.LastParameter();
        const type = enumVal(curve.GetType());
        const samples = type === 0 ? 2 : type === 1 ? 64 : 36;
        const pts: Vec3[] = [];
        let length = 0;
        let prev: Vec3 | null = null;
        for (let i = 0; i < samples; i++) {
          const t = first + ((last - first) * i) / (samples - 1);
          const p = curve.Value(t);
          const v: Vec3 = [p.X(), p.Y(), p.Z()];
          if (prev) length += Math.hypot(v[0] - prev[0], v[1] - prev[1], v[2] - prev[2]);
          pts.push(v);
          prev = v;
        }
        if (pts.length >= 2 && length > 1e-5) {
          edges.push({ index: edgeIndex, points: pts, length, closed: false });
        }
      } catch (e) {
        if (warnings.length < 8) warnings.push("edge read error: " + String(e));
      }
    }
  } catch (e) {
    warnings.push("edge explorer error: " + String(e));
  }

  let volume = 0;
  let area = 0;
  try {
    const vp = new oc.GProp_GProps_1();
    oc.BRepGProp.VolumeProperties_1(shape, vp, false, false, false);
    volume = Math.abs(vp.Mass());
    const sp = new oc.GProp_GProps_1();
    oc.BRepGProp.SurfaceProperties_1(shape, sp, false, false);
    area = Math.abs(sp.Mass());
  } catch {
    /* properties are optional */
  }

  if (!Number.isFinite(bboxMin[0])) {
    bboxMin[0] = bboxMin[1] = bboxMin[2] = 0;
    bboxMax[0] = bboxMax[1] = bboxMax[2] = 0;
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    triFaceIds: new Uint32Array(triFaceIds),
    faces,
    edges,
    volume,
    area,
    bbox: { min: bboxMin, max: bboxMax },
    shapeType: "solid",
    warnings,
  };
}

function buildPart(part: RebuildPart, quality: number): { mesh: MeshData; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  let shape: any = null;
  let baseImported: any = null;
  if ((part.assetFormat === "step" || part.assetFormat === "iges") && part.assetBase64) {
    try {
      const bytes = Uint8Array.from(atob(part.assetBase64), (c) => c.charCodeAt(0)).buffer;
      baseImported = (importedShapes.get(part.id)?.rev === part.assetRev
        ? importedShapes.get(part.id)!.shape
        : null) ?? null;
      if (!baseImported) {
        // Importing is async in the protocol, but Uint8Array construction above is sync.
        // The client sends the asset on rebuild, so perform the import inline.
        const format = part.assetFormat;
        const path = format === "step" ? "/r.step" : "/r.igs";
        oc.FS.writeFile(path, new Uint8Array(bytes));
        try {
          const reader = format === "step" ? new oc.STEPControl_Reader_1() : new oc.IGESControl_Reader_1();
          const status = reader.ReadFile(path);
          if (enumVal(status) !== 1) throw new Error("The imported file could not be read.");
          reader.TransferRoots();
          baseImported = reader.OneShape();
        } finally {
          try {
            oc.FS.unlink(path);
          } catch {
            /* ignore */
          }
        }
        if (!baseImported || baseImported.IsNull()) throw new Error("The imported file did not contain a solid.");
        importedShapes.set(part.id, { rev: part.assetRev ?? "", shape: baseImported });
      }
    } catch (e) {
      errors["import"] = String(e);
    }
  }
  shape = baseImported;

  const rollback = part.rollbackIndex ?? part.features.length;
  for (let featureIndex = 0; featureIndex < part.features.length; featureIndex++) {
    const feature = part.features[featureIndex];
    if (featureIndex >= rollback) break;
    if (feature.suppressed) continue;
    try {
      if (feature.type === "imported") {
        if (baseImported) shape = baseImported;
        else throw new Error("Imported body data is missing.");
      } else if (feature.type === "extrude" || feature.type === "cut") {
        const sketch = part.sketches.find((s) => s.id === feature.sketchId);
        if (!sketch) throw new Error("The sketch for this feature was deleted.");
        shape = extrudeFeature(sketch, feature, shape);
      } else if (feature.type === "revolve") {
        const sketch = part.sketches.find((s) => s.id === feature.sketchId);
        if (!sketch) throw new Error("The sketch for this feature was deleted.");
        shape = revolveFeature(sketch, feature, shape);
      } else if (feature.type === "fillet") {
        if (!shape) throw new Error("Fillet needs an existing body.");
        shape = filletFeature(shape, feature);
      } else if (feature.type === "chamfer") {
        if (!shape) throw new Error("Chamfer needs an existing body.");
        shape = chamferFeature(shape, feature);
      } else if (feature.type === "shell") {
        if (!shape) throw new Error("Shell needs an existing body.");
        shape = shellFeature(shape, feature);
      } else if (feature.type === "mirror") {
        if (!shape) throw new Error("Mirror needs an existing body.");
        shape = mirrorFeature(shape, feature);
      } else if (feature.type === "pattern") {
        if (!shape) throw new Error("Linear pattern needs an existing body.");
        shape = patternFeature(shape, feature);
      }
    } catch (e) {
      errors[feature.id] = e instanceof Error ? e.message : String(e);
    }
  }

  if (!shape || shape.IsNull()) {
    const empty: MeshData = {
      positions: new Float32Array(),
      normals: new Float32Array(),
      indices: new Uint32Array(),
      triFaceIds: new Uint32Array(),
      faces: [],
      edges: [],
      volume: 0,
      area: 0,
      bbox: { min: [0, 0, 0], max: [0, 0, 0] },
      shapeType: "empty",
      warnings: Object.values(errors),
    };
    return { mesh: empty, errors };
  }

  partShapes.set(part.id, shape);
  const mesh = tessellate(shape, quality);
  mesh.warnings = [...mesh.warnings, ...Object.values(errors)];
  return { mesh, errors };
}

function matrixToTrsf(matrix: number[]): any {
  const t = new oc.gp_Trsf_1();
  t.SetValues(
    matrix[0], matrix[4], matrix[8], matrix[12],
    matrix[1], matrix[5], matrix[9], matrix[13],
    matrix[2], matrix[6], matrix[10], matrix[14],
  );
  return t;
}

function buildCompound(targets: { partId: string; matrix?: number[] }[]): any {
  if (targets.length === 1) {
    const shape = partShapes.get(targets[0].partId);
    if (!shape) throw new Error("Part geometry is not available. Rebuild the model first.");
    if (!targets[0].matrix) return shape;
    const tr = new oc.BRepBuilderAPI_Transform_2(shape, matrixToTrsf(targets[0].matrix), true);
    return tr.Shape();
  }
  const builder = new oc.BRep_Builder();
  const compound = new oc.TopoDS_Compound();
  builder.MakeCompound(compound);
  for (const target of targets) {
    const shape = partShapes.get(target.partId);
    if (!shape) continue;
    const transformed = target.matrix
      ? new oc.BRepBuilderAPI_Transform_2(shape, matrixToTrsf(target.matrix), true).Shape()
      : shape;
    builder.Add(compound, transformed);
  }
  return compound;
}

async function handleRebuild(req: RebuildRequest) {
  const t0 = performance.now();
  const meshes: Record<string, MeshData> = {};
  const errors: Record<string, Record<string, string>> = {};
  for (const part of req.parts) {
    const result = buildPart(part, req.quality ?? 0.12);
    meshes[part.id] = result.mesh;
    if (Object.keys(result.errors).length) errors[part.id] = result.errors;
  }
  post({ type: "rebuild", parts: meshes, errors, kernelMs: Math.round(performance.now() - t0) });
}

async function handleImport(req: ImportRequest) {
  try {
    const shape = await ensureImport(req.partId, req.format, req.data, req.rev);
    partShapes.set(req.partId, shape);
    const mesh = tessellate(shape, 0.15);
    post({ type: "import", partId: req.partId, mesh });
  } catch (e) {
    post({ type: "import", partId: req.partId, mesh: null, error: e instanceof Error ? e.message : String(e) });
  }
}

/** OCCT's Emscripten build corrupts output file names longer than 10 characters:
 * the write reports success but the file lands under a mangled name that can no
 * longer be looked up. Kernel exchange files therefore use short ASCII names;
 * the user-facing download name is applied on the UI side. */
const EXPORT_PATHS = { step: "/o.step", iges: "/o.igs" } as const;

async function handleExport(req: ExportRequest) {
  const path = EXPORT_PATHS[req.format];
  try {
    const shape = buildCompound(req.targets);
    if (req.format === "step") {
      const writer = new oc.STEPControl_Writer_1();
      const transfer = writer.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true);
      if (enumVal(transfer) !== 1) throw new Error(`STEP transfer failed: status ${enumVal(transfer)}.`);
      const status = writer.Write(path);
      if (enumVal(status) !== 1) throw new Error(`STEP writer failed: status ${enumVal(status)}.`);
    } else {
      const writer = new oc.IGESControl_Writer_2("MM", 1);
      writer.AddShape(shape);
      writer.ComputeModel();
      // The stream overload (Write_1) is not bound in opencascade.js; the file
      // overload takes (filename, bureautic-mode) and must be called with both.
      if (!writer.Write_2(path, false)) throw new Error("IGES writer failed.");
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(oc.FS.readFile(path));
    } catch (e) {
      throw new Error(`The exported CAD file could not be read back (${String(e)}).`);
    }
    if (bytes.length === 0) throw new Error("The CAD exporter produced an empty file.");
    post({ type: "export", bytes, filename: req.filename }, [bytes.buffer]);
  } catch (e) {
    post({ type: "export", bytes: null, filename: req.filename, error: e instanceof Error ? e.message : String(e) });
  } finally {
    try {
      oc.FS.unlink(path);
    } catch {
      /* ignore */
    }
  }
}

async function boot() {
  const t0 = performance.now();
  oc = await getOcct((progress) => {
    post({ type: "boot-progress", phase: progress.phase, percent: progress.percent });
  });
  bootMs = Math.round(performance.now() - t0);
  const info = occtCacheInfo();
  post({ type: "ready", bootMs, fromCache: info.fromCache, wasmBytes: info.bytes });
}

self.onmessage = async (e: MessageEvent) => {
  const req = e.data;
  try {
    if (req.type === "boot") await boot();
    else if (req.type === "rebuild") await handleRebuild(req);
    else if (req.type === "import") await handleImport(req);
    else if (req.type === "export") await handleExport(req);
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err), stack: (err as Error)?.stack });
  }
};

boot().catch((err) => post({ type: "error", message: String(err), stack: (err as Error)?.stack }));
