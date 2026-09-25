// Shared boundary lists (F-001 design §6.1). ESLint, dependency-cruiser, check-banned-deps,
// check-provider-hosts and check-workspaces all import from this one file, so the rules can't
// drift apart. F-001-T02 created the slots; F-001-T04 fills the package, loading and workspace
// lists, and T16 adds the provider hostnames.
//
// Every rule here is defence in depth. SR-03's authoritative control is network egress policy
// (F-004 and deploy/): static analysis catches mistakes early, but a determined author can get
// past it (SEC-F001-09).

/**
 * @typedef {{ name: string, message: string, importNames?: string[] }} RestrictedPath
 * @typedef {{ group?: string[], regex?: string, message: string }} RestrictedPattern
 * @typedef {{ selector: string, message: string }} RestrictedSyntax
 * @typedef {{ workspace: string, dependency: string, specifier: string, reason: string }} SpecifierException
 * @typedef {{
 *   id: string,
 *   packages: string[],
 *   importAllowedIn: string[],
 *   graphAllowedThrough: string[][],
 *   message: string,
 * }} BannedPackageGroup
 * @typedef {{ from: string[], to: string, message: string }} WorkspaceDependencyRule
 * @typedef {{ files: string[], reason: string }} LoadingException
 */

/** Imports banned everywhere by `no-restricted-imports`, beyond the package groups. @type {RestrictedPath[]} */
export const BANNED_IMPORT_PATHS = [];

/** Import patterns banned everywhere, beyond the package groups. @type {RestrictedPattern[]} */
export const BANNED_IMPORT_PATTERNS = [];

const LOADING_MESSAGE =
  'Non-literal module loading defeats the import boundary rules (SEC-F001-09 b). Use a static import or import() with a string literal; a reviewed exception goes in boundaries.js LOADING_EXCEPTIONS.';

/**
 * `no-restricted-syntax` selectors: the dynamic-loading ban (SEC-F001-09 b). Vite's
 * `import.meta.glob` with a literal pattern isn't an ImportExpression, so it stays allowed.
 * @type {RestrictedSyntax[]}
 */
export const RESTRICTED_SYNTAX = [
  { selector: "ImportExpression[source.type!='Literal']", message: LOADING_MESSAGE },
  {
    selector: "CallExpression[callee.name='require'][arguments.0.type!='Literal']",
    message: LOADING_MESSAGE,
  },
  {
    selector: "CallExpression[callee.name='require'][arguments.length=0]",
    message: LOADING_MESSAGE,
  },
  // The `require` handle on any object (code review findings 5 and round 2): `module.require`,
  // `mod['require']`, `module.require.bind(module)`, `Reflect.apply(module.require, …)`. Only a
  // direct call with a string literal, `module.require('./x.cjs')`, is allowed.
  {
    selector:
      "MemberExpression[property.name='require']:not(CallExpression[arguments.0.type='Literal'] > MemberExpression.callee)",
    message: LOADING_MESSAGE,
  },
  {
    selector:
      "MemberExpression[property.value='require']:not(CallExpression[arguments.0.type='Literal'] > MemberExpression.callee)",
    message: LOADING_MESSAGE,
  },
  // Destructuring the handle out: `const { require: rq } = module`, `{ 'require': rq }`.
  { selector: "ObjectPattern > Property[key.name='require']", message: LOADING_MESSAGE },
  { selector: "ObjectPattern > Property[key.value='require']", message: LOADING_MESSAGE },
  // `process.mainModule.require` and any alias of it: ban the handle itself.
  { selector: "MemberExpression[property.name='mainModule']", message: LOADING_MESSAGE },
  { selector: "MemberExpression[property.value='mainModule']", message: LOADING_MESSAGE },
  // Any mention: the import, `module.createRequire(...)` and a destructured alias all name it.
  { selector: "Identifier[name='createRequire']", message: LOADING_MESSAGE },
  { selector: "Identifier[name='getBuiltinModule']", message: LOADING_MESSAGE },
  {
    selector:
      'MemberExpression[computed=true][property.value=/^(createRequire|getBuiltinModule)$/]',
    message: LOADING_MESSAGE,
  },
  { selector: "Identifier[name='eval']", message: LOADING_MESSAGE },
  { selector: "NewExpression[callee.name='Function']", message: LOADING_MESSAGE },
  { selector: "CallExpression[callee.name='Function']", message: LOADING_MESSAGE },
];

