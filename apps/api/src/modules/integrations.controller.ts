import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { bringsLeads, DUPLICATE_MODES, DuplicateMode, FieldDef, guessTarget, MAP_TARGETS, normalizeMobile, setupFor, sourceFieldsFor, validateCustomFields } from '@ubos/shared';
import type { Tx } from '@ubos/database';
import { findCustomer } from '../common/customers';
import { decrypt, encrypt, randomToken } from '../auth/crypto';
import { ctx } from '../common/context';
import { parse } from '../common/errors';
import { DbService } from '../common/db.service';
import { RequireFeature, RequirePermission } from '../common/auth.guard';
import { auth, tenantId } from '../common/context';
import { IntakeService } from './integration-runtime';
import { registerIntegrationNames } from './public.controller';

type Category =
  | 'Lead sources' | 'Forms & surveys' | 'Calling' | 'Messaging' | 'Website & e-commerce' | 'Payments' | 'Accounting'
  | 'Marketing & analytics' | 'AI & automation' | 'Productivity' | 'Support desks' | 'Other CRMs';
interface Entry { name: string; description: string; category: Category; phase: string }

/**
 * Integrations Hub catalogue. Each organization switches entries on or off; the live data connection
 * (credentials, field mapping, sync) ships per adapter in the phase shown.
 */
