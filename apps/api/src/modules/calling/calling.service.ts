import { HttpException, Injectable, Logger } from '@nestjs/common';
import { normalizeMobile, LIVE_TENANT_STATUSES } from '@ubos/shared';
import { DbService } from '../../common/db.service';
import { contextStore } from '../../common/context';
import { tenantFeatures } from '../../common/auth-for';
import { live } from '../../common/live';
import { storage } from '../../common/storage';
import { decrypt, encrypt } from '../../auth/crypto';
import { assertPublicUrl, type IntegrationConfig } from '../integration-runtime';
import { ingestCall, normalizeCloudCall } from './call-pipeline';

const MAX_RECORDING = 50 * 1024 * 1024;
export const CALL_PROVIDERS = new Set(['callerdesk']);
export const recordingKey = (tenantId: string, callId: string) => `${tenantId}/recordings/${callId}.rec`;

/** Cloud calling (CallerDesk first): incoming call webhooks, recordings copied or linked, click-to-call, retention. */
@Injectable()
export class CallingService {
  private readonly log = new Logger('Calling');
  constructor(private db: DbService) {}

  /** One webhook record from a cloud-calling provider → the call pipeline. */
  async ingestCloud(tenantId: string, provider: string, cfg: IntegrationConfig, record: Record<string, unknown>) {
    const n = normalizeCloudCall(provider, record);
    if (!n.externalId || !n.phone) return { status: 'rejected' as const, error: 'The call id or the customer number is missing' };
    const settings = await this.db.tenant((tx) => tx.organizationSetting.findFirst());
    const agent = n.agent ? normalizeMobile(n.agent) : null;
    const user = agent ? await this.db.tenant((tx) => tx.user.findFirst({ where: { mobile: agent, isActive: true } })) : null;
    const r = await this.db.tenant((tx) => ingestCall(tx, {
      tenantId, userId: user?.id ?? null, channel: 'cloud', provider, unknownWorkspaceId: cfg.values.businessLine || settings?.unknownCallerWorkspaceId || null,
    }, { externalId: n.externalId!, direction: n.direction, phone: n.phone!, startedAt: n.startedAt, ringSec: n.ringSec, talkSec: n.talkSec, answered: n.answered }));
    r.live.forEach((e) => live.publish(tenantId, e));
    if (n.recordingUrl && r.status !== 'duplicate') await this.keepRecording(tenantId, r.callId, n.recordingUrl, settings?.recordingMode ?? 'ubos');
    return { status: r.status, callId: r.callId, leadId: r.leadId };
  }

  /** "Copy into UBOS" downloads the provider's file (encrypted at rest); "link only" stores the address, encrypted. */
  private async keepRecording(tenantId: string, callId: string, url: string, mode: string) {
    if (mode === 'ubos') {
      try {
        await assertPublicUrl(url);
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'follow' });
        const len = Number(res.headers.get('content-length') ?? 0);
        if (!res.ok || len > MAX_RECORDING) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_RECORDING || !buf.length) throw new Error('Empty or too large');
        const k = recordingKey(tenantId, callId);
        await storage.put(k, buf);
        const mime = (res.headers.get('content-type') ?? 'audio/mpeg').split(';')[0];
        await this.db.tenant((tx) => tx.call.update({ where: { id: callId }, data: { recordingStatus: 'ready', recordingKey: k, recordingBytes: buf.length, recordingMime: /^audio\//.test(mime) ? mime : 'audio/mpeg', recordingLinkEnc: encrypt(url) } }));
        return;
      } catch (e) {
        this.log.warn(`Recording copy failed, keeping the link: ${e instanceof Error ? e.message : e}`);
      }
    }
    await this.db.tenant((tx) => tx.call.update({ where: { id: callId }, data: { recordingStatus: 'link', recordingLinkEnc: encrypt(url) } }));
  }

  /** Asks the cloud provider to ring the agent's phone and then connect the customer. */
  async clickToCall(cfg: IntegrationConfig, agentMobile: string, customer: string) {
    const base = (cfg.values.apiBase || 'https://app.callerdesk.io/api').replace(/\/$/, '');
    const url = `${base}/click_to_call_v2?${new URLSearchParams({ calling_party_a: agentMobile.replace(/^\+91/, ''), calling_party_b: customer.replace(/^\+91/, ''), deskphone: cfg.values.callerId ?? '', authcode: cfg.values.apiKey ?? '', call_from_did: '1' })}`;
    await assertPublicUrl(url);
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch((e) => { throw new HttpException({ code: 'PROVIDER_UNREACHABLE', message: `CallerDesk could not be reached: ${e instanceof Error ? e.message : e}` }, 502); });
    const text = await res.text();
    if (!res.ok || /"type"\s*:\s*"error"|invalid|fail/i.test(text)) throw new HttpException({ code: 'PROVIDER_REFUSED', message: `CallerDesk refused the call: ${text.slice(0, 160)}` }, 502);
    return { ok: true };
  }

  /** The recording bytes (decrypted) or the provider link for one call. */
  async recording(call: { id: string; tenantId: string; recordingStatus: string; recordingKey: string | null; recordingLinkEnc: string | null; recordingMime: string | null }) {
    if (call.recordingStatus === 'ready' && call.recordingKey) return { data: await storage.get(call.recordingKey), mime: call.recordingMime ?? 'audio/mpeg' };
    if (call.recordingStatus === 'link' && call.recordingLinkEnc) return { link: decrypt(call.recordingLinkEnc) };
    return null;
  }

  /** Deletes recordings older than the retention (organization setting, never longer than the plan). Runs from the scheduler. */
  async purge(onlyTenantId?: string) {
    const tenants = await this.db.platform.tenant.findMany({ where: { status: { in: LIVE_TENANT_STATUSES }, ...(onlyTenantId ? { id: onlyTenantId } : {}) } });
    let removed = 0;
    for (const t of tenants) {
      await contextStore.run({ traceId: `purge-${Date.now()}`, ip: null, tenant: { id: t.id, slug: t.slug, name: t.name, status: t.status } }, async () => {
        const { plan } = await this.db.tenant((tx) => tenantFeatures(tx));
        const org = await this.db.tenant((tx) => tx.organizationSetting.findFirst());
        const days = Math.min(plan?.recordingRetentionDays ?? 90, org?.recordingRetentionDays ?? Number.MAX_SAFE_INTEGER);
        const before = new Date(Date.now() - days * 86_400_000);
        const old = await this.db.tenant((tx) => tx.call.findMany({ where: { startedAt: { lt: before }, recordingStatus: { in: ['ready', 'link', 'uploading'] } }, take: 500 }));
        for (const c of old) {
          if (c.recordingKey) await storage.remove(c.recordingKey);
          await storage.remove(`${recordingKey(t.id, c.id)}.part`).catch(() => undefined);
          await this.db.tenant((tx) => tx.call.update({ where: { id: c.id }, data: { recordingStatus: 'deleted', recordingKey: null, recordingLinkEnc: null } }));
          removed++;
        }
      });
    }
    return removed;
  }
}
