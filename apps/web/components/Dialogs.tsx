'use client';

import { useEffect, useRef, useState } from 'react';

type Req =
  | { kind: 'text'; label: string; value: string; resolve: (v: string | null) => void }
  | { kind: 'confirm'; message: string; ok?: string; resolve: (v: boolean) => void };

let show: ((r: Req) => void) | null = null;

/** In-app replacement for window.prompt. Resolves to the trimmed text, or null if cancelled or empty. */
export const askText = (label: string, value = '') =>
  new Promise<string | null>((resolve) => { if (show) show({ kind: 'text', label, value, resolve }); else resolve(null); });

/** In-app replacement for window.confirm. "Delete X? More detail." shows the question as the title and the rest below it. */
export const askConfirm = (message: string, ok?: string) =>
  new Promise<boolean>((resolve) => { if (show) show({ kind: 'confirm', message, ok, resolve }); else resolve(false); });

const VERB = /^(Delete|Archive|Remove|Revoke|Unpair|Suspend|Deactivate|Merge|Undo|Change|Discard|Put)\b/;
const RISKY = /^(Delete|Archive|Remove|Revoke|Unpair|Suspend|Deactivate|Discard|Cancel)\b/;

/** Mounted once in the root layout, so every page and the Platform Console share it. */
export function DialogHost() {
  const [req, setReq] = useState<Req | null>(null);
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const okBtn = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    show = (r) => {
      opener.current = document.activeElement as HTMLElement | null;
      if (r.kind === 'text') setText(r.value);
      setReq(r);
    };
    return () => { show = null; };
  }, []);

  useEffect(() => {
    if (!req) return;
    if (req.kind === 'text') { input.current?.focus(); input.current?.select(); } else okBtn.current?.focus();
  }, [req]);

  const finish = (answer: boolean) => {
    if (!req) return;
    if (req.kind === 'text') req.resolve(answer ? text.trim() || null : null);
    else req.resolve(answer);
    setReq(null);
    opener.current?.focus?.();
  };

  if (!req) return null;

  const split = req.kind === 'confirm' ? req.message.indexOf('? ') : -1;
  const title = req.kind === 'text' ? req.label : split > 0 ? req.message.slice(0, split + 1) : req.message;
  const body = req.kind === 'confirm' && split > 0 ? req.message.slice(split + 2) : '';
  const verb = req.kind === 'confirm' ? req.ok ?? req.message.match(VERB)?.[1] ?? 'Yes' : 'Save';
  const risky = req.kind === 'confirm' && RISKY.test(req.message);

  return (
    <div className="modal-bg dialog-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) finish(false); }}>
      <form className="modal dialog" role="dialog" aria-modal="true" aria-label={title}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(false); } }}
        onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); finish(true); }}>
        <h2>{title}</h2>
        {body && <p className="muted dialog-body">{body}</p>}
        {req.kind === 'text' && <input ref={input} className="input" value={text} maxLength={200} aria-label={req.label} onChange={(e) => setText(e.target.value)} />}
        <div className="row end dialog-actions">
          <button type="button" className="btn ghost" onClick={() => finish(false)}>Go back</button>
          <button ref={okBtn} type="submit" className={`btn${risky ? ' danger' : ''}`} disabled={req.kind === 'text' && !text.trim()}>{verb}</button>
        </div>
      </form>
    </div>
  );
}
