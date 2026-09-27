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

## The seam (read CONTEXT's "Host contract" before changing this file)

This plugin wraps `ctx.subagents.start()` / `startContinuable()` — Cordis
`intercept` supplies per-service *config* only, and the `subagents` Config carries
no route field, so those two methods are the one place every delegation path
meets. Reading `ctx.subagents` hands back a tracing proxy: function values have no
stable identity, only property *descriptors* do — so a wrapper is an *own shadow*,
and both activation and disposal work on descriptors rather than on a captured
function identity. Activation first drops a shadow a previous generation left
behind, with a warning, and **disabling the plugin always returns the service to
its unwrapped shape**.

Every Host shape the seam needs is declared once in `host-contract.js` and checked
once at activation: a missing seam fails activation and the row shows as failed
instead of silently leaving children on the parent route, while a capability
downgrade (`getProvider` absent, a provider record missing a field) only logs one
warning naming what it costs — the promise that matters, a route-unspecified
delegation never keeping the inherited route, still holds. The full reasoning, the
shape list and the domain words are in `CONTEXT.md` under "Host contract".

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
| Fresh child, only effort given (tool parameter `reasoning_effort`, internally `agentOptions.reasoningEffort`) | The default route, caller's effort kept — effort is not a named route (the tool layer counts it as an explicit choice; this plugin deliberately does not) |
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

The shipped config is the section in [`cordis.patch.yml`](cordis.patch.yml):
`source: settings`, with neither `defaultModel` nor `reasoningEffort` — a
delegation that names no route takes the first model of the Settings list, and the
effort is left to the model's own default.

The field-level authority is the `Config` the plugin exports (declared in
`config-schema.js`): DSH validates the whole `config` row against it before
activation, with a field path in the message, and `Config.listConfigs` projects it
into JSON Schema, so an author can query it before writing a config.

The two blocks below are **examples: every writable key** — not the shipped
content. Example one, default mode — the route follows Settings:

```yaml
- id: subagent-pin
  name: '@local/dsh-subagent-pin'
  config:
    source: settings            # default
    defaultModel:               # optional; defaults to the first Settings model
      provider: <provider-id>
      model: <model-id>
    reasoningEffort: high       # optional; one of DSH's seven thinking levels; unset leaves the effort to the provider profile/model default
```

Example two, the static mode, for a Host without the Settings row:

```yaml
- id: subagent-pin
  name: '@local/dsh-subagent-pin'
  config:
    source: pinned
    provider: <provider-id>
    model: <model-id>
    reasoningEffort: high          # optional; one of DSH's seven thinking levels
```

In `settings` mode `provider` and `model` are rejected at activation, so a stale
static route cannot quietly win; `defaultModel` is only meaningful in `settings`
mode and is rejected under `pinned` (the pinned route is already the default). An
unknown config key is an activation error, not a silent no-op — `allowedModels`
is no longer a config key at all: the list decides a default, a delegation that
names a route never consults it, so "which routes an explicit request may name"
stopped being a rule. `reasoningEffort` applies only when the caller names no
effort of its own, and its value must be one of DSH's seven thinking levels
(`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`, the same vocabulary as the
pi-ai profile's `reasoning` field): anything else is an **activation error**
carrying the field path, instead of a failure that only shows up on the request
path. The shipped config does not set it: an omitted effort is resolved by DSH to
the model's own default (for the pi-ai adapter, the provider profile's
`reasoning` field). **The key states which effort is wanted; it does not promise
the model it lands on accepts it** — that answer belongs to DSH on the request
path, where an unsupported effort is rejected with the provider, model and effort
named, never clamped and never dropped. This plugin neither validates nor
rewrites it, and never changes the route because of it. Schemastery merges unknown keys and cannot express
which keys may appear together, so the key closure and the mode rules above still
run in `plugin.js` on top of the schema.

## Verified

Every check below is stated so that it can be reproduced on another machine. The
only prerequisite is one Node.js (**this repository's tests and tools all need
Node ≥ 22.15**: `tools/read-session.mjs` uses `zlib.zstdDecompressSync`, and the
tests build frames with `zlib.zstdCompressSync`; that floor is what `engines` in
`package.json` states. The plugin itself loads no Node from this repository — it
runs on the runtime the Harness ships with) — if
`node` is not on `PATH`, use the runtime the Harness ships with, relative to the
Harness install directory:
`<harness>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`.
The plugin also needs `@deepseek-ai/schemastery` at runtime, and the contract
tests run against the real Host libraries (`@deepseek-ai/cordis`,
`@deepseek-ai/dsh-app-boot`); all three are pinned by exact version in
`package.json` (test-only — nothing loads them at runtime), so a fresh clone
installs once with `npm install`. The live table additionally needs a running
Harness with this plugin enabled.

