import React, { useState } from 'react';

/**
 * Thumbnail strip for imageOutput* events (e.g. rendered previews or
 * generated textures). Click a thumbnail to view it full size in a new tab.
 */
export default function ImageOutputs({ images }) {
  const visible = images.filter(i => i.visible && i.contents);
  const [openId, setOpenId] = useState(null);
  if (visible.length === 0) return null;
  const opened = visible.find(i => i.id === openId);

  return (
    <>
      <div
        style={{
          position: 'absolute', top: 56, right: 12, display: 'flex',
          flexDirection: 'column', gap: 8, zIndex: 5,
        }}
      >
        {visible.map(img => (
          <button
            key={img.id}
            onClick={() => setOpenId(img.id)}
            title={img.name || img.id}
            style={{
              padding: 0, border: '1px solid rgba(0,0,0,0.18)', borderRadius: 5,
              overflow: 'hidden', cursor: 'pointer', background: '#fff',
              boxShadow: '0 1px 4px rgba(0,0,0,0.12)', width: 72, height: 72,
            }}
          >
            <img src={img.contents} alt={img.name || img.id}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </button>
        ))}
      </div>

      {opened && (
        <div
          onClick={() => setOpenId(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 50, cursor: 'zoom-out',
          }}
        >
          <img src={opened.contents} alt={opened.name || opened.id}
            style={{ maxWidth: '90%', maxHeight: '90%', boxShadow: '0 8px 40px rgba(0,0,0,0.5)' }} />
        </div>
      )}
    </>
  );
}
