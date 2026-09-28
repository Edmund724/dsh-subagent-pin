/**
 * Host plugin: give every fresh subagent delegation that names no route the
 * configured default route.
 *
 * `tool-subagent.agentOptions` is the only configuration-plane knob for a child
 * route, and it exists only on the delegation *tools*. Teammates
 * (`agentTeams.spawnTeammate`), workflow `agent()` and nested delegations reach
 * `ctx.subagents` directly with no model input, so they inherit the delegating
 * agent's route. This plugin closes that gap at the one seam every delegation
 * path shares: `ctx.subagents.start()` and `startContinuable()`, before the
 * provider resolves child options. A delegation that names a route is left
 * exactly as its caller wrote it.
 *
 * This file owns the seam. The accepted shape of a config row is
 * `config-schema.js` — a native Schemastery graph the platform projects and
 * validates without reading this file — *which* route a delegation gets, plus
 * every way that answer fails, is `route-policy.js`, a module with no Host
 * dependency, and what the Host must look like for either to reach the seam is
 * `host-contract.js`, asserted once at activation. Here the rest is wired up:
 * close the key set and the mode rules a single-node schema cannot express, read
 * the Settings row, hand the values in, throw a rejection, log a notice, and
 * call the original method.
 *
 * The policy itself is documented in `README.md`; the domain words are in
 * `CONTEXT.md`.
 *
 * The seam is an instance method of the `subagents` service, not a Cordis
 * `intercept` point: `Context.intercept` supplies per-service *config*, and the
 * `subagents` Config carries no route field. Three properties of that shape
 * drive the code below:
 *
 * - Reading `ctx.subagents` yields a tracing proxy whose function reads are
 *   re-wrapped on every access, so a wrapper can never recognize itself by
 *   comparing function values — only property descriptors are stable.
 * - `defineProperty` through that proxy lands on the service instance every
 *   consumer reads, and the shipped methods live on the prototype. A wrapper is
 *   therefore an *own shadow*: deleting it exposes the original method again.
 * - Both activation and disposal therefore work on shadows, never on captured
 *   function identity. Activation drops a shadow a previous activation left
 *   behind and warns; disposal drops its own shadow, so disabling the plugin
 *   always returns the service to its unwrapped shape.
 *
 * The wrapper fails activation loudly when a shape declared in
 * `host-contract.js` is absent or unreachable, instead of silently leaving
 * children on the parent route.
 *
 * @module dsh-subagent-pin
 */

import { PREFIX, decideDelegation, renderRoutes, resolveAuthorization } from './route-policy.js'
import { Config, KNOWN_KEYS } from './config-schema.js'
import { METHODS, assertSeam, inspectProviderRecord, verifyShadowInstall } from './host-contract.js'

/** The row's config interface: what DSH projects for `Config.listConfigs` and validates before `apply()`. */
export { Config }

/** Wait for the delegation service instead of failing on a Host composition without it. */
export const inject = ['subagents']

/** Raise one activation-visible configuration or seam failure. */
function fail(message) {
  throw new Error(`${PREFIX}${message}`)
}

/** Render one caught error without nesting the plugin prefix twice. */
function reason(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.startsWith(PREFIX) ? message.slice(PREFIX.length) : message
}

/**
 * Read one required non-empty string config field.
 *
 * `Config` rejects an empty string already. What it cannot state is *presence*
 * under a condition — `provider` must be present in `pinned` mode and absent in
 * `settings` mode — so the check stays here, and keeps `apply()` total when it
 * is called with a config that never went through the schema.
 */
function requiredText(value, field) {
  if (typeof value !== 'string' || value.length === 0) fail(`config.${field} must be a non-empty string`)
  return value
}

