import bcrypt from 'bcryptjs';
import { ROLE_TEMPLATES } from '@ubos/shared';
import type { Tx } from './tenant-context';
import { appendAudit } from './audit';

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

export const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** Creates a workspace with its pipelines and stages inside an existing tenant. */
export async function createWorkspace(tx: Tx, tenantId: string, w: WorkspaceInput) {
  const workspace = await tx.workspace.create({
    data: { tenantId, name: w.name, slug: slugify(w.name), template: w.template },
  });
  for (const p of w.pipelines ?? [{ name: 'Sales' }]) {
    await tx.pipeline.create({
      data: {
        tenantId,
        workspaceId: workspace.id,
        name: p.name,
        stages: {
          create: (p.stages ?? DEFAULT_STAGES).map((name, position) => ({
            tenantId, name, position, isWon: name === 'Won', isLost: name === 'Lost',
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
