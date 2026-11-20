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
- [ ] GitHub Actions → GitHub Pages deployment pipeline (workflow committed, first deploy pending)
- [x] Application shell (SolidWorks-style title bar, CommandManager, tree, viewport, status bar)
- [x] Design tokens, icons, responsive layout, onboarding/loading screen

### Sketch environment
- [x] Plane selection (Front / Top / Right / planar face)
- [x] Sketch grid, origin, axes and live cursor coordinates
- [x] Line tool with chained segments and snapping
- [x] Rectangle tool with automatic horizontal/vertical relations
- [x] Circle tool
- [x] Arc tool (3-point)
- [x] Smart Dimension with editable value labels
- [x] Geometric relations: Horizontal, Vertical, Coincident, Tangent, Fix
- [x] 2D constraint solver (Levenberg–Marquardt, minimal-displacement)
- [x] Fully-closed profile detection and open-contour diagnostics
- [x] Sketch edit / delete / hide, dimensions and relations visible in FeatureManager

### 3D features
- [x] Extruded Boss/Base (blind, symmetric, reverse)
- [x] Extruded Cut
- [x] Revolve (boss/cut, selectable axis)
- [x] Fillet (edge selection, live preview of selection)
- [x] Chamfer (edge selection)
- [x] Feature history rebuild, edit, suppress, delete
- [x] Face + edge picking with highlighting
- [x] Mass properties (volume, surface area, mass)
- [x] Tessellation with smooth per-face normals and topological edge display
- [x] ViewCube, isometric/front/top/right views, zoom-to-fit
- [x] Shaded-with-edges / shaded / wireframe display styles

### Assembly
- [x] Multiple parts and component instances
- [x] Insert component, hide/show, delete, rename
- [x] Component transform (move/rotate, numeric fields)
- [x] Mates: Coincident, Concentric, Distance
- [x] Mate solver and mate tree (edit/delete)
- [x] Fixed/ground component

### File I/O & persistence
- [x] Import STEP (AP203/AP214/AP242)
- [x] Import IGES
- [x] Import STL
- [x] Import OBJ
- [x] Export STEP (AP214)
- [x] Export IGES
- [x] Export STL (binary)
- [x] Export OBJ
- [x] `.mcad.json` project save/open
- [x] IndexedDB autosave + restore + recent projects
- [x] Assembly export with component transforms

## Phase 2 — Structural FEA

- [x] Ansys Mechanical-style analysis tree
- [x] Engineering material library (Structural Steel, Aluminum 6061, Titanium Ti-6Al-4V, Copper, ABS, custom)
- [x] Voxel-based conforming hexahedral mesh generator (8-node bricks, 2×2×2 Gauss integration)
- [x] Mesh size control + element/node counters
- [x] Face selection for Fixed Support
- [x] Face selection for Force and Pressure loads
- [x] Linear static solver (CSR assembly + Jacobi-preconditioned CG)
- [x] Total Deformation result
- [x] Equivalent Von Mises Stress result
- [x] Yield-based safety factor
- [x] Colorbars with min/max, deformed-shape scaling
- [x] Solve in Web Worker (UI stays responsive)
- [x] FEA verification tests against analytical benchmarks

## Quality gates
- [x] `npm run build` clean
- [x] Unit tests (sketch solver, profile builder, hex element, FEA mesh/solver) — 12/12
- [x] Playwright end-to-end: boot, WASM cache, WebGPU/WebGL2 fallback
- [x] Playwright end-to-end: every sketch tool (line, rectangle, circle, 3-point arc, dimension,
      equal/fix relations) → Extrude Boss / Extruded Cut, volumes checked analytically
- [x] Playwright end-to-end: Revolve, Fillet and Chamfer with parametric FeatureManager edits
- [x] Playwright end-to-end: sketch → extrude → STEP export/import round-trip
- [x] Playwright end-to-end: STEP AP214 header + B-Rep entity validation, volume/face preservation
- [x] Playwright end-to-end: Coincident + Concentric mates with independently recomputed residuals
- [x] Playwright end-to-end: fillet, undo/redo, autosave restore
- [x] Playwright end-to-end: analysis solve, result rendering and analytical beam benchmark
- [x] Visual QA pass with screenshot review
- [x] Live GitHub Pages verification (desktop)
- [x] README with architecture, usage, verification and license notes

