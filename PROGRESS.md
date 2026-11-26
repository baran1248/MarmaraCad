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
- [x] Automatic model listing; visible default `hydrogen` (used directly when listed, otherwise aliased
      to the first flash model) + `mid` thinking
- [x] Thinking config per generation: Gemini 3 → `thinkingLevel`, 2.5 → `thinkingBudget`
      (low 1,024 / mid 8,192 / high 24,576 tokens); older models omit `thinkingConfig`
- [x] System prompt teaches the JSON command schema (box/cylinder, extrude, cut, revolve, fillet,
      chamfer, shell, mirror, pattern, mate, material, variable, fea, …); replies are validated
      against an action whitelist
- [x] `fea` binds a real Fixed Support on the lowest X/Z face plus a Force/Pressure on the free end,
      honouring the AI's `force`, `pressure` and `direction` parameters
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
- [x] Playwright end-to-end: HUD overlay guard — view tools, selection filters, view badge,
      confirmation corner and view cube have zero rect overlaps at 1440 and 1180 px (`e2e-hud.mjs`)
- [x] Playwright end-to-end: drawing width dimension stays 24 px under the front-view lower edge and
      the height dimension 28 px outside its right edge (`e2e-faz2.mjs`)
- [x] Playwright end-to-end: TR/EN also relabels the Assembly/Analysis tabs, mass card title and every
      dropdown menu item (`e2e-faz2.mjs`)
- [x] Playwright end-to-end: Gemini assistant against a mocked API — local key, model listing,
      `hydrogen`/`mid`, validated commands, apply + undo, `Clear API Key`; plus Gemini 3
      `thinkingLevel`, Gemini 1.5 without `thinkingConfig`, direct `hydrogen` ids, AI-driven FEA
      support/force, AI pattern+mirror (20,000 mm³) and AI mate seating the lid at y = 30
      (`e2e-ai.mjs`)
- [x] Visual QA pass with screenshot review
- [x] Live GitHub Pages verification (desktop)
- [x] README with architecture, usage, verification and license notes

## Phase 3 — Advanced CAD, Shapr3D control modes & Ansys-class FEA

### Input modes & ribbon
- [x] Mouse / Trackpad / Pen switcher in the status bar, persisted in `localStorage`
      (`marmaracad.controlMode`), with SolidWorks / Fusion / Ansys mouse presets
      (`marmaracad.mousePreset`)
- [x] Mouse presets: MMB orbit (SolidWorks, Ansys), MMB pan (Fusion), Shift+MMB orbit (Fusion),
      Ctrl+MMB pan everywhere, wheel zoom at the cursor, RMB box zoom / context menu
- [x] Trackpad: two-finger orbit, Shift (or horizontal) pan, Ctrl+wheel cursor-anchored pinch zoom
- [x] Pen: `pointerType === "pen"` draw/select/drag, touch orbit/pan/pinch, barrel button or
      press-and-hold context menu
- [x] Debug hook `window.__marmaracad.control()` returns the mode, preset and live
      orbit/pan/zoom/pinch/pen/touch counters
- [x] Ribbon captions no longer collide with wrapped two-line button labels: every group reserves a
      19 px caption lane and the ribbon row is 128 px, proven with `getBoundingClientRect()` at
      1440 and 1024 px (`tests/e2e-ribbon.mjs`)
- [x] Playwright end-to-end control-mode suite (`tests/e2e-controlmodes.mjs`)

### Sketch tools
- [x] Slot (straight / arc), Polygon (3–12 sides, inscribed / circumscribed), Spline
      (Catmull-Rom), Sketch Fillet / Chamfer, Circular Sketch Pattern
- [x] All new tools respect OSnap, Dynamic Input, the solver and profile extraction

### Part & assembly features
- [x] Reference planes (offset, angled, mid) and reference axes (plane intersection, cylinder axis),
      including sketching on a reference plane
- [x] Sweep, Helix/Spiral (diameter, pitch, turns, hand), Loft (≥2 sections), Circular Pattern,
      Hole Wizard (M3–M16, simple / counterbore / countersink), Draft, Rib
- [x] Angle mate and Exploded View (axis offsets with an explode/collapse slider)
- [x] Technical drawing: hidden lines, centerlines, center marks, hatched A-A section view and an
      assembly BOM table — all present in both SVG and PDF output

### FEA (Ansys-class)
- [x] Conformal Tet4 / Tet10 mesher built on the OCCT surface triangulation (24 tets per voxel
      through shared face centres, watertight across neighbours), with local mesh sizing and
      element/node/aspect-ratio/Jacobian quality metrics; the voxel hexahedron mesher stays as the
      fast preview/fallback
