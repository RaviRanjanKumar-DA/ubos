-- Tenant isolation, runtime roles and append-only audit log.
-- ubos_app      : used by the tenant API; every tenant table is filtered by row-level security.
-- ubos_platform : used by the Platform Console API; BYPASSRLS (granted in infra init script).

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ubos_app') THEN CREATE ROLE ubos_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ubos_platform') THEN CREATE ROLE ubos_platform NOLOGIN BYPASSRLS; END IF;
END $$;

GRANT USAGE ON SCHEMA public TO ubos_app, ubos_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ubos_app, ubos_platform;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ubos_app, ubos_platform;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ubos_app, ubos_platform;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ubos_app, ubos_platform;

-- The tenant API may read platform catalogues but never change them.
REVOKE INSERT, UPDATE, DELETE ON "Plan", "PlanFeature", "Permission", "Tenant", "TenantDomain",
  "TenantEntitlement", "Subscription", "PlatformInvoice", "UsageRecord", "SupportAccessGrant" FROM ubos_app;
REVOKE ALL ON "PlatformUser" FROM ubos_app;

-- Row-level security: a row is visible only when its tenantId equals the transaction's app.tenant_id.
-- FORCE makes the policy apply to the table owner as well (superusers still bypass it).
CREATE FUNCTION ubos_enable_tenant_rls(tbl text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = current_setting(''app.tenant_id'', true)) '
    'WITH CHECK ("tenantId" = current_setting(''app.tenant_id'', true))', tbl);
END $$;

SELECT ubos_enable_tenant_rls(t) FROM unnest(ARRAY[
  'Asset', 'AssetAssignment', 'AuditLog', 'Branch', 'Customer', 'CustomerPackage', 'Department',
  'Employee', 'FollowUp', 'IntegrationConnection', 'Lead', 'LeadSourceMapping', 'LeadStage',
  'LeaveRequest', 'Package', 'Pipeline', 'Role', 'Subscription', 'SupportAccessGrant', 'Team',
  'TenantEntitlement', 'UsageRecord', 'User', 'UserRole', 'WebhookInbox', 'Workspace'
]) AS t;

-- Child tables without tenantId inherit isolation through their parent (the subquery is itself RLS-filtered).
ALTER TABLE "RolePermission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RolePermission" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "RolePermission"
  USING (EXISTS (SELECT 1 FROM "Role" r WHERE r.id = "roleId"))
  WITH CHECK (EXISTS (SELECT 1 FROM "Role" r WHERE r.id = "roleId"));

ALTER TABLE "FieldRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FieldRule" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "FieldRule"
  USING (EXISTS (SELECT 1 FROM "Role" r WHERE r.id = "roleId"))
  WITH CHECK (EXISTS (SELECT 1 FROM "Role" r WHERE r.id = "roleId"));

ALTER TABLE "PlatformInvoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlatformInvoice" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PlatformInvoice"
  USING (EXISTS (SELECT 1 FROM "Subscription" s WHERE s.id = "subscriptionId"));

-- Audit log is append-only for everyone, including the table owner.
REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog" FROM ubos_app, ubos_platform;
CREATE FUNCTION ubos_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only';
END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION ubos_audit_append_only();
