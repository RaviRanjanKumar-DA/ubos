'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { API_URL } from '@/lib/api';

interface Item { id: string; name: string; description: string | null; category: string | null; unit: string; mrpPaise: number; offerPaise: number | null; brochureUrl: string | null; photoVersion: number | null }
interface Page { organization: string; title: string; intro: string | null; whatsappNumber: string | null; items: Item[] }

const rs = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/** Public catalogue of a business line. No sign-in. */
export default function GalleryPublicPage() {
  const { org, slug } = useParams<{ org: string; slug: string }>();
  const url = `${API_URL}/public/gallery/${encodeURIComponent(org)}/${encodeURIComponent(slug)}`;
  const [page, setPage] = useState<Page | null>(null);
  const [gone, setGone] = useState('');
  const [item, setItem] = useState<Item | null | undefined>(undefined);
  const [f, setF] = useState({ name: '', mobile: '', email: '', note: '', _hp: '' });
  const [state, setState] = useState<{ kind: 'idle' | 'sending' | 'done' | 'error'; text?: string }>({ kind: 'idle' });
  useEffect(() => { fetch(url).then(async (r) => { if (!r.ok) return setGone('This gallery is not available.'); setPage((await r.json()) as Page); }).catch(() => setGone('This page could not be loaded. Please try again.')); }, [url]);
  const open = (i: Item | null) => { setItem(i); setState({ kind: 'idle' }); };
  async function send(e: React.FormEvent) {
    e.preventDefault();
    setState({ kind: 'sending' });
    const r = await fetch(`${url}/enquiry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...f, itemId: item?.id ?? null }) }).catch(() => null);
    if (r?.ok) return setState({ kind: 'done' });
    const b = (await r?.json().catch(() => null)) as { message?: string } | null;
    setState({ kind: 'error', text: r?.status === 400 ? 'Please check your name and mobile number.' : b?.message ?? 'That did not go through. Please try again.' });
  }
  if (gone) return <div className="pub-wrap"><div className="pub-form book-pub"><div className="muted">{gone}</div></div></div>;
  if (!page) return <div className="pub-wrap"><div className="pub-form book-pub"><div className="muted">Loading…</div></div></div>;
  const wa = page.whatsappNumber?.replace(/\D/g, '');
  return (
    <div className="gal-pub">
      <header><div className="small muted">{page.organization}</div><h1>{page.title}</h1>{page.intro && <p className="muted">{page.intro}</p>}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><button className="btn" onClick={() => open(null)}>Enquire</button>{wa && <a className="btn outline" target="_blank" rel="noreferrer" href={`https://wa.me/${wa}`}>Chat on WhatsApp</a>}</div>
      </header>
      {!page.items.length && <div className="card empty">Nothing to show yet.</div>}
      <div className="gal-grid">
        {page.items.map((i) => (
          <article key={i.id} className="card gal-card">
            {i.photoVersion && <img alt={i.name} loading="lazy" src={`${url}/photo/${i.id}?v=${i.photoVersion}`} />}
            <div className="gal-body">
              {i.category && <div className="small muted">{i.category}</div>}
              <h2>{i.name}</h2>
              {i.description && <p className="small muted">{i.description}</p>}
              <div className="gal-price">{i.offerPaise !== null ? <><b>{rs(i.offerPaise)}</b> <s className="muted">{rs(i.mrpPaise)}</s></> : <b>{rs(i.mrpPaise)}</b>}<span className="small muted"> / {i.unit}</span></div>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}><button className="btn sm" onClick={() => open(i)}>I am interested</button>{i.brochureUrl && <a className="btn sm ghost" target="_blank" rel="noopener noreferrer" href={i.brochureUrl}>Brochure</a>}</div>
            </div>
          </article>
        ))}
      </div>
      {item !== undefined && (
        <div className="modal-bg">
          {state.kind === 'done' ? (
            <div className="modal"><h2>Thank you</h2><p className="muted">We have your details and will get in touch soon.</p><div className="row end"><button className="btn" onClick={() => setItem(undefined)}>Close</button></div></div>
          ) : (
            <form className="modal" onSubmit={send}>
              <h2>{item ? item.name : 'Enquire'}</h2>
              {state.kind === 'error' && <div className="error">{state.text}</div>}
              <input hidden tabIndex={-1} autoComplete="off" aria-hidden="true" value={f._hp} onChange={(e) => setF({ ...f, _hp: e.target.value })} />
              <div className="field"><label htmlFor="e-n">Your name</label><input id="e-n" className="input" required minLength={2} maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
              <div className="field"><label htmlFor="e-m">Mobile</label><input id="e-m" className="input" required inputMode="tel" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} /></div>
              <div className="field"><label htmlFor="e-e">Email (optional)</label><input id="e-e" className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
              <div className="field"><label htmlFor="e-o">Message (optional)</label><textarea id="e-o" className="input" style={{ height: 60, paddingTop: 8 }} maxLength={1000} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
              <div className="row end"><button type="button" className="btn ghost" onClick={() => setItem(undefined)}>Go back</button><button className="btn" disabled={state.kind === 'sending'}>Send</button></div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
