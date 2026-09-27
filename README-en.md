# @local/dsh-subagent-pin

**English** | [简体中文](README.md)

Host plugin that gives every **fresh** subagent delegation a route — but only one
that names no route of its own. The route list is the models checked in Settings
(`subagent-model-selection-settings`), re-read on every delegation: a delegation
that names no route (which is every teammate, workflow `agent()` and nested
delegation) gets the default entry — `config.defaultModel`, or the first listed
model when unset. A request that names `provider` or `model` itself is passed
through untouched: the plugin does not consult the list, does not rewrite it and
does not throw — the route is the caller's business. It is installed as a bundle
in a profile (in this environment: profile `desktop`, bundle
`@local/dsh-subagent-pin`, row `subagent-pin`).

## What you get without this plugin

The Settings row for the subagent model is an **allow-list plus a discovery
tool**; on its own it never steers a delegation to that model. So even with a
subagent model checked in Settings, children easily run on the main agent's
model, and the setting is effectively a no-op:

- `resolveChildAgentOptions(parent, requested, childDepth)` spreads the
  **parent's provider/model** first; `requested` (the route named on this call)
  only overrides. When the caller names no model, the child is the main agent's
  model.
- The allow-list check, `assertAllowedModelSelection`, only applies when a
  model-facing choice actually occurred — its own comment says: *Pure inheritance
  remains outside this policy because no model-facing choice occurred*.
  Inheriting a route is not constrained by Settings at all.
- `list_subagent_models` merely tells the model which routes are allowed; whether
  one gets used depends on the model writing `provider`/`model` into every single
  call. Omit it once and the delegation silently falls back to the main agent's
  model, with no warning.
- Paths with no model input at all — `agentTeams.spawnTeammate`, workflow
  `agent()`, nested delegations — always inherit.

Net effect: the setting looks like it worked (a child does run), while the child
runs the main agent's model. This plugin closes that gap: it injects the route
before the provider resolves child options, so the model checked in Settings
actually applies to every fresh delegation that names no route of its own.

## Why a Host plugin

The delegation *tools* (`subagent`, `subagent_fork`) take a route from
`tool-subagent.agentOptions`, but that config exists only on the tools.
`agentTeams.spawnTeammate`, workflow `agent()` and nested delegations call
`ctx.subagents` directly and inherit the delegating agent's route; the Agent
Teams service has no model input at all and `workflow-ptc`'s Config carries only
a provider *name*. Preset-plane changes therefore cannot reach those paths.

This plugin wraps the one seam they all share — `ctx.subagents.start()` and
`ctx.subagents.startContinuable()` — before the provider resolves child options.
The injected `request.agentOptions` becomes the child's real route, is recorded
in the child's `subagent/descriptor`, and survives cold resume (which reads that
descriptor back).

## How the seam works (read before changing this file)

Reading `ctx.subagents` does not hand back the service instance: Cordis returns a
tracing proxy whose **function reads are re-wrapped on every access**. A wrapper
can therefore never recognize itself by comparing function values — an identity
check silently fails and the wrapper is never removed. Only property
*descriptors* are stable, and `defineProperty` through that proxy lands on the
shared instance every consumer reads.

The shipped `start`/`startContinuable` are prototype methods, so a wrapper is an
*own shadow*: deleting the property exposes the original method again. Both
activation and disposal work on shadows:

- activation deletes a shadow a previous activation left behind and logs a
  warning, so a crashed or replaced generation cannot stack wrappers;
- disposal deletes its own shadow (or, for a service whose methods are own
  properties, puts the captured property back), so **disabling the plugin always
  returns the service to its unwrapped shape**.

If the seam is missing (no `start`, or a non-extensible instance) activation
fails loudly and the row shows as failed instead of silently leaving children on
the parent route.

## Model source

The Settings row is a **list**: it exists so a model-facing `subagent` call may
name one of those routes, and nothing in DSH ever picks from it — pure
inheritance is not constrained by it at all. So this plugin takes over the
delegations that name nothing (teammates, workflow `agent()`, nested ones) and
fills in the **default entry** of the list:

- The default is the **first** model of the Settings list; to pin it to another
  listed model, set `defaultModel` in this row's config (it must be in the
  current list, or the delegation that names no route fails).
- List order is storage order (the UI keeps stored routes first and appends
  newly checked ones), so `defaultModel` is what makes the default independent
  of it.

That read happens on every delegation, so re-checking a model applies to the
next child with no restart — fresher than the shipped `subagent` tool, which
samples the list when a session receives its delegation tools.

