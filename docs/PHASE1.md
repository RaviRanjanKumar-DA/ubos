# Phase 1 — Core CRM (MVP): slice plan

Goal (blueprint section 27): your own company (Tenant #1) runs sales on UBOS instead of spreadsheets.
Everything is built and tested **locally** (no hosting spend). Each slice ends with tests and a local commit.

| Slice | Scope | Status |
|---|---|---|
| 1.1 Sign-in & security | Sign in with email / username / mobile + password, **Continue with Google**, **Continue with Microsoft**, **one-time email code**; httpOnly cookie sessions with refresh-token rotation and theft detection; idle timeout; device list & remote sign-out; TOTP two-factor (mandatory per role); IP allow-list; lockout; password change; admin reset/unlock; CSRF protection; organization Security Policy page | **Done** (36 e2e checks) |
| 1.2 Users, roles & org structure | Users page (add with email invite, edit, deactivate/reactivate, reset password, unlock), multiple roles per person per workspace or organization-wide (with optional end date), custom roles with a permission × scope matrix + Deny, duplicate/delete roles, protected Organization Admin, anti-escalation (you can only grant what you have), last-admin protection, branches → departments → teams linked to workspaces, reporting lines with loop check, plan licence limit | **Done** (30 e2e checks) |
| 1.3 Workspace settings | Per business line: several pipelines; stage editor (rename, add, reorder, Open/Won/Lost, safe delete); custom lead fields (11 types incl. dropdown, multi-select, date, amount; required; archive; order; key never changes); lead sources & lost reasons lists; lost reason asked when a lead is lost; Add lead form built from the workspace fields; business-line heads can manage their own workspace only; archive/restore workspace | **Done** (26 e2e + 6 unit checks) |
| 1.4 Customer Master | One customer per person across all business lines; new leads auto-link by mobile, alternate mobile or email (new number kept as alternate); one active customer per mobile enforced in the database; PAN stored encrypted with keyed-hash matching, only last 4 shown, never in audit; duplicate suggestions (exact: same email / PAN / number; possible: similar name via trigram search) with "not the same person"; merge (leads, packages, numbers and missing details move; sticky RM kept) with full undo; Customers list, Customer 360° (KPIs, enquiries across business lines, timeline, merged records) | **Done** (30 e2e checks) |
| 1.5 Lead management | Lead detail page, notes, follow-ups with reminders, assignment rules (sticky, round-robin, manual / bulk), saved views, CSV/Excel import with dedupe preview, export with field masking & row limits | Planned |
| 1.6 Integrations (free to test locally) | Website/API inbound webhook with secret + source→workspace mapping; Google Sheets import via published-CSV link (OAuth version later) | Planned |
| 1.7 Platform Console basics | Tenant detail, change plan, entitlement overrides, platform staff users & 2FA | Planned |
| 1.8 Upgrades | Next.js 16 and Prisma 7 (clears current `npm audit` advisories) | Planned |

Out of scope for Phase 1 (later phases): calling, WhatsApp, billing, HRMS, AI.
