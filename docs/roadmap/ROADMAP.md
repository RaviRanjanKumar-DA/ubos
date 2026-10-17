# Road map

Your own company (Tenant #1) goes live first; beta customers join in Phase 3; commercial launch follows Phase 4.

| Phase | Timing | Deliverables | Outcome |
|---|---|---|---|
| 0 Foundation | Weeks 1–3 | Blueprint sign-off, design system, clickable prototype, repo, CI/CD, **multi-tenant core** (tenant resolution, row-level security, tenant registry), auth, audit logging, base RBAC | Prototype |
| 1 Core CRM (MVP) | Months 1–2 | Users, multi-role RBAC, org, **workspaces & pipelines**, settings, Customer Master + dedupe, leads, assignment, follow-ups, views, CSV import/export, Integrations Hub with Google Sheets + Website/API; Platform Console basics (tenants, plans, entitlements) | Your company runs sales on UBOS |
| 2 Communication | Months 3–4 | CallerDesk, WhatsApp (inbox, templates, broadcast, widget), Facebook leads, tasks, workflows v1, reminders, Support Desk, tenant support desk | Calls & chats in UBOS |
| 3 Money & People | Months 5–6 | Packages, discounts, invoices, receipts, Razorpay, ledgers, collections; onboarding, attendance, leave, approvals, HR reminders, assets; **subscriptions, platform billing, usage metering, self-serve trial** | 3–5 beta customers |
| 4 Insight & Pay | Months 7–8 | Reports, role dashboards, incentive engine, payroll & payslips, exit, performance, achievements, celebrations, AI Content Studio, Chat IQ pilot; white-label & domains, release centre, platform analytics; VAPT, legal documents | **Commercial launch** |
| 5 Governance | Months 9–10 | Audit explorer, documents & versions, legal register, refunds/credit notes, GST summary, Tally/Zoho sync, more lead sources, Android app v1 | Audit-ready |
| 6 AI & Scale | Months 11–12 | Call IQ, Lead IQ, sentiment, forecasting, churn, MCP server, Ask UBOS, video shorts, partner programme, dedicated-cloud option, hardening | AI-assisted, scalable SaaS |

## New requests (17 Oct 2026) — proposed placement, to confirm

| Request | What it covers | Proposed phase |
|---|---|---|
| Product & Service Gallery per workspace | Catalogue of products / services / packages with photos, brochures, prices and offers; shareable on WhatsApp from a lead | Phase 3 (with Packages) |
| Course / Software access & validity | Enrolments and licences per customer: start / end date, access status, licence keys, expiry reminders, renewal leads created automatically | Phase 3 (with Packages & Finance) |
| Class video recordings | Recordings per course / batch (upload or Zoom / YouTube link), access only for enrolled, valid customers; watch tracking | Phase 4 |
| Notes | Internal notes / knowledge base per workspace (scripts, FAQs, SOPs), plus customer notes on Customer 360 | Phase 2 (notes) · Phase 4 (knowledge base) |
| Campaigns | Calling / WhatsApp / email campaigns with lists, results and cost per lead | Phase 2 |
| Workshops & Events | Event pages, registrations as leads, reminders, attendance, follow-up after the event | Phase 4 |
| Marketing | UTM / source ROI, ad spend, AI content studio (copy, creatives, short videos) | Phase 4 |
| Integrations with other CRMs & platforms | Catalogue now lists 36 integrations (portals, telephony, WhatsApp, Shopify / WooCommerce / WordPress, Zoho / HubSpot / Salesforce / LeadSquared / TeleCRM / Pipedrive / Freshsales, Zapier); adapters ship per phase | Catalogue: Phase 1.5 · adapters: Phases 1–5 |

## Dashboards & analytics (requested 17 Oct 2026)

Every dashboard follows the same access rules as the data: what a person sees depends on their organization, workspace (business line), roles and data scope.

| Level | Who | Example view |
|---|---|---|
| Platform | You (Platform Owner) | MRR / ARR, tenants, trials, churn, usage, revenue forecast |
| Company (organization) | CEO / Management | All business lines together, compared side by side |
| Workspace (business line) | Business-line head | One business line: funnel, revenue, team, sources |
| Team | Manager / Team Leader | Team leaderboard, calls, follow-up discipline |
| User | RM / caller | My day: follow-ups due, calls, conversions, incentive estimate |
| Function | Finance, HR, Auditor, Marketing, Ops | Collections, headcount, exceptions, source ROI, SLAs |

**KPIs** — leads, first-response time, contact rate, connected calls, talk time, follow-up compliance (done on time %), stage conversion, win rate, lost reasons, sales cycle length, revenue booked / collected, average deal value, cost per lead and ROI by source, RM productivity, leaderboard; later collections, incentives, attendance, support SLAs.

**Charts** — KPI tiles with trend vs previous period, funnel, line / area trends, stacked bars by business line or source, heatmap (best hour / day to call), leaderboards, target vs actual gauges; every chart drills down to the leads behind it.

**Forecasting & predictions** — step 1 (statistical, no AI cost): pipeline-weighted revenue forecast by stage probability, run-rate projection to month end, target attainment. Step 2 (AI, Phase 6): lead win probability, best next action, best time to call, renewal / churn risk, anomaly alerts.

**Controls** — date ranges and comparison, filters (business line, team, user, source, stage), saved custom dashboards per person, export (respects export permission), scheduled email / WhatsApp digest.

**Customizable dashboards** — a dashboard builder: add widgets from a library (KPI tile, funnel, line, bar, pie / donut, table, leaderboard, heatmap, target gauge, follow-up list), pick the metric, grouping, chart type, date range and filters for each widget, then drag to arrange and resize. Each person can keep personal dashboards; admins can publish dashboards to roles, teams, business lines or named users, set one as the default landing dashboard for a role, and lock it so it cannot be changed. Start from ready templates (CEO, Business-line head, Manager, RM, Marketing) and duplicate to customise. Widgets always respect the viewer's data access, so a shared dashboard shows each person only their own permitted numbers.

**Proposed placement** — Dashboards v1 (role & level dashboards, KPI tiles, charts, drill-down, statistical forecast) as slice 1.6, right after 1.5b; AI predictions in Phase 6; finance / HR dashboards arrive with those modules.
