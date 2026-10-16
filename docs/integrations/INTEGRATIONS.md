# Integrations Hub

Every integration can be **activated, paused or deactivated by the owner** (or roles granted `integrations.manage`).
Deactivating stops all traffic immediately but keeps history and settings; re-activation is one click.

Lifecycle: `available → activate → credentials → test connection → field mapping → active ⇄ paused → deactivated`

| Integration | Purpose | Mechanism | Phase |
|---|---|---|---|
| CallerDesk | Click-to-call, inbound screen-pop, IVR, call logs, recordings | REST API out, call-event webhooks in | 2 |
| WhatsApp Business | Shared inbox, templates, broadcast, chatbot, alerts | Meta Cloud API or BSP + webhooks | 2 |
| WhatsApp Chat Widget | Website chat entry point → lead | JS snippet | 2 |
| Google Sheets | Import leads from sheets; export/sync reports & views | Google OAuth + Sheets API | 1 |
| Website / API | Lead capture from forms / backends | Incoming webhook / REST + API key | 1 |
| Razorpay | Payment links, payments, refunds, auto-receipts | REST + signed webhooks | 3 |
| Facebook & Instagram Lead Ads | Real-time leads | Meta Graph webhooks | 2 |
| Google Ads lead forms | Leads | Webhook | 5 |
| IndiaMart, JustDial | Enquiries → leads | Vendor APIs | 5 |
| 99acres, Housing, MagicBricks | Property enquiries → leads | Vendor APIs / email parsing | 5 |
| Google Meet / Calendar | Meeting links, calendar sync | Google OAuth | 2 |
| Email (Gmail / M365 / SMTP) | Send and log email | OAuth / SMTP | 2 |
| SMS (DLT) | OTP and alerts | Provider API | 2 |
| Tally / Zoho Books | Push invoices & receipts | Export / API | 5 |
| Gemini / Claude / OpenAI | AI Suite | API keys via AI Gateway | 4 |
| Biometric devices | Attendance punches | CSV / vendor API | 3 |

## Adapter contract (for developers)

Each adapter in `packages/integrations/<name>` implements:

```ts
interface IntegrationAdapter {
  key: string;
  activate(config: unknown): Promise<void>;
  testConnection(): Promise<{ ok: boolean; message?: string }>;
  handleWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<void>;
  sync?(): Promise<void>;
  deactivate(): Promise<void>;
}
```

Rules: credentials encrypted at rest and never returned to the browser; every inbound webhook is signature-checked, stored raw in `webhook_inbox`, then processed from a queue with retry and replay.
