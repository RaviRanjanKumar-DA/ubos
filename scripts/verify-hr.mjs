// End-to-end checks for slice 3.6: employees, checklists, sensitive details, documents, assets, HR reminders, access.
// Usage: npm run verify:hr   (API running, freshly seeded; run `npm run db:seed` afterwards).

const API = process.env.API_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
let failures = 0;
let WSID; // the web app always sends the chosen workspace; workspace-limited roles only apply with it
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  if (!cond) failures++;
}
async function call(path, { tenant = 'mycompany', token, method = 'GET', body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (tenant) h['X-Tenant'] = tenant;
  if (WSID && tenant === 'mycompany') h['X-Workspace'] = WSID;
  if (token) h.Authorization = `Bearer ${token}`;
  const raw = body instanceof Uint8Array;
  const res = await fetch(API + path, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const buf = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(buf);
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, bytes: buf, headers: res.headers };
}
const login = async (identifier, tenant = 'mycompany') => (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { identifier, password: PASSWORD } })).body.accessToken;
const admin = await login('admin@mycompany.local');
const manager = await login('manager@mycompany.local');
const rm = await login('arjun');
const auditor = await login('auditor@mycompany.local');
const abc = await login('admin@abc.local', 'abc');
WSID = (await call('/api/v1/auth/me', { token: admin })).body.workspaces.find((w) => w.name === 'Vastu Consultation / Audit').id;
const users = (await call('/api/v1/users', { token: admin })).body;
const NEHA = users.find((u) => u.email === 'manager@mycompany.local');
const ARJUN = users.find((u) => u.username === 'arjun' || u.email?.startsWith('arjun'));
const post = (p, token, body) => call(p, { token, method: 'POST', body: body ?? {} });
const put = (p, token, body) => call(p, { token, method: 'PUT', body });
const patch = (p, token, body) => call(p, { token, method: 'PATCH', body });
const get = (p, token) => call(p, { token });
const ist = (offset) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const yearsAgo = (n, offset = 0) => { const [y, m, d] = ist(offset).split('-'); return `${Number(y) - n}-${m}-${d}`; };

const meta = (await get('/api/v1/hr/meta', admin)).body;
check('the checklists start with sensible items', meta.onboardingTasks.length >= 5 && meta.docTypes.includes('PAN card') && meta.can.manage && meta.can.sensitive, meta.can);
check('a plan without HR cannot open it', (await call('/api/v1/hr/employees', { tenant: 'abc', token: abc })).status === 403);
check('a salesperson cannot add employees', (await post('/api/v1/hr/employees', rm, { name: 'X Y', joiningOn: ist(0) })).status === 403);
check('a manager cannot add employees', (await post('/api/v1/hr/employees', manager, { name: 'X Y', joiningOn: ist(0) })).status === 403);
check('a bad PAN is refused', (await post('/api/v1/hr/employees', admin, { name: 'Bad Pan', joiningOn: ist(0), pan: 'ABC' })).status === 400);
check('a bad mobile is refused', (await post('/api/v1/hr/employees', admin, { name: 'Bad Mobile', joiningOn: ist(0), mobile: '123' })).body.code === 'INVALID_MOBILE');

// A staff member without a login, with sensitive details
const e1 = await post('/api/v1/hr/employees', admin, { name: 'Ramesh Driver', mobile: '9812300001', designation: 'Driver', joiningOn: yearsAgo(2), dateOfBirthOn: yearsAgo(30, 3), probationEndOn: null, pan: 'abcde1234f', bank: { account: '001234567890', ifsc: 'hdfc0001234' }, ctcPaise: 36_000_000, address: '12 Lane, Pune' });
check('an employee without a login is added with a code', e1.status === 201 && /^E\d{4}$/.test(e1.body.employeeCode), e1.body);
const E1 = e1.body.id;
const d1 = (await get(`/api/v1/hr/employees/${E1}`, admin)).body;
check('the joining checklist is created', d1.tasks.filter((t) => t.kind === 'onboarding').length === meta.onboardingTasks.length, d1.tasks?.length);
check('only the last digits are shown', d1.panLast4 === '234F' && d1.bankLast4 === '7890' && !JSON.stringify(d1).includes('ABCDE1234F') && !JSON.stringify(d1).includes('001234567890'), d1);
const shown = (await post(`/api/v1/hr/employees/${E1}/reveal`, admin)).body;
check('the full details can be revealed', shown.pan === 'ABCDE1234F' && shown.bank.account === '001234567890' && shown.bank.ifsc === 'HDFC0001234', shown);
const e2 = await post('/api/v1/hr/employees', admin, { name: 'Second Person', joiningOn: ist(0) });
check('codes count up', e2.body.employeeCode !== e1.body.employeeCode, e2.body);

