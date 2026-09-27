# @local/dsh-subagent-pin

**English** | [简体中文](README.md)

Host plugin that gives every fresh subagent delegation **that names no route of
its own** a route — the default entry of the models checked in Settings
(`config.defaultModel`, or the first listed model when unset), with the list
re-read on every delegation. A delegation that names `provider` or `model`
itself is passed through untouched: the list is not consulted, nothing is
rewritten, nothing throws. Installed as a bundle into a profile (in this
environment: profile `desktop`, row `subagent-pin`).

## What you get without this plugin

The Settings row for the subagent model is an **allow-list plus a discovery
tool**; on its own it never steers a delegation to a listed model:

- Child options spread the **parent's route** first and the caller's choice only
  overrides — name no model field and the child runs the main agent's model;
- the allow-list check only fires when a model-facing choice occurred (the
  source says it plainly: *Pure inheritance remains outside this policy because
  no model-facing choice occurred*), so pure inheritance is not constrained by
  Settings at all;
- `agentTeams.spawnTeammate`, workflow `agent()` and nested delegations have
  **no model input** and always inherit.

Net effect: the setting looks applied while the child runs the main agent's
model. This plugin injects the route before the provider resolves child options,
so the checked model actually applies to every fresh delegation that names no
route.

## Why a Host plugin

The delegation *tools* (`subagent`, `subagent_fork`) take a route from
`tool-subagent.agentOptions`, but that config exists only on the tools;
teammates, workflow `agent()` and nested delegations call `ctx.subagents`
directly, and the preset plane cannot reach them. The one point all four paths
share is `ctx.subagents.start()` / `startContinuable()`, and that is what this
plugin wraps. The injected `request.agentOptions` is recorded in the child's
`subagent/descriptor` and survives cold resume, which reads it back.

## The seam (read CONTEXT's "Host contract" before changing this file)

Cordis `intercept` supplies per-service *config* only, and the `subagents`
Config carries no route field, so those two instance methods are everything.
Reading `ctx.subagents` yields a tracing proxy: function values are re-wrapped
on every read and only property *descriptors* are stable — a wrapper is
therefore an *own shadow*, and both activation and disposal work on descriptors.
Activation first drops a shadow a previous generation left behind, with a
warning, and **disabling the plugin always returns the service to its unwrapped
shape**.

Every Host shape the seam needs is declared once in `host-contract.js` and
checked once at activation: a missing seam fails activation (the row shows
failed) instead of silently leaving children on the parent route; a capability
downgrade (`getProvider` absent, a provider record missing a field) logs one
warning naming what it costs. The full reasoning, the shape list and the domain
words are in `CONTEXT.md`.

## Model source

- The default is the list's **first** model (storage order: stored first, newly
  checked appended); to pin it to another listed model, set
  `config.defaultModel` — it must be in the current list, or a delegation that
  names no route fails.
- The list is re-read on every delegation: re-checking a model applies to the
  next child with no restart (the shipped `subagent` tool only samples the list
  when a session receives its delegation tools).
- While the list allows zero models, the row is disabled, or it is not composed,
  every fresh delegation **that names no route** fails with a message naming the
  fix — it never silently falls back to the delegating agent's route.
  `source: pinned` is the escape hatch for a Host without that row.

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

**The list decides a default; it is not a licence.** A delegation that names a
route belongs to its caller: DSH's own `subagent` tool still rejects an
out-of-list named route once, against the list frozen into that session — that
is tool-layer policy, which this plugin cannot lift and should not; callers that
bypass the tools, such as workflow `agent()`, are entirely on their own. Both
exceptions (fork and out-of-process) apply only to a delegation that names no
route: a teammate spawned with `context: "fork"` falls under the fork exception,
while a fresh teammate (the default `freshProvider`) is routed.

## Config

The shipped config is the section in [`cordis.patch.yml`](cordis.patch.yml):
`source: settings`, with neither `defaultModel` nor `reasoningEffort`. The
field-level authority is the `Config` the plugin exports (`config-schema.js`):
DSH validates the whole row against it before activation, with a field path in
the message, and `Config.listConfigs` projects it into JSON Schema — query it
before writing a config.

The two blocks below are **examples: every writable key**, not the shipped
content. Example one, the default mode — the route follows Settings:

```yaml
- id: subagent-pin
  name: '@local/dsh-subagent-pin'
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
  name: '@local/dsh-subagent-pin'
  config:
    source: pinned
    provider: <provider-id>
    model: <model-id>
    reasoningEffort: high          # optional; one of DSH's seven thinking levels
```

The rules (Schemastery merges unknown keys and cannot express which keys may
appear together, so this part runs in `plugin.js` at activation):

