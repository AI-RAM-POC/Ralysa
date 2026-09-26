#!/usr/bin/env node
// guard-bash: the Claude Code PreToolUse guard for the Bash tool (F-001 design §6.3.3; D-4;
// SEC-F001-10, -11, -12). It is layer 2 behind the allow and deny lists in .claude/settings.json:
// those match the command string, and miss rewritten forms (`git -C . push`); this parses the
// command and decides from the parsed form.
//
// Contract (Claude Code hooks): the hook JSON arrives on stdin. Exit 0 hands the command back to
// the normal permission flow (a hook can only narrow permissions). Exit 2 blocks it, and stderr
// goes back to the agent as the reason. Every block names its rule id in brackets, for example
// "[G-2]", so the fixture tests (.claude/hooks/test/) can check which rule fired.
//
// Plain Node 24 ESM with no dependencies, so it works before any install and can't be changed by
// a dependency update. It fails closed: anything it can't parse or resolve in a command that
// mentions git, gh, pnpm, npm, npx, turbo, hub or sudo is blocked.
//
// Limits (design §6.3): only commands Claude Code runs directly are seen. A script run by an
// allowed command (`pnpm test` runs package.json scripts) is not. These rules stop mistakes and
// prompt-injected shortcuts; they are not a boundary against a deliberately hostile agent
// (accepted risk SEC-F001-01).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository this hook belongs to: .claude/hooks/ → the repo root. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

class Block extends Error {
  constructor(rule, reason) {
    super(reason);
    this.rule = rule;
  }
}

class ParseError extends Error {}

function block(rule, reason) {
  throw new Block(rule, reason);
}

// ---------------------------------------------------------------------------------------------
// Guarded words
// ---------------------------------------------------------------------------------------------

const GUARDED = ['git', 'gh', 'pnpm', 'npm', 'npx', 'pnpx', 'turbo', 'hub', 'sudo'];
const GUARDED_SET = new Set(GUARDED);
const GUARDED_ALT = GUARDED.join('|');
/** Broad: any mention, for deciding whether parse-level rules apply to a command at all. */
const MENTION_BROAD = new RegExp(`(?<![\\w.-])(?:${GUARDED_ALT})(?![\\w-])`);
/**
 * Narrow: a guarded word used as a command inside an argument (`node -e "…git push…"`,
 * `find -exec git …`, `sed 's/x/git push/e'`). It must be followed by a shell boundary, so
 * `test/git.test.ts` and `.github/` don't match.
 */
const MENTION_AS_COMMAND = new RegExp(
  `(?:^|[\\s;&|()<>'"\`=/])(?:${GUARDED_ALT})(?=$|[\\s;&|()<>'"\`])`,
  'm',
);

/** Commands that only read or print their arguments, so a guarded word there is data. */
const DATA_ONLY = new Set([
  'echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'which', 'type', 'whereis',
  'whatis', 'man', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'ls', 'file', 'stat', 'test', '[',
  '[[', 'true', 'false', ':', 'pwd', 'mkdir', 'touch', 'cp', 'mv', 'rm', 'ln', 'diff', 'sort',
  'uniq', 'cut', 'tr', 'basename', 'dirname', 'realpath', 'readlink', 'jq', 'tee', 'column',
  'cd', 'pushd', 'popd', 'for', 'case', 'in', 'done', 'fi', 'esac', 'select', 'unset',
]);

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']);
const INTERPRETERS = new Set([
  'node', 'python', 'python3', 'perl', 'ruby', 'php', 'deno', 'bun', 'osascript', 'awk', 'gawk',
  'mawk', 'lua', 'tclsh', 'pwsh', 'powershell', 'expect',
]);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!']);
/** An interpreter's inline-code option: node -e/-p/--eval/--print, python -c, perl -e/-E, ruby -e. */
const INLINE_CODE_FLAG = /^(-[a-zA-Z]*[ecpE][a-zA-Z]*|--eval(=.*)?|--print(=.*)?|--command(=.*)?)$/;
const INLINE_CODE_WORDS = /\b(git|gh|push|merge|release)\b/;

/** Environment assignments that redirect git, gh or Turbo (design §6.3.3 "Parsing"). */
function isGuardedVariable(name) {
  return (
    /^(GIT_|GH_|TURBO_REMOTE_)/.test(name) ||
    ['GITHUB_TOKEN', 'TURBO_API', 'TURBO_TOKEN', 'TURBO_TEAM', 'TURBO_TEAMID'].includes(name) ||
    // git and gh read their user config from here, so a crafted one could hold an alias or a
    // hooksPath the guard never sees (standing authorization, recorded by Claude; T15 notes).
    ['HOME', 'XDG_CONFIG_HOME'].includes(name)
  );
}

// ---------------------------------------------------------------------------------------------
// Lexer: shell words and segments
// ---------------------------------------------------------------------------------------------

/**
 * Splits a command line into segments (split on ; && || | & newlines and parentheses) of words.
 * Quotes are removed from word text. It records command and process substitution, variables,
 * unquoted globs and brace expansion, and skips here-document bodies and redirection targets.
 */
