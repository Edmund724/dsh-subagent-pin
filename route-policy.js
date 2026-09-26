/**
 * Route policy: which LLM route one subagent delegation gets, and every way that
 * answer can fail.
 *
 * This module owns no Host service, no Cordis context, and no delegation seam.
 * `plugin.js` reads the Settings row and the provider registry and hands the
 * results in as plain values; this file turns them into one decision. That split
 * is the point: the policy changes far more often than the seam does, so it must
 * be reachable — and testable — without mounting the plugin.
 *
 * The route comes from one of two sources:
 *
 * - `source: 'settings'` (default) follows the `subagentModelSelection` Settings
 *   row — the model checkboxes in Settings. That list is a *permission* list, so
 *   an unspecified delegation is pinned to one of its entries: `config.defaultModel`
 *   when set, otherwise the first authorized model. Any other authorized model an
 *   explicit request names is left exactly as requested, which keeps the original
 *   intent — the agent chooses among the authorized routes — while a delegation
 *   that names no route can still never inherit the parent's. The list is re-read
 *   on every delegation, so re-checking a model in the UI takes effect on the next
 *   delegation without a restart. A list that allows zero models, a disabled row,
 *   a missing row, or a row that rejects its own list is a rejection with an
 *   actionable message: a child never silently falls back to the parent route.
 * - `source: 'pinned'` keeps a route in this row's own config, for a Host without
 *   the Settings row. `allowedModels` is the exact set those explicit requests may
 *   name.
 *
 * Two exemptions are deliberate and documented in `README.md`: a fork-class
 * provider (`inheritsParentContext`) keeps the inherited route so its reused
 * conversation prefix stays cacheable, and a provider that advertises no
 * `agentOptions` capability (an out-of-process backend) is left to route its own
 * child. Both still have an explicit route checked against the authorization.
 *
 * @module @local/dsh-subagent-pin/route-policy
 */

/** The prefix every rejection and notice carries. */
export const PREFIX = 'subagent-pin: '

/** Render the allowed routes for one diagnostic. */
export function renderRoutes(routes) {
  return routes.map((route) => `${route?.provider ?? '?'}/${route?.model ?? '?'}`).join(', ')
}

/** Reject one delegation with a message written for the operator who must fix it. */
function rejected(reason) {
  return { kind: 'reject', message: `${PREFIX}${reason}`, notices: [] }
}

/**
 * Resolve the route an unspecified delegation must use.
 *
 * In `pinned` mode this is the row's own config. In `settings` mode it is the
 * route of an unspecified delegation — `config.defaultModel` when set, otherwise
 * the first model the Settings row authorizes. Every authorized route is passed
 * on, so an explicit request may name any of them.
 *
 * The Settings read is the caller's: this function receives its outcome, never
 * touches the service. Every way that read can fail is a rejection whose `reason`
 * says how to fix it; it is unprefixed so a caller may log it, while
 * `decideDelegation` prefixes it into a message ready to throw.
 *
 * @param config - Validated row config.
 * @param settingsRead - `{ kind: 'ok', state }`, `{ kind: 'unavailable' }`,
 *   `{ kind: 'failed', message }`, or undefined in `pinned` mode.
 * @returns `{ ok: true, route }` with `{ provider, model, reasoningEffort, allowedModels }`,
 *   or `{ ok: false, reason }`.
 */
