// check-banned-deps (F-001 design §6.1; ADR-0012, SR-03, ADR-0024, AC-13; AR-5, AR-6;
// SEC-F001-08, -09 a/c): the dependency-graph layer of the boundary rules. It reads
// pnpm-lock.yaml, so it sees the full installed graph of every workspace and of the root:
// prod, dev and optional dependencies at any depth. Names are the **resolved** package names
// from the lockfile, so an `npm:` alias can't hide a banned package.
//
// For each banned package reached from a workspace, every dependency path to it must contain one
// of the group's `graphAllowedThrough` sequences (boundaries.js); a group with none is banned
// outright. The check runs a breadth-first search over (node, progress along each sequence)
// states, so it never enumerates paths, and reports one witness path per finding.
//
// Production-closure mode (F-002-T14; SEC-F002-13 b, AR-12): from every `shipped: true` workspace,
// only production edges are followed (an importer's dependencies and optionalDependencies, then
// every package's dependencies and optionalDependencies, through linked workspaces too). No
// DEV_ONLY_PACKAGES entry (the mock IdP's `oidc-provider`, `@ralysa/dev-stack`) may be reachable,
// at any depth. devDependencies stay allowed: integration tests import the harness from test/**.
import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import {
  BANNED_PACKAGE_GROUPS,
  DEV_ONLY_MESSAGE,
  DEV_ONLY_PACKAGES,
  WORKSPACE_DEPENDENCY_RULES,
  bannedGroupOf,
  globSource,
} from '@ralysa/eslint-config/boundaries';
import { type Finding, isRecord, listWorkspaceDirs, readJson, readYaml } from './lib/repo.ts';

const IMPORTER_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
const IMPORTER_PROD_FIELDS = ['dependencies', 'optionalDependencies'] as const;
const SNAPSHOT_FIELDS = ['dependencies', 'optionalDependencies'] as const;
const SUPPORTED_LOCKFILE = '9.0';

type NodeId = string; // "importer:<path>" or "package:<snapshot key>"

interface GraphNode {
  id: NodeId;
  /** The resolved package name (workspaces: their package.json name). */
  name: string;
  /** How the node reads in a finding. */
  label: string;
  importer?: string;
}

export interface DependencyGraph {
  nodes: Map<NodeId, GraphNode>;
  edges: Map<NodeId, NodeId[]>;
  /** Production edges only: what `pnpm deploy --prod` installs (no devDependencies). */
  prodEdges: Map<NodeId, NodeId[]>;
  importers: string[];
  problems: Finding[];
}

export interface CheckBannedDepsOptions {
  root: string;
  /** Parsed lockfile; defaults to reading `<root>/pnpm-lock.yaml`. */
  lockfile?: unknown;
  /** Workspace path → package name; defaults to reading each workspace's package.json. */
  workspaceNames?: Map<string, string>;
  /** Paths of the `shipped: true` workspaces; defaults to reading each package.json. */
  shipped?: string[];
}

/** `name@1.2.3(peer@4)` → `name`. */
export function packageNameOfKey(key: string): string {
  const base = key.split('(')[0] ?? key;
  const at = base.lastIndexOf('@');
  return at > 0 ? base.slice(0, at) : base;
}

function importerId(path: string): NodeId {
  return `importer:${path}`;
}

function packageId(key: string): NodeId {
  return `package:${key}`;
}

/** Workspace path → package name, for the root and every folder under the four roots. */
export function readWorkspaceNames(root: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const dir of ['.', ...listWorkspaceDirs(root)]) {
    const manifest = join(root, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = readJson(manifest);
    if (isRecord(pkg) && typeof pkg.name === 'string') names.set(dir, pkg.name);
  }
  return names;
}

