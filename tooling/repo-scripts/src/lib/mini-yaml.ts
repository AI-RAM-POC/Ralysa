// A strict, dependency-free reader for the YAML subset pnpm-workspace.yaml needs. The pre-install
// gate runs before `pnpm install`, so it can't use the `yaml` package.
//
// It fails closed: anything outside the subset is an error, not a guess, so a document can't
// hide a key from the gate by using YAML syntax the gate doesn't understand (anchors, aliases,
// merge keys, tags, explicit `?` keys, flow collections, block scalars, escapes, multi-line plain
// scalars, several documents, tabs, duplicate keys). check-workspaces also compares this parse
// with the `yaml` package's parse after install and fails on any difference.
//
// Supported: block mappings and block sequences nested by indentation; plain, single-quoted and
// double-quoted (no backslash) scalars; `{}` and `[]`; `# comments`. Plain `true`/`false` are
// booleans, `null`/`~` null, and plain decimal integers numbers; every other plain scalar is a
// string. Plain scalars that YAML 1.2 would read as another type (`True`, `0x1F`, `1.5`, `.inf`)
// are rejected so the two parsers can't disagree.

export type YamlValue =
  string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export class MiniYamlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`line ${String(line)}: ${message}`);
    this.line = line;
  }
}

interface Line {
  no: number;
  indent: number;
  text: string;
}

