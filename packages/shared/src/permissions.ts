// Permission catalogue: every action in UBOS is `module.resource.action`.
// Roles grant a permission with a data scope; see rbac.ts for how multiple roles combine.

export const DATA_SCOPES = ['OWN', 'TEAM', 'DEPARTMENT', 'BRANCH', 'WORKSPACE', 'ORGANIZATION'] as const;
export type DataScope = (typeof DATA_SCOPES)[number];

export const PERMISSIONS = {
  'dashboard.view': 'View dashboards',
  'dashboard.manage': 'Share dashboards with roles, teams and business lines; set default dashboards',
  'crm.lead.view': 'View leads',
  'crm.lead.create': 'Create leads',
  'crm.lead.update': 'Edit leads',
  'crm.lead.delete': 'Delete leads',
  'crm.lead.assign': 'Assign / transfer leads',
  'crm.lead.export': 'Export leads to CSV',
  'crm.lead.import': 'Bulk upload leads (CSV / Excel)',
  'crm.goal.manage': 'Set goals and targets for people and teams',
  'crm.view.share': 'Share saved lead views with roles',
  'crm.customer.view': 'View customers',
  'crm.customer.update': 'Edit customer details (email, PAN, alternate numbers)',
  'crm.customer.merge': 'Merge duplicate customers (organization-wide)',
  'org.workspace.view': 'View workspaces',
  'org.workspace.manage': 'Create / edit / archive workspaces and pipelines',
  'org.user.view': 'View users',
  'org.user.manage': 'Create users and assign roles',
  'org.role.manage': 'Create and edit roles',
  'org.structure.manage': 'Branches, departments and teams',
  'org.billing.manage': 'Buy licences and services, see orders and transactions',
  'org.security.manage': 'Security policy: login methods, 2FA rules, IP allow-list, session timeout',
  'integrations.view': 'View integrations',
  'integrations.manage': 'Activate / deactivate integrations',
  'audit.view': 'View audit log',
} as const;
export type PermissionKey = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

/** Groups for the role editor screen. */
export const PERMISSION_GROUPS: { label: string; prefix: string }[] = [
  { label: 'Dashboard', prefix: 'dashboard.' },
  { label: 'Leads & customers', prefix: 'crm.' },
  { label: 'Organization', prefix: 'org.' },
  { label: 'Integrations', prefix: 'integrations.' },
  { label: 'Audit', prefix: 'audit.' },
];

/**
 * The built-in administrator role. It always has every permission organization-wide and cannot be
 * edited or deleted, and an organization can never be left without an active user holding it.
 */
export const ADMIN_ROLE = 'Organization Admin';

// Feature keys sold through plans (Platform → Plans & Entitlements).
export const FEATURES = {
  'module.crm': 'CRM: customers, leads, follow-ups',
  'module.workspaces': 'Multiple workspaces (business lines)',
  'module.integrations': 'Integrations Hub',
  'module.telephony': 'Cloud calling (CallerDesk)',
  'module.whatsapp': 'WhatsApp CRM',
  'module.workflows': 'Workflows & automation',
  'module.support': 'Support desk',
  'module.hrms': 'HRMS, payroll, assets',
  'module.finance': 'Finance, collections, incentives',
  'module.audit_explorer': 'Audit explorer',
  'module.ai': 'AI Suite',
} as const;
export type FeatureKey = keyof typeof FEATURES;

// Which feature a permission belongs to (a permission is unusable if the tenant's plan lacks the feature).
export const PERMISSION_FEATURE: Partial<Record<PermissionKey, FeatureKey>> = {
  'crm.lead.view': 'module.crm',
  'crm.lead.create': 'module.crm',
  'crm.lead.update': 'module.crm',
  'crm.lead.delete': 'module.crm',
  'crm.lead.assign': 'module.crm',
  'crm.lead.export': 'module.crm',
  'crm.lead.import': 'module.crm',
  'crm.customer.view': 'module.crm',
  'crm.customer.update': 'module.crm',
  'crm.customer.merge': 'module.crm',
  'integrations.view': 'module.integrations',
  'integrations.manage': 'module.integrations',
};

export interface RoleTemplate {
  name: string;
  grants: { key: PermissionKey; scope: DataScope; isDeny?: boolean }[];
}

const all = (scope: DataScope) => PERMISSION_KEYS.map((key) => ({ key, scope }));

// Default role templates copied into every new tenant; tenant admins can edit or add their own.
export const ROLE_TEMPLATES: RoleTemplate[] = [
  { name: 'Organization Admin', grants: all('ORGANIZATION') },
  {
    name: 'Manager',
    grants: [
      { key: 'dashboard.view', scope: 'WORKSPACE' },
      { key: 'crm.lead.view', scope: 'WORKSPACE' },
      { key: 'crm.lead.create', scope: 'WORKSPACE' },
      { key: 'crm.lead.update', scope: 'WORKSPACE' },
      { key: 'crm.lead.assign', scope: 'WORKSPACE' },
      { key: 'crm.lead.export', scope: 'WORKSPACE' },
      { key: 'crm.lead.import', scope: 'WORKSPACE' },
      { key: 'crm.goal.manage', scope: 'WORKSPACE' },
      { key: 'crm.view.share', scope: 'WORKSPACE' },
      { key: 'crm.customer.view', scope: 'WORKSPACE' },
      { key: 'crm.customer.update', scope: 'WORKSPACE' },
      { key: 'org.workspace.view', scope: 'WORKSPACE' },
      { key: 'org.user.view', scope: 'WORKSPACE' },
    ],
  },
  {
    name: 'Team Leader',
    grants: [
      { key: 'dashboard.view', scope: 'TEAM' },
      { key: 'crm.lead.view', scope: 'TEAM' },
      { key: 'crm.lead.create', scope: 'TEAM' },
      { key: 'crm.lead.update', scope: 'TEAM' },
      { key: 'crm.lead.assign', scope: 'TEAM' },
      { key: 'crm.customer.view', scope: 'TEAM' },
      { key: 'org.workspace.view', scope: 'WORKSPACE' },
    ],
  },
  {
    name: 'RM',
    grants: [
      { key: 'dashboard.view', scope: 'OWN' },
      { key: 'crm.lead.view', scope: 'OWN' },
      { key: 'crm.lead.create', scope: 'OWN' },
      { key: 'crm.lead.update', scope: 'OWN' },
      { key: 'crm.customer.view', scope: 'OWN' },
      { key: 'org.workspace.view', scope: 'WORKSPACE' },
    ],
  },
  {
    name: 'Auditor',
    grants: [
      { key: 'dashboard.view', scope: 'ORGANIZATION' },
      { key: 'crm.lead.view', scope: 'ORGANIZATION' },
      { key: 'crm.lead.export', scope: 'ORGANIZATION' },
      { key: 'crm.customer.view', scope: 'ORGANIZATION' },
      { key: 'org.workspace.view', scope: 'ORGANIZATION' },
      { key: 'org.user.view', scope: 'ORGANIZATION' },
      { key: 'integrations.view', scope: 'ORGANIZATION' },
      { key: 'audit.view', scope: 'ORGANIZATION' },
      // Explicit denies: an auditor never edits, even if another role would allow it.
      { key: 'crm.lead.create', scope: 'ORGANIZATION', isDeny: true },
      { key: 'crm.lead.update', scope: 'ORGANIZATION', isDeny: true },
      { key: 'crm.lead.delete', scope: 'ORGANIZATION', isDeny: true },
    ],
  },
];
