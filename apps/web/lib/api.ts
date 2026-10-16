'use client';

// Prototype session handling: tokens live in localStorage. Phase 1 moves them to httpOnly cookies.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface TenantSession {
  tenant: string;
  token: string;
  workspaceId: string | null;
}

const KEY = 'ubos.session';
const PKEY = 'ubos.platform';

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
  set: (s: TenantSession | null) => write(KEY, s),
  setWorkspace: (workspaceId: string | null) => {
    const s = read<TenantSession>(KEY);
    if (s) write(KEY, { ...s, workspaceId });
  },
};
export const platformSession = {
  get: () => read<{ token: string; name: string }>(PKEY),
  set: (s: { token: string; name: string } | null) => write(PKEY, s),
};

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit & { headers?: Record<string, string> }): Promise<T> {
  const res = await fetch(API_URL + path, init);
  if (res.headers.get('content-type')?.includes('text/csv')) return (await res.blob()) as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.code ?? 'ERROR', body.message ?? 'Request failed');
  return body as T;
}

/** Tenant API call: adds organization, token and selected workspace headers. */
export function api<T = any>(path: string, opts: { method?: string; body?: unknown; tenant?: string; noWorkspace?: boolean } = {}) {
  const s = session.get();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const tenant = opts.tenant ?? s?.tenant;
  if (tenant) headers['X-Tenant'] = tenant;
  if (s?.token && !opts.tenant) headers.Authorization = `Bearer ${s.token}`;
  if (s?.workspaceId && !opts.noWorkspace) headers['X-Workspace'] = s.workspaceId;
  return request<T>(path, { method: opts.method ?? 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
}

/** Platform Console API call. */
export function platformApi<T = any>(path: string, opts: { method?: string; body?: unknown } = {}) {
  const s = platformSession.get();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (s?.token) headers.Authorization = `Bearer ${s.token}`;
  return request<T>(path, { method: opts.method ?? 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
}

export const rupees = (paise: number) =>
  '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });
