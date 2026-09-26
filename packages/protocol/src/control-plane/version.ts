// The control-plane REST contract's version (F-002 design §3.10): path prefix `/v1`, and the
// OpenAPI document's `info.version`. Minor versions only add optional fields and routes; a
// breaking change needs `/v2` and an overlap window.
export const CONTROL_PLANE_API_PREFIX = '/v1' as const;
export const CONTROL_PLANE_API_VERSION = '1.1.0' as const;
