# Development logins (local seed data only)

Created by `npm run db:seed`. All accounts use the dev password **`Ubos@2026dev`**.
These exist only in your local Docker database. Never reuse them anywhere real.

## Platform Console — http://localhost:3030/console/login

| Role | Email |
|---|---|
| Platform Owner | owner@ubos.local |

## Tenant #1 — your company (organization code `mycompany`) — http://localhost:3030/login

Workspaces: Course / Software · Logo Designing · Vastu Consultation / Audit

| User | Email | Roles |
|---|---|---|
| Company Admin | admin@mycompany.local | Organization Admin (all workspaces) |
| Neha | manager@mycompany.local | Manager in Vastu **and** RM in Logo Designing (multi-role) |
| Arjun | rm@mycompany.local | RM in Vastu (sees only own leads) |
| Simran | rm2@mycompany.local | RM in Course / Software |
| Kabir | auditor@mycompany.local | Auditor (read-only, organization-wide, audit log) |

## Demo customer tenant — ABC Group (organization code `abc`)

Workspaces: Education · Real Estate (Growth plan, trial)

| User | Email | Roles |
|---|---|---|
| ABC Admin | admin@abc.local | Organization Admin |
