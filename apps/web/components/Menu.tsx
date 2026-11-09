'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Icon } from './Icon';

export interface MenuItem { label: string; icon?: string; href?: string; onClick?: () => void; hidden?: boolean }

/** A small "More" button that keeps less-used actions out of the page header. */
export function Menu({ items, label = 'More' }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const shown = items.filter((i) => !i.hidden);
  if (!shown.length) return null;
  return (
    <span className="menu" ref={box}>
      <button type="button" className="btn outline" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{label} <Icon name="chevron" className="ic" /></button>
      {open && (
        <div className="menu-pop" role="menu">
          {shown.map((i) => {
            const body = <>{i.icon && <Icon name={i.icon} className="ic" />}{i.label}</>;
            return i.href
              ? <Link key={i.label} role="menuitem" href={i.href} onClick={() => setOpen(false)}>{body}</Link>
              : <button key={i.label} type="button" role="menuitem" onClick={() => { setOpen(false); i.onClick?.(); }}>{body}</button>;
          })}
        </div>
      )}
    </span>
  );
}
