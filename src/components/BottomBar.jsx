import React from 'react';

/**
 * Bottom bar showing string/number outputs (read-only computed values).
 */
export default function BottomBar({ stringOutputs, numberOutputs }) {
  const visibleStrings = stringOutputs.filter(o => o.visible);
  const visibleNumbers = numberOutputs.filter(o => o.visible);
  const hasOutputs = visibleStrings.length > 0 || visibleNumbers.length > 0;

  if (!hasOutputs) return null;

  return (
    <div
      style={{
        flexShrink: 0, background: '#f5f5f5', borderTop: '1px solid #ddd',
        padding: '8px 14px', display: 'flex', flexWrap: 'wrap', gap: 12,
        alignItems: 'center', minHeight: 44,
      }}
    >
      {visibleStrings.map(o => (
        <OutputItem key={o.id} label={o.name || o.id} value={o.value} />
      ))}

      {visibleNumbers.map(o => (
        <OutputItem
          key={o.id}
          label={o.name || o.id}
          value={(typeof o.value === 'number' ? o.value.toFixed(4) : o.value) + (o.unit ? ` ${o.unit}` : '')}
        />
      ))}
    </div>
  );
}

function OutputItem({ label, value }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
      <span style={{ fontSize: 12, color: '#777', fontWeight: 500 }}>{label}:</span>
      <span style={{ fontSize: 13, color: '#222' }}>{String(value)}</span>
    </div>
  );
}
