'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, API_URL } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { Icon } from '@/components/Icon';
import { Menu } from '@/components/Menu';
import { PickWorkspace } from '@/components/PickWorkspace';

interface Step { id: string; type: 'message' | 'buttons' | 'question' | 'handoff'; text: string; next?: string; saveTo?: string; options?: { label: string; next?: string }[] }
interface Flow { id: string; name: string; channel: string; trigger: string; keywords: string[]; steps: Step[]; isActive: boolean; runs: number }
interface Widget { id: string; name: string; publicKey: string; greeting: string; color: string; isActive: boolean }
type Draft = { id: string | null; name: string; channel: string; trigger: string; keywords: string; steps: Step[] };

const KINDS: [Step['type'], string][] = [['message', 'Send a message'], ['buttons', 'Ask with buttons'], ['question', 'Ask a question'], ['handoff', 'Hand to a person']];
const newId = (steps: Step[]) => { let n = steps.length + 1; while (steps.some((s) => s.id === `s${n}`)) n++; return `s${n}`; };

export default function ChatbotPage() {
  const { me, version } = useShell();
  const ws = me.currentWorkspaceId;
  const [tab, setTab] = useState<'flows' | 'web'>('flows');
  const [flows, setFlows] = useState<Flow[]>([]);
  const [fields, setFields] = useState<{ key: string; label: string }[]>([]);
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [wf, setWf] = useState<{ id: string | null; name: string; greeting: string; color: string } | null>(null);
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const load = useCallback(async () => {
    if (!ws) return;
    try {
      const [a, b] = await Promise.all([api<{ flows: Flow[]; fields: { key: string; label: string }[] }>('/api/v1/chat-flows'), api<Widget[]>('/api/v1/chat-widgets')]);
      setFlows(a.flows); setFields(a.fields); setWidgets(b);
    } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); }
  }, [ws]);
  useEffect(() => { load(); }, [load, version]);
  if (!ws) return <><div className="page-head"><h1>Chatbot &amp; web chat</h1></div><PickWorkspace text="Chatbots and website chat belong to a business line." /></>;

  const act = async (fn: () => Promise<unknown>, text: string) => { setMsg(null); try { await fn(); setMsg({ type: 'notice', text }); await load(); return true; } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError ? e.message : 'Failed' }); return false; } };
  const blank = (): Draft => ({ id: null, name: '', channel: 'whatsapp', trigger: 'first_message', keywords: '', steps: [{ id: 's1', type: 'buttons', text: 'Hello! How can we help you today?', options: [{ label: 'Talk to sales' }, { label: 'Get a call back' }] }] });
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    const { id, keywords, ...d } = draft;
    const steps = d.steps.map((s) => ({ id: s.id, type: s.type, text: s.text, ...(s.next ? { next: s.next } : {}), ...(s.saveTo ? { saveTo: s.saveTo } : {}), ...(s.type === 'buttons' ? { options: (s.options ?? []).map((o) => ({ label: o.label, ...(o.next ? { next: o.next } : {}) })) } : {}) }));
    const body = { ...d, steps, keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean) };
    if (await act(() => (id ? api(`/api/v1/chat-flows/${id}`, { method: 'PATCH', body }) : api('/api/v1/chat-flows', { method: 'POST', body })), 'Flow saved.')) setDraft(null);
  }
  const step = (i: number, p: Partial<Step>) => draft && setDraft({ ...draft, steps: draft.steps.map((s, j) => (j === i ? { ...s, ...p } : s)) });
  const opt = (i: number, k: number, p: { label?: string; next?: string }) => { if (!draft) return; const o = [...(draft.steps[i].options ?? [])]; o[k] = { ...o[k], ...p }; step(i, { options: o }); };
  const nextPick = (value: string | undefined, onChange: (v: string | undefined) => void, self: string, aria: string) => (
    <select className="input" aria-label={aria} value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">End here</option>
      {draft?.steps.filter((s) => s.id !== self).map((s) => <option key={s.id} value={s.id}>{s.text.slice(0, 34) || s.id}</option>)}
    </select>
  );
  const widgetSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wf) return;
    const { id, ...body } = wf;
    if (await act(() => (id ? api(`/api/v1/chat-widgets/${id}`, { method: 'PATCH', body }) : api('/api/v1/chat-widgets', { method: 'POST', body })), 'Chat button saved.')) setWf(null);
  };
  const snippet = (w: Widget) => `<script src="${API_URL}/public/chat/${me.tenant.slug}/${w.publicKey}/widget.js" async></script>`;

  return (
    <>
      <div className="page-head">
        <div><h1>Chatbot &amp; web chat</h1><div className="muted small">Answer customers automatically, then pass them to your team. When a person replies, the bot steps aside.</div></div>
        {tab === 'flows' ? <button className="btn" onClick={() => setDraft(blank())}><Icon name="plus" className="ic" />New flow</button> : <button className="btn" onClick={() => setWf({ id: null, name: '', greeting: 'Hi! Tell us a little about yourself and we will reply here.', color: '#4a2bc2' })}><Icon name="plus" className="ic" />New chat button</button>}
      </div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      <div className="dash-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'flows'} className={`dash-tab${tab === 'flows' ? ' on' : ''}`} onClick={() => setTab('flows')}>Flows</button>
        <button role="tab" aria-selected={tab === 'web'} className={`dash-tab${tab === 'web' ? ' on' : ''}`} onClick={() => setTab('web')}>Website chat</button>
      </div>

      {tab === 'flows' && (
        <>
          {!flows.length && <div className="card empty">No flows yet. Start with a greeting and a few buttons.</div>}
          {flows.map((f) => (
            <div key={f.id} className={`card rule-card${f.isActive ? '' : ' off'}`}>
              <div className="rule-main">
                <div className="row"><b>{f.name}</b><span className={`badge ${f.isActive ? 'ok' : 'grey'}`}>{f.isActive ? 'On' : 'Paused'}</span><span className="badge grey">{f.channel === 'whatsapp' ? 'WhatsApp' : 'Website'}</span></div>
                <div className="small">{f.trigger === 'keyword' ? `When a customer says: ${f.keywords.join(', ')}` : 'On a customer’s first message'} · {f.steps.length} {f.steps.length === 1 ? 'step' : 'steps'}</div>
                <div className="small muted">Started {f.runs} {f.runs === 1 ? 'time' : 'times'}</div>
              </div>
              <Menu sm items={[
                { label: 'Edit', icon: 'edit', onClick: () => setDraft({ id: f.id, name: f.name, channel: f.channel, trigger: f.trigger, keywords: f.keywords.join(', '), steps: f.steps }) },
                { label: f.isActive ? 'Pause' : 'Switch on', icon: 'radio', onClick: () => act(() => api(`/api/v1/chat-flows/${f.id}`, { method: 'PATCH', body: { isActive: !f.isActive } }), f.isActive ? 'Flow paused.' : 'Flow switched on.') },
                { label: 'Archive', icon: 'trash', onClick: () => act(() => api(`/api/v1/chat-flows/${f.id}`, { method: 'PATCH', body: { isArchived: true } }), 'Flow archived.') },
              ]} />
            </div>
          ))}
        </>
      )}

      {tab === 'web' && (
        <>
          {!widgets.length && <div className="card empty">No chat buttons yet. Create one and paste its code on your website.</div>}
          {widgets.map((w) => (
            <div key={w.id} className="card" style={{ marginBottom: 10 }}>
              <div className="org-head">
                <div className="row"><b>{w.name}</b><span className={`badge ${w.isActive ? 'ok' : 'grey'}`}>{w.isActive ? 'On' : 'Off'}</span></div>
                <Menu sm items={[
                  { label: 'Edit', icon: 'edit', onClick: () => setWf({ id: w.id, name: w.name, greeting: w.greeting, color: w.color }) },
                  { label: 'Preview', icon: 'play', onClick: () => window.open(`/chat/${me.tenant.slug}/${w.publicKey}`, '_blank', 'noopener') },
                  { label: w.isActive ? 'Turn off' : 'Turn on', icon: 'radio', onClick: () => act(() => api(`/api/v1/chat-widgets/${w.id}`, { method: 'PATCH', body: { isActive: !w.isActive } }), w.isActive ? 'Turned off.' : 'Turned on.') },
                  { label: 'Archive', icon: 'trash', onClick: () => act(() => api(`/api/v1/chat-widgets/${w.id}`, { method: 'PATCH', body: { isArchived: true } }), 'Archived.') },
                ]} />
              </div>
              <div className="small muted">Paste this before the end of your website&rsquo;s body tag. Replies appear in the Inbox.</div>
              <code className="snippet">{snippet(w)}</code>
            </div>
          ))}
        </>
      )}

      {draft && (
        <div className="modal-bg">
          <form className="modal flow-modal" onSubmit={save}>
            <div className="org-head"><h2 style={{ margin: 0 }}>{draft.id ? 'Edit flow' : 'New flow'}</h2><button type="button" className="btn sm ghost" aria-label="Close" onClick={() => setDraft(null)}><Icon name="close" className="ic" /></button></div>
            <div className="field"><label htmlFor="fn">Name</label><input id="fn" className="input" required minLength={2} maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
            <div className="book-nums">
              <div className="field"><label htmlFor="fc">Channel</label><select id="fc" className="input" value={draft.channel} onChange={(e) => setDraft({ ...draft, channel: e.target.value })}><option value="whatsapp">WhatsApp</option><option value="webchat">Website chat</option></select></div>
              <div className="field"><label htmlFor="ft">Starts</label><select id="ft" className="input" value={draft.trigger} onChange={(e) => setDraft({ ...draft, trigger: e.target.value })}><option value="first_message">On a customer&rsquo;s first message</option><option value="keyword">When a customer says a keyword</option></select></div>
            </div>
            {draft.trigger === 'keyword' && <div className="field"><label htmlFor="fk">Keywords, separated by commas</label><input id="fk" className="input" required placeholder="price, offer, menu" value={draft.keywords} onChange={(e) => setDraft({ ...draft, keywords: e.target.value })} /></div>}
            <div className="book-hours-title">Steps (the first one runs first)</div>
            {draft.steps.map((s, i) => (
              <div key={s.id} className="flow-step">
                <div className="flow-top">
                  <select className="input" aria-label="Step type" value={s.type} onChange={(e) => { const type = e.target.value as Step['type']; step(i, { type, options: type === 'buttons' ? s.options ?? [{ label: 'Yes' }] : undefined, saveTo: undefined }); }}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                  <span />
                  <button type="button" className="btn sm ghost" aria-label="Remove step" disabled={draft.steps.length === 1} onClick={() => { const gone = s.id; setDraft({ ...draft, steps: draft.steps.filter((x) => x.id !== gone).map((x) => ({ ...x, next: x.next === gone ? undefined : x.next, options: x.options?.map((o) => ({ ...o, next: o.next === gone ? undefined : o.next })) })) }); }}><Icon name="close" className="ic" /></button>
                </div>
                <textarea className="input" aria-label="Message text" required rows={2} maxLength={1024} value={s.text} onChange={(e) => step(i, { text: e.target.value })} />
                {s.type === 'buttons' && (
                  <div style={{ marginTop: 8 }}>
                    {s.options?.map((o, k) => (
                      <div key={k} className="flow-opt">
                        <input className="input" aria-label="Button label" required maxLength={20} placeholder="Button (20 letters)" value={o.label} onChange={(e) => opt(i, k, { label: e.target.value })} />
                        {nextPick(o.next, (v) => opt(i, k, { next: v }), s.id, 'Then go to')}
                        <button type="button" className="btn sm ghost" aria-label="Remove button" disabled={(s.options?.length ?? 0) === 1} onClick={() => step(i, { options: s.options?.filter((_, j) => j !== k) })}><Icon name="close" className="ic" /></button>
                      </div>
                    ))}
                    {(s.options?.length ?? 0) < 3 && <button type="button" className="btn sm ghost" onClick={() => step(i, { options: [...(s.options ?? []), { label: '' }] })}><Icon name="plus" className="ic" />Button</button>}
                  </div>
                )}
                {s.type !== 'handoff' && s.type !== 'buttons' && (
                  <div className="flow-next">
                    <div><label>Then go to</label>{nextPick(s.next, (v) => step(i, { next: v }), s.id, 'Then go to')}</div>
                    {s.type === 'question' && <div><label>Save the answer to</label><select className="input" aria-label="Save the answer to" value={s.saveTo ?? 'remark'} onChange={(e) => step(i, { saveTo: e.target.value })}><option value="remark">The lead&rsquo;s journey</option><option value="city">City</option><option value="email">Email</option>{fields.map((x) => <option key={x.key} value={`cf:${x.key}`}>{x.label}</option>)}</select></div>}
                  </div>
                )}
              </div>
            ))}
            <button type="button" className="btn sm outline" disabled={draft.steps.length >= 30} onClick={() => setDraft({ ...draft, steps: [...draft.steps, { id: newId(draft.steps), type: 'message', text: '' }] })}><Icon name="plus" className="ic" />Step</button>
            <div className="row end" style={{ marginTop: 16 }}><button type="button" className="btn ghost" onClick={() => setDraft(null)}>Go back</button><button className="btn">Save</button></div>
          </form>
        </div>
      )}

      {wf && (
        <div className="modal-bg">
          <form className="modal" onSubmit={widgetSave}>
            <h2>{wf.id ? 'Edit chat button' : 'New chat button'}</h2>
            <div className="field"><label htmlFor="wn">Name</label><input id="wn" className="input" required minLength={2} maxLength={80} placeholder="e.g. Main website" value={wf.name} onChange={(e) => setWf({ ...wf, name: e.target.value })} /></div>
            <div className="field"><label htmlFor="wg">Greeting</label><textarea id="wg" className="input" required rows={2} maxLength={300} value={wf.greeting} onChange={(e) => setWf({ ...wf, greeting: e.target.value })} /></div>
            <div className="field"><label htmlFor="wc">Colour</label><input id="wc" className="input" type="color" style={{ width: 70, padding: 4 }} value={wf.color} onChange={(e) => setWf({ ...wf, color: e.target.value })} /></div>
            <div className="row end"><button type="button" className="btn ghost" onClick={() => setWf(null)}>Go back</button><button className="btn">Save</button></div>
          </form>
        </div>
      )}
    </>
  );
}