/**
 * Reviewed per-path exceptions to the dynamic-loading ban: repo-relative globs and a reason.
 * Starts empty (design §6.1).
 * @type {LoadingException[]}
 */
export const LOADING_EXCEPTIONS = [];

/**
 * Rule IDs that make up the boundary layer. They live in the `base` preset, no preset may
 * relax them, and `eslint-comments/no-restricted-disable` forbids disabling them inline (RC-3).
 */
export const BOUNDARY_RULE_IDS = ['no-restricted-imports', 'no-restricted-syntax'];

const AGENT_HOST_ENGINE = 'services/agent-host/src/engine/claude/**';
const MODEL_GATEWAY = 'services/model-gateway/**';

/**
 * Banned packages, in groups. Package entries are names or globs (`@scope/*`, a trailing `*`).
 * A package belongs to the **first** group that matches it, so the order matters: the Agent SDK
 * groups come before the `@anthropic-ai/*` scope ban.
 *
 * - `importAllowedIn`: repo-relative globs of the files that may import the group's packages
 *   (ESLint and dependency-cruiser).
 * - `graphAllowedThrough`: for check-banned-deps, a dependency path from any workspace (or the
 *   root) to one of the packages is allowed only if it contains one of these node sequences in
 *   order (`@ralysa/*` names are workspaces, the others are packages). Empty = never allowed.
 *
 * Names are matched on the resolved package name, so an `npm:` alias can't hide one
 * (SEC-F001-09 a). Any further exception is a reviewed change to this file with a reason.
 * @type {BannedPackageGroup[]}
 */
