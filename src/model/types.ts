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

export interface SplineEntity {
  id: string;
  kind: "spline";
  /** Ordered sketch-point ids. The curve passes through every control point. */
  points: string[];
  construction?: boolean;
}

export type SketchEntity = LineEntity | CircleEntity | ArcEntity | SplineEntity;

export type ConstraintType =
  | "horizontal"
  | "vertical"
  | "coincident"
  | "distance"
  | "radius"
  | "tangent"
  | "fix"
  | "equal"
  | "perpendicular"
  | "angle";

export interface SketchConstraint {
  id: string;
  type: ConstraintType;
  a?: string;
  b?: string;
  entity?: string;
  value?: number;
  /** Expression such as "L / 2"; when set it overrides `value` at rebuild time. */
  expression?: string;
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
  | "shell"
  | "mirror"
  | "pattern"
  | "sweep"
  | "loft"
  | "circularPattern"
  | "hole"
  | "draft"
  | "rib"
  | "helix"
  | "baseFlange"
  | "edgeFlange"
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
  faceIndices?: number[];
  operation?: BooleanOp;
  format?: "step" | "iges" | "stl" | "obj";
  sourceName?: string;
  draftAngle?: number;
  throughAll?: boolean;
  /** Shell wall thickness (mm). */
  thickness?: number;
  /** Mirror plane for the mirror feature. */
  mirrorPlane?: "front" | "top" | "right";
  /** Linear pattern settings. */
  patternAxis?: "x" | "y" | "z";
  patternCount?: number;
  patternSpacing?: number;
  /** Sweep path / loft sections. */
  pathSketchId?: string;
  profileSketchIds?: string[];
  /** Circular pattern settings. */
  circularAxis?: "x" | "y" | "z";
  circularCount?: number;
  circularAngle?: number;
  /** Hole Wizard. */
  standard?: string;
  holeType?: "simple" | "counterbore" | "countersink" | "tap";
  holeDiameter?: number;
  holeHeadDiameter?: number;
  holeDepth?: number;
  /** Draft / rib. */
  faceIndex?: number;
  ribThickness?: number;
  /** Helix / thread path. */
  helixDiameter?: number;
  helixPitch?: number;
  helixTurns?: number;
  helixHand?: "right" | "left";
  /** Placement for hole/rib when no face is selected. */
  center?: Vec3;
  normal?: Vec3;
  /** Expression evaluated at rebuild time, e.g. "L / 2". */
  depthExpression?: string;
  radiusExpression?: string;
  /** Sheet metal (base / edge flange). */
  sheetThickness?: number;
  bendRadius?: number;
  kFactor?: number;
  flangeLength?: number;
  flangeAngle?: number;
  /** Straight edge used by the edge flange (index into the body edge list). */
  edgeIndex?: number;
  /** Open-sketch base flange width (mm). */
  sheetWidth?: number;
  /** Direct-edit marker (push/pull gesture). */
  pushPull?: boolean;
}

export interface ReferencePlane {
  id: string;
  name: string;
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  n: Vec3;
  kind: "offset" | "angle" | "mid";
  visible: boolean;
}

export interface ReferenceAxis {
  id: string;
  name: string;
  origin: Vec3;
  direction: Vec3;
  visible: boolean;
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
  /** Overrides for the library material (Edit Material → custom values). */
  materialOverride?: {
    name?: string;
    E?: number;
    nu?: number;
    yield?: number;
    density?: number;
  };
  /** Features at or below this index rebuild; the rest are rolled back. */
  rollbackIndex?: number;
  referencePlanes?: ReferencePlane[];
  referenceAxes?: ReferenceAxis[];
  /** Exploded-view slider state (0 = assembled, 1 = fully exploded). */
  explode?: number;
  /** Sheet-metal defaults + flange recipes used by the flat pattern / DXF. */
  sheetMetal?: SheetMetalState;
  /** Named part variants (variables + suppression state). */
  configurations?: Configuration[];
  activeConfigurationId?: string;
}

export interface SheetMetalFlange {
  id: string;
  featureId: string;
  edgeIndex: number;
  angle: number;
  length: number;
  radius: number;
  thickness: number;
  kFactor: number;
  /** Flat-pattern placement, in the base sketch's 2-D frame. */
  side?: "left" | "right" | "bottom" | "top";
  from?: number;
  to?: number;
}

