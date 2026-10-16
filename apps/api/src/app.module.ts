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
    HealthController, AuthController, WorkspacesController, LeadsController,
    IntegrationsController, AuditController, DashboardController, PlatformController,
    SecurityController, OAuthController,
  ],
  providers: [
    DbService,
    SessionService,
    TenantLoginService,
    Mailer,
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
