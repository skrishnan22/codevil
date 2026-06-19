# Patterns from flue worth considering for codevil

Notes from exploring `references/flue/`. Flue is a TypeScript "agent harness framework" — closest cousin to codevil (both ship an autonomous agent on a sandbox; flue is the framework, codevil is the product).

## Code-quality / tooling findings (deferred — see separate framework-pattern pass)

These are valid but lower-priority than the architectural patterns we actually want to evaluate.

- Turbo pipeline with proper DAG (`check:types` depends on `^build`, `globalPassThroughEnv` for CA cert vars).
- Biome + knip as one lint+deadcode gate.
- Stricter `tsconfig.base.json` (`noUncheckedIndexedAccess`, `isolatedModules`, `verbatimModuleSyntax`).
- Multi-entry package exports including `./internal` for `packages/shared`.
- Lift `packages/runtime/src/skill-frontmatter.ts` wholesale if we parse skill frontmatter (FAILSAFE_SCHEMA so `version: 1.0` stays a string).

## Framework / architecture patterns (TBD)

Pending focused re-read of flue with this lens. Section to be filled in by the next exploration pass.
