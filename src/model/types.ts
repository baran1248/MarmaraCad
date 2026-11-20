export type Vec2 = { x: number; y: number };
export type Vec3 = [number, number, number];

export type PlaneKind = "front" | "top" | "right" | "face" | "custom";

export interface SketchPlane {
  kind: PlaneKind;
  name: string;
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  n: Vec3;
  faceIndex?: number;
  componentId?: string;
}

export interface SketchPoint {
  id: string;
  x: number;
  y: number;
  fixed?: boolean;
}

export interface LineEntity {
  id: string;
  kind: "line";
  p1: string;
  p2: string;
  construction?: boolean;
}

export interface CircleEntity {
  id: string;
  kind: "circle";
  center: string;
  radius: number;
  construction?: boolean;
}

export interface ArcEntity {
  id: string;
  kind: "arc";
  center: string;
  start: string;
  end: string;
  radius: number;
  ccw: boolean;
  construction?: boolean;
}

export type SketchEntity = LineEntity | CircleEntity | ArcEntity;

export type ConstraintType =
  | "horizontal"
  | "vertical"
  | "coincident"
  | "distance"
  | "radius"
  | "tangent"
  | "fix"
  | "equal";

export interface SketchConstraint {
  id: string;
  type: ConstraintType;
  a?: string;
  b?: string;
  entity?: string;
  value?: number;
  labelOffset?: Vec2;
}

export interface Sketch {
  id: string;
  name: string;
  plane: SketchPlane;
  points: SketchPoint[];
  entities: SketchEntity[];
  constraints: SketchConstraint[];
  visible: boolean;
}

export type FeatureType =
  | "extrude"
  | "cut"
  | "revolve"
  | "fillet"
  | "chamfer"
  | "imported";

export type BooleanOp = "new" | "join" | "cut";

export interface FeatureParams {
  depth?: number;
  direction?: 1 | -1;
  symmetric?: boolean;
  angle?: number;
  axisEntityId?: string | null;
  axisMode?: "u" | "v" | "entity";
  radius?: number;
  distance?: number;
  edgeIndices?: number[];
  operation?: BooleanOp;
  format?: "step" | "iges" | "stl" | "obj";
  sourceName?: string;
  draftAngle?: number;
  throughAll?: boolean;
}

export interface Feature {
  id: string;
  type: FeatureType;
  name: string;
  sketchId?: string;
  params: FeatureParams;
  suppressed?: boolean;
  error?: string;
}

export interface ImportedAsset {
  name: string;
  format: "step" | "iges" | "stl" | "obj";
  dataBase64: string;
  size: number;
  rev: string;
}

export interface Part {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  sketches: Sketch[];
  features: Feature[];
  asset?: ImportedAsset;
  meshOnly?: boolean;
  materialId?: string;
}

export interface Component {
  id: string;
  partId: string;
  name: string;
  position: Vec3;
  rotation: Vec3; // degrees, XYZ order
  visible: boolean;
  fixed?: boolean;
  color?: string;
}

export type MateType = "coincident" | "concentric" | "distance";

export interface FaceRef {
  componentId: string;
  faceIndex: number;
  surface: string;
  point: Vec3;
  normal: Vec3;
  axis?: Vec3;
  radius?: number;
}

export interface Mate {
  id: string;
  type: MateType;
  name: string;
  a: FaceRef;
  b: FaceRef;
  distance?: number;
  flipped?: boolean;
  error?: string;
}

export interface AnalysisFaceSelection {
  faceIndex: number;
  surface: string;
  point: Vec3;
  normal: Vec3;
}

export interface AnalysisLoad {
  id: string;
  type: "force" | "pressure";
  faceIndex: number;
  face: AnalysisFaceSelection;
  magnitude: number; // N for force, MPa for pressure
  direction: Vec3;
  label: string;
}

export interface AnalysisSupport {
  id: string;
  faceIndex: number;
  face: AnalysisFaceSelection;
}

export type AnalysisStatus = "draft" | "meshed" | "solved" | "failed";

export interface AnalysisStudy {
  id: string;
  name: string;
  partId: string;
  materialId: string;
  meshSize: number;
  supports: AnalysisSupport[];
  loads: AnalysisLoad[];
  status: AnalysisStatus;
  meshStats?: { nodes: number; elements: number };
  error?: string;
}

export type WorkspaceMode = "part" | "assembly" | "analysis";

export interface ProjectDocument {
  name: string;
  units: "mm";
  parts: Part[];
  components: Component[];
  mates: Mate[];
  analyses: AnalysisStudy[];
  activePartId: string;
  activeComponentId: string | null;
  activeStudyId: string | null;
  mode: WorkspaceMode;
  createdAt: number;
  updatedAt: number;
}

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  triFaceIds: Uint32Array;
  faces: FaceInfo[];
  edges: EdgeInfo[];
  volume: number;
  area: number;
  bbox: { min: Vec3; max: Vec3 };
  shapeType: string;
  warnings: string[];
}

export interface FaceInfo {
  index: number;
  surface: "plane" | "cylinder" | "cone" | "sphere" | "torus" | "other";
  point: Vec3;
  normal: Vec3;
  axis?: Vec3;
  radius?: number;
  triStart: number;
  triCount: number;
}

export interface EdgeInfo {
  index: number;
  points: Vec3[];
  length: number;
  closed: boolean;
}

export interface RebuildPart {
  id: string;
  sketches: Sketch[];
  features: Feature[];
  assetBase64?: string;
  assetFormat?: ImportedAsset["format"];
  assetRev?: string;
}

export interface AssemblyTransform {
  partId: string;
  position: Vec3;
  rotation: Vec3;
  visible?: boolean;
}

export interface FeaMaterial {
  id: string;
  name: string;
  category: string;
  E: number; // MPa
  nu: number;
  yield: number; // MPa
  density: number; // kg/m3
  color: string;
}

export interface FeaNodeResult {
  positions: Float32Array;
  displacement: Float32Array;
  vonMises: Float32Array;
  magnitude: Float32Array;
  /** Boundary triangles of the hexahedral mesh, indexing into positions. */
  surfaceIndices: Uint32Array;
  boundaryIndices: Uint32Array;
  elementCount: number;
  meshSize: number;
  maxDisplacement: number;
  maxStress: number;
  minStress: number;
  safetyFactor: number;
  reaction: Vec3;
  solveMs: number;
  dofs: number;
  converged: boolean;
  iterations: number;
  warnings: string[];
}

export interface ProjectFile {
  format: "marmaracad";
  version: 1;
  app: "MarmaraCad";
  savedAt: string;
  document: ProjectDocument;
}
