// End-to-end checks for slice 3.7: check-in and out, leave types and balances, approvals, corrections, holidays, register.
// Usage: npm run verify:attendance   (API running, freshly seeded; run `npm run db:seed` afterwards).

const API = process.env.API_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
let failures = 0;
let WSID; // the web app always sends the chosen workspace; workspace-limited roles only apply with it
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  if (!cond) failures++;
}
async function call(path, { tenant = 'mycompany', token, method = 'GET', body } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (tenant) h['X-Tenant'] = tenant;
  if (WSID && tenant === 'mycompany') h['X-Workspace'] = WSID;
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
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
WSID = (await call('/api/v1/auth/me', { token: admin })).body.workspaces.find((w) => w.name === 'Vastu Consultation / Audit').id;
const users = (await call('/api/v1/users', { token: admin })).body;
const NEHA = users.find((u) => u.email === 'manager@mycompany.local');
const ARJUN = users.find((u) => u.username === 'arjun');
const ADMIN = users.find((u) => u.email === 'admin@mycompany.local');
const post = (p, token, body) => call(p, { token, method: 'POST', body: body ?? {} });
const put = (p, token, body) => call(p, { token, method: 'PUT', body });
const get = (p, token) => call(p, { token });

// IST day helpers, matching the app's rules (Sundays and 2nd/4th Saturdays off by default)
const DAY = 86_400_000;
const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const add = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const wd = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const off = (d) => wd(d) === 0 || (wd(d) === 6 && [2, 4].includes(Math.ceil(Number(d.slice(8)) / 7)));
const yearsAgo = (n) => `${Number(today.slice(0, 4)) - n}${today.slice(4)}`;
/** The Monday at least `weeks` weeks ahead that starts a Monday–Wednesday run inside one leave year. */
function mondayAhead(weeks) {
  let d = add(today, weeks * 7);
  while (wd(d) !== 1) d = add(d, 1);
  if (d.slice(0, 4) !== add(d, 2).slice(0, 4)) d = add(d, 7);
  return d;
}
// A past working day in the current month (not today), if any
let pastDay = null;
for (let d = add(today, -1); d.slice(0, 7) === today.slice(0, 7); d = add(d, -1)) if (!off(d)) { pastDay = d; break; }

// ---- Setup and access ----
const setup = (await get('/api/v1/hr/leave/setup', admin)).body;
const CL = setup.types.find((t) => t.code === 'CL'), SL = setup.types.find((t) => t.code === 'SL'), EL = setup.types.find((t) => t.code === 'EL'), LWP = setup.types.find((t) => t.code === 'LWP');
check('leave types start with CL, SL, EL and LWP', setup.types.length === 4 && CL?.yearlyDays === 12 && EL?.accrual === 'monthly' && LWP?.allowNegative === true, setup.types?.map((t) => t.code));
check('shift settings start with sensible defaults', setup.settings.workStart === '09:30' && setup.settings.saturdayOff === '2nd_4th' && setup.can.fix && setup.can.leave, setup.settings);
check('a plan without HR cannot open it', (await call('/api/v1/hr/me', { tenant: 'abc', token: abc })).status === 403);
check('a salesperson cannot see the register', (await get(`/api/v1/hr/attendance/register?month=${today.slice(0, 7)}`, rm)).status === 403);
check('a salesperson cannot approve', (await get('/api/v1/hr/approvals', rm)).status === 403);
check('a manager cannot change leave types', (await post('/api/v1/hr/leave/types', manager, { code: 'XX', name: 'Extra', isPaid: true, yearlyDays: 1, accrual: 'yearly', carryForwardMax: 0, allowHalfDay: true, allowNegative: false })).status === 403);
const before = (await get('/api/v1/hr/me', rm)).body;
check('someone without an employee record is told so', before.employee === null && before.types.length === 4);
check('checking in needs an employee record', (await post('/api/v1/hr/me/check-in', rm)).body.code === 'NO_EMPLOYEE_RECORD');

// Employees: Arjun (reports to Neha) and Neha with logins, Ramesh without
await call(`/api/v1/users/${ARJUN.id}`, { token: admin, method: 'PATCH', body: { reportsToId: NEHA.id } });
const eA = (await post('/api/v1/hr/employees', admin, { name: 'Arjun Sales', joiningOn: yearsAgo(2), userId: ARJUN.id })).body;
const eN = (await post('/api/v1/hr/employees', admin, { name: 'Neha Manager', joiningOn: yearsAgo(3), userId: NEHA.id })).body;
const eR = (await post('/api/v1/hr/employees', admin, { name: 'Ramesh Driver', joiningOn: yearsAgo(1) })).body;
check('employees are ready', !!eA.id && !!eN.id && !!eR.id, [eA, eN, eR]);

// ---- Check in and out ----
const ci = await post('/api/v1/hr/me/check-in', rm, { lat: 18.52, lng: 73.85 });
check('an employee checks in', ci.status === 200 && !!ci.body.checkInAt && ci.body.day === today && ci.body.inLat === 18.52, ci.body);
check('checking in twice is refused', (await post('/api/v1/hr/me/check-in', rm)).body.code === 'ALREADY_CHECKED_IN');
check('checking out before checking in is refused', (await post('/api/v1/hr/me/check-out', manager)).body.code === 'NOT_CHECKED_IN');
const co = await post('/api/v1/hr/me/check-out', rm);
check('an employee checks out', co.status === 200 && !!co.body.checkOutAt, co.body);
const meA = (await get('/api/v1/hr/me', rm)).body;
check('their page shows today and the month', meA.employee.id === eA.id && !!meA.record?.checkOutAt && meA.days.length >= 28 && meA.days.find((d) => d.day === today), meA.record);
const bal = (code, me = meA) => me.balances.find((b) => b.code === code);
check('balances start full for someone who joined years ago', bal('CL').available === 12 && bal('SL').available === 7 && bal('LWP').unlimited === true, meA.balances);
check('earned leave builds up month by month', bal('EL').earned > 0 && bal('EL').earned <= 15 && bal('EL').carried > 0, bal('EL'));

// ---- Applying for leave ----
const mon = mondayAhead(3), wed = add(mon, 2);
const apply = (token, body) => post('/api/v1/hr/me/leave', token, body);
check('earned leave cannot be a half day', (await apply(rm, { leaveTypeId: EL.id, fromOn: mon, toOn: mon, halfDay: true })).body.code === 'NO_HALF_DAY');
check('a half day covers one day only', (await apply(rm, { leaveTypeId: CL.id, fromOn: mon, toOn: wed, halfDay: true })).body.code === 'HALF_DAY_ONE_DAY');
check('the last day cannot be before the first', (await apply(rm, { leaveTypeId: CL.id, fromOn: wed, toOn: mon })).body.code === 'BAD_DATES');
check('more days than the balance are refused', (await apply(rm, { leaveTypeId: CL.id, fromOn: mon, toOn: add(mon, 20).slice(0, 4) === mon.slice(0, 4) ? add(mon, 20) : mon.slice(0, 4) + '-12-31' })).body.code === 'LOW_BALANCE');
let sun = add(mon, -1);
check('leave crossing into the next leave year is split', (await apply(rm, { leaveTypeId: LWP.id, fromOn: mon.slice(0, 4) + '-12-30', toOn: (Number(mon.slice(0, 4)) + 1) + '-01-02' })).body.code === 'ACROSS_YEARS');
check('a leave on only a weekly off is refused', (await apply(rm, { leaveTypeId: CL.id, fromOn: sun, toOn: sun })).body.code === 'NO_WORKING_DAYS');
const l1 = await apply(rm, { leaveTypeId: CL.id, fromOn: mon, toOn: wed, reason: 'Family function' });
check('applying for three days of casual leave', l1.status === 201 && l1.body.days === 3 && l1.body.status === 'pending' && l1.body.approverId === NEHA.id, l1.body);
check('overlapping leave is refused', (await apply(rm, { leaveTypeId: SL.id, fromOn: wed, toOn: wed })).body.code === 'LEAVE_OVERLAP');
const afterApply = (await get('/api/v1/hr/me', rm)).body;
check('pending leave is held from the balance', bal('CL', afterApply).pending === 3 && bal('CL', afterApply).available === 9, bal('CL', afterApply));
const nNotes = (await get('/api/v1/notifications', manager)).body;
check('the manager is told', (nNotes.items ?? nNotes).some((n) => n.title.includes('Arjun Sales asked for 3 days')), (nNotes.items ?? nNotes).slice(0, 3).map((n) => n.title));

// ---- Approvals ----
const q = (await get('/api/v1/hr/approvals', manager)).body;
const pend = q.leave.find((l) => l.id === l1.body.id);
check('the manager sees it with the balance', !!pend && pend.balance.available === 9 && pend.employee.name === 'Arjun Sales', q);
const ok1 = await post(`/api/v1/hr/leave/${l1.body.id}/decide`, manager, { approve: true, note: 'Enjoy' });
check('the manager approves it', ok1.status === 200, ok1.body);
check('it cannot be decided twice', (await post(`/api/v1/hr/leave/${l1.body.id}/decide`, manager, { approve: false })).body.code === 'ALREADY_DECIDED');
const afterOk = (await get('/api/v1/hr/me', rm)).body;
check('approved leave counts as taken', bal('CL', afterOk).taken === 3 && bal('CL', afterOk).pending === 0 && bal('CL', afterOk).available === 9, bal('CL', afterOk));
check('the employee is told', afterOk.requests.find((r) => r.id === l1.body.id)?.status === 'approved');
const lN = await apply(manager, { leaveTypeId: SL.id, fromOn: mon, toOn: mon, halfDay: true, reason: 'Doctor' });
check('a manager can apply for a half day', lN.status === 201 && lN.body.days === 0.5, lN.body);
check('nobody approves their own leave', (await post(`/api/v1/hr/leave/${lN.body.id}/decide`, manager, { approve: true })).body.code === 'OWN_REQUEST');
check('their own request is not in their approvals', !(await get('/api/v1/hr/approvals', manager)).body.leave.some((l) => l.id === lN.body.id));
check('the organization admin approves it', (await post(`/api/v1/hr/leave/${lN.body.id}/decide`, admin, { approve: true })).status === 200);
const l2 = await apply(rm, { leaveTypeId: SL.id, fromOn: add(mon, 7), toOn: add(mon, 7) });
await post(`/api/v1/hr/leave/${l2.body.id}/decide`, manager, { approve: false, note: 'Busy week' });
const afterNo = (await get('/api/v1/hr/me', rm)).body;
check('rejected leave goes back to the balance', bal('SL', afterNo).available === 7 && afterNo.requests.find((r) => r.id === l2.body.id)?.decisionNote === 'Busy week', bal('SL', afterNo));
const l3 = await apply(rm, { leaveTypeId: LWP.id, fromOn: add(mon, 14), toOn: add(mon, 16) });
check('leave without pay has no limit', l3.status === 201, l3.body);
check('an employee cancels a request', (await post(`/api/v1/hr/me/leave/${l3.body.id}/cancel`, rm)).status === 200 && (await get('/api/v1/hr/me', rm)).body.requests.find((r) => r.id === l3.body.id).status === 'cancelled');

// ---- Holidays ----
const hd = add(mon, 21);
const h1 = await post('/api/v1/hr/holidays', admin, { day: hd, name: 'Test Festival' });
check('HR adds a holiday', h1.status === 201, h1.body);
check('a second holiday on the same day is refused', (await post('/api/v1/hr/holidays', admin, { day: hd, name: 'Again' })).body.code === 'HOLIDAY_EXISTS');
check('leave on a holiday is refused', (await apply(rm, { leaveTypeId: CL.id, fromOn: hd, toOn: hd })).body.code === 'NO_WORKING_DAYS');
const l4 = await apply(rm, { leaveTypeId: CL.id, fromOn: hd, toOn: add(hd, 1) });
check('holidays are not counted as leave days', l4.body.days === 1, l4.body);
check('everyone sees the holiday list', (await get('/api/v1/hr/me', rm)).body.holidays.some((h) => h.name === 'Test Festival') || hd.slice(0, 4) !== today.slice(0, 4));
check('a holiday can be removed', (await post(`/api/v1/hr/holidays/${h1.body.id}/archive`, admin)).status === 200 && !(await get('/api/v1/hr/leave/setup', admin)).body.holidays.some((h) => h.id === h1.body.id));

// ---- Corrections and HR fixes ----
if (pastDay) {
  check('a future correction is refused', (await post('/api/v1/hr/me/corrections', rm, { day: add(today, 1), checkIn: '09:30', checkOut: '18:30', reason: 'Forgot' })).body.code === 'FUTURE_DAY');
  check('check-out must be after check-in', (await post('/api/v1/hr/me/corrections', rm, { day: pastDay, checkIn: '18:30', checkOut: '09:30', reason: 'Forgot' })).body.code === 'BAD_TIMES');
  const c1 = await post('/api/v1/hr/me/corrections', rm, { day: pastDay, checkIn: '09:20', checkOut: '18:40', reason: 'Forgot to check in' });
  check('an employee asks to correct a day', c1.status === 201, c1.body);
  check('only one correction per day waits at a time', (await post('/api/v1/hr/me/corrections', rm, { day: pastDay, checkIn: '09:20', checkOut: '18:40', reason: 'Again' })).body.code === 'CORRECTION_PENDING');
  check('the manager sees it', (await get('/api/v1/hr/approvals', manager)).body.corrections.some((c) => c.id === c1.body.id));
  await post(`/api/v1/hr/corrections/${c1.body.id}/decide`, manager, { approve: true });
  const fixed = (await get(`/api/v1/hr/attendance/employees/${eA.id}?month=${today.slice(0, 7)}`, manager)).body.days.find((d) => d.day === pastDay);
  check('an approved correction fills the day', fixed.kind === 'present' && fixed.late === false && fixed.hours === 9.33, fixed);
  const fx = await put(`/api/v1/hr/attendance/employees/${eA.id}/days/${pastDay}`, admin, { override: 'absent', note: 'Was not in' });
  const fixedA = (await get(`/api/v1/hr/attendance/employees/${eA.id}?month=${today.slice(0, 7)}`, admin)).body.days.find((d) => d.day === pastDay);
  check('HR can mark a day absent', fx.status === 200 && fixedA.kind === 'absent' && fixedA.note === 'Was not in', fixedA);
  check('a manager cannot correct days', (await put(`/api/v1/hr/attendance/employees/${eA.id}/days/${pastDay}`, manager, { override: 'present' })).status === 403);
  await put(`/api/v1/hr/attendance/employees/${eA.id}/days/${pastDay}`, admin, { override: null, checkIn: '10:05', checkOut: '15:00' });
  const late = (await get(`/api/v1/hr/attendance/employees/${eA.id}?month=${today.slice(0, 7)}`, admin)).body.days.find((d) => d.day === pastDay);
  check('a short, late day is a late half day', late.kind === 'half_day' && late.late === true, late);
} else console.log('SKIP  corrections (no past working day this month yet)');
check('future days cannot be marked', (await put(`/api/v1/hr/attendance/employees/${eA.id}/days/${add(today, 2)}`, admin, { override: 'present' })).body.code === 'FUTURE_DAY');
check('check-out needs a check-in', (await put(`/api/v1/hr/attendance/employees/${eR.id}/days/${today}`, admin, { checkOut: '18:00' })).body.code === 'BAD_TIMES');

// ---- HR records leave and adjusts balances ----
const r1 = await post('/api/v1/hr/leave', admin, { employeeId: eR.id, leaveTypeId: CL.id, fromOn: mon, toOn: mon });
check('HR records leave for staff without a login', r1.status === 201 && r1.body.status === 'approved', r1.body);
const adj = await post('/api/v1/hr/leave/adjust', admin, { employeeId: eR.id, leaveTypeId: CL.id, days: 2, reason: 'Comp off for Sunday work' });
check('HR adds days to a balance', adj.status === 201, adj.body);
check('a zero adjustment is refused', (await post('/api/v1/hr/leave/adjust', admin, { employeeId: eR.id, leaveTypeId: CL.id, days: 0, reason: 'x y z' })).status === 400);
const rView = (await get(`/api/v1/hr/attendance/employees/${eR.id}`, admin)).body;
const rCL = rView.balances.find((b) => b.code === 'CL');
check('the balance shows the adjustment and the leave', rCL.adjustment === 2 && rCL.taken === 1 && rCL.available === rCL.earned + 2 - 1, rCL);
check('a manager cannot record leave for others', (await post('/api/v1/hr/leave', manager, { employeeId: eR.id, leaveTypeId: CL.id, fromOn: wed, toOn: wed })).status === 403);
check('HR can cancel approved leave', (await post(`/api/v1/hr/leave/${r1.body.id}/cancel`, admin)).status === 200);

// ---- Leave types and settings ----
const ml = await post('/api/v1/hr/leave/types', admin, { code: 'ml', name: 'Maternity leave', isPaid: true, yearlyDays: 182, accrual: 'yearly', carryForwardMax: 0, allowHalfDay: false, allowNegative: false });
check('HR adds a leave type', ml.status === 201 && ml.body.code === 'ML', ml.body);
check('codes are unique', (await post('/api/v1/hr/leave/types', admin, { code: 'ML', name: 'Again', isPaid: true, yearlyDays: 1, accrual: 'yearly', carryForwardMax: 0, allowHalfDay: true, allowNegative: false })).body.code === 'CODE_TAKEN');
await put(`/api/v1/hr/leave/types/${ml.body.id}`, admin, { isArchived: true });
check('an archived type is not offered', !(await get('/api/v1/hr/me', rm)).body.types.some((t) => t.code === 'ML'));
check('half-day hours must be under full-day hours', (await put('/api/v1/hr/attendance/settings', admin, { ...setup.settings, halfDayHours: 9 })).status === 400);
check('a manager cannot change the shift', (await put('/api/v1/hr/attendance/settings', manager, setup.settings)).status === 403);
const saved = await put('/api/v1/hr/attendance/settings', admin, { ...setup.settings, requireLocation: true, saturdayOff: 'none' });
check('HR saves shift settings', saved.status === 200 && (await get('/api/v1/hr/leave/setup', rm)).body.settings.saturdayOff === 'none', saved.body);
check('the HR checklists survive saving the shift', (await get('/api/v1/hr/meta', admin)).body.onboardingTasks.length >= 5);
check('location can be required to check in', (await post('/api/v1/hr/me/check-in', manager)).body.code === 'LOCATION_REQUIRED' && (await post('/api/v1/hr/me/check-in', manager, { lat: 19.07, lng: 72.87 })).status === 200);
await put('/api/v1/hr/attendance/settings', admin, setup.settings);

// ---- Today and the register ----
const td = (await get('/api/v1/hr/attendance/today', manager)).body;
check('the manager sees who is in today', td.counts.in >= 2 && td.people.some((p) => p.id === eA.id && p.checkInAt), td.counts);
check('a manager does not see people outside the team', !td.people.some((p) => p.id === eR.id));
const reg = (await get(`/api/v1/hr/attendance/register?month=${today.slice(0, 7)}`, auditor)).body;
const rowA = reg.rows.find((r) => r.id === eA.id);
check('the auditor sees the monthly register', !!rowA && reg.rows.some((r) => r.id === eR.id) && typeof rowA.payable === 'number', reg.rows?.length);
const csv = await call(`/api/v1/hr/attendance/register.csv?month=${today.slice(0, 7)}`, { token: admin });
check('the register downloads as CSV', csv.status === 200 && csv.headers.get('content-type').includes('text/csv') && String(csv.body).includes('Payable days') && String(csv.body).includes(eA.employeeCode));
check('a bad month is refused', (await get('/api/v1/hr/attendance/register?month=2026-13', admin)).status === 400);
const empMonth = (await get(`/api/v1/hr/attendance/employees/${eA.id}?month=${mon.slice(0, 7)}`, manager)).body;
check('approved leave shows on the calendar', empMonth.days.find((d) => d.day === mon)?.kind === 'leave' && empMonth.days.find((d) => d.day === mon)?.leaveCode === 'CL', empMonth.days.find((d) => d.day === mon));
check('a salesperson cannot open someone else', (await get(`/api/v1/hr/attendance/employees/${eN.id}`, rm)).status === 404);

// ---- Isolation and audit ----
check('another organization sees none of it', (await call('/api/v1/hr/attendance/register', { tenant: 'abc', token: abc })).status === 403);
const audit = JSON.stringify((await call('/api/v1/audit-logs', { token: admin })).body);
check('changes are audited', ['leave.applied', 'leave.approved', 'leave.rejected', 'leave.adjusted', 'leave.recorded', 'holiday.added', 'attendance.settings_saved', 'leave_type.created'].every((a) => audit.includes(a)) && (!pastDay || audit.includes('attendance.corrected')));

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
