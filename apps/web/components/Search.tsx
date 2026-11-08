'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Icon } from './Icon';

export interface PageLink { href: string; label: string; icon: string }
interface Hit { href: string; label: string; icon: string; group: string; note?: string }
interface Found { id: string; name: string; code?: string | null; mobile?: string | null }

const SHOWN = 6;

/** Ctrl+K: jump to any page, lead or customer. */
export function Search({ pages, canCustomers, canLeads, onClose }: { pages: PageLink[]; canCustomers: boolean; canLeads: boolean; onClose: () => void }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [found, setFound] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(0);
  const latest = useRef(0);
  const q = text.trim();

  useEffect(() => {
    const ticket = ++latest.current;
    if (q.length < 2) { setFound([]); setBusy(false); return; }
    setBusy(true);
    const timer = setTimeout(async () => {
      const term = encodeURIComponent(q);
      const [leads, customers] = await Promise.all([
        canLeads ? api<Found[]>(`/api/v1/leads?q=${term}`).catch(() => []) : Promise.resolve([] as Found[]),
        canCustomers ? api<Found[]>(`/api/v1/customers?q=${term}`).catch(() => []) : Promise.resolve([] as Found[]),
      ]);
      if (ticket !== latest.current) return;
      setFound([
        ...leads.slice(0, SHOWN).map((l) => ({ href: `/app/leads/${l.id}`, label: l.name, icon: 'funnel', group: 'Leads', note: l.code ?? undefined })),
        ...customers.slice(0, SHOWN).map((c) => ({ href: `/app/customers/${c.id}`, label: c.name, icon: 'hr', group: 'Customers', note: c.code ?? undefined })),
      ]);
      setBusy(false);
    }, 220);
    return () => clearTimeout(timer);
  }, [q, canLeads, canCustomers]);

  const needle = q.toLowerCase();
  const pageHits: Hit[] = pages.filter((p) => !needle || p.label.toLowerCase().includes(needle)).slice(0, needle ? SHOWN : 8).map((p) => ({ ...p, group: 'Pages' }));
  const hits = [...found, ...pageHits];
  const at = Math.min(cursor, Math.max(hits.length - 1, 0));

  function go(h: Hit | undefined) {
    if (!h) return;
    onClose();
    router.push(h.href);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((at + 1) % Math.max(hits.length, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((at - 1 + hits.length) % Math.max(hits.length, 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(hits[at]); }
  }

  return (
    <div className="search-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="search-box" role="dialog" aria-modal="true" aria-label="Search" onKeyDown={onKey}>
        <div className="search-field">
          <Icon name="search" />
          <input autoFocus value={text} onChange={(e) => { setText(e.target.value); setCursor(0); }} placeholder="Search leads, customers or pages" aria-label="Search leads, customers or pages" />
          <kbd>Esc</kbd>
        </div>
        <div className="search-list">
          {hits.length === 0 && <div className="search-none">{busy ? 'Searching…' : `Nothing found for "${q}".`}</div>}
          {hits.map((h, i) => (
            <div key={h.href}>
              {(i === 0 || hits[i - 1].group !== h.group) && <div className="search-group">{h.group}</div>}
              <button className={`search-item ${i === at ? 'on' : ''}`} onMouseMove={() => { if (i !== at) setCursor(i); }} onClick={() => go(h)}>
                <Icon name={h.icon} /> {h.label}{h.note && <small>{h.note}</small>}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
