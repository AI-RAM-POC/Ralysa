// TC-F-002-06 and the OpenAPI half of TC-F-002-05 (AC-3; F-002-T14): check-no-password passes the
// real repository (the committed control-plane OpenAPI document and packages/auth), and fails on
// fixtures with a password field, a password prompt, a PIN or OTP field, the password grant or a
// client secret, in client code or in an OpenAPI document.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_OPENAPI,
  checkClientSource,
  checkNoPassword,
  checkOpenApiDocument,
} from '../src/check-no-password.ts';
import { REAL_ROOT } from './repo-copy.ts';
import { makeTempDir } from './temp.ts';

const CLEAN_OPENAPI = {
  openapi: '3.1.0',
  info: { title: 'x', version: '1.0.0', description: 'No route takes a password.' },
  paths: {
    '/oauth2/token': {
      post: {
        summary: 'Token endpoint; the password grant is refused',
        requestBody: {
          content: {
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                properties: {
                  grant_type: { enum: ['authorization_code', 'refresh_token'] },
                  code_verifier: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  },
};

function fixture(files: Record<string, string>): string {
  const root = makeTempDir('ralysa-nopw-');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const withOpenApi = (files: Record<string, string>, doc: unknown = CLEAN_OPENAPI) => ({
  [REQUIRED_OPENAPI[0] as string]: JSON.stringify(doc),
  ...files,
});

const run = (files: Record<string, string>): string[] =>
  checkNoPassword(fixture(files), Object.keys(files)).map((f) => `${f.rule} ${f.path}`);

describe('check-no-password (TC-F-002-06)', () => {
  it('passes the real repository: the committed OpenAPI document and packages/auth', () => {
    expect(checkNoPassword(REAL_ROOT)).toEqual([]);
  });

  it('passes clean client code, comments that say no password exists, and tests', () => {
    expect(
      run(
        withOpenApi({
          'packages/auth/src/flow.ts':
            "// No password grant: the CLI signs in through the IdP (AC-3).\nexport const grant = 'refresh_token';\n",
          'apps/cli/src/login.tsx':
            '/**\n * Never prompts for a password.\n */\nexport const Login = () => <Text>Open the link</Text>;\n',
          'packages/auth/test/token.test.ts':
            "expect(await form({ grant_type: 'password', client_secret: 'x' })).toBe(400);\n",
          'services/control-plane/src/token.ts': "if (grant === 'password') refuse();\n",
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    ['a password input (TSX)', 'apps/desktop/src/Login.tsx', '<input type="password" />'],
    ['a password input (JSX expression)', 'apps/web/src/Login.tsx', "<Input type={'password'} />"],
    [
      'an Ink/inquirer password prompt',
      'apps/cli/src/login.ts',
      "prompt({ type: 'password', name: 'secret' });",
    ],
    ['a readline password prompt', 'apps/cli/src/login.ts', "rl.question('Password: ', done);"],
    ['a PIN field', 'apps/web/src/Pin.tsx', 'const [pin, setPin] = useState("");'],
    ['an OTP field', 'apps/web/src/Otp.tsx', 'export function askOtp(otp: string) {}'],
    ['a one-time code prompt', 'apps/cli/src/mfa.ts', 'print("Enter your one-time code");'],
    ['the password grant', 'packages/auth/src/token.ts', "body.set('grant_type', 'password');"],
    ['a client secret', 'packages/auth/src/token.ts', 'body.set("client_secret", secret);'],
    [
      'a password string in a catalog',
      'apps/web/src/i18n/en.json',
      '{ "login.password": "Password" }',
    ],
    // Review of #34 (R34-3): the forms the first version missed.
    ['a passcode field', 'apps/web/src/Code.tsx', 'const [passcode, setPasscode] = useState("");'],
    ['a camelCase passCode', 'apps/cli/src/login.ts', 'export const passCode = await ask();'],
    ['a bare pwd', 'apps/cli/src/login.ts', 'const pwd = readline();'],
    ['a camelCase userPin', 'apps/web/src/Pin.tsx', 'export function Pin({ userPin }: Props) {}'],
    ['a camelCase otpCode', 'packages/auth/src/mfa.ts', 'body.set("otpCode", code);'],
    ['a camelCase totpCode', 'packages/auth/src/mfa.ts', 'export const totpCode = 1;'],
    ['a snake_case user_pin', 'apps/cli/src/pin.ts', 'const user_pin = 1;'],
    ['a sharedSecret', 'packages/auth/src/hmac.ts', 'const sharedSecret = load();'],
    ['a user_secret', 'apps/cli/src/login.ts', 'send({ user_secret });'],
    ['a "Secret: " prompt', 'apps/cli/src/login.ts', "rl.question('Secret: ', done);"],
    ['an "Enter your secret" prompt', 'apps/cli/src/login.ts', 'ask("Enter your secret?");'],
    [
      'code after a block comment on the same line',
      'apps/web/src/Login.tsx',
      '/* legacy */ <input type="password" />',
    ],
    [
      'code after a JSX comment on the same line',
      'apps/web/src/Login.tsx',
      '{/* legacy */} <input type="password" />',
    ],
    [
      'code after a comment continuation closes',
      'apps/web/src/Login.tsx',
      ' * end of note */ const password = x;',
    ],
  ])('fails on %s', (_, path, line) => {
    const findings = run(withOpenApi({ [path]: `export {};\n${line}\n` }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(
      new RegExp(`^no-password/[a-z-]+ ${path.replace(/\./g, '\\.')}:2$`),
    );
  });

  it('R34-3: look-alike words and whole-line comments stay clean', () => {
    const clean = [
      'const spinner = <Spinner pinned />;',
      'export const hotpath = pinch(opinion);',
      'const secretary = "Secrets manager";',
      'const passport = passive();',
      '/* a block comment about the password grant */',
      '{/* the passcode field was removed */}',
      ' * the user never types a password */',
      '<!-- no password field here -->',
    ];
    expect(clean.flatMap((line) => checkClientSource('a.tsx', line))).toEqual([]);
  });

  it('reports the rule that matched', () => {
    expect(checkClientSource('a.tsx', '<input type="password" />').map((f) => f.rule)).toEqual([
      'no-password/password-input',
    ]);
    expect(checkClientSource('a.ts', "grant_type: 'password'").map((f) => f.rule)).toEqual([
      'no-password/password-grant',
    ]);
    expect(checkClientSource('a.ts', 'const clientSecret = 1;').map((f) => f.rule)).toEqual([
      'no-password/client-secret',
    ]);
  });

  it('fails when the committed OpenAPI document is missing', () => {
    expect(run({ 'packages/auth/src/a.ts': 'export {};\n' })).toEqual([
      `no-password/openapi ${REQUIRED_OPENAPI[0] as string}`,
    ]);
  });
});

describe('check-no-password over OpenAPI (TC-F-002-05)', () => {
  const doc = (mutate: (d: typeof CLEAN_OPENAPI & Record<string, unknown>) => void) => {
    const copy = structuredClone(CLEAN_OPENAPI) as typeof CLEAN_OPENAPI & Record<string, unknown>;
    mutate(copy);
    return checkOpenApiDocument('openapi.json', copy).map((f) => f.message.split(':')[0]);
  };

  it('passes a clean document; prose may say there is no password', () => {
    expect(doc(() => undefined)).toEqual([]);
  });

  it.each([
    [
      'a schema property',
      (d: Record<string, unknown>) => {
        d.components = { schemas: { Login: { properties: { password: {} } } } };
      },
      '$.components.schemas.Login.properties.password',
    ],
    [
      'a query parameter name',
      (d: Record<string, unknown>) => {
        (d.paths as Record<string, unknown>)['/v1/x'] = {
          get: { parameters: [{ name: 'pin', in: 'query' }] },
        };
      },
      '$.paths./v1/x.get.parameters[0].name',
    ],
    [
      'a header parameter',
      (d: Record<string, unknown>) => {
        (d.paths as Record<string, unknown>)['/v1/y'] = {
          post: { parameters: [{ name: 'X-OTP', in: 'header' }] },
        };
      },
      '$.paths./v1/y.post.parameters[0].name',
    ],
    [
      'a grant type enum value',
      (d: Record<string, unknown>) => {
        const post = (d.paths as Record<string, { post: Record<string, unknown> }>)['/oauth2/token']
          ?.post as {
          requestBody: {
            content: Record<
              string,
              { schema: { properties: Record<string, { enum?: string[] }> } }
            >;
          };
        };
        const form = post.requestBody.content['application/x-www-form-urlencoded'];
        form?.schema.properties.grant_type?.enum?.push('password');
      },
      '$.paths./oauth2/token.post.requestBody.content.application/x-www-form-urlencoded.schema.properties.grant_type.enum[2]',
    ],
    [
      'a client_secret property',
      (d: Record<string, unknown>) => {
        d.components = { schemas: { T: { properties: { client_secret: {} } } } };
      },
      '$.components.schemas.T.properties.client_secret',
    ],
    [
      'a path',
      (d: Record<string, unknown>) => {
        (d.paths as Record<string, unknown>)['/v1/users/{id}/password'] = { put: {} };
      },
      '$.paths./v1/users/{id}/password',
    ],
    // Review of #34 (R34-3).
    [
      'a password inside a property NAMED description',
      (d: Record<string, unknown>) => {
        d.components = {
          schemas: { T: { properties: { description: { enum: ['password'] } } } },
        };
      },
      '$.components.schemas.T.properties.description.enum[0]',
    ],
    [
      'a camelCase userPin property',
      (d: Record<string, unknown>) => {
        d.components = { schemas: { T: { properties: { userPin: {} } } } };
      },
      '$.components.schemas.T.properties.userPin',
    ],
    [
      'a default value',
      (d: Record<string, unknown>) => {
        d.components = { schemas: { T: { properties: { grant: { default: 'password' } } } } };
      },
      '$.components.schemas.T.properties.grant.default',
    ],
    [
      'a pattern value',
      (d: Record<string, unknown>) => {
        d.components = { schemas: { T: { properties: { g: { pattern: '^(otp|code)$' } } } } };
      },
      '$.components.schemas.T.properties.g.pattern',
    ],
    [
      'an example value, nested',
      (d: Record<string, unknown>) => {
        d.components = { schemas: { T: { example: { grant: 'password', user: 'u' } } } };
      },
      '$.components.schemas.T.example.grant',
    ],
    [
      'an examples entry',
      (d: Record<string, unknown>) => {
        d.components = { examples: { login: { value: { g: 'otp' } } } };
      },
      '$.components.examples.login.value.g',
    ],
  ])('fails on %s', (_, mutate, where) => {
    expect(doc(mutate)).toEqual([where]);
  });
});
