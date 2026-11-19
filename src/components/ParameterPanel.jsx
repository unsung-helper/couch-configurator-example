import React from 'react';
import ParameterControl from './ParameterControl';
import ConfigurationControls from './ConfigurationControls';

/**
 * Right-side panel that shows every dynamic parameter emitted by the WASM
 * module (boolean / integer / number / string / enum / uri / color / trigger),
 * in the order they were first added.
 */
export default function ParameterPanel({ module, parameters, width, onShowInstructions }) {
  const visibleParams = parameters.filter(p => p.visible);

  return (
    <div
      style={{
        width, flexShrink: 0, height: '100%', overflowY: 'auto',
        background: '#fafafa', borderLeft: '1px solid #ddd',
        display: 'flex', flexDirection: 'column',
      }}
    >
      <div
        style={{
          padding: '12px 14px 10px', borderBottom: '1px solid #e0e0e0',
          fontSize: 13, fontWeight: 600, color: '#333',
          letterSpacing: '0.02em', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}
      >
        Parameters
        <button
          onClick={onShowInstructions}
          title="How to drive this product from your own code"
          style={{
            padding: '3px 8px', borderRadius: 4, border: '1px solid #ccc',
            background: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 500,
            fontFamily: 'inherit', color: '#333',
          }}
        >
          {'</>'} API guide
        </button>
      </div>

      <ConfigurationControls module={module} />

      <div style={{ padding: '4px 14px 12px', flex: 1 }}>
        {visibleParams.length === 0 ? (
          <p style={{ fontSize: 12, color: '#aaa', marginTop: 16, textAlign: 'center' }}>
            {parameters.length === 0 ? 'No parameters' : 'No visible parameters'}
          </p>
        ) : (
          visibleParams.map(param => (
            <ParameterControl key={param.id} param={param} module={module} />
          ))
        )}
      </div>
    </div>
  );
}
