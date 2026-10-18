// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const STDOUT_MESSAGE =
  'stdout carries MCP protocol frames only. Log through src/log.ts (stderr); CLI output goes through src/cli/stdout.ts.';

export default defineConfig(
  globalIgnores([
    'node_modules/',
    'dist/',
    'coverage/',
    '.cache/',
    // The OTCP specification is owned by its own change process; it holds no JS or TS anyway.
    'spec/',
    // Byte-identical copy of the maintainer's canonical checker (sha256-pinned); not edited here.
    'scripts/check-attribution.mjs',
  ]),
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    // Server code: stdout belongs to the MCP protocol. Bundled dependencies are checked
    // separately on the built bundle (gates: bundle stdout hygiene).
    files: ['src/**/*.ts'],
    rules: {
      'no-console': ['error'],
      'no-restricted-syntax': [
        'error',
        // `.stdout` / `["stdout"]` on any object (process, globalThis.process, an alias, a
        // child-process result) and destructuring it. The one sanctioned writer, src/cli/stdout.ts,
        // carries an inline exemption.
        { selector: "MemberExpression[property.name='stdout']", message: STDOUT_MESSAGE },
        { selector: "MemberExpression[property.value='stdout']", message: STDOUT_MESSAGE },
        { selector: "ObjectPattern > Property[key.name='stdout']", message: STDOUT_MESSAGE },
        { selector: "ObjectPattern > Property[key.value='stdout']", message: STDOUT_MESSAGE },
        // no-console does not see console being aliased or destructured.
        { selector: "VariableDeclarator[init.name='console']", message: STDOUT_MESSAGE },
        // Writing to file descriptor 1 directly: fs.writeSync(1, …), writeFileSync(1, …) and the
        // like, streams opened on it ({ fd: 1 }, new tty.WriteStream(1)), and its device paths.
        {
          selector:
            'CallExpression[callee.property.name=/^(write|writev|writeFile|appendFile)(Sync)?$/][arguments.0.value=1]',
          message: STDOUT_MESSAGE,
        },
        {
          selector: 'CallExpression[callee.name=/^(write|writev|writeFile|appendFile)(Sync)?$/][arguments.0.value=1]',
          message: STDOUT_MESSAGE,
        },
        { selector: "Property[key.name='fd'][value.value=1]", message: STDOUT_MESSAGE },
        {
          selector:
            "NewExpression:matches([callee.name='WriteStream'], [callee.property.name='WriteStream'])[arguments.0.value=1]",
          message: STDOUT_MESSAGE,
        },
        { selector: "Literal:matches([value='/dev/stdout'], [value='/dev/fd/1'])", message: STDOUT_MESSAGE },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'node:process', importNames: ['stdout'], message: STDOUT_MESSAGE },
            { name: 'process', importNames: ['stdout'], message: STDOUT_MESSAGE },
          ],
        },
      ],
    },
  },
);
