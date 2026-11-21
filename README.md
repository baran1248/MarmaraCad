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
- Extrude Boss/Base, Extruded Cut, Revolve, Fillet, Chamfer, Shell, Mirror and Linear Pattern
  as an editable feature history.
- Multi-select with Ctrl/Shift-click, window (left→right) and crossing (right→left) selection,
  All / Faces / Edges / Vertices pick filters, and loop / tangency selection from the context menu.
- SolidWorks-style dynamic input while drawing (type length/angle, `Tab`, `Enter`) and object snaps
  (Endpoint, Midpoint, Center, Origin, Quadrant, Intersection, Perpendicular, Tangent) with
  automatic Horizontal / Vertical / Perpendicular relations shown as clickable green badges.
- Construction geometry, Trim, Offset Entities and Convert Entities in the sketch environment.
- Material row above the feature tree (AISI 1020, 6061-T6, 304 SS, Ti-6Al-4V, ABS, Brass and
  custom), feeding mass properties and every analysis study.
- Evaluate tools: Mass Properties (volume, area, mass, centre of mass X/Y/Z), Measure, Section View,
  Interference Detection, technical drawing (3 orthographic + isometric views) and PDF export.
- Toolbox fasteners (M4–M12 hex bolts, nuts, washers), equations/variables, rollback bar,
  TR/EN interface, document templates (`Cantilever Beam`, `L-Bracket`, `Box + Lid Assembly`).
- Gemini CAD assistant: the API key is stored only in this browser; Turkish or English requests are
  translated to a validated command list and applied inside the normal undo/redo history.
- Multi-part assemblies with Coincident, Concentric and Distance mates.
- STEP (AP214), IGES, STL and OBJ import/export; `.mcad.json` projects; IndexedDB autosave.
- Ansys-inspired structural analysis: material library, conforming hexahedral (8-node brick)
  mesh, fixed supports, forces/pressures, linear static solve, total deformation and Von Mises
  stress with Geometry/Material/Mesh/Loads/Results status indicators.
- WebGPU renderer with an automatic WebGL2 fallback (`?renderer=webgl2` forces the fallback).

## Development

```bash
npm install
npm run dev      # http://localhost:5173/MarmaraCad/
npm run build    # typecheck + production build
npm test         # unit tests
npm run test:e2e # 19 Playwright suites (start `npm run dev` first; uses local Chrome)
npm run test:ui  # non-visual UI audit: icon hydration, overflow, legend, sketch raster proof
npm run test:live # smoke test against the published GitHub Pages build
```

Any end-to-end suite can target a deployed build instead of the dev server:

```bash
MARMARACAD_URL=https://baran1248.github.io/MarmaraCad/ npm run test:e2e
```

The phase-2 suites cover Ctrl+click multi-selection into a bulk fillet, dynamic input
(`100`, `Tab`, `0`, `Enter`), midpoint/endpoint/origin snaps and alignment guides, window vs
crossing selection, construction/trim/offset/convert plus sketch definition colours, the Box + Lid
template (shell volume, placement, zero interference, mass), technical drawing + PDF, Section View,
rollback, Toolbox, TR/EN, the view selector, the `?` guide, and the Gemini assistant with a mocked
API.

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
| `src/kernel/fea.worker.ts` | voxel hexahedral meshing, CSR assembly, PCG solve, stress recovery |
| `src/viewport/` | Three.js scene, picking, sketch rendering, CPU section cut, result visualisation |
| `src/sketch/` | 2D constraint solver, profile extraction, snapping, dynamic input |
| `src/model/` | project document model, feature history, mates, materials, expressions, toolbox |
| `src/analysis/` | material library, FEA study model, solver and result helpers |
| `src/drawing/` | orthographic/isometric SVG drawing generator and PDF export |
| `src/ui/` | CommandManager, FeatureManager, PropertyManager, dialogs, colorbar, Gemini assistant |

## Licensing

Application code: MIT. OpenCascade.js/OCCT is distributed under LGPL-2.1; Three.js under MIT.
No proprietary SolidWorks or Ansys code or assets are used. The UI is an original clean-room
implementation inspired by familiar mechanical-CAD workflows.
