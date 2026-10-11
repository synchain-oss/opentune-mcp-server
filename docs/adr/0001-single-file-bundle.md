# ADR 0001: Publish a single-file bundle with no runtime dependencies

- Status: accepted
- Date: 2026-10-11

## Context

MCP clients start `opentune-mcp` on the user's machine, usually through `npx` or a desktop extension bundle, often
without anyone watching the install. A package that declares ordinary `dependencies` has three problems in that
setting:

- Its transitive dependencies are resolved again on every fresh install. Pinning the top-level version pins only the
  top-level package; what actually runs can change without a release of this project.
- npm runs the `preinstall`, `install` and `postinstall` scripts of every package in that tree with the user's
  privileges.
- Any dependency that writes to stdout corrupts the MCP stdio stream, which carries protocol frames only.

The server needs very little at runtime: the MCP TypeScript SDK and zod.

## Decision

1. The published package contains one program file, `dist/opentune-mcp.mjs`, built by esbuild (`bundle: true`,
   `platform: 'node'`, `format: 'esm'`, `target: 'node22'`, with a `#!/usr/bin/env node` banner). It is not minified,
   so the code that ships can be read and audited.
2. `package.json` has no `dependencies`, `optionalDependencies`, `peerDependencies` or `bundleDependencies`. Everything
   needed to build and test (the SDK, zod, esbuild, TypeScript, vitest, eslint, prettier) is a devDependency pinned to
   an exact version, and `package-lock.json` is committed.
3. `package.json` defines no lifecycle scripts (`preinstall`, `install`, `postinstall`, `prepare`, `prepack`,
   `postpack`, `prepublish*`, `publish*` and the rest). Installing or packing the package runs nothing.
4. `files` is an exact whitelist: the bundle, `README.md`, `README.zh-CN.md`, `LICENSE` and `THIRD-PARTY-NOTICES.md`
   (npm adds `package.json` itself).
5. `THIRD-PARTY-NOTICES.md` is generated and never edited by hand. `scripts/gen-notices.mjs` bundles in memory with the
   same options as the build, reads the esbuild metafile and collects every package under `node_modules/` that
   contributes at least one byte to the output; code removed by tree shaking does not count. For each package it
   records the name, the version, the SPDX `license` expression from its `package.json`, and the full text of its
   LICENSE, COPYING and NOTICE files, or links to the SPDX license texts when the package ships none. A bundled package
   without a name, a version or a license expression makes the generator fail, so a new dependency cannot ship
   unlisted. The file is committed so that it is reviewed together with dependency changes.

## Enforcement

`npm run gates` fails when any of this stops being true:

- bundle shape: `dist/` contains only the bundle, its first line is the shebang, every import left in it is a `node:`
  built-in, and no `require()` was left for esbuild's runtime shim;
- bundle stdout hygiene: no console method that writes to stdout appears anywhere in the bundle, bundled dependencies
  included;
- `npm pack --dry-run --json` lists exactly the whitelist;
- `package.json` and the lockfile's root entry declare no dependencies, `package.json` defines no lifecycle scripts,
  and every devDependency is an exact version;
- `THIRD-PARTY-NOTICES.md` equals a fresh generation;
- `npm audit`, devDependencies included, reports nothing.

## Consequences

- Users install one file. `npx @synchain/opentune-mcp@<version>` runs exactly the code that was reviewed and
  released, and the license notices of everything inside it ship with it.
- A dependency fix reaches users only through a new release of this package, after the gates have run on it. Security
  fixes in the SDK or zod therefore need a release here; dependency update PRs keep the devDependencies current.
- The bundle is larger than the first-party code (most of it is the SDK and zod), but it is still a single module to
  load at startup.
- Dependencies that need native addons, load files next to themselves, or `require()` other packages at runtime cannot
  be used; the bundle-shape check rejects them.
- After changing dependencies, contributors run `npm run notices` and commit the result.