- `settings` mode rejects `provider`/`model`, so a stale static route cannot
  quietly win; `pinned` mode requires both and rejects `defaultModel` (the
  pinned route already is the default).
- An unknown config key is an activation error, not a silent no-op —
  `allowedModels` is no longer a config key at all.
- `reasoningEffort` applies only when the caller names no effort, and its value
  must be one of the seven thinking levels (`off`/`minimal`/`low`/`medium`/
  `high`/`xhigh`/`max`, the same vocabulary as the pi-ai profile's `reasoning`
  field); anything else is an **activation error** carrying the field path. The
  key only states which effort is wanted: whether the model it lands on accepts
  it is DSH's answer on the request path (rejected with provider/model/effort
  named, never clamped, never dropped) — this plugin neither validates nor
  rewrites it, and never changes the route because of it.

## Verified

The only prerequisite is one Node ≥ 22.15 (`engines` in `package.json`; both
tools need zstd. If `node` is not on `PATH`, use the runtime the Harness ships:
`<harness>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`;
the plugin itself loads no Node from this repository — it runs on the runtime
the Harness ships). The runtime dependency `@deepseek-ai/schemastery` and the
contract tests' real Host libraries (`@deepseek-ai/cordis`,
`@deepseek-ai/dsh-app-boot`) are pinned by exact version in `package.json` (the
latter two are test-only), so a fresh clone installs once with `npm install`.
The tests start no Harness and need no credentials or network; the live checks
additionally need a running Harness with this plugin enabled.

Unit tests — 128 tests (`config-schema` 10 · `route-policy` 32 · `plugin` 29 ·
`host-contract` 17 · `docs` 12 · `read-session` 5 · `verify-session` 9 ·
`package` 5 · `patch` 5 · `maintainer-docs` 3 · `tarball` 1; verified on Node
25.8.0):

```powershell
npm install
npm test
```

`npm test` is `node --test "test/*.test.mjs"` (an explicit glob; doubles and
helpers live in `test-support/`). The tests, `test-support/` and the
`.agents/notes` decision records are all in `files`, so `npm install && npm
test` in a packed copy prints the same number. Each file runs alone (`node
--test test/<name>.test.mjs`); responsibilities:

- `test/config-schema.test.mjs` — the config interface: the native graph, the
  accepted/rejected domain, what an omitted field resolves to, and the gaps
  deliberately left to `plugin.js`;
- `test/route-policy.test.mjs` — the policy: both sources, the default itself,
  a named route passing through untouched (including half a route, non-string
  values, an unreadable list), `defaultModel` overriding and expiring, every
  unusable-Settings shape, both exemptions;
- `test/plugin.test.mjs` — the seam and the composition: install on real Cordis
  doubles (`test-support/host-doubles.mjs`), both restoration shapes, healing a
  shadow a previous activation left, a wrapper installed over ours, notice
  dedup;
- `test/host-contract.test.mjs` — the Host contract: the proxy's traps,
  descriptor placement, `ctx.effect`, the Schemastery behaviours and the
  `Config` projection, all asserted against the pinned libraries; each of the
  contract's five items is named by a test;
- `test/docs.test.mjs` — the document guard: a README's config keys are declared
  by the schema, the decision words are in the `CONTEXT.md` glossary, relative
  links and the repository paths the prose names exist and ship, and the two
  READMEs carry the same sections in the same order; it carries a bad baseline
  per judgement — each is fed a real document with one edit and has to report
  it;
- `test/read-session.test.mjs` / `test/verify-session.test.mjs` — the evidence
  tools: self-built multi-frame and truncated-frame logs exercise the reader and
  `verify` (a missing child log, a descriptor disagreeing with its own header,
  an expectation outside the frozen list);
- `test/package.test.mjs` / `test/patch.test.mjs` / `test/tarball.test.mjs` /
  `test/maintainer-docs.test.mjs` — respectively: `exports` agreeing with
  `files` (the icon ships and draws on the official 36×36 viewBox), the bundled
  patch (read through the Host's own API as exactly one insert row carrying
  `source: settings`), the real packlist matched against `files` (the one test
  that runs npm — no network), and the references in the maintainer documents
  (`AGENTS.md` and the `.agents/notes/` notes).

Live checks — manual, one tool call each. Producing the evidence cannot be
automated (the logs only exist after a real run), but reading it is one command:

```powershell
npm run verify -- --lead <lead session log>   # also --child / --expect / --default-model / --lead-expect
```