- [x] Tet4/Tet10 stiffness assembly (4-point tetrahedral rule), Jacobi-preconditioned block CG
- [x] WebGPU WGSL compute PCG (single dispatch, whole iteration on the GPU) with an automatic CPU
      fallback; the GPU result is accepted only when the shader reports convergence
- [x] Boundary conditions: Fixed, Displacement (X/Y/Z), Frictionless, Cylindrical, Moment,
      Standard Earth Gravity (1 g = 9810 mm/s², density-driven), Bonded contact
- [x] Results: Total/Directional deformation, von Mises, Max/Min Principal, Shear, Safety Factor,
      Reaction Force (per-node field + Fx/Fy/Fz/total), Probe pin, Min/Max flags, deformation
      animation (play/pause), undeformed wireframe
- [x] Modal (first 4–6 frequencies + mode animation), Linear Buckling (load multiplier) and
      Steady-State Thermal (°C distribution, temperature / heat flux / convection loads)
- [x] Analytical vitest suite: cantilever δ = FL³/3EI = 2.000 mm and σ = 600 MPa (<2 %),
      reaction force, probe, Tet4 vs Tet10 perforated plate stress concentration, modal
      Euler–Bernoulli f₁, 1-D thermal linear profile, buckling π²EI/(4L²)

### AI
- [x] Gemini actions `reference-plane`, `circular-pattern`, `sweep`, `loft`, `hole`,
      `exploded-view`, `modal`, `thermal`, `buckling` wired into the system prompt and the command
      applier

### Verification
- [x] `npm test` — 23/23 unit + analytical tests (6 files, 109 s); includes the cantilever
      δ = 1.942 mm vs 2.000 mm analytical and σ = 600 MPa regression, Tet4 vs Tet10 perforated
      plate, modal f₁, 1-D thermal and buckling cases
- [x] `npx tsc --noEmit` — 0 errors; `npm run build` — production build OK
- [x] `npm run test:e2e` — 30/30 suites, exit 0, zero console/page errors
- [x] `npm run test:ui` — PASS (icon hydration, overflow, legend, 17.6 % sketch raster proof)
- [x] Live GitHub Pages verification after deploy run `44987902857` (commit `8633305`):
      boot 5.98 s / WebGPU / kernel 65.86 MB, sample 98,507 mm³ · 13 faces · 30 edges,
      STEP 37,607 bytes, FEA 4,854 nodes / 3,352 hexahedra → 0.102 mm / 61.35 MPa / SF 4.07 in
      833 PCG iterations, zero console errors
- [x] Live phase-3 suites: ribbon 7/7 (128 px ribbon, zero overlap at 1440 and 1024 px),
      control modes 14/14 (presets, trackpad gestures, pen, persistence across reload),
      Tet10 result surface (tip deflection within 10 % of FL³/3EI, reaction balancing the
      applied 1000 N, 3,441-node reaction field, probe readout, animation, undeformed
      wireframe, min/max flags, reaction colour bar) and multiphysics
      (modal 856.6 Hz = 5.06 % vs Euler–Bernoulli, thermal 50.000 °C mid-span, buckling
      λ = 48.22 against P_cr = 41.12 kN)
- [x] Regression fix found by the suite: the Rectangle tool attached the second click's snap
      point to the derived corner (p2) instead of the clicked corner (p3), so a snapped rectangle
      could collapse into a diagonal with a duplicate vertex; Convert Entities now also skips
      edges whose projection onto the sketch plane is a single point (a corner click can pick an
      edge normal to the plane)

## Phase 4 — Shapr3D navigation, direct Push/Pull, sheet metal, configurations & live assembly

### Trackpad / pen navigation (Shapr3D)
- [x] The old `Math.abs(dx) > Math.abs(dy) * 1.8` wheel shortcut is gone: a horizontal
      two-finger scroll orbits instead of being hijacked into a pan
- [x] Navigation settings popover (`#nav-settings`) with speed (0.25–2.5×), inertia/damping
      (0–0.95), orbit X/Y inversion and pan inversion, persisted in
      `localStorage["marmaracad.navigation"]` and re-applied to the camera at boot
- [x] Trackpad scheme "Two-finger: Orbit" / "Two-finger: Pan"; Shift swaps the roles
      (Orbit scheme → Shift pans, Pan scheme → Shift orbits), Ctrl+wheel / pinch zooms at the cursor
