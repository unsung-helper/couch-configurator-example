import React, { useEffect, useMemo, useState } from 'react';
import { KINDS, GENERAL_FUNCTIONS, GENERAL_EVENTS } from '../instructions/apiCatalog';
import { formatDetail, headerOf } from '../instructions/useApiInstructions';
import { USES_ASSEMBLY_NODES } from '../instructions/productFeatures';

/**
 * Modal with developer instructions for driving this product's unsung.js
 * module. The general part is fixed; the parameter/output part is generated
 * from what the loaded product actually announced (see useApiInstructions),
 * with real IDs, the call to make, every event with each detail key
 * explained, and the last payload received.
 *
 * "Copy as Markdown" puts the same content on the clipboard, e.g. to hand
 * to whoever integrates the product.
 */
export default function InstructionsModal({ entries, hasRun, onClose }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const parameters = entries.filter(e => KINDS[e.kind].group === 'parameter');
  const outputs = entries.filter(e => KINDS[e.kind].group === 'output');
  const markdown = useMemo(() => toMarkdown(parameters, outputs, hasRun), [entries, hasRun]); // eslint-disable-line react-hooks/exhaustive-deps

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (non-secure context); fall back to a download.
      const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
      const a = document.createElement('a'); a.href = url; a.download = 'unsung-api.md'; a.click();
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div style={styles.backdrop} onMouseDown={onClose}>
      <div style={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="api-title"
        onMouseDown={e => e.stopPropagation()}>
        <div style={styles.header}>
          <h2 id="api-title" style={{ margin: 0, fontSize: 16 }}>Using this product's unsung.js API</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={styles.button} onClick={copy}>{copied ? 'Copied ✓' : 'Copy as Markdown'}</button>
            <button style={styles.button} onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>

        <div style={styles.body}>
          <p style={styles.intro}>
            <code>unsung.js</code> exposes a global <code>Module</code>. You call functions on it, and the
            engine reports back with <code>CustomEvent</code>s on <code>document</code>. Read the payload
            from <code>event.detail</code>:
          </p>
          <pre style={styles.code}>{`document.addEventListener('numberParameterChanged', (event) => {
  const { id, value } = event.detail;
});`}</pre>
          <p style={styles.intro}>
            Register listeners <em>before</em> calling <code>Module.load()</code>, or you will miss the
            initial <code>…Added</code> events. Boolean detail fields arrive as <code>0</code>/<code>1</code>.
            This guide is generated from the product as loaded here, so it lists the real IDs.
          </p>
          <p style={styles.intro}>
            {NOT_YET_RUN_NOTE_INTRO}
          </p>
          {!hasRun && <p style={styles.notice}>{NOT_YET_RUN_NOTE}</p>}
          {USES_ASSEMBLY_NODES && (
            <p style={styles.warning} role="alert"><strong>⚠ {INCOMPLETE_TITLE}</strong> {INCOMPLETE_NOTE}</p>
          )}

          <Section title={`Parameters (${parameters.length})`}>
            {parameters.length === 0
              ? <p style={styles.muted}>This product has no parameters.</p>
              : parameters.map(e => <EntryCard key={`${e.kind}:${e.id}`} entry={e} />)}
          </Section>

          <Section title={`Outputs (${outputs.length})`}>
            {outputs.length === 0
              ? <p style={styles.muted}>This product has no outputs (yet).</p>
              : outputs.map(e => <EntryCard key={`${e.kind}:${e.id}`} entry={e} />)}
          </Section>

          <Section title="Module functions">
            {GENERAL_FUNCTIONS.map(f => (
              <div key={f.sig} style={{ marginBottom: 10 }}>
                <code style={styles.sig}>Module.{f.sig}</code>
                <div style={styles.text}>{f.doc}</div>
              </div>
            ))}
          </Section>

          <Section title="Lifecycle & status events">
            {GENERAL_EVENTS.map(evt => <EventDoc key={evt.name} evt={evt} />)}
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section style={{ marginTop: 22 }}>
      <h3 style={styles.sectionTitle}>{title}</h3>
      {children}
    </section>
  );
}

