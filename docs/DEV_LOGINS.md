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
| Arjun | rm@mycompany.local · username `arjun` · mobile `98765 11111` | RM in Vastu (sees only own leads) |
| Simran | rm2@mycompany.local | RM in Course / Software |
| Kabir | auditor@mycompany.local | Auditor (read-only, organization-wide, audit log) |

## Demo customer tenant — ABC Group (organization code `abc`)

Workspaces: Education · Real Estate (Growth plan, trial)

| User | Email | Roles |
|---|---|---|
| ABC Admin | admin@abc.local | Organization Admin |

## Sign-in options to try locally

- **Password** with email, username or mobile number.
- **Email code**: click "Email me a code", then open the local inbox at http://localhost:8025 (Mailpit). No real email is sent.
- **Google / Microsoft**: shown only after you add free OAuth client IDs to `.env`. Steps are in [docs/LOGIN_SETUP.md](LOGIN_SETUP.md).
- **Two-factor**: turn it on under *My Security* with Google Authenticator or Microsoft Authenticator.
