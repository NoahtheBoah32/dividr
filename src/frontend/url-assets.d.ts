/**
 * Ambient typing for Vite `?url` asset imports (e.g. the bundled RNNoise wasm and
 * worklet). Vite resolves these to a string URL at build time. The project does
 * not reference `vite/client`, so declare the suffix module here.
 */
declare module '*?url' {
  const src: string;
  export default src;
}