/** Builds the dependency graph from a lockfile v9 document. */
export function buildGraph(
  lockfile: unknown,
  workspaceNames: Map<string, string>,
): DependencyGraph {
  const graph: DependencyGraph = {
    nodes: new Map(),
    edges: new Map(),
    prodEdges: new Map(),
    importers: [],
    problems: [],
  };
  const problem = (message: string): void => {
    graph.problems.push({ rule: 'banned-deps/lockfile', path: 'pnpm-lock.yaml', message });
  };
  if (!isRecord(lockfile)) {
    problem('not a YAML mapping');
    return graph;
  }
  // Fail closed on a format this reader wasn't written for.
  if (String(lockfile.lockfileVersion) !== SUPPORTED_LOCKFILE) {
    problem(
      `lockfileVersion ${String(lockfile.lockfileVersion)} is not ${SUPPORTED_LOCKFILE}; update check-banned-deps for the new format`,
    );
    return graph;
  }
  const importers = isRecord(lockfile.importers) ? lockfile.importers : {};
  const snapshots = isRecord(lockfile.snapshots) ? lockfile.snapshots : {};

  for (const path of Object.keys(importers)) {
    const name = workspaceNames.get(path) ?? path;
    graph.importers.push(path);
    graph.nodes.set(importerId(path), {
      id: importerId(path),
      name,
      label: path === '.' ? `${name} (root)` : `${name} (${path})`,
      importer: path,
    });
  }
  for (const key of Object.keys(snapshots)) {
    graph.nodes.set(packageId(key), {
      id: packageId(key),
      name: packageNameOfKey(key),
      label: key,
    });
  }

  /** The node a dependency entry points at, or undefined (reported) if it can't be resolved. */
  const target = (
    fromImporter: string | undefined,
    name: string,
    version: string,
  ): NodeId | undefined => {
    if (version.startsWith('link:')) {
      if (fromImporter === undefined) {
        problem(`a package depends on ${name} through ${version}; only workspaces may use link:`);
        return undefined;
      }
      const path = posix.normalize(posix.join(fromImporter, version.slice('link:'.length)));
      if (graph.nodes.has(importerId(path))) return importerId(path);
      problem(`${fromImporter} links ${name} to ${path}, which is not a workspace in the lockfile`);
      return undefined;
    }
    // A plain version is keyed `<name>@<version>`; an alias (`npm:`) is keyed by the real
    // `<real-name>@<version>` that the lockfile stores as the version.
    for (const key of [`${name}@${version}`, version]) {
      if (key in snapshots) return packageId(key);
    }
    problem(`cannot resolve ${name}@${version} to a snapshot; the lockfile may be malformed`);
    return undefined;
  };

  const addEdges = (
    from: NodeId,
    entries: unknown,
    importer: string | undefined,
    prod: boolean,
  ): void => {
    if (!isRecord(entries)) return;
    const list = graph.edges.get(from) ?? [];
    const prodList = graph.prodEdges.get(from) ?? [];
    for (const [name, raw] of Object.entries(entries)) {
      const version = isRecord(raw) ? raw.version : raw;
      if (typeof version !== 'string') continue;
      const to = target(importer, name, version);
      if (to === undefined) continue;
      list.push(to);
      if (prod) prodList.push(to);
    }
    graph.edges.set(from, list);
    graph.prodEdges.set(from, prodList);
  };

  for (const [path, entry] of Object.entries(importers)) {
    if (!isRecord(entry)) continue;
    for (const field of IMPORTER_FIELDS) {
      addEdges(
        importerId(path),
        entry[field],
        path,
        (IMPORTER_PROD_FIELDS as readonly string[]).includes(field),
      );
    }
  }
  for (const [key, entry] of Object.entries(snapshots)) {
    if (!isRecord(entry)) continue;
    for (const field of SNAPSHOT_FIELDS) addEdges(packageId(key), entry[field], undefined, true);
  }
  return graph;
}

const matchesName = (pattern: string, name: string): boolean =>
  new RegExp(`^${globSource(pattern)}$`).test(name);

interface State {
  node: NodeId;
  progress: number[];
}

const stateKey = (state: State): string => `${state.node}|${state.progress.join(',')}`;

/**
 * Every allowed sequence across the groups, indexed, so one search tracks them all.
 */
const SEQUENCES: string[][] = BANNED_PACKAGE_GROUPS.flatMap((group) => group.graphAllowedThrough);

function advance(progress: number[], name: string): number[] {
  return progress.map((done, index) => {
    const sequence = SEQUENCES[index] ?? [];
    const next = sequence[done];
    return next !== undefined && matchesName(next, name) ? done + 1 : done;
  });
}

function witness(
  graph: DependencyGraph,
  parents: Map<string, State | undefined>,
  end: State,
): string {
  const labels: string[] = [];
  for (
    let state: State | undefined = end;
    state !== undefined;
    state = parents.get(stateKey(state))
  ) {
    labels.unshift(graph.nodes.get(state.node)?.label ?? state.node);
  }
  return labels.join(' → ');
}

/** Breadth-first search from one importer, calling `visit` once per reached state. */
function search(
  graph: DependencyGraph,
  start: string,
  visit: (state: State, parents: Map<string, State | undefined>) => void,
): void {
  const startNode = graph.nodes.get(importerId(start));
  if (startNode === undefined) return;
  const first: State = {
    node: startNode.id,
    progress: advance(
      SEQUENCES.map(() => 0),
      startNode.name,
    ),
  };
  const parents = new Map<string, State | undefined>([[stateKey(first), undefined]]);
  const queue: State[] = [first];
  for (let state = queue.shift(); state !== undefined; state = queue.shift()) {
    visit(state, parents);
    for (const next of graph.edges.get(state.node) ?? []) {
      const node = graph.nodes.get(next);
      if (node === undefined) continue;
      const nextState: State = { node: next, progress: advance(state.progress, node.name) };
      const key = stateKey(nextState);
      if (parents.has(key)) continue;
      parents.set(key, state);
      queue.push(nextState);
    }
  }
}

