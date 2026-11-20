'use client';

import { useState } from 'react';
import { TYPES, type Draft, type Meta } from './hr';

/** Add or edit the work and personal details of an employee. */
export function EmployeeForm({ title, initial, meta, linkable, personal, onSave, onClose }: { title: string; initial: Draft; meta: Meta; linkable: { id: string; name: string; email: string }[] | null; personal: boolean; onSave: (d: Draft) => Promise<string | null>; onClose: () => void }) {
  const [d, setD] = useState(initial);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const f = (k: keyof Draft, label: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="field"><label htmlFor={`ef-${k}`}>{label}</label><input id={`ef-${k}`} className="input" value={d[k]} onChange={(e) => setD({ ...d, [k]: e.target.value })} {...extra} /></div>
  );
  return (
    <div className="modal-bg">
      <form className="modal hr-modal" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr((await onSave(d)) ?? ''); setBusy(false); }}>
        <h2>{title}</h2>
        {err && <div className="error">{err}</div>}
        <div className="grid cols-2">
          {f('name', 'Full name', { required: true, minLength: 2, maxLength: 120 })}
          {f('designation', 'Designation (optional)', { maxLength: 80 })}
          {f('mobile', 'Mobile (optional)', { inputMode: 'tel' })}
          {f('workEmail', 'Work email (optional)', { type: 'email' })}
          <div className="field"><label htmlFor="ef-dep">Department</label><select id="ef-dep" className="input" value={d.departmentId} onChange={(e) => setD({ ...d, departmentId: e.target.value })}><option value="">None</option>{meta.departments.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
          <div className="field"><label htmlFor="ef-type">Employment</label><select id="ef-type" className="input" value={d.employmentType} onChange={(e) => setD({ ...d, employmentType: e.target.value })}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          {f('joiningOn', 'Joining date', { type: 'date', required: true })}
          {f('probationEndOn', 'Probation ends (optional)', { type: 'date' })}
          {f('workLocation', 'Work location (optional)', { maxLength: 80 })}
          {f('noticeDays', 'Notice period (days)', { type: 'number', min: 0, max: 180 })}
          {linkable && <div className="field"><label htmlFor="ef-user">UBOS login (optional)</label><select id="ef-user" className="input" value={d.userId} onChange={(e) => setD({ ...d, userId: e.target.value })}><option value="">No login</option>{linkable.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}</select></div>}
        </div>
        {personal && (
          <>
            <h3 className="hr-sub">Personal</h3>
            <div className="grid cols-2">
              {f('dateOfBirthOn', 'Date of birth (optional)', { type: 'date' })}
              {f('personalEmail', 'Personal email (optional)', { type: 'email' })}
              {f('emergencyName', 'Emergency contact (optional)', { maxLength: 120 })}
              {f('emergencyPhone', 'Emergency phone (optional)', { inputMode: 'tel' })}
            </div>
            <div className="field"><label htmlFor="ef-addr">Address (optional)</label><textarea id="ef-addr" className="input" style={{ height: 60, paddingTop: 8 }} maxLength={500} value={d.address} onChange={(e) => setD({ ...d, address: e.target.value })} /></div>
          </>
        )}
        <div className="row end"><button type="button" className="btn ghost" onClick={onClose}>Go back</button><button className="btn" disabled={busy}>Save</button></div>
      </form>
    </div>
  );
}
