// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: MIT

// The revert recipes that the specification's vectors show (undo.revert and sideEffects.*.revert, also
// inside job results and scenario steps) must each become a tool call of this server, or be listed
// below with the reason no tool can carry them out. A recipe that falls outside the mapping tells the
// agent "no tool can restore it" about a change that a tool can restore, so a new vector, or a mapping
// that is removed or narrowed, turns this test red until the mapping or the list is fixed.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Json } from '../../src/otcp/client.js';
import { encodeArrangementRevision, encodeClipRevision } from '../../src/otcp/tokens.js';
import { RESTORABLE_METHODS, revertPlan, type RevertPlan } from '../../src/render/revert.js';
import { TOOLS } from '../../src/tools/index.js';
import { SPEC_ROOT } from '../support/otcp-spec.js';

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface Found {
  /** The vector id and the place of the recipe in it. */
  readonly where: string;
  readonly recipe: Json;
}

/** Every non-null recipe of undo.revert and sideEffects.<name>.revert below `node`. */
function recipesIn(node: unknown, trail: string, out: Found[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => {
      recipesIn(item, `${trail}[${String(i)}]`, out);
    });
    return;
  }
  if (!isObject(node)) return;
  if (isObject(node.undo) && isObject(node.undo.revert)) {
    out.push({ where: `${trail}.undo.revert`, recipe: node.undo.revert });
  }
  if (isObject(node.sideEffects)) {
    for (const [name, effect] of Object.entries(node.sideEffects)) {
      if (isObject(effect) && isObject(effect.revert)) {
        out.push({ where: `${trail}.sideEffects.${name}.revert`, recipe: effect.revert });
      }
    }
  }
  for (const [key, child] of Object.entries(node)) recipesIn(child, `${trail}.${key}`, out);
}

function vectorRecipes(): Found[] {
  const root = path.join(SPEC_ROOT, 'vectors');
  const out: Found[] = [];
  for (const file of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    if (!file.endsWith('.json')) continue;
    const id = file.replaceAll('\\', '/').replace(/\.json$/, '');
    const found: Found[] = [];
    recipesIn(JSON.parse(readFileSync(path.join(root, file), 'utf8')) as unknown, '', found);
    out.push(...found.map((f) => ({ ...f, where: `${id}${f.where}` })));
  }
  return out;
}

/**
 * A vector matches values it cannot know (`{"$any": ...}`, `{"$ref": ...}`, `{"$capture": ...}`). The recipe is
 * turned into a concrete one by a value of the right form for the member the matcher stands in for. A member
 * without a sample stops the test: a new kind of value is a decision, not a default.
 */
const SAMPLES: Readonly<Record<string, unknown>> = {
  contentId: 'c:01234567:0:1',
  placementId: 'p:01234567:0:1',
  placementIds: 'p:01234567:0:1',
  leadingPlacementId: 'p:01234567:0:1',
  trailingPlacementId: 'p:01234567:0:2',
  expectedUndoId: 'u:01234567:3',
  expectedArrangementRevision: 'a1',
  expectedKeyRevision: 'k1',
  path: 'C:/Music/a.otproj',
  deviceType: 'Mock Audio',
  outputDevice: 'Mock Output',
  colour: '#112233',
  volumeDb: -6,
};

function concrete(value: unknown, member: string, where: string): unknown {
  if (Array.isArray(value)) return value.map((item) => concrete(item, member, where));
  if (!isObject(value)) return value;
  const names = Object.keys(value);
  if (names.length > 0 && names.every((name) => name.startsWith('$'))) {
    if (typeof value.$approx === 'number') return value.$approx;
    if (!(member in SAMPLES)) throw new Error(`${where}: no sample value for a matcher standing in for ${member}`);
    return SAMPLES[member];
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, concrete(item, key, where)]));
}

/** Recipes that no tool of this server can carry out, with the reason. Each must match a recipe of a vector. */
const NO_TOOL: readonly { readonly name: string; readonly why: string; readonly matches: (recipe: Json) => boolean }[] =
  [
    {
      name: 'ui.setSelection with a track id',
      why:
        'The recipe selects the track that was active before, with no clip selected. opentune_manage_ui focus_clip ' +
        'takes a clip placement and no tool selects a track, so only the user can do it, by clicking the track.',
      matches: (recipe) => recipe.method === 'ui.setSelection' && isObject(recipe.params) && 'trackId' in recipe.params,
    },
  ];

