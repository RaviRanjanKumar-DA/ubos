# Phase 0 — Foundation: what is built

Status: complete on local development, 17 October 2026. Not deployed anywhere yet.

## Delivered

| Blueprint item | Where | Notes |
|---|---|---|
| Monorepo, TypeScript, git | root `package.json` (npm workspaces) | `packages/shared`, `packages/database`, `apps/api`, `apps/web` |
| **Multi-tenant core** | `packages/database/prisma/migrations/*_tenant_isolation` | PostgreSQL row-level security on every tenant table; `ubos_app` role (RLS enforced) for tenant APIs, `ubos_platform` role (BYPASSRLS) for the Platform Console only |
| Tenant resolution | `apps/api/src/common/tenant.middleware.ts` | Subdomain (`acme.ubos.app`, `acme.localhost`), verified custom domain, or `X-Tenant` header (dev); suspended tenants blocked |
| Organization → Workspaces → Pipelines | schema + `provisionTenant` / `createWorkspace` | Leads belong to a workspace + pipeline; Customer Master shared across workspaces; plan limits on workspace count |
| Auth | `apps/api/src/modules/auth.controller.ts` | JWT per tenant (token for one organization rejected by every other); separate platform secret for staff |
| Base RBAC (multi-role) | `packages/shared/src/rbac.ts` + `auth.guard.ts` | Union of roles, widest scope, explicit deny, validity windows, workspace-limited roles, plan entitlements; data scopes OWN → ORGANIZATION applied to queries |
| Audit logging | `packages/database/src/audit.ts` | Append-only (DB trigger + revoked grants), SHA-256 hash chain per tenant, verify endpoint |
| Platform Console API | `apps/api/src/platform/platform.controller.ts` | Login, list tenants, onboard company (provisioning), suspend/reactivate, plans, MRR/ARR metrics |
| Design system + clickable prototype | `apps/web` | Tenant portal (login, dashboard, leads, workspaces, integrations on/off, audit log) and Platform Console |
| CI pipeline | `.github/workflows/ci.yml` | Install, migrate, typecheck, unit tests, build, seed, end-to-end isolation checks |
| Tests | `packages/shared/src/rbac.test.ts`, `scripts/verify-isolation.mjs` | 8 unit tests + 27 end-to-end checks (all passing) |

## Run it locally

Prerequisites: Node 20+, Docker Desktop running.

```bash
npm install
npm run db:up
npm run db:migrate
npm run db:seed
npm run build -w @ubos/shared
npm run build -w @ubos/database
npm run dev:api
npm run dev:web
```

- Tenant portal: http://localhost:3030/login · Platform Console: http://localhost:3030/console/login
- API: http://localhost:4000 (health: `/health`)
- Logins: [DEV_LOGINS.md](DEV_LOGINS.md) (local seed data only)
- With the API running: `npm run verify:isolation` (creates a few records; `npm run db:seed` resets)

## Known limitations (deliberately left for Phase 1)

- ~~Tokens in localStorage; no 2FA / IP restriction / session timeout~~ → done in Phase 1.1 (see PHASE1.md).
- Field-level masking and per-role export row limits are designed but not enforced yet (export is capped at 5,000 rows).
- Integration activation is an on/off switch only; credentials, field mapping and the real CallerDesk / WhatsApp / Google Sheets adapters come in Phases 1–2.
- Lead create (customer match + lead insert) is atomic, but the audit hash chain serialises writers per tenant with an advisory lock, which is fine for current volumes and will be revisited for high write rates.
- `npm audit` reports advisories in `postcss` bundled with Next 15 and `deepmerge-ts` in the Prisma CLI; the fixes need major upgrades (Next 16, Prisma 7), scheduled for early Phase 1.
- Dev ports: web 3030, API 4000 (3000 is used by other local projects).
