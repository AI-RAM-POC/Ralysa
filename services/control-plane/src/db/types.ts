// Kysely types for the cp and audit schemas (F-002 design §4.4), matching the migrations in
// migrations/{cp,audit}. `Generated` marks columns the database fills (defaults, identity,
// generated), so inserts may omit them. pg returns bigint and numeric as strings and bytea as
// Buffer (a Uint8Array).
import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type BigIntString = ColumnType<string, string | number | bigint, string | number | bigint>;
type Bytes = Uint8Array;
type Json = ColumnType<unknown, string, string>;
/** Readable, never writable (GENERATED ALWAYS). */
type ReadOnly<T> = ColumnType<T, never, never>;

export interface OrganizationTable {
  id: string;
  org_id: ReadOnly<string>;
  name: string;
  residency: 'in_country' | 'in_region';
  region: string;
  deployment_model: 'dedicated' | 'on_prem' | 'air_gapped';
  settings: ColumnType<Record<string, unknown>, string | undefined, string>;
  created_at: GeneratedTimestamp;
}

export interface AppUserTable {
  id: string;
  org_id: string;
  idp_issuer: string;
  idp_tenant_id: string;
  idp_subject: string;
  email: string | null;
  display_name: string | null;
  locale: Generated<string>;
  department_id: string | null;
  status: Generated<'active' | 'disabled'>;
  revoked_before: Timestamp | null;
  last_sign_in_at: Timestamp | null;
  /** When the Graph call behind the last membership write-back started (cp/0007, R58-4). */
  graph_checked_at: Generated<Date | null>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface IdpGroupTable {
  id: string;
  org_id: string;
  idp_group_id: string;
  display_name: string | null;
  role: 'access' | 'platform_admin' | null;
  name_refreshed_at: Timestamp | null;
}

export interface GroupMembershipTable {
  org_id: string;
  user_id: string;
  group_id: string;
  source: 'token_claim' | 'graph_check';
  observed_at: GeneratedTimestamp;
}

export interface AuthSessionTable {
  id: string;
  org_id: string;
  user_id: string;
  client_id: string;
  surface: string;
  flow: 'idp_device' | 'loopback_pkce';
  status: 'pending' | 'active' | 'revoked';
  roles: Generated<('user' | 'platform_admin')[]>;
  device_label: string | null;
  created_ip: string | null;
  created_at: GeneratedTimestamp;
  last_refresh_at: Timestamp | null;
  absolute_expires_at: Timestamp;
  revoked_at: Timestamp | null;
  revoked_reason: string | null;
}

export interface RefreshTokenTable {
  id: string;
  org_id: string;
  session_id: string;
  parent_id: string | null;
  token_hash: Bytes;
  status: 'active' | 'rotated' | 'revoked';
  issued_at: GeneratedTimestamp;
  expires_at: Timestamp;
  used_at: Timestamp | null;
}

export interface AuthorizationCodeTable {
  code_hash: Bytes;
  org_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  session_id: string;
  callback_ip: string | null;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  /** Facts from the IdP callback for the sign-in event at redemption (cp/0006). */
  sign_in: ColumnType<Record<string, unknown>, string | undefined, string>;
}

export interface IdpAuthRequestTable {
  state_hash: Bytes;
  org_id: string;
  browser_binding_hash: Bytes;
  client_redirect_uri: string;
  client_state: string;
  client_code_challenge: string;
  authorize_ip: string | null;
  idp_code_verifier: string;
  idp_nonce: string;
  expires_at: Timestamp;
}

export interface ReplayTable {
  org_id: string;
  expires_at: Timestamp;
}
export interface IdpTokenReplayTable extends ReplayTable {
  token_id_hash: Bytes;
}
export interface ClientAssertionReplayTable extends ReplayTable {
  jti_hash: Bytes;
}

export interface SigningKeyVersionTable {
  kid: string;
  org_id: string;
  version: number;
  public_jwk: Json;
  published_at: GeneratedTimestamp;
  activated_at: Timestamp | null;
  superseded_at: Timestamp | null;
  retired_at: Timestamp | null;
}

export interface UsageRecordTable {
  id: string;
  org_id: string;
  ts: Timestamp;
  user_id: string | null;
  dept_id: string | null;
  session_id: string | null;
  trace_id: string | null;
  kind: 'model' | 'tool' | 'sandbox_seconds';
  model: string | null;
  endpoint_id: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read: number | null;
  cache_write: number | null;
  cache_hits: number | null;
  cost: string | null;
  credits: string | null;
  endpoint_region: string | null;
  inference_region: string | null;
  inference_region_source: 'registry_declared' | 'provider_reported' | null;
  byom: boolean | null;
  pool_id: string | null;
  price_book_version: string | null;
  connector_id: string | null;
}

export interface CredentialTable {
  id: string;
  org_id: string;
  kind:
    | 'idp_client_secret'
    | 'signing_key'
    | 'checkpoint_key'
    | 'service_key'
    | 'db_role'
    | 'audit_hmac';
  vault_path: string;
  owner_scope: string;
  current_version: number | null;
  rotated_at: Timestamp | null;
}

export interface KillSwitchTable {
  id: string;
  org_id: string;
  scope: 'tenant' | 'department' | 'pack' | 'agent';
  scope_id: string | null;
  active: Generated<boolean>;
  reason: string | null;
  activated_by: string | null;
  activated_at: GeneratedTimestamp;
}

export interface ClientAuditCursorTable {
  org_id: string;
  user_id: string;
  sid: string;
  session_id: string;
  last_seq: ColumnType<string, string | number | undefined, string | number>;
  /** int8multirange text form, e.g. `{[3,5)}`. */
  open_gaps: ColumnType<string, string | undefined, string>;
  final_seq: BigIntString | null;
  ended_at: Timestamp | null;
  updated_at: GeneratedTimestamp;
}

/** The envelope as columns (§3.5). `ts`, `ingest_seq`, `schema_version` are the server's. */
export interface AuditEventTable {
  event_id: string;
  org_id: string;
  schema_version: ColumnType<number, never, never>;
  ts: ColumnType<Date, never, never>;
  ingest_seq: ColumnType<string, never, never>;
  action: string;
  actor_type: 'user' | 'service' | 'system';
  actor_user_id: string | null;
  actor_idp_subject: string | null;
  actor_service: string | null;
  act_sub: string | null;
  surface: string | null;
  resource_type: string | null;
  resource_id: string | null;
  operation: string | null;
  outcome: string;
  reason_code: string | null;
  session_id: string | null;
  turn_id: string | null;
  request_id: string | null;
  tool_call_id: string | null;
  trace_id: string;
  span_id: string | null;
  policy_version: string | null;
  entitlement_version: number | null;
  tier: string | null;
  classification: string | null;
  endpoint_id: string | null;
  endpoint_region: string | null;
  inference_region: string | null;
  inference_region_source: string | null;
  locality: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  payload_hash: string | null;
  source: string;
  attestation: 'server' | 'client';
  client_seq: BigIntString | null;
  details: Json;
}

export interface AuditSealTable {
  org_id: string;
  shard: string;
  seq: BigIntString;
  event_id: string;
  event_hash: Bytes;
  prev_hash: Bytes;
  hash: Bytes;
  sealed_at: GeneratedTimestamp;
}

export interface AuditCheckpointTable {
  org_id: string;
  shard: string;
  seq: BigIntString;
  hash: Bytes;
  checkpoint_ts: Timestamp;
  key_version: number;
  signature: Bytes;
}

export interface Database {
  'cp.organization': OrganizationTable;
  'cp.app_user': AppUserTable;
  'cp.idp_group': IdpGroupTable;
  'cp.group_membership': GroupMembershipTable;
  'cp.auth_session': AuthSessionTable;
  'cp.refresh_token': RefreshTokenTable;
  'cp.authorization_code': AuthorizationCodeTable;
  'cp.idp_auth_request': IdpAuthRequestTable;
  'cp.idp_token_replay': IdpTokenReplayTable;
  'cp.client_assertion_replay': ClientAssertionReplayTable;
  'cp.signing_key_version': SigningKeyVersionTable;
  'cp.usage_record': UsageRecordTable;
  'cp.credential': CredentialTable;
  'cp.kill_switch': KillSwitchTable;
  'cp.client_audit_cursor': ClientAuditCursorTable;
  'audit.audit_event': AuditEventTable;
  'audit.audit_seal': AuditSealTable;
  'audit.audit_checkpoint': AuditCheckpointTable;
}
