declare module "opencascade.js/dist/opencascade.wasm.js" {
  const factory: (options?: Record<string, unknown>) => Promise<any>;
  export default factory;
}

declare module "*.wasm?url" {
  const url: string;
  export default url;
}