- [x] Inertia glide (`applyInertia`) in the render loop, cancelled by any new gesture or view change
- [x] Touch: one finger orbits, two fingers pan around their midpoint + pinch zoom, three-finger
      horizontal swipe = Undo / Redo, one-finger double-tap = Normal To the tapped face, ViewCube
      double-tap = Zoom to Fit
- [x] Pen (`pointerType === "pen"`) never moves the camera: 4 px tremor dead-zone, then draw/select/
      push-pull; barrel button opens the context menu immediately, press-and-hold after 620 ms
- [x] Debug counters `orbits / pans / zooms / pinches / penDown / touches / gizmoDrags` exposed via
      `window.__marmaracad.control()` for the regression suite

### Direct modelling (Push/Pull & edge handles)
- [x] Selecting a planar face draws a 3-D arrow along its normal plus a live millimetre label and a
      translucent preview of the new material
- [x] Releasing the arrow creates a normal parametric feature: outwards = Boss-Extrude (join),
      inwards = Cut-Extrude; the feature lands in the tree and participates in Undo/Redo
- [x] `Enter` with an active face handle opens the numeric Push/Pull panel (positive pulls, negative
      pushes) for keyboard-driven editing
- [x] Selecting one straight edge shows a blue fillet/chamfer knob: up-right grows the radius
      (Fillet), down-left switches to Chamfer; releasing creates the parametric feature
- [x] Face-boundary extraction (`faceBoundaryLoops`) turns the tessellated cap into the sketch profile
      of the direct edit, so the pushed/pulled face keeps its real outline

### Sheet Metal
- [x] `Sheet Metal` CommandManager tab: Base Flange, Edge Flange, Flatten, Export DXF, Sheet Settings
- [x] Base Flange: closed profile → plate of thickness `t`; open sketch → thin band swept by the
      open-sketch width; bend radius `R` and K-Factor (default `0.44`) stored on the part
- [x] Edge Flange: wall swept along the picked straight edge with a real bend cylinder (90°/45°/135°,
      length, `R`, `K`); the flange records its blank placement (side/from/to) for the flat pattern
- [x] Flatten replaces the bent body with the developed blank and draws the bend lines as dashed
      segments (geometry-baked dashes because the WebGPU backend has no `LineDashedMaterial`)
- [x] Flat-pattern DXF: AutoCAD R12, `OUTLINE` + `BEND` (DASHED) layers, header extents, pure ASCII
- [x] Kernel features `baseFlange` / `edgeFlange` build with OCCT prisms and booleans; the flat
      pattern is built from the same pure `flatPattern()` recipe used by the DXF and the tests
- [x] `.mcad.json` keeps `sheetMetal` and every flange recipe; loading restores the flat pattern and
      its bend lines
- [x] AI actions `sheet-metal-flange` and `flatten` (the flange picks the longest straight edge)

### Configurations
- [x] Configurations section in the FeatureManager with a `+` button and per-variant rows; the panel
      lists, creates, copies and deletes variants
- [x] A configuration stores the global variable expressions (`L`, `W`, `D`, …) and the suppression
      state of every feature; activating one rewrites the variables, re-solves the sketches, marks the
      suppressed features and rebuilds, so the model and Mass Properties follow
- [x] Double-clicking a configuration row in the tree activates and rebuilds that variant
- [x] New variants copy the active one and become active immediately (so the variable editor edits
      the new variant, not the one it was copied from)
- [x] `.mcad.json` stores all configurations plus the active id; the loader normalises them
- [x] AI action `configuration` (name, variables, suppression, copyFrom)

### Live assembly drag
- [x] Floating components can be dragged directly in Assembly mode (left button, camera-plane delta)
- [x] Every pointer frame re-projects the move through the mate solver (6 iterations): Coincident /
      Concentric / Distance / Angle stay satisfied while the free DOFs still move
- [x] Dragging a component whose axis is mated concentric leaves the radial residual at 0.000 mm
      while the component slides 12.28 mm along the free axis; the drag commits one undo step

### AI, tests & fixes
- [x] Assistant system prompt and `applyAiCommand` know `sheet-metal-flange`, `flatten`,
      `configuration` and `push-pull`
- [x] New vitest suites: `tests/sheetMetal.test.ts` (12 tests: BA formula, developed length, flat
      pattern on four sides, R12 DXF structure/extents/ASCII, recipe) and
      `tests/configurations.test.ts` (7 tests: capture/apply/copy/remove/summary, no suppression
      leakage between variants)