// A team member with a login, reporting to the manager
const e3 = await post('/api/v1/hr/employees', admin, { name: 'Arjun Sales', joiningOn: ist(-20), probationEndOn: ist(5), userId: ARJUN.id, designation: 'Sales executive' });
check('an employee can be linked to a login', e3.status === 201, e3.body);
check('a login can be linked only once', (await post('/api/v1/hr/employees', admin, { name: 'Again', joiningOn: ist(0), userId: ARJUN.id })).body.code === 'USER_LINKED');
const e4 = await post('/api/v1/hr/employees', admin, { name: 'Neha Manager', joiningOn: yearsAgo(1), userId: NEHA.id });
const E3 = e3.body.id, E4 = e4.body.id;

// Who sees whom
const rmList = (await get('/api/v1/hr/employees', rm)).body;
check('a salesperson sees only their own record', rmList.rows.length === 1 && rmList.rows[0].id === E3, rmList.rows?.map((r) => r.name));
check('a salesperson cannot open someone else', (await get(`/api/v1/hr/employees/${E1}`, rm)).status === 404);
const own = (await get(`/api/v1/hr/employees/${E3}`, rm)).body;
check('their own record hides salary and bank', own.id === E3 && own.ctcPaise === undefined && own.panLast4 === undefined && own.can.manage === false, own);
check('a salesperson cannot reveal details', (await post(`/api/v1/hr/employees/${E3}/reveal`, rm)).status === 403);
const mgrList = (await get('/api/v1/hr/employees', manager)).body;
check('a manager sees their team, not staff outside it', mgrList.rows.some((r) => r.id === E4) && !mgrList.rows.some((r) => r.id === E1), mgrList.rows?.map((r) => r.name));
check('an auditor sees everyone', (await get('/api/v1/hr/employees', auditor)).body.rows.length === 4);
check('search works', (await get('/api/v1/hr/employees?q=driver', admin)).body.rows.length === 1);

// Edits
check('details can be changed', (await put(`/api/v1/hr/employees/${E1}`, admin, { designation: 'Senior driver', ctcPaise: 40_000_000 })).status === 200);
const d1b = (await get(`/api/v1/hr/employees/${E1}`, admin)).body;
check('and are saved', d1b.designation === 'Senior driver' && d1b.ctcPaise === 40_000_000 && d1b.panLast4 === '234F', d1b);

// Checklists
const t0 = d1.tasks[0];
check('a checklist item can be ticked', (await patch(`/api/v1/hr/tasks/${t0.id}`, admin, { done: true })).body.doneAt !== null);
check('and an item added', (await post(`/api/v1/hr/employees/${E1}/tasks`, admin, { title: 'Driving licence copy', kind: 'onboarding' })).status === 201);
const saved = await put('/api/v1/hr/settings', admin, { onboardingTasks: ['Welcome kit'], exitTasks: ['Hand over keys', 'Final pay'], docTypes: ['Aadhaar', 'Driving licence', 'Other'] });
check('the checklists can be changed', saved.body.exitTasks.length === 2 && saved.body.docTypes.includes('Driving licence'), saved.body);
check('a manager cannot change them', (await put('/api/v1/hr/settings', manager, { onboardingTasks: [], exitTasks: [], docTypes: ['x'] })).status === 403);

// Documents
const pdf = new TextEncoder().encode('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF');
const up = (id, body, qs, token = admin, type = 'application/pdf') => call(`/api/v1/hr/employees/${id}/documents?${qs}`, { token, method: 'POST', body, headers: { 'Content-Type': type } });
check('a file that is not PDF, JPG or PNG is refused', (await up(E1, new TextEncoder().encode('<html><script>x</script>'), 'docType=Aadhaar&fileName=a.html', admin, 'text/html')).body.code === 'UNSUPPORTED_FILE');
check('an unknown document type is refused', (await up(E1, pdf, 'docType=Passport&fileName=p.pdf')).body.code === 'INVALID_DOC_TYPE');
check('a salesperson cannot upload', (await up(E3, pdf, 'docType=Aadhaar&fileName=a.pdf', rm)).status === 403);
const doc = await up(E1, pdf, `docType=Driving%20licence&fileName=licence.pdf&expiresOn=${ist(10)}`);
check('a document is stored', doc.status === 201 && doc.body.docType === 'Driving licence', doc.body);
const list = (await get(`/api/v1/hr/employees/${E1}/documents`, admin)).body;
check('it is listed without its storage key', list.length === 1 && list[0].fileKey === undefined, list);
const file = await get(`/api/v1/hr/documents/${doc.body.id}/file`, admin);
check('it downloads unchanged, as an attachment', file.status === 200 && file.headers.get('content-type') === 'application/pdf' && /attachment/.test(file.headers.get('content-disposition') ?? '') && file.bytes.length === pdf.length, file.headers.get('content-disposition'));
check('a manager without access to documents cannot download', (await get(`/api/v1/hr/documents/${doc.body.id}/file`, manager)).status === 403);
check('a document can be archived', (await patch(`/api/v1/hr/documents/${doc.body.id}`, admin, { isArchived: true })).status === 200);
await patch(`/api/v1/hr/documents/${doc.body.id}`, admin, { isArchived: false });

