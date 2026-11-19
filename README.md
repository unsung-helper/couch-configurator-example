# Unsung Helper couch configurator example

This repository contains a representative export of the couch configurator example of [Unsung Helper][https://www.unsunghelper.com].

This is a minimal React app that shows how to embed and drive the WebAssembly
module produced when you export a product from the Unsung editor.

`public/unsung.js` and `public/unsung.wasm` are your exported product — they
already have your product's graph baked in.

## Running

```bash
npm install
npm run dev
```

Then open the printed local URL.

## How it works

- `src/LoadWasm.js` injects `unsung.js` as a `<script>` tag and resolves once
  the Emscripten runtime calls `Module.onRuntimeInitialized`.
- `src/components/ThreeCanvas.jsx` calls `module.load()` (no arguments — the
  product is already compiled in) once the module is ready, then renders the
  `mesh`/`polyline`/`points` outputs with three.js and forwards pointer
  events to `module.sendUserEvent(...)` while an interactive parameter is
  active.
- `src/App.jsx` listens for every parameter/output event the module can emit
  (see the full list in `src/LoadWasm.js` comments) and keeps them in React
  state, which `ParameterPanel`, `BottomBar`, `ImageOutputs` and `StatusBar`
  render.

## API guide

Click **</> API guide** at the top of the parameter panel for developer
instructions generated from this product as it loads. For every parameter and
output it lists the ID, external ID and description, the call that drives it
(e.g. `Module.setNumberParameterValue('<id>', …)`), and every event it fires,
with each `event.detail` key explained and the last payload received. **Copy as
Markdown** copies the whole guide to the clipboard.

A product with assembly nodes adds and removes parameters and outputs at run
time, so the guide warns that its lists are incomplete for such a product
(`src/instructions/productFeatures.js`, generated when the demo is exported).

The guide is built by `src/instructions/useApiInstructions.js` (which listens
for the events) from the reference in `src/instructions/apiCatalog.js`.

## Building for production

```bash
npm run build
```

This produces a static `dist/` folder you can host anywhere — no backend
required, since the whole product runs client-side in WebAssembly.

## Third-party notices

`unsung.wasm` and this demo include open-source components; their licenses are
in `THIRD_PARTY_NOTICES.txt`. Keep that file with the product when you
distribute or host it — for example, by copying it into `public/` so it is
served alongside `unsung.wasm`.