/** True when the path to `state` completed one of the group's allowed sequences. */
function allowedByGroup(groupSequences: string[][], progress: number[]): boolean {
  return groupSequences.some((sequence) => {
    const index = SEQUENCES.indexOf(sequence);
    return index !== -1 && progress[index] === sequence.length;
  });
}

export function checkBannedDepsGraph(graph: DependencyGraph): Finding[] {
  const findings: Finding[] = [...graph.problems];
  const workspaces = new Map(
    [...graph.nodes.values()]
      .filter((node) => node.importer !== undefined)
      .map((node) => [node.name, node]),
  );

  for (const start of graph.importers) {
    const startName = graph.nodes.get(importerId(start))?.name ?? start;
    const reported = new Set<string>();
    const rules = WORKSPACE_DEPENDENCY_RULES.filter(
      (rule) =>
        rule.to !== startName &&
        rule.from.some((glob) => new RegExp(`^${globSource(glob)}$`).test(start)),
    );

    search(graph, start, (state, parents) => {
      const node = graph.nodes.get(state.node);
      if (node === undefined) return;

      for (const rule of rules) {
        const target = workspaces.get(rule.to);
        if (target?.id !== node.id || reported.has(`ws:${rule.to}`)) continue;
        reported.add(`ws:${rule.to}`);
        findings.push({
          rule: 'banned-deps/workspace',
          path: start,
          message: `${rule.message} Path: ${witness(graph, parents, state)}`,
        });
      }

      if (node.importer !== undefined) return;
      const group = bannedGroupOf(node.name);
      if (group === undefined || reported.has(node.name)) return;
      if (allowedByGroup(group.graphAllowedThrough, state.progress)) return;
      reported.add(node.name);
      findings.push({
        rule: `banned-deps/${group.id}`,
        path: start,
        message: `${node.name} is in the dependency graph. ${group.message} Path: ${witness(graph, parents, state)}`,
      });
    });
  }
  return findings;
}

const isDevOnly = (name: string): boolean =>
  DEV_ONLY_PACKAGES.some((pattern) => matchesName(pattern, name));

/**
 * Production-closure mode (SEC-F002-13 b): no development-only package is reachable from a shipped
 * workspace through production edges. One finding per (workspace, package), with a witness path.
 */
export function checkProductionClosure(graph: DependencyGraph, shipped: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const start of shipped) {
    const first = importerId(start);
    if (!graph.nodes.has(first)) {
      findings.push({
        rule: 'banned-deps/dev-only-in-shipped',
        path: start,
        message: `shipped workspace ${start} is not an importer in pnpm-lock.yaml; run pnpm install`,
      });
      continue;
    }
    const parents = new Map<NodeId, NodeId | undefined>([[first, undefined]]);
    const queue: NodeId[] = [first];
    const reported = new Set<string>();
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      const node = graph.nodes.get(id);
      if (node !== undefined && id !== first && isDevOnly(node.name) && !reported.has(node.name)) {
        reported.add(node.name);
        const labels: string[] = [];
        for (let at: NodeId | undefined = id; at !== undefined; at = parents.get(at)) {
          labels.unshift(graph.nodes.get(at)?.label ?? at);
        }
        findings.push({
          rule: 'banned-deps/dev-only-in-shipped',
          path: start,
          message: `${node.name} is in the production closure of a shipped workspace. ${DEV_ONLY_MESSAGE} Path: ${labels.join(' → ')}`,
        });
      }
      for (const next of graph.prodEdges.get(id) ?? []) {
        if (parents.has(next)) continue;
        parents.set(next, id);
        queue.push(next);
      }
    }
  }
  return findings;
}

/** Paths of the workspaces whose package.json says `ralysa.shipped: true`. */
export function readShippedWorkspaces(root: string): string[] {
  return listWorkspaceDirs(root).filter((dir) => {
    const manifest = join(root, dir, 'package.json');
    if (!existsSync(manifest)) return false;
    const pkg = readJson(manifest);
    return isRecord(pkg) && isRecord(pkg.ralysa) && pkg.ralysa.shipped === true;
  });
}

export function checkBannedDeps(options: CheckBannedDepsOptions): Finding[] {
  const { root } = options;
  const lockfilePath = join(root, 'pnpm-lock.yaml');
  if (options.lockfile === undefined && !existsSync(lockfilePath)) {
    return [{ rule: 'banned-deps/lockfile', path: 'pnpm-lock.yaml', message: 'not found' }];
  }
  const lockfile = options.lockfile ?? readYaml(lockfilePath);
  const names = options.workspaceNames ?? readWorkspaceNames(root);
  const graph = buildGraph(lockfile, names);
  return [
    ...checkBannedDepsGraph(graph),
    ...checkProductionClosure(graph, options.shipped ?? readShippedWorkspaces(root)),
  ];
}