// Assets
const a1 = await post('/api/v1/hr/assets', admin, { tag: 'LAP-001', name: 'Dell Latitude', category: 'Laptop', serialNo: 'SN123', costPaise: 6_000_000, warrantyEndOn: ist(300) });
check('an asset is added', a1.status === 201 && a1.body.status === 'available', a1.body);
check('a tag cannot be used twice', (await post('/api/v1/hr/assets', admin, { tag: 'lap-001', name: 'Other', category: 'Laptop' })).body.code === 'DUPLICATE_TAG');
check('a salesperson cannot manage assets', (await get('/api/v1/hr/assets', rm)).status === 403);
check('an asset is issued', (await post(`/api/v1/hr/assets/${a1.body.id}/issue`, admin, { employeeId: E1 })).status === 200);
check('it cannot be issued twice', (await post(`/api/v1/hr/assets/${a1.body.id}/issue`, admin, { employeeId: E3 })).body.code === 'ASSET_NOT_AVAILABLE');
const al = (await get('/api/v1/hr/assets', admin)).body;
check('the list shows who has it', al.rows[0].holder?.id === E1 && al.counts.assigned === 1, al.rows[0]);
check('its status cannot change while issued', (await put(`/api/v1/hr/assets/${a1.body.id}`, admin, { status: 'retired' })).body.code === 'ASSET_ISSUED');
check('the employee page shows it', (await get(`/api/v1/hr/employees/${E1}`, admin)).body.assets.length === 1);

// Leaving
check('leaving needs a last day', (await post(`/api/v1/hr/employees/${E1}/status`, admin, { status: 'exited' })).body.code === 'EXIT_DATE_REQUIRED');
check('resigning works', (await post(`/api/v1/hr/employees/${E1}/status`, admin, { status: 'notice', exitReason: 'Moving city' })).status === 200);
const notice = (await get(`/api/v1/hr/employees/${E1}`, admin)).body;
check('the leaving checklist is added from the settings', notice.status === 'notice' && notice.tasks.filter((t) => t.kind === 'exit').map((t) => t.title).join('|') === 'Hand over keys|Final pay', notice.tasks);
check('someone cannot leave while holding assets', (await post(`/api/v1/hr/employees/${E1}/status`, admin, { status: 'exited', exitOn: ist(0) })).body.code === 'ASSETS_OUT');
await post(`/api/v1/hr/assets/${a1.body.id}/return`, admin, { condition: 'damaged' });
check('a damaged return goes to repair', (await get('/api/v1/hr/assets', admin)).body.rows[0].status === 'repair');
check('then they can leave', (await post(`/api/v1/hr/employees/${E1}/status`, admin, { status: 'exited', exitOn: ist(0) })).body.loginStillActive === false);
const linked = await post(`/api/v1/hr/employees/${E3}/status`, admin, { status: 'notice' });
const left = await post(`/api/v1/hr/employees/${E3}/status`, admin, { status: 'exited', exitOn: ist(0) });
check('leaving warns when the login is still on', linked.status === 200 && left.body.loginStillActive === true, left.body);
check('an exited person cannot get an asset', (await post(`/api/v1/hr/assets/${(await post('/api/v1/hr/assets', admin, { tag: 'SIM-1', name: 'Jio SIM', category: 'SIM' })).body.id}/issue`, admin, { employeeId: E1 })).body.code === 'INVALID_EMPLOYEE');

// Coming up and reminders
const e5 = await post('/api/v1/hr/employees', admin, { name: 'Birthday Today', joiningOn: yearsAgo(3), dateOfBirthOn: yearsAgo(25) });
const upc = (await get('/api/v1/hr/upcoming', admin)).body;
check('coming up shows birthdays, anniversaries and probation', upc.events.some((x) => x.kind === 'birthday' && x.employeeId === e5.body.id && x.daysAway === 0) && upc.events.some((x) => x.kind === 'anniversary' && x.employeeId === E4 && x.years === 1) && !upc.events.some((x) => x.employeeId === E1), upc.events);
check('people who left are not in it', !upc.events.some((x) => x.employeeId === E3));
await post(`/api/v1/hr/employees/${E4}/status`, admin, { status: 'active' });
await post('/api/v1/automation/run-now', admin);
const notes = JSON.stringify((await get('/api/v1/notifications', admin)).body);
check('HR is reminded of birthdays and anniversaries', notes.includes('Birthday today: Birthday Today') && notes.includes('Neha Manager completes 1 year today'), notes.slice(0, 300));
await post('/api/v1/automation/run-now', admin);
const notes2 = JSON.stringify((await get('/api/v1/notifications', admin)).body);
check('each reminder is sent once', notes2.split('Birthday today: Birthday Today').length === 2);

check('another organization sees none of it', (await call('/api/v1/hr/employees', { tenant: 'abc', token: abc })).status === 403);
const audit = JSON.stringify((await get('/api/v1/audit-logs', admin)).body);
check('changes are audited', audit.includes('employee.created') && audit.includes('employee.sensitive_viewed') && audit.includes('employee.document_opened') && audit.includes('asset.issued') && audit.includes('employee.status_changed'));
check('the audit log never holds PAN, bank or salary', !audit.includes('ABCDE1234F') && !audit.includes('001234567890') && !audit.includes('36000000') && !audit.includes('40000000'));

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