const CATALOGUE: Record<string, Entry> = {
  // Lead sources / portals
  website_api: { name: 'Website / API', description: 'Capture leads from any website form or system', category: 'Lead sources', phase: 'Phase 1' },
  google_sheets: { name: 'Google Sheets', description: 'Import leads from sheets and export reports', category: 'Lead sources', phase: 'Phase 1' },
  facebook_leads: { name: 'Facebook & Instagram', description: 'Leads from Facebook & Instagram Lead Ads', category: 'Lead sources', phase: 'Phase 2' },
  google_ads: { name: 'Google Ads', description: 'Leads from Google Ads lead forms', category: 'Lead sources', phase: 'Phase 5' },
  linkedin_leads: { name: 'LinkedIn Lead Gen', description: 'Leads from LinkedIn Lead Gen forms', category: 'Lead sources', phase: 'Phase 5' },
  youtube: { name: 'YouTube', description: 'Lead forms on YouTube video ads', category: 'Lead sources', phase: 'Phase 5' },
  google_business: { name: 'Google Business Profile', description: 'Calls, messages and reviews from your Google listing', category: 'Lead sources', phase: 'Phase 5' },
  indiamart: { name: 'IndiaMart', description: 'Buyer enquiries as leads', category: 'Lead sources', phase: 'Phase 5' },
  justdial: { name: 'JustDial', description: 'JustDial enquiries as leads', category: 'Lead sources', phase: 'Phase 5' },
  tradeindia: { name: 'Trade India', description: 'Trade India buyer enquiries as leads', category: 'Lead sources', phase: 'Phase 5' },
  sulekha: { name: 'Sulekha', description: 'Sulekha service enquiries as leads', category: 'Lead sources', phase: 'Phase 5' },
  urbancompany: { name: 'Urban Company', description: 'Service partner enquiries as leads', category: 'Lead sources', phase: 'Phase 5' },
  shiksha: { name: 'Shiksha', description: 'Shiksha student enquiries as leads', category: 'Lead sources', phase: 'Phase 5' },
  collegedunia: { name: 'Collegedunia', description: 'Student enquiries as leads', category: 'Lead sources', phase: 'Phase 5' },
  careers360: { name: 'Careers360', description: 'Student enquiries as leads', category: 'Lead sources', phase: 'Phase 5' },
  acres99: { name: '99acres', description: '99acres property enquiries as leads', category: 'Lead sources', phase: 'Phase 5' },
  magicbricks: { name: 'MagicBricks', description: 'MagicBricks property enquiries as leads', category: 'Lead sources', phase: 'Phase 5' },
  housing: { name: 'Housing.com', description: 'Housing.com property enquiries as leads', category: 'Lead sources', phase: 'Phase 5' },
  nobroker: { name: 'NoBroker', description: 'Property enquiries as leads', category: 'Lead sources', phase: 'Phase 5' },
  // Forms & surveys
  google_forms: { name: 'Google Forms', description: 'Form responses become leads', category: 'Forms & surveys', phase: 'Phase 2' },
  typeform: { name: 'Typeform', description: 'Form responses become leads', category: 'Forms & surveys', phase: 'Phase 5' },
  jotform: { name: 'Jotform', description: 'Form responses become leads', category: 'Forms & surveys', phase: 'Phase 5' },
  tally_forms: { name: 'Tally Forms', description: 'Form responses become leads', category: 'Forms & surveys', phase: 'Phase 5' },
  // Calling
  callerdesk: { name: 'CallerDesk', description: 'Cloud calling, IVR and call recordings', category: 'Calling', phase: 'Phase 2' },
  knowlarity: { name: 'Knowlarity', description: 'Cloud telephony, IVR and call recordings', category: 'Calling', phase: 'Phase 5' },
  exotel: { name: 'Exotel', description: 'Cloud calling, IVR and call recordings', category: 'Calling', phase: 'Phase 5' },
  myoperator: { name: 'MyOperator', description: 'Cloud calling, IVR and call recordings', category: 'Calling', phase: 'Phase 5' },
  ozonetel: { name: 'Ozonetel', description: 'Cloud contact centre and dialer', category: 'Calling', phase: 'Phase 5' },
  servetel: { name: 'Servetel', description: 'Cloud calling and IVR', category: 'Calling', phase: 'Phase 5' },
  tatatele: { name: 'Tata Tele Business', description: 'Smartflo cloud calling and recordings', category: 'Calling', phase: 'Phase 5' },
  telecmi: { name: 'TeleCMI', description: 'Cloud calling and recordings', category: 'Calling', phase: 'Phase 5' },
  mcube: { name: 'MCube', description: 'Call tracking and recordings', category: 'Calling', phase: 'Phase 5' },
  maqsam: { name: 'Maqsam', description: 'Cloud call centre and recordings', category: 'Calling', phase: 'Phase 5' },
  twilio: { name: 'Twilio', description: 'International calling and SMS', category: 'Calling', phase: 'Phase 5' },
  // Messaging
  whatsapp: { name: 'WhatsApp Cloud API', description: 'Shared inbox, templates, broadcast, chatbot; new chats become leads', category: 'Messaging', phase: 'Phase 2' },
  whatsapp_widget: { name: 'WhatsApp Chat Widget', description: 'Website chat button that creates leads', category: 'Messaging', phase: 'Phase 2' },
  interakt: { name: 'Interakt', description: 'Use your Interakt WhatsApp number in UBOS', category: 'Messaging', phase: 'Phase 5' },
  wati: { name: 'WATI', description: 'Use your WATI WhatsApp number in UBOS', category: 'Messaging', phase: 'Phase 5' },
  aisensy: { name: 'AiSensy', description: 'Use your AiSensy WhatsApp number in UBOS', category: 'Messaging', phase: 'Phase 5' },
  gupshup: { name: 'Gupshup', description: 'WhatsApp and SMS through Gupshup', category: 'Messaging', phase: 'Phase 5' },
  instagram_dm: { name: 'Instagram Direct', description: 'Instagram DMs in the shared inbox; new chats become leads', category: 'Messaging', phase: 'Phase 5' },
  messenger: { name: 'Facebook Messenger', description: 'Page messages in the shared inbox', category: 'Messaging', phase: 'Phase 5' },
  telegram: { name: 'Telegram', description: 'Bot messages in the shared inbox', category: 'Messaging', phase: 'Phase 5' },
  email_smtp: { name: 'Email (Gmail / Outlook / SMTP)', description: 'Send and log emails from UBOS', category: 'Messaging', phase: 'Phase 2' },
  sms_dlt: { name: 'SMS (DLT)', description: 'OTP and alerts through an Indian SMS provider (MSG91, Kaleyra…)', category: 'Messaging', phase: 'Phase 2' },
  // Website & e-commerce
  wordpress: { name: 'WordPress', description: 'Website forms (Contact Form 7, WPForms, Elementor) as leads', category: 'Website & e-commerce', phase: 'Phase 5' },
  wix: { name: 'Wix', description: 'Website forms and store customers as leads', category: 'Website & e-commerce', phase: 'Phase 5' },
  webflow: { name: 'Webflow', description: 'Website forms as leads', category: 'Website & e-commerce', phase: 'Phase 5' },
  shopify: { name: 'Shopify', description: 'Customers, orders and abandoned carts', category: 'Website & e-commerce', phase: 'Phase 5' },
  woocommerce: { name: 'WooCommerce', description: 'Customers, orders and abandoned carts', category: 'Website & e-commerce', phase: 'Phase 5' },
  // Payments
  razorpay: { name: 'Razorpay', description: 'Payment links, payments and refunds', category: 'Payments', phase: 'Phase 3' },
  cashfree: { name: 'Cashfree', description: 'Payment links and payments', category: 'Payments', phase: 'Phase 3' },
  payu: { name: 'PayU', description: 'Payment links and payments', category: 'Payments', phase: 'Phase 3' },
  paytm: { name: 'Paytm', description: 'Payment links and UPI payments', category: 'Payments', phase: 'Phase 3' },
  phonepe: { name: 'PhonePe', description: 'UPI payments', category: 'Payments', phase: 'Phase 3' },
  instamojo: { name: 'Instamojo', description: 'Payment links and course / product sales', category: 'Payments', phase: 'Phase 3' },
  stripe: { name: 'Stripe', description: 'International card payments', category: 'Payments', phase: 'Phase 3' },
  paypal: { name: 'PayPal', description: 'International payments', category: 'Payments', phase: 'Phase 3' },
  // Accounting
  tally_prime: { name: 'TallyPrime', description: 'Invoices and receipts to Tally', category: 'Accounting', phase: 'Phase 3' },
  zoho_books: { name: 'Zoho Books', description: 'Invoices, payments and GST', category: 'Accounting', phase: 'Phase 3' },
  quickbooks: { name: 'QuickBooks', description: 'Invoices and payments', category: 'Accounting', phase: 'Phase 3' },
  // Marketing & analytics
  google_analytics: { name: 'Google Analytics', description: 'Send conversions; see which pages bring leads', category: 'Marketing & analytics', phase: 'Phase 4' },
  meta_capi: { name: 'Meta Conversions API', description: 'Send won leads back to Facebook / Instagram ads', category: 'Marketing & analytics', phase: 'Phase 4' },
  mailchimp: { name: 'Mailchimp', description: 'Sync audiences and campaign results', category: 'Marketing & analytics', phase: 'Phase 4' },
  brevo: { name: 'Brevo', description: 'Email and SMS campaigns', category: 'Marketing & analytics', phase: 'Phase 4' },
  // AI & automation
  openai: { name: 'OpenAI (ChatGPT)', description: 'Use your own key for AI notes, replies and scoring', category: 'AI & automation', phase: 'Phase 4' },
  anthropic: { name: 'Anthropic (Claude)', description: 'Use your own key for AI notes, replies and scoring', category: 'AI & automation', phase: 'Phase 4' },
  gemini: { name: 'Google Gemini', description: 'Use your own key for AI notes, replies and scoring', category: 'AI & automation', phase: 'Phase 4' },
  zapier: { name: 'Zapier', description: 'Connect thousands of other apps through triggers and actions', category: 'AI & automation', phase: 'Phase 2' },
  make: { name: 'Make', description: 'Visual automations with other apps', category: 'AI & automation', phase: 'Phase 2' },
  n8n: { name: 'n8n', description: 'Self-hosted automations with other apps', category: 'AI & automation', phase: 'Phase 2' },
  pabbly: { name: 'Pabbly Connect', description: 'Automations with other apps', category: 'AI & automation', phase: 'Phase 2' },
  // Productivity
  google_meet: { name: 'Google Meet & Calendar', description: 'Meeting links and calendar sync on tasks', category: 'Productivity', phase: 'Phase 2' },
  zoom: { name: 'Zoom', description: 'Meeting links, webinars and class recordings', category: 'Productivity', phase: 'Phase 5' },
  ms_teams: { name: 'Microsoft Teams & Outlook', description: 'Meeting links and calendar sync', category: 'Productivity', phase: 'Phase 5' },
  calendly: { name: 'Calendly', description: 'Booked meetings become leads and follow-ups', category: 'Productivity', phase: 'Phase 2' },
  google_drive: { name: 'Google Drive', description: 'Attach and store documents on leads and customers', category: 'Productivity', phase: 'Phase 5' },
  dropbox: { name: 'Dropbox', description: 'Attach and store documents', category: 'Productivity', phase: 'Phase 5' },
  slack: { name: 'Slack', description: 'Alerts for new leads, wins and approvals', category: 'Productivity', phase: 'Phase 5' },
  notion: { name: 'Notion', description: 'Push won customers and notes to Notion', category: 'Productivity', phase: 'Phase 5' },
  // Support desks
  freshdesk: { name: 'Freshdesk', description: 'Tickets linked to customers', category: 'Support desks', phase: 'Phase 5' },
  zendesk: { name: 'Zendesk', description: 'Tickets linked to customers', category: 'Support desks', phase: 'Phase 5' },
  intercom: { name: 'Intercom', description: 'Chats and tickets linked to customers', category: 'Support desks', phase: 'Phase 5' },
  // Other CRMs — import existing data or keep it in sync while you move
  zoho_crm: { name: 'Zoho CRM', description: 'Import or sync leads, contacts and deals', category: 'Other CRMs', phase: 'Phase 5' },
  hubspot: { name: 'HubSpot', description: 'Import or sync contacts, companies and deals', category: 'Other CRMs', phase: 'Phase 5' },
  salesforce: { name: 'Salesforce', description: 'Import or sync leads, contacts and opportunities', category: 'Other CRMs', phase: 'Phase 5' },
  leadsquared: { name: 'LeadSquared', description: 'Import or sync leads and activities', category: 'Other CRMs', phase: 'Phase 5' },
  telecrm: { name: 'TeleCRM', description: 'Import leads, call history and statuses', category: 'Other CRMs', phase: 'Phase 5' },
  pipedrive: { name: 'Pipedrive', description: 'Import or sync people, organizations and deals', category: 'Other CRMs', phase: 'Phase 5' },
  freshsales: { name: 'Freshsales', description: 'Import or sync contacts and deals', category: 'Other CRMs', phase: 'Phase 5' },
  bitrix24: { name: 'Bitrix24', description: 'Import or sync leads and deals', category: 'Other CRMs', phase: 'Phase 5' },
  odoo: { name: 'Odoo', description: 'Import or sync leads, contacts and sales orders', category: 'Other CRMs', phase: 'Phase 5' },
  kylas: { name: 'Kylas', description: 'Import leads, deals and call history', category: 'Other CRMs', phase: 'Phase 5' },
};
export const INTEGRATION_KEYS = Object.keys(CATALOGUE);
/** Lead sources whose live connection works now (webhook receiver or Google Sheets sync). */
export const LIVE_NOW = new Set(['razorpay', 'acres99', 'magicbricks', 'housing', 'sulekha', 'facebook_leads', 'website_api', 'google_sheets', 'indiamart', 'justdial', 'google_forms', 'google_ads', 'wordpress', 'shopify', 'woocommerce', 'calendly', 'zapier', 'make', 'n8n', 'pabbly', 'callerdesk', 'whatsapp', 'sms_dlt']);
for (const k of LIVE_NOW) CATALOGUE[k].phase = 'Live';
registerIntegrationNames(Object.fromEntries(Object.entries(CATALOGUE).map(([k, e]) => [k, e.name])));
export const INTEGRATION_CATEGORIES: Category[] = [
  'Lead sources', 'Forms & surveys', 'Calling', 'Messaging', 'Website & e-commerce', 'Payments', 'Accounting',
  'Marketing & analytics', 'AI & automation', 'Productivity', 'Support desks', 'Other CRMs',
];

