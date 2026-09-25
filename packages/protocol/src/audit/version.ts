// The audit contract's own version (F-002 design §3.10, [AR-18]). It is part of every event's
// canonical form, so it can never change for stored events; a new envelope field is added as a
// nullable column and omitted from the canonical form while null (§4.6), not by bumping this.
export const AUDIT_SCHEMA_VERSION = 1 as const;
