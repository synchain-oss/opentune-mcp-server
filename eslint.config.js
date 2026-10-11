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
        { selector: "MemberExpression[object.name='process'][property.name='stdout']", message: STDOUT_MESSAGE },
        { selector: "MemberExpression[object.name='process'][property.value='stdout']", message: STDOUT_MESSAGE },
        {
          selector: "VariableDeclarator[init.name='process'] > ObjectPattern > Property[key.name='stdout']",
          message: STDOUT_MESSAGE,
        },
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
