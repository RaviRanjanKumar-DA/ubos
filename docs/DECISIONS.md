# Decisions needed before build starts

Mark your choice next to each item. If left blank, the recommended default is used.

| # | Decision | Options | Recommended default | Your choice |
|---|---|---|---|---|
| 1 | Shared-cloud database | PostgreSQL / MySQL / SQL Server | PostgreSQL (MySQL/SQL Server only for dedicated enterprise) | |
| 2 | Hosting | AWS / Azure / own VPS | AWS Mumbai (ap-south-1) | |
| 3 | WhatsApp connection | Meta Cloud API / BSP / current provider | Current provider if it has an API, else Meta Cloud API | |
| 4 | CallerDesk details | API key, numbers, IVR flows, agents | Needed in Phase 2 | |
| 5 | Single company or SaaS | — | **Decided: multi-tenant SaaS, own use as Tenant #1, multiple workspaces per company** | ✓ |
| 6 | Branches & departments | list | Needed in Phase 0 | |
| 7 | Lead stages, sources, packages, discount limits (per workspace) | list | Needed in Phase 0 | |
| 8 | Current incentive scheme | rules | Needed by Phase 3 | |
| 9 | Payroll statutory | PF / ESI / PT (state) / TDS | Confirm with CA | |
| 10 | Accounting package | Tally / Zoho Books / none | Tally export | |
| 11 | Default AI provider | Gemini / Claude / OpenAI (mix per feature) | Configurable; start with one | |
| 12 | Mobile app timing | Phase 2 / Phase 5 | Phase 5 | |
| 13 | Build team | In-house / agency / mixed | Mixed with in-house tech lead | |
| 14 | Brand name, logo, colours, domain, trademark | — | "UBOS" working name; check trademark | |
| 15 | Pricing & plans | Per user / per workspace / flat | Per user per month, 4 plans (blueprint section 3) | |
| 16 | Legal entity selling the software, GST | Existing / new company | Confirm with CA | |
| 17 | First focus industries for sales | e.g. Education, Consulting/Vastu, Design services, Real estate | 2–3 where you have domain knowledge | |
| 18 | Deployment tiers at launch | Shared / dedicated / on-premise | Shared cloud only at launch | |
| 19 | WhatsApp for tenants | Meta Tech Provider / BSP partnership / tenants bring own | Tenants bring own; apply for Tech Provider | |
| 20 | Free trial length & limits | 7 / 14 / 30 days | 14 days, 5 users | |
| 21 | Your own business lines (workspaces for Tenant #1) | e.g. Course/Software, Logo Designing, Vastu Consultation/Audit | Needed in Phase 0 | |
| 22 | Time zone | — | **Decided: every date is shown, filtered and exported in IST (Asia/Kolkata)** | ✓ |
| 23 | Calling campaign access | — | **Decided: a campaign never widens access. Callers get only leads already in their own scope; to share others' leads, assign them or add the person to the lead team** | ✓ |
