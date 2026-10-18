# UBOS build plan — Setup Guide features + best of other CRMs

Requested 18 Oct 2026: "all the features mentioned in the Setup Guide" and relevant features from Zoho, TeleCRM, Close,
monday.com, Pipedrive, Salesforce, Copper and HubSpot. Everything below follows the UBOS rules: multi-tenant isolation,
roles and data scope on every screen and API, audit log on every change, nothing deleted (archive instead), local build and
test first (no paid services until the product is complete — third-party connections use free sandbox / test modes).

## Already built (Phase 0 – 1.6)

Sign-in & security, users / roles / org structure, workspaces with pipelines and custom fields, Customer Master with
duplicate merge, lead work (calls, remarks, follow-ups, bulk upload & bulk actions, assignment rules), stage board with stage
rules and SLA, custom actions with lead scoring, flexible lead filters, billing & licences, Platform Console pricing, Setup
Guide, dashboards (38 KPIs: revenue, conversion, pipeline, SLA, productivity, audit; per-role dashboards, builder, sharing,
click-to-filter), integrations catalogue (93 services).

## Features adopted from other CRMs

| From | Feature | How it fits UBOS | Slice |
|---|---|---|---|
| Close, HubSpot | **Smart views** — saved filters + columns, shared with a team | Saved views on the leads list (personal / shared by role) | 1.5c |
| Pipedrive, monday | **Kanban board** of leads — drag between stages | Board view on the leads list, stage rules still apply | 1.5c |
| Pipedrive, HubSpot | **Activities & calendar** — calls, meetings, tasks with due dates | Tasks & meetings on leads, calendar view, reminders | 1.5c |
| Pipedrive, Salesforce | **Goals / targets** per person and team | Targets for calls, wins, won value; shown on dashboards (gauges) | 1.5c |
| HubSpot, Close | **Playbooks / call scripts** | Script per stage shown in the Log-call panel | 1.5c |
| monday, Salesforce (Chatter) | **@mentions & notes** | Mention a colleague in a remark → in-app notification | 1.5c |
| Zoho, HubSpot | **Tags / labels** | Coloured labels on leads, filter and bulk add / remove | 1.5c |
| Zoho, Salesforce | **Field-level security** | Hide or make read-only per role | 1.5c |
| Zoho (Blueprint), Salesforce | **Guided process** with mandatory steps and approvals | Process templates after a sale (steps, owners, payments, approvals) | 1.5d |
| Salesforce, HubSpot, Zoho | **Products, price lists, quotes** | Products / packages per business line, quote PDF from a lead | 1.5d |
| Salesforce | **Lead conversion to deal / customer account** | "Won" opens the process template; customer 360 keeps history | 1.5d |
| HubSpot, Zoho | **Web-to-lead forms** | Hosted form builder per business line + embed code | 1.7 |
| All | **Public API & webhooks** | API keys with scopes, outgoing webhooks per event | 1.7 |
| Copper, HubSpot | **Gmail / Outlook sync** | Emails logged on the lead, send from UBOS | 1.7 |
| HubSpot, Calendly | **Meeting scheduler** | Booking link per person → lead + meeting | 1.7 |
| TeleCRM, Close | **Power dialer & calling campaigns** | Queue of leads, auto next-call, disposition required | Phase 2 |
| TeleCRM | **SIM calling app** with call recording sync | Android app logs calls & recordings | Phase 2 |
| Close, HubSpot, Zoho (Cadences) | **Sequences** — multi-step email / WhatsApp / call follow-up | Sequence builder; stops when the lead replies | Phase 2 |
| monday, Zoho, HubSpot | **Automation recipes** — "when X, if Y, then Z" | Workflow rules engine, then a visual flow builder (Phase 3) | Phase 2 |
| TeleCRM, Interakt | **WhatsApp inbox, templates, broadcast** | WhatsApp Cloud API + BSP adapters | Phase 2 |
| Close | **Call coaching** — listen to recordings, comment | Recording player with comments on the lead | Phase 2 |
| HubSpot | **Email tracking** (opens / clicks) | For emails sent from UBOS | Phase 2 |
| HubSpot, Zoho | **Help desk tickets & knowledge base** | Support module linked to Customer 360 | Phase 2 |
| Salesforce, Zoho | **P&L, invoices, payments, collections, incentives** | Finance module (income and expenses → real P&L) | Phase 3 |
| Zoho (Zia), HubSpot, Salesforce (Einstein) | **AI**: call notes, next best action, win probability, anomaly alerts | AI Suite with the organization's own key; MCP connector | Phase 4 |
| HubSpot | **Campaigns & attribution / ROI** | Campaigns, ad spend per source, cost per lead | Phase 4 |
| monday | **Embedded apps** | Custom tabs / iframes on lead and dashboard pages | Phase 5 |

## Setup Guide items → slices

| Setup Guide item | Slice |
|---|---|
| Import past calls & remarks; export calls / actions; bulk edit through Excel; labels; dashboards per role (done) | 1.5c |
| Process templates / SOP forms | 1.5d |
| Lead sources (Facebook, Google Sheets, IndiaMART / JustDial, Google Forms), webhooks, API keys, Zapier / Make / n8n / Pabbly | 1.7 |
| SIM calling, message templates, calling campaigns, WhatsApp chat sync & Business API, IVR providers (CallerDesk first), schedules & sequences | Phase 2 |
| Flowcharts, API templates, Shopify / WooCommerce, Razorpay & other payments, accounting sync | Phase 3 |
| AI call summariser, MCP connector (Claude / ChatGPT) | Phase 4 |
| Embedded apps & iframes | Phase 5 |

## Order of work

1. **1.5c Productivity** — smart views, Kanban, tasks & meetings with calendar and reminders, daily digest + scheduled dashboard emails (Mailpit locally), goals, call scripts, @mentions, labels, field-level security, alternate emails, Excel bulk update, import of past activities, export of actions.
2. **1.5d Process & deals** — process templates (Blueprint-style), approvals, products / price lists / quotes, lock / unlock, payment rules.
3. **1.7 Integrations & API** — API keys, webhooks, web-to-lead forms, Website API, Google Sheets, Facebook Lead Ads, portals, Google Forms, automation tools, email sync, meeting scheduler.
4. **Phase 2** — calling (CallerDesk, SIM app, power dialer), WhatsApp, SMS, sequences, automation rules, help desk.
5. **Phase 3 – 5** — finance & P&L, e-commerce, AI, marketing, remaining adapters.

Each slice ends the same way: end-to-end tests, browser check, Setup Guide steps switched from "Coming in …" to live, local commit.
