# dsh-subagent-pin

**English** | [简体中文](README.md)

> A Host plugin for DeepSeek Harness: it makes the models checked in the Settings subagent-model row the default route of every fresh subagent delegation that names no route of its own, and passes a delegation that names `provider` or `model` through untouched. Installed as a bundle into a profile (in this environment: profile `desktop`, row `subagent-pin`); disabling it restores the original shape.

## Why it is needed

The Settings row for the subagent model is an allow-list plus a discovery tool: it constrains a route that is named explicitly, but it never steers a delegation to a listed model. A child's options always spread the parent's route first, and the allow-list check only fires when a model-facing choice occurred (in the source's own words: *Pure inheritance remains outside this policy because no model-facing choice occurred*), so a delegation that names no model field runs the main agent's model; teammates, workflow `agent()` and nested delegations have no model input at all and can only inherit. The setting looks applied while the child keeps running the main agent's model.

Turning the checkmarks into the default of every delegation is only possible inside the Host: the one point all four delegation paths share — the delegation tools, teammates, workflow and nested delegations — is `ctx.subagents.start()` / `startContinuable()`, which neither tool configuration nor the preset plane fully reaches. This plugin is a Host plugin wrapped around exactly those two methods, injecting the route before the provider resolves the child's options. The injected route freezes into the child's `subagent/descriptor` and survives cold resume.

## Install

1. Run `npm install` in this package directory — the profile only receives a link, so the dependencies are yours to install (`@deepseek-ai/schemastery`). Without them the plugin does not mount, delegations keep inheriting the parent route, and no restart fixes it
2. `plugin_manager`'s `install_bundle`, with `target` set to the absolute directory of this package: it installs the package, attaches it to the profile, and lets the shipped `cordis.patch.yml` insert the `subagent-pin` row (`source: settings`)
3. Restart the Harness, then probe with a `subagent` that names no model field — the child should run the Settings list's default. The checklist is in [Tests and live checks](docs/verification.md)

## Model source

- The default is the list's **first** model (storage order: stored first, newly checked appended); to pin it to another listed model, set `config.defaultModel` — it must be in the current list, or a delegation that names no route fails.
- The list is re-read on every delegation: re-checking a model applies to the next child with no restart (the shipped `subagent` tool only samples the list when a session receives its delegation tools).
- While the list allows zero models, the row is disabled, or it is not composed, every fresh delegation **that names no route** fails with a message naming the fix — it never silently falls back to the delegating agent's route. `source: pinned` is the escape hatch for a Host without that row.

## Policy

| Delegation | Result |
|---|---|
| Fresh child, no model fields | Filled with the list's default |
| Fresh child, only effort given (`agentOptions.reasoningEffort`) | The default route, caller's effort kept — effort is not a named route (the tool layer counts it as an explicit choice; this plugin deliberately does not) |
| `provider` or `model` named | **Passed through untouched**, the list never consulted (including when it cannot be read at all) |
| No route named, and the list is unusable (0 models / disabled / absent / rejected by the row itself) | **Throws**, naming the fix |
| No route named, `defaultModel` outside the current list | **Throws**, naming the fix |
| No route named, fork-class provider (`inheritsParentContext`) | Left on the inherited route, so the reused prefix stays cacheable |
| No route named, a provider without the `agentOptions` capability (out-of-process `codex`/`claude-code`) | Left to that provider, reported once as a warning |
| An already existing child (cold resume / follow-up) | Keeps the route frozen into `subagent/descriptor` at creation; unchecking a model does **not** revoke it |

**The list decides a default; it is not a licence.** A delegation that names a route belongs to its caller: DSH's own `subagent` tool still rejects an out-of-list named route once, against the list frozen into that session — that is tool-layer policy, which this plugin cannot lift and should not; callers that bypass the tools, such as workflow `agent()`, are entirely on their own. Both exceptions (fork and out-of-process) apply only to a delegation that names no route: a teammate spawned with `context: "fork"` falls under the fork exception, while a fresh teammate (the default `freshProvider`) is routed.

## Config

The shipped config is the section in [`cordis.patch.yml`](cordis.patch.yml): `source: settings`, with neither `defaultModel` nor `reasoningEffort`. The field-level authority is the `Config` the plugin exports (`config-schema.js`): DSH validates the whole row against it before activation, with a field path in the message, and `Config.listConfigs` projects it into JSON Schema — query it before writing a config.

The two blocks below are **examples: every writable key**, not the shipped content. Example one, the default mode — the route follows Settings:

```yaml
- id: subagent-pin
  name: '@edmund724/dsh-subagent-pin'
  config:
    source: settings            # default
    defaultModel:               # optional; defaults to the first Settings model
      provider: <provider-id>
      model: <model-id>
    reasoningEffort: high       # optional; one of DSH's seven thinking levels; unset leaves it to the provider profile/model default
```

Example two, the static mode, for a Host without the Settings row:

```yaml
- id: subagent-pin
  name: '@edmund724/dsh-subagent-pin'
  config:
    source: pinned
    provider: <provider-id>
    model: <model-id>
    reasoningEffort: high          # optional; one of DSH's seven thinking levels
```

The rules (Schemastery merges unknown keys and cannot express which keys may appear together, so this part runs in `plugin.js` at activation):

- `settings` mode rejects `provider`/`model`, so a stale static route cannot quietly win; `pinned` mode requires both and rejects `defaultModel` (the pinned route already is the default).
- An unknown config key is an activation error, not a silent no-op — `allowedModels` is no longer a config key at all.
- `reasoningEffort` applies only when the caller names no effort, and its value must be one of the seven thinking levels (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`, the same vocabulary as the pi-ai profile's `reasoning` field); anything else is an **activation error** carrying the field path. The key only states which effort is wanted: whether the model it lands on accepts it is DSH's answer on the request path (rejected with provider/model/effort named, never clamped, never dropped) — this plugin neither validates nor rewrites it, and never changes the route because of it.

## Changing this plugin

Editing the file has no effect on a running Harness: DSH caches each plugin module by package name and loads a replacement module generation only in a fresh Host process. Restart the Harness after a code change, then re-run the checklist in [Tests and live checks](docs/verification.md).

## Rollback

Disable `@edmund724/dsh-subagent-pin` with `plugin_manager`'s `set_bundle`, or delete it with `remove_bundle`. Disabling disposes the wrapper in the running process: the seam is unwrapped and children inherit the delegating agent's route again. No profile patch and no preset was modified for this plugin; removing it leaves the composition exactly as it was.

## Further reading

- [The seam and the Host contract](docs/seam.md) — why the wrapper lives on descriptors, what activation checks, and what a capability downgrade warns about.
- [Tests and live checks](docs/verification.md) — the 129 unit tests by file, how to use `verify`, and the checklist to run after a Harness upgrade.
- [The glossary](CONTEXT.md) — the four decisions and the two exemption reasons; read it before touching the policy.