/** The recipes `plan` does not turn into a tool call. */
function unmapped(found: readonly Found[], plan: (recipe: Json) => RevertPlan): Found[] {
  return found.filter(({ recipe, where }) => plan(concrete(recipe, '', where) as Json).kind !== 'tool');
}

const covered = (f: Found): boolean => NO_TOOL.some((entry) => entry.matches(f.recipe));

describe('the revert recipes of the specification vectors', () => {
  const found = vectorRecipes();

  it('are found in the vectors, so the checks below are not vacuous', () => {
    expect(found.length).toBeGreaterThan(40);
    const methods = new Set(found.map((f) => String(f.recipe.method)));
    // Every method the mapping knows, bar the one no vector shows a recipe for.
    expect([...RESTORABLE_METHODS].filter((m) => !methods.has(m))).toEqual(['content.setPitchShift']);
  });

  it('each become a tool call, except those listed with a reason', () => {
    const left = unmapped(found, revertPlan).filter((f) => !covered(f));
    expect(left.map((f) => `${f.where}: ${JSON.stringify(f.recipe)}`)).toEqual([]);
  });

  it('are not listed as having no tool when a tool can carry them out', () => {
    for (const entry of NO_TOOL) {
      const matching = found.filter((f) => entry.matches(f.recipe));
      expect(matching.length, entry.name).toBeGreaterThan(0);
      expect(unmapped(matching, revertPlan).length, entry.name).toBe(matching.length);
      expect(entry.why.length, entry.name).toBeGreaterThan(20);
    }
  });

  it('still become tool calls when they name only some of their members', () => {
    // OpenTune lists in a recipe the members a call changed, so the vectors, which change every member at
    // once, are not the whole story: each member of these methods alone has to be carried out too.
    const independent = new Set(['transport.setTempo', 'prefs.set', 'audio.set']);
    const subsets = found.flatMap(({ recipe, where }) => {
      const params = concrete(recipe.params, 'params', where);
      if (!independent.has(String(recipe.method)) || !isObject(params) || Object.keys(params).length < 2) return [];
      return Object.entries(params).map(([member, value]) => ({
        where: `${where} (only ${member})`,
        recipe: { method: recipe.method, params: { [member]: value } },
      }));
    });
    expect(subsets.length).toBeGreaterThan(0);
    expect(unmapped(subsets, revertPlan).map((f) => f.where)).toEqual([]);
    // The guard bites: a mapping that needs both members of a tempo recipe fails on its parts.
    const both = (recipe: Json): RevertPlan => {
      const params = isObject(recipe.params) ? recipe.params : {};
      return recipe.method === 'transport.setTempo' && Object.keys(params).length < 2
        ? { kind: 'manual', consent: false }
        : revertPlan(recipe);
    };
    expect(unmapped(subsets, both).length).toBeGreaterThan(0);
  });

  it('become calls that the input schema of their tool accepts', () => {
    const clipRevision = encodeClipRevision({ content: 'r1', grid: 'g1', key: 'k1', geometry: null });
    const arrangementRevision = encodeArrangementRevision('a1');
    let checked = 0;
    for (const { recipe, where } of found) {
      const plan = revertPlan(concrete(recipe, '', where));
      if (plan.kind !== 'tool') continue;
      const tool = TOOLS.find((t) => t.name === plan.call.tool);
      if (tool === undefined) throw new Error(`${where}: no tool ${plan.call.tool}`);
      const args: Json = {
        ...plan.call.arguments,
        ...(plan.needsRevision
          ? { expected_revision: plan.revisionKind === 'arrangement' ? arrangementRevision : clipRevision }
          : {}),
        ...(plan.consentArgument === undefined ? {} : { [plan.consentArgument]: true }),
      };
      const parsed = tool.inputSchema.safeParse(args);
      expect(parsed.success, `${where}: ${JSON.stringify(args)}`).toBe(true);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(40);
  });

  it('turn the guard red when the mapping of a method is removed', () => {
    // The same guard over a mapping that has lost one method: it reports exactly the recipes of that method.
    for (const method of ['transport.setTempo', 'transport.setLoop', 'track.set', 'prefs.set', 'edit.undo']) {
      const without = (recipe: Json): RevertPlan =>
        recipe.method === method ? { kind: 'manual', consent: false } : revertPlan(recipe);
      const broken = unmapped(found, without).filter((f) => !covered(f));
      expect(broken.length, method).toBeGreaterThan(0);
      expect(new Set(broken.map((f) => f.recipe.method)), method).toEqual(new Set([method]));
    }
  });
});
