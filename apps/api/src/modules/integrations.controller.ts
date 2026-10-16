import { Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { DbService } from '../common/db.service';
import { RequireFeature, RequirePermission } from '../common/auth.guard';
import { auth } from '../common/context';

// Display metadata for the hub; credentials and field mapping arrive with each adapter (Phase 1–2).
const CATALOGUE: Record<string, { name: string; description: string }> = {
  callerdesk: { name: 'CallerDesk', description: 'Cloud calling, IVR and call recordings' },
  whatsapp: { name: 'WhatsApp', description: 'Shared inbox, templates, broadcast and chatbot' },
  whatsapp_widget: { name: 'WhatsApp Chat Widget', description: 'Website chat button that creates leads' },
  google_sheets: { name: 'Google Sheets', description: 'Import leads from sheets and export reports' },
  razorpay: { name: 'Razorpay', description: 'Payment links, payments and refunds' },
  website_api: { name: 'Website / API', description: 'Capture leads from any website form or system' },
  facebook_leads: { name: 'Facebook', description: 'Facebook & Instagram Lead Ads' },
  indiamart: { name: 'IndiaMart', description: 'Buyer enquiries as leads' },
  justdial: { name: 'JustDial', description: 'JustDial enquiries as leads' },
  google_meet: { name: 'Google Meet', description: 'Meeting links on tasks' },
};

@Controller('api/v1/integrations')
@RequireFeature('module.integrations')
export class IntegrationsController {
  constructor(private db: DbService) {}

  @Get()
  @RequirePermission('integrations.view')
  async list() {
    const rows = await this.db.tenant((tx) => tx.integrationConnection.findMany({ orderBy: { key: 'asc' } }));
    return rows.map((r) => ({
      key: r.key, status: r.status, activatedAt: r.activatedAt,
      ...(CATALOGUE[r.key] ?? { name: r.key, description: '' }),
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
    return this.db.tenant(async (tx) => {
      const conn = await tx.integrationConnection.findFirst({ where: { key, workspaceId: null } });
      if (!conn) throw new NotFoundException({ code: 'INTEGRATION_NOT_FOUND', message: 'Unknown integration' });
      await tx.integrationConnection.update({
        where: { id: conn.id },
        data: { status, activatedAt: status === 'active' ? new Date() : conn.activatedAt, activatedById: auth().userId },
      });
      await this.db.audit(tx, {
        entity: 'integration', entityId: key, action: `integration.${status === 'active' ? 'activated' : 'deactivated'}`,
        oldValue: { status: conn.status }, newValue: { status },
      });
      return { key, status };
    });
  }
}
