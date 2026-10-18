# Phase 2 — Calling, messaging, automation

Built in slices like Phase 1; each ends with end-to-end tests, a browser check, docs and a local commit. Everything is
tested locally first (no paid services until the product is complete); provider adapters are tested against local stand-ins
until a real account is connected.

| Slice | Scope | Status |
|---|---|---|
| 2.1 Calling core | One call pipeline for every channel: `Call` records (SIM, cloud, manual) with a stable id per organization (sent twice = stored once), call on the lead's journey at the time it happened, unknown numbers (optional new lead or "unmatched" to link later). Phone pairing (6-digit code → device token, revoke), mobile API (calls batch, reconcile, resumable recording upload, sync of my leads / follow-ups / dispositions, dial requests). Recordings encrypted at rest (local disk now, S3 / MinIO later), retention by plan / organization, listening permission and audit. Cloud calling: CallerDesk webhook → same pipeline, recordings copied or linked per setting, click-to-call. "Call" on a lead (paired phone or cloud). Live updates in open browsers (server-sent events). Calls page (log, filters, player, unmatched), phones admin, my phone. Built: `Call` / `Device` / `PairingCode` / `DialRequest`, mobile API `/mobile/v1` (pair, sync, calls, calls/reconcile, recording upload, heartbeat), CallerDesk webhook + click-to-call (field names and the click-to-call address follow CallerDesk's usual API — check against a real account), recordings encrypted on local disk (`STORAGE_DIR`), hourly retention purge, `crm.call.recording` permission, unknown-caller and "outcome required" settings, live updates via `/api/v1/stream`. | **Done** (34 e2e checks) |
| 2.2 SIM-calling Android app | Kotlin app per `design/SIM-CALLING.md`: pairing, my leads, tap to dial, call-log capture, disposition sheet, offline queue + reconciliation, recording upload. Needs Android Studio on the build machine. | Planned |
| 2.3 WhatsApp | WhatsApp Cloud API (Meta's free test number): shared inbox per business line, new chats → leads, templates, broadcasts with opt-out, chat on the lead. | Planned |
| 2.4 SMS & templates | DLT SMS provider adapter, message templates (WhatsApp / SMS / email) with lead placeholders. | Planned |
| 2.5 Automation | Rules "when X, if Y, then Z" (assign, change stage, create task, send message, webhook), schedules, sequences that stop on reply. | Planned |
| 2.6 Calling campaigns | Power dialer queue with required disposition, campaign reports, call coaching comments on recordings. | Planned |
| 2.7 Help desk | Tickets linked to Customer 360, SLA, knowledge base. | Planned |
| 2.8 Connected accounts | Native Facebook Lead Ads (Meta app review), Gmail / Outlook email sync and tracking, meeting booking links. | Planned |
