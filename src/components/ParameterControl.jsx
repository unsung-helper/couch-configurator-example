import React, { useState, useEffect } from 'react';
import { displayLabel } from '../utils';
import EnumControl from './EnumControl';

// Engine colour channels are 0..1 floats (us::Color); <input type="color"> is
// #rrggbb. module.setColorParameterValue(id, r, g, b) takes the 0..1 channels.
function rgbToHex(rgb) {
  const c = Array.isArray(rgb) ? rgb : [0, 0, 0];
  const h = (n) => Math.max(0, Math.min(255, Math.round((Number(n) || 0) * 255)))
    .toString(16).padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex).trim());
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

const S = {
  row: {
    display: 'flex', flexDirection: 'column', gap: 4,
    padding: '6px 0', borderBottom: '1px solid #e8e8e8',
  },
  label: { fontSize: 12, color: '#555', fontWeight: 500, userSelect: 'none' },
  input: {
    width: '100%', padding: '5px 8px', border: '1px solid #ccc',
    borderRadius: 4, fontSize: 13, background: '#fff', outline: 'none',
    fontFamily: 'inherit',
  },
  slider: { width: '100%', cursor: 'pointer', accentColor: '#d05500' },
  select: {
    width: '100%', padding: '5px 8px', border: '1px solid #ccc',
    borderRadius: 4, fontSize: 13, background: '#fff',
    fontFamily: 'inherit', cursor: 'pointer',
  },
  checkboxRow: { display: 'flex', alignItems: 'center', gap: 8 },
  checkbox: { width: 15, height: 15, cursor: 'pointer', accentColor: '#d05500' },
  fileInput: { width: '100%', fontSize: 12 },
  unit: { fontSize: 11, color: '#888', marginLeft: 4 },
  sliderValue: { fontSize: 12, color: '#333', textAlign: 'right' },
};

/**
 * Renders one parameter based on its type and calls the matching
 * module.set*ParameterValue()/invokeTriggerParameter()/activate…() function
 * when the user changes it.
 */
export default function ParameterControl({ param, module }) {
  const label = displayLabel(param);
  const editable = param.editable !== false;

  // Local value state keeps inputs responsive while the WASM event round-trips.
  const [localValue, setLocalValue] = useState(param.value);
  useEffect(() => { setLocalValue(param.value); }, [param.value]);

  if (!param.visible) return null;

  switch (param.paramType) {
    case 'boolean':
      return (
        <div style={S.row}>
          <div style={S.checkboxRow}>
            <input
              type="checkbox" style={S.checkbox}
              checked={!!localValue} disabled={!editable}
              onChange={(e) => {
                setLocalValue(e.target.checked);
                module?.setBooleanParameterValue(param.id, e.target.checked);
              }}
            />
            <span style={S.label}>{label}</span>
          </div>
        </div>
      );

    case 'number': {
      const isSlider = param.presentation === 1;
      return (
        <div style={S.row}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={S.label}>{label}</span>
            {param.unit ? <span style={S.unit}>{param.unit}</span> : null}
          </div>
          {isSlider ? (
            <>
              <input
                type="range" style={S.slider}
                min={param.minimum ?? 0} max={param.maximum ?? 100} step="any"
                value={localValue ?? 0} disabled={!editable}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setLocalValue(v);
                  module?.setNumberParameterValue(param.id, v);
                }}
              />
              <div style={S.sliderValue}>{Number(localValue).toFixed(3)}</div>
            </>
          ) : (
            <input
              type="number" style={S.input}
              value={localValue ?? ''} min={param.minimum} max={param.maximum} step="any"
              disabled={!editable}
              onChange={(e) => setLocalValue(e.target.value)}
              onBlur={(e) => {
                const v = parseFloat(e.target.value);
                if (!isNaN(v)) {
                  setLocalValue(v);
                  module?.setNumberParameterValue(param.id, v);
                }
              }}
            />
          )}
        </div>
      );
    }

    case 'integer':
      return (
        <div style={S.row}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={S.label}>{label}</span>
            {param.unit ? <span style={S.unit}>{param.unit}</span> : null}
          </div>
          <input
            type="number" step="1" style={S.input}
            value={localValue ?? ''} min={param.minimum} max={param.maximum}
            disabled={!editable}
            onChange={(e) => setLocalValue(e.target.value)}
            onBlur={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v)) {
                setLocalValue(v);
                module?.setIntegerParameterValue(param.id, v);
              }
            }}
          />
        </div>
      );

    case 'string':
      return (
        <div style={S.row}>
          <span style={S.label}>{label}</span>
          <input
            type="text" style={S.input}
            value={localValue ?? ''} disabled={!editable}
            onChange={(e) => setLocalValue(e.target.value)}
            onBlur={(e) => module?.setStringParameterValue(param.id, e.target.value)}
          />
        </div>
      );

    case 'uri':
      return (
        <div style={S.row}>
          <span style={S.label}>{label}</span>
          <input
            type="file" style={S.fileInput} disabled={!editable}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              const ext = file.name.split('.').pop().toLowerCase();
              reader.onload = (ev) => {
                let contents = ev.target.result;
                // Normalise the MIME type in the data URI to the file extension.
                contents = contents.replace(/^data:.*?;base64,/, `data:${ext};base64,`);
                module?.setURIParameterValue(param.id, contents);
              };
              reader.readAsDataURL(file);
            }}
          />
        </div>
      );

    case 'enum':
      return (
        <div style={S.row}>
          <span style={S.label}>{label}</span>
          <EnumControl
            param={param} value={localValue} disabled={!editable} label={label}
            onChange={(v) => {
              setLocalValue(v);
              module?.setEnumParameterValue(param.id, v);
            }}
          />
        </div>
      );

    case 'color': {
      const hex = rgbToHex(localValue);
      return (
        <div style={S.row}>
          <span style={S.label}>{label}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="color"
              style={{
                width: 40, height: 26, padding: 0, border: '1px solid #ccc',
                borderRadius: 4, background: '#fff', cursor: 'pointer', flexShrink: 0,
              }}
              value={hex} disabled={!editable}
              onChange={(e) => {
                const rgb = hexToRgb(e.target.value);
                setLocalValue(rgb);
                module?.setColorParameterValue(param.id, rgb[0], rgb[1], rgb[2]);
              }}
            />
            <span style={{ fontSize: 12, color: '#333', fontFamily: 'monospace' }}>
              {hex.toUpperCase()}
            </span>
          </div>
        </div>
      );
    }

    case 'trigger':
      return (
        <div style={S.row}>
          <button
            style={{
              width: '100%', padding: '6px 12px', border: 'none', borderRadius: 4,
              fontSize: 13, cursor: editable ? 'pointer' : 'not-allowed',
              fontFamily: 'inherit', fontWeight: 500, background: '#d05500',
              color: '#fff', opacity: editable ? 1 : 0.5, transition: 'background 0.15s',
            }}
            disabled={!editable}
            onClick={() => module?.invokeTriggerParameter(param.id)}
          >
            {label}
          </button>
        </div>
      );

    default:
      return null;
  }
}