export function lex(src) {
  const segments = [];
  const info = { substitution: false, processSubstitution: false };
  let words = [];
  let word = null;
  let pendingHeredocs = [];
  let expectRedirectTarget = false;
  let expectHeredoc = null;
  let i = 0;
  const n = src.length;

  const start = () => {
    if (word === null) {
      word = { text: '', hasVar: false, glob: false, brace: false, quoted: false, quotedAt: Infinity };
    }
    return word;
  };
  const markQuoted = () => {
    const w = start();
    w.quoted = true;
    if (w.quotedAt === Infinity) w.quotedAt = w.text.length;
  };
  const endWord = () => {
    if (word === null) return;
    if (expectHeredoc !== null) {
      pendingHeredocs.push({ delim: word.text, strip: expectHeredoc.strip, quoted: word.quoted });
      expectHeredoc = null;
    } else if (expectRedirectTarget) {
      expectRedirectTarget = false;
    } else if (!word.quoted && (word.text === '{' || word.text === '}')) {
      word = null;
      endSegment();
    } else {
      if (word.brace && !word.quoted) word.brace = /\{[^{}]*(,|\.\.)[^{}]*\}/.test(word.text);
      else word.brace = false;
      words.push(word);
    }
    word = null;
  };
  function endSegment() {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  }
  const consumeHeredocs = (from) => {
    let pos = from;
    for (const doc of pendingHeredocs) {
      while (pos < n) {
        const eol = src.indexOf('\n', pos);
        const line = src.slice(pos, eol === -1 ? n : eol);
        pos = eol === -1 ? n : eol + 1;
        const compared = doc.strip ? line.replace(/^\t+/, '') : line;
        if (compared === doc.delim) break;
        if (!doc.quoted && (line.includes('$(') || line.includes('`'))) info.substitution = true;
      }
    }
    pendingHeredocs = [];
    return pos;
  };
  /** Index of the `)` closing the `(` at `open`, skipping quotes. */
  const matchParen = (open) => {
    let depth = 0;
    for (let j = open; j < n; j++) {
      const ch = src[j];
      if (ch === '\\') {
        j++;
      } else if (ch === "'") {
        const end = src.indexOf("'", j + 1);
        if (end === -1) throw new ParseError('unterminated single quote');
        j = end;
      } else if (ch === '"') {
        j = matchDoubleQuote(j);
      } else if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
        if (depth === 0) return j;
      }
    }
    throw new ParseError('unterminated command substitution');
  };
  const matchDoubleQuote = (open) => {
    for (let j = open + 1; j < n; j++) {
      if (src[j] === '\\') j++;
      else if (src[j] === '"') return j;
    }
    throw new ParseError('unterminated double quote');
  };
  const matchBacktick = (open) => {
    for (let j = open + 1; j < n; j++) {
      if (src[j] === '\\') j++;
      else if (src[j] === '`') return j;
    }
    throw new ParseError('unterminated backtick');
  };
  /** Handles `$…` at i (outside single quotes). Returns the next index. */
  const dollar = (at) => {
    const w = start();
    const next = src[at + 1];
    if (next === '(') {
      info.substitution = true;
      w.hasVar = true;
      const end = matchParen(at + 1);
      w.text += src.slice(at, end + 1);
      return end + 1;
    }
    if (next === '{') {
      w.hasVar = true;
      let depth = 0;
      for (let j = at + 1; j < n; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) {
          const body = src.slice(at, j + 1);
          if (body.includes('$(') || body.includes('`')) info.substitution = true;
          w.text += body;
          return j + 1;
        }
      }
      throw new ParseError('unterminated ${');
    }
    const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(src.slice(at + 1));
    if (name) {
      w.hasVar = true;
      w.text += `$${name[0]}`;
      return at + 1 + name[0].length;
    }
    w.text += '$';
    return at + 1;
  };
  const ansiC = (at) => {
    // $'…': decode the escapes, so $'\x67it' is seen as "git".
    markQuoted();
    let j = at + 2;
    let out = '';
    const simple = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
    while (true) {
      if (j >= n) throw new ParseError("unterminated $'");
      const ch = src[j];
      if (ch === "'") break;
      if (ch !== '\\') {
        out += ch;
        j++;
        continue;
      }
      const e = src[j + 1];
      let m;
      if (e !== undefined && e in simple) {
        out += simple[e];
        j += 2;
      } else if ((m = /^x([0-9A-Fa-f]{1,2})/.exec(src.slice(j + 1)))) {
        out += String.fromCharCode(parseInt(m[1], 16));
        j += 1 + m[0].length;
      } else if ((m = /^u([0-9A-Fa-f]{1,4})/.exec(src.slice(j + 1)))) {
        out += String.fromCharCode(parseInt(m[1], 16));
        j += 1 + m[0].length;
      } else if ((m = /^U([0-9A-Fa-f]{1,8})/.exec(src.slice(j + 1)))) {
        out += String.fromCodePoint(parseInt(m[1], 16));
        j += 1 + m[0].length;
      } else if ((m = /^([0-7]{1,3})/.exec(src.slice(j + 1)))) {
        out += String.fromCharCode(parseInt(m[1], 8));
        j += 1 + m[0].length;
      } else if (e === 'c' && j + 2 < n) {
        out += String.fromCharCode(src.charCodeAt(j + 2) & 31);
        j += 3;
      } else {
        out += `\\${e ?? ''}`;
        j += 2;
      }
    }
    word.text += out;
    return j + 1;
  };

  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2;
        continue;
      }
      markQuoted();
      word.text += src[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) throw new ParseError('unterminated single quote');
      markQuoted();
      word.text += src.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"' || (c === '$' && src[i + 1] === '"')) {
      if (c === '$') i++;
      markQuoted();
      i++;
      for (;;) {
        if (i >= n) throw new ParseError('unterminated double quote');
        const d = src[i];
        if (d === '"') {
          i++;
          break;
        }
        if (d === '\\' && i + 1 < n && '$`"\\\n'.includes(src[i + 1])) {
          if (src[i + 1] !== '\n') word.text += src[i + 1];
          i += 2;
        } else if (d === '`') {
          info.substitution = true;
          word.hasVar = true;
          const end = matchBacktick(i);
          word.text += src.slice(i, end + 1);
          i = end + 1;
        } else if (d === '$') {
          i = dollar(i);
        } else {
          word.text += d;
          i++;
        }
      }
      continue;
    }
    if (c === '$' && src[i + 1] === "'") {
      i = ansiC(i);
      continue;
    }
    if (c === '$') {
      i = dollar(i);
      continue;
    }
    if (c === '`') {
      info.substitution = true;
      start().hasVar = true;
      const end = matchBacktick(i);
      word.text += src.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if ((c === '<' || c === '>') && src[i + 1] === '(') {
      info.processSubstitution = true;
      const end = matchParen(i + 1);
      start().hasVar = true;
      word.text += src.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      i++;
      continue;
    }
    if (c === '\n') {
      endSegment();
      i = pendingHeredocs.length > 0 ? consumeHeredocs(i + 1) : i + 1;
      continue;
    }
    if (c === '#' && word === null) {
      const eol = src.indexOf('\n', i);
      i = eol === -1 ? n : eol;
      continue;
    }
    if (c === ';') {
      endSegment();
      i += src[i + 1] === ';' || src[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (c === '&') {
      if (src[i + 1] === '>') {
        endWord();
        expectRedirectTarget = true;
        i += src[i + 2] === '>' ? 3 : 2;
        continue;
      }
      endSegment();
      i += src[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (c === '|') {
      endSegment();
      i += src[i + 1] === '|' || src[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (c === '(' || c === ')') {
      endSegment();
      i++;
      continue;
    }
    if (c === '<' || c === '>') {
      // A digit-only word right before a redirection is its file descriptor (2>&1).
      if (word !== null && !word.quoted && /^\d+$/.test(word.text)) word = null;
      else endWord();
      if (src.startsWith('<<<', i)) {
        expectRedirectTarget = true;
        i += 3;
      } else if (src.startsWith('<<-', i)) {
        expectHeredoc = { strip: true };
        i += 3;
      } else if (src.startsWith('<<', i)) {
        expectHeredoc = { strip: false };
        i += 2;
      } else {
        expectRedirectTarget = true;
        const two = src.slice(i, i + 2);
        i += ['>>', '>|', '>&', '<&', '<>'].includes(two) ? 2 : 1;
      }
      continue;
    }
    const w = start();
    if (c === '*' || c === '?' || c === '[') w.glob = true;
    if (c === '{') w.brace = true;
    w.text += c;
    i++;
  }
  endSegment();
  return { segments, ...info };
}

// ---------------------------------------------------------------------------------------------
// State helpers (git, gh, files)
// ---------------------------------------------------------------------------------------------

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 45_000 });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function git(cwd, args) {
  return run('git', args, cwd);
}

function isDir(path) {
  try {
    return path !== null && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The existing candidate directories, or a block when none can be resolved. */
function existingDirs(cwds, rule, what) {
  if (cwds.some((c) => c === null)) block(rule, `can't tell which directory ${what} runs in; run it without cd to a variable`);
  const dirs = [...new Set(cwds)].filter(isDir);
  if (dirs.length === 0) block(rule, `can't resolve the repository for ${what} (directory not found)`);
  return dirs;
}

function configGet(cwd, key) {
  const r = git(cwd, ['config', '--get', key]);
  if (r.status === 0) return r.stdout.trim();
  if (r.status === 1) return null;
  block('parse', `git config --get ${key} failed in ${cwd}: ${r.stderr.trim() || r.error?.message || r.status}`);
}

/** owner/repo from a GitHub remote URL or a -R value, lower-cased; null if unrecognised. */
export function repoSlug(value) {
  const v = value.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  let m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?[^/]+\/([^/]+)\/([^/]+)$/.exec(v);
  if (!m) m = /^[^@\s]+@[^:\s]+:([^/]+)\/([^/]+)$/.exec(v);
  if (!m) m = /^(?:[^/\s]+\/)?([^/\s]+)\/([^/\s]+)$/.exec(v);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

/**
 * Decides one Bash command. Returns { block: false } or { block: true, rule, reason }.
 * `context.cwd` is the directory Claude Code runs the command in.
 */
export function evaluate(command, context) {
  const broad = MENTION_BROAD.test(command) || command.includes("$'");
  let lexed;
  try {
    lexed = lex(command);
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    if (broad) return { block: true, rule: 'parse', reason: `can't parse the command (${error.message})` };
    return { block: false };
  }
  const decoded = lexed.segments.some((seg) =>
    seg.some((w) => GUARDED_SET.has(basename(w.text)) || MENTION_BROAD.test(w.text)),
  );
  const st = {
    guarded: broad || decoded,
    initialCwd: context.cwd,
    cwds: [context.cwd],
    segmentIndex: 0,
    commits: [],
    pushes: [],
  };
  try {
    if (st.guarded) {
      if (lexed.substitution) {
        block('parse', 'command substitution ($(…) or backticks) together with git/gh/pnpm is blocked. For a commit message use `git commit -F <file>` or a quoted here-document (`git commit -F - <<\'EOF\'`); for a PR body use `--body-file <file>`');
      }
      if (lexed.processSubstitution) block('parse', 'process substitution together with git/gh/pnpm is blocked');
      for (const seg of lexed.segments) {
        for (const w of seg) {
          if (w.brace && MENTION_BROAD.test(w.text)) block('parse', `brace expansion that forms a guarded command is blocked: ${w.text}`);
        }
      }
    }
    for (const seg of lexed.segments) {
      checkWords(seg, st);
      st.segmentIndex++;
    }
    afterChecks(st);
    return { block: false };
  } catch (error) {
    if (error instanceof Block) return { block: true, rule: error.rule, reason: error.message };
    if (st.guarded) {
      return { block: true, rule: 'internal', reason: `guard error, failing closed: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { block: false };
  }
}

function isAssignment(w) {
  const m = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/.exec(w.text);
  return m !== null && m[0].length <= w.quotedAt;
}

function assignmentName(text) {
  return /^[A-Za-z_][A-Za-z0-9_]*/.exec(text)[0];
}

function checkAssignments(names, st) {
  if (!st.guarded) return;
  for (const name of names) {
    if (isGuardedVariable(name)) block('parse', `setting ${name} together with git/gh/pnpm is blocked`);
  }
}

function checkCommandWord(w) {
  if (w.hasVar) block('parse', `a variable or substitution in command position is blocked: ${w.text}`);
  if (w.glob && !w.quoted) block('parse', `a glob in command position is blocked: ${w.text}`);
  if (w.brace) block('parse', `brace expansion in command position is blocked: ${w.text}`);
}

/** Skips a wrapper's own options. Returns the index of the wrapped command (or words.length). */
const WRAPPERS = {
  command(ws, k) {
    while (k < ws.length && ws[k].text.startsWith('-')) {
      if (/^-[pvV]+$/.test(ws[k].text)) {
        if (/[vV]/.test(ws[k].text)) return ws.length; // command -v: a lookup, runs nothing
        k++;
      } else return -1;
    }
    return k;
  },
  builtin: (ws, k) => k,
  nohup: (ws, k) => k,
  chronic: (ws, k) => k,
  unbuffer: (ws, k) => k,
  time(ws, k) {
    while (k < ws.length && /^-[p]$|^--portability$/.test(ws[k].text)) k++;
    return k;
  },
  nice(ws, k) {
    while (k < ws.length && ws[k].text.startsWith('-')) {
      const t = ws[k].text;
      if (t === '-n') k += 2;
      else if (/^-\d+$|^-n\d+$|^--adjustment=/.test(t)) k++;
      else return -1;
    }
    return k;
  },
  exec(ws, k) {
    while (k < ws.length && ws[k].text.startsWith('-')) {
      const t = ws[k].text;
      if (t === '-a') k += 2;
      else if (/^-[cl]+$/.test(t)) k++;
      else return -1;
    }
    return k;
  },
  timeout(ws, k) {
    while (k < ws.length && ws[k].text.startsWith('-')) {
      const t = ws[k].text;
      if (t === '-s' || t === '-k') k += 2;
      else if (/^(--signal=|--kill-after=|--foreground$|--preserve-status$|-v$|--verbose$)/.test(t)) k++;
      else return -1;
    }
    return k + 1; // the duration
  },
  stdbuf(ws, k) {
    while (k < ws.length && ws[k].text.startsWith('-')) {
      const t = ws[k].text;
      if (/^-[ioe]$/.test(t)) k += 2;
      else if (/^(-[ioe].+|--(input|output|error)=)/.test(t)) k++;
      else return -1;
    }
    return k;
  },
  caffeinate(ws, k) {
    while (k < ws.length && ws[k].text.startsWith('-')) {
      const t = ws[k].text;
      if (t === '-t' || t === '-w') k += 2;
      else if (/^-[dimsu]+$/.test(t)) k++;
      else return -1;
    }
    return k;
  },
};

/** Evaluates one segment (a simple command) and updates st.cwds. */
function checkWords(ws, st) {
  let k = 0;
  while (k < ws.length && !ws[k].quoted && KEYWORDS.has(ws[k].text)) k++;
  const assigned = [];
  while (k < ws.length && isAssignment(ws[k])) assigned.push(assignmentName(ws[k].text)), k++;
  checkAssignments(assigned, st);
  for (;;) {
    if (k >= ws.length) return;
    const w = ws[k];
    checkCommandWord(w);
    const name = basename(w.text);
    if (['sudo', 'doas', 'su', 'pkexec', 'run0'].includes(name)) block('parse', `${name} is blocked`);
    if (name === 'env') {
      k++;
      while (k < ws.length) {
        const t = ws[k].text;
        if (t === '-u' || t === '--unset') k += 2;
        else if (t === '-C' || t === '--chdir') {
          st.cwds = st.cwds.map((c) => (c === null || ws[k + 1] === undefined || ws[k + 1].hasVar ? null : resolve(c, ws[k + 1].text)));
          k += 2;
        } else if (t === '-S' || t.startsWith('--split-string') || /^-[a-zA-Z]*S/.test(t)) {
          if (st.guarded) block('parse', 'env -S (split string) together with git/gh/pnpm is blocked');
          return;
        } else if (/^(-i|-0|--null|--ignore-environment|-|--unset=.*|--chdir=.*|-v|--debug)$/.test(t)) k++;
        else if (t === '--') k++;
        else if (isAssignment(ws[k])) {
          checkAssignments([assignmentName(t)], st);
          k++;
        } else if (t.startsWith('-')) {
          if (st.guarded) block('parse', `unknown env option ${t}`);
          return;
        } else break;
      }
      continue;
    }
    const wrapper = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : undefined;
    if (wrapper === undefined) break;
    const next = wrapper(ws, k + 1);
    if (next === -1) {
      if (st.guarded) block('parse', `unrecognised ${name} options; run the command without the wrapper`);
      return;
    }
    k = next;
  }
  const cmd = basename(ws[k].text);
  const args = ws.slice(k + 1);
  switch (cmd) {
    case 'git':
      return checkGit(args, st);
    case 'gh':
      return checkGh(args, st);
    case 'pnpm':
    case 'npm':
    case 'npx':
    case 'pnpx':
    case 'turbo':
      return checkPackageManager(cmd, args, st);
    case 'hub':
      return block('parse', 'hub is blocked; use gh');
    case 'cd':
    case 'pushd': {
      const target = args.find((a) => !a.text.startsWith('-') || a.text === '-');
      st.cwds = [
        ...st.cwds,
        ...st.cwds.map((c) => {
          if (c === null || (target !== undefined && (target.hasVar || target.text === '-'))) return null;
          return resolve(c, target === undefined ? homedir() : target.text.replace(/^~(?=$|\/)/, homedir()));
        }),
      ];
      return;
    }
    case 'popd':
      st.cwds = [...st.cwds, null];
      return;
    case 'export':
    case 'declare':
    case 'typeset':
    case 'local':
    case 'readonly':
      // Like VAR=x, but whether or not the command mentions git: an export can outlive this
      // command (SEC-F001-31).
      checkAssignments(args.filter(isAssignment).map((a) => assignmentName(a.text)), { guarded: true });
      return;
    case 'source':
    case '.':
      // A sourced file can set any variable, including GIT_* (SEC-F001-31).
      if (st.guarded) block('parse', `${cmd} together with git/gh/pnpm is blocked`);
      return;
    case 'eval':
    case 'xargs':
    case 'parallel':
      if (st.guarded) block('parse', `${cmd} together with git/gh/pnpm is blocked`);
      return;
    default:
      break;
  }
  if (INTERPRETERS.has(cmd)) {
    // Inline code that could assemble a git/gh call at run time ("g"+"it"), whether or not the
    // command line mentions git (SEC-F001-31).
    const inline = args.findIndex((a) => INLINE_CODE_FLAG.test(a.text));
    if (inline !== -1 && args.slice(inline).some((a) => INLINE_CODE_WORDS.test(a.text))) {
      block('parse', `${cmd} inline code that mentions git, gh, push, merge or release is blocked; put it in a script file and run that`);
    }
  }
  if (!st.guarded) return;
  if (SHELLS.has(cmd)) {
    block('parse', `${cmd} together with git/gh/pnpm is blocked; run the git/gh/pnpm command directly`);
  }
  if (INTERPRETERS.has(cmd)) {
    const inline = args.some((a) => /^(-[a-zA-Z]*[ecpE]|--eval|--print|--input-type|--command)/.test(a.text));
    const positional = args.some((a) => !a.text.startsWith('-'));
    if (inline || !positional) block('parse', `${cmd} with inline code or stdin, together with git/gh/pnpm, is blocked`);
  }
  if (!DATA_ONLY.has(cmd) && args.some((a) => GUARDED_SET.has(basename(a.text)) || MENTION_AS_COMMAND.test(a.text))) {
    block('parse', `${cmd} is given a git/gh/pnpm command as an argument; run that command directly`);
  }
}

// ---------------------------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------------------------

const GIT_SAFE_GLOBALS = new Set([
  '--no-pager', '-P', '-p', '--paginate', '--no-replace-objects', '--literal-pathspecs',
  '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks',
  '--no-advice', '--no-lazy-fetch',
]);
const GIT_BLOCKED_GLOBALS = /^(-c.*|--config-env(=.*)?|--git-dir(=.*)?|--work-tree(=.*)?|--exec-path(=.*)?|--namespace(=.*)?|--super-prefix(=.*)?|--attr-source(=.*)?|--bare|--list-cmds(=.*)?)$/;
const GIT_BUILTINS = new Set(`add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file check-attr
check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column
commit commit-graph commit-tree config count-objects credential credential-cache credential-store describe diagnose
diff diff-files diff-index diff-pairs diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch
fmt-merge-msg for-each-ref for-each-repo format-patch fsck gc get-tar-commit-id grep gui hash-object help hook
http-push index-pack init instaweb interpret-trailers last-modified log ls-files ls-remote ls-tree maintenance merge
merge-base merge-file merge-index merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects
pack-refs patch-id prune prune-packed pull push range-diff read-tree rebase reflog refs remote repack replace replay
repo rerere reset restore rev-list rev-parse revert rm send-email send-pack shortlog show show-branch show-index
show-ref sparse-checkout stash status stripspace submodule switch symbolic-ref tag unpack-file unpack-objects
update-index update-ref update-server-info var verify-commit verify-pack verify-tag version whatchanged worktree
write-tree`.split(/\s+/));
/** Subcommands whose arguments can run commands (--exec, foreach, run, --upload-pack, -x). */
const GIT_RUNS_COMMANDS = new Set([
  'submodule', 'rebase', 'bisect', 'filter-branch', 'difftool', 'mergetool', 'send-email', 'fetch',
  'pull', 'clone', 'ls-remote', 'archive', 'for-each-repo', 'hook', 'am', 'worktree',
]);

function checkGit(args, st) {
  let cwds = st.cwds;
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    const t = a.text;
    if (t === '-C') {
      const dir = args[i + 1];
      if (dir === undefined) block('parse', 'git -C needs a directory');
      cwds = cwds.map((c) => (c === null || dir.hasVar ? null : resolve(c, dir.text.replace(/^~(?=$|\/)/, homedir()))));
      i += 2;
      continue;
    }
    if (GIT_BLOCKED_GLOBALS.test(t)) block('parse', `git ${t.split('=')[0]} is blocked (it changes which config, repository or commands git uses)`);
    if (GIT_SAFE_GLOBALS.has(t)) {
      i++;
      continue;
    }
    if (['--version', '--help', '-h', '-v', '--html-path', '--man-path', '--info-path'].includes(t)) return;
    if (t.startsWith('-')) block('parse', `unknown git global option ${t}`);
    break;
  }
  if (i >= args.length) return;
  const subWord = args[i];
  if (subWord.hasVar || subWord.glob) block('parse', `git subcommand ${subWord.text} isn't a literal`);
  const sub = subWord.text;
  const rest = args.slice(i + 1);
  if (GIT_RUNS_COMMANDS.has(sub) && rest.some((a) => MENTION_AS_COMMAND.test(a.text) || GUARDED_SET.has(basename(a.text)))) {
    block('parse', `git ${sub} is given a git/gh/pnpm command to run; run it directly`);
  }
  switch (sub) {
    case 'push':
      return checkPush(rest, cwds, st);
    case 'commit':
      return checkCommit(rest, cwds, st);
    case 'diff':
    case 'log':
    case 'show':
    case 'whatchanged':
    case 'diff-tree':
    case 'diff-index':
    case 'diff-files':
    case 'range-diff':
    case 'format-patch':
      return checkDiffLike(sub, rest);
    case 'config':
      return checkConfig(rest);
    case 'remote': {
      const verb = rest.find((a) => !a.text.startsWith('-'));
      if (verb !== undefined && ['add', 'set-url', 'rename'].includes(verb.text)) {
        block('G-9', `git remote ${verb.text} is blocked (pushes go only to origin)`);
      }
      return;
    }
    case 'send-pack':
    case 'http-push':
      return block('G-9', `git ${sub} is blocked`);
    case 'tag':
      return checkTag(rest);
    default:
      if (sub.startsWith('credential')) block('G-9', `git ${sub} is blocked`);
      if (!GIT_BUILTINS.has(sub)) checkAlias(sub, cwds, st);
  }
}

function checkAlias(sub, cwds, st) {
  const dirs = new Set([...cwds, st.initialCwd].filter(isDir));
  if (dirs.size === 0) dirs.add(ROOT);
  for (const dir of dirs) {
    if (configGet(dir, `alias.${sub}`) !== null) block('parse', `git ${sub} is an alias; run the git command it stands for`);
  }
}

// G-8: diff, log and show must not write files or run external programs.
function checkDiffLike(sub, rest) {
  for (const a of rest) {
    const t = a.text;
    if (t === '--') break;
    if (/^--output(=|$)/.test(t)) block('G-8', `git ${sub} --output is blocked (it writes files)`);
    if (t === '--ext-diff') block('G-8', `git ${sub} --ext-diff is blocked (it runs an external program)`);
    if (t === '--textconv') block('G-8', `git ${sub} --textconv is blocked (it runs an external program)`);
  }
}

function checkTag(rest) {
  for (const a of rest) {
    const t = a.text;
    if (t === '--') break;
    if (t === '--force') block('G-5', 'git tag --force is blocked (release tags are never moved)');
    if (/^-[a-zA-Z]+$/.test(t)) {
      for (const ch of t.slice(1)) {
        if (ch === 'f') block('G-5', 'git tag -f is blocked (release tags are never moved)');
        if ('mFu'.includes(ch)) break;
      }
    }
  }
}

// G-9: config writes that change remotes, aliases, hooks, pagers, credentials or includes.
const CONFIG_VALUE_OPTS = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value']);
const CONFIG_READ_FLAGS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '-l', '--list']);
const CONFIG_FLAGS = new Set([
  '--global', '--system', '--local', '--worktree', '--bool', '--int', '--bool-or-int', '--path',
  '--expiry-date', '--fixed-value', '--show-origin', '--show-scope', '--name-only', '--null', '-z',
  '--includes', '--no-includes', '--all', '--regexp', '--no-type',
]);
const CONFIG_WRITE_OPS = new Set(['--add', '--replace-all', '--unset', '--unset-all', '--rename-section', '--remove-section']);
const PROTECTED_SECTIONS = new Set(['alias', 'remote', 'url', 'credential', 'push', 'include', 'includeif']);

function checkConfig(rest) {
  let read = false;
  let op = null;
  const pos = [];
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j].text;
    const name = t.split('=')[0];
    if (t === '-e' || t === '--edit') block('G-9', 'git config --edit is blocked');
    if (CONFIG_READ_FLAGS.has(t)) read = true;
    else if (CONFIG_WRITE_OPS.has(t)) op = t;
    else if (CONFIG_FLAGS.has(t)) continue;
    else if (CONFIG_VALUE_OPTS.has(name)) {
      if (!t.includes('=')) j++;
    } else if (t.startsWith('-')) block('parse', `unknown git config option ${t}`);
    else pos.push(rest[j]);
  }
  const verb = pos[0]?.text;
  if (['get', 'list'].includes(verb)) return;
  if (verb === 'edit') block('G-9', 'git config edit is blocked');
  if (verb === 'set') return checkConfigKey(pos[1]?.text ?? '', pos[2]?.text, 'set');
  if (verb === 'unset') return checkConfigKey(pos[1]?.text ?? '', undefined, 'unset');
  if (verb === 'rename-section' || verb === 'remove-section') return checkConfigSections(pos.slice(1));
  if (read) return;
  if (op === '--rename-section' || op === '--remove-section') return checkConfigSections(pos);
  if (op === '--unset' || op === '--unset-all') return checkConfigKey(pos[0]?.text ?? '', undefined, 'unset');
  if (op !== null || pos.length >= 2) return checkConfigKey(pos[0]?.text ?? '', pos[1]?.text, op ?? 'set');
}

function checkConfigSections(words) {
  for (const w of words) {
    const section = w.text.toLowerCase().split('.')[0];
    if (PROTECTED_SECTIONS.has(section) || ['core', 'diff', 'branch'].includes(section)) {
      block('G-9', `renaming or removing the git config section ${w.text} is blocked`);
    }
  }
}

function checkConfigKey(key, value, op) {
  const lower = key.toLowerCase();
  const parts = lower.split('.');
  const section = parts[0];
  const last = parts.at(-1);
  const hasSub = parts.length > 2;
  const deny = () => block('G-9', `writing git config ${key} is blocked (design §6.3.3 G-9)`);
  if (PROTECTED_SECTIONS.has(section)) deny();
  if (section === 'core') {
    if (last === 'hookspath' && !(op === 'set' && value === '.githooks')) deny();
    if (['sshcommand', 'pager'].includes(last)) deny();
  }
  if (section === 'diff' && ((!hasSub && last === 'external') || (hasSub && ['command', 'textconv'].includes(last)))) deny();
  if (section === 'branch' && hasSub && ['remote', 'pushremote'].includes(last)) deny();
}

// G-7 (T15 part): commits may not skip hooks.
const COMMIT_VALUE_LONG = new Set([
  '--message', '--file', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--author',
  '--date', '--template', '--cleanup', '--trailer', '--pathspec-from-file',
]);

function checkCommit(rest, cwds, st) {
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j].text;
    if (t === '--') break;
    if (t === '--no-verify') block('G-7', 'git commit --no-verify is blocked');
    if (t.startsWith('--')) {
      if (COMMIT_VALUE_LONG.has(t)) j++;
      continue;
    }
    if (/^-[a-zA-Z]/.test(t)) {
      for (let x = 1; x < t.length; x++) {
        const ch = t[x];
        if (ch === 'n') block('G-7', 'git commit -n (no-verify) is blocked');
        if ('mFCct'.includes(ch)) {
          if (x === t.length - 1) j++;
          break;
        }
        if ('uS'.includes(ch)) break;
      }
    }
  }
  st.commits.push({ cwds, segmentIndex: st.segmentIndex });
}

// G-1 to G-5: pushes.
const TAG_REFSPEC = /^refs\/tags\/(v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))(-rc\.(0|[1-9]\d*))?$/;
const PUSH_FLAGS = new Set([
  '--set-upstream', '--verbose', '--quiet', '--progress', '--no-progress', '--dry-run', '--porcelain',
  '--atomic', '--no-atomic', '--no-signed', '--thin', '--no-thin', '--ipv4', '--ipv6', '--verify',
  '--no-force-with-lease', '--no-recurse-submodules', '--no-follow-tags',
]);

function checkPush(rest, cwds, st) {
  let endOfOptions = false;
  const pos = [];
  for (let j = 0; j < rest.length; j++) {
    const w = rest[j];
    const t = w.text;
    if (endOfOptions || !t.startsWith('-') || t === '-') {
      pos.push(w);
      continue;
    }
    if (t === '--') {
      endOfOptions = true;
      continue;
    }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq === -1 ? t : t.slice(0, eq);
      const value = eq === -1 ? undefined : t.slice(eq + 1);
      if (['--force', '--force-with-lease', '--force-if-includes', '--mirror', '--all', '--branches', '--prune'].includes(name)) {
        block('G-1', `git push ${name} is blocked (no force, mirror, all or prune pushes)`);
      }
      if (name === '--delete') block('G-3', 'git push --delete is blocked (remote branches are deleted only by gh pr merge --delete-branch)');
      if (['--tags', '--follow-tags'].includes(name)) block('G-4', `git push ${name} is blocked; push one release tag as refs/tags/vX.Y.Z`);
      if (name === '--no-verify') block('G-4', 'git push --no-verify is blocked');
      // SEC-F001-31: no remote override, no remote-side program, no push options.
      if (['--repo', '--receive-pack', '--exec', '--push-option'].includes(name)) block('G-4', `git push ${name} is blocked`);
      if (name === '--recurse-submodules') {
        if (!['check', 'no'].includes(value ?? '')) block('G-4', 'git push --recurse-submodules is allowed only as =check or =no');
        continue;
      }
      if (name === '--signed' || PUSH_FLAGS.has(name)) continue;
      block('parse', `unknown git push option ${t}`);
    }
    for (let x = 1; x < t.length; x++) {
      const ch = t[x];
      if (ch === 'f') block('G-1', `git push ${t} is blocked (force)`);
      if (ch === 'd') block('G-3', `git push ${t} is blocked (delete)`);
      if ('uvqn46'.includes(ch)) continue;
      if (ch === 'o') block('G-4', 'git push -o (push options) is blocked');
      block('parse', `unknown git push option ${t}`);
    }
  }
  const remoteWord = pos[0];
  const refspecs = pos.slice(1);
  if (remoteWord !== undefined) {
    if (remoteWord.hasVar) block('parse', 'the push remote must be a literal');
    if (remoteWord.text !== 'origin') block('G-4', `git push only to the remote "origin" (got "${remoteWord.text}")`);
  }

  // Static refspec checks: no state needed.
  const tagRefspecs = [];
  let needsHead = false;
  const branchSources = [];
  for (const r of refspecs) {
    const s = r.text;
    if (r.hasVar || r.glob) block('parse', `refspec ${s} isn't a literal`);
    if (s.startsWith('+')) block('G-1', `refspec ${s} forces the update`);
    if (s === ':') block('G-1', 'the matching refspec ":" pushes every branch');
    if (s.startsWith(':')) block('G-3', `refspec ${s} deletes a remote ref`);
    if (s.includes('*')) block('G-4', `wildcard refspec ${s} is blocked`);
    const colon = s.indexOf(':');
    const src = colon === -1 ? s : s.slice(0, colon);
    const dst = colon === -1 ? null : s.slice(colon + 1);
    if (src.startsWith('refs/tags/') || src.startsWith('tags/') || (dst !== null && dst.startsWith('refs/tags/'))) {
      tagRefspecs.push(r);
      continue;
    }
    if (/^v\d+\.\d+\.\d+/.test(src)) block('G-5', `push a release tag as refs/tags/${src}, never as a bare name`);
    for (const ref of dst === null ? [src] : [dst]) {
      if (ref.startsWith('refs/') && !ref.startsWith('refs/heads/')) block('G-4', `only branches and release tags may be pushed (got ${ref})`);
      const short = ref.replace(/^refs\/heads\//, '');
      if (short === 'main') block('G-2', 'pushes to main are blocked; open a PR');
      if (dst !== null && (short === 'HEAD' || short === '@')) block('G-2', `destination ${ref} is ambiguous`);
    }
    if (dst === null && (src === 'HEAD' || src === '@')) needsHead = true;
    branchSources.push(src);
  }
  if (tagRefspecs.length > 0) {
    if (refspecs.length !== 1) block('G-5', 'push a release tag on its own, as the only refspec');
    const s = tagRefspecs[0].text;
    if (!TAG_REFSPEC.test(s)) block('G-5', `only refs/tags/vX.Y.Z[-rc.N] may be pushed (got ${s})`);
  }

  // State checks.
  const dirs = existingDirs(cwds, 'G-2', 'git push');
  for (const dir of dirs) {
    for (const src of branchSources) {
      if (src === 'HEAD' || src === '@') continue;
      const name = src.replace(/^refs\/heads\//, '');
      if (git(dir, ['show-ref', '--verify', '--quiet', `refs/tags/${name}`]).status === 0) {
        block('G-5', `"${src}" is a tag; push a release tag as refs/tags/${name}`);
      }
    }
    if (needsHead || refspecs.length === 0) {
      const head = git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      if (head.status !== 0) block('G-2', 'HEAD is detached; name the branch to push');
      const branch = head.stdout.trim();
      if (branch === 'main') block('G-2', 'you are on main; pushes to main are blocked');
      if (refspecs.length === 0) checkImplicitPush(dir, branch, remoteWord === undefined);
    }
    if (tagRefspecs.length > 0) checkTagPush(dir, tagRefspecs[0].text);
    st.pushes.push({
      dir,
      sources: tagRefspecs.length > 0 ? [tagRefspecs[0].text] : branchSources.length > 0 ? branchSources : ['HEAD'],
    });
  }
}

/** G-2: `git push` / `git push origin` with no refspec — where would it go? */
function checkImplicitPush(dir, branch, remoteImplicit) {
  const pushDefault = configGet(dir, 'push.default');
  if (pushDefault !== null && !['simple', 'current', 'upstream'].includes(pushDefault)) {
    block('G-2', `push.default=${pushDefault} can push other branches; name the branch to push`);
  }
  if (configGet(dir, 'remote.origin.push') !== null) block('G-2', 'remote.origin.push is configured; name the branch to push');
  if (remoteImplicit) {
    const remote =
      configGet(dir, `branch.${branch}.pushRemote`) ??
      configGet(dir, 'remote.pushDefault') ??
      configGet(dir, `branch.${branch}.remote`) ??
      'origin';
    if (remote !== 'origin') block('G-4', `this branch pushes to the remote "${remote}"; only origin is allowed`);
  }
  const merge = configGet(dir, `branch.${branch}.merge`);
  if (merge !== null && merge.replace(/^refs\/heads\//, '') === 'main' && pushDefault !== 'current') {
    block('G-2', `${branch} tracks main, so a bare push would update main; push with an explicit branch name`);
  }
}

/** G-5: an annotated tag on origin/main, with its release record, that origin doesn't have yet. */
function checkTagPush(dir, refspec) {
  const tag = refspec.slice('refs/tags/'.length);
  const remote = git(dir, ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]);
  if (remote.status !== 0) block('G-5', `can't check origin for ${tag}: ${remote.stderr.trim()}`);
  if (remote.stdout.trim() !== '') block('G-5', `${tag} already exists on origin; tags are never overwritten`);
  checkTagState(dir, tag);
}

/** G-5 state: the local tag is annotated, on freshly fetched origin/main, with its release record. */
function checkTagState(dir, tag) {
  const release = tag.replace(/-rc\.\d+$/, '');
  const type = git(dir, ['cat-file', '-t', `refs/tags/${tag}`]);
  if (type.status !== 0) block('G-5', `there is no local tag ${tag}`);
  if (type.stdout.trim() !== 'tag') block('G-5', `${tag} is a lightweight tag; release tags must be annotated (git tag -a)`);
  const fetch = git(dir, ['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  if (fetch.status !== 0) block('G-5', `can't fetch origin/main: ${fetch.stderr.trim()}`);
  const commit = git(dir, ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]);
  if (commit.status !== 0) block('G-5', `can't resolve the commit of ${tag}`);
  const sha = commit.stdout.trim();
  const ancestor = git(dir, ['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main']);
  if (ancestor.status !== 0) block('G-5', `${tag} points at ${sha.slice(0, 12)}, which isn't on origin/main`);
  // The release record is named for the version without -rc.N (docs/releases/README.md).
  if (git(dir, ['cat-file', '-e', `${sha}:docs/releases/${release}.md`]).status !== 0) {
    block('G-5', `docs/releases/${release}.md doesn't exist at ${tag}; the release record comes first`);
  }
}

// ---------------------------------------------------------------------------------------------
// gh
// ---------------------------------------------------------------------------------------------

/**
 * The gh commands agents may run (SEC-F001-28): an allow-list, so a new or unfamiliar gh
 * command is blocked rather than trusted. `pr merge` goes through H-2, `api` through H-3 and
 * `release create` through the release check.
 */
const GH_ALLOWED = {
  pr: ['create', 'view', 'list', 'diff', 'checks', 'comment', 'merge'],
  issue: ['list', 'view', 'create', 'comment'],
  run: ['list', 'view', 'watch'],
  auth: ['status'],
  repo: ['view'],
  release: ['view', 'list', 'create'],
};

/**
 * Human-merge paths (design §6.3.5; SEC-F001-30): an agent must not merge a change to its own
 * permissions and hooks, to the merge gate's inputs, or to the release workflow.
 */
export function isHumanMergePath(path) {
  return (
    path.startsWith('.claude/') ||
    path === 'CLAUDE.md' ||
    path.endsWith('/CLAUDE.md') ||
    ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].includes(path) ||
    path === '.github/required-checks.json' ||
    path === '.github/workflows/release.yml' ||
    path.startsWith('.githooks/') ||
    path.startsWith('tooling/repo-scripts/bin/')
  );
}

function valueOf(args, j, short, long) {
  const t = args[j].text;
  if (t === short || t === long) return { value: args[j + 1]?.text, skip: 1 };
  if (long !== null && t.startsWith(`${long}=`)) return { value: t.slice(long.length + 1), skip: 0 };
  if (short !== null && t.startsWith(short) && t.length > short.length) return { value: t.slice(short.length), skip: 0 };
  return null;
}

function checkGh(args, st) {
  if (args.length === 0) return;
  const first = args[0].text;
  if (first.startsWith('-')) {
    if (['--version', '--help', '-h'].includes(first)) return;
    block('parse', `unknown gh option ${first}`);
  }
  const second = args[1]?.text;
  if (first !== 'api') {
    const verbs = Object.hasOwn(GH_ALLOWED, first) ? GH_ALLOWED[first] : [];
    if (!verbs.includes(second)) {
      block('H-4', `gh ${first}${second === undefined ? '' : ` ${second}`} is not on the allow-list (SEC-F001-28). Allowed: gh pr create|view|list|diff|checks|comment|merge, gh issue list|view|create|comment, gh run list|view|watch, gh api (GET), gh auth status, gh repo view, gh release view|list|create --verify-tag`);
    }
  }
  checkGhRepoFlag(args, st);
  if (first === 'api') return checkGhApi(args.slice(1));
  if (first === 'pr' && second === 'merge') return checkMerge(args.slice(2), st);
  if (first === 'release' && second === 'create') return checkReleaseCreate(args.slice(2), st);
}

/** H-1: -R/--repo must name this repository. */
function checkGhRepoFlag(args, st) {
  for (let j = 0; j < args.length; j++) {
    const v = valueOf(args, j, '-R', '--repo');
    if (v === null) continue;
    if (v.value === undefined) block('H-1', '-R/--repo needs a value');
    const dirs = [...new Set([...st.cwds, st.initialCwd, ROOT].filter(isDir))];
    let origin = null;
    for (const dir of dirs) {
      const r = git(dir, ['remote', 'get-url', 'origin']);
      if (r.status === 0) {
        origin = repoSlug(r.stdout);
        break;
      }
    }
    if (origin === null) block('H-1', "can't read origin's URL to check -R/--repo");
    if (repoSlug(v.value) !== origin) block('H-1', `-R/--repo must name this repository (${origin}), not ${v.value}`);
    j += v.skip;
  }
}

// H-3: gh api only reads.
function checkGhApi(args) {
  let method = 'GET';
  let endpoint = null;
  for (let j = 0; j < args.length; j++) {
    const t = args[j].text;
    let v;
    if ((v = valueOf(args, j, '-X', '--method'))) {
      method = (v.value ?? '').toUpperCase();
      j += v.skip;
    } else if (/^(-f|-F|--field|--raw-field|--input)(=|$)/.test(t) || /^-[fF].+/.test(t)) {
      block('H-3', `gh api ${t.startsWith('--') ? t.split('=')[0] : t.slice(0, 2)} sends a request body; gh api is read-only`);
    } else if ((v = valueOf(args, j, '-H', '--header'))) {
      if (/x-http-method-override/i.test(v.value ?? '')) block('H-3', 'gh api with a method-override header is blocked');
      j += v.skip;
    } else if ((v = valueOf(args, j, '-q', '--jq') ?? valueOf(args, j, '-t', '--template') ?? valueOf(args, j, '-p', '--preview') ?? valueOf(args, j, null, '--hostname') ?? valueOf(args, j, null, '--cache'))) {
      j += v.skip;
    } else if (['--paginate', '--slurp', '-i', '--include', '--silent', '--verbose'].includes(t)) {
      continue;
    } else if (t.startsWith('-')) {
      block('parse', `unknown gh api option ${t}`);
    } else if (endpoint === null) {
      endpoint = t;
    } else {
      block('parse', `unexpected gh api argument ${t}`);
    }
  }
  if (method !== 'GET') block('H-3', `gh api -X ${method} is blocked; gh api is read-only`);
  if (endpoint !== null && /(^|\/)graphql$/i.test(endpoint)) block('H-3', 'gh api graphql is blocked (mutations)');
}

/**
 * gh release create: only `--verify-tag`, for a release tag that is already on origin and
 * passes the G-5 checks (annotated, on origin/main, release record present). SEC-F001-28.
 */
function checkReleaseCreate(args, st) {
  let tag = null;
  let verifyTag = false;
  for (let j = 0; j < args.length; j++) {
    const t = args[j].text;
    let v;
    if (t === '--verify-tag') verifyTag = true;
    else if (['--prerelease', '--latest', '--latest=true', '--latest=false', '--generate-notes'].includes(t)) continue;
    else if ((v = valueOf(args, j, '-t', '--title') ?? valueOf(args, j, '-n', '--notes') ?? valueOf(args, j, '-F', '--notes-file') ?? valueOf(args, j, '-R', '--repo') ?? valueOf(args, j, null, '--notes-start-tag'))) {
      j += v.skip;
    } else if (t.startsWith('-')) {
      block('H-4', `gh release create ${t.split('=')[0]} is not allowed (only --verify-tag, --title, --notes, --notes-file, --prerelease, --latest, --generate-notes)`);
    } else if (tag === null) tag = t;
    else block('H-4', 'gh release create uploads no assets from an agent');
  }
  if (!verifyTag) block('H-4', 'gh release create needs --verify-tag (the tag must already be on origin)');
  if (tag === null || !TAG_REFSPEC.test(`refs/tags/${tag}`)) block('H-4', `gh release create needs a release tag vX.Y.Z[-rc.N] (got ${tag})`);
  const [dir] = existingDirs([...st.cwds], 'G-5', 'gh release create');
  const remote = git(dir, ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]);
  if (remote.status !== 0) block('G-5', `can't check origin for ${tag}: ${remote.stderr.trim()}`);
  const remoteSha = remote.stdout.trim().split(/\s+/)[0] ?? '';
  if (remoteSha === '') block('G-5', `${tag} is not on origin yet; push it first (git push origin refs/tags/${tag})`);
  const local = git(dir, ['rev-parse', '--verify', `refs/tags/${tag}`]);
  if (local.status !== 0 || local.stdout.trim() !== remoteSha) block('G-5', `the local ${tag} differs from origin's`);
  checkTagState(dir, tag);
}

// H-2: the merge gate (D-2). Inputs come from GitHub (state, head, checks, comments) and from git
// (the changed files, and required-checks.json and CODEOWNERS as they are on origin/main), never
// from the working tree or the branch being merged (SEC-F001-29, -30).
function checkMerge(args, st) {
  let number = null;
  let squash = false;
  let sha = null;
  const repoArgs = [];
  for (let j = 0; j < args.length; j++) {
    const t = args[j].text;
    let v;
    if (t === '--squash' || t === '-s') squash = true;
    else if (t === '--delete-branch' || t === '-d') continue;
    else if ((v = valueOf(args, j, null, '--match-head-commit'))) {
      sha = v.value ?? null;
      j += v.skip;
    } else if ((v = valueOf(args, j, '-R', '--repo'))) {
      repoArgs.push('--repo', v.value ?? '');
      j += v.skip;
    } else if ((v = valueOf(args, j, '-t', '--subject') ?? valueOf(args, j, '-b', '--body') ?? valueOf(args, j, '-F', '--body-file'))) {
      j += v.skip;
    } else if (t.startsWith('-')) {
      block('H-2', `gh pr merge ${t} is not allowed; the only form is gh pr merge <number> --squash [--delete-branch] --match-head-commit <sha>`);
    } else if (number === null) number = t;
    else block('H-2', `unexpected gh pr merge argument ${t}`);
  }
  if (number === null || !/^\d+$/.test(number)) block('H-2', 'gh pr merge needs the PR number');
  if (!squash) block('H-2', 'gh pr merge must use --squash');
  if (sha === null || !/^[0-9a-f]{40}$/i.test(sha)) block('H-2', 'gh pr merge needs --match-head-commit <full head SHA>');
  const [cwd] = existingDirs([...st.cwds], 'H-2', 'gh pr merge');

  const view = run('gh', ['pr', 'view', number, ...repoArgs, '--json', 'state,isDraft,baseRefName,headRefName,headRefOid,changedFiles,comments'], cwd);
  const pr = parseJson(view.stdout);
  if (view.status !== 0 || pr === null || typeof pr !== 'object') block('H-2', `gh pr view ${number} failed: ${view.stderr.trim() || view.error?.message || 'no JSON'}`);
  if (pr.state !== 'OPEN' || pr.isDraft !== false) block('H-2', `PR #${number} is not open and ready (state ${pr.state}, draft ${pr.isDraft})`);
  if (pr.baseRefName !== 'main' || pr.headRefName === 'main') block('H-2', `PR #${number} must merge a feature branch into main`);
  if (typeof pr.headRefOid !== 'string' || pr.headRefOid.toLowerCase() !== sha.toLowerCase()) {
    block('H-2', `--match-head-commit ${sha.slice(0, 12)} is not the PR head (${String(pr.headRefOid).slice(0, 12)}); re-check CI and review for the new head`);
  }
  const head = pr.headRefOid.toLowerCase();

  // The changed files, from git (SEC-F001-29): gh's file list stops at 100 and names only the
  // new side of a rename.
  const fetchMain = git(cwd, ['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  if (fetchMain.status !== 0) block('H-2', `can't fetch origin/main: ${fetchMain.stderr.trim()}`);
  const fetchHead = git(cwd, ['fetch', '--quiet', '--no-tags', 'origin', `refs/pull/${number}/head`]);
  if (fetchHead.status !== 0) block('H-2', `can't fetch PR #${number}'s head: ${fetchHead.stderr.trim()}`);
  const fetched = git(cwd, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
  if (fetched.status !== 0 || fetched.stdout.trim().toLowerCase() !== head) {
    block('H-2', `PR #${number}'s head on origin (${fetched.stdout.trim().slice(0, 12)}) is not ${head.slice(0, 12)}`);
  }
  const range = `refs/remotes/origin/main...${head}`;
  const both = git(cwd, ['diff', '--name-only', '-z', '--no-renames', range]);
  const counted = git(cwd, ['diff', '--name-only', '-z', '-M', range]);
  if (both.status !== 0 || counted.status !== 0) block('H-2', `can't list PR #${number}'s files: ${both.stderr.trim() || counted.stderr.trim()}`);
  const paths = both.stdout.split('\0').filter(Boolean);
  const count = counted.stdout.split('\0').filter(Boolean).length;
  if (count !== pr.changedFiles) {
    block('H-2', `git lists ${count} changed files in PR #${number}, GitHub ${pr.changedFiles}; can't be sure of every path, so a human merges it`);
  }
  const human = paths.filter(isHumanMergePath);
  if (human.length > 0) {
    block('H-2', `PR #${number} touches ${human.slice(0, 3).join(', ')}: human merge required (an agent must not merge a change to its own permissions, hooks, the merge gate's inputs or the release workflow)`);
  }

  const checks = run('gh', ['pr', 'checks', number, ...repoArgs, '--json', 'name,state,bucket'], cwd);
  const list = parseJson(checks.stdout);
  if (!Array.isArray(list)) block('H-2', `gh pr checks ${number} failed: ${checks.stderr.trim() || 'no JSON'}`);
  if (list.length === 0) block('H-2', `PR #${number} has no checks`);
  for (const name of requiredChecksOnMain(cwd)) {
    const runs = list.filter((c) => c?.name === name);
    if (runs.length === 0) block('H-2', `required check "${name}" is missing on PR #${number}`);
    const bad = runs.find((c) => c.bucket !== 'pass');
    if (bad) block('H-2', `required check "${name}" is ${bad.bucket} on PR #${number}`);
  }
  const notDone = list.find((c) => !['pass', 'skipping'].includes(c?.bucket));
  if (notDone) block('H-2', `check "${notDone.name}" is ${notDone.bucket} on PR #${number}`);

  const owned = codeownersMatcher(showOnMain(cwd, '.github/CODEOWNERS'));
  const protectedPaths = paths.filter(owned);
  const marker = `code-reviewer: APPROVED head=${pr.headRefOid}`;
  const comments = Array.isArray(pr.comments) ? pr.comments : [];
  const approved = comments.some((c) => {
    const body = typeof c?.body === 'string' ? c.body : '';
    return body.includes(marker) && (protectedPaths.length === 0 || body.includes('protected-paths-reviewed'));
  });
  if (!approved) {
    block('H-2', `no "${marker}"${protectedPaths.length > 0 ? ' + "protected-paths-reviewed"' : ''} comment on PR #${number}; the code-reviewer agent must approve this head`);
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A file as it is on origin/main (fetched by the caller), or null if it doesn't exist there. */
function showOnMain(cwd, path) {
  const r = git(cwd, ['show', `refs/remotes/origin/main:${path}`]);
  return r.status === 0 ? r.stdout : null;
}

function requiredChecksOnMain(cwd) {
  const text = showOnMain(cwd, '.github/required-checks.json');
  const value = text === null ? null : parseJson(text);
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string' && v !== '')) {
    block('H-2', ".github/required-checks.json on origin/main is missing or isn't a non-empty array of check names");
  }
  return value;
}

/** A matcher for the paths a CODEOWNERS file lists (gitignore-style subset). */
function codeownersMatcher(text) {
  if (text === null) return () => false;
  const patterns = text
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/)[0]);
  const regexes = patterns.map((p) => {
    const anchored = p.startsWith('/') || p.slice(0, -1).includes('/');
    const dir = p.endsWith('/');
    const body = p.replace(/^\//, '').replace(/\/$/, '');
    const re = body
      .split('**')
      .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
      .join('.*');
    return new RegExp(`${anchored ? '^' : '(^|/)'}${re}${dir ? '/' : '(/|$)'}`);
  });
  return (file) => regexes.some((r) => r.test(file));
}

// ---------------------------------------------------------------------------------------------
// pnpm, npm, npx and Turbo
// ---------------------------------------------------------------------------------------------

const PM_VALUE_OPTS = new Set(['-C', '--dir', '--filter', '-F', '--filter-prod', '--workspace-dir', '--reporter', '--loglevel', '--prefix']);
/** The only binaries `pnpm exec` may run (SEC-F001-31); each is a pinned workspace devDependency. */
const EXEC_ALLOWED = new Set(['turbo', 'playwright', 'vitest', 'prettier', 'eslint']);

function checkPackageManager(cmd, args, st) {
  if (cmd === 'turbo') return checkTurbo(args);
  // P-3 (SEC-F001-31): npx, pnpx, pnpm dlx and npm exec fetch and run arbitrary packages.
  if (cmd === 'npx' || cmd === 'pnpx') block('P-3', `${cmd} is blocked; use pnpm exec <${[...EXEC_ALLOWED].join('|')}>`);
  const stop = args.findIndex((a) => a.text === '--');
  const tokens = stop === -1 ? args : args.slice(0, stop);
  if (tokens.some((a) => /^--dangerously-allow-all-builds(=|$)/.test(a.text))) block('P-1', '--dangerously-allow-all-builds is blocked');
  let k = 0;
  while (k < tokens.length && tokens[k].text.startsWith('-')) k += PM_VALUE_OPTS.has(tokens[k].text) ? 2 : 1;
  const sub = tokens[k]?.text;
  if (sub === 'dlx' || (cmd === 'npm' && (sub === 'exec' || sub === 'x'))) {
    block('P-3', `${cmd} ${sub} is blocked; use pnpm exec <${[...EXEC_ALLOWED].join('|')}>`);
  }
  if (sub === 'exec') {
    let j = k + 1;
    while (j < args.length && args[j].text.startsWith('-')) {
      const t = args[j].text;
      if (t === '--') {
        j++;
        break;
      }
      block('P-3', `pnpm exec ${t} is not allowed; the form is pnpm exec <${[...EXEC_ALLOWED].join('|')}> …`);
    }
    const bin = args[j];
    if (bin === undefined || bin.hasVar || !EXEC_ALLOWED.has(bin.text)) {
      block('P-3', `pnpm exec ${bin?.text ?? ''} is blocked; pnpm exec runs only ${[...EXEC_ALLOWED].join(', ')}`);
    }
    return checkWords(args.slice(j), st);
  }
  const positional = tokens.filter((a) => !a.text.startsWith('-')).map((a) => a.text);
  const verbs = cmd === 'npm' ? ['publish', 'login', 'adduser', 'token', 'approve-builds'] : ['publish', 'login', 'adduser', 'approve-builds'];
  for (const verb of verbs) {
    if (positional.includes(verb)) block('P-1', `${cmd} ${verb} is blocked`);
  }
  if (sub === 'set') block('P-1', `${cmd} set is blocked`);
  const config = positional.indexOf('config');
  if (config !== -1 && ['set', 'delete'].includes(positional[config + 1])) block('P-1', `${cmd} config ${positional[config + 1]} is blocked`);
  if (sub === 'turbo') return checkTurbo(tokens.slice(k + 1));
  if (tokens.some((a) => ['git', 'gh', 'hub', 'sudo'].includes(basename(a.text)))) {
    block('parse', `${cmd} is given a git/gh command as an argument; run it directly`);
  }
}

// P-2: no Turbo remote cache, tokens, teams or graph files.
function checkTurbo(args) {
  for (let j = 0; j < args.length; j++) {
    const t = args[j].text;
    const name = t.split('=')[0];
    if (['--api', '--token', '--team', '--graph', '--remote-only', '--remote-cache-read-only', '--login'].includes(name)) {
      block('P-2', `turbo ${name} is blocked (remote cache and tokens stay off; SEC-F001-12)`);
    }
    if (name === '--cache') {
      const value = t.includes('=') ? t.slice(t.indexOf('=') + 1) : (args[j + 1]?.text ?? '');
      if (value.includes('remote')) block('P-2', 'turbo --cache with a remote setting is blocked');
    }
    if (!t.startsWith('-') && ['login', 'link', 'unlink'].includes(t) && j === args.findIndex((a) => !a.text.startsWith('-'))) {
      block('P-2', `turbo ${t} is blocked (no remote cache)`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Checks that need the whole command (T17 adds the gitleaks scans here)
// ---------------------------------------------------------------------------------------------

function afterChecks(_st) {}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const payload = parseJson(input);
  if (payload === null || typeof payload !== 'object') {
    process.stderr.write('guard-bash [internal]: unreadable hook input; blocking\n');
    process.exit(2);
  }
  if (payload.tool_name !== 'Bash') process.exit(0);
  const command = payload.tool_input?.command;
  if (typeof command !== 'string') {
    process.stderr.write('guard-bash [internal]: no command in the hook input; blocking\n');
    process.exit(2);
  }
  const cwd = typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : process.cwd();
  const verdict = evaluate(command, { cwd });
  if (verdict.block) {
    process.stderr.write(`guard-bash blocked this command [${verdict.rule}]: ${verdict.reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

// Always the entry point: comparing import.meta.url with argv[1] would fail (and exit 0 without
// judging anything) whenever the hook is started through a symlinked path, such as macOS's
// /var -> /private/var or a symlinked $CLAUDE_PROJECT_DIR.
try {
  await main();
} catch (error) {
  // Claude Code treats exit codes other than 2 as "proceed", so a crash must still block.
  process.stderr.write(`guard-bash [internal]: ${error instanceof Error ? error.message : String(error)}; blocking\n`);
  process.exit(2);
}