/** Read one route entry: reject its unknown keys, which `Config`'s shape cannot. */
function routeEntry(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`)
  for (const key of Object.keys(value)) if (key !== 'provider' && key !== 'model') fail(`${field} has unknown key "${key}"`)
  return { provider: value.provider, model: value.model }
}

/**
 * Read the row's config as the policy needs it.
 *
 * `Config` has already rejected a bad shape at activation, so this closes only
 * the gaps of a single-node schema: the key set (Schemastery merges unknown
 * keys) and the rules that depend on more than one field — which keys each mode
 * allows.
 *
 * @param config - The row's config, validated against `Config`.
 * @returns The policy's view: `{ source, ... }`.
 */
function resolveConfig(config) {
  const record = config ?? {}
  for (const key of Object.keys(record)) if (!KNOWN_KEYS.includes(key)) fail(`unknown config key "${key}" (known: ${KNOWN_KEYS.join(', ')})`)
  const source = record.source
  const reasoningEffort = record.reasoningEffort
  if (source === 'settings') {
    for (const key of ['provider', 'model']) {
      if (record[key] !== undefined) fail(`config.${key} is fixed by the Settings row while config.source is "settings"; remove it or set config.source to "pinned"`)
    }
    const defaultModel = record.defaultModel === undefined ? undefined : routeEntry(record.defaultModel, 'config.defaultModel')
    return { source, reasoningEffort, defaultModel }
  }
  if (record.defaultModel !== undefined) fail('config.defaultModel is redundant while config.source is "pinned"; the pinned route is already the default')
  const provider = requiredText(record.provider, 'provider')
  const model = requiredText(record.model, 'model')
  return { source, provider, model, reasoningEffort }
}

/** Render the effort suffix for one diagnostic. */
function effortText(reasoningEffort) {
  return reasoningEffort === undefined ? '' : ` (effort ${reasoningEffort})`
}

/**
 * Read the Settings row's current state, or why it cannot be read.
 *
 * The read stays here, on the effect side, so the policy module never needs a
 * context: it receives this outcome as a value.
 *
 * @param ctx - Host context exposing `subagentModelSelection`.
 * @returns `{ kind: 'ok', state }`, `{ kind: 'unavailable' }` when the service
 *   is not composed, `{ kind: 'malformed' }` when it is composed in a shape
 *   this plugin cannot read, or `{ kind: 'failed', message }`.
 */
function readSettings(ctx) {
  const settings = typeof ctx.get === 'function' ? ctx.get('subagentModelSelection') : undefined
  if (settings === undefined) return { kind: 'unavailable' }
  if (settings === null || typeof settings !== 'object' || typeof settings.current !== 'function') return { kind: 'malformed' }
  try {
    return { kind: 'ok', state: settings.current() }
  } catch (error) {
    return { kind: 'failed', message: reason(error) }
  }
}

/** The method an instance would expose if its own shadowing property were gone. */
function inheritedMethod(subagents, method) {
  for (let proto = Object.getPrototypeOf(subagents); proto !== null; proto = Object.getPrototypeOf(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, method)
    if (descriptor === undefined) continue
    return 'value' in descriptor ? descriptor.value : descriptor.get
  }
  return undefined
}

/**
 * Whether this method carries an own shadow that is hiding a real prototype
 * method — the one question activation healing and disposal ask in opposite
 * directions.
 */
function shadowOverPrototype(subagents, method) {
  return Object.getOwnPropertyDescriptor(subagents, method) !== undefined && typeof inheritedMethod(subagents, method) === 'function'
}

/**
 * Delete every own shadow hiding a real prototype method.
 *
 * @param subagents - Service instance holding the delegation methods.
 * @returns Whether any shadow was dropped.
 */
function dropOwnShadows(subagents) {
  let dropped = false
  for (const method of METHODS) {
    if (!shadowOverPrototype(subagents, method)) continue
    delete subagents[method]
    dropped = true
  }
  return dropped
}

/**
 * Route fresh subagent delegations at `ctx.subagents`.
 *
 * A delegation that names no route gets the configured one; a delegation that
 * names an authorized route is left exactly as requested; anything else fails.
 *
 * @param ctx - Host context; `subagents` must be available.
 * @param config - The row's config, already validated against `Config`.
 */
export function apply(ctx, config) {
  const pinConfig = resolveConfig(config)
  const subagents = ctx.subagents

  const reported = new Set()
  const report = (level, key, message) => {
    if (reported.has(key)) return
    reported.add(key)
    ctx.logger?.[level]?.(message)
  }

  // Every Host shape the seam depends on is declared, and checked, in one
  // place: a missing one fails activation here instead of leaving children on
  // the parent route, and a degraded one names what it costs.
  for (const notice of assertSeam(ctx)) report(notice.level, notice.key, notice.message)
  if (dropOwnShadows(subagents)) ctx.logger?.warn?.(`${PREFIX}a previous activation left the \`subagents\` service wrapped; the prototype methods were restored before pinning again`)

  // The methods as this context calls them, plus the own properties we replace;
  // a service whose methods are own properties (not the shipped prototype
  // shape) is restored from these, and a prototype method by dropping the shadow.
  const original = Object.fromEntries(METHODS.map((method) => [method, subagents[method]]))
  const own = Object.fromEntries(METHODS.map((method) => [method, Object.getOwnPropertyDescriptor(subagents, method)]))

  /** Resolve the row's authorization for one delegation, reading Settings fresh. */
  const authorizationOf = () => resolveAuthorization(pinConfig, pinConfig.source === 'settings' ? readSettings(ctx) : undefined)

  /** Resolve the request handed to the provider (never mutating the caller's object). */
  const plan = (providerName, request) => {
    const provider = typeof subagents.getProvider === 'function' ? subagents.getProvider(providerName) : undefined
    if (provider !== undefined) {
      const problem = inspectProviderRecord(provider)
      if (problem !== undefined) report('warn', `provider:${providerName}`, `${PREFIX}provider "${providerName}": ${problem}; the delegation is pinned as usual`)
    }
    const decision = decideDelegation(
      { provider: providerName, request, capabilities: provider?.capabilities, inheritsParentContext: provider?.inheritsParentContext },
      authorizationOf(),
    )
    if (decision.kind === 'reject') throw new Error(decision.message)
    for (const notice of decision.notices) report(notice.level, notice.key, notice.message)
    return decision.request
  }

  const wrappers = {
    start: function (name, request) {
      return Reflect.apply(original.start, subagents, [name, plan(name, request)])
    },
    startContinuable: function (spec) {
      if (spec === null || typeof spec !== 'object') return Reflect.apply(original.startContinuable, subagents, [spec])
      return Reflect.apply(original.startContinuable, subagents, [{ ...spec, request: plan(spec.provider, spec.request) }])
    },
  }

  for (const method of METHODS) Object.defineProperty(subagents, method, { value: wrappers[method], writable: true, configurable: true })

  // Read the shadows back before registering disposal: a Host that keeps the
  // write somewhere else must not be left half-wrapped by a failed activation.
  const installProblem = verifyShadowInstall(subagents, wrappers)
  if (installProblem !== undefined) {
    for (const method of METHODS) {
      try {
        if (own[method] === undefined) delete subagents[method]
        else Object.defineProperty(subagents, method, own[method])
      } catch {
        // Best effort: the failure reported below is the diagnosis.
      }
    }
    fail(installProblem)
  }

  ctx.effect(() => () => {
    for (const method of METHODS) {
      const current = Object.getOwnPropertyDescriptor(subagents, method)
      if (current === undefined) continue
      if (shadowOverPrototype(subagents, method)) {
        if (current.value !== wrappers[method]) ctx.logger?.warn?.(`${PREFIX}another wrapper replaced ours on ${method}(); restoring the prototype method anyway`)
        delete subagents[method]
        continue
      }
      if (current.value !== wrappers[method]) continue
      if (own[method] === undefined) delete subagents[method]
      else Object.defineProperty(subagents, method, own[method])
    }
  })

  if (pinConfig.source === 'pinned') {
    const { route } = resolveAuthorization(pinConfig, undefined)
    ctx.logger?.info?.(`${PREFIX}fresh delegations pinned to ${route.provider}/${route.model}${effortText(route.reasoningEffort)}; a delegation that names its own route is passed through`)
    return
  }
  const authorization = resolveAuthorization(pinConfig, readSettings(ctx))
  if (authorization.ok) {
    const { route } = authorization
    ctx.logger?.info?.(`${PREFIX}fresh delegations follow the Settings row; default ${route.provider}/${route.model}${effortText(route.reasoningEffort)}; the row lists: ${renderRoutes(route.allowedModels)}; a delegation that names its own route is passed through`)
  } else {
    ctx.logger?.warn?.(`${PREFIX}the Settings row cannot supply a default route yet, so every fresh delegation that names no route will fail until it does — ${authorization.reason}`)
  }
}