export const BANNED_PACKAGE_GROUPS = [
  {
    id: 'agent-sdk',
    packages: ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk-*'],
    importAllowedIn: [AGENT_HOST_ENGINE],
    graphAllowedThrough: [['@ralysa/agent-host']],
    message:
      'The Claude Agent SDK is importable only from services/agent-host/src/engine/claude/** (ADR-0012 decision 2, ADR-0004 decision 6).',
  },
  {
    // The Agent SDK's declared peer (AR-6). Also an Anthropic package, so the gateway may use it.
    id: 'anthropic-sdk-peer',
    packages: ['@anthropic-ai/sdk'],
    importAllowedIn: [AGENT_HOST_ENGINE, MODEL_GATEWAY],
    graphAllowedThrough: [
      ['@ralysa/agent-host', '@anthropic-ai/claude-agent-sdk'],
      ['@ralysa/model-gateway'],
    ],
    message:
      '@anthropic-ai/sdk is allowed only as the Agent SDK peer inside services/agent-host/src/engine/claude/**, or in services/model-gateway (SR-03, AR-6).',
  },
  {
    id: 'model-provider',
    packages: [
      '@anthropic-ai/*',
      '@anthropic-ai/claude-code',
      'openai',
      '@azure/openai',
      '@azure-rest/ai-inference',
      '@google/genai',
      '@google/generative-ai',
      '@google-cloud/vertexai',
      '@google-cloud/aiplatform',
      '@aws-sdk/client-bedrock*',
      '@aws-sdk/client-sagemaker-runtime',
      '@mistralai/*',
      'cohere-ai',
      'groq-sdk',
      '@huggingface/*',
      'ollama',
      '@openrouter/*',
      // No @ai-sdk/react exemption: it depends on `ai`, which depends on @ai-sdk/gateway
      // (SEC-F001-08). A future UI-hook exemption needs an ADR judged on its full closure.
      'ai',
      '@ai-sdk/*',
      'langchain',
      '@langchain/*',
      'llamaindex',
      // In-process inference runtimes (AR-5): SR-03 covers OCR, embedding and classifiers too.
      '@xenova/transformers',
      'onnxruntime-*',
      'node-llama-cpp',
      '@tensorflow/tfjs*',
      'tesseract.js',
    ],
    importAllowedIn: [MODEL_GATEWAY],
    graphAllowedThrough: [['@ralysa/model-gateway']],
    message:
      'Model-provider SDKs and in-process inference runtimes are allowed only in services/model-gateway (SR-03). Call the Model Gateway instead.',
  },
  {
    id: 'telemetry-vendor',
    packages: [
      'dd-trace',
      '@datadog/*',
      'newrelic',
      '@sentry/*',
      'elastic-apm-node',
      'applicationinsights',
      '@dynatrace/*',
      'posthog-js',
      'posthog-node',
      '@amplitude/*',
      'mixpanel-browser',
      '@segment/*',
      '@vercel/analytics',
      '@vercel/speed-insights',
      'logrocket',
      '@fullstory/*',
    ],
    importAllowedIn: [],
    graphAllowedThrough: [],
    message:
      'Vendor APM, crash-reporting, analytics and session-replay SDKs are banned: OpenTelemetry is the only instrumentation API (ADR-0024, SR-21, REQ-101c). An exception needs an ADR.',
  },
  {
    // Not a security ban: the icon registry (F-001 design §3.4, AC-7) is the one place that
    // decides whether an icon mirrors in RTL, so the icon set is imported nowhere else. Apps get
    // icons through @ralysa/ui's <Icon name>, never a direct dependency.
    id: 'icon-set',
    packages: ['lucide-react'],
    importAllowedIn: ['packages/ui/src/icons/registry.ts'],
    graphAllowedThrough: [['@ralysa/ui']],
    message:
      'Import icons through the @ralysa/ui icon registry (<Icon name="…">), which decides whether an icon mirrors in RTL (F-001 design §3.4, AC-7). Only packages/ui/src/icons/registry.ts imports lucide-react.',
  },
];

/**
 * Workspace-level dependency bans for check-banned-deps (any depth, prod, dev and optional).
 * `from` holds workspace globs; the target workspace itself is never checked against its own rule.
 * @type {WorkspaceDependencyRule[]}
 */
export const WORKSPACE_DEPENDENCY_RULES = [
  {
    from: ['apps/web', 'packages/*'],
    to: '@ralysa/agent-host',
    message:
      'apps/web and packages/* must not depend on @ralysa/agent-host (AR-6); only apps/cli and apps/desktop may, to launch the local host.',
  },
  {
    from: ['**'],
    to: '@ralysa/ui-lab',
    message: 'Nothing may depend on the internal demo app @ralysa/ui-lab (AC-13).',
  },
];

/**
 * Development-only packages that must never reach a shipped workspace (F-002 design §2,
 * SEC-F002-13, [AR-12]): the Entra-shaped mock IdP and its engine. check-workspaces
 * (`deps/dev-only-in-shipped`) fails when one is a production dependency of a `shipped: true`
 * workspace, directly or through another workspace's production dependencies (F-002-T01).
 * F-002-T14 extends the check to the lockfile's production closure, dependency-cruiser and the
 * image scan. @type {string[]}
 */
export const DEV_ONLY_PACKAGES = ['@ralysa/dev-stack', 'oidc-provider'];

/**
 * Model-provider API hostnames (SEC-F001-09 d): a raw `fetch` needs no SDK, so check-provider-hosts
 * greps tracked source (outside services/model-gateway/**, docs/**, requirements/**, *.md and
 * this file) and every shipped artefact for them. `*.` at the start stands for one or more
 * labels; any other `*` for characters within one label. Matched case-insensitively.
 * List confirmed in F-001-T16 (2026-09-25) against the providers' API documentation.
 */
