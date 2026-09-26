# @local/dsh-subagent-pin

**English** | [简体中文](README.md)

Host plugin that pins every **fresh** subagent delegation to one LLM route, with
no prompt cooperation from the model. By default that route is the model checked
in Settings (`subagent-model-selection-settings`), read fresh on every
delegation. It is installed as a bundle in a profile (in this environment:
profile `desktop`, bundle `@local/dsh-subagent-pin`, row `subagent-pin`).

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

The Settings row is a **permission** list, not a candidate pool: it exists so a
model-facing `subagent` call may name one of those routes, and nothing in DSH
ever picks from it. So this plugin requires it to allow **exactly one** model and
pins that one. That read happens on every delegation, so re-checking a model
applies to the next child with no restart — fresher than the shipped `subagent`
tool, which samples the list when a session receives its delegation tools.

While the row allows zero or several models, is disabled, or is not composed,
**every** fresh delegation fails with a message naming the fix. That is
deliberate: an unauthorized child must never silently fall back to the
delegating agent's route. `source: pinned` is the escape hatch for a Host
without that row.

## Policy

| Delegation | Result |
|---|---|
| Fresh child (`spawn`), no model fields | Pinned to the single model the Settings row allows |
| Fresh child, only `reasoning_effort` given | Pinned route, caller's effort kept |
| Any child, explicit route equal to that model | Left exactly as requested |
| Any child, explicit route for any other model | **Throws** — the delegation fails visibly |
| Settings row allows 0 or 2+ models, disabled, or absent | **Throws** on every fresh delegation, naming the fix |
| Fork-class provider (`inheritsParentContext`) | Left on the inherited route, so the reused conversation prefix stays cacheable |
| Provider without the `agentOptions` capability (out-of-process `codex`/`claude-code`) | Left to that provider, reported once as a warning |

The fork exception and the out-of-process exception are deliberate: pinning
either would spend more than it saves, and neither can be enforced in-process.
Teammates spawned with `context: "fork"` fall under the fork exception; fresh
teammates (`freshProvider`, the default) are pinned. Both exceptions still
validate an *explicit* route against the checked model.

## Config

The shipped config (default mode — the route follows Settings):

```yaml
- id: subagent-pin
  name: '@local/dsh-subagent-pin'
  config:
    source: settings     # default
    reasoningEffort: high  # optional
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
    allowedModels:                 # optional; defaults to the pinned route
      - provider: <provider-id>
        model: <model-id>
```

In `settings` mode `provider`, `model` and `allowedModels` are rejected at
activation, so a stale static route cannot quietly win; in `pinned` mode
`allowedModels` must contain the pinned route. An unknown config key is an
activation error, not a silent no-op. `reasoningEffort` is applied only when the
caller names no effort of its own — unset it here if you re-check a model that
does not advertise that effort.

## Verified

Every check below is stated so that it can be reproduced on another machine. The
only prerequisite is one Node.js (unit tests: Node ≥ 20;
`tools/read-session.mjs`: Node ≥ 22.15, for `zlib.zstdDecompressSync`) — if
`node` is not on `PATH`, use the runtime the Harness ships with, relative to the
Harness install directory:
`<harness>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`.
The live table additionally needs a running Harness with this plugin enabled.

Unit tests — 39 tests, no Harness needed (verified on Node 25.8.0). From the
repository root:

```powershell
node --test
```

(`node --test test/plugin.test.mjs` names the same file explicitly.)

They cover both sources, the pin, the per-delegation re-read of the Settings
row, every unusable-Settings shape (0 models, 2+ models, disabled, absent, a
list the row itself rejects), both exceptions, the explicit-route error, the
single-warning rule, both restoration shapes, healing of a shadow a previous
activation left, a wrapper installed over ours, and disposal through a proxy
that re-wraps every function read (the shape that broke the first version).

Live checks — manual, one tool call each, against a Harness with the plugin
enabled. `<checked model>` means the one model the Settings row allows; the
routes used as examples here (`opencodego`, `deepseek-v4.1-flash`) are this
environment's — substitute your own. Session logs live at
`$DSH_HOME/sessions/<project-dir>/<session-id>/session.v4.jsonl.zstd`
(`$DSH_HOME` defaults to `~/.dsh`, on Windows `%USERPROFILE%\.dsh`).

| Check | How | Expected |
|---|---|---|
| Fresh `subagent`, no model fields | `subagent` probe asking for its `{{model}}` | the model checked in Settings |
| Workflow `agent()`, no model fields | `workflow` probe returning the child's model | the model checked in Settings |
| Re-checked model | re-check another model in Settings, repeat the workflow probe | the newly checked model, with no restart |
| Several models checked | check two models, repeat the workflow probe | a visible error naming the checked count |
| Continuable child (the Agent Teams seam) | `subagent` with `run_in_background: true`, then `node tools/read-session.mjs <child session log>` | `subagent/descriptor`: `"mode":"continuable","agentProvider":"<provider-id>","agentModel":"<checked model>"` |
| Explicit route other than the checked model | `subagent` with an explicit provider/model other than the checked one | error naming the route and the allowed route |
| Lead unaffected | `node tools/read-session.mjs <lead session log> request` | `request/header` keeps the Lead's own route |
| Disabled = unchanged | disable the bundle, then run a probe with an explicit route | the child runs that explicit route: nothing is wrapped |

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
