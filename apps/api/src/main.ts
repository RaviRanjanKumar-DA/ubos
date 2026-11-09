import 'reflect-metadata';
import { resolve } from 'path';
import { config } from 'dotenv';
config({ path: resolve(__dirname, '../../../.env') });
process.env.TZ = 'Asia/Kolkata'; // every "today", due time and date filter is IST, whatever clock the server runs on

import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { contextStore } from './common/context';
import { DbService } from './common/db.service';
import { syncPermissionCatalog } from '@ubos/database';

async function bootstrap() {
  for (const key of ['APP_DATABASE_URL', 'PLATFORM_DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_PLATFORM_SECRET']) {
    if (!process.env[key]) throw new Error(`Missing environment variable ${key}`);
  }
  for (const key of ['ENCRYPTION_KEY']) {
    if (!process.env[key]) throw new Error(`Missing environment variable ${key}`);
  }
  // rawBody: webhook signatures (WhatsApp / Meta) are checked against the exact bytes received.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.use(cookieParser());
  app.enableCors({
    origin: (process.env.WEB_ORIGIN ?? 'http://localhost:3030').split(','),
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Tenant', 'X-Workspace', 'X-UBOS-CSRF', 'X-Chat-Token'],
    exposedHeaders: ['X-Total-Count', 'X-Trace-Id'],
  });
  // CSRF: a browser request that relies on session cookies must also carry a custom header,
  // which other websites cannot add (CORS). Together with SameSite=Lax cookies this blocks forged requests.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const usesCookies = Object.keys(req.cookies ?? {}).some((k) => k.startsWith('ubos_'));
    if (unsafe && usesCookies && !req.headers.authorization && req.headers['x-ubos-csrf'] !== '1') {
      return res.status(403).json({ code: 'CSRF_REJECTED', message: 'Request blocked for security reasons' });
    }
    next();
  });
  // Every request runs inside its own context (trace id, tenant, user) — read via ctx().
  app.use((req: { ip?: string; headers: Record<string, unknown> }, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    const traceId = randomUUID();
    res.setHeader('X-Trace-Id', traceId);
    contextStore.run({ traceId, ip: req.ip ?? null }, next);
  });
  const added = await syncPermissionCatalog(app.get(DbService).platform);
  if (added) Logger.log(`Granted ${added} new permission(s) to Organization Admin roles`, 'Bootstrap');
  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port);
  Logger.log(`UBOS API listening on http://localhost:${port}`, 'Bootstrap');
}
bootstrap();
