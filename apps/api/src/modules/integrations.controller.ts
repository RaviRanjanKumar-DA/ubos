import { Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { DbService } from '../common/db.service';
import { RequireFeature, RequirePermission } from '../common/auth.guard';
import { auth, tenantId } from '../common/context';

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
export const INTEGRATION_CATEGORIES: Category[] = [
  'Lead sources', 'Forms & surveys', 'Calling', 'Messaging', 'Website & e-commerce', 'Payments', 'Accounting',
  'Marketing & analytics', 'AI & automation', 'Productivity', 'Support desks', 'Other CRMs',
];

@Controller('api/v1/integrations')
@RequireFeature('module.integrations')
export class IntegrationsController {
  constructor(private db: DbService) {}

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
