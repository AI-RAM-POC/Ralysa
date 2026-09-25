// check-integration-scope (F-002 design §8.1, PR #18 review): integration tests must skip cleanly
// without a dev stack. `const stack = await devStackOrSkip()` is undefined then, and
// `describe.skipIf(stack === undefined)` still runs the describe callback at collection time, so a
// `stack` read directly in that callback (not inside a hook, test or helper function) crashes the
// run instead of skipping it. This check finds such reads in every test/integration/**/*.int.ts.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { type Finding, listRepoFiles } from './lib/repo.ts';

export interface CheckIntegrationScopeOptions {
  root: string;
  /** Override the file list (tests). Paths are relative to `root`. */
  files?: string[];
}

const RULE = 'integration/stack-at-collection';

export function isIntegrationTestFile(path: string): boolean {
  return /(^|\/)test\/integration\/.+\.int\.ts$/.test(path);
}

function unwrapAwait(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** Names bound at module scope to the result of devStackOrSkip(). */
function stackBindings(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (decl.initializer === undefined || !ts.isIdentifier(decl.name)) continue;
      const init = unwrapAwait(decl.initializer);
      if (
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === 'devStackOrSkip'
      ) {
        names.add(decl.name.text);
      }
    }
  }
  return names;
}

/** The identifier at the root of a callee chain: describe.skipIf(x) → describe. */
function calleeRoot(expression: ts.Expression): string | undefined {
  let current = expression;
  for (;;) {
    if (ts.isIdentifier(current)) return current.text;
    if (ts.isPropertyAccessExpression(current)) current = current.expression;
    else if (ts.isCallExpression(current)) current = current.expression;
    else return undefined;
  }
}

function isDescribeCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && calleeRoot(node.expression) === 'describe';
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)
  );
}

export function checkIntegrationScopeSource(path: string, text: string): Finding[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = stackBindings(source);
  if (names.size === 0) return [];
  const findings: Finding[] = [];
  const report = (node: ts.Identifier): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({
      rule: RULE,
      path: `${path}:${String(line + 1)}`,
      message: `\`${node.text}\` (from devStackOrSkip) is read while the describe block is collected, which crashes the run when the dev stack is absent; read it only inside beforeAll/afterAll, a test or a helper function`,
    });
  };

  // Collection-time code: the body of a describe callback, minus nested functions (hooks, tests
  // and helpers run later, and only when the suite is not skipped), plus nested describe bodies.
  const visitCollection = (node: ts.Node): void => {
    if (isDescribeCall(node)) {
      visitDescribe(node);
      return;
    }
    if (isFunctionLike(node) || ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node) && names.has(node.text)) {
      const parent = node.parent;
      const isMemberName = ts.isPropertyAccessExpression(parent) && parent.name === node;
      if (!isMemberName) report(node);
      return;
    }
    ts.forEachChild(node, visitCollection);
  };

  // In the describe callee chain (describe.skipIf(…), describe.each(…)) the arguments run at
  // collection too. The skip condition legitimately compares the binding, so only a dereference
  // (`stack!`, `stack.x`, `stack[x]`, `...stack`) is flagged there.
  const isDereference = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    return (
      ts.isNonNullExpression(parent) ||
      (ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        parent.questionDotToken === undefined) ||
      (ts.isElementAccessExpression(parent) &&
        parent.expression === node &&
        parent.questionDotToken === undefined) ||
      ts.isSpreadElement(parent) ||
      ts.isSpreadAssignment(parent)
    );
  };
  const visitCalleeArgs = (node: ts.Node): void => {
    if (isFunctionLike(node) || ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node) && names.has(node.text) && isDereference(node)) {
      report(node);
      return;
    }
    ts.forEachChild(node, visitCalleeArgs);
  };

  const visitDescribe = (call: ts.CallExpression): void => {
    let callee: ts.Expression = call.expression;
    while (ts.isCallExpression(callee) || ts.isPropertyAccessExpression(callee)) {
      if (ts.isCallExpression(callee)) {
        for (const arg of callee.arguments) visitCalleeArgs(arg);
      }
      callee = callee.expression;
    }
    for (const arg of call.arguments) {
      if (isFunctionLike(arg)) {
        ts.forEachChild(arg.body, visitCollection);
      } else {
        visitCollection(arg);
      }
    }
  };

  // Top-level describe calls only; the skip condition in the callee (skipIf(stack === undefined))
  // is where the binding belongs.
  const visitTop = (node: ts.Node): void => {
    if (isDescribeCall(node)) {
      visitDescribe(node);
      return;
    }
    if (isFunctionLike(node)) return;
    ts.forEachChild(node, visitTop);
  };
  ts.forEachChild(source, visitTop);
  return findings;
}

export function checkIntegrationScope({ root, files }: CheckIntegrationScopeOptions): Finding[] {
  // git ls-files --cached still lists a file deleted in the working tree until it is staged.
  const targets = (files ?? listRepoFiles(root))
    .filter(isIntegrationTestFile)
    .filter((file) => existsSync(join(root, file)));
  return targets.flatMap((file) =>
    checkIntegrationScopeSource(file, readFileSync(join(root, file), 'utf8')),
  );
}