While the row allows zero models, is disabled, or is not composed, every fresh
delegation **that names no route** fails with a message naming the fix. That is
deliberate: a child with no route of its own must never silently fall back to the
delegating agent's route. A delegation that names its own route is unaffected —
the list decides a default, it is not a licence. `source: pinned` is the escape
hatch for a Host without that row.

## Policy

| Delegation | Result |
|---|---|
| Fresh child (`spawn`), no model fields | Filled with the list's default (`defaultModel`, else the first model) |
| Fresh child, only `reasoning_effort` given | The default route, caller's effort kept — effort is not a named route |
| Any child that names `provider` or `model` | **Passed through untouched**: the list is not consulted, nothing is rewritten, nothing throws |
| A delegation that names no route, while the Settings row allows 0 models, is disabled, is absent, or rejects its own list | **Throws**, naming the fix |
| A delegation that names no route, with a configured `defaultModel` outside the current list | **Throws**, naming the fix |
| A delegation that names no route, on a fork-class provider (`inheritsParentContext`) | Left on the inherited route, so the reused conversation prefix stays cacheable |
| A delegation that names no route, on a provider without the `agentOptions` capability (out-of-process `codex`/`claude-code`) | Left to that provider, reported once as a warning |
| An already existing child (cold resume / follow-up) | Keeps the route written into `subagent/descriptor` at creation — the plugin neither re-checks nor rewrites it, and unchecking a model does **not** revoke it |

**The list decides a default; it is not a licence.** A delegation that names a
route belongs to its caller: it is passed through before the list is ever
consulted, including when the Settings row cannot be read at all. DSH's own
`subagent` tool still rejects a model-named out-of-list route once, against the
list **frozen into that session** — that is tool-layer policy, which this plugin
cannot lift and should not; callers that bypass the tools, such as workflow
`agent()`, are entirely on their own. An already existing child is not a
delegation at all: its route was frozen into the descriptor at creation (see
`CONTEXT.md`, 入口).

Both exceptions (fork and out-of-process) apply only to a delegation that names
no route: pinning either would spend more than it saves, and neither can be
enforced in-process. Teammates spawned with `context: "fork"` fall under the fork
exception; fresh teammates (`freshProvider`, the default) are routed.

## Config

The shipped config (default mode — the route follows Settings):

```yaml
- id: subagent-pin
  name: '@local/dsh-subagent-pin'
  config:
    source: settings            # default
    defaultModel:               # optional; defaults to the first Settings model
      provider: <provider-id>
      model: <model-id>
    reasoningEffort: high       # optional; unset leaves the effort to the provider profile/model default
```

The static mode, for a Host without the Settings row:

```yaml
- id: subagent-pin
  name: '@local/dsh-subagent-pin'
  config:
    source: pinned
    provider: <provider-id>
    model: <model-id>
    reasoningEffort: high          # optional
```

In `settings` mode `provider` and `model` are rejected at activation, so a stale
static route cannot quietly win; `defaultModel` is only meaningful in `settings`
mode and is rejected under `pinned` (the pinned route is already the default). An
unknown config key is an activation error, not a silent no-op — `allowedModels`
is no longer a config key at all: the list decides a default, a delegation that
names a route never consults it, so "which routes an explicit request may name"
stopped being a rule. `reasoningEffort` applies only when the caller names no
effort of its own, and the shipped config no longer sets it: an omitted effort is
resolved by DSH to the model's own default (for the pi-ai adapter, the provider
profile's `reasoning` field), so the plugin no longer pins an effort.

The field-level authority is the `Config` the plugin exports (declared in
`config-schema.js`): DSH validates the whole `config` row against it before
activation, with a field path in the message, and `Config.listConfigs` projects
it into JSON Schema, so an author can query it before writing a config.
Schemastery merges unknown keys and cannot express which keys may appear
together, so the key closure and the mode rules above still run in `plugin.js`
on top of the schema.

## Verified

Every check below is stated so that it can be reproduced on another machine. The
only prerequisite is one Node.js (unit tests: Node ≥ 20;
`tools/read-session.mjs`: Node ≥ 22.15, for `zlib.zstdDecompressSync`) — if
`node` is not on `PATH`, use the runtime the Harness ships with, relative to the
Harness install directory:
`<harness>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`.
The plugin also needs `@deepseek-ai/schemastery` at runtime, so a fresh clone
installs once (`npm install`; the version is pinned in `package.json` to the one
the Harness ships with). The live table additionally needs a running Harness
with this plugin enabled.

Unit tests — 63 tests, no Harness needed (verified on Node 25.8.0). From the
repository root:

```powershell
npm install
node --test
```

