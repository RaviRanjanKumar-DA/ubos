# Phase 4: reports, bulk tools and automation menu

Slices agreed on 22 Nov 2026 from the user's list (reports of many types, bulk tools, an Automations menu). Each slice: own branch, tests, browser check at 1280 and 375, local commit, then one go-live question.

| Slice | What | Status |
|---|---|---|
| 4.1 Reports hub | One Reports page with Leaderboard, Actions, Tasks, Call report, Call log, Leads, Duplicate leads (repeat enquiries and customers with more than one open lead), Facebook data (every form answer as a column) and Sales (won value, invoiced, received). Each report has a period (IST), business line, person and source filters, totals, and a download that opens in Excel (CSV with BOM). Reports follow "View dashboards" scope; lead lists download only with "Export leads"; downloads are audited. Deleted leads, AI insights and call summaries are listed as coming. | Done (24 e2e checks) |
| 4.2 Bulk tools and deleted leads | Bulk tools page linking every tool. New: delete leads (single or many, with a reason; kept and restorable; they leave every list, count, report, reminder and automation; open tasks are cancelled, sequences and flows stop), Deleted leads report with restore, "Download my leads in this format" for the Excel update round trip, bulk upload tasks from CSV/Excel with a check first (assignee by email/username/name, lead by mobile/email, due in IST), bulk cancel tasks (cancelled tasks drop out of open lists and show as Cancelled in the Tasks report). Already existed and linked: bulk edit on the Leads list, update from Excel, bulk upload leads, import past calls and remarks, bulk user upload, users export. "List delete" waits for lead lists. | Done (23 e2e checks) |
| 4.3 Automations menu | Workflows (flows), Schedules (scheduled reports by email), Salesform, API templates, Webhooks and Apps in one menu. | Planned |
| Later (AI phase) | AI insights and call summarization need an AI provider key per organization. | Planned |