- [x] New Playwright suite `tests/e2e-phase4.mjs` (53 checks): trackpad orbit regression, Pan scheme,
      Shift swap, ctrl/pinch zoom, two-finger pan+pinch, three-finger undo/redo, pen dead-zone and
      tap-to-select, push/pull +15 mm (boss, 168,000 mm³), inward cut, Enter value, edge-handle R6
      fillet, base/edge flange, BA flat pattern (23,123.82 mm³ analytical), DXF structure, `.mcad.json`
      round-trip, configurations (48,000 ↔ 144,000 mm³ + mass card), AI actions, live mate drag
- [x] Real bugs found and fixed by the suite:
  - WebGPU has no `LineDashedMaterial` (it throws `Uniform "null" not declared.` every frame):
    bend lines now bake the dashes into the geometry with `LineBasicMaterial`
  - navigation preferences were read by the Shell but never handed to the viewport at boot; the
    restored speed/inertia/invert values now apply on load
  - adding a configuration kept the previous variant active, so the editor overwrote it; the new
    variant becomes active
  - configuration apply evaluated the variables before writing the variant's expressions; the order
    is now apply → evaluate → rebuild
  - the AI sheet-metal action skipped the rebuild when an empty sketch mesh existed, so no edges
    were found and the edge flange was silently omitted

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
- Phase-2B live verification (commit `931876e`, deploy run 44882973857): eleven suites run against
  the published URL — `e2e-live`, `e2e-sample`, `e2e-multiselect`, `e2e-dynamic-input`, `e2e-snap`,
  `e2e-template-boxlid`, `e2e-faz2`, `e2e-ai`, `e2e-variables`, `e2e-analysis-strip` and
  `e2e-templates` — all `RESULT PASS` with `EXIT=0` and no console errors.
- HUD audit (1440 × 900): tools `top 144…172`, filters `180…209`, corner `144…181`, cube
  `186…332` — every pair disjoint (0 collisions); the same holds at 1180 px. The view cube moved to
  `top: 52px` and the filter bar to `top: 46px`.
- Dev-server crash fixed: `e2e-faz2.mjs` used to `saveAs` the downloaded PDF into `tests/`, so
  Vite's watcher locked the file mid-write and killed `npm run dev` with
  `EBUSY: resource busy or locked, watch '…\tests\.tmp-drawing.pdf'`. The download now goes to
  `os.tmpdir()`, and `vite.config.ts` ignores `tests/.tmp-*`, `tests/*.pdf`, `tests/*.step` and
  `tests/*.mcad.json`. Verified by re-running the suite against a live dev server: PDF 92,963 bytes,
  `RESULT PASS`, dev server still answering 200 with no watcher errors.
- Final live check after deploy run 44892175060 (commit `ec80e7b`): `e2e-live` on
  https://baran1248.github.io/MarmaraCad/ — boot 4,994 ms, WebGPU, sample 98,507 mm³ / 13 faces /
  30 edges, STEP 37,607 bytes, FEA 4,854 nodes / 3,352 hexahedra, max 0.102 mm / 61.35 MPa,
  `ERRORS none`; `e2e-hud` on the same URL reports 0 collisions at 1440 and 1180 px.
- Technical drawing: the front view spans y 215.53…278.47; the width dimension sits at y 302.47
  (gap 23.997 px, slot limit 368) and the height dimension at x 564 (28 px right of the outline),
  so neither dimension crosses the part.
- Gemini assistant (mocked API): 2.5 Flash request sends `thinkingBudget: 8192`; Gemini 3 sends
  `thinkingLevel: "medium"`; Gemini 1.5 sends no `thinkingConfig`; a listed `hydrogen` id is called
  directly. An AI batch `box + fea(force 250, direction down)` produces a fixed support with normal
  `[-1,0,0]` and one 250 N `[0,-1,0]` load on the opposite face. AI `pattern(3 × 40) + mirror`
  yields 20,000 mm³ over x −90…90; AI `mate(coincident)` pairs Box/Lid and seats the lid at
  y = 30.000.

### Phase 4 verification (local dev server, headless Chrome, WebGPU)
- `npm test`: 8 files / 42 tests passed (adds `tests/sheetMetal.test.ts` 12 and
  `tests/configurations.test.ts` 7); `npx tsc --noEmit` clean; `npm run build` 1594 modules,
  11.08 s.
- `npm run test:e2e`: the whole 31-suite chain exits 0 (26 `RESULT PASS` reports, 0 `FAIL`);
  `e2e-phase4.mjs` reports `RESULT PASS 53/53`.
