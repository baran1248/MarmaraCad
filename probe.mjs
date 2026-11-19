import path from 'node:path';
import { fileURLToPath } from 'node:url';
import opencascade from './node_modules/opencascade.js/dist/opencascade.wasm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const t0 = Date.now();
const oc = await opencascade({
  locateFile(p) {
    return path.resolve(__dirname, 'node_modules/opencascade.js/dist', p);
  },
});
console.log('init ms', Date.now() - t0);
const names = Object.keys(oc);
const pick = (prefix) => names.filter((n) => n.startsWith(prefix)).slice(0, 40);
for (const p of [
  'BRepPrimAPI_MakeBox',
  'BRepPrimAPI_MakePrism',
  'BRepPrimAPI_MakeRevol',
  'BRepBuilderAPI_MakeEdge',
  'BRepBuilderAPI_MakeWire',
  'BRepBuilderAPI_MakeFace',
  'BRepBuilderAPI_MakePolygon',
  'BRepAlgoAPI_Fuse',
  'BRepAlgoAPI_Cut',
  'BRepFilletAPI_MakeFillet',
  'BRepFilletAPI_MakeChamfer',
  'BRepMesh_IncrementalMesh',
  'STEPControl_Writer',
  'STEPControl_Reader',
  'IGESControl_Writer',
  'IGESControl_Reader',
  'StlAPI_Writer',
  'BRep_Tool',
  'TopExp_Explorer',
  'BRepAdaptor_Surface',
  'GCPnts_QuasiUniformAbortable',
  'BRepAdaptor_Curve',
  'gp_Pnt',
  'gp_Vec',
  'gp_Dir',
  'gp_Ax2',
  'gp_Circ',
  'GC_MakeArcOfCircle',
  'BRepBuilderAPI_Transform',
  'BRepBuilderAPI_GTransform',
  'BRepGProp',
  'GProp_GProps',
  'BRepClass3d_SolidClassifier',
  'BRep_Tool',
]) {
  console.log('\n##', p);
  console.log(pick(p).join('\n'));
}
console.log('\nFS?', !!oc.FS, 'STEP model type', oc.STEPControl_StepModelType);
