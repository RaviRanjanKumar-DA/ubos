'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { API_URL } from '@/lib/api';

interface PubField { name: string; label: string; required: boolean; placeholder: string; type: string; options: string[] }
interface PubForm { organization: string; title: string; description: string | null; fields: PubField[]; submitLabel: string; color: string }

/** Public hosted form (no sign-in). ?embed=1 hides the page frame for iframes. */
function HostedForm() {
  const { org, form } = useParams<{ org: string; form: string }>();
  const params = useSearchParams();
  const embed = params.get('embed') === '1';
  const [def, setDef] = useState<PubForm | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [state, setState] = useState<{ kind: 'idle' | 'sending' | 'done' | 'error'; text?: string }>({ kind: 'idle' });
  const url = `${API_URL}/public/forms/${encodeURIComponent(org)}/${encodeURIComponent(form)}`;
  useEffect(() => {
    fetch(url).then(async (r) => (r.ok ? setDef(await r.json()) : setState({ kind: 'error', text: 'This form is not available.' }))).catch(() => setState({ kind: 'error', text: 'This form could not be loaded.' }));
  }, [url]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState({ kind: 'sending' });
    const utm = Object.fromEntries(['utm_source', 'utm_medium', 'utm_campaign'].map((k) => [k, params.get(k)]).filter(([, v]) => v));
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...values, ...utm }) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) return setState({ kind: 'error', text: b.message ?? 'Please check your answers and try again.' });
      if (b.redirectUrl) { (window.top ?? window).location.href = b.redirectUrl; return; }
      setState({ kind: 'done', text: b.message });
    } catch { setState({ kind: 'error', text: 'Could not send. Please try again.' }); }
  }

  const color = def?.color ?? '#5b3cc4';
  return (
    <div className={embed ? 'pub-wrap embed' : 'pub-wrap'}>
      <div className="pub-form" style={{ borderTop: `4px solid ${color}` }}>
        {!def && state.kind !== 'error' && <div className="muted">Loading…</div>}
        {!def && state.kind === 'error' && <div className="error">{state.text}</div>}
        {def && state.kind === 'done' && <div style={{ textAlign: 'center', padding: '24px 0' }}><div style={{ fontSize: 40, color }}>✓</div><h2>{state.text}</h2></div>}
        {def && state.kind !== 'done' && (
          <form onSubmit={submit}>
            <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>{def.title}</h1>
            {def.description && <p className="muted" style={{ marginTop: 0 }}>{def.description}</p>}
            {def.fields.map((f) => (
              <div key={f.name} className="field">
                <label htmlFor={f.name}>{f.label}{f.required && ' *'}</label>
                {f.type === 'textarea' ? <textarea id={f.name} className="input" style={{ height: 80, paddingTop: 8 }} required={f.required} placeholder={f.placeholder} value={String(values[f.name] ?? '')} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
                  : f.type === 'dropdown' ? <select id={f.name} className="input" required={f.required} value={String(values[f.name] ?? '')} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}><option value="">Choose…</option>{f.options.map((o) => <option key={o}>{o}</option>)}</select>
                  : f.type === 'checkbox' ? <label className="row small"><input id={f.name} type="checkbox" checked={values[f.name] === true} onChange={(e) => setValues({ ...values, [f.name]: e.target.checked })} /> Yes</label>
                  : <input id={f.name} className="input" required={f.required} placeholder={f.placeholder}
                      type={f.type === 'phone' ? 'tel' : f.type === 'email' ? 'email' : f.type === 'number' || f.type === 'currency' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                      autoComplete={f.name === 'name' ? 'name' : f.name === 'mobile' ? 'tel' : f.name === 'email' ? 'email' : f.name === 'city' ? 'address-level2' : undefined}
                      value={String(values[f.name] ?? '')} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />}
              </div>
            ))}
            {/* Honeypot: hidden from people, bots fill it */}
            <input type="text" name="_hp" tabIndex={-1} autoComplete="off" aria-hidden="true" style={{ position: 'absolute', left: '-9999px' }} onChange={(e) => setValues({ ...values, _hp: e.target.value })} />
            {state.kind === 'error' && <div className="error">{state.text}</div>}
            <button className="btn" style={{ width: '100%', background: color, borderColor: color }} disabled={state.kind === 'sending'}>{state.kind === 'sending' ? 'Sending…' : def.submitLabel}</button>
            <p className="small muted" style={{ textAlign: 'center', marginBottom: 0 }}>{def.organization} · your details are used only to contact you about this enquiry.</p>
          </form>
        )}
      </div>
    </div>
  );
}

export default function HostedFormPage() {
  return <Suspense fallback={null}><HostedForm /></Suspense>;
}
