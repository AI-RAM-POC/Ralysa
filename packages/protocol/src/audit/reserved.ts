// Reserved `details` keys (F-002 design §3.4.5, SEC-F002-15). Server-owned facts live under
// `details.server.*` and client data under `details.client.*`; a client payload that contains
// any of these keys, at any depth, is refused with 422 so it can't impersonate a server fact.

export const RESERVED_DETAIL_KEYS = [
  'server',
  'seq_gap',
  'late',
  'reported_by',
  'suppressed_count',
  'spooled',
  'original_ts',
] as const;
export type ReservedDetailKey = (typeof RESERVED_DETAIL_KEYS)[number];

/** Every reserved key found in `value`, as a dotted path (for example `a.b.server`). */
export function findReservedKeys(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findReservedKeys(item, `${path}[${String(index)}]`));
  }
  if (typeof value !== 'object' || value === null) return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const here = path === '' ? key : `${path}.${key}`;
    if ((RESERVED_DETAIL_KEYS as readonly string[]).includes(key)) found.push(here);
    found.push(...findReservedKeys(child, here));
  }
  return found;
}
