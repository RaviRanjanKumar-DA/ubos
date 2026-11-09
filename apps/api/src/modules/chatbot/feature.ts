import { NotFoundException } from '@nestjs/common';
import type { Tx } from '@ubos/database';
import { tenantFeatures } from '../../common/auth-for';

/** Website chat is answered in the shared inbox, so a plan without the inbox cannot offer it. */
export async function authFeatureCheck(tx: Tx) {
  const { features } = await tenantFeatures(tx);
  if (!features.has('module.whatsapp')) throw new NotFoundException({ code: 'NOT_FOUND', message: 'This chat is not available' });
}
