// End-to-end checks for Phase 1.5d: products & price lists, quotes with discount approval, process templates after a sale
// (steps, owners, forms, gates, step access, lock / unlock, send back, sign-off), payments and payment rules, lead team,
// accepting-new-leads switch, temporary cover, rating and the process report.
// Usage: npm run verify:process   (API running, freshly seeded; run `npm run db:seed` afterwards)

const API = process.env.API_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.UBOS_DEV_PASSWORD ?? 'Ubos@2026dev'; // seed-only dev password
let failures = 0;

function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
  if (!cond) failures++;
}
async function call(path, { tenant = 'mycompany', token, workspace, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (tenant) headers['X-Tenant'] = tenant;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (workspace) headers['X-Workspace'] = workspace;
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const login = async (identifier, tenant = 'mycompany') =>
  (await call('/api/v1/auth/login', { tenant, method: 'POST', body: { identifier, password: PASSWORD } })).body.accessToken;

const admin = await login('admin@mycompany.local');
const rm = await login('arjun');
const manager = await login('manager@mycompany.local');
const abc = await login('admin@abc.local', 'abc');
const me = (await call('/api/v1/auth/me', { token: admin })).body;
const ws = Object.fromEntries(me.workspaces.map((w) => [w.name, w.id]));
const VASTU = ws['Vastu Consultation / Audit'];
const COURSE = ws['Course / Software'];
const users = (await call('/api/v1/users', { token: admin })).body;
const uid = (email) => users.find((u) => u.email === email).id;
const ARJUN = uid('rm@mycompany.local');
const NEHA = uid('manager@mycompany.local');
const SIMRAN = uid('rm2@mycompany.local');
const roles = (await call('/api/v1/roles', { token: admin })).body;
const RM_ROLE = roles.find((r) => r.name === 'RM').id;
const MANAGER_ROLE = roles.find((r) => r.name === 'Manager').id;
const vastuLeads = (await call('/api/v1/leads', { token: admin, workspace: VASTU })).body;
const arjunLeads = vastuLeads.filter((l) => l.ownerId === ARJUN);
const lead = arjunLeads[0];
const lead2 = arjunLeads[1];
const nehaLead = vastuLeads.find((l) => l.ownerId === NEHA);
const A = { token: admin, workspace: VASTU };
const R = { token: rm, workspace: VASTU };
const M = { token: manager, workspace: VASTU };

// ── Products & price lists ──
const audit = await call('/api/v1/products', { ...A, method: 'POST', body: { name: 'Vastu Audit', code: 'VA-01', category: 'Audit', mrpPaise: 2_500_000, gstRate: 18 } });
const visit = await call('/api/v1/products', { ...A, method: 'POST', body: { name: 'Site visit', category: 'Visit', mrpPaise: 500_000, gstRate: 18 } });
const kit = await call('/api/v1/products', { ...A, method: 'POST', body: { name: 'Remedies kit', category: 'Remedies', mrpPaise: 300_000, gstRate: 12 } });
check('admins add products with MRP and GST', audit.status === 201 && visit.status === 201 && kit.status === 201 && audit.body.gstRate === 18, [audit.body, kit.body]);
const dupProd = await call('/api/v1/products', { ...A, method: 'POST', body: { name: 'vastu audit', mrpPaise: 1 } });
const rmProd = await call('/api/v1/products', { ...R, method: 'POST', body: { name: 'My product', mrpPaise: 100 } });
const mgrProd = await call('/api/v1/products', { ...M, method: 'POST', body: { name: 'Mgr product', mrpPaise: 100 } });
check('product names are unique; RMs and managers cannot change the catalogue', dupProd.status === 400 && rmProd.status === 403 && mgrProd.status === 403, [dupProd.status, rmProd.status, mgrProd.status]);
const rmProducts = (await call('/api/v1/products', R)).body;
check('everyone in the business line sees its products', rmProducts.length === 3 && rmProducts.some((p) => p.name === 'Remedies kit'), rmProducts.map((p) => p.name));
const courseProducts = (await call('/api/v1/products', { token: admin, workspace: COURSE })).body;
check('products belong to their business line', courseProducts.every((p) => p.workspaceId === COURSE) && !courseProducts.some((p) => p.name === 'Vastu Audit'), courseProducts.map((p) => p.name));
const badMin = await call('/api/v1/price-lists', { ...A, method: 'POST', body: { name: 'Broken', items: [{ packageId: audit.body.id, pricePaise: 2_000_000, minPricePaise: 2_100_000 }] } });
const std = await call('/api/v1/price-lists', { ...A, method: 'POST', body: { name: 'Standard', isDefault: true, items: [{ packageId: audit.body.id, pricePaise: 2_200_000, minPricePaise: 2_000_000 }, { packageId: visit.body.id, pricePaise: 500_000 }] } });
check('a default price list with lowest allowed prices (lowest ≤ list price)', badMin.status === 400 && std.status === 201 && std.body.items.length === 2 && std.body.isDefault, [badMin.body, std.body]);
const crossPl = await call('/api/v1/price-lists', { token: admin, workspace: COURSE, method: 'POST', body: { name: 'X', items: [{ packageId: audit.body.id, pricePaise: 1 }] } });
check('a price list cannot use another business line’s products', crossPl.status === 400, crossPl.body);
await call(`/api/v1/products/${kit.body.id}`, { ...A, method: 'PATCH', body: { isArchived: true } });
const afterArch = (await call('/api/v1/products', R)).body.map((p) => p.name);
const archived = (await call('/api/v1/products?archived=true', R)).body.map((p) => p.name);
check('archived products leave the list but are kept', !afterArch.includes('Remedies kit') && archived.includes('Remedies kit'), [afterArch, archived]);
await call(`/api/v1/products/${kit.body.id}`, { ...A, method: 'PATCH', body: { isArchived: false } });

// ── Quotes ──
const q1 = await call(`/api/v1/leads/${lead.id}/quotes`, { ...R, method: 'POST', body: { items: [{ packageId: audit.body.id }, { packageId: visit.body.id, qty: 1 }] } });
check('an RM makes a quote from their lead using the default price list', q1.status === 201 && q1.body.priceListId === std.body.id && /^Q-\d{4}-\d{4}$/.test(q1.body.number), q1.body);
check('quote totals: list value, discount vs MRP-free list, GST added', q1.body.subtotalPaise === 2_700_000 && q1.body.discountPaise === 0 && q1.body.taxPaise === 486_000 && q1.body.totalPaise === 3_186_000 && !q1.body.needsApproval, [q1.body.subtotalPaise, q1.body.taxPaise, q1.body.totalPaise]);
const notMine = await call(`/api/v1/leads/${nehaLead.id}/quotes`, { ...R, method: 'POST', body: { items: [{ packageId: audit.body.id }] } });
check('an RM cannot quote on someone else’s lead', notMine.status === 404, notMine.status);
const custom = await call(`/api/v1/leads/${lead.id}/quotes`, { ...R, method: 'POST', body: { items: [{ name: 'Travel charges', pricePaise: 150_000 }] } });
const badCustom = await call(`/api/v1/leads/${lead.id}/quotes`, { ...R, method: 'POST', body: { items: [{ name: 'No price' }] } });
check('custom lines need a name and a price', custom.status === 201 && custom.body.totalPaise === 150_000 && badCustom.status === 400, [custom.body.totalPaise, badCustom.status]);

const low = await call(`/api/v1/leads/${lead.id}/quotes`, { ...R, method: 'POST', body: { items: [{ packageId: audit.body.id, pricePaise: 1_900_000 }] } });
check('a price below the lowest allowed price needs approval (with the reason)', low.status === 201 && low.body.needsApproval && low.body.reasons.some((r) => /lowest/.test(r)), low.body);
const sendLow = await call(`/api/v1/quotes/${low.body.id}/send`, { ...R, method: 'POST', body: {} });
check('sending it asks a manager first', sendLow.status === 201 && sendLow.body.status === 'pending_approval', sendLow.body);
const again = await call(`/api/v1/quotes/${low.body.id}/send`, { ...R, method: 'POST', body: {} });
check('it cannot be sent while waiting', again.status === 400 && again.body.code === 'AWAITING_APPROVAL', again.body);
const mgrApprovals = (await call('/api/v1/approvals', M)).body;
const rmApprovals = (await call('/api/v1/approvals', R)).body;
const apDiscount = mgrApprovals.items.find((x) => x.entityId === low.body.id);
check('the manager sees the request; the RM sees their own request', mgrApprovals.canDecide && !!apDiscount && apDiscount.customerName && !rmApprovals.canDecide && rmApprovals.items.some((x) => x.entityId === low.body.id && x.isMine), [mgrApprovals, rmApprovals]);
const rmDecide = await call(`/api/v1/approvals/${apDiscount.id}/decide`, { ...R, method: 'POST', body: { decision: 'approve' } });
const noNote = await call(`/api/v1/approvals/${apDiscount.id}/decide`, { ...M, method: 'POST', body: { decision: 'reject' } });
check('RMs cannot approve; a rejection needs a reason', rmDecide.status === 403 && noNote.status === 400, [rmDecide.status, noNote.body]);
const approve = await call(`/api/v1/approvals/${apDiscount.id}/decide`, { ...M, method: 'POST', body: { decision: 'approve', note: 'Repeat customer' } });
const lowAfter = (await call(`/api/v1/quotes/${low.body.id}`, R)).body;
check('approval moves the quote to approved', approve.status === 201 && lowAfter.status === 'approved' && lowAfter.approval.status === 'approved', [approve.body, lowAfter.status]);
const twice = await call(`/api/v1/approvals/${apDiscount.id}/decide`, { ...M, method: 'POST', body: { decision: 'reject', note: 'x' } });
check('a request is decided once', twice.status === 400 && twice.body.code === 'ALREADY_DECIDED', twice.body);
const sent = await call(`/api/v1/quotes/${low.body.id}/send`, { ...R, method: 'POST', body: {} });
check('the approved quote is sent', sent.status === 201 && sent.body.status === 'sent', sent.body);
const editSent = await call(`/api/v1/quotes/${low.body.id}`, { ...R, method: 'PUT', body: { items: [{ packageId: audit.body.id }] } });
check('a sent quote is locked (make a new one instead)', editSent.status === 400 && editSent.body.code === 'QUOTE_LOCKED', editSent.body);
const rejectQ = await call(`/api/v1/quotes/${low.body.id}/reject`, { ...R, method: 'POST', body: { reason: 'Customer found it costly' } });
check('the customer declines a sent quote', rejectQ.status === 201 && rejectQ.body.status === 'rejected', rejectQ.body);

const mgrSettings = await call(`/api/v1/workspaces/${VASTU}/quote-settings`, { ...M, method: 'PUT', body: { quoteMaxDiscountPct: 5 } });
const setLimit = await call(`/api/v1/workspaces/${VASTU}/quote-settings`, { ...A, method: 'PUT', body: { quoteMaxDiscountPct: 5, quoteTerms: '50% advance, balance before the report.' } });
const disc = await call(`/api/v1/leads/${lead.id}/quotes`, { ...R, method: 'POST', body: { items: [{ packageId: visit.body.id, pricePaise: 450_000 }] } });
check('discount above the business-line limit needs approval; default terms are printed', mgrSettings.status === 403 && setLimit.status === 200 && disc.body.needsApproval && disc.body.reasons.some((r) => /limit/.test(r)) && /advance/.test(disc.body.terms), [mgrSettings.status, disc.body]);
const editDisc = await call(`/api/v1/quotes/${disc.body.id}`, { ...R, method: 'PUT', body: { items: [{ packageId: visit.body.id }] } });
check('editing a draft re-prices it (no discount → no approval)', editDisc.status === 200 && !editDisc.body.needsApproval && editDisc.body.discountPaise === 0, editDisc.body);

// ── Process templates ──
const steps = [
  { name: 'Kick-off call', assignTo: 'lead_owner', dueDays: 1, fields: [{ key: 'preferred_date', label: 'Preferred visit date', type: 'date', required: true }, { key: 'notes', label: 'Notes', type: 'textarea' }] },
  { name: 'Site visit', assignTo: 'role', ownerRoleId: MANAGER_ROLE, dueDays: 7, minPaymentPct: 50, fields: [{ key: 'visit_done', label: 'Visit done', type: 'checkbox', required: true }, { key: 'zone', label: 'Main door zone', type: 'dropdown', options: ['N', 'E', 'S', 'W'] }] },
  { name: 'Report & sign-off', assignTo: 'role', ownerRoleId: MANAGER_ROLE, requiresApproval: true, access: { [RM_ROLE]: 'view' }, fields: [{ key: 'report_url', label: 'Report link', type: 'url', required: true }] },
];
const badDrop = await call('/api/v1/process-templates', { ...A, method: 'POST', body: { name: 'Bad', steps: [{ name: 'One', fields: [{ key: 'x', label: 'X', type: 'dropdown' }] }] } });
const badUser = await call('/api/v1/process-templates', { ...A, method: 'POST', body: { name: 'Bad', steps: [{ name: 'One', assignTo: 'user' }] } });
const mgrTpl = await call('/api/v1/process-templates', { ...M, method: 'POST', body: { name: 'Mine', steps: [{ name: 'One' }] } });
check('templates are validated (dropdown options, assignee); only process designers create them', badDrop.status === 400 && badUser.status === 400 && mgrTpl.status === 403, [badDrop.body, badUser.body, mgrTpl.status]);
const tpl = await call('/api/v1/process-templates', { ...A, method: 'POST', body: { name: 'Vastu audit delivery', description: 'From payment to report', trigger: 'won', steps } });
check('admin designs a 3-step after-sale process', tpl.status === 201 && tpl.body.steps.length === 3 && tpl.body.steps[1].minPaymentPct === 50, tpl.body);
const tplList = (await call('/api/v1/process-templates', R)).body;
check('the RM sees the business line’s processes (read-only)', tplList.length === 1 && tplList[0].canManage === false, tplList);

// ── Winning the lead starts the process ──
const q2 = await call(`/api/v1/leads/${lead.id}/quotes`, { ...R, method: 'POST', body: { items: [{ packageId: audit.body.id }] } });
await call(`/api/v1/quotes/${q2.body.id}/send`, { ...R, method: 'POST', body: {} });
const accepted = await call(`/api/v1/quotes/${q2.body.id}/accept`, { ...R, method: 'POST', body: { markWon: true } });
check('accepting the quote marks the lead won and starts the process', accepted.status === 201 && accepted.body.won && accepted.body.processRunIds.length === 1, accepted.body);
let proc = (await call(`/api/v1/leads/${lead.id}/processes`, R)).body;
let run = proc.runs[0];
check('the run carries the quote value; step 1 is with the lead owner', run.dealValuePaise === q2.body.totalPaise && run.steps[0].status === 'active' && run.steps[0].assigneeId === ARJUN && run.steps[1].status === 'pending', run);

const s1 = run.steps[0].id, s2 = run.steps[1].id, s3 = run.steps[2].id;
const early = await call(`/api/v1/process-steps/${s2}/complete`, { ...R, method: 'POST', body: {} });
check('later steps wait for earlier ones', early.status === 400 && early.body.code === 'STEP_NOT_STARTED', early.body);
const missing = await call(`/api/v1/process-steps/${s1}/complete`, { ...R, method: 'POST', body: { data: { notes: 'Called' } } });
check('required step fields must be filled', missing.status === 400 && /Preferred visit date/.test(missing.body.message), missing.body);
const badDate = await call(`/api/v1/process-steps/${s1}`, { ...R, method: 'PUT', body: { data: { preferred_date: 'soon' } } });
const saved = await call(`/api/v1/process-steps/${s1}`, { ...R, method: 'PUT', body: { data: { preferred_date: '2026-10-25', junk: 'x' } } });
check('step data is typed and only the step’s own fields are kept', badDate.status === 400 && saved.status === 200 && saved.body.data.preferred_date === '2026-10-25' && !('junk' in saved.body.data), [badDate.body, saved.body]);
const done1 = await call(`/api/v1/process-steps/${s1}/complete`, { ...R, method: 'POST', body: {} });
proc = (await call(`/api/v1/leads/${lead.id}/processes`, R)).body; run = proc.runs[0];
check('completing a step locks it and hands over to the next owner (by role)', done1.status === 201 && run.steps[0].status === 'done' && run.steps[0].locked && run.steps[1].status === 'active' && run.steps[1].assigneeId === NEHA, run.steps);
const editLocked = await call(`/api/v1/process-steps/${s1}`, { ...R, method: 'PUT', body: { data: { notes: 'changed' } } });
check('a completed step cannot be edited', editLocked.status === 400 && editLocked.body.code === 'STEP_LOCKED', editLocked.body);
const bell = (await call('/api/v1/notifications', M)).body;
check('the next step owner is notified', bell.items.some((n) => /Site visit/.test(n.title)), bell.items.map((n) => n.title));

// Payment gate (50%)
const gate = await call(`/api/v1/process-steps/${s2}/complete`, { ...M, method: 'POST', body: { data: { visit_done: true, zone: 'E' } } });
check('a step with a payment gate waits for the money', gate.status === 400 && /50%/.test(gate.body.message), gate.body);
const token = await call(`/api/v1/leads/${lead.id}/payments`, { ...R, method: 'POST', body: { amountPaise: 500_000, kind: 'token', mode: 'upi', reference: 'UPI123' } });
const wrong = await call(`/api/v1/leads/${lead.id}/payments`, { ...R, method: 'POST', body: { amountPaise: 1_000_000, kind: 'instalment', mode: 'cash' } });
check('payments are recorded on the running process', token.status === 201 && token.body.runId === run.id && wrong.status === 201, [token.body, wrong.body]);
const rmVoid = await call(`/api/v1/payments/${wrong.body.id}/void`, { ...R, method: 'POST', body: { reason: 'Entered twice' } });
proc = (await call(`/api/v1/leads/${lead.id}/processes`, R)).body; run = proc.runs[0];
check('a wrong entry is voided (kept, not counted); balance updates', rmVoid.status === 201 && run.receivedPaise === 500_000 && run.balancePaise === run.dealValuePaise - 500_000 && proc.payments.some((p) => p.id === wrong.body.id && p.isVoided), [rmVoid.body, run.receivedPaise]);
const gate2 = await call(`/api/v1/process-steps/${s2}/complete`, { ...M, method: 'POST', body: { data: { visit_done: true, zone: 'E' } } });
await call(`/api/v1/leads/${lead.id}/payments`, { ...R, method: 'POST', body: { amountPaise: 1_000_000, kind: 'instalment', mode: 'bank' } });
const done2 = await call(`/api/v1/process-steps/${s2}/complete`, { ...M, method: 'POST', body: { data: { visit_done: true, zone: 'E' } } });
proc = (await call(`/api/v1/leads/${lead.id}/processes`, R)).body; run = proc.runs[0];
check('once 50% is in, the step completes', gate2.status === 400 && done2.status === 201 && run.paidPct >= 50 && run.steps[2].status === 'active', [gate2.body, done2.body, run.paidPct]);

// Step access per role
check('the RM can only view the sign-off step', run.steps[2].access === 'view' && run.steps[0].access === 'edit', run.steps.map((s) => s.access));
const rmEdit = await call(`/api/v1/process-steps/${s3}`, { ...R, method: 'PUT', body: { data: { report_url: 'https://x.y' } } });
check('…and cannot change it', rmEdit.status === 403 && rmEdit.body.code === 'STEP_ACCESS', rmEdit.body);

// Unlock with a reason
const rmUnlock = await call(`/api/v1/process-steps/${s1}/unlock`, { ...R, method: 'POST', body: { reason: 'Wrong date' } });
const noReason = await call(`/api/v1/process-steps/${s1}/unlock`, { ...M, method: 'POST', body: { reason: '' } });
const unlock = await call(`/api/v1/process-steps/${s1}/unlock`, { ...M, method: 'POST', body: { reason: 'Customer moved the visit date' } });
const fix = await call(`/api/v1/process-steps/${s1}`, { ...R, method: 'PUT', body: { data: { preferred_date: '2026-10-27' } } });
const redo = await call(`/api/v1/process-steps/${s1}/complete`, { ...R, method: 'POST', body: {} });
proc = (await call(`/api/v1/leads/${lead.id}/processes`, R)).body; run = proc.runs[0];
check('unlocking needs the unlock right and a reason; the step is fixed and re-locked', rmUnlock.status === 403 && noReason.status === 400 && unlock.status === 201 && fix.status === 200 && redo.status === 201 && run.steps[0].locked && run.steps[0].data.preferred_date === '2026-10-27' && run.steps[2].status === 'active', [rmUnlock.status, noReason.status, unlock.body, run.steps]);
const logs = (await call('/api/v1/audit-logs', { token: admin })).body;
check('unlocking is audited with the reason', logs.some((l) => l.action === 'process.step_unlocked' && l.newValue?.reason === 'Customer moved the visit date'), logs.slice(0, 5).map((l) => l.action));

// Send back to an earlier step
const badBack = await call(`/api/v1/process-runs/${run.id}/send-back`, { ...M, method: 'POST', body: { toStepRunId: s3, reason: 'Same step' } });
const back = await call(`/api/v1/process-runs/${run.id}/send-back`, { ...M, method: 'POST', body: { toStepRunId: s2, reason: 'Photos of the kitchen missing' } });
proc = (await call(`/api/v1/leads/${lead.id}/processes`, R)).body; run = proc.runs[0];
check('send back to an earlier step with a reason; later steps wait again', badBack.status === 400 && back.status === 201 && run.steps[1].status === 'active' && !run.steps[1].locked && run.steps[1].sentBackCount === 1 && run.steps[2].status === 'pending' && run.steps[1].data.zone === 'E', [badBack.body, run.steps]);
await call(`/api/v1/process-steps/${s2}/complete`, { ...M, method: 'POST', body: {} });

// Sign-off approval (no self-approval below organization level)
const submit = await call(`/api/v1/process-steps/${s3}/complete`, { ...M, method: 'POST', body: { data: { report_url: 'https://reports.example.com/r1' } } });
proc = (await call(`/api/v1/leads/${lead.id}/processes`, R)).body; run = proc.runs[0];
check('a sign-off step waits for approval', submit.status === 201 && submit.body.status === 'awaiting_approval' && run.steps[2].status === 'awaiting_approval', [submit.body, run.steps[2]]);
const self = await call(`/api/v1/approvals/${submit.body.approvalId}/decide`, { ...M, method: 'POST', body: { decision: 'approve' } });
check('nobody approves their own request (below organization level)', self.status === 403 && self.body.code === 'SELF_APPROVAL', self.body);
const rejectStep = await call(`/api/v1/approvals/${submit.body.approvalId}/decide`, { ...A, method: 'POST', body: { decision: 'reject', note: 'Add the remedies section' } });
proc = (await call(`/api/v1/leads/${lead.id}/processes`, R)).body; run = proc.runs[0];
check('a rejected sign-off goes back to the step owner', rejectStep.status === 201 && run.steps[2].status === 'active' && run.steps[2].approval.status === 'rejected', run.steps[2]);
const submit2 = await call(`/api/v1/process-steps/${s3}/complete`, { ...M, method: 'POST', body: { data: { report_url: 'https://reports.example.com/r2' } } });
const approveStep = await call(`/api/v1/approvals/${submit2.body.approvalId}/decide`, { ...A, method: 'POST', body: { decision: 'approve' } });
proc = (await call(`/api/v1/leads/${lead.id}/processes`, R)).body; run = proc.runs[0];
check('approval completes the last step and the process', approveStep.status === 201 && run.status === 'completed' && run.steps.every((s) => s.status === 'done'), run);
const rate = await call(`/api/v1/process-runs/${run.id}/rating`, { ...R, method: 'POST', body: { rating: 5, note: 'Very happy' } });
const leadAfter = (await call(`/api/v1/leads/${lead.id}`, R)).body;
check('the customer’s rating is recorded on the process and the lead', rate.status === 201 && leadAfter.rating === 5, [rate.body, leadAfter.rating]);
const restart = await call(`/api/v1/leads/${lead.id}/processes`, { ...R, method: 'POST', body: { templateId: tpl.body.id } });
check('a process can be started again by hand once the previous one is complete', restart.status === 201, restart.body);
const dupStart = await call(`/api/v1/leads/${lead.id}/processes`, { ...R, method: 'POST', body: { templateId: tpl.body.id } });
check('…but not twice at the same time', dupStart.status === 400 && dupStart.body.code === 'ALREADY_RUNNING', dupStart.body);
const rmCancel = await call(`/api/v1/process-runs/${restart.body.id}/cancel`, { ...R, method: 'POST', body: { reason: 'Started by mistake' } });
const cancel = await call(`/api/v1/process-runs/${restart.body.id}/cancel`, { ...M, method: 'POST', body: { reason: 'Started by mistake' } });
check('managers cancel a process with a reason', rmCancel.status === 403 && cancel.status === 201, [rmCancel.status, cancel.body]);

// Board & report
const board = (await call('/api/v1/process-runs?status=all', R)).body;
check('the process board lists runs in the person’s scope', board.some((r) => r.id === run.id && r.status === 'completed' && r.doneSteps === 3), board);
const mine = (await call('/api/v1/process-runs?mine=true', M)).body;
check('“my steps” shows runs waiting on me', Array.isArray(mine), mine);
const csv = await fetch(`${API}/api/v1/process-runs/report.csv?status=all`, { headers: { 'X-Tenant': 'mycompany', Authorization: `Bearer ${admin}`, 'X-Workspace': VASTU } });
const csvText = await csv.text();
check('process report exports as CSV (steps, payments, rating)', csv.status === 200 && csvText.startsWith('Process,Customer') && /Vastu audit delivery/.test(csvText) && /Report & sign-off: done/.test(csvText), csvText.slice(0, 300));
const rmCsv = await call('/api/v1/process-runs/report.csv', R);
check('people without export rights cannot download it', rmCsv.status === 403, rmCsv.status);

// ── Lead team ──
await call(`/api/v1/users/${SIMRAN}/roles`, { token: admin, method: 'PUT', body: { roles: [{ roleId: RM_ROLE, workspaceId: COURSE }, { roleId: RM_ROLE, workspaceId: VASTU }] } });
const simran = await login('rm2@mycompany.local');
const S = { token: simran, workspace: VASTU };
const before = await call(`/api/v1/leads/${lead2.id}`, S);
const add = await call(`/api/v1/leads/${lead2.id}/team`, { ...R, method: 'POST', body: { userId: SIMRAN, roleLabel: 'Designer' } });
const addOwner = await call(`/api/v1/leads/${lead2.id}/team`, { ...R, method: 'POST', body: { userId: ARJUN, roleLabel: 'Owner' } });
const during = await call(`/api/v1/leads/${lead2.id}`, S);
const team = (await call(`/api/v1/leads/${lead2.id}/team`, R)).body;
check('adding someone to the lead team lets them open the lead', before.status === 404 && add.status === 201 && addOwner.status === 400 && during.status === 200 && team.some((t) => t.name.startsWith('Simran') && t.roleLabel === 'Designer'), [before.status, add.body, during.status, team]);
await call(`/api/v1/leads/${lead2.id}/team/${add.body.id}/remove`, { ...R, method: 'POST' });
const after = await call(`/api/v1/leads/${lead2.id}`, S);
check('removing them takes the access away again (history kept)', after.status === 404, after.status);

// ── Accepting new leads & temporary cover ──
await call(`/api/v1/workspaces/${VASTU}/assignment`, { ...A, method: 'PUT', body: { mode: 'round_robin', userIds: [ARJUN, SIMRAN], sticky: false } });
const paused = await call('/api/v1/me/accepting-leads', { token: simran, method: 'PUT', body: { accepting: false } });
const mk = (n) => call('/api/v1/leads', { ...A, method: 'POST', body: { name: `RR Test ${n}`, mobile: `98100777${10 + n}`, ownerId: 'rules', customFields: { property_type: 'Home' } } });
const rr = [await mk(1), await mk(2)];
check('people who stop accepting new leads are skipped by round-robin', paused.status === 200 && rr.every((r) => r.status === 201 && r.body.ownerId === ARJUN), rr.map((r) => [r.status, r.body.ownerId]));
await call('/api/v1/me/accepting-leads', { token: simran, method: 'PUT', body: { accepting: true } });
const now = Date.now();
const rmForOther = await call('/api/v1/covers', { token: rm, method: 'POST', body: { userId: NEHA, coverUserId: SIMRAN, startsAt: new Date(now).toISOString(), endsAt: new Date(now + 86_400_000).toISOString() } });
const cover = await call('/api/v1/covers', { token: rm, method: 'POST', body: { coverUserId: SIMRAN, startsAt: new Date(now - 60_000).toISOString(), endsAt: new Date(now + 2 * 86_400_000).toISOString(), note: 'On leave' } });
const overlap = await call('/api/v1/covers', { token: rm, method: 'POST', body: { coverUserId: NEHA, startsAt: new Date(now + 3_600_000).toISOString(), endsAt: new Date(now + 7_200_000).toISOString() } });
check('people set their own cover (no overlaps; others need user-management rights)', rmForOther.status === 403 && cover.status === 201 && overlap.status === 400, [rmForOther.status, cover.body, overlap.body]);
const covering = await call(`/api/v1/leads/${lead2.id}`, S);
await call(`/api/v1/workspaces/${VASTU}/assignment`, { ...A, method: 'PUT', body: { mode: 'fixed', userIds: [ARJUN], sticky: false } });
const whileAway = await mk(3);
check('while Arjun is away, Simran sees his leads and receives his new ones', covering.status === 200 && whileAway.body.ownerId === SIMRAN, [covering.status, whileAway.body.ownerId]);
const avail = (await call('/api/v1/me/availability', { token: simran })).body;
check('the cover shows for both people', avail.covers.some((c) => c.userId === ARJUN && c.isActive), avail);
await call(`/api/v1/covers/${cover.body.id}/cancel`, { token: rm, method: 'POST' });
const back2 = await mk(4);
const notCovering = await call(`/api/v1/leads/${lead2.id}`, S);
check('ending the cover restores normal assignment and access', back2.body.ownerId === ARJUN && notCovering.status === 404, [back2.body.ownerId, notCovering.status]);
await call(`/api/v1/workspaces/${VASTU}/assignment`, { ...A, method: 'PUT', body: { mode: 'round_robin', userIds: [], sticky: true } });

// ── Payment rules ──
const rmRules = await call(`/api/v1/workspaces/${VASTU}/payment-rules`, { ...R, method: 'PUT', body: { rules: [] } });
const rules = await call(`/api/v1/workspaces/${VASTU}/payment-rules`, { ...A, method: 'PUT', body: { rules: [
  { name: 'Remedies kit is an add-on', packageIds: [kit.body.id], action: 'instalment' },
  { name: '₹20,000 or more is a new sale', minAmountPaise: 2_000_000, action: 'new_sale' },
  { name: 'Smaller amounts are instalments', maxAmountPaise: 1_999_999, action: 'instalment' },
] } });
check('managers of products set payment rules', rmRules.status === 403 && rules.status === 200, [rmRules.status, rules.body]);
const sale = await call('/api/v1/payments/incoming', { ...A, method: 'POST', body: { mobile: '9810088801', name: 'Ritu Malhotra', amountPaise: 2_500_000, mode: 'online', reference: 'pay_001' } });
check('a large payment from a new customer opens a won lead and starts its process', sale.status === 201 && sale.body.action === 'new_sale' && !!sale.body.leadId && !!sale.body.runId && /20,000/.test(sale.body.rule), sale.body);
const inst = await call('/api/v1/payments/incoming', { ...A, method: 'POST', body: { mobile: '+91 98100 88801', amountPaise: 500_000, mode: 'online', reference: 'pay_002' } });
check('a smaller payment from the same customer is attached as an instalment', inst.status === 201 && inst.body.action === 'instalment' && inst.body.runId === sale.body.runId, inst.body);
const addon = await call('/api/v1/payments/incoming', { ...A, method: 'POST', body: { mobile: '9810088801', amountPaise: 3_000_000, packageId: kit.body.id, mode: 'online' } });
check('product rules come first (a big add-on payment is still an instalment)', addon.body.action === 'instalment' && addon.body.runId === sale.body.runId, addon.body);
const orphan = await call('/api/v1/payments/incoming', { ...A, method: 'POST', body: { mobile: '9810088802', name: 'New Person', amountPaise: 100_000, mode: 'cash' } });
check('an instalment with nothing running becomes a new sale (flagged)', orphan.body.action === 'new_sale' && orphan.body.fallback === true, orphan.body);
const saleProc = (await call(`/api/v1/leads/${sale.body.leadId}/processes`, A)).body;
check('the new sale’s process counts every payment', saleProc.runs[0].receivedPaise === 6_000_000, saleProc.runs[0]);
const noName = await call('/api/v1/payments/incoming', { ...A, method: 'POST', body: { mobile: '9810088803', amountPaise: 2_500_000 } });
check('a new customer needs a name', noName.status === 400 && noName.body.code === 'NAME_REQUIRED', noName.body);

// ── Setup Guide ──
const guide = (await call('/api/v1/setup-guide', { token: admin })).body;
const gstep = (id) => guide.guides.flatMap((x) => x.cards.flatMap((c) => c.steps)).find((x) => x.id === id);
check('Setup Guide: products and process steps are live and tick themselves off', gstep('products').done && gstep('products').href === '/app/products' && gstep('process_templates').done && gstep('process_templates').href === '/app/processes' && gstep('labels').available !== false, [gstep('products'), gstep('process_templates'), gstep('labels')]);

// ── Isolation ──
const abcQuote = await call(`/api/v1/quotes/${q2.body.id}`, { token: abc, tenant: 'abc' });
const abcTpl = (await call('/api/v1/process-runs?status=all', { token: abc, tenant: 'abc' })).body;
const abcApprovals = (await call('/api/v1/approvals?status=all', { token: abc, tenant: 'abc' })).body;
check('another organization sees none of it', abcQuote.status === 404 && Array.isArray(abcTpl) && abcTpl.length === 0 && abcApprovals.items.length === 0, [abcQuote.status, abcTpl, abcApprovals]);

await call(`/api/v1/users/${SIMRAN}/roles`, { token: admin, method: 'PUT', body: { roles: [{ roleId: RM_ROLE, workspaceId: COURSE }] } });

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll process & deals checks passed');
process.exit(failures ? 1 : 0);
