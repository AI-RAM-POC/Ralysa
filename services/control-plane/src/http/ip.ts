// Client IP comparison (F-002 design §3.2.5 `ipaddr`, §3.3 loopback binding). Node reports an
// IPv4 client on a dual-stack socket as `::ffff:a.b.c.d`; both forms of one address compare
// equal, and IPv6 compares case-insensitively. A genuine IPv4 client and an IPv6 client of the
// same host are still different addresses (see the UAT note on dual-stack hosts).
export function normalizeIp(ip: string): string {
  const lower = ip.toLowerCase();
  return lower.startsWith('::ffff:') && lower.includes('.') ? lower.slice(7) : lower;
}

export const sameIp = (a: string, b: string): boolean => normalizeIp(a) === normalizeIp(b);
