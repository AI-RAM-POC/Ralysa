// A headless "browser" for the mock IdP's HTML pages (F-002 design §8.3), so tests can play the
// user's part: approve a device code (flow A) or sign in at the authorization endpoint (flow B).
// It follows redirects inside the mock's origin, keeps cookies per path, submits the pages'
// forms, and stops at the first redirect that leaves the mock (the client's redirect_uri).
//
// The only thing it types is a fixture username: the mock has no password field.

export class MockBrowserError extends Error {
  /** The `id="error"` text of the page that stopped the flow, when there was one. */
  readonly pageError: string | undefined;

  constructor(message: string, pageError?: string) {
    super(message);
    this.name = 'MockBrowserError';
    this.pageError = pageError;
  }
}

interface Cookie {
  name: string;
  value: string;
  path: string;
}

class CookieJar {
  readonly #cookies = new Map<string, Cookie>();

  store(url: URL, setCookies: string[]): void {
    for (const line of setCookies) {
      const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      let path = '/';
      let expired = value === '';
      for (const attribute of attributes) {
        const [key = '', attributeValue = ''] = attribute.split('=');
        const lower = key.toLowerCase();
        if (lower === 'path' && attributeValue.startsWith('/')) path = attributeValue;
        if (lower === 'max-age' && Number(attributeValue) <= 0) expired = true;
        if (lower === 'expires' && Date.parse(attributeValue) <= Date.now()) expired = true;
      }
      const id = `${name}|${path}|${url.host}`;
      if (expired) this.#cookies.delete(id);
      else this.#cookies.set(id, { name, value, path });
    }
  }

  header(url: URL): string | undefined {
    const matching = [...this.#cookies.entries()]
      .filter(([id, c]) => id.endsWith(`|${url.host}`) && url.pathname.startsWith(c.path))
      .map(([, c]) => `${c.name}=${c.value}`);
    return matching.length === 0 ? undefined : matching.join('; ');
  }
}

const decodeEntities = (text: string): string =>
  text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const attr = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag);
  return match?.[1] === undefined ? undefined : decodeEntities(match[1]);
};

interface ParsedForm {
  action: string;
  method: string;
  fields: URLSearchParams;
  /** Names of the visible (non-hidden) inputs. */
  visible: string[];
  marker: string | undefined;
}

/** The pages' forms: oidc-provider's form_post and device forms, and the mock's login form. */
export function parseForms(html: string): ParsedForm[] {
  const forms: ParsedForm[] = [];
  for (const match of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const open = match[1] ?? '';
    const body = match[2] ?? '';
    const fields = new URLSearchParams();
    const visible: string[] = [];
    for (const input of body.matchAll(/<input\b([^>]*)>/gi)) {
      const tag = input[1] ?? '';
      const name = attr(tag, 'name');
      if (name === undefined) continue;
      if ((attr(tag, 'type') ?? 'text').toLowerCase() === 'hidden') {
        fields.append(name, attr(tag, 'value') ?? '');
      } else {
        visible.push(name);
      }
    }
    forms.push({
      action: attr(open, 'action') ?? '',
      method: (attr(open, 'method') ?? 'get').toLowerCase(),
      fields,
      visible,
      marker: attr(open, 'data-mock-idp'),
    });
  }
  return forms;
}

const pageError = (html: string): string | undefined => {
  const match = /<p id="error">([\s\S]*?)<\/p>/.exec(html);
  return match?.[1] === undefined ? undefined : decodeEntities(match[1]);
};

export interface BrowserResult {
  /** The redirect that left the mock (flow B: the client's redirect_uri with code and state). */
  redirect?: URL;
  /** The last page's HTML when the flow ended on a mock page (flow A: the success page). */
  html?: string;
}

const MAX_STEPS = 30;

/**
 * Drive the mock's pages from `start` until a redirect leaves the mock's origin, or a page has
 * nothing left to submit. `username` answers the login page. Any page with `id="error"` throws.
 */
async function drive(
  start: URL,
  username: string,
  form?: { method: 'post'; body: URLSearchParams },
): Promise<BrowserResult> {
  const origin = start.origin;
  const jar = new CookieJar();
  let url = start;
  let request: { method: 'get' | 'post'; body?: URLSearchParams } = form ?? { method: 'get' };

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const headers: Record<string, string> = {};
    const cookie = jar.header(url);
    if (cookie !== undefined) headers.cookie = cookie;
    if (request.body !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    const response = await fetch(url, {
      method: request.method.toUpperCase(),
      headers,
      redirect: 'manual',
      ...(request.body === undefined ? {} : { body: request.body.toString() }),
    });
    jar.store(url, response.headers.getSetCookie());

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location !== null) {
      await response.body?.cancel();
      const next = new URL(location, url);
      if (next.origin !== origin) return { redirect: next };
      url = next;
      request = { method: 'get' };
      continue;
    }

    const html = await response.text();
    const error = pageError(html);
    if (error !== undefined) {
      throw new MockBrowserError(`mock IdP page error: ${error}`, error);
    }
    const forms = parseForms(html);
    const login = forms.find((f) => f.marker === 'login');
    const next =
      login ??
      // form_post pages and the device confirm form: hidden fields only.
      forms.find((f) => f.method === 'post' && f.visible.length === 0 && [...f.fields].length > 0);
    if (next === undefined) return { html };
    if (login !== undefined) next.fields.set('username', username);
    url = new URL(next.action, url);
    request = { method: 'post', body: next.fields };
  }
  throw new MockBrowserError(`mock IdP flow did not finish in ${String(MAX_STEPS)} steps`);
}

/**
 * Flow A: the user opens `verification_uri_complete` (or the verification URI with the code),
 * confirms, and signs in as `username`. Resolves when the mock shows its success page.
 */
export async function approveDeviceCode(input: {
  verificationUri: string;
  userCode: string;
  username: string;
}): Promise<void> {
  const url = new URL(input.verificationUri);
  url.searchParams.set('user_code', input.userCode);
  const result = await drive(url, input.username);
  if (result.html?.includes('id="device-success"') !== true) {
    throw new MockBrowserError('device approval did not reach the success page');
  }
}

/**
 * Flow B: open the authorization URL as the browser would, sign in as `username`, and return the
 * redirect to the client's `redirect_uri` (with `code` and `state`, or `error`). The redirect is
 * returned, not followed.
 */
export async function signInAtAuthorize(input: {
  authorizationUrl: string;
  username: string;
}): Promise<URL> {
  const result = await drive(new URL(input.authorizationUrl), input.username);
  if (result.redirect === undefined) {
    throw new MockBrowserError('the authorization flow did not redirect to the client');
  }
  return result.redirect;
}
