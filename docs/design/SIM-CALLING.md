# SIM calling — design (Phase 2)

Requested 18 Oct 2026: CRM calling in two flavours — **cloud calling** (IVR providers such as CallerDesk, Exotel,
Knowlarity) and **SIM calling** (reps call from their own phone) — sold as plan options: one, the other, or both.
SIM calls happen on the phone, so UBOS needs a phone app whose call log and recordings reach UBOS at once, with no
duplicates and nothing missing.

## Already in place (18 Oct 2026)

- Plan modules `module.telephony` (cloud) and `module.sim_calling` (SIM); the Platform Owner picks No calling / Cloud /
  SIM / Both per plan, plus how long recordings are kept (`Plan.recordingRetentionDays`).
- Billing shows which calling each licence includes; Security Policy → *Calls & recordings* shows what the plan
  includes and lets the organization choose where cloud-call recordings live (copied into UBOS storage, or link only)
  and a shorter retention than the plan limit.
- Calls already land on the lead as `LeadActivity` (type `call`, disposition, connected, duration), so dashboards,
  leaderboards and follow-up rules work the same for every calling type.

## Server side built (slice 2.1, 18 Oct 2026)

Pairing, the mobile API below, idempotent calls (`Call.externalId` unique per organization), edits (latest wins),
reconciliation, resumable recording upload (encrypted at rest), dial requests from the web, live updates to open
browsers, phones admin, retention purge — tested end to end with a simulated phone (`npm run verify:calling`).
The Android app itself is slice 2.2.

## The phone app (Android first)

| Part | Behaviour |
|---|---|
| Pairing | User opens *My Security → Devices → Add phone*, gets a 6-digit code (10 min). App enters org code + pairing code → receives a **device token** (stored in Android Keystore, revocable from the web). One active phone per user by default. |
| Dial from UBOS | Tap a lead's number in the app (or "Call" on the web, which pushes to the paired phone) → the phone dials with the SIM. The app knows which lead and which number the call is for. |
| Call capture | The app reads the phone's call log for the tracked number (READ_CALL_LOG) right after the call ends: direction, number, start time, ring and talk duration, answered or not. |
| Disposition | A full-screen sheet appears after every call: call outcome chips from the business line, remark, next follow-up. Mandatory if the organization requires it. Unanswered calls are pre-filled. |
| Recording | If the phone's own call recorder is on, the app finds the file for that call (matched by time window and number) and uploads it. Android does not allow apps to record calls themselves; UBOS never claims to. |
| Unknown callers | Incoming calls from numbers not in UBOS can create a lead in the user's business line (organization setting), using the same customer matching (mobile and other numbers). |

## Sync without discrepancy

1. **Every call has a stable key**: `deviceId + callLogId + startTime`. The API stores it as `LeadActivity.externalId`
   with a unique index per organization, so sending the same call twice never creates two activities (idempotent
   upsert; the second send returns the existing record).
2. **Instant path**: the app sends the call the moment it ends (HTTPS, device token). The web shows it immediately:
   the lead timeline and dashboards read the same table, and an event (`call.logged`) is pushed to open browser tabs
   (server-sent events) so a manager watching the leaderboard sees it within seconds.
3. **Offline path**: if there is no network, the call goes into an on-phone queue (SQLite) and is retried with
   back-off until the server acknowledges it. The queue survives restarts; the app shows "3 calls waiting to sync".
4. **Reconciliation**: on every app start and every 15 minutes, the app sends the call-log keys of the last 48 hours;
   the server answers with what it is missing, and the app re-sends those. Calls made while the app was closed are
   therefore never lost.
5. **One source of truth for time**: the phone's call-log times are stored as given (UTC) together with the server's
   receive time, so late-synced calls still count on the day they happened (dashboards use the call time).
6. **Edits after sync**: disposition / remark edits made in the app or on the web are versioned (`updatedAt`); the
   latest edit wins and both sides show it.
7. **Recordings upload separately** in chunks, resumable, after the call record exists; until then the call shows
   "recording uploading". Files are encrypted at rest in UBOS storage (MinIO / S3) and deleted after the retention
   period.

## API contract (to build in Phase 2)

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/devices/pair-code` | Signed-in user gets a 6-digit pairing code |
| `POST /mobile/v1/pair` | `{ org, code, deviceName, platform }` → `{ deviceId, token }` |
| `POST /mobile/v1/calls` | Batch of calls `{ externalId, leadId?, number, direction, startedAt, ringSec, talkSec, answered, disposition?, remark?, followUpAt? }` → per call `created` / `duplicate` / `unmatched` |
| `POST /mobile/v1/calls/reconcile` | `{ since, externalIds[] }` → ids the server does not have |
| `PUT /mobile/v1/calls/:externalId/recording` | Resumable upload of the recording file |
| `GET /mobile/v1/sync` | Leads assigned to me, today's follow-ups and tasks, call outcomes and scripts (delta since last sync) |
| `DELETE /api/v1/devices/:id` | Revoke a phone (admin or the user) |

Rules that stay the same as the web: data scope (a rep syncs only their leads), field-level security (masked numbers
stay masked in the app; the app dials through UBOS so the rep never needs to see the full number), audit log for
pairing, revoking and recording access.

## Cloud calling side

Provider webhooks (CallerDesk first) arrive at the private webhook URL from the integration setup panel; the call is
matched to the lead by number and saved with the same `externalId` rule (provider call id), so retries from the
provider never duplicate. Recordings are copied into UBOS storage or kept as provider links per the organization
setting.

## Order of work (Phase 2)

1. `LeadActivity.externalId` + unique index; devices table; pairing API.
2. Calls batch + reconcile API with idempotency tests (duplicates, out-of-order, offline replay, clock skew).
3. Android app (Kotlin): pairing, dial, call-log capture, disposition sheet, offline queue, recording upload.
4. Live updates to the web (server-sent events) and "phones" admin page (last sync, pending calls, app version).
5. CallerDesk webhook adapter on the same call pipeline.