export const PROVIDER_HOSTS = [
  'api.anthropic.com',
  'api.openai.com',
  '*.openai.azure.com',
  '*.services.ai.azure.com',
  'generativelanguage.googleapis.com',
  '*aiplatform.googleapis.com',
  'bedrock-runtime.*.amazonaws.com',
  'api.mistral.ai',
  'api.groq.com',
  'api.cohere.com',
  'api.cohere.ai',
  'openrouter.ai',
  'api-inference.huggingface.co',
  'router.huggingface.co',
  'ai-gateway.vercel.sh',
  'api.together.xyz',
];

/** Where a provider hostname may appear (repo-relative globs). */
export const PROVIDER_HOSTS_ALLOWED_IN = [
  'services/model-gateway/**',
  'docs/**',
  'requirements/**',
  '*.md',
  '**/*.md',
  'tooling/eslint-config/boundaries.js',
];

/**
 * One regex source matching any PROVIDER_HOSTS entry as a whole hostname: not preceded by a
 * hostname character other than `.` (so `eu.api.openai.com` matches, `myapi.openai.com` doesn't),
 * and not followed by a hostname character.
 * @returns {string}
 */
export function providerHostSource() {
  const hosts = PROVIDER_HOSTS.map((host) => {
    const leading = host.startsWith('*.');
    const body = (leading ? host.slice(2) : host)
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[a-z0-9-]*');
    return leading ? `(?:[a-z0-9-]+\\.)+${body}` : body;
  });
  return `(?<![a-z0-9-])(?:${hosts.join('|')})(?![a-z0-9-])`;
}

/**
 * Reviewed exceptions to the dependency-specifier rule in check-workspaces (`npm:`, `file:`,
 * `link:`, `portal:`, git and tarball specifiers). A specifier that resolves under `packs/` can
 * never be excepted (SEC-F001-09 a, SEC-F001-26). Starts empty.
 * @type {SpecifierException[]}
 */
export const SPECIFIER_ALLOWLIST = [];

// ---------------------------------------------------------------------------------------------
// Matching helpers shared by the ESLint presets, .dependency-cruiser.cjs and check-banned-deps.

/**
 * A glob as a regex source: `**` matches across `/`, `*` within one segment, the rest literally.
 * @param {string} glob
 * @returns {string}
 */
export function globSource(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob.charAt(i);
    if (char === '*' && glob.charAt(i + 1) === '*') {
      out += '.*';
      i += 1;
    } else if (char === '*') {
      out += '[^/]*';
    } else {
      out += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}

/**
 * Regex source for "a package name in `group`, and in no earlier group".
 * @param {BannedPackageGroup} group
 * @returns {string}
 */
export function groupNameSource(group) {
  const index = BANNED_PACKAGE_GROUPS.indexOf(group);
  const earlier = BANNED_PACKAGE_GROUPS.slice(0, index).flatMap((g) => g.packages);
  const own = `(?:${group.packages.map(globSource).join('|')})`;
  if (earlier.length === 0) return own;
  return `(?!(?:${earlier.map(globSource).join('|')})(?:/|$))${own}`;
}

/**
 * The group a package name belongs to, if any.
 * @param {string} name a bare package name (no subpath)
 * @returns {BannedPackageGroup | undefined}
 */
export function bannedGroupOf(name) {
  return BANNED_PACKAGE_GROUPS.find((group) =>
    group.packages.some((glob) => new RegExp(`^${globSource(glob)}$`).test(name)),
  );
}

/**
 * `no-restricted-imports` patterns for every group not in `allow`: the package itself and any
 * subpath (`openai`, `openai/resources`).
 * @param {string[]} [allow] group ids allowed for the files this config applies to
 * @returns {RestrictedPattern[]}
 */
export function bannedImportPatterns(allow = []) {
  return BANNED_PACKAGE_GROUPS.filter((group) => !allow.includes(group.id)).map((group) => ({
    regex: `^${groupNameSource(group)}(?:/.*)?$`,
    message: group.message,
  }));
}
