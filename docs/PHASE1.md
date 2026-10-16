# Phase 1 — Core CRM (MVP): slice plan

Goal (blueprint section 27): your own company (Tenant #1) runs sales on UBOS instead of spreadsheets.
Everything is built and tested **locally** (no hosting spend). Each slice ends with tests and a local commit.

| Slice | Scope | Status |
|---|---|---|
| 1.1 Sign-in & security | Sign in with email / username / mobile + password, **Continue with Google**, **Continue with Microsoft**, **one-time email code**; httpOnly cookie sessions with refresh-token rotation and theft detection; idle timeout; device list & remote sign-out; TOTP two-factor (mandatory per role); IP allow-list; lockout; password change; admin reset/unlock; CSRF protection; organization Security Policy page | **Done** (36 e2e checks) |
| 1.2 Users, roles & org structure | User management UI, invite / deactivate, assign multiple roles per workspace or organization-wide, custom role editor (permission × scope matrix), branches / departments / teams | Planned |
| 1.3 Workspace settings | Pipeline & stage editor per workspace, custom lead fields per workspace, lost reasons, lead sources | Planned |
| 1.4 Customer Master | Duplicate detection (mobile / email / PAN), duplicate suggestions, merge with history, Customer 360° timeline | Planned |
| 1.5 Lead management | Lead detail page, notes, follow-ups with reminders, assignment rules (sticky, round-robin, manual / bulk), saved views, CSV/Excel import with dedupe preview, export with field masking & row limits | Planned |
| 1.6 Integrations (free to test locally) | Website/API inbound webhook with secret + source→workspace mapping; Google Sheets import via published-CSV link (OAuth version later) | Planned |
| 1.7 Platform Console basics | Tenant detail, change plan, entitlement overrides, platform staff users & 2FA | Planned |
| 1.8 Upgrades | Next.js 16 and Prisma 7 (clears current `npm audit` advisories) | Planned |

Out of scope for Phase 1 (later phases): calling, WhatsApp, billing, HRMS, AI.
