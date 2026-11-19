import { useEffect, useState } from 'react';
import { KINDS } from './apiCatalog';

/**
 * Builds the product-specific API instructions on the fly: listens for every
 * parameter/output event in apiCatalog.js and keeps one entry per id with the
 * latest detail of every event received for it, so the instructions modal
 * can show real IDs, current values and example payloads.
 *
 * Returns { entries, hasRun }. Entries are in announcement order:
 *   { id, kind, details: { [eventName]: lastDetail } }
 * Names, descriptions, external IDs and visibility only arrive with the
 * first run of the product (as …Changed events), so hasRun tells whether
 * the entries already carry them. Use headerOf(entry) for the current
 * values: it merges the …Added and …Changed payloads.
 *
 * Like App.jsx's listeners, this registers on mount, unconditionally and
 * before module.load() runs, so the initial burst of …Added events is
 * never missed.
 */
export default function useApiInstructions() {
  const [entries, setEntries] = useState([]);
  const [hasRun, setHasRun] = useState(false);

  useEffect(() => {
    const upsert = (kind, eventName, detail) => {
      setEntries(prev => {
        const idx = prev.findIndex(e => e.id === detail.id && e.kind === kind);
        const snapshot = summarizeDetail(detail);
        if (idx === -1) return [...prev, { id: detail.id, kind, details: { [eventName]: snapshot } }];
        const next = [...prev];
        next[idx] = { ...next[idx], details: { ...next[idx].details, [eventName]: snapshot } };
        return next;
      });
    };
    const drop = (kind, id) => setEntries(prev => prev.filter(e => !(e.id === id && e.kind === kind)));

    const listeners = [
      ['loadingStarted', () => { setEntries([]); setHasRun(false); }],
      // a run that finished has sent the metadata of every parameter and output
      ['executingChanged', (e) => { if (!e.detail.executing) setHasRun(true); }],
    ];
    for (const kind of Object.values(KINDS)) {
      for (const evt of kind.events) {
        const fn = evt.name.endsWith('Removed')
          ? (e) => drop(kind.key, e.detail.id)
          : (e) => upsert(kind.key, evt.name, e.detail);
        listeners.push([evt.name, fn]);
      }
    }

    listeners.forEach(([evt, fn]) => document.addEventListener(evt, fn));
    return () => listeners.forEach(([evt, fn]) => document.removeEventListener(evt, fn));
  }, []);

  return { entries, hasRun };
}

/**
 * The current name/description/externalID/visibility of an entry. The
 * …Added event only carries placeholders until the product has run, and the
 * …Changed events carry the complete current state, so the newest wins.
 */
export function headerOf(entry) {
  const kind = KINDS[entry.kind];
  return { ...entry.details[kind.addedEvent], ...entry.details[`${kind.key}Changed`] };
}

// Event details can carry large typed arrays (geometry) and data: URIs
// (images, textures); keep only a short, JSON-friendly sample of those so
// state stays small and the modal can show an example payload.
const MAX_ITEMS = 9;
const MAX_STRING = 80;

function summarizeDetail(detail) {
  const out = {};
  for (const [key, value] of Object.entries(detail ?? {})) out[key] = summarize(value);
  return out;
}

function summarize(value) {
  if (ArrayBuffer.isView(value)) {
    const head = Array.from(value.slice(0, MAX_ITEMS), v => (Number.isInteger(v) ? v : +v.toFixed(4)));
    return { __typed: value.constructor.name, length: value.length, head };
  }
  if (typeof value === 'string' && value.length > MAX_STRING) {
    return `${value.slice(0, MAX_STRING)}… (${value.length} chars)`;
  }
  if (Array.isArray(value)) return value.map(summarize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = summarize(v);
    return out;
  }
  return value;
}

/** JSON-ish rendering of a summarized detail, for display / markdown. */
export function formatDetail(detail) {
  return JSON.stringify(detail, (key, value) => {
    if (value && value.__typed) {
      const more = value.length > value.head.length ? `, … (${value.length} values)` : '';
      return `${value.__typed}[${value.head.join(', ')}${more}]`;
    }
    return value;
  }, 2);
}
