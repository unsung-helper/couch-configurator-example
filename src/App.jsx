import React, { useState, useCallback, useEffect } from 'react';
import ThreeCanvas from './components/ThreeCanvas';
import ParameterPanel from './components/ParameterPanel';
import BottomBar from './components/BottomBar';
import ImageOutputs from './components/ImageOutputs';
import StatusBar from './components/StatusBar';
import InstructionsModal from './components/InstructionsModal';
import useApiInstructions from './instructions/useApiInstructions';

const PANEL_WIDTH = 300;

export default function App() {
  const [module, setModule] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [productLoaded, setProductLoaded] = useState(false);

  // Engine status — see WebRunner::onStatusChanged / onResultsInvalidatedChanged
  // / onPendingChangesChanged in webTemplate/WebTemplate.cpp.
  const [status, setStatus] = useState('Setup');
  const [resultsInvalidated, setResultsInvalidated] = useState(false);

  // All dynamic parameters in insertion order.
  // Each entry: { id, paramType, name, externalID, value, visible, editable,
  //               unit?, minimum?, maximum?, presentation?, options? }
  const [parameters, setParameters] = useState([]);

  // String / number outputs shown in the bottom bar, and image outputs
  // shown as thumbnails over the canvas.
  const [stringOutputs, setStringOutputs] = useState([]);
  const [numberOutputs, setNumberOutputs] = useState([]);
  const [imageOutputs, setImageOutputs] = useState([]);

  // Developer instructions for this product's unsung.js API, generated from
  // the parameter/output events as the product loads. Names, descriptions
  // and external IDs only arrive with the first run (…Changed events), which
  // ThreeCanvas starts as soon as the product is loaded.
  const { entries: apiEntries, hasRun: apiHasRun } = useApiInstructions();
  const [showInstructions, setShowInstructions] = useState(false);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const addOrUpdate = useCallback((setter, id, data) => {
    setter(prev => {
      const idx = prev.findIndex(p => p.id === id);
      if (idx === -1) return [...prev, { id, ...data }];
      const next = [...prev];
      next[idx] = { ...next[idx], ...data };
      return next;
    });
  }, []);

  const remove = useCallback((setter, id) => {
    setter(prev => prev.filter(p => p.id !== id));
  }, []);

  // ── Register WASM event listeners ───────────────────────────────────────────
  //
  // This runs once on mount, unconditionally — NOT gated on `module` being
  // set. module.load() (called from ThreeCanvas as soon as the WASM module
  // is ready) submits its command to a background worker thread, which
  // dispatches the *entire* initial burst of events (loadingStarted,
  // productLoaded, every parameter/output Added event) back to the main
  // thread asynchronously via emscripten_async_run_in_main_runtime_thread.
  // If listener registration instead waited for a `module` React state
  // update (itself set from an async WASM-ready callback), it would be
  // racing that worker-thread round-trip and can easily lose, silently
  // dropping the initial parameters/outputs. Registering unconditionally
  // during the synchronous initial mount guarantees listeners are attached
  // long before the WASM has even finished loading.

  useEffect(() => {
    // ── Lifecycle / engine status events ────────────────────────────────────

    function onStatusChanged(e) { setStatus(e.detail.status); }
    function onResultsInvalidatedChanged(e) { setResultsInvalidated(!!e.detail.invalidated); }
    function onLoadingStarted() {
      // Fires once the product's graph structure is known, before the
      // initial parameter/output events. Clear any stale state from a
      // previous load() call.
      setParameters([]);
      setStringOutputs([]);
      setNumberOutputs([]);
      setImageOutputs([]);
    }
    function onProductLoaded() { setProductLoaded(true); }

    // ── Parameter events ───────────────────────────────────────────────────

    function onBooleanParameterAdded(e) {
      const d = e.detail;
      addOrUpdate(setParameters, d.id, { paramType: 'boolean', name: d.name, externalID: d.externalID,
        value: !!d.value, visible: !!d.visible, editable: !!d.editable });
    }
    function onBooleanParameterChanged(e) {
      const d = e.detail;
      addOrUpdate(setParameters, d.id, { name: d.name, externalID: d.externalID, description: d.description, value: !!d.value, visible: !!d.visible, editable: !!d.editable });
    }
    function onBooleanParameterRemoved(e) { remove(setParameters, e.detail.id); }

    function onIntegerParameterAdded(e) {
      const d = e.detail;
      addOrUpdate(setParameters, d.id, { paramType: 'integer', name: d.name, externalID: d.externalID,
        value: d.value, visible: !!d.visible, editable: !!d.editable,
        unit: d.unit, minimum: d.minimum, maximum: d.maximum });
    }
    function onIntegerParameterChanged(e) {
      const d = e.detail;
      addOrUpdate(setParameters, d.id, { name: d.name, externalID: d.externalID, description: d.description, value: d.value, visible: !!d.visible,
        editable: !!d.editable, unit: d.unit, minimum: d.minimum, maximum: d.maximum });
    }
    function onIntegerParameterRemoved(e) { remove(setParameters, e.detail.id); }

    function onNumberParameterAdded(e) {
      const d = e.detail;
      addOrUpdate(setParameters, d.id, { paramType: 'number', name: d.name, externalID: d.externalID,
        value: d.value, visible: !!d.visible, editable: !!d.editable,
        unit: d.unit, minimum: d.minimum, maximum: d.maximum, presentation: d.presentation });
    }
    function onNumberParameterChanged(e) {
      const d = e.detail;
      addOrUpdate(setParameters, d.id, { name: d.name, externalID: d.externalID, description: d.description, value: d.value, visible: !!d.visible,
        editable: !!d.editable, unit: d.unit, minimum: d.minimum, maximum: d.maximum,
        presentation: d.presentation });
    }
    function onNumberParameterRemoved(e) { remove(setParameters, e.detail.id); }

    function onStringParameterAdded(e) {
      const d = e.detail;
      addOrUpdate(setParameters, d.id, { paramType: 'string', name: d.name, externalID: d.externalID,
        value: d.value, visible: !!d.visible, editable: !!d.editable });
    }
    function onStringParameterChanged(e) {
      const d = e.detail;
      addOrUpdate(setParameters, d.id, { name: d.name, externalID: d.externalID, description: d.description, value: d.value, visible: !!d.visible, editable: !!d.editable });
    }
    function onStringParameterRemoved(e) { remove(setParameters, e.detail.id); }

    function onUriParameterAdded(e) {
      const d = e.detail;
      addOrUpdate(setParameters, d.id, { paramType: 'uri', name: d.name, externalID: d.externalID,
        value: d.value, visible: !!d.visible, editable: !!d.editable });
    }
    function onUriParameterChanged(e) {
      const d = e.detail;
      addOrUpdate(setParameters, d.id, { name: d.name, externalID: d.externalID, description: d.description, value: d.value, visible: !!d.visible, editable: !!d.editable });
    }
    function onUriParameterRemoved(e) { remove(setParameters, e.detail.id); }

    // options: one comma-separated string; images: the image URI of each
    // option ('' without one), in the same order
    function enumFields(d) {
      const names = d.options ? d.options.split(',') : [];
      const images = Array.isArray(d.images) ? d.images : [];
      const options = names.map((name, i) => ({ name, image: images[i] ?? '' })).filter(o => o.name);
      return {
        name: d.name, externalID: d.externalID, description: d.description, value: d.value,
        visible: !!d.visible, editable: !!d.editable, options,
        parameterPresentation: d.parameterPresentation || 'dropdown',
        optionPresentation: d.optionPresentation || 'label',
      };
    }
    function onEnumParameterAdded(e) {
      addOrUpdate(setParameters, e.detail.id, { paramType: 'enum', ...enumFields(e.detail) });
    }
    function onEnumParameterChanged(e) {
      addOrUpdate(setParameters, e.detail.id, enumFields(e.detail));
    }
    function onEnumParameterRemoved(e) { remove(setParameters, e.detail.id); }

    // Colour parameter value/defaultValue are [r, g, b] with each channel 0..1
    // (us::Color) — see webTemplate/WebTemplate.cpp visit(ColorParameterAddedEvent).
    function onColorParameterAdded(e) {
      const d = e.detail;
      addOrUpdate(setParameters, d.id, { paramType: 'color', name: d.name, externalID: d.externalID,
        value: d.value, visible: !!d.visible, editable: !!d.editable });
    }
    function onColorParameterChanged(e) {
      const d = e.detail;
      addOrUpdate(setParameters, d.id, { name: d.name, externalID: d.externalID, description: d.description, value: d.value, visible: !!d.visible, editable: !!d.editable });
    }
    function onColorParameterRemoved(e) { remove(setParameters, e.detail.id); }

    function onTriggerParameterAdded(e) {
      const d = e.detail;
      addOrUpdate(setParameters, d.id, { paramType: 'trigger', name: d.name, externalID: d.externalID,
        visible: !!d.visible, editable: !!d.editable });
    }
    function onTriggerParameterChanged(e) {
      const d = e.detail;
      addOrUpdate(setParameters, d.id, { name: d.name, externalID: d.externalID, description: d.description, visible: !!d.visible, editable: !!d.editable });
    }
    function onTriggerParameterRemoved(e) { remove(setParameters, e.detail.id); }

    // ── Output events ──────────────────────────────────────────────────────

    function onStringOutputAdded(e) {
      const d = e.detail;
      addOrUpdate(setStringOutputs, d.id, { name: d.name || d.id, value: d.value || '', visible: !!(d.visible ?? true) });
    }
    function onStringOutputChanged(e) {
      const d = e.detail;
      addOrUpdate(setStringOutputs, d.id, { name: d.name || d.id, value: d.value || '', visible: !!(d.visible ?? true) });
    }
    function onStringOutputRemoved(e) { remove(setStringOutputs, e.detail.id); }

    function onNumberOutputAdded(e) {
      const d = e.detail;
      addOrUpdate(setNumberOutputs, d.id, { name: d.name || d.id, value: d.value, unit: d.unit, visible: !!(d.visible ?? true) });
    }
    function onNumberOutputChanged(e) {
      const d = e.detail;
      addOrUpdate(setNumberOutputs, d.id, { name: d.name || d.id, value: d.value, unit: d.unit, visible: !!(d.visible ?? true) });
    }
    function onNumberOutputRemoved(e) { remove(setNumberOutputs, e.detail.id); }

    function onImageOutputAdded(e) {
      const d = e.detail;
      addOrUpdate(setImageOutputs, d.id, { name: d.name || d.id, visible: !!(d.visible ?? true) });
    }
    function onImageOutputChanged(e) {
      const d = e.detail;
      addOrUpdate(setImageOutputs, d.id, { name: d.name || d.id, visible: !!(d.visible ?? true) });
    }
    function onImageOutputRemoved(e) { remove(setImageOutputs, e.detail.id); }
    function onImageOutputContentsChanged(e) {
      const { id, contents } = e.detail;
      addOrUpdate(setImageOutputs, id, { contents });
    }

    // Downloadable binary outputs are handled (auto-download) in
    // ThreeCanvas — this just keeps the list of available files, in case
    // you want to render your own "Downloads" UI instead.
    const binaryOutputs = {};
    function onBinaryOutputAdded(e) { binaryOutputs[e.detail.id] = e.detail; }
    function onBinaryOutputRemoved(e) { delete binaryOutputs[e.detail.id]; }
    function onBinaryOutputChanged(e) { binaryOutputs[e.detail.id] = { ...binaryOutputs[e.detail.id], ...e.detail }; }

    const listeners = [
      ['statusChanged', onStatusChanged],
      ['resultsInvalidatedChanged', onResultsInvalidatedChanged],
      ['loadingStarted', onLoadingStarted],
      ['productLoaded', onProductLoaded],

      ['booleanParameterAdded', onBooleanParameterAdded],
      ['booleanParameterChanged', onBooleanParameterChanged],
      ['booleanParameterRemoved', onBooleanParameterRemoved],
      ['integerParameterAdded', onIntegerParameterAdded],
      ['integerParameterChanged', onIntegerParameterChanged],
      ['integerParameterRemoved', onIntegerParameterRemoved],
      ['numberParameterAdded', onNumberParameterAdded],
      ['numberParameterChanged', onNumberParameterChanged],
      ['numberParameterRemoved', onNumberParameterRemoved],
      ['stringParameterAdded', onStringParameterAdded],
      ['stringParameterChanged', onStringParameterChanged],
      ['stringParameterRemoved', onStringParameterRemoved],
      ['uriParameterAdded', onUriParameterAdded],
      ['uriParameterChanged', onUriParameterChanged],
      ['uriParameterRemoved', onUriParameterRemoved],
      ['enumParameterAdded', onEnumParameterAdded],
      ['enumParameterChanged', onEnumParameterChanged],
      ['enumParameterRemoved', onEnumParameterRemoved],
      ['colorParameterAdded', onColorParameterAdded],
      ['colorParameterChanged', onColorParameterChanged],
      ['colorParameterRemoved', onColorParameterRemoved],
      ['triggerParameterAdded', onTriggerParameterAdded],
      ['triggerParameterChanged', onTriggerParameterChanged],
      ['triggerParameterRemoved', onTriggerParameterRemoved],

      ['stringOutputAdded', onStringOutputAdded],
      ['stringOutputChanged', onStringOutputChanged],
      ['stringOutputRemoved', onStringOutputRemoved],
      ['numberOutputAdded', onNumberOutputAdded],
      ['numberOutputChanged', onNumberOutputChanged],
      ['numberOutputRemoved', onNumberOutputRemoved],
      ['imageOutputAdded', onImageOutputAdded],
      ['imageOutputChanged', onImageOutputChanged],
      ['imageOutputRemoved', onImageOutputRemoved],
      ['imageOutputContentsChanged', onImageOutputContentsChanged],
      ['binaryOutputAdded', onBinaryOutputAdded],
      ['binaryOutputChanged', onBinaryOutputChanged],
      ['binaryOutputRemoved', onBinaryOutputRemoved],
    ];

    listeners.forEach(([evt, fn]) => document.addEventListener(evt, fn));
    return () => listeners.forEach(([evt, fn]) => document.removeEventListener(evt, fn));
  }, [addOrUpdate, remove]);

  // ── Layout ─────────────────────────────────────────────────────────────────

  const hasBottom = stringOutputs.some(o => o.visible) || numberOutputs.some(o => o.visible);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <ThreeCanvas
            onModuleReady={setModule}
            onLoadError={setLoadError}
          />

          <StatusBar status={status} resultsInvalidated={resultsInvalidated} module={module} />
          <ImageOutputs images={imageOutputs} />

          {!productLoaded && !loadError && (
            <div style={overlayStyle}>Loading product…</div>
          )}
          {loadError && (
            <div style={{ ...overlayStyle, color: '#e05050' }}>
              Failed to load unsung.js — see the console for details.
            </div>
          )}
        </div>

        <ParameterPanel module={module} parameters={parameters} width={PANEL_WIDTH}
          onShowInstructions={() => setShowInstructions(true)} />
      </div>

      {hasBottom && (
        <BottomBar
          stringOutputs={stringOutputs}
          numberOutputs={numberOutputs}
        />
      )}

      {showInstructions && (
        <InstructionsModal entries={apiEntries} hasRun={apiHasRun} onClose={() => setShowInstructions(false)} />
      )}
    </div>
  );
}

const overlayStyle = {
  position: 'absolute', inset: 0, display: 'flex',
  alignItems: 'center', justifyContent: 'center',
  background: 'rgba(255,255,255,0.85)', fontSize: 14, color: '#555',
  pointerEvents: 'none',
};