## Verification log
- OCCT 7.x WASM bootstrap: ~0.8 s (local), box 20×30×10 volume = 6000 mm³ exact.
- STEP AP214 round-trip: 15,416 bytes, re-imported volume = 6000 mm³.
- Fillet and chamfer operators verified on box topology.
- Sample bracket: 3 features, volume 98,507 mm³, 13 faces, 60 edges, 924 triangles.
- Sketch on Top Plane (4 lines, 4,720 mm²) → Extrude Boss: volume 110,327 mm³, 4 features.
- Fillet 1.5 mm on an 80 mm vertical edge: volume 98,468 mm³, 14 faces, rebuild 383 ms.
- STEP export of the filleted bracket: 41,808 bytes; re-imported volume 98,507 mm³ (13 faces).
- IGES export: 40 KB; STEP 37–41 KB; STL and OBJ downloads verified.
- Assembly: 2 components, coincident mate solved (component B at 0, 0, −80).
- FEA bracket: 4,854 nodes / 3,352 hexahedra (5.5 mm), PCG converged in 833 iterations,
  max deformation 0.102 mm, max von Mises 61.4 MPa, safety factor 4.07.
- Analytical beam benchmark (100×10×10 mm steel cantilever, 1000 N tip load, 1.25 mm mesh):
  6,561 nodes / 5,120 hexahedra, 561 iterations, deflection 1.988 mm vs 2.000 mm (−0.6 %),
  root stress 595.1 MPa vs 600 MPa (−0.8 %), reaction [0, 0, 1000] N exactly.
  Halving the load halves both results, and vertex colours correlate > 0.9 with the stress field.
- Solver benchmark (40×10×10 bar, hex mesh): 0.002 mm axial stretch, 10 MPa axial stress.
- STEP AP214 audit: `FILE_SCHEMA AUTOMOTIVE_DESIGN { 1 0 10303 214 ... }`, one
  `MANIFOLD_SOLID_BREP`, one `CLOSED_SHELL`, 7 `ADVANCED_FACE`, 1 `CYLINDRICAL_SURFACE`;
  plate-with-hole round trip preserves 7,214.6 mm³ and 7 faces.
- Assembly mate audit: Coincident residual 0.000 mm, Concentric axis cross 0 and radial 0.000 mm
  after the component was first offset 40/25 mm and tilted 30°.
- Kernel cache: first boot downloads 65.86 MB into the Cache API, second boot restores it in
  ~0.9 s (vs ~1.8 s cold); WebGPU is selected when an adapter exists and `?renderer=webgl2`
  produces the identical frame through the fallback path.
- Edge picking now lists each topological edge once (a box reports 12, not 24), so fillet and
  chamfer selections match what the user sees.
- Undo/redo and IndexedDB autosave restore verified (4 features, 3 sketches after reload).
- Kernel note: `opencascade.js@1.1.1` corrupts/fails MEMFS paths longer than 10 characters, so all
  worker exchange files use short names (`/o.step`, `/i.step`, `/r.step`, `/o.igs`, `/i.igs`, `/r.igs`).
- Live build at https://baran1248.github.io/MarmaraCad/ boots in ~3–4 s and reproduces the local
  sample, STEP export and FEA results exactly (deploy run 44686524966, commit 36bc5bb).
- Visual QA fixes: `fmt()` no longer strips trailing zeros from integers (250 MPa was shown as
  25 MPa, 1000 N as 1 N); PropertyManager subtitle moved to its own line; colorbar widened to
  92 px with consistent tick formatting and preserved `MPa` casing; the assembly mass card now
  aggregates visible components; the sketch solver recognises an already-consistent profile so a
  freshly drawn rectangle no longer reports a false constraint conflict.