@Controller('api/v1/integrations')
@RequireFeature('module.integrations')
export class IntegrationsController {
  constructor(private db: DbService, private intake: IntakeService) {}

  /** Full catalogue merged with this organization's switches (missing row = inactive). */
  @Get()
  @RequirePermission('integrations.view')
  async list() {
    const rows = await this.db.tenant((tx) => tx.integrationConnection.findMany({ where: { workspaceId: null } }));
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return Object.entries(CATALOGUE).map(([key, e]) => ({
      key, ...e, status: byKey.get(key)?.status ?? 'inactive', activatedAt: byKey.get(key)?.activatedAt ?? null,
    }));
  }

  /** Setup panel: steps, fields (secrets shown masked), webhook URL and status. */
  @Get(':key/setup')
  @RequirePermission('integrations.view')
  setup(@Param('key') key: string) {
    const entry = CATALOGUE[key];
    if (!entry) throw new NotFoundException({ code: 'INTEGRATION_NOT_FOUND', message: 'Unknown integration' });
    const def = setupFor(key, entry.category);
    return this.db.tenant(async (tx) => {
      const conn = await tx.integrationConnection.findFirst({ where: { key, workspaceId: null } });
      const cfg = this.config(conn?.configEncrypted);
      const workspaces = await tx.workspace.findMany({ where: { isArchived: false }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
      const values = Object.fromEntries(def.fields.map((f) => {
        const v = cfg.values[f.key];
        if (v === undefined || v === '') return [f.key, ''];
        return [f.key, f.type === 'secret' ? `••••${String(v).slice(-4)}` : v];
      }));
      return {
        key, ...entry, status: conn?.status ?? 'inactive', activatedAt: conn?.activatedAt ?? null, lastEventAt: conn?.lastEventAt ?? null,
        steps: def.steps, where: def.where ?? null,
        fields: def.fields.map((f) => (f.key === 'businessLine' ? { ...f, options: workspaces.map((w) => w.id), optionLabels: workspaces.map((w) => w.name) } : f)),
        values, configured: Object.keys(cfg.values).length > 0,
        mapping: bringsLeads(def) ? await this.mappingView(tx, key, cfg) : null,
        webhookUrl: def.webhook && cfg.webhookToken ? `${(process.env.API_PUBLIC_URL ?? 'http://localhost:4000').replace(/\/$/, '')}/hooks/${ctx().tenant!.slug}/${key}/${cfg.webhookToken}` : null,
        needsWebhook: !!def.webhook,
        verifyToken: key === 'whatsapp' ? cfg.webhookToken ?? null : null,
      };
    });
  }

  /** Saves the settings (secrets encrypted; unchanged masked secrets are kept) and optionally activates. */
  @Put(':key/setup')
  @RequirePermission('integrations.manage', 'ORGANIZATION')
  saveSetup(@Param('key') key: string, @Body() body: unknown) {
    const entry = CATALOGUE[key];
    if (!entry) throw new NotFoundException({ code: 'INTEGRATION_NOT_FOUND', message: 'Unknown integration' });
    const input = parse(z.object({ values: z.record(z.string().max(2000)), activate: z.boolean().default(false) }), body);
    const def = setupFor(key, entry.category);
    return this.db.tenant(async (tx) => {
      const conn = await tx.integrationConnection.findFirst({ where: { key, workspaceId: null } });
      const old = this.config(conn?.configEncrypted);
      const values: Record<string, string> = {};
      for (const f of def.fields) {
        let v = (input.values[f.key] ?? '').trim();
        if (f.type === 'secret' && (v.startsWith('••••') || v === '')) v = old.values[f.key] ?? '';
        if (f.required && !v) throw new BadRequestException({ code: 'FIELD_REQUIRED', message: `${f.label} is required` });
        if (v && f.type === 'url' && !/^https?:\/\/\S+$/.test(v)) throw new BadRequestException({ code: 'INVALID_URL', message: `${f.label} must start with https://` });
        if (v && f.type === 'number' && Number.isNaN(Number(v))) throw new BadRequestException({ code: 'INVALID_NUMBER', message: `${f.label} must be a number` });
        if (v && f.type === 'select' && f.key !== 'businessLine' && f.options && !f.options.includes(v)) throw new BadRequestException({ code: 'INVALID_OPTION', message: `Choose a valid ${f.label}` });
        if (v && f.key === 'businessLine' && !(await tx.workspace.findFirst({ where: { id: v } }))) throw new BadRequestException({ code: 'INVALID_OPTION', message: 'Unknown business line' });
        if (v) values[f.key] = v;
      }
      const cfg = { ...old, values, webhookToken: old.webhookToken ?? (def.webhook ? randomToken(18).replace(/[^A-Za-z0-9]/g, '').slice(0, 24) : undefined) };
      const status = input.activate ? 'active' : conn?.status ?? 'inactive';
      const data = { configEncrypted: encrypt(JSON.stringify(cfg)), status, ...(input.activate && conn?.status !== 'active' ? { activatedAt: new Date(), activatedById: auth().userId } : {}) };
      if (conn) await tx.integrationConnection.update({ where: { id: conn.id }, data });
      else await tx.integrationConnection.create({ data: { tenantId: tenantId(), key, ...data } });
      await this.db.audit(tx, {
        entity: 'integration', entityId: key, action: 'integration.configured',
        // secrets never go into the audit log
        newValue: { fields: Object.keys(values).map((k) => (def.fields.find((f) => f.key === k)?.type === 'secret' ? `${k}:••••` : k)), activated: input.activate },
      });
      return { ok: true, status };
    });
  }

  /** Step 2 — how incoming data becomes a lead: field mapping and what to do with existing leads. */
  @Put(':key/mapping')
  @RequirePermission('integrations.manage', 'ORGANIZATION')
  saveMapping(@Param('key') key: string, @Body() body: unknown) {
    const entry = CATALOGUE[key];
    if (!entry) throw new NotFoundException({ code: 'INTEGRATION_NOT_FOUND', message: 'Unknown integration' });
    if (!bringsLeads(setupFor(key, entry.category))) throw new BadRequestException({ code: 'NO_MAPPING', message: 'This integration does not bring leads' });
    const input = parse(z.object({
      sourceFields: z.array(z.string().trim().min(1).max(80)).min(1).max(80),
      map: z.record(z.string().max(80)),
      duplicateMode: z.enum(Object.keys(DUPLICATE_MODES) as [DuplicateMode, ...DuplicateMode[]]),
      defaultSource: z.string().trim().max(40).optional(),
    }), body);
    return this.db.tenant(async (tx) => {
      const conn = await tx.integrationConnection.findFirst({ where: { key, workspaceId: null } });
      const cfg = this.config(conn?.configEncrypted);
      const ws = cfg.values.businessLine;
      if (!ws) throw new BadRequestException({ code: 'BUSINESS_LINE_REQUIRED', message: 'Choose the business line in step 1 and save first' });
      const targets = await this.targets(tx, ws);
      const map = Object.fromEntries(input.sourceFields.map((f) => [f, input.map[f] ?? 'ignore']));
      const bad = Object.values(map).filter((t) => !targets.some((x) => x.value === t));
      if (bad.length) throw new BadRequestException({ code: 'UNKNOWN_TARGET', message: `Unknown lead field "${bad[0]}"` });
      const used = Object.values(map).filter((t) => t !== 'ignore' && t !== 'remark');
      if (new Set(used).size !== used.length) throw new BadRequestException({ code: 'DUPLICATE_TARGET', message: 'Each lead field can receive only one incoming field' });
      const byEmail = (await tx.organizationSetting.findFirst())?.leadIdentifier === 'email';
      if (!used.includes('name')) throw new BadRequestException({ code: 'NAME_REQUIRED', message: 'Map one incoming field to Name' });
      if (!used.includes(byEmail ? 'email' : 'mobile')) throw new BadRequestException({ code: 'LEAD_ID_REQUIRED', message: `Map one incoming field to ${byEmail ? 'Email' : 'Mobile'} — it is your Lead ID` });
      const mapping = { sourceFields: input.sourceFields, map, duplicateMode: input.duplicateMode, defaultSource: input.defaultSource || key };
      const data = { configEncrypted: encrypt(JSON.stringify({ ...cfg, mapping })) };
      if (conn) await tx.integrationConnection.update({ where: { id: conn.id }, data });
      else await tx.integrationConnection.create({ data: { tenantId: tenantId(), key, status: 'inactive', ...data } });
      await this.db.audit(tx, { entity: 'integration', entityId: key, action: 'integration.mapping_saved', newValue: mapping });
      return { ok: true, mapping };
    });
  }

  /** Shows what a sample record would become, without saving anything. */
  @Post(':key/mapping/preview')
  @RequirePermission('integrations.view')
  previewMapping(@Param('key') key: string, @Body() body: unknown) {
    const { sample } = parse(z.object({ sample: z.record(z.unknown()) }), body);
    return this.db.tenant(async (tx) => {
      const conn = await tx.integrationConnection.findFirst({ where: { key, workspaceId: null } });
      const cfg = this.config(conn?.configEncrypted);
      if (!cfg.mapping || !cfg.values.businessLine) throw new BadRequestException({ code: 'MAPPING_REQUIRED', message: 'Save the field mapping first' });
      const ws = cfg.values.businessLine;
      const get = (path: string) => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), sample);
      const lead: Record<string, string> = {};
      const remarks: string[] = [];
      const custom: Record<string, unknown> = {};
      for (const [src, target] of Object.entries(cfg.mapping.map)) {
        const raw = get(src);
        if (raw === undefined || raw === null || raw === '') continue;
        const v = Array.isArray(raw) ? raw.join(', ') : typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
        if (target === 'ignore') continue;
        if (target === 'remark') remarks.push(v);
        else if (target === 'name') lead.name = lead.name ? `${lead.name} ${v}` : v;
        else if (target.startsWith('cf:')) custom[target.slice(3)] = v;
        else lead[target] = v;
      }
      const errors: string[] = [];
      const byEmail = (await tx.organizationSetting.findFirst())?.leadIdentifier === 'email';
      if (!lead.name) errors.push('Name is missing');
      const mobile = lead.mobile ? normalizeMobile(lead.mobile) : null;
      if (lead.mobile && !mobile) errors.push(`"${lead.mobile}" is not a valid mobile number`);
      if (!byEmail && !mobile) errors.push('Mobile is missing (it is your Lead ID)');
      if (byEmail && !lead.email) errors.push('Email is missing (it is your Lead ID)');
      const fields = (await tx.leadField.findMany({ where: { workspaceId: ws, isArchived: false } })) as unknown as FieldDef[];
      const { values, errors: fieldErrors } = validateCustomFields(fields, custom);
      errors.push(...Object.values(fieldErrors));
      const match = await findCustomer(tx, { mobile, email: lead.email || null, preferEmail: byEmail });
      let existing = null;
      if (match) {
        const leads = await tx.lead.findMany({ where: { customerId: match.customer.id, workspaceId: ws }, orderBy: { createdAt: 'desc' } });
        const stages = await tx.leadStage.findMany({ where: { id: { in: leads.map((l) => l.stageId) } } });
        const open = leads.find((l) => { const st = stages.find((x) => x.id === l.stageId); return st && !st.isWon && !st.isLost; });
        existing = { customerCode: match.customer.code, customerName: match.customer.name, openLeadId: open?.id ?? null };
      }
      const mode = cfg.mapping.duplicateMode as DuplicateMode;
      const outcome = errors.length ? 'rejected'
        : !existing?.openLeadId ? (existing ? 'new_lead_existing_customer' : 'new_lead_new_customer')
        : mode === 'new_lead' ? 'new_lead_existing_customer' : mode;
      return { lead: { ...lead, mobile: mobile ?? lead.mobile ?? null, remark: remarks.join('\n') || null, customFields: values, source: cfg.mapping.defaultSource }, errors, existing, outcome };
    });
  }