function EntryCard({ entry }) {
  const kind = KINDS[entry.kind];
  const header = headerOf(entry);
  const name = header?.name?.trim();

  return (
    <details style={styles.card}>
      <summary style={styles.summary}>
        <span style={styles.badge}>{kind.label}</span>
        <strong>{name || entry.id}</strong>
        <code style={{ color: '#666', fontSize: 12 }}>id: {entry.id}</code>
      </summary>

      <div style={{ padding: '4px 12px 12px' }}>
        <dl style={styles.facts}>
          <dt>ID</dt><dd><code>{entry.id}</code></dd>
          {header?.externalID ? <><dt>External ID</dt><dd><code>{header.externalID}</code></dd></> : null}
          {header?.description ? <><dt>Description</dt><dd>{header.description}</dd></> : null}
        </dl>
        <p style={styles.text}>{kind.summary}</p>

        <div style={styles.label}>{kind.group === 'parameter' ? 'Set it' : 'Use it'}</div>
        <pre style={styles.code}>{kind.usage(entry.id, header)}</pre>

        <div style={styles.label}>Events (filter on <code>event.detail.id === {JSON.stringify(entry.id)}</code>)</div>
        {kind.events.map(evt => (
          <EventDoc key={evt.name} evt={evt} example={entry.details[evt.name]} />
        ))}
      </div>
    </details>
  );
}

