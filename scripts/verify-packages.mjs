// End-to-end checks for slice 3.5: product gallery, course and software access with validity, renewal leads.
// Usage: npm run verify:packages   (API running, freshly seeded, Mailpit on; run `npm run db:seed` afterwards).

const API = process.env.API_URL ?? 'http://localhost:4000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  if (!cond) failures++;
}
async function call(path, { tenant = 'mycompany', token, workspace, method = 'GET', body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (tenant) h['X-Tenant'] = tenant;
  if (token) h.Authorization = `Bearer ${token}`;
  if (workspace) h['X-Workspace'] = workspace;
  const raw = body instanceof Uint8Array;
  const res = await fetch(API + path, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
const login = async (identifier, tenant = 'mycompany') => (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { identifier, password: PASSWORD } })).body.accessToken;
const admin = await login('admin@mycompany.local');
const manager = await login('manager@mycompany.local');
const rm = await login('arjun');
const auditor = await login('auditor@mycompany.local');
const abc = await login('admin@abc.local', 'abc');
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const WS = Object.fromEntries(me.workspaces.map((w) => [w.name, w.id]));
const VASTU = WS['Vastu Consultation / Audit'], COURSE = WS['Course / Software'];
const users = (await call('/api/v1/users', { token: admin })).body;
const NEHA = users.find((u) => u.email === 'manager@mycompany.local').id;
const post = (p, token, body, workspace = VASTU) => call(p, { token, workspace, method: 'POST', body: body ?? {} });
const put = (p, token, body, workspace = VASTU) => call(p, { token, workspace, method: 'PUT', body });
const patch = (p, token, body, workspace = VASTU) => call(p, { token, workspace, method: 'PATCH', body });
const get = (p, token, workspace = VASTU) => call(p, { token, workspace });
const stamp = Date.now();
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const mobile = (n) => `9${String(stamp + n).slice(-9)}`;

// ── Products ──
const mk = (b) => post('/api/v1/products', admin, { mrpPaise: 1_000_000, gstRate: 18, ...b });
const course = (await mk({ name: `Elite Course ${stamp}`, accessKind: 'course', validityDays: 365, renewBeforeDays: 30, remindCustomer: true, description: 'A year of classes' })).body;
check('a product can carry an access type and validity', course.accessKind === 'course' && course.validityDays === 365, course);
const plain = (await mk({ name: `Audit ${stamp}` })).body;
check('a product is not an access product unless set', plain.accessKind === 'none', plain.accessKind);
const hidden = (await mk({ name: `Secret ${stamp}` })).body;

// ── Gallery ──
const empty = (await get('/api/v1/gallery', manager)).body;
check('no gallery until it is saved', empty.gallery === null && empty.items.length >= 3, empty.gallery);
check('a salesperson cannot change the gallery', (await put('/api/v1/gallery', rm, { title: 'Nope', isActive: true })).status === 403);
check('a bad WhatsApp number is refused', (await put('/api/v1/gallery', admin, { title: 'Our work', whatsappNumber: '12', isActive: true })).body.code === 'INVALID_MOBILE');
const saved = await put('/api/v1/gallery', admin, { title: 'Our services', intro: 'Pick what suits you', whatsappNumber: '9811122233', isActive: false });
check('the gallery is saved', saved.status === 200 && saved.body.url.includes(`/g/mycompany/${saved.body.gallery.slug}`), saved.body);
const slug = saved.body.gallery.slug;
const pub = `/public/gallery/mycompany/${slug}`;
const noHdr = (p, o = {}) => call(p, { tenant: null, ...o });
check('a closed gallery cannot be opened', (await noHdr(pub)).status === 404);
await put('/api/v1/gallery', admin, { title: 'Our services', intro: 'Pick what suits you', whatsappNumber: '9811122233', isActive: true });
check('the second save keeps the same link', (await get('/api/v1/gallery', manager)).body.gallery.slug === slug);
check('an offer at or above MRP is refused', (await patch(`/api/v1/gallery/items/${course.id}`, admin, { offerPaise: 1_000_000 })).body.code === 'OFFER_TOO_HIGH');
check('a brochure must be a web link', (await patch(`/api/v1/gallery/items/${course.id}`, admin, { brochureUrl: 'javascript:alert(1)' })).status === 400);
await patch(`/api/v1/gallery/items/${course.id}`, admin, { showInGallery: true, offerPaise: 800_000, brochureUrl: 'https://example.com/b.pdf' });
await patch(`/api/v1/gallery/items/${plain.id}`, admin, { showInGallery: true });
let page = (await noHdr(pub)).body;
check('the public page shows only what was marked', page.items.length === 2 && !page.items.some((i) => i.id === hidden.id), page.items?.length);
const pi = page.items.find((i) => i.id === course.id);
check('it shows the offer, MRP and brochure', pi.offerPaise === 800_000 && pi.mrpPaise === 1_000_000 && pi.brochureUrl === 'https://example.com/b.pdf', pi);
check('it does not expose internal fields', !JSON.stringify(page).includes('photoKey') && !JSON.stringify(page).includes('workspaceId'));
check('a wrong link finds nothing', (await noHdr('/public/gallery/mycompany/wrongslug')).status === 404);
check('another organization cannot open it', (await noHdr(`/public/gallery/abc/${slug}`)).status === 404);

// Photos
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const photo = (id, body, token = admin, type = 'image/png') => call(`/api/v1/gallery/items/${id}/photo`, { token, workspace: VASTU, method: 'POST', body, headers: { 'Content-Type': type } });
const notPic = await photo(course.id, new TextEncoder().encode('<svg onload=alert(1)></svg>'), admin, 'image/svg+xml');
check('a file that is not a picture is refused', notPic.body.code === 'NOT_A_PHOTO', notPic.body);
check('an oversized photo is refused', (await photo(course.id, new Uint8Array(3 * 1024 * 1024 + 10))).status >= 400);
check('a salesperson cannot add a photo', (await photo(course.id, png, rm)).status === 403);
check('a photo can be added', (await photo(course.id, png)).status === 200);
const img = await fetch(`${API}${pub}/photo/${course.id}`);
const bytes = new Uint8Array(await img.arrayBuffer());
check('the photo is served as a picture, unchanged', img.status === 200 && img.headers.get('content-type') === 'image/png' && img.headers.get('x-content-type-options') === 'nosniff' && bytes.length === png.length && bytes[0] === 0x89, img.headers.get('content-type'));
page = (await noHdr(pub)).body;
check('the page knows it has a photo', page.items.find((i) => i.id === course.id).photoVersion > 0);
check('a photo can be taken off', (await call(`/api/v1/gallery/items/${course.id}/photo`, { token: admin, workspace: VASTU, method: 'DELETE' })).status === 200);
check('and is then gone from the page', (await fetch(`${API}${pub}/photo/${course.id}`)).status === 404);

// Enquiries
const ask = (b) => noHdr(`${pub}/enquiry`, { method: 'POST', body: b });
check('a bad mobile is refused', (await ask({ name: 'Bad Number', mobile: '12345678' })).status === 400);
const enqMob = mobile(1);
check('an enquiry goes through', (await ask({ name: 'Gallery Visitor', mobile: enqMob, itemId: course.id, note: 'Call me' })).status === 200);
const leadsFor = async (q, token = admin) => { const r = (await call(`/api/v1/leads?q=${q}`, { token, workspace: VASTU })).body; return r.rows ?? r.items ?? r.data ?? r; };
let found = await leadsFor(enqMob);
check('an enquiry becomes a lead in that business line', found.length === 1 && found[0].source === 'gallery', found);
const hp = await ask({ name: 'Robot', mobile: mobile(2), _hp: 'filled' });
check('a bot is quietly ignored', hp.status === 200 && (await leadsFor(mobile(2))).length === 0);

// ── Access ──
const lead = (await post('/api/v1/leads', manager, { name: `Access Lead ${stamp}`, mobile: mobile(3), email: `access${stamp}@example.com`, customFields: { property_type: 'Home' }, ownerId: NEHA })).body;
const leadId = lead.id ?? lead.lead?.id;
const detail = (await get(`/api/v1/leads/${leadId}`, manager)).body;
const customerId = detail.customerId ?? detail.customer?.id;
const give = (b, token = manager, w = VASTU) => post('/api/v1/access', token, { customerId, packageId: course.id, leadId, ...b }, w);
check('a salesperson cannot give access', (await give({}, rm)).status === 403);
check('a product without an access type cannot be given', (await give({ packageId: plain.id })).body.code === 'NOT_AN_ACCESS_PRODUCT');
const g1 = await give({ startsOn: day(-30), licenceKey: `SECRET-KEY-${stamp}-ABCD` });
check('access is given with the product validity', g1.status === 201 && g1.body.state === 'active' && g1.body.daysLeft === 334, g1.body);
check('the licence key never appears in the record', !JSON.stringify(g1.body).includes('SECRET-KEY') && g1.body.licenceLast4 === 'ABCD' && g1.body.hasLicence === true, g1.body);
check('the same access cannot be given twice', (await give({})).body.code === 'ALREADY_ACTIVE');
const stranger = (await post('/api/v1/leads', manager, { name: `Other ${stamp}`, mobile: mobile(4), customFields: { property_type: 'Home' }, ownerId: NEHA })).body;
check('a lead of another customer is refused', (await give({ leadId: stranger.id ?? stranger.lead?.id })).body.code === 'INVALID_LEAD');
const l1 = (await get('/api/v1/access', manager)).body;
check('the list shows it', l1.rows.some((r) => r.id === g1.body.id) && l1.counts.active >= 1, l1.counts);
check('the list hides the key', !JSON.stringify(l1).includes('SECRET-KEY') && !JSON.stringify(l1).includes('licenceEncrypted'));
check('another business line does not see it', !(await get('/api/v1/access', admin, COURSE)).body.rows.some((r) => r.id === g1.body.id));
check('search finds it', (await get(`/api/v1/access?q=${encodeURIComponent('Access Lead')}`, manager)).body.rows.length >= 1);
const rmList = (await get('/api/v1/access', rm)).body;
check('a salesperson sees only their own customers', rmList.rows !== undefined && !rmList.rows.some((r) => r.id === g1.body.id), rmList.rows?.length);
check('a salesperson cannot see the key', (await post(`/api/v1/access/${g1.body.id}/licence`, rm)).status === 403);
const shown = await post(`/api/v1/access/${g1.body.id}/licence`, manager);
check('a manager can see the key', shown.body.licenceKey === `SECRET-KEY-${stamp}-ABCD`, shown.status);
const csv = String((await get('/api/v1/access.csv', manager)).body);
check('the download leaves the key out', csv.startsWith('Customer,Code,Mobile') && csv.includes(`Elite Course ${stamp}`) && !csv.includes('SECRET-KEY'));
check('an auditor can view', (await call('/api/v1/access', { token: auditor })).status === 200);

// Renew
const before = g1.body.expiresAt;
const ren = await post(`/api/v1/access/${g1.body.id}/renew`, manager, { days: 30 });
check('renewing early adds to the end date', new Date(ren.body.expiresAt).getTime() - new Date(before).getTime() === 30 * 86_400_000, ren.body);
const back = await put(`/api/v1/access/${g1.body.id}`, manager, { expiresOn: day(-5) });
check('the end date can be corrected', back.body.state === 'expired' && back.body.daysLeft === -5, back.body);
const r2 = await post(`/api/v1/access/${g1.body.id}/renew`, manager, { days: 10 });
check('renewing after it lapsed starts today', r2.body.daysLeft === 9 && r2.body.state === 'expiring', r2.body);
check('a past end date is refused when renewing', (await post(`/api/v1/access/${g1.body.id}/renew`, manager, { expiresOn: day(-1) })).body.code === 'INVALID_RANGE');

// Revoke
check('a reason is needed to revoke', (await post(`/api/v1/access/${g1.body.id}/revoke`, manager, { reason: '' })).status === 400);
check('access can be revoked', (await post(`/api/v1/access/${g1.body.id}/revoke`, manager, { reason: 'refund given' })).status === 200);
check('it stays on the list', (await get('/api/v1/access?state=revoked', manager)).body.rows.some((r) => r.id === g1.body.id && r.revokeReason === 'refund given'));
check('revoked access cannot be renewed', (await post(`/api/v1/access/${g1.body.id}/renew`, manager, { days: 5 })).body.code === 'REVOKED');
check('it can be restored', (await post(`/api/v1/access/${g1.body.id}/restore`, manager)).status === 200);

// Renewal leads and reminders
const runNow = () => post('/api/v1/automation/run-now', admin);
const renewProduct = (await mk({ name: `Software ${stamp}`, accessKind: 'software', validityDays: 365, renewBeforeDays: 30, remindCustomer: true })).body;
const email = `renew${stamp}@example.com`;
const lr = (await post('/api/v1/leads', manager, { name: `Renew Me ${stamp}`, mobile: mobile(5), email, customFields: { property_type: 'Home' }, ownerId: NEHA })).body;
const lrId = lr.id ?? lr.lead?.id;
const lrC = (await get(`/api/v1/leads/${lrId}`, manager)).body;
const cid = lrC.customerId ?? lrC.customer?.id;
await post('/api/v1/access', manager, { customerId: cid, packageId: renewProduct.id, leadId: lrId, startsOn: day(-345), validityDays: 365 });
const far = (await mk({ name: `Far ${stamp}`, accessKind: 'course', validityDays: 365 })).body;
const lf = (await post('/api/v1/leads', manager, { name: `Far Away ${stamp}`, mobile: mobile(6), customFields: { property_type: 'Home' }, ownerId: NEHA })).body;
const lfC = (await get(`/api/v1/leads/${lf.id ?? lf.lead?.id}`, manager)).body;
const farA = await post('/api/v1/access', manager, { customerId: lfC.customerId ?? lfC.customer?.id, packageId: far.id });
const old = (await mk({ name: `Old ${stamp}`, accessKind: 'course', validityDays: 30 })).body;
const lo = (await post('/api/v1/leads', manager, { name: `Long Gone ${stamp}`, mobile: mobile(7), customFields: { property_type: 'Home' }, ownerId: NEHA })).body;
const loC = (await get(`/api/v1/leads/${lo.id ?? lo.lead?.id}`, manager)).body;
const oldA = await post('/api/v1/access', manager, { customerId: loC.customerId ?? loC.customer?.id, packageId: old.id, startsOn: day(-400) });
await runNow();
const notes = async () => JSON.stringify((await call('/api/v1/notifications', { token: manager, workspace: VASTU })).body);
const row = async (n) => (await get(`/api/v1/access?q=${encodeURIComponent(n)}`, manager)).body.rows[0];
let a = await row(`Renew Me ${stamp}`);
check('a renewal lead is linked when the window opens', !!a.renewalLeadId && a.reminderStage === 1, a);
check('the open lead carries the renewal note, with no duplicate', a.renewalLeadId === lrId && (await leadsFor(mobile(5))).length === 1, a.renewalLeadId);
check('the team is alerted', (await notes()).includes(`Software ${stamp}`));
const mails = async () => { const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}&limit=20`).then((x) => x.json()); return r.messages ?? []; };
let m = await mails();
check('the customer is reminded when that is switched on', m.length === 1 && m[0].Subject.includes(`Software ${stamp}`), m.length);
check('access far from its end is left alone', (await row(`Far Away ${stamp}`)).reminderStage === 0 && !(await row(`Far Away ${stamp}`)).renewalLeadId, farA.status);
check('long-lapsed access makes no lead', !(await row(`Long Gone ${stamp}`)).renewalLeadId && (await row(`Long Gone ${stamp}`)).reminderStage === 3, oldA.status);
await runNow();
check('running again repeats nothing', (await mails()).length === 1 && (await row(`Renew Me ${stamp}`)).reminderStage === 1);
await put(`/api/v1/access/${a.id}`, manager, { expiresOn: day(5) });
a = await row(`Renew Me ${stamp}`);
await post(`/api/v1/access/${a.id}/renew`, manager, { days: 365 });
a = await row(`Renew Me ${stamp}`);
check('renewing clears the reminder state', a.reminderStage === 0 && a.renewalLeadId === null, a);

// Merge carries access
const dupLead = (await post('/api/v1/leads', manager, { name: `Dup ${stamp}`, mobile: mobile(8), customFields: { property_type: 'Home' }, ownerId: NEHA })).body;
const dupC = (await get(`/api/v1/leads/${dupLead.id ?? dupLead.lead?.id}`, manager)).body;
const dupId = dupC.customerId ?? dupC.customer?.id;
const dupA = await post('/api/v1/access', manager, { customerId: dupId, packageId: far.id });
const merged = await post('/api/v1/customers/merge', admin, { primaryId: cid, duplicateId: dupId, reason: 'same person' }, null);
check('merging customers moves their access', merged.status < 300 && (await get(`/api/v1/access?customerId=${cid}`, manager)).body.rows.some((r) => r.id === dupA.body.id), merged.body);
await post(`/api/v1/customers/merges/${merged.body.mergeId}/undo`, admin, {}, null);
check('undoing the merge moves it back', (await get(`/api/v1/access?customerId=${dupId}`, manager)).body.rows.some((r) => r.id === dupA.body.id));

check('another organization sees none of it', (await call('/api/v1/access', { tenant: 'abc', token: abc })).body.rows?.length === 0);
const audit = JSON.stringify((await call('/api/v1/audit-logs', { token: admin })).body);
check('changes are audited', audit.includes('access.granted') && audit.includes('access.renewed') && audit.includes('access.licence_viewed') && audit.includes('gallery.saved'));
check('the key is never in the audit log', !audit.includes('SECRET-KEY'));

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
