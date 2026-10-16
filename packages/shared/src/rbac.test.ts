import { describe, expect, it } from 'vitest';
import { accessibleWorkspaceIds, resolvePermissions, RoleAssignment } from './rbac';
import { normalizeMobile } from './phone';

const rm = (workspaceId: string | null): RoleAssignment => ({
  roleName: 'RM',
  workspaceId,
  grants: [
    { key: 'crm.lead.view', scope: 'OWN' },
    { key: 'crm.lead.create', scope: 'OWN' },
  ],
});
const manager = (workspaceId: string | null): RoleAssignment => ({
  roleName: 'Manager',
  workspaceId,
  grants: [
    { key: 'crm.lead.view', scope: 'WORKSPACE' },
    { key: 'crm.lead.export', scope: 'WORKSPACE' },
  ],
});

describe('resolvePermissions', () => {
  it('takes the union of roles and the widest scope', () => {
    const p = resolvePermissions([rm(null), manager(null)], { workspaceId: 'w1' });
    expect(p['crm.lead.view']).toBe('WORKSPACE');
    expect(p['crm.lead.create']).toBe('OWN');
    expect(p['crm.lead.export']).toBe('WORKSPACE');
  });

  it('applies workspace-limited roles only inside that workspace', () => {
    const assignments = [manager('vastu'), rm('logo')];
    expect(resolvePermissions(assignments, { workspaceId: 'vastu' })['crm.lead.view']).toBe('WORKSPACE');
    expect(resolvePermissions(assignments, { workspaceId: 'logo' })['crm.lead.view']).toBe('OWN');
    expect(resolvePermissions(assignments, { workspaceId: 'logo' })['crm.lead.export']).toBeUndefined();
    expect(resolvePermissions(assignments, { workspaceId: null })['crm.lead.view']).toBeUndefined();
  });

  it('caps workspace-limited assignments at WORKSPACE scope', () => {
    const a: RoleAssignment = { roleName: 'X', workspaceId: 'w1', grants: [{ key: 'crm.lead.view', scope: 'ORGANIZATION' }] };
    expect(resolvePermissions([a], { workspaceId: 'w1' })['crm.lead.view']).toBe('WORKSPACE');
  });

  it('lets an explicit deny win over any grant', () => {
    const auditor: RoleAssignment = {
      roleName: 'Auditor',
      workspaceId: null,
      grants: [{ key: 'crm.lead.create', scope: 'ORGANIZATION', isDeny: true }],
    };
    expect(resolvePermissions([rm(null), auditor], { workspaceId: 'w1' })['crm.lead.create']).toBeUndefined();
  });

  it('ignores assignments outside their validity window', () => {
    const now = new Date('2026-10-17T00:00:00Z');
    const expired = { ...manager(null), validTo: new Date('2026-10-01T00:00:00Z') };
    const future = { ...manager(null), validFrom: new Date('2026-11-01T00:00:00Z') };
    expect(resolvePermissions([expired, future], { workspaceId: 'w1', now })).toEqual({});
  });

  it('removes permissions whose feature is not in the plan', () => {
    const a: RoleAssignment = {
      roleName: 'Admin',
      workspaceId: null,
      grants: [
        { key: 'integrations.manage', scope: 'ORGANIZATION' },
        { key: 'crm.lead.view', scope: 'ORGANIZATION' },
      ],
    };
    const p = resolvePermissions([a], { workspaceId: null, features: new Set(['module.crm']) });
    expect(p['crm.lead.view']).toBe('ORGANIZATION');
    expect(p['integrations.manage']).toBeUndefined();
  });
});

describe('accessibleWorkspaceIds', () => {
  it('gives all workspaces to org-wide roles and only assigned ones otherwise', () => {
    const all = ['a', 'b', 'c'];
    expect(accessibleWorkspaceIds([rm(null)], all)).toEqual(all);
    expect(accessibleWorkspaceIds([rm('b'), manager('c')], all)).toEqual(['b', 'c']);
  });
});

describe('normalizeMobile', () => {
  it('normalises common Indian formats to E.164', () => {
    expect(normalizeMobile('98765 43210')).toBe('+919876543210');
    expect(normalizeMobile('09876543210')).toBe('+919876543210');
    expect(normalizeMobile('+91-98765-43210')).toBe('+919876543210');
    expect(normalizeMobile('919876543210')).toBe('+919876543210');
    expect(normalizeMobile('123')).toBeNull();
  });
});
