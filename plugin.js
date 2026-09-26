/**
 * Host plugin: give every fresh subagent delegation an authorized LLM route.
 *
 * `tool-subagent.agentOptions` is the only configuration-plane knob for a child
 * route, and it exists only on the delegation *tools*. Teammates
 * (`agentTeams.spawnTeammate`), workflow `agent()` and nested delegations reach
 * `ctx.subagents` directly with no model input, so they inherit the delegating
 * agent's route. This plugin closes that gap at the one seam every delegation
 * path shares: `ctx.subagents.start()` and `startContinuable()`, before the
 * provider resolves child options.
 *
 * The route comes from one of two sources:
 *
 * - `source: 'settings'` (default) follows the `subagentModelSelection` Settings
 *   row — the model checkboxes in Settings. That list is a *permission* list, so
 *   the plugin pins the route of an unspecified delegation to one of its
 *   entries: `config.defaultModel` when set, otherwise the first authorized
 *   model. Any other authorized model an explicit request names is left exactly
 *   as requested, which keeps the original intent — the agent chooses among the
 *   authorized routes — while a delegation that names no route can still never
 *   inherit the parent's. The list is re-read on every delegation, so re-checking
 *   a model in the UI takes effect on the next delegation without a restart. A
 *   list that allows zero models, a disabled row, a missing row, or a row that
 *   rejects its own list fails the delegation loudly with an actionable message:
 *   a child never silently falls back to the parent route.
 * - `source: 'pinned'` keeps a route in this row's own config, for a Host
 *   without the Settings row. `allowedModels` is the exact set those explicit
 *   requests may name.
 *
 * Coverage and deliberate exceptions are documented in `README.md`. Two
 * exceptions matter here: a fork-class provider (`inheritsParentContext`) keeps
 * the inherited route so its reused conversation prefix stays cacheable, and a
 * provider that advertises no `agentOptions` capability (an out-of-process
 * backend) is left to route its own child.
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
 * The wrapper fails activation loudly when the service shape it depends on is
 * absent instead of silently leaving children on the parent route.
 *
 * @module @local/dsh-subagent-pin
 */

/** Wait for the delegation service instead of failing on a Host composition without it. */
export const inject = ['subagents']

/** The delegated methods every delegation path shares. */
const METHODS = ['start', 'startContinuable']

/** Config keys this row understands. */
const KNOWN_KEYS = ['source', 'provider', 'model', 'reasoningEffort', 'allowedModels', 'defaultModel']

/** Raise one activation-visible configuration or seam failure. */
function fail(message) {
  throw new Error(`subagent-pin: ${message}`)
}

/** Render one caught error without nesting the plugin prefix twice. */
function reason(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/^subagent-pin: /, '')
}

/** Read one required non-empty string config field. */
function requiredText(value, field) {
  if (typeof value !== 'string' || value.length === 0) fail(`config.${field} must be a non-empty string`)
  return value
}

/** Read one optional non-empty string config field. */
function optionalText(value, field) {
  if (value === undefined) return undefined
  return requiredText(value, field)
}

