import React from 'react';

const STATUS_COLOR = {
  Idle: '#22c55e',
  Executing: '#d05500',
  Setup: '#d05500',
  Interactive: '#3d9e91',
  CancelingExecution: '#ef4444',
};

/**
 * Shows the engine's statusChanged value and, when resultsInvalidatedChanged
 * has fired true (e.g. after an asset upload), offers a manual
 * execute()/cancelExecution() — most parameter edits re-execute
 * automatically, but this covers the cases that don't.
 */
export default function StatusBar({ status, resultsInvalidated, module }) {
  const isExecuting = status === 'Executing' || status === 'CancelingExecution';

  return (
    <div
      style={{
        position: 'absolute', top: 12, right: 12, display: 'flex',
        alignItems: 'center', gap: 8, zIndex: 6,
        background: 'rgba(255,255,255,0.92)', border: '1px solid rgba(0,0,0,0.12)',
        borderRadius: 5, padding: '5px 10px', fontSize: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
      }}
    >
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: STATUS_COLOR[status] ?? '#999', flexShrink: 0,
      }} />
      <span style={{ color: '#333' }}>{status}</span>

      {resultsInvalidated && (
        <button
          onClick={() => (isExecuting ? module?.cancelExecution() : module?.execute())}
          style={{
            marginLeft: 4, padding: '3px 10px', borderRadius: 4, border: 'none',
            cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
            background: isExecuting ? '#ef4444' : '#d05500', color: '#fff',
          }}
        >
          {isExecuting ? 'Cancel' : 'Execute'}
        </button>
      )}
    </div>
  );
}
