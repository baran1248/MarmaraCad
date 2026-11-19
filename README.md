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
- Ansys-inspired structural analysis: material library, conforming tetrahedral mesh,
  fixed supports, forces/pressures, linear static solve, total deformation and Von Mises stress.

## Development

```bash
npm install
npm run dev      # http://localhost:5173/MarmaraCad/
npm run build    # typecheck + production build
npm test         # unit tests
npm run test:e2e # Playwright end-to-end suite (uses local Chrome)
```

The OpenCascade WASM binary is served as a static asset from the build output. On first load
the kernel is initialised inside a worker; a loading screen reports progress.

## Architecture

| Layer | Responsibility |
| --- | --- |
| `src/kernel/cad.worker.ts` | OCCT B-Rep operations, tessellation, topological metadata, STEP/IGES |
| `src/kernel/fea.worker.ts` | voxel tetrahedral meshing, CSR assembly, PCG solve, stress recovery |
| `src/viewport/` | Three.js scene, picking, sketch rendering, result visualisation |
| `src/sketch/` | 2D constraint solver, profile extraction, snapping |
| `src/model/` | project document model, feature history, mates, materials |
| `src/ui/` | CommandManager, FeatureManager, PropertyManager, dialogs, colorbar |

## Licensing

Application code: MIT. OpenCascade.js/OCCT is distributed under LGPL-2.1; Three.js under MIT.
No proprietary SolidWorks or Ansys code or assets are used. The UI is an original clean-room
implementation inspired by familiar mechanical-CAD workflows.