Unit tests — 108 tests (`config-schema` 10 · `route-policy` 32 · `plugin` 27 ·
`host-contract` 15 · `docs` 5 · `read-session` 5 · `verify-session` 9 ·
`package` 5), no Harness needed (verified on Node 25.8.0). From
the repository root:

```powershell
npm install
npm test
```

(`npm test` is `node --test "test/*.test.mjs"`: the target is an explicit glob
rather than Node's default test glob, and test files are always named
`test/*.test.mjs` — doubles and helpers live in `test-support/`. The tests,
`test-support/` and the `.agents/notes` decision records are all in `files`, so
`npm install && npm test` in a packed copy prints the same number.)

(`node --test test/config-schema.test.mjs` runs the config interface alone — it
calls `config-schema.js` directly and needs no double; `node --test
test/route-policy.test.mjs` runs the policy half alone — it calls
`route-policy.js` directly and needs no double; `node --test
test/plugin.test.mjs` runs the seam and composition half on real Cordis doubles
(`test-support/host-doubles.mjs`); `node --test test/host-contract.test.mjs` runs
the Host contract alone — it asserts the proxy, the effect, Schemastery and the
projection against the pinned libraries, without the plugin; `node --test
test/docs.test.mjs` runs the document guard alone — it reads the two READMEs and
`CONTEXT.md` as text and asserts that their config keys are declared by the
schema, their decision words are in the glossary, their relative links and the
repository paths their prose writes by hand exist and ship, and the two READMEs
carry the same section count; `node --test
test/read-session.test.mjs` builds its own logs to exercise the evidence reader
(concatenated zstd frames, an incomplete trailing frame, the CLI's exact filter
and untrimmed printing); `node --test test/verify-session.test.mjs` builds one
run's two logs to exercise the `verify` command below; `node --test
test/package.test.mjs` asserts that every `exports` subpath exists and is shipped
by `files`. None of them goes through the plugin.)

They cover the config interface (the native graph, the accepted and rejected
domain, what an omitted field resolves to, and the gaps deliberately left to
`plugin.js`), both sources, the default route itself, a named route passing
through untouched (including half a route, non-string values, and an unreadable
list), `defaultModel` overriding it and the error once it leaves the list, the
per-delegation re-read of the Settings row, every unusable-Settings shape
(0 models, disabled, absent, a list the row itself rejects), both exceptions, the
single-warning rule, both restoration shapes, healing of a shadow a previous
activation left, a wrapper installed over ours, and disposal through a proxy that
re-wraps every function read (the shape that broke the first version), plus the
Host contract itself: the proxy's three traps and its fresh wrapper per read,
`defineProperty`/`delete` reaching the instance, `ctx.effect` running its callback
immediately and registering the returned disposer, the four Schemastery
behaviours, the Host's `isNativeConfigSchema` and `createConfigProjector` reading
our `Config`, and the activation self-check (a redirected write refuses
activation, an unreadable provider record warns by name). On the evidence side
they cover reading concatenated zstd frames, the CLI's exact filter and untrimmed
printing, `verify`'s route assertions over one run (including a missing child
log, a descriptor disagreeing with its own header, and an expectation outside the
frozen list), and `exports` agreeing with `files` plus the manifest `icon`
existing, shipping, and drawing on the official 36×36 viewBox — every `files`
entry still matching something in the tree.

Live checks — manual, one tool call each, against a Harness with the plugin
enabled. **Producing the evidence cannot be automated** (the logs only exist
after a real run), but reading it is one command: after a row, `npm run verify --
--lead <lead session log>` reads the model list that run froze into its own
`subagent/model-selection-policy`, finds each child's log through
`subagent/catalog` (the Host writes it as a sibling directory named after the
childId), and asserts that every child's `request/header` and continuable
descriptor hold the default route. `--expect`, `--default-model` and
`--lead-expect` supply expectations a log cannot, and `--child` points at a log
elsewhere. It reads no live Settings and starts no Harness — it verifies **that
run**, not now. The `verify` column below is how each row uses it.

`<default model>` means the list's default entry (`defaultModel` when
configured, otherwise the first model); the routes used as examples here
(`opencodego`, `deepseek-v4.1-flash`) are this environment's — substitute your
own. Session logs live at
`$DSH_HOME/sessions/<project-dir>/<session-id>/session.v4.jsonl.zstd`
(`$DSH_HOME` defaults to `~/.dsh`, on Windows `%USERPROFILE%\.dsh`); a session
directory is named either `<uuid>` or `session-<uuid>`, and a run's children sit
beside it as sibling directories.

| Check | verify | How | Expected |
|---|---|---|---|
| Fresh `subagent`, no model fields | default | `subagent` probe asking for its `{{model}}` | `<default model>` |
| Workflow `agent()`, no model fields | default | `workflow` probe returning the child's model | `<default model>` |
| Re-checked model | default | re-check another model in Settings, repeat the workflow probe | the new first model (or `defaultModel`), with no restart |
| Several models checked, one named | `--expect <second route>` | check two models, name the second in a `subagent` call | the child runs the second model, no error |
| Configured `defaultModel` | `--default-model <second route>` | point `defaultModel` at the second listed model, repeat the workflow probe | the child runs `defaultModel` |
| Continuable child (the Agent Teams seam) | default | `subagent` with `run_in_background: true`, then `node tools/read-session.mjs <child session log>` (`verify` also asserts the descriptor agrees with the child's own header) | `subagent/descriptor`: `"mode":"continuable","agentProvider":"<provider-id>","agentModel":"<default model>"` |
| Named route outside the list | `--expect <outside route>` | workflow `agent()` naming a route outside the list (the `subagent` tool path is rejected by DSH itself first, so it cannot show this plugin) | the child **runs that route unchanged**; the plugin does not throw |
| Lead unaffected | `--lead-expect <Lead route>` | examine the same run's lead session log | `request/header` keeps the Lead's own route |
| Disabled = unchanged | — | disable the bundle, then run a probe with an explicit route | the child runs that explicit route: nothing is wrapped |
| Projection contract after a Harness upgrade (check this row first) | — | query `Config.listConfigs` with `entry: include:subagent-pin` (the offline part of this row is asserted in `test/host-contract.test.mjs` against the pinned library; `status` is only observable on the running Host) | `status: "schema"` and `limitations: []`; `provider` carries `minLength: 1`, the nested `defaultModel` carries `required: [provider, model]`, `source` carries `default: "settings"`, `reasoningEffort` carries a seven-level `const` domain |

The last row is what to look at after upgrading the Harness. `Config` uses this
repository's own `@deepseek-ai/schemastery` (pinned exactly in `package.json`),
and validation never goes through the Harness copy, so **a version difference
alone will not break the plugin**. But the new Host's `createConfigProjector`
reads our graph's node shape (`type`/`meta`/`dict`/`inner`/`list`) under a
cross-version contract, and a changed convention shows up right here: a
non-empty `limitations` means the projection degraded, and a `status` other than
`schema` means the new Host rejects the graph.

The contract tests work the same way, only earlier: `test/host-contract.test.mjs`
runs against **three pinned packages** — `@deepseek-ai/schemastery`,
`@deepseek-ai/cordis`, `@deepseek-ai/dsh-app-boot`. They must be the versions the
Harness ships, or the suite tests a different Host. Read the shipped versions
from `/dsh/node_modules/@deepseek-ai/*/package.json` inside the asar (in this
environment: `schemastery` 3.18.4, `cordis` 4.0.4, `dsh-app-boot` 0.1.7-rc.2).
Two cautions: **`npm view <package> version` lies** — it prints the `latest` tag,
and this environment's `dsh-app-boot` is `0.1.0-rc.6`, older than the shipped
`0.1.7-rc.2`, so `devDependencies` must carry exact versions, never ranges; and on
a Harness upgrade, reconcile all three versions, re-run the unit tests, then run
the whole table above. One coupling does **not** ride on a package version:
`THINKING_LEVELS` in `config-schema.js` is the same vocabulary as the pi-ai
profile's `reasoning` field (`z.union(THINKING_LEVELS)` in `llm-pi-ai`) — a level
the Host adds has to be added here, or the schema starts refusing an effort the
Host already knows.

`tools/read-session.mjs` reads a durable session log from evidence: it splits the
log's concatenated zstd frames (a single-shot decompress loses everything after
the first, and a half-written trailing frame costs only its own events), its
second argument selects events whose `type` is **exactly** that string (not a
substring — the old form let `request` also match `request/context` and
`session/title-llm-request`), and it prints every selected event whole, one
parseable JSON object per line (the old 1200-character cut turned a 24k–31k
`request/header` into invalid JSON). To call `verify` from outside the package,
use the `./verify` entry in `exports`; `read-session.mjs` stays an implementation
detail that `verify` imports relatively.

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
