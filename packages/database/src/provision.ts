import bcrypt from 'bcryptjs';
import { ADMIN_ROLE, PERMISSION_KEYS, ROLE_TEMPLATES } from '@ubos/shared';
import type { PrismaClient } from '@prisma/client';
import type { Tx } from './tenant-context';
import { appendAudit } from './audit';

export const STAGE_COLORS = ['#e4e2ec', '#d6e6fb', '#f9e7c5', '#f7d3dc', '#e3d9f7', '#d5efe9', '#fbe0cf', '#dfe8d2'];
export const DEFAULT_STAGES = ['New', 'Contacted', 'Interested', 'Follow-up', 'Demo', 'Negotiation', 'Won', 'Lost'];

// Integrations listed in every tenant's hub; all start inactive so the tenant admin decides what to switch on.
export const INTEGRATION_CATALOGUE = [
  'callerdesk', 'whatsapp', 'whatsapp_widget', 'google_sheets', 'razorpay', 'website_api',
  'facebook_leads', 'indiamart', 'justdial', 'google_meet',
];

export interface WorkspaceInput {
  name: string;
  template?: string;
  pipelines?: { name: string; stages?: string[] }[];
}

export interface ProvisionInput {
  name: string;
  slug: string;
  industry?: string;
  planCode: string;
  isInternal?: boolean;
  admin: { name: string; email: string; password: string };
  workspaces: WorkspaceInput[];
  actor?: { type: 'platform_user' | 'system'; id?: string };
}

/**
 * Keeps the database permission catalogue in step with the code: new permission keys are added, and every
 * tenant's built-in admin role receives them organization-wide. Runs at API startup (platform connection).
 */
export async function syncPermissionCatalog(client: PrismaClient) {
  await client.permission.createMany({ data: PERMISSION_KEYS.map((key) => ({ key })), skipDuplicates: true });
  const perms = await client.permission.findMany({ where: { key: { in: PERMISSION_KEYS } } });
  const adminRoles = await client.role.findMany({ where: { name: ADMIN_ROLE }, select: { id: true } });
  if (!adminRoles.length) return 0;
  const r = await client.rolePermission.createMany({
    data: adminRoles.flatMap((role) => perms.map((p) => ({ roleId: role.id, permissionId: p.id, scope: 'ORGANIZATION' as const }))),
    skipDuplicates: true,
  });
  return r.count;
}

export const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export const DEFAULT_SOURCES: [string, string][] = [
  ['manual', 'Manual entry'], ['website', 'Website'], ['facebook', 'Facebook'], ['instagram', 'Instagram'],
  ['google_ads', 'Google Ads'], ['whatsapp', 'WhatsApp'], ['google_sheets', 'Google Sheets'], ['referral', 'Referral'],
  ['indiamart', 'IndiaMart'], ['justdial', 'JustDial'], ['walk_in', 'Walk-in'], ['cross_sell', 'Cross-sell'],
];
export const DEFAULT_LOST_REASONS = ['Not interested', 'Budget issue', 'Bought elsewhere', 'Not reachable', 'Wrong number', 'Duplicate enquiry'];
export const DEFAULT_STATUSES: [string, string][] = [['fresh', 'Fresh'], ['hot', 'Hot'], ['warm', 'Warm'], ['cold', 'Cold']];
/** [value, label, connected] */
export const DEFAULT_DISPOSITIONS: [string, string, boolean][] = [
  ['connected', 'Connected', true], ['interested', 'Connected – Interested', true], ['not_interested', 'Connected – Not interested', true],
  ['call_back', 'Connected – Call back later', true], ['not_answered', 'Not answered', false], ['busy', 'Busy', false],
  ['switched_off', 'Switched off / Not reachable', false], ['wrong_number', 'Wrong number', false],
];

