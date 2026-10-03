# dsh-subagent-pin

**English** | [简体中文](README.md)

> A Host plugin for DeepSeek Harness, three rows from one package: it makes the models checked in the Settings subagent-model row the default route of every fresh subagent delegation that names no route of its own (a delegation that names `provider` or `model` passes through untouched); it sends **each conversation's own** id in the `x-opencode-session` header OpenCode Go requires; and while Agent Teams owns `send_message`, it restores id-addressed messaging and interrupt for continuable subagents. Installed as a bundle into a profile (in this environment: profile `desktop`, rows `subagent-pin`, `opencode-header` and `subagent-steer`); disabling it restores the original shape. The third row is a fix-forward patch carrying a deletion condition (delete it once upstream fixes the collision — see "Subagent steering"), not a feature.

## Why it is needed

The Settings row for the subagent model is an allow-list plus a discovery tool: it constrains a route that is named explicitly, but it never steers a delegation to a listed model. A child's options always spread the parent's route first, and the allow-list check only fires when a model-facing choice occurred (in the source's own words: *Pure inheritance remains outside this policy because no model-facing choice occurred*), so a delegation that names no model field runs the main agent's model; teammates, workflow `agent()` and nested delegations have no model input at all and can only inherit. The setting looks applied while the child keeps running the main agent's model.

Turning the checkmarks into the default of every delegation is only possible inside the Host: the one point all four delegation paths share — the delegation tools, teammates, workflow and nested delegations — is `ctx.subagents.start()` / `startContinuable()`, which neither tool configuration nor the preset plane fully reaches. This plugin is a Host plugin wrapped around exactly those two methods, injecting the route before the provider resolves the child's options. The injected route freezes into the child's `subagent/descriptor` and survives cold resume.

## Install

1. `git clone https://github.com/Edmund724/dsh-subagent-pin.git <clone directory>`, then run `npm install` in it
2. In the `dependencies` of `~/.dsh/profiles/<profile>/package.json`, write `"dsh-subagent-pin": "link:<absolute clone path>"`
3. Append the mount row to `~/.dsh/profiles/<profile>/cordis.patch.yml` — the row name is **that row's own address** (DSH reads its title, description, and icon from it, so `subagent-pin` mounts `…/subagent-pin` rather than the package root); the row's `config` is this plugin's settings form: `source` / `defaultModel` / `reasoningEffort` — the Settings page writes exactly it; omit it and every value is the schema default:

```yaml
- id: subagent-pin
  name: 'dsh-subagent-pin/subagent-pin'
  config:
    source: settings
```

The same package also inserts two more rows, `opencode-header` and `subagent-steer` (a section each below): installing this package through `dsh.profile.bundles` brings them along, and a hand-written mount row follows the shape above with no `config`.

All three rows draw their own icons — `subagent-pin` shows the pin (the package root's `icon.svg`), `opencode-header` shows the OpenCode mark (the `opencode-header.icon.svg` its own address exports through `opencode-header.package.json`: the official geometry, this package's blue), and `subagent-steer` shows a target node with an arrow leaving it (the same mechanism through `subagent-steer.package.json` / `subagent-steer.icon.svg`). DSH reads the `icon` of each address's own `package.json`, so different addresses can draw different marks; one icon shared by several rows leaves the cards distinguishable by title alone.

4. Run `pnpm install` in `~/.dsh/profiles/<profile>`, then restart the Harness

Update: `git pull && npm install` → restart the Harness (a host plugin caches its module generation by package name, so only a restart loads a new one). To go back to the npm channel, write the published version back into the dependency and run pnpm install again.

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

## The OpenCode Go session header

OpenCode Go requires every inference request to carry `x-opencode-session`, whose value identifies **that conversation**. The header used to be hard-coded in the route config — one value for the whole machine, shared by every conversation and every child. This package's second row, `opencode-header`, replaces it with a **value derived from** the conversation's id: one SHA-256, first 16 bytes, emitted in the v4 UUID shape. The value depends on nothing but the id, so one conversation always derives the same value and two never collide, while the local session id itself leaves the machine (the gateway has been observed to accept `session-<uuid>` and a bare UUID, which is why the UUID shape is kept). The static header belongs out of the route.

Because the derivation is a pure function, this row **stores nothing**: there is no mapping to write, prune or guard against concurrent writers, and cold resume reads nothing back — DSH persists the session id, and the same id derives the same value. To reconcile a value seen in the gateway's logs with a local session, run the same function (deliberately unsalted, so it stays reproducible).

**An upgrade cannot retire this row either.** Since `0.86.0` pi-ai carries `withOpenCodeSessionHeader`, which sets `x-opencode-session` from that request's own `options.sessionId` and leaves an existing header alone, and DSH ships it from `0.2.0-rc.2` on (pi-ai `^0.87.1`). It **still does not reach this environment's route**: the wrapper is baked into the providers the catalog factories build, while `opencodego` hand-declares `api: anthropic-messages` and builds its provider from the protocol table, never reusing a catalog provider. And even where it is reached it sends the **raw** `options.sessionId`, whereas this row sends a derived value (the raw id never leaves the machine); pi-ai's other session-header path, the per-model `compat` one, does not even use the gateway's header name, and its Responses path cannot be switched off at all (each case in [docs/opencode-header.md](docs/opencode-header.md); what was ruled out, in the [decision record](.agents/notes/implemented/architecture/2026-09-29-升级了也不跟着走.md)).

The scope is narrow: a request is rewritten only when **all three** hold — it runs inside an `llm/stream` scope, its method is `POST`, and its provider id starts with a configured prefix **or** the host it reaches is a configured gateway domain. The gateway's own `GET {baseURL}/models` discovery call, every other provider's traffic, web fetch and MCP all pass through byte-identical. Anything the row cannot judge (a session id the `Headers` constructor refuses, say) also passes through: a bad id must never turn a healthy model call into a hard failure.

The row ships no `config`: the four keys below are all optional and their schema defaults are the install (an empty list claims nothing on that axis):

```yaml
- id: opencode-header
  name: 'dsh-subagent-pin/opencode-header'
  config:
    enabled: true
    headerName: x-opencode-session
    providers: [opencode]
    hosts: [opencode.ai]
```

Why the header can only live in the process transport (with the options ruled out), and how to check it is really in effect, are the last two entries of Further reading.

## Subagent steering

DSH ships two tools named `send_message` with different arguments: the global one from `dsh-tool-subagent-control`, `send_message({ agent_id })`, addresses a continuable subagent or parent by **agent id**, while Agent Teams' scoped one, `send_message({ target })`, addresses a **teammate name** into **every Team member's agent scope** (the Lead included). The Agent Teams profile layer this environment mounts disables the global row outright (`tool-subagent-control: disabled: true` in `@deepseek-ai/dsh-experimental-agent-team-profile`); where both are mounted, the tools registry resolves the **nearest scope** instead — either way a member cannot reach a subagent by id. And `subagent` / `subagent_fork` still return that id and still tell the model, unconditionally, to continue the child with `send_message`, so the id the model was just handed is unaddressable: the call dies with `active teammate "<uuid>" not found`.

The third row, `subagent-steer`, restores that dead end, in three parts: `send_subagent_message({ agent_id, message })` and `interrupt_subagent({ agent_id })` carry names of their own, so no scope collision is involved; a global guard denies only when the scope resolves the name-addressed `send_message` **and** the target is neither a live teammate name nor `lead`, naming `list_agents` and `send_subagent_message` so the dead end becomes a redirection; and a systemPrompt section speaks only while `send_subagent_message` is visible to that scope, stating the split in one sentence. This row **renames nothing, lifts no shadow and edits no other package's tool description** — it only adds names, denies, and appends one sentence.

Boundaries: the service layer honours direct continuable parent/child pairs only (a non-direct relation throws `UNAUTHORIZED`, a one-shot child is not resumable: `NOT_RESUMABLE`); the row abstains silently when the `agentTeams` service is absent (and then `send_message` is not the name-addressed one either); the "wrong teammate name" error text becomes clearer and longer, which a deployment matching that exact text needs to know. The row ships **no `config`** (there are no knobs, and `subagent-steer.js` exports no `Config`), so its Config status showing `absent` in the Plugin Manager is expected.

### When to delete this row

Any one of these retires it — delete the row together with its code, tests and documentation:

- `send_message`'s schema accepts both `target` and `agent_id`, or the Team version takes another name;
- the `subagent` / `subagent_fork` description learns the same scope check the tool's return guidance already performs, instead of unconditionally pointing at `send_message`;
- the tools registry starts diagnosing or rejecting a cross-scope name collision with different schemas.

## Config

The shipped config is the `subagent-pin` section of [`cordis.patch.yml`](cordis.patch.yml): `source: settings`, with neither `defaultModel` nor `reasoningEffort`. The field-level authority is the `Config` the route row exports (`config-schema.js`): DSH validates the whole row against it before activation, with a field path in the message, and `Config.listConfigs` projects it into JSON Schema — query it before writing a config. The session-header row's own interface lives in `opencode-header.js`; its keys and defaults are in the section above. The steering row has no interface to query — it exports no `Config`, so it has no writable key.

The two blocks below are **examples: every writable key**, not the shipped content. Example one, the default mode — the route follows Settings:

```yaml
- id: subagent-pin
  name: 'dsh-subagent-pin/subagent-pin'
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
  name: 'dsh-subagent-pin/subagent-pin'
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

Disable `dsh-subagent-pin` with `plugin_manager`'s `set_bundle`, or delete it with `remove_bundle`. Disabling disposes the wrapper in the running process: the seam is unwrapped and children inherit the delegating agent's route again. The steering row's three registrations (two tools, its guard, its prompt section) hang on the Host's effects too and are disposed with the row, so `send_message` returns to name-only addressing that cannot reach an agent id. No profile patch and no preset was modified for this plugin; removing it leaves the composition exactly as it was.

## Further reading

- [The seam and the Host contract](docs/seam.md) — why the wrapper lives on descriptors, what activation checks, and what a capability downgrade warns about.
- [Tests and live checks](docs/verification.md) — the 190 unit tests by file, how to use `verify`, and the checklist to run after a Harness upgrade.
- [The OpenCode Go session header](docs/opencode-header.md) — the header row's scope, where its value comes from, its four config keys and how to check it.
- [The glossary](CONTEXT.md) — the four decisions and the two exemption reasons; read it before touching the policy.