/** Read one exact `{ provider, model }` route from config. */
function routeEntry(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`)
  for (const key of Object.keys(value)) if (key !== 'provider' && key !== 'model') fail(`${field} has unknown key "${key}"`)
  return {
    provider: requiredText(value.provider, `${field}.provider`),
    model: requiredText(value.model, `${field}.model`),
  }
}

/** Read one route list from config. */
function routeList(value) {
  if (!Array.isArray(value) || value.length === 0) fail('config.allowedModels must be a non-empty list of { provider, model }')
  return value.map((entry, index) => routeEntry(entry, `config.allowedModels[${index}]`))
}

/** Validate the row's config; an unknown key is a typo, never a silent no-op. */
function resolveConfig(config) {
  const record = config ?? {}
  if (record === null || typeof record !== 'object' || Array.isArray(record)) fail('config must be an object')
  for (const key of Object.keys(record)) if (!KNOWN_KEYS.includes(key)) fail(`unknown config key "${key}" (known: ${KNOWN_KEYS.join(', ')})`)
  const source = record.source === undefined ? 'settings' : record.source
  if (source !== 'settings' && source !== 'pinned') fail(`config.source must be "settings" or "pinned" (got ${JSON.stringify(record.source)})`)
  const reasoningEffort = optionalText(record.reasoningEffort, 'reasoningEffort')
  if (source === 'settings') {
    for (const key of ['provider', 'model', 'allowedModels']) {
      if (record[key] !== undefined) fail(`config.${key} is fixed by the Settings row while config.source is "settings"; remove it or set config.source to "pinned"`)
    }
    const defaultModel = record.defaultModel === undefined ? undefined : routeEntry(record.defaultModel, 'config.defaultModel')
    return { source, reasoningEffort, defaultModel }
  }
  if (record.defaultModel !== undefined) fail('config.defaultModel is redundant while config.source is "pinned"; the pinned route is already the default')
  const provider = requiredText(record.provider, 'provider')
  const model = requiredText(record.model, 'model')
  const allowedModels = record.allowedModels === undefined ? [{ provider, model }] : routeList(record.allowedModels)
  if (!allowedModels.some((route) => route.provider === provider && route.model === model)) fail(`allowedModels must include the pinned route ${provider}/${model}`)
  return { source, provider, model, reasoningEffort, allowedModels }
}

/**
 * Resolve the route one delegation must use.
 *
 * In `pinned` mode this is the row's own config. In `settings` mode it is the
 * route of an unspecified delegation — `config.defaultModel` when set, otherwise
 * the first model the Settings row authorizes — read fresh on every call so a
 * re-checked model applies immediately. Every authorized route is passed on, so
 * an explicit request may name any of them. Every way that read can fail is a
 * hard error: a delegation without an authorized route must not inherit the
 * parent's.
 *
 * @param pin - Validated row config.
 * @param ctx - Host context exposing `subagentModelSelection`.
 * @returns `{ provider, model, reasoningEffort, allowedModels }` for this delegation.
 */
function pinRoute(pin, ctx) {
  if (pin.source === 'pinned') return pin
  const settings = typeof ctx.get === 'function' ? ctx.get('subagentModelSelection') : undefined
  if (settings === null || typeof settings !== 'object' || typeof settings.current !== 'function') {
    fail('config.source is "settings" but @deepseek-ai/dsh-tool-subagent/model-selection-settings is not composed in this Host; add that row or set this plugin to source: "pinned"')
  }
  let state
  try {
    state = settings.current()
  } catch (error) {
    fail(`the Settings row rejected its own model list: ${reason(error)}`)
  }
  if (state?.enabled !== true) fail('the Settings row is disabled, so no subagent route is authorized; enable it and check at least one model, or set this plugin to source: "pinned"')
  const routes = Array.isArray(state.allowedModels) ? state.allowedModels : []
  if (routes.length === 0) fail('the Settings row authorizes no subagent model; check at least one model, or set this plugin to source: "pinned"')
  const allowedModels = routes.map((route, index) => {
    if (route === null || typeof route !== 'object' || typeof route.provider !== 'string' || route.provider.length === 0 || typeof route.model !== 'string' || route.model.length === 0) {
      fail(`the Settings row reported a malformed route at index ${index}; expected { provider, model }`)
    }
    return { provider: route.provider, model: route.model }
  })
  const chosen = pin.defaultModel
  if (chosen !== undefined && !allowedModels.some((route) => route.provider === chosen.provider && route.model === chosen.model)) {
    fail(`config.defaultModel "${chosen.provider}/${chosen.model}" is not among the models the Settings row authorizes (${renderRoutes(allowedModels)}); check it in Settings or remove config.defaultModel`)
  }
  const route = chosen ?? allowedModels[0]
  return { source: 'settings', provider: route.provider, model: route.model, reasoningEffort: pin.reasoningEffort, allowedModels }
}

/** The route an explicitly model-selecting caller named, if any. */
function explicitRoute(request) {
  const options = request.agentOptions
  if (options === null || typeof options !== 'object') return undefined
  const provider = typeof options.provider === 'string' ? options.provider : undefined
  const model = typeof options.model === 'string' ? options.model : undefined
  if (provider === undefined && model === undefined) return undefined
  return { provider, model }
}

/** Render the allowed routes for one diagnostic. */
function renderRoutes(routes) {
  return routes.map((route) => `${route?.provider ?? '?'}/${route?.model ?? '?'}`).join(', ')
}

/** Render the effort suffix for one diagnostic. */
function effortText(reasoningEffort) {
  return reasoningEffort === undefined ? '' : ` (effort ${reasoningEffort})`
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
 * Delete every own shadow hiding a real prototype method.
 *
 * @param subagents - Service instance holding the delegation methods.
 * @returns Whether any shadow was dropped.
 */
function dropOwnShadows(subagents) {
  let dropped = false
  for (const method of METHODS) {
    if (Object.getOwnPropertyDescriptor(subagents, method) === undefined) continue
    if (typeof inheritedMethod(subagents, method) !== 'function') continue
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
 * @param config - `{ source?, provider?, model?, reasoningEffort?, allowedModels?, defaultModel? }`.
 */
export function apply(ctx, config) {
  const pinConfig = resolveConfig(config)
  const subagents = ctx.subagents
  if (subagents === null || typeof subagents !== 'object') fail('the `subagents` service is unavailable; load @deepseek-ai/dsh-subagent in the Host composition')
  for (const method of METHODS) if (typeof subagents[method] !== 'function') fail(`the \`subagents\` service has no ${method}() method — this Harness moved the delegation seam, so nothing was pinned`)
  if (!Object.isExtensible(subagents)) fail('the `subagents` service instance is not extensible, so nothing was pinned')
  if (dropOwnShadows(subagents)) ctx.logger?.warn?.('subagent-pin: a previous activation left the `subagents` service wrapped; the prototype methods were restored before pinning again')

  // The methods as this context calls them, plus the own properties we replace;
  // a service whose methods are own properties (not the shipped prototype
  // shape) is restored from these, and a prototype method by dropping the shadow.
  const original = Object.fromEntries(METHODS.map((method) => [method, subagents[method]]))
  const own = Object.fromEntries(METHODS.map((method) => [method, Object.getOwnPropertyDescriptor(subagents, method)]))

  const reported = new Set()
  const report = (level, key, message) => {
    if (reported.has(key)) return
    reported.add(key)
    ctx.logger?.[level]?.(message)
  }

  /** Resolve the request handed to the provider (never mutating the caller's object). */
  const plan = (providerName, request) => {
    if (request === null || typeof request !== 'object') return request
    const pin = pinRoute(pinConfig, ctx)
    const explicit = explicitRoute(request)
    if (explicit !== undefined) {
      const named = `${explicit.provider ?? '?'}/${explicit.model ?? '?'}`
      if (!pin.allowedModels.some((route) => route.provider === explicit.provider && route.model === explicit.model)) throw new Error(`subagent-pin: child LLM route "${named}" is not allowed for delegation; allowed: ${renderRoutes(pin.allowedModels)}`)
      return request
    }
    const provider = typeof subagents.getProvider === 'function' ? subagents.getProvider(providerName) : undefined
    if (provider?.capabilities?.agentOptions === false) {
      report('warn', `capability:${providerName}`, `subagent-pin: provider "${providerName}" cannot honor child agentOptions (out-of-process delegation); its child route is left to that provider`)
      return request
    }
    if (provider?.inheritsParentContext === true) {
      report('info', `inherited:${providerName}`, `subagent-pin: provider "${providerName}" inherits the parent conversation; its child keeps the inherited route so the reused prefix stays cacheable`)
      return request
    }
    const requested = request.agentOptions?.reasoningEffort
    const reasoningEffort = typeof requested === 'string' ? requested : pin.reasoningEffort
    return {
      ...request,
      agentOptions: {
        ...request.agentOptions,
        provider: pin.provider,
        model: pin.model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      },
    }
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
  ctx.effect(() => () => {
    for (const method of METHODS) {
      const current = Object.getOwnPropertyDescriptor(subagents, method)
      if (current === undefined) continue
      if (typeof inheritedMethod(subagents, method) === 'function') {
        if (current.value !== wrappers[method]) ctx.logger?.warn?.(`subagent-pin: another wrapper replaced ours on ${method}(); restoring the prototype method anyway`)
        delete subagents[method]
        continue
      }
      if (current.value !== wrappers[method]) continue
      if (own[method] === undefined) delete subagents[method]
      else Object.defineProperty(subagents, method, own[method])
    }
  })

  if (pinConfig.source === 'pinned') {
    ctx.logger?.info?.(`subagent-pin: fresh delegations pinned to ${pinConfig.provider}/${pinConfig.model}${effortText(pinConfig.reasoningEffort)}; allowed: ${renderRoutes(pinConfig.allowedModels)}`)
    return
  }
  try {
    const route = pinRoute(pinConfig, ctx)
    ctx.logger?.info?.(`subagent-pin: fresh delegations follow the Settings row; default ${route.provider}/${route.model}${effortText(route.reasoningEffort)}; authorized: ${renderRoutes(route.allowedModels)}; any other explicitly requested route fails`)
  } catch (error) {
    ctx.logger?.warn?.(`subagent-pin: the Settings row cannot authorize a route yet, so every fresh delegation will fail until it does — ${reason(error)}`)
  }
}
