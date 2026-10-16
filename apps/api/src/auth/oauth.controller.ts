import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import { createHash } from 'crypto';
import { withTenant } from '@ubos/database';
import { DbService } from '../common/db.service';
import { ctx } from '../common/context';
import { randomToken } from './crypto';
import { authTransaction, LoginResult, TenantLoginService } from './login.service';

/**
 * "Continue with Google" (Gmail / Google Workspace) and "Continue with Microsoft" (Outlook / Office 365).
 * Standard OpenID Connect authorization-code flow with PKCE. Only users who already exist in the
 * organization can sign in this way (matched by verified email) — there is no self-signup.
 */
const PROVIDERS = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
    extra: { prompt: 'select_account' },
  },
  microsoft: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    userinfo: 'https://graph.microsoft.com/oidc/userinfo',
    clientId: () => process.env.MICROSOFT_CLIENT_ID,
    clientSecret: () => process.env.MICROSOFT_CLIENT_SECRET,
    extra: { prompt: 'select_account' },
  },
} as const;
type Provider = keyof typeof PROVIDERS;

export const oauthConfigured = (p: string) =>
  p in PROVIDERS && !!PROVIDERS[p as Provider].clientId() && !!PROVIDERS[p as Provider].clientSecret();

const COOKIE = 'ubos_oauth';
const web = () => (process.env.WEB_ORIGIN ?? 'http://localhost:3030').split(',')[0];
const callbackUrl = (p: Provider) => `${process.env.API_PUBLIC_URL ?? 'http://localhost:4000'}/oauth/${p}/callback`;

@Controller('oauth')
export class OAuthController {
  constructor(private db: DbService, private jwt: JwtService, private login: TenantLoginService) {}

  /** Browser navigates here from the login page: /oauth/google/start?tenant=mycompany */
  @Get(':provider/start')
  async start(@Param('provider') provider: string, @Query('tenant') slug: string, @Res() res: Response) {
    const fail = (code: string) => res.redirect(`${web()}/login?error=${code}${slug ? `&org=${encodeURIComponent(slug)}` : ''}`);
    if (!(provider in PROVIDERS)) return fail('UNKNOWN_PROVIDER');
    if (!oauthConfigured(provider)) return fail('PROVIDER_NOT_CONFIGURED');
    const tenant = slug ? await this.db.app.tenant.findUnique({ where: { slug: slug.toLowerCase() } }) : null;
    if (!tenant || tenant.status === 'suspended' || tenant.status === 'cancelled') return fail('TENANT_NOT_FOUND');
    const settings = await withTenant(this.db.app, tenant.id, (tx) => this.login.settings(tx, tenant.id));
    if (!settings.loginMethods.includes(provider)) return fail('LOGIN_METHOD_DISABLED');

    const p = PROVIDERS[provider as Provider];
    const state = randomToken(16);
    const verifier = randomToken(32);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const signed = await this.jwt.signAsync(
      { state, verifier, tenant: tenant.slug, provider, typ: 'oauth' },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: 600 },
    );
    res.cookie(COOKIE, signed, { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', path: '/oauth', maxAge: 600_000 });
    const url = new URL(p.authorize);
    url.search = new URLSearchParams({
      client_id: p.clientId()!, redirect_uri: callbackUrl(provider as Provider), response_type: 'code',
      scope: 'openid email profile', state, code_challenge: challenge, code_challenge_method: 'S256', ...p.extra,
    }).toString();
    return res.redirect(url.toString());
  }

  @Get(':provider/callback')
  async callback(@Param('provider') provider: string, @Query() q: Record<string, string>, @Req() req: Request, @Res() res: Response) {
    let slug = '';
    const fail = (code: string) => res.redirect(`${web()}/login?error=${code}${slug ? `&org=${encodeURIComponent(slug)}` : ''}`);
    try {
      const raw = req.cookies?.[COOKIE];
      res.clearCookie(COOKIE, { path: '/oauth' });
      if (!raw || !(provider in PROVIDERS)) return fail('OAUTH_STATE_INVALID');
      const st = await this.jwt.verifyAsync(raw, { secret: process.env.JWT_ACCESS_SECRET }).catch(() => null);
      if (!st || st.typ !== 'oauth' || st.provider !== provider || st.state !== q.state) return fail('OAUTH_STATE_INVALID');
      slug = st.tenant;
      if (q.error || !q.code) return fail('OAUTH_CANCELLED');

      const p = PROVIDERS[provider as Provider];
      const tokenRes = await fetch(p.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: p.clientId()!, client_secret: p.clientSecret()!, code: q.code, code_verifier: st.verifier,
          grant_type: 'authorization_code', redirect_uri: callbackUrl(provider as Provider),
        }),
      });
      if (!tokenRes.ok) return fail('OAUTH_EXCHANGE_FAILED');
      const { access_token } = (await tokenRes.json()) as { access_token?: string };
      const infoRes = await fetch(p.userinfo, { headers: { Authorization: `Bearer ${access_token}` } });
      if (!infoRes.ok) return fail('OAUTH_EXCHANGE_FAILED');
      const info = (await infoRes.json()) as { email?: string; email_verified?: boolean; preferred_username?: string };
      const email = (info.email ?? info.preferred_username ?? '').toLowerCase();
      // Google says explicitly whether the email is verified; Microsoft accounts are verified by the directory.
      if (!email || (provider === 'google' && info.email_verified !== true)) return fail('EMAIL_NOT_VERIFIED');

      const tenant = await this.db.app.tenant.findUnique({ where: { slug } });
      if (!tenant || tenant.status === 'suspended' || tenant.status === 'cancelled') return fail('TENANT_NOT_FOUND');
      ctx().tenant = { id: tenant.id, slug: tenant.slug, name: tenant.name, status: tenant.status };

      const result: LoginResult | null = await authTransaction(
        (fn) => withTenant(this.db.app, tenant.id, fn),
        async (tx) => {
          const settings = await this.login.settings(tx, tenant.id);
          this.login.assertMethodAllowed(settings, provider as 'google' | 'microsoft');
          this.login.assertDomainAllowed(settings, email);
          const user = await tx.user.findFirst({ where: { email } });
          if (!user) return null;
          this.login.assertNotLocked(user);
          return this.login.complete(tx, user, provider as 'google' | 'microsoft', req, res);
        },
      );
      if (!result) return fail('NO_ACCOUNT');
      if (result.mfaRequired) {
        // Token in the URL fragment: never sent to any server or written to access logs.
        return res.redirect(`${web()}/login/callback?org=${encodeURIComponent(slug)}#mfa=${result.mfaToken}`);
      }
      return res.redirect(`${web()}/login/callback?org=${encodeURIComponent(slug)}`);
    } catch (e) {
      const code = (e as { response?: { code?: string } })?.response?.code ?? 'OAUTH_FAILED';
      return fail(code);
    }
  }
}
