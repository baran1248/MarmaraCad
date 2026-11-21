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
- [x] GitHub Actions → GitHub Pages deployment pipeline (deploy run `44844692126` green, live URL verified)
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

## Phase 2B — Interaction, AI & engineering deliverables

### Selection & viewport
- [x] Ctrl/Shift+click additive selection (face, edge, vertex, tree); clicking a selected item removes it
- [x] Fillet, Chamfer, Measure and FEA boundary conditions consume the multi-selection
- [x] Window selection (left→right, full containment) and crossing selection (right→left, touch) in sketches and 3D
- [x] `All / Faces / Edges / Vertices` pick filters
- [x] `Select Loop` and `Select Tangency` in the right-click menu
- [x] Right-click `Sketch on Face`, `Normal To`, `Hide / Show`, `Edit`, `Delete`
- [x] Zoom towards the cursor; SolidWorks/Fusion (MMB orbit, RMB pan) and legacy mouse schemes

### Sketch interaction
- [x] Dynamic input boxes next to the cursor for Line, Rectangle, Circle and 3-Point Arc
- [x] Type value → `Tab` → value → `Enter` draws exact geometry and adds driving dimensions/constraints
- [x] Object snaps: Endpoint, Midpoint, Center, Origin, Quadrant, Intersection, Perpendicular, Tangent,
      with symbol + label and dashed alignment guides
- [x] Automatic Horizontal / Vertical / Perpendicular relations; green badges are clickable to delete
- [x] Snap on/off toggle in the status bar
- [x] `For Construction` (dashed), Trim, Offset Entities, Convert Entities
- [x] Under Defined blue / Fully Defined black / Over Defined amber-red state colours + status text
- [x] `Esc`, `Delete`, `F`, `N`/`Ctrl+8`, `S` shortcut bar at the cursor, `Ctrl+Z/Y`

### Features, materials & evaluation
- [x] Shell, Mirror, Linear Pattern
- [x] Draggable FeatureManager rollback bar (rebuild up to a feature; drop on itself to clear)
- [x] `Material <not specified>` / `Edit Material` row, library + custom overrides flowing into mass and FEA
- [x] Mass Properties with volume, area, mass and centre of mass X/Y/Z; Measure
- [x] Spacebar transparent 3D View Selector cube (6 directions + isometric), Confirmation Corner
- [x] Section View with capped CPU cut (works on WebGL2 and WebGPU)
- [x] Assembly Interference Detection (AABB + ~1 mm parity sampling)
- [x] Toolbox parametric M4–M12 hex bolts, nuts and washers
- [x] Parametric variables (`L = 100`, `W = L / 2`) bound to dimensions, with live re-solve
- [x] Technical drawing: front/top/right/isometric views, overall dimensions, title block, SVG + PDF
- [x] `?` shortcut guide, TR/EN switch, templates (Cantilever Beam, L-Bracket, Box + Lid Assembly)

### Gemini assistant
- [x] Slide-out panel; key stored in localStorage + first-party cookie; `Clear API Key`; no relay server
- [x] Automatic model listing; visible default `hydrogen` alias + `mid` thinking
- [x] System prompt teaches the JSON command schema; replies validated against an action whitelist
- [x] One-click apply inside the normal undo/redo transaction


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
- [x] Playwright end-to-end: Ctrl+click multi-selection → bulk fillet/chamfer, Measure, window/crossing
      box selection, pick filters, right-click Select Loop/Tangency (`e2e-multiselect.mjs`)
- [x] Playwright end-to-end: Ctrl+click faces seed the Mate panel (one per component) and become
      Fixed Supports / one shared Force (`e2e-mates.mjs`, `e2e-fea-multiselect.mjs`)
- [x] Playwright end-to-end: Normal To (`N` / `Ctrl+8`), `F` zoom fit, right-click Hide/Show with
      undo, right-click Sketch on Face, and Esc closing a PropertyManager / empty sketch
      (`e2e-shortcuts.mjs`)
- [x] Playwright end-to-end: Linear Pattern 3 × 50 mm (8,000 → 24,000 mm³) and Mirror across the
      Right Plane (4,000 → 8,000 mm³, bbox −30…30), both deletable (`e2e-body-features.mjs`)
- [x] Playwright end-to-end: parametric variables `L = 100`, `W = L / 2`, a dimension bound to `L`
      re-solves the sketch and the extrude (20,000 → 32,000 mm³) (`e2e-variables.mjs`)
- [x] Playwright end-to-end: Ansys-style strip — Geometry/Material/Mesh/Loads/Results pills with
      `Input required` → `Current` → `Stale · re-solve`, MMGS · NMM label (`e2e-analysis-strip.mjs`)