  private async targets(tx: Tx, workspaceId: string) {
    const fields = await tx.leadField.findMany({ where: { workspaceId, isArchived: false }, orderBy: { position: 'asc' } });
    return [
      ...Object.entries(MAP_TARGETS).map(([value, label]) => ({ value, label, required: false })),
      ...fields.map((f) => ({ value: `cf:${f.key}`, label: f.label, required: f.required })),
    ];
  }

  private async mappingView(tx: Tx, key: string, cfg: ReturnType<IntegrationsController['config']>) {
    const ws = cfg.values.businessLine;
    const targets = ws ? await this.targets(tx, ws) : Object.entries(MAP_TARGETS).map(([value, label]) => ({ value, label, required: false }));
    const sourceFields = cfg.mapping?.sourceFields ?? sourceFieldsFor(key);
    const map = cfg.mapping?.map ?? Object.fromEntries(sourceFields.map((f) => [f, guessTarget(f)]));
    const byEmail = (await tx.organizationSetting.findFirst())?.leadIdentifier === 'email';
    return {
      saved: !!cfg.mapping, businessLineSet: !!ws, sourceFields, map, duplicateMode: cfg.mapping?.duplicateMode ?? 'add_remark',
      defaultSource: cfg.mapping?.defaultSource ?? key, targets, leadIdentifier: byEmail ? 'email' : 'mobile',
      duplicateModes: Object.entries(DUPLICATE_MODES).map(([value, label]) => ({ value, label })),
    };
  }