const FORBIDDEN_PLAIN_START = /^[&*!|>%@`{[\]}?,'"]/;

/**
 * A carriage return not followed by a line feed. pnpm's YAML reader (@zkochan/js-yaml) and the
 * `ini` reader it uses for .npmrc both treat a lone CR as a line break, so text after one would
 * be read as a new line by pnpm but as part of the previous line (for example a comment) by a
 * reader that splits on LF only (code review R3-1).
 */
export const LONE_CR = /\r(?!\n)/;

/**
 * Characters the subset refuses anywhere: C0 controls other than LF (CR is handled as CRLF or
 * rejected as a lone CR; tab has its own message), DEL, the Unicode line and paragraph
 * separators and NEL, the byte-order mark, and non-ASCII spaces. Readers disagree about whether
 * these are line breaks or whitespace, so none of them may appear.
 */
const FORBIDDEN_CHAR =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point of this check
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/;

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split(/\r\n|\n/).length;
}

function preprocess(source: string): Line[] {
  const cr = LONE_CR.exec(source);
  if (cr !== null) {
    throw new MiniYamlError(
      'a carriage return not followed by a line feed; pnpm reads it as a line break, so it is refused',
      lineOf(source, cr.index),
    );
  }
  const forbidden = FORBIDDEN_CHAR.exec(source);
  if (forbidden !== null) {
    const code = (forbidden[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
    throw new MiniYamlError(`character U+${code} is not allowed`, lineOf(source, forbidden.index));
  }
  const lines: Line[] = [];
  source.split(/\r\n|\n/).forEach((text, index) => {
    const no = index + 1;
    if (text.includes('\t')) throw new MiniYamlError('tab characters are not supported', no);
    const trimmed = text.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    if (/^(---|\.\.\.)(\s|$)/.test(text) || text.startsWith('%')) {
      throw new MiniYamlError('document markers and directives are not supported', no);
    }
    const indent = text.length - text.trimStart().length;
    lines.push({ no, indent, text: trimmed });
  });
  return lines;
}

/** Strips a trailing ` # comment` from the text after a value. */
function assertOnlyComment(rest: string, no: number): void {
  const trimmed = rest.trim();
  if (trimmed !== '' && !trimmed.startsWith('#')) {
    throw new MiniYamlError(`unexpected text after a quoted value: ${trimmed}`, no);
  }
}

/** Reads a quoted scalar at the start of `text`; returns the value and the rest of the line. */
function readQuoted(text: string, no: number): [string, string] {
  const quote = text[0];
  if (quote === "'") {
    let value = '';
    let i = 1;
    for (;;) {
      if (i >= text.length) throw new MiniYamlError('unterminated single-quoted scalar', no);
      if (text[i] === "'") {
        if (text[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }
        return [value, text.slice(i + 1)];
      }
      value += text.charAt(i);
      i += 1;
    }
  }
  const end = text.indexOf('"', 1);
  if (end === -1) throw new MiniYamlError('unterminated double-quoted scalar', no);
  const value = text.slice(1, end);
  if (value.includes('\\')) {
    throw new MiniYamlError('escape sequences in double-quoted scalars are not supported', no);
  }
  return [value, text.slice(end + 1)];
}

function plainScalar(raw: string, no: number): YamlValue {
  // A plain scalar ends at " #".
  const hash = raw.search(/\s#/);
  const text = (hash === -1 ? raw : raw.slice(0, hash)).trim();
  if (text === '{}') return {};
  if (text === '[]') return [];
  if (FORBIDDEN_PLAIN_START.test(text)) {
    throw new MiniYamlError(`unsupported value syntax: ${text}`, no);
  }
  if (/:(\s|$)/.test(text)) throw new MiniYamlError(`ambiguous plain scalar: ${text}`, no);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?(0|[1-9][0-9]*)$/.test(text)) return Number(text);
  if (/^(true|false|null|yes|no|on|off)$/i.test(text)) {
    throw new MiniYamlError(`ambiguous boolean or null: ${text}; quote it or use lowercase`, no);
  }
  const numeric = text.replace(/_/g, '');
  if (/^[-+]?\.(inf|nan)$/i.test(text) || (numeric !== '' && Number.isFinite(Number(numeric)))) {
    throw new MiniYamlError(`ambiguous number: ${text}; quote it`, no);
  }
  return text;
}

function scalar(raw: string, no: number): YamlValue {
  const text = raw.trimStart();
  if (text.startsWith("'") || text.startsWith('"')) {
    const [value, rest] = readQuoted(text, no);
    assertOnlyComment(rest, no);
    return value;
  }
  return plainScalar(text, no);
}

/** Splits `key: value` / `key:`; returns undefined when the line is not a mapping entry. */
function splitEntry(line: Line): { key: string; rest: string } | undefined {
  const { text, no } = line;
  if (text.startsWith("'") || text.startsWith('"')) {
    const [key, after] = readQuoted(text, no);
    if (!after.startsWith(':')) throw new MiniYamlError('expected ":" after a quoted key', no);
    const rest = after.slice(1);
    if (rest !== '' && !rest.startsWith(' '))
      throw new MiniYamlError('expected a space after ":"', no);
    return { key, rest };
  }
  const match = /^([^\s:#][^:#]*?)\s*:(\s+|$)(.*)$/.exec(text);
  if (match === null) return undefined;
  const key = match[1] ?? '';
  if (FORBIDDEN_PLAIN_START.test(key) || key === '<<') {
    throw new MiniYamlError(`unsupported key syntax: ${key}`, no);
  }
  return { key, rest: match[3] ?? '' };
}

/** True when `text` would read as a `key: value` entry (used to reject maps inside sequences). */
function looksLikeEntry(text: string, no: number): boolean {
  if (text.startsWith("'") || text.startsWith('"')) {
    const [, after] = readQuoted(text, no);
    return after.trimStart().startsWith(':');
  }
  return /^[^\s:#][^:#]*?\s*:(\s|$)/.test(text);
}

const isSequenceItem = (line: Line): boolean => line.text === '-' || line.text.startsWith('- ');

class Parser {
  private i = 0;
  private readonly lines: Line[];
  constructor(lines: Line[]) {
    this.lines = lines;
  }

  parseDocument(): Record<string, YamlValue> {
    if (this.lines.length === 0) return {};
    const first = this.lines[0] as Line;
    if (first.indent !== 0)
      throw new MiniYamlError('the document must start at column 0', first.no);
    if (isSequenceItem(first) || splitEntry(first) === undefined) {
      throw new MiniYamlError('the document must be a mapping', first.no);
    }
    const value = this.parseMapping(0);
    const next = this.lines[this.i];
    if (next !== undefined) throw new MiniYamlError('unexpected indentation', next.no);
    return value;
  }

  private parseMapping(indent: number): Record<string, YamlValue> {
    const result: Record<string, YamlValue> = {};
    for (;;) {
      const line = this.lines[this.i];
      if (line === undefined || line.indent < indent) return result;
      if (line.indent > indent) throw new MiniYamlError('unexpected indentation', line.no);
      if (isSequenceItem(line))
        throw new MiniYamlError('a sequence item where a key was expected', line.no);
      const entry = splitEntry(line);
      if (entry === undefined)
        throw new MiniYamlError(`not a "key: value" line: ${line.text}`, line.no);
      if (Object.hasOwn(result, entry.key)) {
        throw new MiniYamlError(`duplicate key: ${entry.key}`, line.no);
      }
      this.i += 1;
      const rest = entry.rest.trim();
      if (rest !== '' && !rest.startsWith('#')) {
        result[entry.key] = scalar(entry.rest, line.no);
        continue;
      }
      const next = this.lines[this.i];
      if (next !== undefined && next.indent > indent) {
        result[entry.key] = isSequenceItem(next)
          ? this.parseSequence(next.indent)
          : this.parseMapping(next.indent);
      } else if (next !== undefined && next.indent === indent && isSequenceItem(next)) {
        result[entry.key] = this.parseSequence(indent);
      } else {
        result[entry.key] = null;
      }
    }
  }

  private parseSequence(indent: number): YamlValue[] {
    const items: YamlValue[] = [];
    for (;;) {
      const line = this.lines[this.i];
      if (line === undefined || line.indent < indent || !isSequenceItem(line)) return items;
      if (line.indent > indent) throw new MiniYamlError('unexpected indentation', line.no);
      const body = line.text.slice(1).trim();
      if (body === '' || body.startsWith('#')) {
        throw new MiniYamlError('nested collections in sequence items are not supported', line.no);
      }
      if (body.startsWith('- ') || looksLikeEntry(body, line.no)) {
        throw new MiniYamlError('nested collections in sequence items are not supported', line.no);
      }
      items.push(scalar(body, line.no));
      this.i += 1;
    }
  }
}

/** Parses the supported subset; throws MiniYamlError on anything else. */
export function parseMiniYaml(source: string): Record<string, YamlValue> {
  return new Parser(preprocess(source)).parseDocument();
}
