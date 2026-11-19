/**
 * Loads unsung.js (the Emscripten build produced by exporting a product) and
 * returns a promise that resolves with the fully-initialised Module once the
 * WASM runtime is ready.
 *
 * unsung.js/unsung.wasm are expected to live in `public/` (served at the
 * document root by Vite), alongside this app.
 *
 * Once ready, the module exposes exactly these functions — this is the
 * entire client API surface of an exported unsung product:
 *
 *   load()                                    — load the embedded product; computes nothing,
 *                                              ThreeCanvas calls execute() after productLoaded
 *   execute() / cancelExecution()             — (re)run / cancel the current computation
 *   setBooleanParameterValue(id, bool)
 *   setIntegerParameterValue(id, int)
 *   setNumberParameterValue(id, float)
 *   setStringParameterValue(id, string)
 *   setEnumParameterValue(id, string)
 *   setURIParameterValue(id, dataURI)
 *   invokeTriggerParameter(id)
 *   sendMouseEvent(gesture, button, x, y, modifiers) -> requestId
 *   sendWheelEvent(delta, modifiers) -> requestId
 *   sendCameraChange(posX, posY, posZ, targetX, targetY, targetZ,
 *                     upX, upY, upZ, near, far, fov, lock)
 *   sendDimensionsChange(width, height)
 *
 * Every node in the product can listen for mouse/wheel/camera/dimension
 * events now (there is no more single "active interactive parameter").
 * sendMouseEvent/sendWheelEvent return a request id that comes back on a
 * `userEventHandled` event telling the caller whether any node consumed it.
 *
 * Everything else — parameter values, geometry, images, downloadable files —
 * arrives asynchronously as `CustomEvent`s dispatched on `document`. See
 * App.jsx and ThreeCanvas.jsx for the full list this demo listens for.
 */
export function LoadWasm() {
  if (window._unsungWasmReady) {
    return Promise.resolve(window.Module);
  }
  if (window._unsungWasmLoading) {
    return window._unsungWasmLoading;
  }

  window._unsungWasmLoading = new Promise((resolve, reject) => {
    // Pre-configure Module so we get the callback before unsung.js runs.
    // Emscripten reads Module.onRuntimeInitialized during startup.
    window.Module = window.Module || {};
    window.Module.onRuntimeInitialized = function () {
      window._unsungWasmReady = true;
      resolve(window.Module);
    };

    const script = document.createElement('script');
    script.src = 'unsung.js';
    script.async = false; // preserve execution order relative to other scripts
    script.onerror = () => reject(new Error('Failed to load unsung.js'));
    document.body.appendChild(script);
  });

  return window._unsungWasmLoading;
}
