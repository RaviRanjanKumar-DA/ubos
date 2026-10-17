'use client';

// Sessions live in httpOnly cookies set by the API (the browser never sees the tokens).
// localStorage only remembers which organization and workspace the user picked.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface TenantSession {
  tenant: string;
  workspaceId: string | null;
}

const KEY = 'ubos.session';
const LAST_ORG = 'ubos.lastOrg';

function read<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, v: unknown) {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

export const session = {
  get: () => read<TenantSession>(KEY),
  set: (s: TenantSession | null) => {
    write(KEY, s);
    if (s) write(LAST_ORG, s.tenant);
  },
  setWorkspace: (workspaceId: string | null) => {
    const s = read<TenantSession>(KEY);
    if (s) write(KEY, { ...s, workspaceId });
  },
  lastOrg: () => read<string>(LAST_ORG) ?? '',
};

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** workspace: send this workspace instead of the one selected in the switcher (e.g. opening a lead of another business line). */
type Opts = { method?: string; body?: unknown; tenant?: string; noWorkspace?: boolean; workspace?: string | null; onHeaders?: (h: Headers) => void };

async function raw(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, credentials: 'include' });
  if (res.headers.get('content-type')?.includes('text/csv')) return { res, body: await res.blob() };
  return { res, body: await res.json().catch(() => ({})) };
}

let refreshing: Promise<boolean> | null = null;

/** One refresh at a time; concurrent requests wait for it. */
function refreshOnce(path: string, headers: Record<string, string>) {
  refreshing ??= raw(API_URL + path, { method: 'POST', headers })
    .then(({ res }) => res.ok)
    .finally(() => setTimeout(() => (refreshing = null), 0));
  return refreshing;
}

async function request<T>(path: string, init: { method: string; headers: Record<string, string>; body?: string }, refreshPath: string, onHeaders?: (h: Headers) => void): Promise<T> {
  let { res, body } = await raw(API_URL + path, init);
  // Access tokens live 15 minutes; refresh silently and retry once.
  if (res.status === 401 && (body as { code?: string }).code === 'TOKEN_EXPIRED') {
    if (await refreshOnce(refreshPath, init.headers)) ({ res, body } = await raw(API_URL + path, init));
  }
  onHeaders?.(res.headers);
  if (!res.ok) {
    const b = body as { code?: string; message?: string };
    throw new ApiError(res.status, b.code ?? 'ERROR', b.message ?? 'Request failed');
  }
  return body as T;
}

/** Tenant API call: sends organization + selected workspace; session cookie goes automatically. */
export function api<T = any>(path: string, opts: Opts = {}) {
  const s = session.get();
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-UBOS-CSRF': '1' };
  const tenant = opts.tenant ?? s?.tenant;
  if (tenant) headers['X-Tenant'] = tenant;
  const wsId = opts.workspace !== undefined ? opts.workspace : s?.workspaceId;
  if (wsId && !opts.noWorkspace && !opts.tenant) headers['X-Workspace'] = wsId;
  return request<T>(path, { method: opts.method ?? 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined }, '/api/v1/auth/refresh', opts.onHeaders);
}

/** Platform Console API call. */
export function platformApi<T = any>(path: string, opts: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-UBOS-CSRF': '1' };
  return request<T>(path, { method: opts.method ?? 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined }, '/platform/v1/auth/refresh');
}

export const rupees = (paise: number) =>
  '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });

/** Friendly text for error codes the API sends back to the login page via redirects. */
export const LOGIN_ERRORS: Record<string, string> = {
  PROVIDER_NOT_CONFIGURED: 'This sign-in option is not set up yet. Ask your administrator.',
  LOGIN_METHOD_DISABLED: 'This sign-in method is turned off for your organization.',
  NO_ACCOUNT: 'No UBOS user with that email exists in this organization. Ask your admin to add you.',
  EMAIL_NOT_VERIFIED: 'Your Google email address is not verified.',
  EMAIL_DOMAIN_NOT_ALLOWED: 'Your email domain is not allowed for this organization.',
  TENANT_NOT_FOUND: 'Organization not found or not active.',
  OAUTH_CANCELLED: 'Sign-in was cancelled.',
  OAUTH_STATE_INVALID: 'The sign-in link expired. Please try again.',
  OAUTH_EXCHANGE_FAILED: 'Could not complete sign-in with the provider. Please try again.',
  ACCOUNT_LOCKED: 'Too many failed attempts. Please try again later.',
  IP_NOT_ALLOWED: 'Sign-in is not allowed from this network.',
  USER_INACTIVE: 'Your account is inactive.',
};