function EventDoc({ evt, example }) {
  const keys = Object.entries(evt.fields);
  return (
    <div style={{ margin: '10px 0 14px' }}>
      <code style={styles.sig}>{evt.name}</code>
      <span style={{ ...styles.text, marginLeft: 8 }}>{evt.when}</span>
      {evt.sameAs ? (
        <div style={{ ...styles.text, fontSize: 12.5, marginTop: 2 }}>
          Same detail keys as <code>{evt.sameAs}</code>.
        </div>
      ) : keys.length > 0 && (
        <table style={styles.table}>
          <tbody>
            {keys.map(([k, doc]) => (
              <tr key={k}>
                <td style={styles.keyCell}><code>{k}</code></td>
                <td style={styles.docCell}>{doc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {example && (
        <details style={{ marginTop: 4 }}>
          <summary style={{ fontSize: 12, color: '#666', cursor: 'pointer' }}>Last payload received</summary>
          <pre style={styles.code}>{formatDetail(example)}</pre>
        </details>
      )}
    </div>
  );
}

const NOT_YET_RUN_NOTE_INTRO = 'Names, descriptions, external IDs and visibility are computed by the product, so they are only known after it has run: Module.execute() after productLoaded sends them as …Changed events. Handle …Added and …Changed with the same code.';
const INCOMPLETE_TITLE = 'Not all parameters and outputs are listed here.';
const INCOMPLETE_NOTE = 'This product uses assembly nodes, which add and remove parameters and outputs at run time, based on user input. The lists below only show what exists right now, and their IDs are not known in advance. Your integration has to handle …Added and …Removed events at any moment, not just during load().';
const NOT_YET_RUN_NOTE = 'The product has not finished a run yet, so the names, descriptions and external IDs below may still be placeholders.';

// ── Markdown export ──────────────────────────────────────────────────────────

function toMarkdown(parameters, outputs, hasRun) {
  const lines = [];
  const eventMd = (evt, example) => {
    lines.push(`- \`${evt.name}\`: ${evt.when}`);
    if (evt.sameAs) lines.push(`  - Same detail keys as \`${evt.sameAs}\`.`);
    else for (const [k, doc] of Object.entries(evt.fields)) lines.push(`  - \`${k}\`: ${doc}`);
    if (example) {
      lines.push('', '  Last payload received:', '', '  ```json');
      formatDetail(example).split('\n').forEach(l => lines.push(`  ${l}`));
      lines.push('  ```', '');
    }
  };
  const entryMd = (entry) => {
    const kind = KINDS[entry.kind];
    const header = headerOf(entry);
    lines.push(`### ${header?.name?.trim() || entry.id} (${kind.label})`, '');
    lines.push(`- ID: \`${entry.id}\``);
    if (header?.externalID) lines.push(`- External ID: \`${header.externalID}\``);
    if (header?.description) lines.push(`- Description: ${header.description}`);
    lines.push('', kind.summary, '', '```js', kind.usage(entry.id, header), '```', '');
    lines.push(`Events (filter on \`event.detail.id === ${JSON.stringify(entry.id)}\`):`, '');
    kind.events.forEach(evt => eventMd(evt, entry.details[evt.name]));
    lines.push('');
  };

  lines.push('# unsung.js API for this product', '');
  lines.push('`unsung.js` exposes a global `Module`. You call functions on it, and the engine reports back with `CustomEvent`s on `document` (payload in `event.detail`). Register listeners before calling `Module.load()`. Boolean detail fields arrive as 0/1.', '');
  lines.push(NOT_YET_RUN_NOTE_INTRO, '');
  if (!hasRun) lines.push(`> ${NOT_YET_RUN_NOTE}`, '');
  if (USES_ASSEMBLY_NODES) lines.push(`> **⚠ ${INCOMPLETE_TITLE}** ${INCOMPLETE_NOTE}`, '');
  lines.push('## Parameters', '');
  if (parameters.length === 0) lines.push('_None._', '');
  parameters.forEach(entryMd);
  lines.push('## Outputs', '');
  if (outputs.length === 0) lines.push('_None._', '');
  outputs.forEach(entryMd);
  lines.push('## Module functions', '');
  GENERAL_FUNCTIONS.forEach(f => lines.push(`- \`Module.${f.sig}\`: ${f.doc}`));
  lines.push('', '## Lifecycle & status events', '');
  GENERAL_EVENTS.forEach(evt => eventMd(evt));
  return lines.join('\n');
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  backdrop: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 100,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
  },
  dialog: {
    background: '#fff', color: '#222', borderRadius: 8, width: 'min(860px, 100%)',
    maxHeight: '100%', display: 'flex', flexDirection: 'column',
    boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    padding: '12px 16px', borderBottom: '1px solid #e5e5e5', flexShrink: 0,
  },
  body: { padding: '4px 18px 20px', overflowY: 'auto', fontSize: 13, lineHeight: 1.5 },
  button: {
    padding: '5px 10px', borderRadius: 4, border: '1px solid #ccc', background: '#f6f6f6',
    cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', color: '#222',
  },
  intro: { margin: '12px 0 6px' },
  muted: { color: '#999', fontSize: 12 },
  notice: { margin: '6px 0', padding: '8px 10px', background: '#fff6e0', border: '1px solid #f0d080', borderRadius: 4, fontSize: 13 },
  warning: { margin: '8px 0', padding: '10px 12px', background: '#fdecea', border: '1px solid #e0776c', borderRadius: 4, fontSize: 13, color: '#7a1f16' },
  text: { fontSize: 13, color: '#444' },
  sectionTitle: { fontSize: 14, margin: '0 0 8px', paddingBottom: 4, borderBottom: '1px solid #eee' },
  card: { border: '1px solid #e2e2e2', borderRadius: 6, marginBottom: 8, background: '#fcfcfc' },
  summary: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', cursor: 'pointer', flexWrap: 'wrap' },
  badge: {
    fontSize: 11, padding: '1px 7px', borderRadius: 10, background: '#eef3f2', color: '#2d6f66',
    border: '1px solid #d3e4e1',
  },
  facts: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 12px', margin: '6px 0' },
  label: { fontSize: 12, fontWeight: 600, color: '#555', margin: '10px 0 4px' },
  sig: { fontSize: 12.5, fontWeight: 600, color: '#1f4f8a' },
  code: {
    background: '#f4f4f4', border: '1px solid #e6e6e6', borderRadius: 4, padding: '8px 10px',
    fontSize: 12, overflowX: 'auto', margin: '4px 0', whiteSpace: 'pre',
  },
  table: { borderCollapse: 'collapse', width: '100%', marginTop: 4 },
  keyCell: { verticalAlign: 'top', padding: '3px 10px 3px 0', whiteSpace: 'nowrap', fontSize: 12, borderTop: '1px solid #f0f0f0' },
  docCell: { verticalAlign: 'top', padding: '3px 0', fontSize: 12.5, color: '#444', borderTop: '1px solid #f0f0f0' },
};
