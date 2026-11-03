/**
 * FrontX Template Dependency Cruiser Configuration (template-shell/, self-contained)
 *
 * Template-internal rules over src-app/: MFE vertical-slice isolation, the
 * screenset flux architecture and ADR-0028's single router seam. The FrontX
 * packages come from npm, so the layer chain between them (state/i18n ->
 * framework -> react) is theirs to enforce, not this tree's.
 */

/**
 * A FrontX package as dependency-cruiser sees it: resolved through node_modules
 * when installed, or the bare specifier when not.
 */
const pkgTargets = (...dirs) => {
  const group = dirs.join('|');
  return [`(^|/)@gears-frontx/(${group})(/|$)`];
};

// Type-only edges are visible because `tsPreCompilationDeps` is on (see
// `options` below), and a `types.ts` <-> the class it types cycle is idiomatic
// TS that is erased before emit. The exemption lives in `viaOnly`, not in a
// per-edge `to.dependencyTypesNot`: the latter only filters the edge the cycle
// is evaluated from, so the same cycle is still reported from its runtime side.
// `viaOnly` requires *every* edge in the cycle to be runtime, which is exactly
// "the cycle survives to runtime". Mirrors `internal/depcruise-config/core.cjs`.
const TYPE_ONLY_DEPENDENCY_TYPES = ['type-only', 'type-import'];

module.exports = {
  forbidden: [
    // ============ L0 BASE: UNIVERSAL RULES ============
    // Error-severity cycle detection over the whole tree;
    // `no-circular-screenset-deps` below is `warn` and covers only
    // `src-app/screensets`.
    {
      name: 'no-circular',
      severity: 'error',
      from: { path: '^(?!.*node_modules)' },
      to: { circular: true, viaOnly: { dependencyTypesNot: TYPE_ONLY_DEPENDENCY_TYPES } },
      comment:
        'Circular dependencies create tight coupling and make code harder to reason about.',
    },

    // ============ L4 SCREENSET: ISOLATION RULES ============
    {
      name: 'no-cross-mfe-imports',
      severity: 'error',
      from: { path: '^src-app/mfe_packages/([^/]+)/' },
      to: {
        path: '^src-app/mfe_packages/[^/]+/',
        pathNot: [
          '^src-app/mfe_packages/$1/',
          '^src-app/mfe_packages/shared/',
        ],
      },
      comment: 'MFE packages must not import from other MFE packages (vertical slice isolation).',
    },
    {
      name: 'no-circular-screenset-deps',
      severity: 'warn',
      from: { path: '^src-app/screensets/([^/]+)/' },
      to: {
        path: '^src-app/screensets/$1/',
        circular: true,
      },
      comment: 'Avoid circular dependencies within screenset modules.',
    },

    // ============ L4 SCREENSET: FLUX ARCHITECTURE RULES ============
    {
      name: 'flux-no-actions-in-effects-folder',
      severity: 'error',
      from: { path: '/effects/' },
      to: { path: '/actions/' },
      comment: 'FLUX VIOLATION: Effects folder cannot import from actions folder.',
    },
    {
      name: 'flux-no-effects-in-actions-folder',
      severity: 'error',
      from: { path: '/actions/' },
      to: { path: '/effects/' },
      comment: 'FLUX VIOLATION: Actions folder cannot import from effects folder.',
    },

    // ============ ADR-0028: ONE PLACE TALKS TO THE ROUTER ============
    {
      name: 'routing-package-only-in-routing-folder',
      severity: 'error',
      from: { pathNot: ['^src-app/app/routing/', '^src-app/__test-utils__/memoryNavigationHistory'] },
      to: { path: pkgTargets('routing') },
      comment:
        'ADR-0028: the shell alone owns the address. `@gears-frontx/routing` is imported from src-app/app/routing/ (and its test seam) only; MFEs and shell chrome stay URL-unaware.',
    },
  ],
  options: {
    // node_modules is matched at ANY depth, not just the root: after
    // `frontx add mfe` (or CI's composition of template-mfe onto this shell),
    // `npm install` nests a node_modules under each src-app/mfe_packages/*
    // workspace whose pins conflict with the shell's. Anchored `^node_modules`
    // misses those, and dependency-cruiser then traverses the entire installed
    // dependency universe — which is not a rule violation but an OOM.
    // The same workspaces build into `src-app/mfe_packages/*/dist`. That is
    // bundled output, not code anyone writes: the framework's shared chunk there
    // imports @gears-frontx/routing, which ADR-0028's rule would read as an MFE
    // talking to the router.
    doNotFollow: { path: ['(^|/)node_modules/', '^src-app/mfe_packages/[^/]+/dist'] },
    // Nothing is path-excluded. `exclude` drops modules from the graph outright,
    // so anything listed here becomes unusable as a rule's `to` — the routing
    // rule above needs node_modules visible. Traversal is bounded by
    // `doNotFollow` above instead, which keeps the nodes visible.
    exclude: {
      dynamic: true,
    },
    // Type-only imports are erased before emit, so without this any boundary
    // crossing written as `import type` is invisible to every rule above. The
    // contract is about coupling, not about what survives to runtime.
    tsPreCompilationDeps: true,
  },
};
