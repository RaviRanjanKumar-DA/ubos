/**
 * Rich demo data on top of the basic seed: ~150 leads for "My Company" and ~40 for "ABC Group", spread over the last
 * 60 days with realistic stages, statuses, sources, owners, calls, remarks, follow-ups, custom fields, lost reasons,
 * custom actions and an import. Deterministic (same data every run). Development only.
 * Usage: npm run db:demo   (runs the basic seed first, then this)
 */
import { PrismaClient } from '@prisma/client';
import { normalizeMobile } from '@ubos/shared';

const prisma = new PrismaClient();

// Small deterministic random generator so the demo is identical every time.
let seed = 20261017;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
const chance = (p: number) => rnd() < p;
// Past dates never land later than now (today at 5 pm would be in the future in the morning).
const daysAgo = (d: number, hour = 9 + Math.floor(rnd() * 9)) => {
  const x = new Date(); x.setDate(x.getDate() - d); x.setHours(hour, Math.floor(rnd() * 60), 0, 0);
  return d >= 0 && x > new Date() ? new Date(Date.now() - (5 + Math.floor(rnd() * 120)) * 60_000) : x;
};

const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Krishna', 'Ishaan', 'Rohan', 'Ananya', 'Diya', 'Saanvi', 'Aadhya', 'Kavya', 'Pooja', 'Neha', 'Riya', 'Sneha', 'Priyanka', 'Rahul', 'Amit', 'Suresh', 'Deepak', 'Manish', 'Sunita', 'Meena', 'Rekha', 'Vikas', 'Nikhil', 'Harsh', 'Tanvi', 'Kiran', 'Gaurav', 'Ritu'];
const LAST = ['Sharma', 'Verma', 'Gupta', 'Agarwal', 'Singh', 'Kumar', 'Mehta', 'Jain', 'Patel', 'Shah', 'Reddy', 'Nair', 'Iyer', 'Malhotra', 'Kapoor', 'Chopra', 'Bansal', 'Mittal', 'Saxena', 'Joshi', 'Batra', 'Khanna', 'Arora', 'Sethi'];
const CITIES = ['Delhi', 'Gurugram', 'Noida', 'Mumbai', 'Pune', 'Jaipur', 'Lucknow', 'Bengaluru', 'Chandigarh', 'Indore', 'Ahmedabad', 'Hyderabad'];
const REMARKS = [
  'Asked for fee details on WhatsApp', 'Wants a call back in the evening', 'Comparing with another provider', 'Interested, discussing with family',
  'Requested brochure', 'Budget is a concern, may join next month', 'Very keen, wants to start soon', 'Asked for EMI option',
  'Will visit the office on Saturday', 'Needs a demo first', 'Referred by an existing customer', 'Not picking up, try tomorrow',
];
const SOURCE_WEIGHTS = ['facebook', 'facebook', 'facebook', 'instagram', 'website', 'website', 'google_ads', 'whatsapp', 'whatsapp', 'referral', 'google_sheets', 'justdial', 'indiamart', 'walk_in'];

async function ownersOf(tenantId: string, workspaceId: string) {
  const users = await prisma.user.findMany({
    where: { tenantId, isActive: true, roles: { some: { OR: [{ workspaceId }, { workspaceId: null }], role: { permissions: { some: { isDeny: false, permission: { key: 'crm.lead.update' } } } } } } },
    select: { id: true, name: true },
  });
  // RMs carry most leads; admins a few.
  return users.flatMap((u) => (/RM|Manager/.test(u.name) ? [u.id, u.id, u.id] : [u.id]));
}

function fieldValues(template: string | null, fields: { key: string; type: string; options: string[] }[]) {
  const v: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type === 'dropdown') v[f.key] = pick(f.options);
    else if (f.type === 'multiselect') v[f.key] = f.options.filter(() => chance(0.4)).slice(0, 3);
    else if (f.type === 'currency') v[f.key] = pick([15000, 25000, 40000, 60000, 99000]);
    else if (f.type === 'date') v[f.key] = daysAgo(-Math.floor(rnd() * 20)).toISOString().slice(0, 10);
    else if (f.key === 'city') v[f.key] = pick(CITIES);
    else if (f.key === 'business_type') v[f.key] = pick(['Bakery', 'Clinic', 'Boutique', 'Startup', 'Restaurant', 'Coaching centre', 'Real estate agency']);
    else if (f.type === 'text') v[f.key] = pick(['Yes', 'Needs details', 'Later']);
  }
  if (Array.isArray(v.services) && !(v.services as string[]).length) v.services = ['Logo'];
  return v;
}

