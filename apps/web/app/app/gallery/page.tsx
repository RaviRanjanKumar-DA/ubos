'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, API_URL, ApiError, apiUpload } from '@/lib/api';
import { useShell } from '@/components/AppShell';
import { PickWorkspace } from '@/components/PickWorkspace';
import { inr, toPaise } from '@/lib/money';

interface Item { id: string; name: string; category: string | null; mrpPaise: number; showInGallery: boolean; offerPaise: number | null; brochureUrl: string | null; hasPhoto: boolean; updatedAt: string }
interface Gallery { slug: string; title: string; intro: string | null; whatsappNumber: string | null; isActive: boolean }
interface Data { gallery: Gallery | null; url: string | null; photoBase: string | null; workspaceName: string; items: Item[] }

/** Shrinks a chosen picture in the browser, so phone photos upload quickly and stay under the limit. */
function shrink(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, 1200 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('That picture could not be read'))), 'image/jpeg', 0.82);
    };
    img.onerror = () => reject(new Error('Choose a JPG, PNG or WebP photo'));
    img.src = url;
  });
}

export default function GalleryPage() {
  const { me, can, version } = useShell();
  const ws = me.currentWorkspaceId;
  const manage = can('crm.product.manage');
  const [data, setData] = useState<Data | null>(null);
  const [f, setF] = useState({ title: '', intro: '', whatsappNumber: '', isActive: false });
  const [offers, setOffers] = useState<Record<string, { offer: string; brochure: string }>>({});
  const [msg, setMsg] = useState<{ type: 'error' | 'notice'; text: string } | null>(null);
  const load = useCallback(async () => {
    if (!ws) return;
    const d = await api<Data>('/api/v1/gallery');
    setData(d);
    setF({ title: d.gallery?.title ?? d.workspaceName, intro: d.gallery?.intro ?? '', whatsappNumber: d.gallery?.whatsappNumber ?? '', isActive: d.gallery?.isActive ?? false });
    setOffers(Object.fromEntries(d.items.map((i) => [i.id, { offer: i.offerPaise === null ? '' : String(i.offerPaise / 100), brochure: i.brochureUrl ?? '' }])));
  }, [ws]);
  useEffect(() => { load().catch((e) => setMsg({ type: 'error', text: e.message })); }, [load, version]);
  const run = async (fn: () => Promise<unknown>, text: string) => { setMsg(null); try { await fn(); setMsg({ type: 'notice', text }); await load(); } catch (e) { setMsg({ type: 'error', text: e instanceof ApiError || e instanceof Error ? e.message : 'Failed' }); } };
  if (!ws) return (<><div className="page-head"><h1>Gallery</h1></div><PickWorkspace text="Each business line has its own gallery." /></>);
  const copy = async () => { if (data?.url) { await navigator.clipboard.writeText(data.url).catch(() => undefined); setMsg({ type: 'notice', text: 'Link copied.' }); } };
  const saveItem = (i: Item) => { const o = offers[i.id]; const offerPaise = o.offer.trim() ? toPaise(o.offer.replace(/,/g, '')) : null; if (o.offer.trim() && (offerPaise === null || offerPaise < 0)) return setMsg({ type: 'error', text: 'Enter the offer price as a number' }); run(() => api(`/api/v1/gallery/items/${i.id}`, { method: 'PATCH', body: { offerPaise, brochureUrl: o.brochure.trim() || null } }), `${i.name} saved.`); };
  return (
    <>
      <div className="page-head"><div><h1>Gallery</h1><div className="muted small">A page of what {data?.workspaceName ?? 'this business line'} sells, to share with customers. No sign-in needed to open it.</div></div></div>
      {msg && <div className={msg.type}>{msg.text}</div>}
      <form className="card" onSubmit={(e) => { e.preventDefault(); run(() => api('/api/v1/gallery', { method: 'PUT', body: { title: f.title, intro: f.intro.trim() || null, whatsappNumber: f.whatsappNumber.trim() || null, isActive: f.isActive } }), 'Gallery saved.'); }} style={{ marginBottom: 14 }}>
        <div className="grid cols-2">
          <div className="field"><label htmlFor="g-t">Title</label><input id="g-t" className="input" required minLength={2} maxLength={120} disabled={!manage} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
          <div className="field"><label htmlFor="g-w">WhatsApp number for enquiries (optional)</label><input id="g-w" className="input" inputMode="tel" disabled={!manage} value={f.whatsappNumber} onChange={(e) => setF({ ...f, whatsappNumber: e.target.value })} /></div>
        </div>
        <div className="field"><label htmlFor="g-i">Introduction (optional)</label><textarea id="g-i" className="input" style={{ height: 60, paddingTop: 8 }} maxLength={1000} disabled={!manage} value={f.intro} onChange={(e) => setF({ ...f, intro: e.target.value })} /></div>
        <div className="org-head">
          <label className="row small"><input type="checkbox" disabled={!manage} checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> The gallery page is open to customers</label>
          {manage && <button className="btn">Save</button>}
        </div>
        {data?.url && data.gallery?.isActive && <div className="gal-link"><a href={data.url} target="_blank" rel="noreferrer">{data.url}</a><button type="button" className="btn sm outline" onClick={copy}>Copy link</button></div>}
      </form>
      {data && !data.items.length && <div className="card empty">Add products in Products &amp; prices first.</div>}
      <div className="gal-admin">
        {data?.items.map((i) => (
          <div key={i.id} className="card gal-item">
            <div className="gal-thumb">{i.hasPhoto && data.photoBase ? <img alt={i.name} src={`${API_URL}${data.photoBase}/${i.id}?v=${new Date(i.updatedAt).getTime()}`} /> : <span className="small muted">No photo</span>}</div>
            <div>
              <b>{i.name}</b><div className="small muted">MRP {inr(i.mrpPaise)}{i.category ? ` · ${i.category}` : ''}</div>
              {manage ? (
                <>
                  <label className="row small" style={{ margin: '8px 0' }}><input type="checkbox" checked={i.showInGallery} onChange={(e) => run(() => api(`/api/v1/gallery/items/${i.id}`, { method: 'PATCH', body: { showInGallery: e.target.checked } }), e.target.checked ? `${i.name} now shows in the gallery.` : `${i.name} is hidden from the gallery.`)} /> Show in the gallery</label>
                  <div className="grid cols-2">
                    <div className="field"><label htmlFor={`o-${i.id}`}>Offer price ₹</label><input id={`o-${i.id}`} className="input" inputMode="decimal" placeholder="None" value={offers[i.id]?.offer ?? ''} onChange={(e) => setOffers({ ...offers, [i.id]: { ...offers[i.id], offer: e.target.value } })} /></div>
                    <div className="field"><label htmlFor={`b-${i.id}`}>Brochure link</label><input id={`b-${i.id}`} className="input" type="url" placeholder="https://" value={offers[i.id]?.brochure ?? ''} onChange={(e) => setOffers({ ...offers, [i.id]: { ...offers[i.id], brochure: e.target.value } })} /></div>
                  </div>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <button className="btn sm" onClick={() => saveItem(i)}>Save</button>
                    <label className={`btn sm outline ${data.gallery ? '' : 'disabled'}`} title={data.gallery ? '' : 'Save the gallery first'}>{i.hasPhoto ? 'Change photo' : 'Add photo'}<input hidden type="file" accept="image/jpeg,image/png,image/webp" disabled={!data.gallery} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) run(async () => apiUpload(`/api/v1/gallery/items/${i.id}/photo`, await shrink(file)), 'Photo added.'); }} /></label>
                    {i.hasPhoto && <button className="btn sm ghost" onClick={() => run(() => api(`/api/v1/gallery/items/${i.id}/photo`, { method: 'DELETE' }), 'Photo removed.')}>Remove photo</button>}
                  </div>
                </>
              ) : <div className="small" style={{ marginTop: 6 }}>{i.showInGallery ? 'In the gallery' : 'Not in the gallery'}</div>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