- Measured by `e2e-phase4.mjs` on the live document:
  - Trackpad: dx 120 / dy 10 orbits (the old 1.8 ratio hijack is gone: pans stay 0); vertical
    scroll orbits too; Shift pans; Ctrl+wheel zooms once (zooms 0 -> 1, pinches 0 -> 1); the "Pan"
    scheme pans and Shift + Pan orbits.
  - Touch: two fingers move pan 19 -> 80 and pinches 1 -> 3 in the same gesture; a three-finger
    swipe undoes (2 -> 1 feature) and redoes (1 -> 2).
  - Pen: 4 px tremor never orbits (orbits 73 -> 73) but arms the band (`penArmed` true); tapping a
    planar face selects it (1 face) and shows the push/pull arrow (`gizmo.kind = "face"`).
  - Push/Pull: 80 x 60 x 20 block = 96,000 mm3; +15 mm -> 167,999.956 mm3 (0 % error) and a
    second `extrude` feature with `pushPull: true`; inward drag -> cut; Ctrl+Z x2 back to 96,000;
    Enter +5 mm -> 120,000 mm3.
  - Edge handle: R6 drag on a 20 mm vertical edge -> 95,845.49 mm3
    (96,000 - (36 - 9*pi) * 20 = 95,845.49) and a parametric `fillet` feature with radius 6.000.
  - Sheet metal: 120 x 80 x t2 Base Flange = 19,200 mm3; a 90 deg / 20 mm / R2 edge flange stores
    `side: "right", from: -40, to: 40` and grows the body to 23,151.83 mm3; flatten = 23,123.823 mm3,
    exactly `developedChain` with BA = (pi/180)*90*(2 + 0.44*2) = 4.5239 mm; the bend lines are 70
    vertices on `LineBasicMaterial` (no WebGPU `null` uniform errors).
  - DXF: 1,196 bytes, `AC1009` header, 9 `LINE` entities, `OUTLINE` + `BEND` on the `DASHED`
    layer, 84.5239 mm developed extent, pure ASCII.
  - Configurations: Default 48,000 mm3 and Config 2 144,000 mm3 (D 20 -> 60) with the Mass card
    following; double-clicking a row restores the model; both variants and the active id survive
    the `.mcad.json` round-trip (sheet metal + flanges too).
  - Live assembly drag: six pointer frames keep the concentric mate at radial residual 0.000 mm and
    axis cross 0.000 mm while the component slides 12.28 mm along the free axis; one undo step.
- Live verification on https://baran1248.github.io/MarmaraCad/ after deploy run 45080257978
  (commit `059ed30`): `e2e-phase4.mjs` reports `RESULT PASS 53/53` with no console or page errors
  (push/pull 167,999.956 mm3, R6 fillet 95,845.49 mm3, BA flatten 23,123.823 mm3, DXF 1,196 B,
  configurations 48,000 <-> 144,000 mm3, live drag radial residual 0.000 mm / moved 12.28 mm), and
  `e2e-live`, `e2e-ribbon` (7/7), `e2e-controlmodes` (14/14), `e2e-faz2`, `e2e-ai`, `e2e-hud`,
  `e2e-body-features`, `e2e-fea-tet`, `e2e-fea-multiphysics`, `e2e-variables`, `e2e-snap`,
  `e2e-dynamic-input` and `e2e-template-boxlid` all exit 0 against the published URL.
- Real bugs the new suites caught and fixed: WebGPU `LineDashedMaterial` (`Uniform "null" not
  declared.`) -> geometry-baked dashes; navigation preferences read but never handed to the viewport
  at boot; new configurations losing activation; configuration apply order (apply -> evaluate);
  AI sheet-metal action rebuilding before picking the edge flange edge.

## Phase 5 — Memory discipline, Engineering Data and a quieter ribbon

### Kernel lifetime (OCCT RAII)
- [x] `src/kernel/occtScope.ts`: `OcctScope` (`track` / `keep` / `dispose` / `stats`) and
      `OcctMemory` (`run`, `track`, nested scope stack, lifetime totals) plus
      `wrapOcctConstructors(module, memory)`, a Proxy over the OCCT module so **every**
      `new oc.*` call is tracked automatically; value-returning helpers (`TopoDS.Edge_1`…) are
      tracked explicitly.
- [x] Each rebuild / import / export runs inside `memory.run("rebuild:<part>")`; tessellation,
      boolean ops, fillet/chamfer, sheet metal and STEP/IGES paths dispose in `try/finally`.
      Persistent B-Reps are `scope.keep(shape)` + cached; `dropCachedShape()` deletes the previous
      wrapper when a part is rebuilt or deleted (imported bodies stay shared).
