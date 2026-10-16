import 'reflect-metadata';
import { resolve } from 'path';
import { config } from 'dotenv';
config({ path: resolve(__dirname, '../../../.env') });

import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { contextStore } from './common/context';

async function bootstrap() {
  for (const key of ['APP_DATABASE_URL', 'PLATFORM_DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_PLATFORM_SECRET']) {
    if (!process.env[key]) throw new Error(`Missing environment variable ${key}`);
  }
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: (process.env.WEB_ORIGIN ?? 'http://localhost:3000').split(','),
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Tenant', 'X-Workspace'],
  });
  // Every request runs inside its own context (trace id, tenant, user) — read via ctx().
  app.use((req: { ip?: string; headers: Record<string, unknown> }, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    const traceId = randomUUID();
    res.setHeader('X-Trace-Id', traceId);
    contextStore.run({ traceId, ip: req.ip ?? null }, next);
  });
  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port);
  Logger.log(`UBOS API listening on http://localhost:${port}`, 'Bootstrap');
}
bootstrap();
