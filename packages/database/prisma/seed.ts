/**
 * Development seed. Creates plans, the permission catalogue, a Platform Owner, your own company
 * (Tenant #1, internal) with three business-line workspaces, and a demo customer tenant (ABC Group)
 * used to prove tenant isolation. Dev-only logins are listed in docs/DEV_LOGINS.md.
 * Re-running wipes and recreates all data (development databases only).
 */
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { FEATURES, PERMISSIONS, normalizeMobile } from '@ubos/shared';
import { appendAudit, provisionTenant } from '../src';

const DEV_PASSWORD = 'Ubos@2026dev';
const prisma = new PrismaClient(); // owner connection (DATABASE_URL), bypasses RLS

const PLANS = [
  { code: 'starter', name: 'Starter', price: 49_900, maxWorkspaces: 1, storage: 5, ai: 0, recordings: 30,
    features: ['module.crm', 'module.integrations', 'module.sim_calling'] },
  { code: 'growth', name: 'Growth', price: 99_900, maxWorkspaces: 3, storage: 10, ai: 50, recordings: 90,
    features: ['module.crm', 'module.integrations', 'module.workspaces', 'module.telephony', 'module.sim_calling', 'module.whatsapp', 'module.workflows', 'module.support'] },
  { code: 'business', name: 'Business', price: 149_900, maxWorkspaces: 10, storage: 20, ai: 100, recordings: 180,
    features: ['module.crm', 'module.integrations', 'module.workspaces', 'module.telephony', 'module.sim_calling', 'module.whatsapp', 'module.workflows', 'module.support', 'module.hrms', 'module.finance', 'module.audit_explorer'] },
  { code: 'enterprise', name: 'Enterprise', price: 0, maxWorkspaces: null, storage: 50, ai: 500,
    features: Object.keys(FEATURES) },
];

