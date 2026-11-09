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
| Integrations with other CRMs & platforms | Catalogue now lists 93 integrations in 12 categories with brand icons (lead portals incl. LinkedIn / YouTube / Google Business / education & property portals, forms, 11 telephony providers, WhatsApp BSPs, Instagram / Messenger / Telegram, websites & e-commerce, 8 payment gateways, Tally / Zoho Books / QuickBooks, marketing & analytics, AI keys and automation tools, productivity, support desks, 10 other CRMs); adapters ship per phase | Catalogue: Phase 1.5 · adapters: Phases 1–5 |

## Market coverage and UI (requested 9 Nov 2026)

"Every feature of every CRM" is tracked as a feature-by-feature comparison with eight CRMs, India first: see `CRM-COMPARISON.md`. Each gap has a priority and a phase, and the Must items set the order of work.

The UI is redone in three batches, alternating with feature slices: UI 1 (design foundation, navigation, small screens), slice 2.6, UI 2 (daily pages), slice 2.7, UI 3 (setup and admin pages), slice 2.8, then the Must gaps. UI 1, UI 2 and UI 3 are done. UI 3 replaced browser pop-ups with in-app dialogs, added a business line picker where a page needs one, made the Audit Log readable and filterable, and redid Org Structure. Audit Log still reads the latest 200 entries; going further back needs server paging and date filters.

## Setup Guide & onboarding checklist (requested 17 Oct 2026)

A **Setup Guide** page for organization admins (TeleCRM-style reference): a greeting, guide groups in a left menu, cards with a progress bar (e.g. 2/5), and steps marked **Basic** or **Advanced**. Steps tick themselves off from real data (a step is done when the thing exists, e.g. "Add team members" = at least 2 active users), so nobody ticks boxes by hand; a step can also be skipped. Each step links straight to the screen that does it. Steps whose feature is not built yet show "Coming in Phase N" instead of a link, so the guide grows with the product. Per organization, not per user; the Platform Console shows each tenant's setup progress (useful for onboarding paying customers). Resources block: Download app, Contact our team (support ticket), Help videos, Product updates (changelog).

| Guide · step | In UBOS | When |
|---|---|---|
| Get started · lead fields, lead stages, add leads manually, import from Excel | Fields settings, stage board, Add lead, bulk upload | **Built** (1.3 – 1.5b) |
| Get started · import historical actions (calls / remarks) from another CRM | Bulk upload in "activity history" mode | 1.5c |
| Team · add members, team structure, member access | Users (incl. bulk add), Org structure, Roles & permissions | **Built** (1.2, 1.5b) |
| Team · role SOPs (custom dashboards per role) | Shared dashboards with a landing dashboard per role | **Built** (1.6) |
| Customise · call feedback, custom actions | Status & call feedback, Custom actions | **Built** (1.5b) |
| Customise · labels | Tags on leads (colour, filter, bulk add / remove) | 1.5c |
| Customise · SOP forms | Stage required fields + custom actions (built); full process templates with step forms | 1.5d |
| Calling & messaging · SIM call recording, SIM mode | Android app logs SIM calls and recordings | Phase 2 |
| Calling & messaging · WhatsApp / SMS / email templates, calling campaigns | Templates, campaign lists with dialer queue | Phase 2 |
| Calling & messaging · call summariser | AI call notes (Gemini / Claude / OpenAI, tenant's own key) | Phase 4 |
| WhatsApp · chat sync, Business API, templates, first broadcast | WhatsApp integration (user can turn it on / off) | Phase 2 |
| IVR / cloud telephony · CallerDesk, TeleCMI, Tata Tele, Knowlarity, MCube, Maqsam | Telephony adapters, CallerDesk first | Phase 2 |
| Integrations · Facebook Lead Ads, Google Sheets, IndiaMART / JustDial | Lead-source adapters | 1.7 |
| Integrations · Shopify, WooCommerce, Razorpay | E-commerce leads, payment links on leads | Phase 3 |
| Automation · flowcharts, schedules, sequences, API templates | Workflow builder | Phase 2 (rules) · Phase 3 (visual builder) |
| Automation · webhooks | Outgoing webhooks per event | 1.7 |
| Reports · leaderboard, call reports, lead reports | Dashboards & analytics | **Built** (1.6) |
| Move data · export leads, bulk edit in app | Filtered export, bulk actions | **Built** |
| Move data · export actions, bulk edit through Excel | Activity export; upload in "update existing" mode | 1.5c |
| AI connectors · Claude / ChatGPT via MCP | UBOS MCP server on top of the public API, per-user keys and permissions | Phase 4 |
| Developer · API keys | Organization API keys with scopes, rate limits, audit | 1.7 |
| Developer · embedded apps & iframes | Custom tabs on lead / dashboard pages | Phase 5 |

Proposed build: the Setup Guide page itself as small slice **1.5e** (it only reads existing data), then every later slice adds its steps.

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