async function fillWorkspace(tenantId: string, workspaceId: string, count: number, nextCode: () => Promise<string>) {
  const ws = await prisma.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    include: { pipelines: { orderBy: { position: 'asc' }, include: { stages: { orderBy: { position: 'asc' } } } }, fields: true, options: true },
  });
  const owners = await ownersOf(tenantId, workspaceId);
  const pipeline = ws.pipelines[0];
  const open = pipeline.stages.filter((s) => !s.isWon && !s.isLost);
  const won = pipeline.stages.find((s) => s.isWon)!;
  const lost = pipeline.stages.find((s) => s.isLost)!;
  const dispositions = ws.options.filter((o) => o.kind === 'call_disposition');
  const lostReasons = ws.options.filter((o) => o.kind === 'lost_reason');
  const statuses = ws.options.filter((o) => o.kind === 'lead_status').map((o) => o.value);
  const sources = new Set(ws.options.filter((o) => o.kind === 'lead_source').map((o) => o.value));

  for (let i = 0; i < count; i++) {
    const age = Math.floor(rnd() ** 1.4 * 60); // more recent leads than old ones
    const createdAt = daysAgo(age);
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    const mobile = normalizeMobile(`9${String(Math.floor(100000000 + rnd() * 899999999))}`)!;
    if (await prisma.customer.findFirst({ where: { tenantId, mobile } })) continue;
    const customer = await prisma.customer.create({
      data: { tenantId, code: await nextCode(), name, mobile, email: chance(0.55) ? `${name.toLowerCase().replace(' ', '.')}${i}@example.com` : null, city: pick(CITIES), createdAt },
    });

    // Funnel: older leads are further along; ~12% won, ~18% lost.
    const roll = rnd();
    const stage = age > 7 && roll < 0.12 ? won : age > 4 && roll < 0.3 ? lost : open[Math.min(open.length - 1, Math.floor(rnd() * Math.min(open.length, 1 + age / 6)))];
    const ownerId = chance(0.06) ? null : pick(owners);
    const contacted = stage.position > 0 || chance(0.5);
    const calls = contacted ? 1 + Math.floor(rnd() * 4) : 0;
    const source = [...sources].includes('facebook') ? pick(SOURCE_WEIGHTS.filter((s) => sources.has(s))) : pick([...sources]);
    const followUp = stage.isWon || stage.isLost ? null : chance(0.25) ? daysAgo(Math.floor(rnd() * 4) + 1, 11) : chance(0.3) ? daysAgo(0, 15 + Math.floor(rnd() * 4)) : chance(0.6) ? daysAgo(-1 - Math.floor(rnd() * 7), 11) : null;
    const stageChangedAt = daysAgo(Math.max(0, age - Math.floor(rnd() * (age + 1))));
    const lastCallAt = calls ? daysAgo(Math.max(0, Math.floor(rnd() * Math.max(1, age)))) : null;
    const lastDisp = calls ? pick(dispositions).value : null;

    const lead = await prisma.lead.create({
      data: {
        tenantId, workspaceId, pipelineId: pipeline.id, stageId: stage.id, customerId: customer.id, source, ownerId,
        assignedAt: ownerId ? createdAt : null, createdAt, stageChangedAt,
        status: stage.isWon ? null : stage.isLost ? 'cold' : pick(statuses), lostReason: stage.isLost && lostReasons.length ? pick(lostReasons).value : null,
        customFields: fieldValues(ws.template, ws.fields.filter((f) => !f.isArchived)), score: Math.floor(rnd() * 40),
        firstResponseAt: calls ? new Date(createdAt.getTime() + (5 + Math.floor(rnd() * 600)) * 60_000) : null,
        lastActivityAt: lastCallAt, lastDisposition: lastDisp, nextFollowUpAt: followUp,
      },
    });
    if (ownerId) await prisma.customer.update({ where: { id: customer.id }, data: { primaryRmId: ownerId } });

    const acts = [];
    for (let c = 0; c < calls; c++) {
      const d = pick(dispositions);
      acts.push({ tenantId, workspaceId, leadId: lead.id, type: 'call', disposition: d.value, connected: d.connected, durationSec: d.connected ? 60 + Math.floor(rnd() * 600) : 0, remark: d.connected && chance(0.7) ? pick(REMARKS) : null, userId: ownerId, createdAt: daysAgo(Math.max(0, age - c)) });
    }
    if (chance(0.4)) acts.push({ tenantId, workspaceId, leadId: lead.id, type: 'remark', remark: pick(REMARKS), userId: ownerId, createdAt: daysAgo(Math.max(0, age - 1)) });
    if (stage.position > 0) acts.push({ tenantId, workspaceId, leadId: lead.id, type: 'stage', data: { from: pipeline.stages[0].id, to: stage.id }, userId: ownerId, createdAt: stageChangedAt });
    if (acts.length) await prisma.leadActivity.createMany({ data: acts });
    if (followUp && ownerId) await prisma.followUp.create({ data: { tenantId, leadId: lead.id, dueAt: followUp, userId: ownerId, createdById: ownerId, note: pick(['Call back as promised', 'Share fee details', 'Confirm visit', 'Check decision']) } });
    // Earlier follow-ups already handled — most on the day, some late — for follow-up discipline reports.
    if (ownerId && calls && age >= 2) {
      for (let k = 0; k < 1 + Math.floor(rnd() * 2); k++) {
        const dueAt = daysAgo(1 + Math.floor(rnd() * (age - 1)), 10 + Math.floor(rnd() * 6));
        const doneAt = new Date(dueAt.getTime() + (chance(0.72) ? 30 + Math.floor(rnd() * 300) : 1440 + Math.floor(rnd() * 2880)) * 60_000);
        await prisma.followUp.create({ data: { tenantId, leadId: lead.id, dueAt, doneAt: doneAt < new Date() ? doneAt : new Date(), outcome: 'Done', userId: ownerId, createdById: ownerId, note: 'Follow-up call' } });
      }
    }
  }
}

