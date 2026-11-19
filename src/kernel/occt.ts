// OpenCascade.js (OCCT) WASM loader. The stock package entry imports the
// .wasm file without Vite's ?url suffix, which Vite rejects, so we load the
// glue module and wasm asset explicitly.
// @ts-ignore - upstream package has no ESM type declarations for this path
import opencascadeFactory from "opencascade.js/dist/opencascade.wasm.js";
// @ts-ignore - Vite asset URL import
import occtWasmUrl from "opencascade.js/dist/opencascade.wasm.wasm?url";

let occtPromise: Promise<any> | null = null;

export function getOcct(): Promise<any> {
  if (!occtPromise) {
    occtPromise = Promise.resolve(
      opencascadeFactory({
        locateFile: (path: string) => (path.endsWith(".wasm") ? occtWasmUrl : path),
        print: () => {},
        printErr: () => {},
      }),
    ).catch((err) => {
      occtPromise = null;
      throw err;
    });
  }
  return occtPromise;
}