- [x] Playwright end-to-end: Cantilever Beam (28,800 mm³ + study), L-Bracket (22,080 mm³) and Blank
      Part templates (`e2e-templates.mjs`)
- [x] Playwright end-to-end: interference detection both ways — clear when the lid rests on the box,
      and ≈1,152 mm³ when pushed 5 mm inside (`e2e-template-boxlid.mjs`)
- [x] Playwright end-to-end: dynamic input `100` + `Tab` + `0` + `Enter` → exact 100 mm line with
      driving dimensions; typed rectangle 40 × 25, Ø24 circle (R12) and a typed R25 3-point arc
      (`e2e-dynamic-input.mjs`)
- [x] Playwright end-to-end: For Construction, Trim between intersections, Offset Entities and
      Convert Entities, plus the under/full/over-defined colours and status text
      (`e2e-sketch-utils.mjs`)
- [x] Playwright end-to-end: midpoint/endpoint/origin snap markers, alignment guides, inferred
      horizontal/vertical/perpendicular relations, clickable badge deletion, snap toggle
      (`e2e-snap.mjs`)
- [x] Playwright end-to-end: Box + Lid template (shell 15,552 mm³, lid 8,448 mm³, placement,
      zero interference, 24,000 mm³ mass) (`e2e-template-boxlid.mjs`)
- [x] Playwright end-to-end: material assignment, drawing views + title block, real PDF download,
      capped Section View, rollback drag, Toolbox M8 bolt, TR/EN, view selector, confirmation
      corner, `S` bar and `?` guide (`e2e-faz2.mjs`)
- [x] Playwright end-to-end: Gemini assistant against a mocked API — local key, model listing,
      `hydrogen`/`mid`, validated commands, apply + undo, `Clear API Key` (`e2e-ai.mjs`)
- [x] Visual QA pass with screenshot review
- [x] Live GitHub Pages verification (desktop)
- [x] README with architecture, usage, verification and license notes

## Verification log
- Phase-2 verification (local dev server, headless Chrome, all measured from the live document):
  - Ctrl+click builds a 3-edge selection that Fillet consumes (`3 EDGE(S)`), volume 19,935.62 mm³
    against the analytical three-R2-corner value; Ctrl+click on a selected edge removes it and adds
    it back (3 → 2 → 3); Measure lists the same three edges. The same selection drives Chamfer
    (`2 EDGE(S)`, 19,900 mm³ = 20,000 − 2 × 2²/2 × 25). Right-click → Select Loop selects the four
    edges bounding the face under the cursor; Select Tangency stops at the sharp corners.
  - Mate preselection: Ctrl+click one face on each component, then Mate → the panel already lists
    both picks (`2` rows) and the mate solves; the preselection is consumed so the next command
    starts empty. Ctrl+click faces then Fixed Support adds every face in the set, and Force applies
    one shared magnitude to all queued faces (`2` loads at 250 N → solved, 0.66 MPa).
  - Dynamic input: `100` + `Tab` + `0` + `Enter` produces a 100.000 mm / 0.000° line with
    `distance` and `angle` constraints; typed rectangle 40 × 25 and Ø24 circle (R12) match exactly.
  - Shortcuts: `N` and `Ctrl+8` put the camera on the face normal (direction dot 1.000), `F` frames
    all 8 bbox corners, right-click Hide/Show toggles the part and Ctrl+Z restores it, Sketch on Face
    opens a sketch whose plane carries the picked face index, and Esc closes a PropertyManager.
    Mouse wheel closes from 217.4 to 82.6 mm while the world point under the cursor drifts 2 px.
  - Body features: 40 × 20 × 10 box (8,000 mm³) → Linear Pattern 3 × 50 mm = 24,000 mm³, bbox
    0…140 mm; a 4,000 mm³ box at x = 10…30 mirrored about the Right Plane = 8,000 mm³, bbox
    −30…30 mm; deleting the Mirror feature returns to 4,000 mm³.
  - Variables: `L = 100`, `W = L / 2` → 50; editing `L` to 160 gives 80 before Apply; a rectangle
    width dimension typed as `L` solves to 100 mm, and changing `L` to 160 re-solves the sketch and
    rebuilds the extrude from 19,999.9 mm³ to 31,999.9 mm³ (bbox width 160 mm).
  - Analysis strip (FeatureManager, Analysis mode): Geometry/Material/Mesh/Loads/Results with
    `MMGS / NMM · mm, N, MPa`; a fresh study on a part without material shows `Input required`
    (Material) and `Solve required` (Results); after material + BCs + mesh the Mesh and Loads pills
    read `Current`; after the solve Results reads `Current`; editing the extrude depth (20 → 25 mm)
    flips Mesh and Results to `Stale` / `Stale · re-solve` while Geometry stays `Current`.
  - Snaps: `△ Midpoint`, `□ Endpoint`, `⊕ Origin`; two dashed alignment guides while tracking; a
    line started on a snapped midpoint shares that point and infers `vertical` + `perpendicular`.
  - Sketch utilities: construction toggle flips one entity only (blue `Under defined · 2 DOF` →
    black `Fully defined · 0 DOF` after fixing every point → amber `Over defined` when a second
    driving dimension lands on the same edge); Trim splits a crossing line into 10 mm + 10 mm;
    Offset Entities duplicates the 6-line selection at 3 mm (x = 3 / 17 / 37 appear); Convert
    Entities projects a 40 mm 3D edge into the sketch.
  - Box + Lid template: shelled box 15,552 mm³, lid 8,448 mm³, lid at y = 30 mm, no interference,
    assembly mass 0.1889 kg from AISI 1020 (7,850 kg/m³).
  - Drawing: 5 paths / 6 lines / 19 texts, views FRONT/TOP/RIGHT/ISOMETRIC, title block carries
    part name, 6061-T6, scale 1:1 and `UNITS mm`; the downloaded PDF is 93,235 bytes with a
    `%PDF-` header.
  - Section View: cut at X = −14.9 mm, body bbox min X = −14.9 mm, 826 triangles (from 924, caps
    included), picking disabled; turning it off restores 924 triangles and the full −60…60 extent.
  - Rollback: dropping the bar on the second feature rebuilds 2 of 3 features (volume changes,
    one row suppressed); dropping it back on itself restores the full tree.
  - Toolbox: M8 × 20 hex bolt, 1,795 mm³, 13 mm across flats (analytic OBJ body).
  - Gemini (mocked): key stored in localStorage + cookie and sent only to
    `generativelanguage.googleapis.com`; models listed automatically; `hydrogen` resolves to
    `gemini-2.5-flash` with `thinkingLevel: medium`; 2 of 3 commands applied (unknown action
    rejected); Ctrl+Z removes the AI edits; `Clear API Key` empties storage and the cookie.
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
- Interference detector fix: `transformMeshData` used to return a zeroed bbox, so every component
  pair failed the AABB pre-check and the dialog always said "No interference detected". It now
  recomputes the bbox from the transformed vertices; the sampling step is capped by the shortest
  extent too, so 2 mm shell walls are visible. The Box + Lid template pushed 5 mm inside reports
  ≈1,152 mm³ (2·2·40·3 side walls + 2·56·2·3 end walls = 1,152 mm³), and the resting lid stays clear.
