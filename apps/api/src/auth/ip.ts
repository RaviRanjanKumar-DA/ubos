/** Normalises Express IPs (::ffff:1.2.3.4 → 1.2.3.4, ::1 stays). */
export function normalizeIp(ip: string | null | undefined): string {
  if (!ip) return '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!/^\d+$/.test(p) || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** True when `ip` matches any entry: exact address (IPv4/IPv6) or IPv4 CIDR like 203.0.113.0/24. Empty list = allow all. */
export function ipAllowed(ip: string, allowlist: string[]): boolean {
  if (!allowlist.length) return true;
  const addr = normalizeIp(ip);
  const n = ipv4ToInt(addr);
  return allowlist.some((entry) => {
    const e = entry.trim();
    if (!e) return false;
    if (!e.includes('/')) return normalizeIp(e) === addr;
    const [base, bitsStr] = e.split('/');
    const b = ipv4ToInt(base);
    const bits = Number(bitsStr);
    if (n === null || b === null || !(bits >= 0 && bits <= 32)) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((b & mask) >>> 0);
  });
}