export function resolveAuthorization(config, settingsRead) {
  if (config.source === 'pinned') {
    return {
      ok: true,
      route: {
        provider: config.provider,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        allowedModels: config.allowedModels,
      },
    }
  }
  if (settingsRead === undefined || settingsRead.kind === 'unavailable') {
    return { ok: false, reason: 'config.source is "settings" but @deepseek-ai/dsh-tool-subagent/model-selection-settings is not composed in this Host; add that row or set this plugin to source: "pinned"' }
  }
  if (settingsRead.kind === 'failed') {
    return { ok: false, reason: `the Settings row rejected its own model list: ${settingsRead.message}` }
  }
  const state = settingsRead.state
  if (state?.enabled !== true) {
    return { ok: false, reason: 'the Settings row is disabled, so no subagent route is authorized; enable it and check at least one model, or set this plugin to source: "pinned"' }
  }
  const routes = Array.isArray(state.allowedModels) ? state.allowedModels : []
  if (routes.length === 0) {
    return { ok: false, reason: 'the Settings row authorizes no subagent model; check at least one model, or set this plugin to source: "pinned"' }
  }
  const allowedModels = []
  for (const [index, route] of routes.entries()) {
    if (route === null || typeof route !== 'object' || typeof route.provider !== 'string' || route.provider.length === 0 || typeof route.model !== 'string' || route.model.length === 0) {
      return { ok: false, reason: `the Settings row reported a malformed route at index ${index}; expected { provider, model }` }
    }
    allowedModels.push({ provider: route.provider, model: route.model })
  }
  const chosen = config.defaultModel
  if (chosen !== undefined && !allowedModels.some((route) => route.provider === chosen.provider && route.model === chosen.model)) {
    return { ok: false, reason: `config.defaultModel "${chosen.provider}/${chosen.model}" is not among the models the Settings row authorizes (${renderRoutes(allowedModels)}); check it in Settings or remove config.defaultModel` }
  }
  const route = chosen ?? allowedModels[0]
  return {
    ok: true,
    route: { provider: route.provider, model: route.model, reasoningEffort: config.reasoningEffort, allowedModels },
  }
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

/**
 * Decide what one delegation gets.
 *
 * A delegation that names no route is pinned to the resolved route; a delegation
 * that names an authorized route is passed through untouched; a provider that
 * cannot be pinned is exempt and says why; anything else is rejected.
 *
 * The decision is a value, not an exception, so the caller owns the effects: it
 * throws a `reject` and logs the notices, which are keyed so the same exemption
 * is reported once per activation rather than once per delegation.
 *
 * @param delegation - `{ provider, request, capabilities, inheritsParentContext }`,
 *   all read off the Host by the caller.
 * @param authorization - The `resolveAuthorization` result for this delegation.
 * @returns `{ kind: 'pin', request }`, `{ kind: 'pass', reason, request }`,
 *   `{ kind: 'exempt', reason, request, notices }`, or `{ kind: 'reject', message }`.
 */
export function decideDelegation(delegation, authorization) {
  const { provider, request, capabilities, inheritsParentContext } = delegation ?? {}
  // Nothing to reason about: hand the caller's value straight through, exactly as
  // it was given, without consulting an authorization it could not describe.
  if (request === null || typeof request !== 'object') return { kind: 'pass', reason: 'opaque', request, notices: [] }
  if (authorization?.ok !== true) return rejected(authorization?.reason ?? 'no route is authorized for this delegation')
  const { route } = authorization

  const explicit = explicitRoute(request)
  if (explicit !== undefined) {
    const named = `${explicit.provider ?? '?'}/${explicit.model ?? '?'}`
    if (!route.allowedModels.some((allowed) => allowed.provider === explicit.provider && allowed.model === explicit.model)) {
      return rejected(`child LLM route "${named}" is not allowed for delegation; allowed: ${renderRoutes(route.allowedModels)}`)
    }
    return { kind: 'pass', reason: 'authorized', request, notices: [] }
  }

  if (capabilities?.agentOptions === false) {
    return {
      kind: 'exempt',
      reason: 'capability',
      request,
      notices: [{ level: 'warn', key: `capability:${provider}`, message: `${PREFIX}provider "${provider}" cannot honor child agentOptions (out-of-process delegation); its child route is left to that provider` }],
    }
  }
  if (inheritsParentContext === true) {
    return {
      kind: 'exempt',
      reason: 'inherited',
      request,
      notices: [{ level: 'info', key: `inherited:${provider}`, message: `${PREFIX}provider "${provider}" inherits the parent conversation; its child keeps the inherited route so the reused prefix stays cacheable` }],
    }
  }

  const requested = request.agentOptions?.reasoningEffort
  const reasoningEffort = typeof requested === 'string' ? requested : route.reasoningEffort
  return {
    kind: 'pin',
    request: {
      ...request,
      agentOptions: {
        ...request.agentOptions,
        provider: route.provider,
        model: route.model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      },
    },
    notices: [],
  }
}