async function main() {
  const own = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'mycompany' } });
  const abc = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'abc' } });
  const codeMaker = (tenantId: string) => async () => {
    const last = await prisma.customer.findFirst({ where: { tenantId }, orderBy: { code: 'desc' }, select: { code: true } });
    return `C${String(Number(last?.code.replace(/\D/g, '') ?? 0) + 1).padStart(5, '0')}`;
  };

  const wsOwn = await prisma.workspace.findMany({ where: { tenantId: own.id }, orderBy: { name: 'asc' } });
  // Deal value per business line (pipeline value and forecasts): Logo uses its Budget field, the others get a Deal value field.
  for (const w of await prisma.workspace.findMany({ where: { tenantId: { in: [own.id, abc.id] } } })) {
    const budget = await prisma.leadField.findFirst({ where: { workspaceId: w.id, key: 'budget' } });
    if (!budget) {
      const position = await prisma.leadField.count({ where: { workspaceId: w.id } });
      await prisma.leadField.create({ data: { tenantId: w.tenantId, workspaceId: w.id, key: 'deal_value', label: 'Deal value', type: 'currency', options: [], required: false, position } });
    }
    await prisma.workspace.update({ where: { id: w.id }, data: { valueFieldKey: budget ? 'budget' : 'deal_value' } });
  }
  for (const w of wsOwn) await fillWorkspace(own.id, w.id, 50, codeMaker(own.id));
  for (const w of await prisma.workspace.findMany({ where: { tenantId: abc.id } })) await fillWorkspace(abc.id, w.id, 20, codeMaker(abc.id));

  // Stage rules on the Vastu consultation pipeline, so the stage board shows them in use.
  const vastu = wsOwn.find((w) => w.name.startsWith('Vastu'))!;
  const consult = await prisma.pipeline.findFirstOrThrow({ where: { workspaceId: vastu.id }, orderBy: { position: 'asc' }, include: { stages: true } });
  const by = (n: string) => consult.stages.find((s) => s.name === n);
  if (by('Contacted')) await prisma.leadStage.update({ where: { id: by('Contacted')!.id }, data: { slaDays: 2 } });
  if (by('Interested')) await prisma.leadStage.update({ where: { id: by('Interested')!.id }, data: { slaDays: 5, setStatus: 'hot', followUpDays: 1 } });
  if (by('Negotiation')) await prisma.leadStage.update({ where: { id: by('Negotiation')!.id }, data: { requiredFieldKeys: ['site_visit_date'], slaDays: 7 } });

  // Custom actions with answers on some leads.
  const admin = await prisma.user.findFirstOrThrow({ where: { tenantId: own.id, email: 'admin@mycompany.local' } });
  const course = wsOwn.find((w) => w.name.startsWith('Course'))!;
  const actions = [
    { code: 1001, name: 'Course Details', workspaceId: course.id, score: 10, description: 'Capture course preference and budget',
      fields: [{ key: 'mode', label: 'Preferred mode', type: 'dropdown', options: ['Online', 'Offline', 'Hybrid'], required: true }, { key: 'budget', label: 'Budget', type: 'currency', options: [], required: false }, { key: 'start', label: 'Wants to start', type: 'dropdown', options: ['This month', 'Next month', 'Later'], required: true }] },
    { code: 1002, name: 'Site visit report', workspaceId: vastu.id, score: 20, description: 'After a Vastu site visit',
      fields: [{ key: 'visited_on', label: 'Visited on', type: 'date', options: [], required: true }, { key: 'issues', label: 'Main issues found', type: 'textarea', options: [], required: true }, { key: 'quote_shared', label: 'Quote shared', type: 'checkbox', options: [], required: false }] },
    { code: 1003, name: 'Qualification check', workspaceId: null, score: 15, description: 'BANT: budget, authority, need, timeline',
      fields: [{ key: 'budget_ok', label: 'Budget confirmed', type: 'checkbox', options: [], required: false }, { key: 'decision_maker', label: 'Talking to decision maker', type: 'checkbox', options: [], required: false }, { key: 'timeline', label: 'Timeline', type: 'dropdown', options: ['Immediate', '1–3 months', 'Later'], required: true }] },
  ];
  for (const a of actions) await prisma.customAction.create({ data: { tenantId: own.id, createdById: admin.id, ...a } });
  const courseAction = await prisma.customAction.findFirstOrThrow({ where: { tenantId: own.id, code: 1001 } });
  const courseLeads = await prisma.lead.findMany({ where: { workspaceId: course.id, lastActivityAt: { not: null } }, take: 12 });
  const labels = Object.fromEntries((courseAction.fields as { key: string; label: string }[]).map((f) => [f.key, f.label]));
  for (const l of courseLeads) {
    const answers = { mode: pick(['Online', 'Offline', 'Hybrid']), budget: pick([15000, 25000, 40000]), start: pick(['This month', 'Next month']) };
    await prisma.leadActionResponse.create({ data: { tenantId: own.id, workspaceId: course.id, leadId: l.id, actionId: courseAction.id, answers, score: 10, userId: l.ownerId ?? admin.id } });
    await prisma.leadActivity.create({ data: { tenantId: own.id, workspaceId: course.id, leadId: l.id, type: 'action', data: { actionId: courseAction.id, code: 1001, name: 'Course Details', score: 10, answers, labels }, userId: l.ownerId ?? admin.id } });
    await prisma.lead.update({ where: { id: l.id }, data: { score: { increment: 10 } } });
  }

  // A past upload in the history and a pending order on the billing page.
  await prisma.leadImport.create({ data: { tenantId: own.id, workspaceId: course.id, fileName: 'facebook-leads-sept.xlsx', total: 48, created: 41, linked: 4, skipped: 3, failed: 4, errors: [{ row: 7, message: 'Mobile is missing' }, { row: 19, message: '"98123" is not a valid mobile number' }], createdById: admin.id, createdAt: daysAgo(20) } });
  await prisma.tenantOrder.create({ data: { tenantId: abc.id, number: 'UB-202610-DEMO1', cycle: 'annual', items: [{ productCode: 'core_crm', name: 'Core CRM', kind: 'licence', planCode: 'growth', quantity: 5, unitPaise: 958_800, amountPaise: 4_794_000 }], subtotalPaise: 4_794_000, gstPaise: 862_920, totalPaise: 5_656_920, createdById: (await prisma.user.findFirstOrThrow({ where: { tenantId: abc.id } })).id, createdAt: daysAgo(1) } });

  const [a, b] = await Promise.all([prisma.lead.count({ where: { tenantId: own.id } }), prisma.lead.count({ where: { tenantId: abc.id } })]);
  console.log(`Demo data ready: My Company ${a} leads, ABC Group ${b} leads.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
