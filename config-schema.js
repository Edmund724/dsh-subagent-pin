/**
 * The row's configuration interface, declared once as a native Schemastery graph.
 *
 * This is the only machine-readable statement of what a `config` row may
 * contain. DSH reads it as data: a plugin that exports `Config` is projected by
 * `Config.listConfigs` into JSON Schema, and cordis validates the row's `config`
 * against it before `apply()` runs (`fiber.ts` `resolveConfig`, so a bad row
 * fails activation with the offending path). Without this export the same
 * knowledge would exist only as the control flow of `resolveConfig()` in
 * `plugin.js`, and the platform's own instruction — query a plugin's schema
 * before writing its config — would find nothing.
 *
 * Two properties of Schemastery decide the split with `plugin.js`:
 *
 * - `z.object` merges unknown keys instead of rejecting them, and `z.union`
 *   takes the first branch that resolves. So *which* keys may appear
 *   *together* is not expressible here; `plugin.js` owns that closure.
 * - `z.object` carries a `{}` default of its own. `.default(undefined)` clears
 *   it, so "the author wrote nothing" stays distinguishable from "the author
 *   wrote an empty value" — which the exclusivity rules depend on.
 *
 * Every field here belongs to the row itself. In `settings` mode only `source`,
 * `reasoningEffort` and `defaultModel` may be set: the routes come from the
 * Settings row of `@deepseek-ai/dsh-tool-subagent/model-selection-settings`,
 * read fresh for every delegation.
 *
 * @module @local/dsh-subagent-pin/config-schema
 */

import z from '@deepseek-ai/schemastery'

/** One `{ provider, model }` route: both fields present, both non-empty. */
const route = z.object({
  provider: z.string().min(1).required().description('LLM provider id, e.g. "opencodego"'),
  model: z.string().min(1).required().description('Model id that provider accepts, e.g. "space-bunny-free"'),
})

/**
 * The accepted shape of this row's `config`.
 *
 * `source` picks the mode: `settings` follows the Settings row (and forbids the
 * static route fields), `pinned` uses `provider`/`model` from here and requires
 * them. `plugin.js` enforces both rules; this graph declares every field they
 * range over.
 */
// `.default(undefined)` below clears Schemastery's own `{}` default: the policy
// reads "unset" as a state of its own.
export const Config = z.object({
  source: z.union([z.const('settings'), z.const('pinned')]).default('settings').description('Where the default route for an unspecified delegation comes from: the Settings row, or this row.'),
  provider: z.string().min(1).description('Required with source "pinned"; forbidden with source "settings".'),
  model: z.string().min(1).description('Required with source "pinned"; forbidden with source "settings".'),
  reasoningEffort: z.string().description('Reasoning effort handed to every pinned delegation, e.g. "high".'),
  defaultModel: route.default(undefined).description('Route an unspecified delegation uses in "settings" mode. Must be one the Settings row lists; forbidden with source "pinned".'),
})

/** The config keys this row understands, from the one place that declares them. */
export const KNOWN_KEYS = Object.keys(Config.dict)