/** Creates a workspace with its pipelines, stages, lead sources and lost reasons inside an existing tenant. */
export async function createWorkspace(tx: Tx, tenantId: string, w: WorkspaceInput) {
  const workspace = await tx.workspace.create({
    data: { tenantId, name: w.name, slug: slugify(w.name), template: w.template },
  });
  await tx.workspaceOption.createMany({
    data: [
      ...DEFAULT_SOURCES.map(([value, label], position) => ({ tenantId, workspaceId: workspace.id, kind: 'lead_source', value, label, position })),
      ...DEFAULT_LOST_REASONS.map((label, position) => ({ tenantId, workspaceId: workspace.id, kind: 'lost_reason', value: label, label, position })),
      ...DEFAULT_STATUSES.map(([value, label], position) => ({ tenantId, workspaceId: workspace.id, kind: 'lead_status', value, label, position, isDefault: position === 0 })),
      ...DEFAULT_DISPOSITIONS.map(([value, label, connected], position) => ({ tenantId, workspaceId: workspace.id, kind: 'call_disposition', value, label, position, connected, isDefault: value === 'connected' })),
    ],
  });
  for (const [position, p] of (w.pipelines ?? [{ name: 'Sales' }]).entries()) {
    await tx.pipeline.create({
      data: {
        tenantId,
        workspaceId: workspace.id,
        name: p.name,
        position,
        stages: {
          create: (p.stages ?? DEFAULT_STAGES).map((name, position) => ({
            tenantId, name, position, isWon: name === 'Won', isLost: name === 'Lost',
            color: name === 'Won' ? '#cdeed8' : name === 'Lost' ? '#f6d0cb' : STAGE_COLORS[position % STAGE_COLORS.length],
          })),
        },
      },
    });
  }
  return workspace;
}

/**
 * Provisions a new tenant (organization): subscription, default roles, first admin, workspaces,
 * integration catalogue. Must run with a connection that bypasses RLS (platform role or owner).
 */
export async function provisionTenant(tx: Tx, input: ProvisionInput) {
  const plan = await tx.plan.findUniqueOrThrow({ where: { code: input.planCode } });
  if (plan.maxWorkspaces !== null && input.workspaces.length > plan.maxWorkspaces) {
    throw new Error(`Plan ${plan.code} allows at most ${plan.maxWorkspaces} workspace(s)`);
  }

  const tenant = await tx.tenant.create({
    data: {
      name: input.name,
      slug: input.slug,
      industry: input.industry,
      isInternal: input.isInternal ?? false,
      status: input.isInternal ? 'active' : 'trial',
    },
  });

  await tx.organizationSetting.create({ data: { tenantId: tenant.id } });

  const now = new Date();
  const trialEnd = new Date(now.getTime() + 14 * 86_400_000);
  await tx.subscription.create({
    data: {
      tenantId: tenant.id,
      planId: plan.id,
      period: 'monthly',
      licences: input.isInternal ? 1000 : 5,
      status: input.isInternal ? 'active' : 'trialing',
      trialEndsAt: input.isInternal ? null : trialEnd,
      currentPeriodEnd: input.isInternal ? new Date(now.getTime() + 3650 * 86_400_000) : trialEnd,
    },
  });

  const permissions = await tx.permission.findMany();
  const permId = new Map(permissions.map((p) => [p.key, p.id]));
  const roles: Record<string, string> = {};
  for (const t of ROLE_TEMPLATES) {
    const role = await tx.role.create({
      data: {
        tenantId: tenant.id,
        name: t.name,
        isTemplate: true,
        permissions: {
          create: t.grants
            .filter((g) => permId.has(g.key))
            .map((g) => ({ permissionId: permId.get(g.key)!, scope: g.scope, isDeny: g.isDeny ?? false })),
        },
      },
    });
    roles[t.name] = role.id;
  }

  const admin = await tx.user.create({
    data: {
      tenantId: tenant.id,
      name: input.admin.name,
      email: input.admin.email.toLowerCase(),
      passwordHash: await bcrypt.hash(input.admin.password, 10),
    },
  });
  await tx.userRole.create({
    data: { tenantId: tenant.id, userId: admin.id, roleId: roles['Organization Admin'], isPrimary: true },
  });

  const workspaces = [];
  for (const w of input.workspaces) workspaces.push(await createWorkspace(tx, tenant.id, w));

  await tx.integrationConnection.createMany({
    data: INTEGRATION_CATALOGUE.map((key) => ({ tenantId: tenant.id, key, status: 'inactive' })),
  });

  await appendAudit(tx, {
    tenantId: null,
    actorType: input.actor?.type ?? 'system',
    actorId: input.actor?.id,
    entity: 'tenant',
    entityId: tenant.id,
    action: 'tenant.provisioned',
    newValue: { name: tenant.name, slug: tenant.slug, plan: plan.code, workspaces: workspaces.map((w) => w.name) },
  });

  return { tenant, admin, roles, workspaces };
}
