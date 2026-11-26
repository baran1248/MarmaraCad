# MarmaraCad

**Browser-native parametric CAD, assembly and structural FEA — no server GPU required.**

MarmaraCad is an open-source engineering workbench that runs entirely in the browser. The
geometry kernel is [OpenCascade.js](https://ocjs.org/) (OCCT compiled to WebAssembly), the
viewport is [Three.js](https://threejs.org/), and the finite-element solver is a purpose-built
linear-static solver running in a Web Worker. Everything — modelling, meshing, solving and
visualisation — executes on the user's own CPU/GPU.

> Live application: https://baran1248.github.io/MarmaraCad/

## Highlights

- SolidWorks-inspired CommandManager, FeatureManager design tree and ViewCube.
- Parametric sketches with dimensions and geometric relations, solved with a
  Levenberg–Marquardt constraint solver.
- Extrude Boss/Base, Extruded Cut, Revolve, Fillet, Chamfer, Shell, Mirror, Linear Pattern, Sweep,
  Helix/Spiral, Loft, Circular Pattern, Hole Wizard (M3–M16, counterbore/countersink), Draft and Rib
  as an editable feature history.
- Reference planes (offset / angled / mid) and reference axes (plane intersection / cylinder axis),
  with sketching directly on a generated plane.
- Sketch tools: Slot (straight / arc), Polygon (3–12 sides, inscribed / circumscribed), Spline,
  Sketch Fillet / Chamfer and Circular Sketch Pattern — all OSnap and Dynamic Input aware.
- Mouse / Trackpad / Pen control modes with SolidWorks, Fusion and Ansys mouse presets, persisted in
  `localStorage`; two-finger trackpad orbit/pan/pinch (choose Orbit or Pan for two fingers, Shift swaps
  the roles), a speed / inertia / invert navigation popover, three-finger swipe Undo/Redo, touch
  double-tap Normal To and ViewCube double-tap Zoom to Fit. The pen never moves the camera: a 4 px
  dead-zone guards draw/select/push-pull, and the barrel button or a press-and-hold opens the context
  menu.
- Direct modelling with Shapr3D-style handles: select a planar face to get a Push/Pull arrow with a live
  millimetre label (pull = Boss-Extrude, push = Cut-Extrude, `Enter` for a typed value) and a straight
  edge to get a Fillet/Chamfer knob. The result is a normal parametric feature in the tree and in
  Undo/Redo.
- Sheet Metal: Base Flange (closed profile or open sketch band), Edge Flange along a straight edge with
  a real bend cylinder (90°/45°/135°), K-Factor bend allowance `BA = π/180 · θ · (R + K·t)`, a flat
  pattern with dashed bend lines, `.dxf` (AutoCAD R12) flat-pattern export and sheet settings.
- Named Configurations per part (`Default`, `Short`, `Long`, `M6`, `M8`…): each stores the global
  variable expressions and feature suppression; activating one rebuilds the model and Mass Properties,
  and everything is saved in `.mcad.json`.
- Live assembly drag: floating components follow the pointer while Coincident / Concentric / Distance /
  Angle mates are re-projected every frame, so only the free degrees of freedom move.
- Multi-select with Ctrl/Shift-click, window (left→right) and crossing (right→left) selection,
  All / Faces / Edges / Vertices pick filters, and loop / tangency selection from the context menu.
- SolidWorks-style dynamic input while drawing (type length/angle, `Tab`, `Enter`) and object snaps
  (Endpoint, Midpoint, Center, Origin, Quadrant, Intersection, Perpendicular, Tangent) with
  automatic Horizontal / Vertical / Perpendicular relations shown as clickable green badges.
- Construction geometry, Trim, Offset Entities and Convert Entities in the sketch environment.
- Material row above the feature tree (AISI 1020, 6061-T6, 304 SS, Ti-6Al-4V, ABS, Brass and
  custom), feeding mass properties and every analysis study.
- Ansys Engineering Data-style material browser (`Ctrl+K` → "malzeme"): 46 real materials in six
  categories with E, ν, G, σy, σu, ρ, real conductivity (W/(mm·K)), specific heat, CTE and PBR
  values, Turkish/English search, category chips and per-part custom edits.
- `Ctrl+K` command palette with Turkish character folding and engineering keywords ("delik",
  "fillet", "açınım", "modal", "malzeme"); the ribbon groups secondary tools under split dropdowns
  (Extrude ▾ Cut/Revolve/Sweep/Loft/Helix, Fillet ▾ Chamfer, Pattern ▾ Circular…) with a distinct
  icon per command.
- Studio viewport: `RoomEnvironment` + `PMREMGenerator` image-based lighting (WebGL2 and WebGPU),
  a soft grid floor and contact shadow, per-material metalness/roughness on every body, and
  translucent live ghosts while Extrude, Cut, Fillet, Chamfer and Edge Flange panels are open.
- OCCT lifetime discipline (`OcctScope`/`OcctMemory` Proxy over the kernel module): a 20-rebuild
  stress test reports `leaked 0 / untracked 0`, and the status-bar Memory chip shows the JS heap,
  mesh buffers, FEA nodes/elements and OCCT object counters. FEA worker replies move their typed
  arrays as Transferables, and mesh size is clamped to a browser RAM budget with a visible message
  instead of a silent coarsening.
- Evaluate tools: Mass Properties (volume, area, mass, centre of mass X/Y/Z), Measure, Section View,
  Interference Detection, technical drawing (3 orthographic + isometric views, hidden lines,
  centerlines/center marks, hatched A-A section, assembly BOM) and PDF export.
- Toolbox fasteners (M4–M12 hex bolts, nuts, washers), equations/variables, rollback bar,
  TR/EN interface, document templates (`Cantilever Beam`, `L-Bracket`, `Box + Lid Assembly`).
- Gemini CAD assistant: the API key is stored only in this browser; each request can attach the current
  viewport JPEG plus a compact B-Rep topology JSON (bbox, faces, edges, hole axes, outer corners), so
  Turkish or English requests become a validated command list applied inside the normal undo/redo
  history. Fillet/chamfer edges can be named semantically (`"all"`, `"selected"`, explicit indices, or
  a selector with `preset` / `axis` / `outerOnly` / `straightOnly` / length bounds), and the assistant
  also covers reference planes, sweeps, lofts, circular patterns, holes, exploded views, modal, thermal
  and buckling studies.
- Multi-part assemblies with Coincident, Concentric, Distance and Angle mates plus an exploded view
  with an explode/collapse slider.
- STEP (AP214), IGES, STL and OBJ import/export; `.mcad.json` projects; IndexedDB autosave.
- Ansys-class FEA: material library, conformal Tet4/Tet10 mesher on the OCCT triangulation (with a
  voxel hexahedron fallback, local mesh sizing and aspect-ratio/Jacobian quality metrics),
  Jacobi-preconditioned block CG with a WebGPU WGSL PCG path and CPU fallback, fixed / displacement /
  frictionless / cylindrical / bonded supports, force / pressure / moment / gravity / thermal loads,
  and total/directional deformation, von Mises, principal, shear, safety factor, reaction force,
  probe, min/max flags, deformation animation and an undeformed wireframe.
- Multiphysics studies: modal (first 4–6 frequencies with mode shapes), linear buckling (critical
  load multiplier) and steady-state thermal (temperature field in °C).
- WebGPU renderer with an automatic WebGL2 fallback (`?renderer=webgl2` forces the fallback).

## Development

```bash
npm install
npm run dev      # http://localhost:5173/MarmaraCad/
npm run build    # typecheck + production build
npm test         # unit tests
npm run test:e2e # 32 Playwright suites (start `npm run dev` first; uses local Chrome)
npm run test:ui  # non-visual UI audit: icon hydration, overflow, legend, sketch raster proof
npm run test:live # smoke test against the published GitHub Pages build
```

Any end-to-end suite can target a deployed build instead of the dev server:

```bash
MARMARACAD_URL=https://baran1248.github.io/MarmaraCad/ npm run test:e2e
```

The phase-2 suites cover Ctrl+click multi-selection into a bulk fillet/chamfer and into Mate,
Fixed Support and a multi-face Force, right-click Select Loop/Tangency, dynamic input
(`100`, `Tab`, `0`, `Enter`, plus a typed R25 3-point arc), midpoint/endpoint/origin snaps and
alignment guides, window vs crossing selection, construction/trim/offset/convert plus sketch
definition colours, the Box + Lid template (shell volume, placement, zero interference, a detected
1,152 mm³ overlap, mass), the Beam/L-Bracket/Blank templates, Linear Pattern + Mirror, parametric
variables (`L = 100`, `W = L / 2`), the Ansys-style analysis strip, technical drawing + PDF, Section
View, rollback, Toolbox M4–M12, TR/EN, keyboard shortcuts (N, Ctrl+8, F, Esc, wheel zoom), the view
selector, the `?` guide, and the Gemini assistant with a mocked API. The newest suites add the HUD
overlap guard (`e2e-hud.mjs`), per-generation Gemini thinking config with AI-driven FEA supports/loads
and AI cut/revolve/mirror/pattern/mate commands, the drawing dimension placement check, and Turkish
Assembly/mass-card/menu labels.

The phase-4 suites add e2e-phase4.mjs: the horizontal-trackpad orbit regression (dx 120 / dy 10 must orbit, not pan), the Pan scheme with Shift swap, Ctrl/pinch zoom, two-finger pan+pinch, three-finger Undo/Redo, pen dead-zone and tap-to-select, Push/Pull +15 mm (168,000 mm³) with an inward cut and Enter value, the edge-handle R6 fillet, Base/Edge Flange with the BA flat pattern (23,123.82 mm³ analytical) and a valid R12 .dxf, configurations (48,000 ↔ 144,000 mm³ with the Mass card), .mcad.json round-trips, the AI sheet-metal/config/push-pull actions and a live concentric-mate drag with a 0.000 mm radial residual.

The phase-6 assistant suite verifies the multimodal request (viewport JPEG `inlineData` + topology JSON with the hole axis and four outer corners), the `Send viewport view` toggle, hydrogen resolution to `gemini-4-hydrogen` with Gemini-4 models in the Recommended group, per-generation thinking config (`thinkingLevel` vs `thinkingBudget`), and a targeted fillet that selects only the four outer corners with the analytic 1,545.13 mm³ volume loss.

The phase-5 suite (`e2e-phase5.mjs`, 23 checks) proves the memory discipline and the new UI: 20
consecutive rebuilds with `created 2002 / deleted 2002 / leaked 0 / untracked 0` and a stable
volume, the Memory chip counters, an FEA solve reply that moves 6 ArrayBuffers as Transferables,
46 materials / 12 fields / 8 category chips with "bakır" and "abs" searches, copper k = 0.385 and
metalness 0.95 repainted on the body, a custom metalness override, Cut/Fillet/Chamfer ghosts that
appear and disappear, the split-dropdown inventory and distinct Chamfer/Draft icons, and the Ctrl+K
palette in Turkish and English (`delik`, `açınım`, `malzeme`, `modal`, `fillet`, `mesh`) including
Enter-to-run. Unit suites add `tests/materials.test.ts` (library completeness, real conductivity and
the 1925× copper/ABS flux ratio) and `tests/transfer.test.ts` (deduplicated transferable collection).

The phase-3 suites add the ribbon caption-lane guard (`e2e-ribbon.mjs`, `getBoundingClientRect()` at
1440 and 1024 px), the control-mode matrix (`e2e-controlmodes.mjs`: presets, trackpad gestures, pen and
`localStorage` persistence across reload), the conformal Tet10 result surface (`e2e-fea-tet.mjs`:
deflection, reaction, 13 result modes, probe, animation, wireframe, min/max) and multiphysics
(`e2e-fea-multiphysics.mjs`: modal f₁, 1-D thermal profile, buckling multiplier).

CI runs `npm test` and `npm run build` on every push to `main`, then publishes `dist` to GitHub
Pages. Pushing changes to `.github/workflows/` needs a token with the `workflow` scope
(`gh auth refresh -h github.com -s workflow`).

The OpenCascade WASM binary is served as a static asset from the build output. On first load
the kernel is initialised inside a worker; a loading screen reports progress. The 66 MB binary
is kept in the Cache API (`marmaracad-kernel-v1`), so repeat visits start in under a second and
a new deployment invalidates the entry automatically (Tools → Clear Cached Kernel removes it).

> Kernel note: the OCCT Emscripten build shipped with `opencascade.js@1.1.1` cannot open MEMFS
> paths longer than 10 characters (writes land under a mangled name, reads fail), so every
> worker exchange file uses a short fixed name (`/o.step`, `/i.step`, `/r.step`, `.igs`).

## Architecture

| Layer | Responsibility |
| --- | --- |
| `src/kernel/cad.worker.ts` | OCCT B-Rep operations, tessellation, topological metadata, STEP/IGES |
| `src/fea/` | voxel + conformal Tet4/Tet10 meshing, CSR assembly, CPU/WebGPU PCG, modal/buckling/thermal |
| `src/viewport/` | Three.js scene, picking, sketch rendering, control modes, CPU section cut, result visualisation |
| `src/sketch/` | 2D constraint solver, profile extraction, snapping, dynamic input |
| `src/model/` | project document model, feature history, mates, materials, expressions, toolbox |
| `src/analysis/` | material library, FEA study model, solver and result helpers |
| `src/drawing/` | orthographic/isometric SVG drawing generator and PDF export |
| `src/ui/` | CommandManager, FeatureManager, PropertyManager, dialogs, colorbar, Gemini assistant |

## Licensing

Application code: MIT. OpenCascade.js/OCCT is distributed under LGPL-2.1; Three.js under MIT.
No proprietary SolidWorks or Ansys code or assets are used. The UI is an original clean-room
implementation inspired by familiar mechanical-CAD workflows.
