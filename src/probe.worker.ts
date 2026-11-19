import { getOcct } from "./kernel/occt";

let oc: any = null;
let logs: string[] = [];

async function boot() {
  const t0 = performance.now();
  oc = await getOcct();
  (self as any).postMessage({ type: "ready", bootMs: Math.round(performance.now() - t0) });
}

async function selftest() {
  const log = logs;
  const show = (name: string, fn: () => any) => {
    try {
      log.push(`OK ${name}: ${String(fn())}`);
    } catch (e) {
      log.push(`ERR ${name}: ${String(e)}`);
    }
  };
  const proto = (o: any) => (o ? Object.getOwnPropertyNames(o?.prototype ?? o).join(",") : "N/A");
  log.push("keys STEP: " + Object.keys(oc).filter((k) => /STEP/i.test(k)).slice(0, 60).join(","));
  log.push("keys TopAbs: " + Object.keys(oc).filter((k) => /TopAbs/i.test(k)).slice(0, 30).join(","));
  log.push("keys IFSelect: " + Object.keys(oc).filter((k) => /IFSelect/i.test(k)).slice(0, 30).join(","));
  log.push("keys Message_Progress: " + Object.keys(oc).filter((k) => /Progress/i.test(k)).slice(0, 30).join(","));
  log.push("keys GeomAbs: " + Object.keys(oc).filter((k) => /GeomAbs/i.test(k)).slice(0, 20).join(","));
  log.push("STEPControl_StepModelType: " + typeof oc.STEPControl_StepModelType + " " + proto(oc.STEPControl_StepModelType));
  log.push("TopAbs_ShapeEnum: " + typeof oc.TopAbs_ShapeEnum + " " + proto(oc.TopAbs_ShapeEnum));
  log.push("TopAbs_FACE value: " + String(oc.TopAbs_ShapeEnum.TopAbs_FACE) + " num=" + Number(oc.TopAbs_ShapeEnum.TopAbs_FACE));
  log.push("GeomAbs type: " + proto(oc.GeomAbs_SurfaceType));
  log.push("Message_ProgressRange: " + typeof oc.Message_ProgressRange + " ctor=" + proto(oc.Message_ProgressRange));
  log.push("IGES proto: " + proto(oc.IGESControl_Writer));
  log.push("STEP writer proto: " + proto(oc.STEPControl_Writer));
  log.push("STEP Transfer.length=" + oc.STEPControl_Writer.prototype.Transfer?.length + " Write.length=" + oc.STEPControl_Writer.prototype.Write?.length);
  log.push("Stl Write.length=" + oc.StlAPI_Writer.prototype.Write?.length + " ASCIIMode.length=" + oc.StlAPI_Writer.prototype.ASCIIMode?.length);
  log.push("PolyTri proto: " + proto(oc.Poly_Triangulation));

  const box = new oc.BRepPrimAPI_MakeBox_1(20, 30, 10).Shape();
  new oc.BRepMesh_IncrementalMesh_2(box, 0.1, false, 0.5, true);
  show("tessellation deep", () => {
    const exp = new oc.TopExp_Explorer_2(box, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    const face = oc.TopoDS.Face_1(exp.Current());
    const loc = new oc.TopLoc_Location_1();
    const tri = oc.BRep_Tool.Triangulation(face, loc);
    const lines = [
      `tri typeof=${typeof tri} ctor=${tri?.constructor?.name}`,
      `own=${Object.getOwnPropertyNames(tri).slice(0, 30).join(",")}`,
      `proto=${Object.getOwnPropertyNames(Object.getPrototypeOf(tri)).slice(0, 40).join(",")}`,
    ];
    let t2 = tri;
    try {
      if (tri?.get) t2 = tri.get();
      lines.push(`get type=${typeof t2} ctor=${t2?.constructor?.name}`);
      lines.push(`t2proto=${Object.getOwnPropertyNames(Object.getPrototypeOf(t2)).slice(0, 40).join(",")}`);
    } catch (e) {
      lines.push("get err " + String(e));
    }
    for (const cand of [tri, t2]) {
      try {
        lines.push(`cand NbNodes=${typeof cand.NbNodes} NbTri=${typeof cand.NbTriangles} Triangle=${typeof cand.Triangle}`);
        if (typeof cand.NbTriangles === "function") {
          lines.push("counts " + cand.NbNodes() + "/" + cand.NbTriangles());
          const t = cand.Triangle(1);
          lines.push("tri1 own=" + Object.getOwnPropertyNames(t).join(",") + " proto=" + Object.getOwnPropertyNames(Object.getPrototypeOf(t)).join(","));
          const arr = typeof t.Get === "function" ? t.Get() : t;
          lines.push("arr=" + JSON.stringify(arr) + " n1=" + (cand.Node(arr[0]).X?.()));
        }
      } catch (e) {
        lines.push("cand err " + String(e));
      }
    }
    const ad = new oc.BRepAdaptor_Surface_2(face, true);
    const ty = ad.GetType();
    lines.push(`type typeof=${typeof ty} str=${String(ty)} num=${Number(ty)} value=${(ty as any)?.value} name=${(ty as any)?.name}`);
    const pl = ad.Plane();
    const ax = pl.Axis();
    const d = ax.Direction();
    const p = ax.Location();
    lines.push(`plane p=${p.X()},${p.Y()},${p.Z()} n=${d.X()},${d.Y()},${d.Z()}`);
    return lines.join(" | ");
  });

  show("polygon+hole face", () => {
    const poly = new oc.BRepBuilderAPI_MakePolygon_1();
    poly.Add_1(new oc.gp_Pnt_3(-10, -8, 0));
    poly.Add_1(new oc.gp_Pnt_3(10, -8, 0));
    poly.Add_1(new oc.gp_Pnt_3(10, 8, 0));
    poly.Add_1(new oc.gp_Pnt_3(-10, 8, 0));
    poly.Close();
    const mf = new oc.BRepBuilderAPI_MakeFace_15(poly.Wire(), true);
    const circ = new oc.gp_Circ_2(new oc.gp_Ax2_3(new oc.gp_Pnt_3(0, 0, 0), new oc.gp_Dir_4(0, 0, 1)), 4);
    const hw = new oc.BRepBuilderAPI_MakeWire_2(new oc.BRepBuilderAPI_MakeEdge_8(circ).Edge()).Wire();
    mf.Add(hw);
    const face = mf.Face();
    const shape = new oc.BRepPrimAPI_MakePrism_1(face, new oc.gp_Vec_4(0, 0, 5), false, true).Shape();
    const props = new oc.GProp_GProps_1();
    oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false);
    return "vol=" + props.Mass() + " expect=" + (20 * 16 * 5 - Math.PI * 16 * 5);
  });

  show("STEP write", () => {
    const pr = oc.Message_ProgressRange_1 ? new oc.Message_ProgressRange_1() : null;
    const w = new oc.STEPControl_Writer_1();
    const mode = oc.STEPControl_StepModelType.STEPControl_AsIs;
    let transfer = "n/a";
    for (const prg of [pr, undefined]) {
      try {
        transfer = String(w.Transfer(box, mode, true, prg));
        break;
      } catch (e) {
        transfer = "transferErr:" + String(e);
      }
    }
    let status: any = "notcalled";
    try {
      status = w.Write("/box.step");
    } catch (e) {
      status = "writeErr:" + String(e);
    }
    let size = -1;
    try {
      size = oc.FS.readFile("/box.step").length;
    } catch (e) {
      size = -1;
    }
    return `mode=${String(mode)} transfer=${transfer} status=${status} size=${size}`;
  });

  show("STEP read", () => {
    const r = new oc.STEPControl_Reader_1();
    const rr = r.ReadFile("/box.step");
    const tr = r.TransferRoots(new oc.Message_ProgressRange_1());
    const s = r.OneShape();
    const props = new oc.GProp_GProps_1();
    oc.BRepGProp.VolumeProperties_1(s, props, false, false, false);
    return `read=${rr} roots=${tr} vol=${props.Mass()}`;
  });

  show("STL write", () => {
    const w = new oc.StlAPI_Writer();
    let r = "?";
    try {
      r = String(w.Write(box, "/box.stl"));
    } catch (e) {
      r = "err1:" + String(e);
    }
    let size = -1;
    try {
      size = oc.FS.readFile("/box.stl").length;
    } catch (e) {
      size = -1;
    }
    return `res=${r} size=${size}`;
  });

  show("IGES full", () => {
    const w = new oc.IGESControl_Writer_2("MM", 1);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(w)).join(",");
    return methods;
  });

  (self as any).postMessage({ type: "selftest", log });
}

self.onmessage = async (e: MessageEvent) => {
  if (e.data.type === "boot") await boot();
  if (e.data.type === "selftest") {
    try {
      logs = [];
      await selftest();
    } catch (err) {
      logs.push("FATAL: " + String(err) + "\n" + (err as Error)?.stack);
      (self as any).postMessage({ type: "selftest", log: logs });
    }
  }
};
