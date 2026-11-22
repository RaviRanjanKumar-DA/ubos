import { HrController, HrReminders } from './modules/hr/hr.controller';
import { AttendanceController } from './modules/hr/attendance.controller';
import { AccessController, AccessReminders } from './modules/packages/access';
import { GalleryController, PublicGalleryController } from './modules/packages/gallery';
import { ExpensesController } from './modules/finance/expenses.controller';
import { CollectionsController, CollectionsReminders } from './modules/finance/collections';
import { PaymentLinksController, RazorpayWebhooks } from './modules/finance/payment-links';
import { InvoicesController } from './modules/finance/invoices.controller';
import { ChatbotController, PublicChatController, ScheduledMessagesController } from './modules/chatbot/chatbot.controller';
import { ChatbotService } from './modules/chatbot/chatbot.service';
import { LeadRulesController } from './modules/lead-rules.controller';
import { BookingLinksController, PublicBookingController } from './modules/connected/booking.controller';
import { ConnectCallbackController, ConnectedController, TrackingController } from './modules/connected/connected.controller';
import { MailService } from './modules/connected/mail.service';
import { Controller, Get, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { DbService } from './common/db.service';
import { TenantMiddleware } from './common/tenant.middleware';
import { TenantAuthGuard } from './common/auth.guard';
import { ErrorFilter } from './common/errors';
import { AuthController } from './modules/auth.controller';
import { WorkspacesController } from './modules/workspaces.controller';
import { LeadsController } from './modules/leads.controller';
import { IntegrationsController } from './modules/integrations.controller';
import { AuditController } from './modules/audit.controller';
import { DashboardController } from './modules/dashboard.controller';
import { PlatformController, PlatformGuard } from './platform/platform.controller';
import { SecurityController } from './modules/security.controller';
import { OAuthController } from './auth/oauth.controller';
import { SessionService } from './auth/sessions';
import { TenantLoginService } from './auth/login.service';
import { Mailer } from './auth/mailer';
import { SignupController, PlatformBillingController, PlatformRazorpayWebhook } from './platform/signup.controller';
import { BillingLifecycle } from './platform/billing-lifecycle';
import { UsersController } from './modules/users.controller';
import { RolesController } from './modules/roles.controller';
import { OrgController } from './modules/org.controller';
import { WorkspaceSettingsController } from './modules/workspace-settings.controller';
import { CustomersController } from './modules/customers.controller';
import { LeadWorkController } from './modules/lead-work.controller';
import { LeadImportController } from './modules/lead-import.controller';
import { SetupGuideController } from './modules/setup-guide.controller';
import { AnalyticsController } from './modules/analytics/analytics.controller';
import { ReportsController } from './modules/analytics/reports.controller';
import { BulkToolsController } from './modules/bulk-tools.controller';
import { LabelsScriptsController } from './modules/labels-scripts.controller';
import { ViewsTasksController } from './modules/views-tasks.controller';
import { NotificationsSettingsController } from './modules/notifications-settings.controller';
import { SchedulerService } from './modules/scheduler.service';
import { DataToolsController } from './modules/data-tools.controller';
import { CustomActionsController } from './modules/custom-actions.controller';
import { BillingController } from './modules/billing.controller';
import { SalesController } from './modules/sales.controller';
import { ProcessController } from './modules/process.controller';
import { DealsController } from './modules/deals.controller';
import { DeveloperController } from './modules/developer.controller';
import { HooksController, PublicApiController, PublicFormsController } from './modules/public.controller';
import { IntakeService, WebhookDispatcher } from './modules/integration-runtime';
import { CallsController } from './modules/calling/calls.controller';
import { TicketsController } from './modules/support/tickets.controller';
import { KbController } from './modules/support/kb.controller';
import { CampaignsController } from './modules/calling/campaigns.controller';
import { MobileController } from './modules/calling/mobile.controller';
import { CallingService } from './modules/calling/calling.service';
import { WhatsAppController } from './modules/whatsapp/whatsapp.controller';
import { WhatsAppService } from './modules/whatsapp/whatsapp.service';
import { MessagingController, UnsubscribeController } from './modules/messaging/messaging.controller';
import { MessagingService } from './modules/messaging/messaging.service';
import { AutomationController } from './modules/automation/automation.controller';
import { FlowsController } from './modules/automation/flows.controller';
import { AutomationService } from './modules/automation/automation.service';

@Controller('health')
class HealthController {
  constructor(private db: DbService) {}
  @Get()
  async health() {
    await this.db.app.$queryRaw`SELECT 1`;
    return { status: 'ok', time: new Date().toISOString() };
  }
}

@Module({
  imports: [JwtModule.register({})],
  controllers: [
    HrController,
    AttendanceController,
    FlowsController,
    ReportsController,
    BulkToolsController,
    SignupController,
    PlatformBillingController,
    PlatformRazorpayWebhook,
    AccessController,
    GalleryController,
    PublicGalleryController,
    ExpensesController,
    CollectionsController,
    PaymentLinksController,
    InvoicesController,
    ChatbotController, PublicChatController, ScheduledMessagesController,
    LeadRulesController,
    BookingLinksController, PublicBookingController, ConnectedController, ConnectCallbackController, TrackingController,
    HealthController, AuthController, WorkspacesController, LeadsController,
    IntegrationsController, AuditController, DashboardController, PlatformController,
    SecurityController, OAuthController, UsersController, RolesController, OrgController,
    WorkspaceSettingsController, CustomersController, LeadImportController, SetupGuideController, AnalyticsController, LabelsScriptsController, ViewsTasksController, NotificationsSettingsController, DataToolsController, LeadWorkController,
    CustomActionsController, BillingController, SalesController, ProcessController, DealsController, DeveloperController, HooksController, PublicFormsController, PublicApiController, CallsController, CampaignsController, TicketsController, KbController, MobileController, WhatsAppController, MessagingController, UnsubscribeController, AutomationController,
  ],
  providers: [
    DbService,
    SessionService,
    TenantLoginService,
    Mailer,
    BillingLifecycle,
    SchedulerService,
    IntakeService,
    WebhookDispatcher,
    CallingService,
    WhatsAppService,
    MessagingService,
    MailService,
    ChatbotService,
    RazorpayWebhooks,
    CollectionsReminders,
    AccessReminders,
    HrReminders,
    AutomationService,
    PlatformGuard,
    { provide: APP_GUARD, useClass: TenantAuthGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes('api/v1/*path');
  }
}