  private config(blob: string | null | undefined): { values: Record<string, string>; webhookToken?: string; mapping?: { sourceFields: string[]; map: Record<string, string>; duplicateMode: string; defaultSource: string } } {
    if (!blob) return { values: {} };
    try { return JSON.parse(decrypt(blob)); } catch { return { values: {} }; }
  }

  /** Recent incoming records for this integration (webhook / sheet rows) with their outcome. */
  @Get(':key/events')
  @RequirePermission('integrations.view')
  events(@Param('key') key: string) {
    if (!CATALOGUE[key]) throw new NotFoundException({ code: 'INTEGRATION_NOT_FOUND', message: 'Unknown integration' });
    return this.db.tenant(async (tx) => {
      const rows = await tx.webhookInbox.findMany({ where: { integrationKey: key }, orderBy: { receivedAt: 'desc' }, take: 50 });
      const counts = await tx.webhookInbox.groupBy({ by: ['status'], where: { integrationKey: key, receivedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }, _count: true });
      return { last7Days: Object.fromEntries(counts.map((c) => [c.status, c._count])), items: rows.map((r) => ({ id: r.id, receivedAt: r.receivedAt, status: r.status, outcome: r.outcome, leadId: r.leadId, error: r.error, externalId: r.externalId, attempts: r.attempts, body: r.body.slice(0, 2000) })) };
    });
  }

