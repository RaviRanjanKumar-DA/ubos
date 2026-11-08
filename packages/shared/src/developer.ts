// Public API scopes and outgoing webhook events (Settings → Developer).

export const API_SCOPES = {
  'leads:read': 'Read leads (within the key’s business line)',
  'leads:write': 'Create leads and update their status / stage / remarks',
  'customers:read': 'Read customers',
  'meta:read': 'Read business lines, stages, sources and fields',
} as const;
export type ApiScope = keyof typeof API_SCOPES;

export const WEBHOOK_EVENTS = {
  'lead.created': 'A new lead was created (any channel)',
  'lead.updated': 'A repeat enquiry was added to an existing lead',
  'lead.stage_changed': 'A lead moved to another stage',
  'lead.won': 'A lead was won',
  'lead.lost': 'A lead was lost',
  'payment.received': 'A payment was recorded',
  'process.completed': 'An after-sale process was completed',
  'quote.accepted': 'A customer accepted a quote',
  'call.logged': 'A call was logged (phone app, cloud calling or by hand)',
  'whatsapp.received': 'A WhatsApp message arrived',
} as const;
export type WebhookEvent = keyof typeof WEBHOOK_EVENTS;

/** Targets a web form field can fill. Custom fields are "cf:<key>". */
export const FORM_TARGETS: Record<string, string> = { name: 'Name', mobile: 'Mobile', email: 'Email', city: 'City', remark: 'Message' };
