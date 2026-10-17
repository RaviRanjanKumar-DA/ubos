# Features adopted from Batra Vastu Desk & Batra Logo Desk

Both apps run real lead and process work for one business line each. UBOS takes their proven ideas but makes each one
**configurable per workspace (business line)** and keeps every UBOS rule: multi-tenant isolation (row-level security),
roles with data scopes, workspace-level settings, append-only audit, API-first and no hard-coded business values.

## Adopted (adapted)

| From the desks | In UBOS | Slice |
|---|---|---|
| Fixed 7-step (Vastu) / 11-step (Logo) process after the lead | **Process templates** per workspace: ordered steps after a lead is won (e.g. Meeting → Audit → Payment → Consultation → Remarks), each with a responsible role, its own fields, and a completion rule | 1.5d |
| Step owner roles with Edit / View / No access per step | **Step access per role**: edit / view / none on each process step, plus "own records only" (we already have data scopes) | 1.5d |
| Completed step locks; Super Admin unlocks with a reason | **Step lock & unlock**: completed steps become read-only; a permission "Unlock completed steps" re-opens them, reason saved to the audit log | 1.5d |
| "← Back to step N" with a reason | **Send back** to an earlier step with a reason (timeline + audit) | 1.5d |
| Step opens only after 50 % advance / full payment (`ADVANCE_PCT`) | **Step gates**: a step can require a payment % received, earlier steps done, or fields filled | 1.5d (payments: Phase 3) |
| Seller, Auditor, Designer, Consultant on one lead | **Lead team**: extra people on a lead with a role label (Seller, Auditor, Designer, Consultant…), each sees and works the lead per their role | 1.5d |
| Meeting date / time / Zoom no., reschedule kept as history | **Meetings on a lead**: date, time, mode (online / site visit), link, participants, status; reschedules kept as history | 1.5d |
| Payment Source: L1 amounts create a lead, other amounts attach as payments, token / instalments | **Payment rules** per workspace: amounts / products that create a lead vs. attach as instalments; token & balance tracking | Phase 3 (with Razorpay & Packages) |
| RM payment reminders: next follow-up + repeat every N days, one daily email per RM | **Repeating follow-ups** ("every 2 days until paid") and a **daily digest** per user at a set time | 1.5c |
| Lead Assignment tab with Auto-assign switch; RM active / inactive for new leads | **Accepting new leads** switch per user (round-robin skips people who are off) and an auto-assign on/off switch per workspace | 1.5d |
| Temporary cover: hand leads to someone for N days, or "person away" with a cover person; ends by itself | **Temporary cover / out-of-office**: leads and new assignments go to a cover person between two dates, then return automatically | 1.5d |
| Close a lead as Lost from the top of the page; 1–5 star rating on closing | **Close as lost** from the lead header (already) + optional **customer rating** when a process completes | 1.5d |
| Dropdowns: rename can update existing records; hidden options stay on old records; delete only if never used | **Option lists**: hide (done), rename updates existing leads automatically because leads store a fixed value and show the current name (done in 1.5b); delete allowed only for never-used options | 1.5c |
| Customer master by email or last 10 digits of mobile, Customer ID, extra emails / numbers kept | Already in UBOS (Customer Master, alternate mobiles); add **alternate emails** | 1.5c |
| Change log with old → new per field, per lead and system-wide | Already in UBOS (hash-chained audit log + lead timeline) | done |
| Full lead report (one row per lead with every step) | **Process report export**: one row per lead with every step's fields | 1.5d |
| Role analytics, date basis for charts, insights | Feeds **Dashboards & analytics** (date basis: created / assigned / won date) | 1.6 |
| Ask AI over the lead report | **Ask UBOS** in the AI Suite — through the API with the user's own permissions (never raw SQL) | Phase 6 |

## Deliberately not copied

| In the desks | Why not in UBOS |
|---|---|
| Hard-coded amounts (`L1_AMOUNTS`, `ADVANCE_PCT`) and step lists in code | UBOS is sold to many companies: every rule is a workspace setting |
| One process per database / app | One organization can run many business lines; processes are per workspace |
| MySQL exposed to the internet for Vercel | UBOS keeps the database private; only the API is public |
| AI running SQL directly on a database view | Would bypass tenant isolation and role scopes; AI uses the API as the user |
| Polling a table every 60 s for new orders | UBOS uses integrations (webhooks / payment gateway) and a background worker |
| "Everyone can view every lead" | UBOS always applies data scopes (own / team / workspace / organization) |