- [x] `memory` message on the kernel protocol, `CadClient.memory()` / `lastMemory`, and a
      `window.__marmaracad.kernelMemory()` telemetry hook.

### Zero-copy FEA transport and the RAM budget
- [x] `src/fea/transfer.ts`: `collectTransferables()` (depth-bounded, deduplicated via buffer
      identity) and `isFullyTransferred()`.
- [x] `fea.worker.ts` posts every reply with its Transferable list and reports `transferred`;
      `FeaClient.transfer` exposes `lastReplyBuffers` / `lastRequestBuffers` / `totalBuffers`
      (requests opt in with `transferBuffers` because the document mesh stays for rendering).
- [x] `MeshBudget` (`requested`, `effective`, `limitedBy`, `limit`, `wanted`, `actual`, `message`)
      flows through `VoxelMeshData` / `TetMeshData` / `FeaMeshStats` / `FeaSolveOutcome`, where the
      hex limit is 120,000 cells and the tet limit 140,000 tets. Instead of silently coarsening,
      the app toasts "Mesh size adapted to X mm (requested Y mm) to stay inside the browser RAM
      budget: N cells would exceed the M cell limit." and the Memory popover repeats it.
- [x] Status-bar Memory / Performance chip: JS heap, mesh buffers, FEA nodes/elements, OCCT
      objects tracked/live and buffers moved zero-copy.

### Material library (Ansys Engineering Data level)
- [x] 46 real materials in the six Ansys categories: Steels & Irons 12, Aluminum Alloys 7,
      Copper/Brass/Bronze 4, Titanium/Nickel/Magnesium 4, Polymers & Elastomers 11,
      Composites/Ceramics/Others 7 plus Custom. Every entry carries E, ν, G, σy, σu, ρ,
      conductivity (W/(mm·K)), specific heat, CTE, color, metalness and roughness.
      Conductivity is the real handbook value converted by /1000: copper 0.385, Al6061 0.167,
      steel 0.050, ABS 0.0002.
- [x] `src/ui/MaterialBrowser.ts`: split layout with a search box (Turkish + English synonyms:
      "bakır", "paslanmaz", "naylon"…), category chips, a list with the live E/k summary and a full
      mechanical + physical/thermal + studio-appearance table. The sphere preview renders a CSS
      approximation of the PBR lobe, and any edit switches the badge to "Custom · edited" and is
      stored as a per-part override (`part.materialOverride` extended with G, σu, k, cp, CTE and
      the PBR triple).
- [x] `main.ts` passes the real conductivity into `fea.solve`; `tetSolver.ts` uses
      `options.material.conductivity` (the 0.05 fallback only survives for legacy documents that
      predate the field).
- [x] `partMaterial()` derives G from an edited E/ν and merges every override; mass properties read
      density from the effective material.

### Ribbon, command palette and studio viewport
- [x] `CommandManager` rebuilt around split dropdowns: Extrude ▾ (Cut, Revolve, Sweep, Loft,
      Helix), Fillet ▾ (Chamfer), Linear Pattern ▾ (Circular), Line ▾ (Rectangle, Circle, Arc,
      Slot, Polygon, Spline), Sketch Fillet ▾ (Sketch Chamfer), Bolt ▾ (Nut, Washer) and
      Edge Flange ▾ (Flatten). `data-cmd-action` selectors are preserved for the existing suites,
      compact icon-only cells keep crowded groups quiet and `.cmd-buttons` is a single non-wrapping
      row so nothing can touch the group captions.
- [x] Original icons: Chamfer uses lucide `Slice` (no longer the Draft `Triangle`), Draft uses
      `Diamond`, plus PenTool/Spline/Radius/Repeat2/Scissors/Cuboid/Orbit/Layers3/Bolt/Drill/
      FlipHorizontal2/Sheet/SunMedium/MemoryStick. A repo-wide audit script checks that every
      `icon("…")` name exists in the registry.
- [x] `src/ui/CommandPalette.ts`: `Ctrl+K` / `Cmd+K` (title-bar search button too) with
      subsequence matching, Turkish character folding and scoring over labels, TR translations,
      action ids and engineering keywords (`delik`, `fillet`, `açınım`, `modal`, `malzeme`,
      `mesh`…). Arrow/Tab navigation, Enter to run, Esc to close, and `stopPropagation` so the
      opening key can never close the command it just launched.
