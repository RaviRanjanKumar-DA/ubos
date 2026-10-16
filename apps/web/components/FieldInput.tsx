'use client';

import type { Field } from '@/lib/workspace';

/** Renders the right input for a custom lead field. */
export function FieldInput({ field, value, onChange }: { field: Field; value: unknown; onChange: (v: unknown) => void }) {
  const common = { className: 'input', id: `f_${field.key}`, required: field.required };
  switch (field.type) {
    case 'textarea':
      return <textarea {...common} style={{ height: 70, paddingTop: 8 }} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
    case 'number':
    case 'currency':
      return <input {...common} type="number" step={field.type === 'currency' ? '0.01' : 'any'} min={field.type === 'currency' ? 0 : undefined} value={value === undefined || value === null ? '' : String(value)} onChange={(e) => onChange(e.target.value)} />;
    case 'date':
      return <input {...common} type="date" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
    case 'dropdown':
      return (
        <select {...common} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {field.options.map((o) => <option key={o}>{o}</option>)}
        </select>
      );
    case 'multiselect': {
      const list = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="row" style={{ gap: 6 }}>
          {field.options.map((o) => (
            <label key={o} className={`badge ${list.includes(o) ? '' : 'grey'}`} style={{ cursor: 'pointer' }}>
              <input type="checkbox" style={{ margin: 0 }} checked={list.includes(o)} onChange={() => onChange(list.includes(o) ? list.filter((x) => x !== o) : [...list, o])} />
              {o}
            </label>
          ))}
        </div>
      );
    }
    case 'checkbox':
      return (
        <label className="row small">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} /> Yes
        </label>
      );
    case 'email':
      return <input {...common} type="email" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
    case 'phone':
      return <input {...common} type="tel" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <input {...common} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
  }
}
