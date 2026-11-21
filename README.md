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
- Extrude Boss/Base, Extruded Cut, Revolve, Fillet and Chamfer as an editable feature history.
- Multi-part assemblies with Coincident, Concentric and Distance mates.
- STEP (AP214), IGES, STL and OBJ import/export; `.mcad.json` projects; IndexedDB autosave.
- Ansys-inspired structural analysis: material library, conforming hexahedral (8-node brick)
  mesh, fixed supports, forces/pressures, linear static solve, total deformation and Von Mises
  stress.
- WebGPU renderer with an automatic WebGL2 fallback (`?renderer=webgl2` forces the fallback).

## Development

```bash
npm install
npm run dev      # http://localhost:5173/MarmaraCad/
npm run build    # typecheck + production build
npm test         # unit tests
npm run test:e2e # Playwright end-to-end suite (start `npm run dev` first; uses local Chrome)
npm run test:ui  # non-visual UI audit: icon hydration, overflow, legend, sketch raster proof
npm run test:live # smoke test against the published GitHub Pages build
```

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
| `src/viewport/` | Three.js scene, picking, sketch rendering, result visualisation |
| `src/sketch/` | 2D constraint solver, profile extraction, snapping |
| `src/model/` | project document model, feature history, mates, materials |
| `src/ui/` | CommandManager, FeatureManager, PropertyManager, dialogs, colorbar |

## Licensing

Application code: MIT. OpenCascade.js/OCCT is distributed under LGPL-2.1; Three.js under MIT.
No proprietary SolidWorks or Ansys code or assets are used. The UI is an original clean-room
implementation inspired by familiar mechanical-CAD workflows.