(`node --test test/config-schema.test.mjs` runs the config interface alone — it
calls `config-schema.js` directly and needs no double; `node --test
test/route-policy.test.mjs` runs the policy half alone — it calls
`route-policy.js` directly and needs no double; `node --test
test/plugin.test.mjs` runs the seam and composition half.)

They cover the config interface (the native graph, the accepted and rejected
domain, what an omitted field resolves to, and the gaps deliberately left to
`plugin.js`), both sources, the default route itself, a named route passing
through untouched (including half a route, non-string values, and an unreadable
list), `defaultModel` overriding it and the error once it leaves the list, the
per-delegation re-read of the Settings row, every unusable-Settings shape
(0 models, disabled, absent, a list the row itself rejects), both exceptions, the
single-warning rule, both restoration shapes, healing of a shadow a previous
activation left, a wrapper installed over ours, and disposal through a proxy that
re-wraps every function read (the shape that broke the first version).

Live checks — manual, one tool call each, against a Harness with the plugin
enabled. `<default model>` means the list's default entry (`defaultModel` when
configured, otherwise the first model); the routes used as examples here
(`opencodego`, `deepseek-v4.1-flash`) are this environment's — substitute your
own. Session logs live at
`$DSH_HOME/sessions/<project-dir>/<session-id>/session.v4.jsonl.zstd`
(`$DSH_HOME` defaults to `~/.dsh`, on Windows `%USERPROFILE%\.dsh`).

| Check | How | Expected |
|---|---|---|
| Fresh `subagent`, no model fields | `subagent` probe asking for its `{{model}}` | `<default model>` |
| Workflow `agent()`, no model fields | `workflow` probe returning the child's model | `<default model>` |
| Re-checked model | re-check another model in Settings, repeat the workflow probe | the new first model (or `defaultModel`), with no restart |
| Several models checked, one named | check two models, name the second in a `subagent` call | the child runs the second model, no error |
| Configured `defaultModel` | point `defaultModel` at the second listed model, repeat the workflow probe | the child runs `defaultModel` |
| Continuable child (the Agent Teams seam) | `subagent` with `run_in_background: true`, then `node tools/read-session.mjs <child session log>` | `subagent/descriptor`: `"mode":"continuable","agentProvider":"<provider-id>","agentModel":"<default model>"` |
| Named route outside the list | workflow `agent()` naming a route outside the list (the `subagent` tool path is rejected by DSH itself first, so it cannot show this plugin) | the child **runs that route unchanged**; the plugin does not throw |
| Lead unaffected | `node tools/read-session.mjs <lead session log> request` | `request/header` keeps the Lead's own route |
| Disabled = unchanged | disable the bundle, then run a probe with an explicit route | the child runs that explicit route: nothing is wrapped |
| Projection contract after a Harness upgrade (check this row first) | query `Config.listConfigs` with `entry: include:subagent-pin` | `status: "schema"` and `limitations: []`; `provider` carries `minLength: 1`, the nested `defaultModel` carries `required: [provider, model]`, `source` carries `default: "settings"` |

The last row is what to look at after upgrading the Harness. `Config` uses this
repository's own `@deepseek-ai/schemastery` (pinned exactly in `package.json`),
and validation never goes through the Harness copy, so **a version difference
alone will not break the plugin**. But the new Host's `createConfigProjector`
reads our graph's node shape (`type`/`meta`/`dict`/`inner`/`list`) under a
cross-version contract, and a changed convention shows up right here: a
non-empty `limitations` means the projection degraded, and a `status` other than
`schema` means the new Host rejects the graph. If that happens, move
`dependencies` to the version the Harness ships (in this environment `3.18.4`;
it exists only inside the asar, at
`/dsh/node_modules/@deepseek-ai/schemastery/package.json`) and re-run the unit
tests plus the whole table above.

`tools/read-session.mjs` reads a durable session log from evidence; it splits the
log's concatenated zstd frames, which a single-shot decompress loses.

Wrapper removal on disable is covered by the unit tests and was observed live in
this environment when an earlier generation of this plugin was disabled: DSH runs
the row's effects on unload, so the shadow is deleted in the running process.

## Changing this plugin

Editing the file has no effect on a running Harness: DSH caches each plugin
module by package name and loads a replacement module generation only in a fresh
Host process. Restart the Harness after a code change, then re-run the table
above.

## Rollback

`plugin_manager` `set_bundle` with `@local/dsh-subagent-pin` disabled, or
`remove_bundle` to delete it. Disabling disposes the wrapper in the running
process: the delegation seam is unwrapped and children inherit the delegating
agent's route again. No profile patch and no preset was modified for this
plugin; removing it leaves the composition exactly as it was.