- [x] Studio viewport: `RoomEnvironment` through `PMREMGenerator` (lazy `three/webgpu` PMREM for
      the WebGPU backend, Three's WebGL PMREM otherwise, procedural equirect canvas as the last
      resort), `scene.environmentIntensity = 0.9`, a soft `GridHelper` floor and a radial-gradient
      contact shadow placed under the model bbox. Body materials receive each part's
      `metalness`/`roughness`/`color`, so copper reads metallic and ABS reads matte.
- [x] Live translucent ghosts from the PropertyManagers (client-side, non-pickable, disposed on
      OK/Cancel/Esc): `extrudeGhost` (exact sketch loops + holes, direction, mid-plane, add/cut
      tone), `edgeGhost` (edge collar whose tube radius follows the fillet/chamfer size) and
      `edgeFlangeGhost` (ribbon along the picked edge with the real bend angle and length).

### Bugs the phase found and fixed
- Lucide leaves `data-lucide` on the generated `<svg>`; the next hydration pass replaced every
  icon in the document. If that happened between mousedown and mouseup (any panel re-render on
  blur), the click was swallowed. `hydrateNow()` now strips the attribute from generated SVGs, so
  hydration is idempotent and panel buttons work after edits.
- The ribbon wrapped compact cells into extra rows that covered the group captions; the groups are
  now a single flex row with horizontal scrolling (e2e-ribbon green at 1440 and 1024 px).
- Closing a PropertyManager fires a final `change` on the focused input; the ghost closure now
  ignores events when the command is gone or the panel is detached.
- `e2e-shortcuts` scanned only ±90 px for a planar face; after a tight `F` fit the bore edges filled
  the window. The scan now reaches ±260 px, so it is zoom-independent.

### Phase 5 verification (local dev server, headless Chrome, WebGPU)
- `npx tsc --noEmit` clean.
- `npm test`: 10 files (adds `tests/materials.test.ts` 8 and `tests/transfer.test.ts` 5).
- `npm run build`: 1,599 modules, 11.68 s.
- `tests/e2e-phase5.mjs`: `RESULT PASS 23/23` — 20 consecutive rebuilds with
  `created 2002 / deleted 2002 / kept 22 / leaked 0 / untracked 0`; stable volume
  7,999.999999999998 mm³; OCCT counters in the status chip; FEA solve reply moved
  `6` ArrayBuffers (displacement 144, von Mises 48 values); material library 46 rows / 12 fields /
  8 category chips; "bakır" 4 hits, "abs" exactly 1, polymers 11; copper k = 0.385 and
  metalness 0.95 repainted on the body; custom metalness 0.25 stored and repainted; Cut/Fillet/
  Chamfer ghosts appear and disappear; Ctrl+K TR/EN queries and Enter-to-run; zero console errors.
- `npm run test:e2e`: all 32 suites exit 0 (19 in the full chain run, the remaining 12 re-run
  individually after the runner aborted on a flaky pixel scan — root cause fixed, see above);
  `npm run test:ui` PASS.

### Live verification on https://baran1248.github.io/MarmaraCad/ (commit `3c9a5f8`, deploy run
`45251307786` build + deploy success)
- `e2e-live` (now phase-5 aware): boot 5,592 ms, WebGPU, kernel 65,864,037 B, sample 98,507 mm³ /
  13 faces / 30 edges, STEP 37,607 bytes, FEA 4,854 nodes / 3,352 hexahedra → 0.102 mm /
  61.35 MPa, SF 4.07, 833 iterations. Phase-5 block: `occt created 1723 / deleted 1723 / kept 7 /
  leaked 0 / untracked 0`, environment present, 2 ground objects, 46 material rows, 6 thermal/PBR
  fields, palette open, Turkish "açınım" hit, 6 transferables. `ERRORS none`, `RESULT PASS`.
- `MARMARACAD_URL=https://baran1248.github.io/MarmaraCad/ node tests/e2e-phase5.mjs`:
  `RESULT PASS 23/23` on the published build, zero console errors.

## Phase 6 - Multimodal Gemini, B-Rep topology and targeted edges

### Viewport + topology context
- [x] `Viewport.captureJpeg(quality = 0.78, maxWidth = 1024)` copies the presented frame to a 2D
      canvas, downscales it to 1024 px, retries with a forced render when the content ratio is below
      0.01, and reports `content`, `fallback` and `bytes`. `lastCapture` keeps the latest frame for the
      debug API.