- Template audit: Cantilever Beam 120 × 20 × 12 mm = 28,800 mm³ with AISI 1020 and a static study,
  L-Bracket (60·8 + 8·32) · 30 = 22,080 mm³, Blank Part with no material and no variables.
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
- Second QA pass (non-visual audit + pixel measurements, because the review model had no vision
  channel):
  - icons are hydrated through a `MutationObserver`, so tab switches and re-rendered panels no
    longer leave empty `<i data-lucide>` boxes (audit went from 14 unhydrated icons to 0);
  - every legend tick now uses one decimal rule (`560.4 / 280.2 / 0.0`, no more mixed `560`/`280.2`),
    the card is 104 px wide with 9.5 px labels, nothing is clipped, and the title fits two lines;
  - the legend sits above the toast stack (`z-index: 96`) and the stack shifts 138 px left while a
    result legend is visible, so the minimum label can never be covered (measured overlap: false);
  - toasts are capped at three cards and still auto-dismiss after 4.2 s;
  - the viewport is zoomed to fit after a solve (result coverage 22 % of canvas pixels, up from
    3.8 % in the reviewed screenshot);
  - mate features are named after their type (`Coincident1`, `Concentric1`, `Distance1`) and the
    tree badge is capitalised, so the assembly tree states the mate type.
- Sketch-canvas regression proof: capture the canvas while a 80×50 rectangle is edited, finish the
  sketch and capture again — 17.4 % of the pixels change, i.e. the overlay (grid + lines + origin
  planes) really rasterises; the "blank canvas" report was a thin-line/OCR artefact.
- Live build at https://baran1248.github.io/MarmaraCad/ re-verified after deploy (run for commit
  83f003c): boot 4.9 s, WebGPU, sample 98,507 mm³ / 13 faces / 30 edges, STEP 37,607 bytes,
  FEA 4,854 nodes / 3,352 hexahedra, max 0.102 mm / 61.35 MPa, zero console errors. All six
  deep suites (boot, sketch tools, features, mates, STEP audit, beam benchmark) pass against the
  same deployed URL.
