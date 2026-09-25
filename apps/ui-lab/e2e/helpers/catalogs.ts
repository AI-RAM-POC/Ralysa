// The ui-lab and ui catalogs as the specs see them (read from source, so a spec never hard-codes
// a translation that could drift).
import { readFileSync } from 'node:fs';

type Tree = { [key: string]: string | Tree };

function read(path: string): Tree {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Tree;
}

/** `lookup(tree, 'a.b.c')`: the string at that key, or an error naming it. */
export function lookup(tree: Tree, key: string): string {
  let node: string | Tree | undefined = tree;
  for (const part of key.split('.')) {
    node = typeof node === 'object' ? node[part] : undefined;
  }
  if (typeof node !== 'string') throw new Error(`no string at ${key}`);
  return node;
}

export const LAB = { en: read('../../locales/en/lab.json'), ar: read('../../locales/ar/lab.json') };
export const UI = {
  en: read('../../../../packages/ui/src/locales/en/ui.json'),
  ar: read('../../../../packages/ui/src/locales/ar/ui.json'),
};