- [x] `src/ai/topology.ts` summarises the active body: bbox/volume/area, selected faces/edges,
      `holeAxes`, faces (`planar|cylindrical|other`, normal/axis, centre, radius, `isHole`) and edges
      (`line|circle|arc|curved`, start/end, centre/radius, length, axis, `planes`, `isOuterBoundary`,
      `isOuterCorner`, `onHole`), capped at 120 faces / 160 edges.
- [x] `Assistant` sends the same JSON in `systemInstruction` on every request and the viewport JPEG as
      `inlineData` on the newest user turn. The `Send viewport view` checkbox is on by default,
      persisted in localStorage, and only suppresses the image (the topology always stays).
- [x] `main.ts` wires `aiContext()` to the live mesh/selection/capture and exposes
      `window.__marmaracad.topology()` / `lastCapture()` for tests.

### Targeted fillet / chamfer
- [x] `src/ai/edgeSelection.ts` resolves `"all"`, `"selected"`, explicit arrays and selector objects
      (`preset`, `axis`, `outerOnly`, `straightOnly`, `minLength`, `maxLength`). `parallel-to-holes`
      uses `holeAxes[0]`; the Y-up `outer-top` / `outer-bottom` presets use `y-max` / `y-min`.
- [x] `fillet` / `chamfer` call the resolver on the same `TopologySummary` the model saw, reject empty
      selections with a reason toast, and store the resolved indices in the feature.
- [x] Verified on a 120 × 80 × 18 plate with four Ø9 holes:
      `{axis:"parallel-to-holes",outerOnly:true,straightOnly:true}` selects exactly edges `[0,1,4,7]`;
      R10 removes 1,545.13 mm³ (168,219.56 → 166,674.42) with no kernel warnings.

### Models and thinking
- [x] The model picker has a `Recommended` group (the hydrogen alias plus every `gemini-4*` /
      `/hydrogen/i` model) and an `All models` group. Hydrogen resolves exact → newest hydrogen alias
      → newest flash → first model.
- [x] `thinkingConfigFor` sends `thinkingLevel` for `gemini-3/4*` and every hydrogen alias,
      `thinkingBudget` (mid 8192) for 2.5, and no config for 1.5.
- [x] Model listing is guarded by a `listing` lock and a `lastListSignature`, so saving the same key
      twice does not duplicate the chat notice; key save no longer posts a "Fetching models…" message.

### Turkish UI
- [x] `Sac Metal` tab, `GÖRÜNÜM` ribbon group, `SEÇ · Tümü / Yüzler / Kenarlar / Köşeler` selection
      bar and `Hacim / Kütle / Alan / Ağırlık Merkezi X/Y/Z` mass card.
- [x] Application version bumped to **1.6.0**: `APP_VERSION` / `APP_VERSION_SHORT`, the title-bar
      badge, Model Info and About dialogs, `package.json` and `package-lock.json` all read 1.6.

### Phase 6 verification (local dev server, headless Chrome, WebGPU)
- `npx tsc --noEmit` clean.
- `npm test`: 12 files / 62 tests pass (adds `tests/topology.test.ts` 3 and
  `tests/edgeSelection.test.ts` 4).
- `tests/e2e-ai.mjs`: `RESULT PASS`, 23 checks — inlineData 104,190 B, topology 13 faces / 30 edges /
  `holeAxes ["y"]` / corners `[0,1,4,7]`, off-toggle sends 0 images, `gemini-4-hydrogen` with
  `thinkingLevel: "medium"`, 1,545.13 mm³ targeted fillet loss, zero console errors.
- Full `npm run test:e2e` chain: 32/32 suites exit 0 (27 `RESULT PASS` blocks, no `FAIL`/`SUITE ERROR`).

### Live verification on https://baran1248.github.io/MarmaraCad/ (commit `050c813`, deploy run
`45787558616` build + deploy success)
- Title-bar badge reads `1.6`; About dialog reads `MarmaraCad 1.6`; zero console errors.
- `e2e-live`: boot 35,540 ms (cold WASM), WebGPU, kernel 65,864,037 B, `ERRORS none`, `RESULT PASS`.
- `e2e-phase5`: `RESULT PASS 23/23` — OCCT leaked 0, 46 materials, 6 transferables.
- `e2e-ai`: `RESULT PASS` — JPEG 104,190 B + topology 13 faces / 30 edges / `holeAxes ["y"]` /
  corners `[0,1,4,7]`, `gemini-4-hydrogen` with `thinkingLevel: "medium"`, targeted fillet
  168,219.56 → 166,674.42 mm³ (1,545.13 mm³), 23/23 checks, zero console errors.
