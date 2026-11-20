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
- [x] Voxel-based conforming tetrahedral mesh generator (6 tets per cell)
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
- [x] Unit tests (sketch solver, profile builder, FEA mesh/solver) — 8/8
- [x] Playwright end-to-end: sketch → extrude → STEP export/import round-trip
- [x] Playwright end-to-end: fillet, undo/redo, autosave restore
- [x] Playwright end-to-end: mates
- [x] Playwright end-to-end: analysis solve and result rendering
- [ ] Visual QA pass with screenshot review
- [ ] Live GitHub Pages verification (desktop)
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
- FEA bracket: 4,854 nodes / 20,112 tets, PCG converged in 1,058 iterations,
  max deformation 0.078 mm, max von Mises 35.7 MPa, safety factor 7.0.
- Solver benchmark (40×10×10 bar, 756 nodes / 3,000 tets): 0.00227 mm, 23.09 MPa, 178 iterations.
- Undo/redo and IndexedDB autosave restore verified (4 features, 3 sketches after reload).
- Kernel note: `opencascade.js@1.1.1` corrupts/fails MEMFS paths longer than 10 characters, so all
  worker exchange files use short names (`/o.step`, `/i.step`, `/r.step`, `/o.igs`, `/i.igs`, `/r.igs`).
