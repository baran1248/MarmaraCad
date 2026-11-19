import { getOcct } from "./kernel/occt";

let oc: any = null;
let logs: string[] = [];

const enumVal = (v: any): number => (typeof v === "number" ? v : v?.value ?? -1);

async function boot() {
  oc = await getOcct();
  (self as any).postMessage({ type: "ready", bootMs: 0 });
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

  const box = new oc.BRepPrimAPI_MakeBox_1(20, 30, 10).Shape();
  new oc.BRepMesh_IncrementalMesh_2(box, 0.1, false, 0.5, true);

  function circleWire(radius: number, x = 0, y = 0, z = 0, reverse = false) {
    const circ = new oc.gp_Circ_2(new oc.gp_Ax2_3(new oc.gp_Pnt_3(x, y, z), new oc.gp_Dir_4(0, 0, 1)), radius);
    let edge = new oc.BRepBuilderAPI_MakeEdge_8(circ).Edge();
    if (reverse) edge = edge.Reversed();
    return new oc.BRepBuilderAPI_MakeWire_2(edge).Wire();
  }
  function rectPoly(w: number, h: number, z = 0) {
    const poly = new oc.BRepBuilderAPI_MakePolygon_1();
    poly.Add_1(new oc.gp_Pnt_3(-w / 2, -h / 2, z));
    poly.Add_1(new oc.gp_Pnt_3(w / 2, -h / 2, z));
    poly.Add_1(new oc.gp_Pnt_3(w / 2, h / 2, z));
    poly.Add_1(new oc.gp_Pnt_3(-w / 2, h / 2, z));
    poly.Close();
    return poly.Wire();
  }

  show("hole reversed", () => {
    const mf = new oc.BRepBuilderAPI_MakeFace_15(rectPoly(20, 16), true);
    mf.Add(circleWire(4, 0, 0, 0, true));
    const face = mf.Face();
    const shape = new oc.BRepPrimAPI_MakePrism_1(face, new oc.gp_Vec_4(0, 0, 5), false, true).Shape();
    const props = new oc.GProp_GProps_1();
    oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false);
    return "vol=" + props.Mass() + " expect=" + (1600 - Math.PI * 16 * 5);
  });

  show("tessellate deep", () => {
    const exp = new oc.TopExp_Explorer_2(box, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    const face = oc.TopoDS.Face_1(exp.Current());
    const tri = oc.BRep_Tool.Triangulation(face, new oc.TopLoc_Location_1()).get();
    const t = tri.Triangle(1);
    const idx = [t.Value(1), t.Value(2), t.Value(3)];
    const p = tri.Node(idx[0]);
    const ad = new oc.BRepAdaptor_Surface_2(face, true);
    return `nodes=${tri.NbNodes()} tris=${tri.NbTriangles()} idx=${idx} p=${p.X()},${p.Y()},${p.Z()} gtype=${enumVal(ad.GetType())}`;
  });

  show("arc wire edge", () => {
    const p1 = new oc.gp_Pnt_3(-5, 0, 0);
    const p2 = new oc.gp_Pnt_3(0, 5, 0);
    const p3 = new oc.gp_Pnt_3(5, 0, 0);
    const arcCurve = new oc.GC_MakeArcOfCircle_4(p1, p2, p3).Value();
    const arcEdge = new oc.BRepBuilderAPI_MakeEdge_24(arcCurve).Edge();
    const chord = new oc.BRepBuilderAPI_MakeEdge_3(p3, p1).Edge();
    const wire = new oc.BRepBuilderAPI_MakeWire_3(arcEdge, chord).Wire();
    const face = new oc.BRepBuilderAPI_MakeFace_15(wire, true).Face();
    const shape = new oc.BRepPrimAPI_MakePrism_1(face, new oc.gp_Vec_4(0, 0, 3), false, true).Shape();
    const props = new oc.GProp_GProps_1();
    oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false);
    return "vol=" + props.Mass() + " expect=" + ((Math.PI * 25) / 2 * 3);
  });

  show("revolve profile", () => {
    const mf = new oc.BRepBuilderAPI_MakeFace_15(rectPoly(4, 10), true);
    const face = mf.Face();
    const axis = new oc.gp_Ax1_2(new oc.gp_Pnt_3(0, 0, 0), new oc.gp_Dir_4(1, 0, 0));
    const shape = new oc.BRepPrimAPI_MakeRevol_1(face, axis, 2 * Math.PI, false).Shape();
    const props = new oc.GProp_GProps_1();
    oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false);
    return "vol=" + props.Mass();
  });

  show("STEP export", () => {
    const w = new oc.STEPControl_Writer_1();
    const mode = oc.STEPControl_StepModelType.STEPControl_AsIs;
    const tr = w.Transfer(box, mode, true);
    const st = w.Write("/box.step");
    const size = oc.FS.readFile("/box.step").length;
    return `mode=${enumVal(mode)} transfer=${enumVal(tr)} status=${enumVal(st)} size=${size}`;
  });

  show("STEP import", () => {
    const r = new oc.STEPControl_Reader_1();
    const rr = r.ReadFile("/box.step");
    const n = r.TransferRoots();
    const shape = r.OneShape();
    const props = new oc.GProp_GProps_1();
    oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false);
    return `read=${enumVal(rr)} roots=${n} volume=${props.Mass()}`;
  });

  show("IGES export", () => {
    const w = new oc.IGESControl_Writer_2("MM", 1);
    w.AddShape(box);
    w.ComputeModel();
    let result: any = "?";
    try {
      result = w.Write_1("/box.igs");
    } catch (e) {
      result = "w1err:" + String(e);
      try {
        result = w.Write_2("/box.igs");
      } catch (e2) {
        result = "w2err:" + String(e2);
      }
    }
    let size = -1;
    try {
      size = oc.FS.readFile("/box.igs").length;
    } catch (e) {
      size = -1;
    }
    return `res=${String(result)} size=${size}`;
  });

  show("STL export variants", () => {
    const w = new oc.StlAPI_Writer();
    const results: string[] = [];
    try {
      results.push("ascii=" + String(w.ASCIIMode()));
      w.ASCIIMode(true);
      results.push("set ascii");
    } catch (e) {
      results.push("asciiErr:" + String(e));
    }
    for (const args of [[box, "/b1.stl"], [box, "/b2.stl", undefined], [box, "/b3.stl", 0]]) {
      try {
        results.push("write" + args.length + "=" + String(w.Write(...(args as [any, any]))));
      } catch (e) {
        results.push("write" + args.length + "Err:" + String(e));
      }
    }
    const files = ["/b1.stl", "/b2.stl", "/b3.stl"].map((f) => {
      try {
        return f + ":" + oc.FS.readFile(f).length;
      } catch {
        return f + ":none";
      }
    });
    return results.join(" ") + " " + files.join(" ");
  });

  show("chamfer+fillet edges", () => {
    const exp = new oc.TopExp_Explorer_2(box, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    const edges: any[] = [];
    while (exp.More() && edges.length < 4) {
      edges.push(oc.TopoDS.Edge_1(exp.Current()));
      exp.Next();
    }
    const fil = new oc.BRepFilletAPI_MakeFillet(box, oc.ChFi3d_FilletShape.ChFi3d_Rational);
    fil.Add_2(1.5, edges[0]);
    fil.Add_2(1.5, edges[1]);
    fil.Build();
    const props = new oc.GProp_GProps_1();
    oc.BRepGProp.VolumeProperties_1(fil.Shape(), props, false, false, false);
    const cham = new oc.BRepFilletAPI_MakeChamfer(box);
    cham.Add_2(1, edges[2]);
    cham.Build();
    return `filletVol=${props.Mass()}`;
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