export interface SheetMetalState {
  thickness: number;
  radius: number;
  kFactor: number;
  /** Flat-pattern preview: the body rebuilds as the developed blank. */
  flattened?: boolean;
  flanges: SheetMetalFlange[];
}

export interface Configuration {
  id: string;
  name: string;
  /** Global variable overrides, name → expression ("L": "160"). */
  variables: Record<string, string>;
  /** Feature ids suppressed in this configuration. */
  suppressed: string[];
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

export type MateType = "coincident" | "concentric" | "distance" | "angle";

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
  /** Angle mate value in degrees. */
  angle?: number;
  flipped?: boolean;
  error?: string;
}

export interface AnalysisFaceSelection {
  faceIndex: number;
  surface: string;
  point: Vec3;
  normal: Vec3;
}

export type AnalysisLoadType = "force" | "pressure" | "moment" | "gravity" | "temperature" | "heatflux" | "convection";

export interface AnalysisLoad {
  id: string;
  type: AnalysisLoadType;
  faceIndex: number;
  face: AnalysisFaceSelection;
  magnitude: number; // N, MPa, N·mm, °C, W/mm², W/mm²·K
  direction: Vec3;
  label: string;
  /** Secondary value: ambient temperature (°C) for convection, moment axis etc. */
  secondary?: number;
}

export type SupportKind = "fixed" | "frictionless" | "cylindrical" | "displacement" | "bonded";

export interface AnalysisSupport {
  id: string;
  faceIndex: number;
  face: AnalysisFaceSelection;
  kind?: SupportKind;
  /** Displacement support: free/blocked per global axis. */
  dofs?: { x: boolean; y: boolean; z: boolean };
  values?: { x: number; y: number; z: number };
}

export type AnalysisStatus = "draft" | "meshed" | "solved" | "failed";
export type AnalysisType = "static" | "modal" | "buckling" | "thermal";
export type FeaMeshKind = "hex" | "tet4" | "tet10";

export interface LocalMeshSizing {
  id: string;
  faceIndex: number;
  size: number;
}

export interface FeaMeshMetrics {
  minAspect: number;
  avgAspect: number;
  minJacobian: number;
  avgJacobian: number;
}

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
  /** Geometry or material changed after the solve; results need a re-run. */
  stale?: boolean;
  analysisType?: AnalysisType;
  meshKind?: FeaMeshKind;
  localSizing?: LocalMeshSizing[];
  modeCount?: number;
  thermal?: { ambient: number; convection: number };
  meshMetrics?: FeaMeshMetrics;
  /** Last result summary persisted with the document (mode frequencies etc.). */
  resultSummary?: Record<string, number>;
}

export interface Variable {
  id: string;
  name: string;
  expression: string;
  value: number;
}

export type Language = "en" | "tr";

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
  variables?: Variable[];
  language?: Language;
  /** Exploded view amount (0 = assembled, 1 = fully exploded). */
  exploded?: number;
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
  rollbackIndex?: number;
  sheetMetal?: SheetMetalState;
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
  /** Thermal conductivity in W/(mm·K); defaults to steel-like 0.05. */
  conductivity?: number;
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
  /** Nodal reaction-force magnitude (N) for probes and reaction plots. */
  reactionForce?: Float32Array;
  solveMs: number;
  dofs: number;
  converged: boolean;
  iterations: number;
  warnings: string[];
  /** Extended Ansys-style result fields. */
  maxPrincipal?: Float32Array;
  minPrincipal?: Float32Array;
  shearStress?: Float32Array;
  directional?: { x: Float32Array; y: Float32Array; z: Float32Array };
  temperature?: Float32Array;
  frequencies?: number[];
  modeShapes?: Float32Array[];
  bucklingMultiplier?: number;
  bucklingMode?: Float32Array;
  meshKind?: FeaMeshKind;
  meshMetrics?: FeaMeshMetrics;
}

export interface ProjectFile {
  format: "marmaracad";
  version: 1;
  app: "MarmaraCad";
  savedAt: string;
  document: ProjectDocument;
}
