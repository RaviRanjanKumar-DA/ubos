# Module catalogue

Hierarchy: Platform → Tenant (organization) → Workspaces (business lines) → Pipelines.

Full requirements for each module are in the blueprint PDF (platform: section 4; business modules: sections 8–17). This table is the working index for the backlog.

| ID | Module | Suite | Phase | Business owner |
|---|---|---|---|---|
| M01 | Users & Access (2FA, IP restriction, login audit) | Core | 1 | Admin |
| M02 | Roles & Permissions (custom roles, multi-role users) | Core | 1 | Admin |
| M03 | Org Structure (branches, departments, hierarchy, sales groups) | Core | 1 | Admin / HR |
| M04 | Organization & Workspace Settings (lead fields, pipelines, stages, call feedback, preferences) | Core | 1 | Admin |
| M05 | Notifications & Reminders | Core | 1–2 | Admin |
| M06 | Customer Master (dedupe, merge, timeline) | Revenue | 1 | Sales |
| M07 | Lead Management (sources, lifecycle, assignment, follow-ups) | Revenue | 1 | Sales |
| M08 | RM Ownership Engine (primary / secondary RM) | Revenue | 1 | Sales |
| M09 | Package Management (Elite, BSP, NME, VPM) | Revenue | 3 | Sales / Finance |
| M10 | Campaigns & Lists | Revenue | 2 | Marketing |
| M11 | Telephony — CallerDesk cloud calling, recording, IVR, SIM | Communication | 2 | Sales / Tech |
| M12 | WhatsApp CRM — inbox, templates, broadcast, chatbot, widget | Communication | 2 | Sales / Ops |
| M13 | Email & SMS | Communication | 2 | Ops |
| M14 | Support Desk (call / chat tickets, SLA, escalation) | Communication | 2 | Operations |
| M15 | Task Management | Operations | 2 | Operations |
| M16 | Workflows & Automation | Operations | 2 | Operations / Tech |
| M17 | Schedules | Operations | 2 | Tech |
| M18 | Sales Forms | Operations | 2 | Sales |
| M19 | Webhooks, API Templates, Apps | Operations | 2 | Tech |
| M20 | Employee Lifecycle (onboarding → exit) | People | 3 (exit 4) | HR |
| M21 | Attendance & Leave | People | 3 | HR |
| M22 | Payroll & Payslips | People | 4 | HR / Finance |
| M23 | Asset Management | People | 3 | HR / Admin |
| M24 | Performance, Achievements & Celebrations | People | 4 | HR |
| M25 | Accounting & Collections (Razorpay) | Finance | 3 | Finance |
| M26 | Incentive Engine | Finance | 4 | Finance / HR |
| M27 | Audit Engine | Governance | 1 (log) / 5 (explorer) | Audit |
| M28 | Document Management | Governance | 5 | Legal / Ops |
| M29 | Reports, Dashboards & CSV Export | Intelligence | 4 | Data |
| M30 | AI Suite (Call IQ, Lead IQ, Chat IQ, Content Studio, MCP) | Intelligence | 4–6 | Tech / Marketing |
| — | Integrations Hub (activate / deactivate) | Platform | 1+ | Admin |
| — | Approvals Engine (shared) | Platform | 3 | Admin |

## Platform modules (Platform Owner only)

| ID | Module | Phase |
|---|---|---|
| P01 | Tenant Management | 1 |
| P02 | Provisioning & Onboarding (industry templates) | 1 |
| P03 | Plans & Entitlements (incl. workspaces per plan) | 1 |
| P04 | Subscriptions & Licences | 3 |
| P05 | Platform Billing & GST Invoicing (Razorpay Subscriptions) | 3 |
| P06 | Usage Metering | 3 |
| P07 | Tenant Support Desk & consent-based support access | 2 |
| P08 | White-label & Custom Domains | 4 |
| P09 | Release & Announcement Centre | 4 |
| P10 | Platform Analytics (MRR, ARR, churn, NRR) | 4 |
| P11 | Partner / Reseller Programme | 6 |
| P12 | Platform Security & Audit | 1 |

## Organization features

| Feature | Phase |
|---|---|
| Workspaces (business lines) — create, clone from template, archive | 1 |
| Pipelines / processes per workspace with own stages | 1 |
| Lead-source → workspace/pipeline mapping, "Unsorted" inbox | 1 |
| Cross-sell between workspaces (shared Customer Master) | 2 |
| Consolidated organization dashboard + per-workspace dashboards | 4 |
