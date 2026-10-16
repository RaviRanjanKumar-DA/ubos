# UBOS — Unified Business Operating System

An enterprise-grade **multi-tenant SaaS** product. You run your own company on it (Tenant #1) and sell it to other companies, each of which gets its own isolated organization with **multiple workspaces** (one per business line, e.g. Course/Software, Logo Designing, Vastu Consultation/Audit). All tenants, plans, billing, usage and support are managed from the **Platform Console**.

Inside each organization: CRM, cloud calling (CallerDesk), WhatsApp, Google Sheets, HRMS, assets, accounting, incentives, audit, reporting and AI (Gemini / Claude / OpenAI).

> **Status: Blueprint v2.0 approved · Phase 0 (Foundation) built locally.**
> What exists and how to run it: [`docs/PHASE0.md`](docs/PHASE0.md) · Blueprint: [`docs/blueprint/UBOS_Blueprint.pdf`](docs/blueprint/UBOS_Blueprint.pdf)

## Hierarchy

```
Platform (you: console.ubos.app)
└── Tenant / Organization (company.ubos.app)        ← shared Customer Master, HR, Finance
    └── Workspace (business line)                    ← own leads, pipelines, packages, teams, numbers
        └── Pipeline / process                       ← own stages
```

## What is in this folder

| Path | Contents |
|---|---|
| `docs/blueprint/` | Full blueprint (PDF + HTML source): SaaS model, pricing, Platform Console, workspaces, requirements, architecture, roadmap, KPIs, risks, decisions |
| `docs/requirements/` | Module catalogue (P01–P12 platform, M01–M30 business) |
| `docs/rbac/` | Default permission matrix (CSV, editable) |
| `docs/integrations/` | Integration catalogue and activate/deactivate rules |
| `docs/api/` | API conventions |
| `docs/roadmap/` | Phase plan |
| `docs/DECISIONS.md` | Questions the owner must answer before build starts |
| `packages/database/prisma/schema.prisma` | Draft multi-tenant data model |
| `apps/api` | NestJS API: tenant resolution, auth, multi-role RBAC, workspaces, leads, integrations, audit, Platform Console |
| `apps/web` | Next.js tenant portal + Platform Console (design system + prototype) |
| `packages/shared` | Permission catalogue, role templates, multi-role resolver (unit-tested) |
| `packages/database` | Prisma schema, migrations (row-level security), provisioning, audit chain, seed |
| `scripts/verify-isolation.mjs` | End-to-end tenant isolation & RBAC checks |
| `infra/docker-compose.yml` | Local dev services (PostgreSQL, Redis, MinIO) |
| `.env.example` | Environment variable template |

## Planned stack

Next.js (tenant portal + Platform Console) · NestJS (API) · Prisma + PostgreSQL with row-level security (MySQL / SQL Server for dedicated enterprise deployments) · Redis + BullMQ · S3 · Docker · Grafana/Prometheus.

## Regenerating the PDF

The PDF is printed from the HTML source with Microsoft Edge:

```bash
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --no-pdf-header-footer --print-to-pdf="C:\Users\ravi\UBOS\docs\blueprint\UBOS_Blueprint.pdf" "file:///C:/Users/ravi/UBOS/docs/blueprint/UBOS_Blueprint.html"
```
