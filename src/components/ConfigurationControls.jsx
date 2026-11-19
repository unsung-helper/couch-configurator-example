import React, { useEffect, useRef, useState } from 'react';

const DEFAULT_FILENAME = 'configuration.prm';

/**
 * Load / save the current parameter values as a .prm file on the viewer's
 * machine.
 *
 * - Save calls module.saveConfiguration(filename). The engine answers
 *   asynchronously with a `savedConfiguration` event carrying
 *   { contents, filename }, which is then written to disk.
 * - Load reads a picked .prm file and passes its text to
 *   module.loadConfiguration(contents), which applies the values and
 *   re-executes the product.
 *
 * Both bindings are defined in webClient/WebClient.cpp
 * (EMSCRIPTEN_BINDINGS(unsungRunner)); on an older unsung.js without them the
 * buttons are disabled.
 */
export default function ConfigurationControls({ module }) {
  const inputRef = useRef(null);
  // Resolves the pending save: either a FileSystemFileHandle picked up front
  // (so the native "Save as" dialog opens within the click's user gesture),
  // or null to fall back to a regular browser download.
  const pendingSaveRef = useRef(null);
  const [message, setMessage] = useState(null);

  const supported = !!module
    && typeof module.saveConfiguration === 'function'
    && typeof module.loadConfiguration === 'function';

  useEffect(() => {
    async function onSavedConfiguration(e) {
      const pending = pendingSaveRef.current;
      if (!pending) return;
      pendingSaveRef.current = null;
      const { contents, filename } = e.detail;
      try {
        if (pending.handle) {
          const writable = await pending.handle.createWritable();
          await writable.write(contents);
          await writable.close();
        } else {
          downloadText(contents, filename || DEFAULT_FILENAME);
        }
        setMessage({ text: 'Configuration saved.' });
      } catch (err) {
        console.error('Saving configuration failed', err);
        setMessage({ text: 'Saving the configuration failed.', error: true });
      }
    }
    document.addEventListener('savedConfiguration', onSavedConfiguration);
    return () => document.removeEventListener('savedConfiguration', onSavedConfiguration);
  }, []);

  async function handleSave() {
    if (!supported) return;
    let handle = null;
    let filename = DEFAULT_FILENAME;
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: DEFAULT_FILENAME,
          types: [{ description: 'Parameter configuration', accept: { 'application/json': ['.prm'] } }],
        });
        filename = handle.name;
      } catch (err) {
        if (err && err.name === 'AbortError') return; // user cancelled
        handle = null;
      }
    }
    pendingSaveRef.current = { handle };
    setMessage(null);
    module.saveConfiguration(filename);
  }

  function handleLoadClick() {
    if (!supported) return;
    inputRef.current?.click();
  }

  async function handleFileChosen(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const contents = await file.text();
      JSON.parse(contents); // reject obviously wrong files before the engine sees them
      module.loadConfiguration(contents);
      setMessage({ text: `Loaded ${file.name}.` });
    } catch (err) {
      console.error('Loading configuration failed', err);
      setMessage({ text: `${file.name} is not a valid configuration file.`, error: true });
    }
  }

  const title = supported ? undefined : 'Not supported by this unsung.js build';

  return (
    <div style={{ padding: '8px 14px', borderBottom: '1px solid #e0e0e0', flexShrink: 0 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={buttonStyle} onClick={handleLoadClick} disabled={!supported} title={title}>
          Load configuration…
        </button>
        <button style={buttonStyle} onClick={handleSave} disabled={!supported} title={title}>
          Save configuration…
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".prm,application/json"
        style={{ display: 'none' }}
        onChange={handleFileChosen}
      />
      {message && (
        <div style={{ marginTop: 6, fontSize: 11, color: message.error ? '#c03030' : '#777' }}>
          {message.text}
        </div>
      )}
    </div>
  );
}

function downloadText(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const buttonStyle = {
  flex: 1, padding: '5px 6px', fontSize: 12, cursor: 'pointer',
  border: '1px solid #ccc', borderRadius: 4, background: '#fff', color: '#333',
};