  /** Runs a stored record again (after fixing the mapping or the business line). */
  @Post(':key/events/:id/replay')
  @RequirePermission('integrations.manage', 'ORGANIZATION')
  async replay(@Param('key') key: string, @Param('id') id: string) {
    const { row, cfg } = await this.db.tenant(async (tx) => {
      const row = await tx.webhookInbox.findFirst({ where: { id, integrationKey: key } });
      if (!row) throw new NotFoundException({ code: 'EVENT_NOT_FOUND', message: 'Event not found' });
      if (row.status === 'processed' || row.status === 'duplicate') throw new BadRequestException({ code: 'ALREADY_PROCESSED', message: 'This record already became a lead' });
      const conn = await tx.integrationConnection.findFirst({ where: { key, workspaceId: null } });
      return { row, cfg: this.config(conn?.configEncrypted) };
    });
    let record: Record<string, unknown>;
    try { record = JSON.parse(row.body); } catch { throw new BadRequestException({ code: 'UNREADABLE', message: 'The stored record cannot be read' }); }
    const out = await this.intake.viaMapping(tenantId(), key, CATALOGUE[key]?.name ?? key, cfg, record, row.externalId, undefined, row.id);
    await this.db.tenant((tx) => this.db.audit(tx, { entity: 'integration', entityId: key, action: 'integration.event_replayed', newValue: { eventId: id, outcome: out.outcome } }));
    return out;
  }