async function reset() {
  // Audit rows are append-only by trigger; the dev reset disables it briefly.
  await prisma.$executeRawUnsafe('ALTER TABLE "AuditLog" DISABLE TRIGGER audit_append_only');
  const tables: { tablename: string }[] = await prisma.$queryRawUnsafe(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`,
  );
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await prisma.$executeRawUnsafe('ALTER TABLE "AuditLog" ENABLE TRIGGER audit_append_only');
}

async function main() {
  await reset();

  await prisma.permission.createMany({ data: Object.keys(PERMISSIONS).map((key) => ({ key })) });
  for (const p of PLANS) {
    await prisma.plan.create({
      data: {
        code: p.code, name: p.name, pricePerUserPaise: p.price, billingPeriods: ['monthly', 'annual'],
        maxWorkspaces: p.maxWorkspaces, storageGbPerUser: p.storage, aiCreditsPerUser: p.ai, recordingRetentionDays: (p as { recordings?: number }).recordings ?? 365,
        isPublic: p.code !== 'enterprise',
        features: { create: p.features.map((featureKey) => ({ featureKey })) },
      },
    });
  }

  // What the platform sells (Billing & licences). Prices in paise; GST is added at checkout.
  await prisma.platformProduct.createMany({
    data: [
      { code: 'core_crm', name: 'Core CRM', description: 'Leads, customers, calling log, follow-ups, bulk upload, dashboards', kind: 'licence', planCode: 'growth', priceMonthlyPaise: 79_900, annualDiscountPct: 0, position: 0 },
      { code: 'core_crm_whatsapp', name: 'Core CRM + WhatsApp Chat Sync', description: 'Everything in Core CRM plus WhatsApp inbox & templates', kind: 'licence', planCode: 'business', priceMonthlyPaise: 99_900, annualDiscountPct: 0, position: 1 },
      { code: 'whatsapp_setup', name: 'WhatsApp Cloud API setup', description: 'One-time setup of your WhatsApp Business number', kind: 'service', priceOncePaise: 169_400, position: 2 },
      { code: 'automation_consulting', name: 'Automation consultancy', description: 'One hour with an automation expert', kind: 'service', priceOncePaise: 84_700, position: 3 },
      { code: 'data_migration', name: 'Data migration', description: 'We move your leads and customers from Excel or another CRM', kind: 'service', priceOncePaise: 249_900, position: 4 },
    ],
  });

  const owner = await prisma.platformUser.create({
    data: { name: 'Platform Owner', email: 'owner@ubos.local', passwordHash: await bcrypt.hash(DEV_PASSWORD, 10), role: 'owner' },
  });

  // ── Tenant #1: your own company ──
  const own = await prisma.$transaction((tx) =>
    provisionTenant(tx, {
      name: 'My Company', slug: 'mycompany', industry: 'consulting', planCode: 'enterprise', isInternal: true,
      admin: { name: 'Company Admin', email: 'admin@mycompany.local', password: DEV_PASSWORD },
      workspaces: [
        { name: 'Course / Software', template: 'software', pipelines: [{ name: 'Sales' }, { name: 'Renewals', stages: ['Due', 'Contacted', 'Renewed', 'Lost'] }] },
        { name: 'Logo Designing', template: 'design_services' },
        { name: 'Vastu Consultation / Audit', template: 'consulting', pipelines: [{ name: 'Consultation' }, { name: 'Site Audit', stages: ['Requested', 'Scheduled', 'Visited', 'Report Shared', 'Won', 'Lost'] }] },
      ],
      actor: { type: 'platform_user', id: owner.id },
    }),
  );
  const [course, logo, vastu] = own.workspaces;

  // Sample custom lead fields per business line (editable in Workspaces → Settings).
  const fields: [string, { key: string; label: string; type: string; options?: string[]; required?: boolean }[]][] = [
    [course.id, [
      { key: 'course', label: 'Course interested', type: 'dropdown', options: ['Numerology Basic', 'Numerology Advanced', 'Software Licence'], required: true },
      { key: 'preferred_batch', label: 'Preferred batch', type: 'dropdown', options: ['Weekday', 'Weekend', 'Online'] },
    ]],
    [logo.id, [
      { key: 'business_type', label: 'Business type', type: 'text' },
      { key: 'services', label: 'Services needed', type: 'multiselect', options: ['Logo', 'Visiting card', 'Brochure', 'Website'] },
      { key: 'budget', label: 'Budget', type: 'currency' },
    ]],
    [vastu.id, [
      { key: 'property_type', label: 'Property type', type: 'dropdown', options: ['Home', 'Office', 'Shop', 'Factory', 'Plot'], required: true },
      { key: 'city', label: 'City', type: 'text' },
      { key: 'site_visit_date', label: 'Site visit date', type: 'date' },
    ]],
  ];
  for (const [workspaceId, list] of fields) {
    await prisma.leadField.createMany({
      data: list.map((f, position) => ({ tenantId: own.tenant.id, workspaceId, position, options: [], required: false, ...f })),
    });
  }

  const branch = await prisma.branch.create({ data: { tenantId: own.tenant.id, name: 'Head Office' } });
  const dept = await prisma.department.create({ data: { tenantId: own.tenant.id, branchId: branch.id, name: 'Sales' } });
  const vastuTeam = await prisma.team.create({ data: { tenantId: own.tenant.id, departmentId: dept.id, workspaceId: vastu.id, name: 'Vastu Team' } });

  const hash = await bcrypt.hash(DEV_PASSWORD, 10);
  const mkUser = (name: string, email: string, teamId?: string, extra: { username?: string; mobile?: string } = {}) =>
    prisma.user.create({ data: { tenantId: own.tenant.id, name, email, passwordHash: hash, teamId, ...extra } });
  const manager = await mkUser('Neha (Manager)', 'manager@mycompany.local', vastuTeam.id);
  // Arjun can also sign in with username "arjun" or mobile 98765 11111.
  const rmVastu = await mkUser('Arjun (RM)', 'rm@mycompany.local', vastuTeam.id, { username: 'arjun', mobile: '+919876511111' });
  const rmCourse = await mkUser('Simran (RM)', 'rm2@mycompany.local');
  const auditor = await mkUser('Kabir (Auditor)', 'auditor@mycompany.local');

  const assign = (userId: string, role: string, workspaceId: string | null, isPrimary = false) =>
    prisma.userRole.create({ data: { tenantId: own.tenant.id, userId, roleId: own.roles[role], workspaceId, isPrimary } });
  // Multi-role example: Neha is Manager in Vastu and RM in Logo Designing.
  await assign(manager.id, 'Manager', vastu.id, true);
  await assign(manager.id, 'RM', logo.id);
  await assign(rmVastu.id, 'RM', vastu.id, true);
  await assign(rmCourse.id, 'RM', course.id, true);
  await assign(auditor.id, 'Auditor', null, true);

  await seedLeads(own.tenant.id, course.id, [
    ['Rohit Sharma', '9876500001', 'facebook', rmCourse.id],
    ['Priya Verma', '9876500002', 'website', rmCourse.id],
    ['Aman Gupta', '9876500003', 'google_sheets', rmCourse.id],
  ]);
  await seedLeads(own.tenant.id, logo.id, [
    ['Sunrise Bakery', '9876500010', 'whatsapp', manager.id],
    ['Priya Verma', '9876500002', 'referral', manager.id], // same customer as in Course: cross-sell
  ]);
  await seedLeads(own.tenant.id, vastu.id, [
    ['Meera Joshi', '9876500020', 'website', rmVastu.id],
    ['Vikram Rao', '9876500021', 'facebook', rmVastu.id],
    ['Kavita Nair', '9876500022', 'manual', manager.id],
  ]);

  // Lead work examples: statuses, a logged call, follow-ups due today and overdue.
  const vastuLeads = await prisma.lead.findMany({ where: { workspaceId: vastu.id }, include: { customer: true }, orderBy: { createdAt: 'asc' } });
  const today = new Date(); today.setHours(16, 0, 0, 0);
  const yesterday = new Date(today.getTime() - 86_400_000);
  for (const [i, l] of vastuLeads.entries()) {
    const status = ['hot', 'warm', 'cold'][i % 3];
    const due = i === 0 ? today : i === 1 ? yesterday : null;
    await prisma.lead.update({ where: { id: l.id }, data: { status, nextFollowUpAt: due, lastActivityAt: i === 0 ? new Date() : null, firstResponseAt: i === 0 ? new Date() : null, lastDisposition: i === 0 ? 'call_back' : null, assignedAt: l.createdAt } });
    if (i === 0) {
      await prisma.leadActivity.create({ data: { tenantId: own.tenant.id, workspaceId: vastu.id, leadId: l.id, type: 'call', disposition: 'call_back', connected: true, remark: 'Wants a site visit after Diwali, call back in the evening', userId: l.ownerId } });
    }
    if (due) await prisma.followUp.create({ data: { tenantId: own.tenant.id, leadId: l.id, dueAt: due, userId: l.ownerId!, createdById: l.ownerId, note: i === 0 ? 'Call back about site visit' : 'Share consultation fees' } });
  }

  // Duplicate examples for the Customer Master "Duplicates" screen.
  await prisma.customer.update({ where: { tenantId_code: { tenantId: own.tenant.id, code: 'C00002' } }, data: { email: 'priya.verma@example.com', city: 'Delhi' } });
  await prisma.customer.create({
    data: { tenantId: own.tenant.id, code: 'C00009', name: 'Priya Varma', mobile: '+919876500099', email: 'priya.verma@example.com' },
  });
  await prisma.customer.create({ data: { tenantId: own.tenant.id, code: 'C00010', name: 'Rohit Sharmaa', mobile: '+919876500098', city: 'Jaipur' } });
  await prisma.customer.updateMany({ where: { tenantId: own.tenant.id, code: 'C00005' }, data: { primaryRmId: rmVastu.id } });

  // ── Demo customer tenant: ABC Group (Education + Real Estate) ──
  const abc = await prisma.$transaction((tx) =>
    provisionTenant(tx, {
      name: 'ABC Group', slug: 'abc', industry: 'education', planCode: 'growth',
      admin: { name: 'ABC Admin', email: 'admin@abc.local', password: DEV_PASSWORD },
      workspaces: [{ name: 'Education', template: 'education' }, { name: 'Real Estate', template: 'real_estate' }],
      actor: { type: 'platform_user', id: owner.id },
    }),
  );
  await seedLeads(abc.tenant.id, abc.workspaces[0].id, [
    ['Ritu Malhotra', '9811100001', 'facebook', abc.admin.id],
    ['Deepak Yadav', '9811100002', 'website', abc.admin.id],
  ]);
  await seedLeads(abc.tenant.id, abc.workspaces[1].id, [['Sanjay Kapoor', '9811100010', '99acres', abc.admin.id]]);

  console.log('Seed complete: plans, platform owner, tenants "mycompany" and "abc". Logins: docs/DEV_LOGINS.md');
}

async function seedLeads(tenantId: string, workspaceId: string, rows: [string, string, string, string][]) {
  const pipeline = await prisma.pipeline.findFirstOrThrow({ where: { workspaceId }, include: { stages: { orderBy: { position: 'asc' } } } });
  for (const [i, [name, phone, source, ownerId]] of rows.entries()) {
    const mobile = normalizeMobile(phone)!;
    const customer =
      (await prisma.customer.findFirst({ where: { tenantId, mobile } })) ??
      (await prisma.customer.create({
        data: { tenantId, name, mobile, code: `C${String((await prisma.customer.count({ where: { tenantId } })) + 1).padStart(5, '0')}` },
      }));
    const lead = await prisma.lead.create({
      data: {
        tenantId, workspaceId, pipelineId: pipeline.id, stageId: pipeline.stages[i % 4].id,
        customerId: customer.id, source, ownerId,
      },
    });
    await prisma.customer.updateMany({ where: { id: customer.id, primaryRmId: null }, data: { primaryRmId: ownerId } });
    await prisma.$transaction((tx) =>
      appendAudit(tx, { tenantId, workspaceId, actorType: 'system', entity: 'lead', entityId: lead.id, action: 'lead.created', newValue: { name, source } }),
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
