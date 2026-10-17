'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Field, Option, Pipeline, Stage, STAGE_PALETTE } from '@/lib/workspace';

type Act = (fn: () => Promise<unknown>, text: string) => Promise<boolean>;

/**
 * Stage board for one pipeline: Initial (first stage, where new leads start) → Active (drag to reorder) →
 * Closed (Won / Lost). Each stage has a colour and optional rules: SLA days, required fields, auto status, auto follow-up.
 */
export function StageBoard({ pipeline, fields, statuses, lostReasons, readOnly, act, canDelete, onEditLostReasons }: {
  pipeline: Pipeline; fields: Field[]; statuses: Option[]; lostReasons: Option[]; readOnly: boolean; act: Act; canDelete: boolean;
  onEditLostReasons: () => void;
}) {
  const [stages, setStages] = useState<Stage[]>(pipeline.stages);
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  useEffect(() => { setStages(pipeline.stages); setDirty(false); }, [pipeline]);

  const update = (next: Stage[]) => { setStages(next); setDirty(true); };
  const initial = stages.findIndex((s) => !s.isWon && !s.isLost);
  const idx = (pred: (s: Stage, i: number) => boolean) => stages.map((s, i) => [s, i] as const).filter(([s, i]) => pred(s, i)).map(([, i]) => i);
  const active = idx((s, i) => !s.isWon && !s.isLost && i !== initial);
  const won = idx((s) => s.isWon);
  const lost = idx((s) => s.isLost);
  const colorOf = (s: Stage, i: number) => s.color ?? (s.isWon ? '#cdeed8' : s.isLost ? '#f6d0cb' : STAGE_PALETTE[i % 8]);

  /** Keeps the saved order: initial, active…, won…, lost… */
  const normalized = (list: Stage[]) => {
    const first = list.findIndex((s) => !s.isWon && !s.isLost);
    return [list[first], ...list.filter((s, i) => i !== first && !s.isWon && !s.isLost), ...list.filter((s) => s.isWon), ...list.filter((s) => s.isLost)].filter(Boolean);
  };
  const add = (kind: 'open' | 'won' | 'lost') => {
    const name = prompt(kind === 'open' ? 'Name of the new stage, e.g. Pitched Elite' : kind === 'won' ? 'Name of the won stage, e.g. Lead Closed' : 'Name of the lost stage, e.g. Not Eligible');
    if (!name?.trim()) return;
    update(normalized([...stages, { name: name.trim(), isWon: kind === 'won', isLost: kind === 'lost', color: STAGE_PALETTE[stages.length % 8] }]));
  };
  const drop = (to: number) => {
    if (dragFrom === null || dragFrom === to) return;
    const next = [...stages];
    const [m] = next.splice(dragFrom, 1);
    next.splice(to, 0, m);
    update(normalized(next));
    setDragFrom(null);
  };
  const remove = (i: number) => update(stages.filter((_, j) => j !== i));

  const chip = (i: number, draggable = false) => {
    const s = stages[i];
    const rules = [s.slaDays ? `SLA ${s.slaDays}d` : '', s.requiredFieldKeys?.length ? `${s.requiredFieldKeys.length} required` : '', s.setStatus ? `→ ${statuses.find((x) => x.value === s.setStatus)?.label ?? s.setStatus}` : '', s.followUpDays ? `follow-up +${s.followUpDays}d` : ''].filter(Boolean);
    return (
      <div key={s.id ?? `n-${i}`} className="stage-chip" style={{ background: colorOf(s, i) }}
        draggable={draggable && !readOnly} onDragStart={() => setDragFrom(i)} onDragOver={(e) => draggable && e.preventDefault()} onDrop={() => draggable && drop(i)}>
        {draggable && !readOnly && <span className="grip" aria-hidden="true">⠿</span>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>{s.name}</b> {i === initial && <span className="badge" style={{ fontStyle: 'italic' }}>Default</span>}
          <div className="small" style={{ opacity: 0.75 }}>{s.leadCount ?? 0} leads{rules.length ? ` · ${rules.join(' · ')}` : ''}</div>
        </div>
        {!readOnly && (
          <>
            <button type="button" className="btn sm ghost" aria-label={`Edit ${s.name}`} onClick={() => setEditing(i)}>✎</button>
            {i !== initial && <button type="button" className="btn sm ghost" aria-label={`Delete ${s.name}`} disabled={!!s.leadCount} title={s.leadCount ? 'Move its leads first' : undefined} onClick={() => remove(i)}>🗑</button>}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <h2 style={{ margin: 0 }}>{pipeline.name} pipeline</h2>
          <div className="small muted">Drag active stages to reorder. New leads always start in the initial stage.</div>
        </div>
        {!readOnly && (
          <div className="row" style={{ gap: 4 }}>
            <button className="btn sm ghost" onClick={() => {
              const name = prompt('Rename pipeline', pipeline.name);
              if (name) act(() => api(`/api/v1/pipelines/${pipeline.id}`, { method: 'PATCH', body: { name } }), 'Pipeline renamed.');
            }}>Rename</button>
            {canDelete && <button className="btn sm ghost" onClick={() => confirm(`Delete the ${pipeline.name} pipeline?`) && act(() => api(`/api/v1/pipelines/${pipeline.id}`, { method: 'DELETE' }), 'Pipeline deleted.')}>Delete</button>}
          </div>
        )}
      </div>

      <div className="stage-board">
        <div className="stage-col">
          <div className="stage-col-head">Initial stage</div>
          {initial >= 0 && chip(initial)}
        </div>
        <div className="stage-col">
          <div className="stage-col-head active">Active stages</div>
          {!readOnly && <button type="button" className="btn sm outline" style={{ width: '100%', justifyContent: 'center', marginBottom: 6 }} onClick={() => add('open')}>+ Add</button>}
          {active.map((i) => chip(i, true))}
          {!active.length && <div className="small muted">No active stages yet.</div>}
        </div>
        <div className="stage-col">
          <div className="stage-col-head closed">Closed stages</div>
          <div className="stage-group won">
            <div className="row" style={{ justifyContent: 'space-between' }}><b>Won</b>{!readOnly && <button type="button" className="btn sm ghost" onClick={() => add('won')}>+ Add</button>}</div>
            {won.map((i) => chip(i))}
          </div>
          <div className="stage-group lost">
            <div className="row" style={{ justifyContent: 'space-between' }}><b>Lost</b>{!readOnly && <button type="button" className="btn sm ghost" onClick={() => add('lost')}>+ Add</button>}</div>
            {lost.map((i) => chip(i))}
            <div className="row small" style={{ justifyContent: 'space-between', marginTop: 8 }}>
              <span className="muted">Reasons for lost leads ({lostReasons.length})</span>
              <a href="#" onClick={(e) => { e.preventDefault(); onEditLostReasons(); }}>Edit</a>
            </div>
            <div className="small" style={{ lineHeight: 1.7 }}>{lostReasons.map((r) => r.label).join(' · ')}</div>
          </div>
        </div>
      </div>

      {!readOnly && dirty && (
        <div className="row end" style={{ marginTop: 12 }}>
          <button type="button" className="btn ghost" onClick={() => { setStages(pipeline.stages); setDirty(false); }}>Undo</button>
          <button type="button" className="btn" onClick={() => act(() => api(`/api/v1/pipelines/${pipeline.id}/stages`, {
            method: 'PUT',
            body: { stages: stages.map((s, i) => ({ id: s.id, name: s.name, isWon: s.isWon, isLost: s.isLost, color: colorOf(s, i), slaDays: s.slaDays ?? null, requiredFieldKeys: s.requiredFieldKeys ?? [], setStatus: s.setStatus ?? null, followUpDays: s.followUpDays ?? null })) },
          }), 'Stages saved.')}>Save stages</button>
        </div>
      )}

      {editing !== null && stages[editing] && (
        <StageDialog stage={stages[editing]} fields={fields} statuses={statuses} isInitial={editing === initial}
          onClose={() => setEditing(null)}
          onSave={(s) => { update(stages.map((x, j) => (j === editing ? s : x))); setEditing(null); }} />
      )}
    </div>
  );
}

function StageDialog({ stage, fields, statuses, isInitial, onClose, onSave }: {
  stage: Stage; fields: Field[]; statuses: Option[]; isInitial: boolean; onClose: () => void; onSave: (s: Stage) => void;
}) {
  const [s, setS] = useState<Stage>({ ...stage, requiredFieldKeys: stage.requiredFieldKeys ?? [] });
  const closed = s.isWon || s.isLost;
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onSave(s); }}>
        <h2>Edit stage</h2>
        <div className="field"><label>Name</label><input className="input" value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} required /></div>
        <div className="field">
          <label>Colour</label>
          <div className="row" style={{ gap: 6 }}>
            {STAGE_PALETTE.map((c) => (
              <button key={c} type="button" aria-label={`Colour ${c}`} onClick={() => setS({ ...s, color: c })}
                style={{ width: 28, height: 28, borderRadius: 8, background: c, border: s.color === c ? '2px solid var(--brand)' : '1px solid var(--line)', cursor: 'pointer' }} />
            ))}
          </div>
        </div>
        {!closed && (
          <>
            <div className="grid cols-2">
              <div className="field"><label>Warn after (days in stage)</label><input className="input" type="number" min={1} value={s.slaDays ?? ''} onChange={(e) => setS({ ...s, slaDays: e.target.value ? Number(e.target.value) : null })} placeholder="No limit" /></div>
              <div className="field"><label>Auto follow-up after (days)</label><input className="input" type="number" min={0} value={s.followUpDays ?? ''} onChange={(e) => setS({ ...s, followUpDays: e.target.value ? Number(e.target.value) : null })} placeholder="None" /></div>
            </div>
            <div className="field">
              <label>Set lead status automatically</label>
              <select className="input" value={s.setStatus ?? ''} onChange={(e) => setS({ ...s, setStatus: e.target.value || null })}>
                <option value="">Do not change</option>
                {statuses.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
              </select>
            </div>
          </>
        )}
        {!isInitial && fields.length > 0 && (
          <div className="field">
            <label>Fields that must be filled before entering this stage</label>
            <div className="chips">
              {fields.filter((f) => !f.isArchived).map((f) => {
                const on = s.requiredFieldKeys!.includes(f.key);
                return <button type="button" key={f.key} className={`chip ${on ? 'on' : ''}`} onClick={() => setS({ ...s, requiredFieldKeys: on ? s.requiredFieldKeys!.filter((k) => k !== f.key) : [...s.requiredFieldKeys!, f.key] })}>{f.label}</button>;
              })}
            </div>
          </div>
        )}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn">Done</button>
        </div>
      </form>
    </div>
  );
}
