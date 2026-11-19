# MarmaraCad — Progress

Browser-based parametric CAD, assembly and structural FEA suite. Everything runs client-side:
OpenCascade.js (OCCT WASM) for B-Rep modelling, Three.js for the viewport, and a custom
tetrahedral FEA solver in a Web Worker.

Live: https://baran1248.github.io/MarmaraCad/

## Phase 1 — Parametric CAD & Assembly

### Project foundation
- [x] Vite + TypeScript + Three.js + OpenCascade.js toolchain
- [x] OCCT WASM loads inside a dedicated Web Worker
- [x] STEP export + re-import verified (volume preserved)
- [x] GitHub repository `Baran1248/MarmaraCad`
- [ ] GitHub Actions → GitHub Pages deployment pipeline
- [ ] Application shell (SolidWorks-style title bar, CommandManager, tree, viewport, status bar)
- [ ] Design tokens, icons, responsive layout, onboarding/loading screen

### Sketch environment
- [ ] Plane selection (Front / Top / Right / planar face)
- [ ] Sketch grid, origin, axes and live cursor coordinates
- [ ] Line tool with chained segments and snapping
- [ ] Rectangle tool with automatic horizontal/vertical relations
- [ ] Circle tool
- [ ] Arc tool (3-point)
- [ ] Smart Dimension with editable value labels
- [ ] Geometric relations: Horizontal, Vertical, Coincident, Tangent, Fix
- [ ] 2D constraint solver (Levenberg–Marquardt, minimal-displacement)
- [ ] Fully-closed profile detection and open-contour diagnostics
- [ ] Sketch edit / delete / hide, dimensions and relations visible in FeatureManager

### 3D features
- [ ] Extruded Boss/Base (blind, symmetric, reverse)
- [ ] Extruded Cut
- [ ] Revolve (boss/cut, selectable axis)
- [ ] Fillet (edge selection, live preview of selection)
- [ ] Chamfer (edge selection)
- [ ] Feature history rebuild, edit, suppress, delete
- [ ] Face + edge picking with highlighting
- [ ] Mass properties (volume, surface area, mass)
- [ ] Tessellation with smooth per-face normals and topological edge display
- [ ] ViewCube, isometric/front/top/right views, zoom-to-fit
- [ ] Shaded-with-edges / shaded / wireframe display styles

### Assembly
- [ ] Multiple parts and component instances
- [ ] Insert component, hide/show, delete, rename
- [ ] Component transform (move/rotate, numeric fields)
- [ ] Mates: Coincident, Concentric, Distance
- [ ] Mate solver and mate tree (edit/delete)
- [ ] Fixed/ground component

### File I/O & persistence
- [ ] Import STEP (AP203/AP214/AP242)
- [ ] Import IGES
- [ ] Import STL
- [ ] Import OBJ
- [ ] Export STEP (AP214)
- [ ] Export IGES
- [ ] Export STL (binary)
- [ ] Export OBJ
- [ ] `.mcad.json` project save/open
- [ ] IndexedDB autosave + restore + recent projects
- [ ] Assembly export with component transforms

## Phase 2 — Structural FEA

- [ ] Ansys Mechanical-style analysis tree
- [ ] Engineering material library (Structural Steel, Aluminum 6061, Titanium Ti-6Al-4V, Copper, ABS, custom)
- [ ] Voxel-based conforming tetrahedral mesh generator (6 tets per cell)
- [ ] Mesh size control + element/node counters
- [ ] Face selection for Fixed Support
- [ ] Face selection for Force and Pressure loads
- [ ] Linear static solver (CSR assembly + Jacobi-preconditioned CG)
- [ ] Total Deformation result
- [ ] Equivalent Von Mises Stress result
- [ ] Yield-based safety factor
- [ ] Colorbars, min/max probes, deformed-shape scaling
- [ ] Solve in Web Worker (UI stays responsive)
- [ ] FEA verification tests against analytical benchmarks

## Quality gates
- [ ] `npm run build` clean
- [ ] Unit tests (sketch solver, profile builder, FEA mesh/solver)
- [ ] Playwright end-to-end: sketch → extrude → hole → STEP round-trip
- [ ] Playwright end-to-end: analysis solve and result rendering
- [ ] Visual QA pass with screenshot review
- [ ] Live GitHub Pages verification (desktop)
- [ ] README with architecture, usage, verification and license notes

## Verification log
- OCCT 7.x WASM bootstrap: ~0.8 s (local), box 20×30×10 volume = 6000 mm³ exact.
- STEP AP214 round-trip: 15,416 bytes, re-imported volume = 6000 mm³.
- Fillet and chamfer operators verified on box topology.
- (more entries are appended as features land)
