// TC-F-001-39 (AC-2; SEC-F001-24): each custom gitleaks rule fires on runtime-assembled positive
// fixtures, in both configs, and not on look-alike negatives. Values are random, so no fixture
// is a real credential, and none exists as a literal in the repo.
import { describe, expect, it } from 'vitest';
import { runGitleaks } from '../src/secret-scan.ts';
import {
  RULE_ENTROPY,
  canary,
  detectable,
  frag,
  ralysaAuthCode,
  ralysaRefreshToken,
  randomFrom,
} from '../src/secret-scan-selftest.ts';
import { ARTEFACT_CONFIG_PATH, REPO_CONFIG_PATH, gitleaks, writeFile } from './gitleaks-bin.ts';
import { makeTempDir } from './temp.ts';

const HEX = '0123456789abcdef';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CUSTOM = [
  'azure-openai-key',
  'litellm-key',
  'mistral-api-key',
  'groq-api-key',
  'ralysa-refresh-token',
  'ralysa-auth-code',
  'ralysa-selftest-canary',
];

/** Scans `lines` (one file, one line each) and returns the rule ids reported per line. */
function scan(lines: string[], config = REPO_CONFIG_PATH): Map<number, string[]> {
  const dir = makeTempDir('ralysa-rules-');
  writeFile(dir, 'fixture.txt', `${lines.join('\n')}\n`);
  const result = runGitleaks({
    binary: gitleaks(),
    label: 'rules',
    mode: 'dir',
    target: dir,
    config,
    reportDir: makeTempDir('ralysa-reports-'),
  });
  const byLine = new Map<number, string[]>();
  for (const finding of result.findings) {
    byLine.set(finding.line, [...(byLine.get(finding.line) ?? []), finding.rule]);
  }
  return byLine;
}

// Positives must clear each rule's entropy floor, or gitleaks rightly skips them (PR #20 flake).
const sk = (): string => detectable(frag('sk', '-'), `${ALNUM}_-`, 24, RULE_ENTROPY['litellm-key']);
const hex = (): string => detectable('', HEX, 32, RULE_ENTROPY['azure-openai-key']);
const mistral = (): string => detectable('', ALNUM, 32, RULE_ENTROPY['mistral-api-key']);

const POSITIVES: [string, string][] = [
  ['azure-openai-key', `AZURE_OPENAI_API_KEY=${hex()}`],
  ['azure-openai-key', `  "api-key": "${hex()}",`],
  [
    'azure-openai-key',
    // The hostname is split: check-provider-hosts bans it in source outside the gateway.
    `const endpoint = "https://ralysa.${frag('openai', '.azure', '.com')}"; const k = "${hex()}";`,
  ],
  ['azure-openai-key', `cognitiveservices_key: ${hex()}`],
  ['litellm-key', `LITELLM_MASTER_KEY="${sk()}"`],
  ['litellm-key', `general_settings: { master_key: ${sk()} }`],
  ['litellm-key', `virtual_key = '${sk()}'`],
  ['mistral-api-key', `MISTRAL_API_KEY=${mistral()}`],
  ['mistral-api-key', `new Mistral({ apiKey: "${mistral()}" })`],
  [
    'groq-api-key',
    `const key = "${detectable(frag('gs', 'k_'), ALNUM, 52, RULE_ENTROPY['groq-api-key'])}";`,
  ],
  // F-002-T14: Ralysa's own tokens, in the places a leak would put them (F-002 design §6.6).
  ['ralysa-refresh-token', `{"refresh_token":"${ralysaRefreshToken()}","token_type":"Bearer"}`],
  ['ralysa-refresh-token', `refresh_token=${ralysaRefreshToken()}&client_id=ralysa-cli`],
  ['ralysa-auth-code', `http://127.0.0.1:49152/callback?code=${ralysaAuthCode()}&state=x`],
  ['ralysa-auth-code', `  code: '${ralysaAuthCode()}',`],
  ['ralysa-selftest-canary', canary()],
];

describe('custom gitleaks rules (TC-F-001-39)', () => {
  it.each([
    ['.gitleaks.toml', REPO_CONFIG_PATH],
    ['.gitleaks.artefacts.toml', ARTEFACT_CONFIG_PATH],
  ])('every positive fixture fires its rule with %s', (_, config) => {
    const found = scan(
      POSITIVES.map(([, line]) => line),
      config,
    );
    for (const [index, [rule, line]] of POSITIVES.entries()) {
      expect(found.get(index + 1) ?? [], `${rule}: ${line.slice(0, 30)}…`).toContain(rule);
    }
  });

  it('no custom rule fires on look-alike negatives', () => {
    const negatives = [
      // A bare 32-hex hash with no provider context.
      `checksum = "${hex()}"`,
      `etag: ${hex()}`,
      // A UUID next to an Azure keyword (dashes break the 32-hex run).
      `AZURE_OPENAI_DEPLOYMENT_ID = "${crypto.randomUUID()}"`,
      // An Azure keyword too far from the hex value.
      `azure ${'x'.repeat(60)} ${hex()}`,
      // sk- without LiteLLM context.
      `token = "${sk()}"`,
      // LiteLLM context but no sk- key.
      `LITELLM_MASTER_KEY = os.environ["LITELLM_MASTER_KEY"]`,
      // Mistral context with a low-entropy placeholder, and with a 31-character value.
      `MISTRAL_API_KEY=${'a'.repeat(32)}`,
      `MISTRAL_API_KEY=${randomFrom(ALNUM, 31)}`,
      // Groq prefix with the wrong length.
      `${frag('gs', 'k_')}${randomFrom(ALNUM, 40)}`,
      // A lowercase or short canary.
      `${frag('ralysa_selftest', '_canary_')}${randomFrom('abcdefghijklmnopqrstuvwxyz0123456789', 24)}`,
      `${frag('RALYSA_SELFTEST', '_CANARY_')}${randomFrom('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 10)}`,
      // A Ralysa token prefix with a short value, or a low-entropy placeholder of the right length.
      `refresh_token = "${frag('rly', '_rt_')}${randomFrom(ALNUM, 42)}"`,
      `code = "${frag('rly', '_ac_')}${randomFrom(ALNUM, 20)}"`,
      `refresh_token = "${frag('rly', '_rt_')}${'A'.repeat(43)}"`,
      // The bare prefixes, as the code and docs mention them.
      `export const REFRESH_TOKEN_PREFIX = '${frag('rly', '_rt_')}';`,
      `the ${frag('rly', '_ac_')} code is single use`,
    ];
    const found = scan(negatives);
    for (const [index, line] of negatives.entries()) {
      const custom = (found.get(index + 1) ?? []).filter((rule) => CUSTOM.includes(rule));
      expect(custom, line.slice(0, 40)).toEqual([]);
    }
  });
});