  /** Google Sheets: read the sheet now instead of waiting for the next automatic check. */
  @Post('google_sheets/sync')
  @RequirePermission('integrations.manage', 'ORGANIZATION')
  async syncSheet() {
    const r = await this.intake.syncSheet(tenantId());
    await this.db.tenant((tx) => this.db.audit(tx, { entity: 'integration', entityId: 'google_sheets', action: 'integration.sheet_synced', newValue: r }));
    return r;
  }

  @Post(':key/activate')
  @RequirePermission('integrations.manage', 'ORGANIZATION')
  activate(@Param('key') key: string) {
    return this.setStatus(key, 'active');
  }

  @Post(':key/deactivate')
  @RequirePermission('integrations.manage', 'ORGANIZATION')
  deactivate(@Param('key') key: string) {
    return this.setStatus(key, 'inactive');
  }

  private setStatus(key: string, status: 'active' | 'inactive') {
    if (!CATALOGUE[key]) throw new NotFoundException({ code: 'INTEGRATION_NOT_FOUND', message: 'Unknown integration' });
    return this.db.tenant(async (tx) => {
      const conn = await tx.integrationConnection.findFirst({ where: { key, workspaceId: null } });
      const data = { status, activatedAt: status === 'active' ? new Date() : conn?.activatedAt ?? null, activatedById: auth().userId };
      if (conn) await tx.integrationConnection.update({ where: { id: conn.id }, data });
      else await tx.integrationConnection.create({ data: { tenantId: tenantId(), key, ...data } });
      await this.db.audit(tx, {
        entity: 'integration', entityId: key, action: `integration.${status === 'active' ? 'activated' : 'deactivated'}`,
        oldValue: { status: conn?.status ?? 'inactive' }, newValue: { status },
      });
      return { key, status };
    });
  }
}
