// Workspace contract (F-001 design §3.1). check-workspaces validates every workspace
// package.json against it.
import { z } from 'zod';

export const REQUIRED_SCRIPTS = ['lint', 'typecheck', 'test', 'build'] as const;

// Lifecycle scripts are defined with the dependency-free config gate.
export { LIFECYCLE_SCRIPTS } from '../config-gate.ts';

export const WORKSPACE_KINDS = [
  'app',
  'cli',
  'library',
  'service',
  'tooling',
  'placeholder',
] as const;

export const RalysaPackageMeta = z
  .strictObject({
    kind: z.enum(WORKSPACE_KINDS),
    // Required when kind = 'library' (RC-6); 'isomorphic' selects the isomorphic lint preset.
    runtime: z.enum(['browser', 'node', 'isomorphic']).optional(),
    // true = reaches customers or users: drives the artefact secret scan (AC-2) and the demo
    // exclusion check (AC-13).
    shipped: z.boolean(),
    // true = the UI lint layer applies (AC-4, AC-5, AC-10).
    ui: z.boolean(),
    // Paths scanned after build when shipped = true.
    artefacts: z.array(z.string()).default(['dist']),
  })
  .superRefine((meta, ctx) => {
    if (meta.kind === 'library' && meta.runtime === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['runtime'],
        message: 'a library must declare its runtime',
      });
    }
    if (meta.kind === 'tooling' && meta.shipped) {
      ctx.addIssue({
        code: 'custom',
        path: ['shipped'],
        message: 'tooling packages are never shipped',
      });
    }
    if (meta.kind === 'placeholder' && meta.artefacts.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['artefacts'],
        message: 'a placeholder builds nothing, so it has no artefacts',
      });
    }
  });

export const WorkspacePackageJson = z.looseObject({
  name: z.string().regex(/^@ralysa\/[a-z0-9-]+$/, 'name must be @ralysa/<lowercase-kebab>'),
  // Nothing is published in Phase 0. Flipping this for packages/protocol or sdk (REQ-053) is a
  // reviewed change.
  private: z.literal(true),
  type: z.literal('module'),
  scripts: z.looseObject(
    Object.fromEntries(REQUIRED_SCRIPTS.map((script) => [script, z.string().min(1)])),
  ),
  ralysa: RalysaPackageMeta,
});

export type WorkspacePackage = z.infer<typeof WorkspacePackageJson>;
