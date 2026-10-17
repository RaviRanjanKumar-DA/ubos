import { Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { DbService } from '../common/db.service';
import { RequireFeature, RequirePermission } from '../common/auth.guard';
import { auth, tenantId } from '../common/context';

type Category = 'Lead sources' | 'Calling' | 'Messaging' | 'Website & e-commerce' | 'Payments' | 'Productivity' | 'Other CRMs';
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
  indiamart: { name: 'IndiaMart', description: 'Buyer enquiries as leads', category: 'Lead sources', phase: 'Phase 5' },
  justdial: { name: 'JustDial', description: 'JustDial enquiries as leads', category: 'Lead sources', phase: 'Phase 5' },
  tradeindia: { name: 'Trade India', description: 'Trade India buyer enquiries as leads', category: 'Lead sources', phase: 'Phase 5' },
  sulekha: { name: 'Sulekha', description: 'Sulekha service enquiries as leads', category: 'Lead sources', phase: 'Phase 5' },
  shiksha: { name: 'Shiksha', description: 'Shiksha student enquiries as leads', category: 'Lead sources', phase: 'Phase 5' },
  acres99: { name: '99acres', description: '99acres property enquiries as leads', category: 'Lead sources', phase: 'Phase 5' },
  magicbricks: { name: 'MagicBricks', description: 'MagicBricks property enquiries as leads', category: 'Lead sources', phase: 'Phase 5' },
  housing: { name: 'Housing.com', description: 'Housing.com property enquiries as leads', category: 'Lead sources', phase: 'Phase 5' },
  // Calling
  callerdesk: { name: 'CallerDesk', description: 'Cloud calling, IVR and call recordings', category: 'Calling', phase: 'Phase 2' },
  knowlarity: { name: 'Knowlarity', description: 'Cloud telephony, IVR and call recordings', category: 'Calling', phase: 'Phase 5' },
  tatatele: { name: 'Tata Tele Business', description: 'Smartflo cloud calling and recordings', category: 'Calling', phase: 'Phase 5' },
  telecmi: { name: 'TeleCMI', description: 'Cloud calling and recordings', category: 'Calling', phase: 'Phase 5' },
  mcube: { name: 'MCube', description: 'Call tracking and recordings', category: 'Calling', phase: 'Phase 5' },
  maqsam: { name: 'Maqsam', description: 'Cloud call centre and recordings', category: 'Calling', phase: 'Phase 5' },
  // Messaging
  whatsapp: { name: 'WhatsApp Cloud API', description: 'Shared inbox, templates, broadcast, chatbot; new chats become leads', category: 'Messaging', phase: 'Phase 2' },
  whatsapp_widget: { name: 'WhatsApp Chat Widget', description: 'Website chat button that creates leads', category: 'Messaging', phase: 'Phase 2' },
  email_smtp: { name: 'Email (Gmail / Outlook / SMTP)', description: 'Send and log emails from UBOS', category: 'Messaging', phase: 'Phase 2' },
  sms_dlt: { name: 'SMS (DLT)', description: 'OTP and alerts through an Indian SMS provider', category: 'Messaging', phase: 'Phase 2' },
  // Website & e-commerce
  wordpress: { name: 'WordPress', description: 'Website forms (Contact Form 7, WPForms, Elementor) as leads', category: 'Website & e-commerce', phase: 'Phase 5' },
  shopify: { name: 'Shopify', description: 'Customers, orders and abandoned carts', category: 'Website & e-commerce', phase: 'Phase 5' },
  woocommerce: { name: 'WooCommerce', description: 'Customers, orders and abandoned carts', category: 'Website & e-commerce', phase: 'Phase 5' },
  // Payments
  razorpay: { name: 'Razorpay', description: 'Payment links, payments and refunds', category: 'Payments', phase: 'Phase 3' },
  // Productivity
  google_meet: { name: 'Google Meet & Calendar', description: 'Meeting links and calendar sync on tasks', category: 'Productivity', phase: 'Phase 2' },
  zoom: { name: 'Zoom', description: 'Meeting links, webinars and class recordings', category: 'Productivity', phase: 'Phase 5' },
  // Other CRMs — import existing data or keep it in sync while you move
  zoho_crm: { name: 'Zoho CRM', description: 'Import or sync leads, contacts and deals', category: 'Other CRMs', phase: 'Phase 5' },
  hubspot: { name: 'HubSpot', description: 'Import or sync contacts, companies and deals', category: 'Other CRMs', phase: 'Phase 5' },
  salesforce: { name: 'Salesforce', description: 'Import or sync leads, contacts and opportunities', category: 'Other CRMs', phase: 'Phase 5' },
  leadsquared: { name: 'LeadSquared', description: 'Import or sync leads and activities', category: 'Other CRMs', phase: 'Phase 5' },
  telecrm: { name: 'TeleCRM', description: 'Import leads, call history and statuses', category: 'Other CRMs', phase: 'Phase 5' },
  pipedrive: { name: 'Pipedrive', description: 'Import or sync people, organizations and deals', category: 'Other CRMs', phase: 'Phase 5' },
  freshsales: { name: 'Freshsales', description: 'Import or sync contacts and deals', category: 'Other CRMs', phase: 'Phase 5' },
  zapier: { name: 'Zapier / Make', description: 'Connect 5,000+ other apps through webhooks', category: 'Other CRMs', phase: 'Phase 2' },
};
export const INTEGRATION_KEYS = Object.keys(CATALOGUE);

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
