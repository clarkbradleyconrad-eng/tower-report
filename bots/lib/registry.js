/**
 * Tower Report bots — registry loading + run ordering
 *
 * bots/registry.json is the single source of truth for bot config. Runtime
 * enable/disable toggles from ops.html live in the tower-bot-overrides blob
 * (serverless functions cannot edit repo files) and are merged over the
 * registry here.
 */

import { readRepoJson } from './repo.js';
import { blobGetJson, KEYS } from './blob.js';

export async function loadRegistry() {
  const reg = await readRepoJson('bots/registry.json');
  if (!reg || !Array.isArray(reg.bots)) throw new Error('bots/registry.json missing or invalid');
  return reg;
}

export async function loadOverrides() {
  const o = await blobGetJson(KEYS.overrides.prefix);
  return o && typeof o === 'object'
    ? { enabled: {}, dismissedNV: [], socialApproved: [], ...o }
    : { enabled: {}, dismissedNV: [], socialApproved: [] };
}

/** Registry bots with runtime enabled-overrides applied. */
export async function loadBots() {
  const [reg, overrides] = await Promise.all([loadRegistry(), loadOverrides()]);
  const bots = reg.bots.map(b => ({
    ...b,
    enabled: overrides.enabled[b.id] !== undefined ? !!overrides.enabled[b.id] : b.enabled !== false,
    enabledSource: overrides.enabled[b.id] !== undefined ? 'override' : 'registry',
  }));
  return { registry: reg, overrides, bots };
}

/**
 * Order bots so every bot runs after its dependsOn entries. dependsOn: ["*"]
 * means "after everything" (the alerts bot). Dependency ordering never GATES
 * execution — a failed dependency does not block dependents; they run with
 * whatever data is already in Blob from the last good run.
 */
export function orderBots(bots) {
  const last = bots.filter(b => (b.dependsOn || []).includes('*'));
  const rest = bots.filter(b => !(b.dependsOn || []).includes('*'));
  const byId = new Map(rest.map(b => [b.id, b]));
  const ordered = [];
  const state = new Map(); // id -> 'visiting' | 'done'
  const visit = (b) => {
    if (state.get(b.id) === 'done') return;
    if (state.get(b.id) === 'visiting') throw new Error(`dependsOn cycle at "${b.id}"`);
    state.set(b.id, 'visiting');
    for (const dep of b.dependsOn || []) {
      const d = byId.get(dep);
      if (d) visit(d);
    }
    state.set(b.id, 'done');
    ordered.push(b);
  };
  for (const b of rest) visit(b);
  return [...ordered, ...last];
}
