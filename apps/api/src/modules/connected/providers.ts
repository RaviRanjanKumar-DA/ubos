/** Addresses of the outside services. CONNECT_STANDIN_URL points them at a local stand-in for tests, and is ignored in production. */
const standin = () => (process.env.NODE_ENV === 'production' ? undefined : process.env.CONNECT_STANDIN_URL?.replace(/\/$/, ''));

export const apiBase = () => (process.env.API_PUBLIC_URL ?? 'http://localhost:4000').replace(/\/$/, '');
export const webBase = () => (process.env.WEB_ORIGIN ?? 'http://localhost:3030').split(',')[0].replace(/\/$/, '');
export const connectCallback = (provider: string) => `${apiBase()}/connect/${provider}/callback`;

export const META = {
  configured: () => !!process.env.META_APP_ID && !!process.env.META_APP_SECRET,
  graph: () => (standin() ? `${standin()}/graph` : 'https://graph.facebook.com/v21.0'),
  dialog: () => (standin() ? `${standin()}/dialog` : 'https://www.facebook.com/v21.0/dialog/oauth'),
  scope: 'pages_show_list,pages_read_engagement,pages_manage_metadata,pages_manage_ads,leads_retrieval',
};

export type MailProvider = 'google' | 'microsoft';
export const MAIL: Record<MailProvider, {
  authorize: () => string; token: () => string; userinfo: () => string; api: () => string; clientId: () => string | undefined; clientSecret: () => string | undefined; scope: string; extra: Record<string, string>;
}> = {
  google: {
    authorize: () => (standin() ? `${standin()}/google/authorize` : 'https://accounts.google.com/o/oauth2/v2/auth'),
    token: () => (standin() ? `${standin()}/google/token` : 'https://oauth2.googleapis.com/token'),
    userinfo: () => (standin() ? `${standin()}/google/userinfo` : 'https://openidconnect.googleapis.com/v1/userinfo'),
    api: () => (standin() ? `${standin()}/google` : 'https://gmail.googleapis.com'),
    clientId: () => process.env.GOOGLE_CLIENT_ID, clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
    scope: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
    extra: { access_type: 'offline', prompt: 'consent' },
  },
  microsoft: {
    authorize: () => (standin() ? `${standin()}/microsoft/authorize` : 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'),
    token: () => (standin() ? `${standin()}/microsoft/token` : 'https://login.microsoftonline.com/common/oauth2/v2.0/token'),
    userinfo: () => (standin() ? `${standin()}/microsoft/userinfo` : 'https://graph.microsoft.com/oidc/userinfo'),
    api: () => (standin() ? `${standin()}/microsoft` : 'https://graph.microsoft.com/v1.0'),
    clientId: () => process.env.MICROSOFT_CLIENT_ID, clientSecret: () => process.env.MICROSOFT_CLIENT_SECRET,
    scope: 'openid email offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send',
    extra: { prompt: 'select_account' },
  },
};
export const isMailProvider = (p: string): p is MailProvider => p === 'google' || p === 'microsoft';
export const mailConfigured = (p: MailProvider) => !!MAIL[p].clientId() && !!MAIL[p].clientSecret();