It reads the model list the run froze into its own
`subagent/model-selection-policy`, finds each child's log through
`subagent/catalog` (the Host writes it as a sibling directory named after the
childId), and asserts that every child's `request/header` and continuable
descriptor hold the default route. It reads no live Settings and starts no
Harness — it verifies **that run**, not now. Session logs live at
`$DSH_HOME/sessions/<project-dir>/<session-id>/session.v4.jsonl.zstd`
(`$DSH_HOME` defaults to `~/.dsh`, on Windows `%USERPROFILE%\.dsh`). `<default
model>` means the list's default entry; the example routes (`opencodego`,
`deepseek-v4.1-flash`) are this environment's — substitute your own.

| Check | verify | How | Expected |
|---|---|---|---|
| Fresh `subagent`, no model fields | default | `subagent` probe asking for its `{{model}}` | `<default model>` |
| Workflow `agent()`, no model fields | default | `workflow` probe returning the child's model | `<default model>` |
| Re-checked model | default | re-check another model in Settings, repeat the workflow probe | the new default, with no restart |
| Several models checked, one named | `--expect <second route>` | check two models, name the second in a `subagent` call | the child runs the second model, no error |
| Configured `defaultModel` | `--default-model <second route>` | point `defaultModel` at the second listed model, repeat the probe | the child runs `defaultModel` |
| Continuable child (the Agent Teams seam) | default | `subagent` with `run_in_background: true`, then `node tools/read-session.mjs <child session log>` | `subagent/descriptor`: `"mode":"continuable","agentProvider":…,"agentModel":"<default model>"` (`verify` also asserts it agrees with the header) |
| Named route outside the list | `--expect <outside route>` | workflow `agent()` naming a route outside the list (the `subagent` tool path is rejected by DSH itself first, so it cannot show this plugin) | the child **runs that route unchanged**; the plugin does not throw |
| Lead unaffected | `--lead-expect <Lead route>` | examine the same run's lead session log | `request/header` keeps the Lead's own route |
| Disabled = unchanged | — | disable the bundle, then run a probe with an explicit route | the child runs that explicit route: nothing is wrapped |
| Projection contract after a Harness upgrade (check this row first) | — | query `Config.listConfigs` with `entry: include:subagent-pin` (the offline part is pinned by `test/host-contract.test.mjs`; `status` is only observable on the running Host) | `status: "schema"` and `limitations: []`; `provider` carries `minLength: 1`, `defaultModel` carries `required: [provider, model]`, `source` carries `default: "settings"`, `reasoningEffort` carries a seven-level domain |

After a Harness upgrade, look at the last row first, then re-run the whole
table. Three cautions:

- The contract tests run against **three pinned packages** —
  `@deepseek-ai/schemastery`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-app-boot`
  (in this environment: 3.18.4 / 4.0.4 / 0.1.7-rc.2, read from
  `/dsh/node_modules/@deepseek-ai/*/package.json` inside the asar) — and must
  match the shipped Host, or the suite tests a different Host. **`npm view
  <package> version` lies** — it prints the `latest` tag, and this environment's
  latest is the older 0.1.0-rc.6, so `devDependencies` must carry exact
  versions; on an upgrade, reconcile all three and re-run the unit tests.
- `Config` uses this repository's own pinned schemastery and validation never
  goes through the Harness copy, so **a version difference alone will not break
  the plugin**; but the Host's `createConfigProjector` reads our graph's node
  shape (`type`/`meta`/`dict`/`inner`/`list`) under a cross-version contract —
  a non-empty `limitations` or a `status` other than `schema` means the
  projection degraded.
- One coupling does **not** ride on a package version: `THINKING_LEVELS` in
  `config-schema.js` is the same vocabulary as the pi-ai profile's `reasoning`
  field — a level the Host adds has to be added here, or the schema starts
  refusing an effort the Host already knows.

Auxiliary tool: `tools/read-session.mjs` splits a log's concatenated zstd frames
(a single-shot decompress yields only the first; a half-written trailing frame
costs only its own events), its second argument selects events whose `type` is
**exactly** that string, and it prints every selected event whole as one
parseable JSON line. To call `verify` from outside the package, use the
`./verify` entry in `exports`. Wrapper removal on disable is covered by the unit
tests and was observed live in this environment: DSH runs the row's effects on
unload, so the shadow is deleted in the running process.

## Changing this plugin

Editing the file has no effect on a running Harness: DSH caches each plugin
module by package name and loads a replacement module generation only in a fresh
Host process. Restart the Harness after a code change, then re-run the table
above.

## Rollback

Disable `@local/dsh-subagent-pin` with `plugin_manager`'s `set_bundle`, or
delete it with `remove_bundle`. Disabling disposes the wrapper in the running
process: the seam is unwrapped and children inherit the delegating agent's route
again. No profile patch and no preset was modified for this plugin; removing it
leaves the composition exactly as it was.
