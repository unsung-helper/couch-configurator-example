import React, { useEffect, useRef, useState } from 'react';
import { imageUrl } from '../utils';

// An enum parameter: a dropdown or a grid of tiles (parameterPresentation),
// whose options show their label, their image or both (optionPresentation).
// An option without an image always shows its label.

const ACCENT = '#d05500';

const S = {
  select: {
    width: '100%', padding: '5px 8px', border: '1px solid #ccc',
    borderRadius: 4, fontSize: 13, background: '#fff',
    fontFamily: 'inherit', cursor: 'pointer',
  },
  dropdown: { position: 'relative' },
  dropdownButton: {
    width: '100%', display: 'flex', alignItems: 'center', gap: 8, minHeight: 32,
    padding: '3px 8px', border: '1px solid #ccc', borderRadius: 4, background: '#fff',
    fontSize: 13, fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left', color: '#222',
  },
  caret: { marginLeft: 'auto', fontSize: 10, color: '#888', flexShrink: 0 },
  list: {
    position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, marginTop: 2,
    maxHeight: 260, overflowY: 'auto', padding: 4, listStyle: 'none',
    background: '#fff', border: '1px solid #ccc', borderRadius: 4,
    boxShadow: '0 4px 14px rgba(0,0,0,.15)',
  },
  item: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px',
    borderRadius: 3, cursor: 'pointer', fontSize: 13, color: '#222',
  },
  itemActive: { background: 'rgba(208,85,0,.12)', color: ACCENT },
  itemFocus: { background: '#f2f2f2' },
  tiles: {
    display: 'grid', gap: 6,
    gridTemplateColumns: 'repeat(auto-fill, minmax(var(--tile-width), 1fr))',
  },
  tile: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 4, padding: 6, minWidth: 0, minHeight: 34,
    border: '1px solid #ccc', borderRadius: 6, background: '#fff', color: '#222',
    fontSize: 12, fontFamily: 'inherit', cursor: 'pointer',
  },
  tileActive: { borderColor: ACCENT, boxShadow: `0 0 0 1px ${ACCENT}`, background: 'rgba(208,85,0,.08)' },
  tileLabel: { maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  image: { objectFit: 'contain', display: 'block', flexShrink: 0 },
};

function OptionContent({ option, showIcon, showLabel, iconSize, labelStyle }) {
  const [failed, setFailed] = useState(false);
  const url = showIcon ? imageUrl(option.image) : '';
  useEffect(() => setFailed(false), [url]);
  const image = url && !failed;
  return (
    <>
      {image && (
        <img src={url} alt={showLabel ? '' : option.name} draggable={false}
          style={{ ...S.image, width: iconSize, height: iconSize }}
          onError={() => setFailed(true)} />
      )}
      {(showLabel || !image) && <span style={labelStyle}>{option.name}</span>}
    </>
  );
}

function Tiles({ options, value, onChange, disabled, showIcon, showLabel, label }) {
  const iconSize = 44;
  const width = showIcon ? (showLabel ? 84 : 64) : 72;
  return (
    <div role="radiogroup" aria-label={label} style={{ ...S.tiles, '--tile-width': `${width}px` }}>
      {options.map(o => {
        const active = o.name === value;
        return (
          <button
            key={o.name} type="button" role="radio" aria-checked={active} disabled={disabled}
            title={o.name}
            style={{ ...S.tile, ...(active ? S.tileActive : {}), ...(disabled ? { cursor: 'default', opacity: 0.6 } : {}) }}
            onClick={() => { if (!active) onChange(o.name); }}
          >
            <OptionContent option={o} showIcon={showIcon} showLabel={showLabel}
              iconSize={iconSize} labelStyle={S.tileLabel} />
          </button>
        );
      })}
    </div>
  );
}

// A listbox, as a native <select> can't show images.
function Dropdown({ options, value, onChange, disabled, showIcon, showLabel, label }) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(-1);
  const ref = useRef(null);
  const current = options.find(o => o.name === value);

  useEffect(() => {
    if (!open) return;
    setFocus(Math.max(0, options.findIndex(o => o.name === value)));
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const choose = (name) => {
    setOpen(false);
    if (name !== value) onChange(name);
  };

  const onKeyDown = (e) => {
    if (disabled) return;
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      setOpen(true);
    } else if (open && e.key === 'ArrowDown') {
      e.preventDefault();
      setFocus(f => Math.min(options.length - 1, f + 1));
    } else if (open && e.key === 'ArrowUp') {
      e.preventDefault();
      setFocus(f => Math.max(0, f - 1));
    } else if (open && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      if (options[focus]) choose(options[focus].name);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={ref} style={S.dropdown}>
      <button
        type="button" aria-haspopup="listbox" aria-expanded={open} aria-label={label}
        disabled={disabled}
        style={{ ...S.dropdownButton, ...(disabled ? { cursor: 'default', opacity: 0.6 } : {}) }}
        onClick={() => setOpen(o => !o)} onKeyDown={onKeyDown}
      >
        {current
          ? <OptionContent option={current} showIcon={showIcon} showLabel={showLabel} iconSize={24} />
          : <span style={{ color: '#888' }}>{value}</span>}
        <span style={S.caret}>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <ul role="listbox" aria-label={label} style={S.list}>
          {options.map((o, i) => (
            <li
              key={o.name} role="option" aria-selected={o.name === value} title={o.name}
              style={{ ...S.item, ...(i === focus ? S.itemFocus : {}), ...(o.name === value ? S.itemActive : {}) }}
              onMouseEnter={() => setFocus(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(o.name)}
            >
              <OptionContent option={o} showIcon={showIcon} showLabel={showLabel} iconSize={28} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function EnumControl({ param, value, onChange, disabled, label }) {
  const options = param.options ?? [];
  const showIcon = param.optionPresentation === 'icon' || param.optionPresentation === 'both';
  const showLabel = param.optionPresentation !== 'icon';
  const props = { options, value, onChange, disabled, showIcon, showLabel, label };

  if (param.parameterPresentation === 'tiles') return <Tiles {...props} />;
  if (showIcon) return <Dropdown {...props} />;
  return (
    <select style={S.select} value={value ?? ''} disabled={disabled} aria-label={label}
      onChange={(e) => onChange(e.target.value)}>
      {options.map(o => <option key={o.name} value={o.name}>{o.name}</option>)}
    </select>
  );
}
