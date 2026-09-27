/**
 * Unit tests for the route-policy module.
 *
 * The module holds no Host dependency, so every case here is a direct call: the
 * `source` a route comes from is an input dimension rather than a second copy of
 * the suite, and nothing needs a context, a service double, or the delegation
 * seam to reach the policy.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decideDelegation, resolveAuthorization } from '../route-policy.js'

const CHECKED = { provider: 'opencodego', model: 'space-bunny-free' }
const OTHER = { provider: 'opencodego', model: 'deepseek-v4.1-flash' }

/** The opt-in static source, for a Host without the Settings row. */
const PINNED = {
  source: 'pinned',
  provider: 'opencodego',
  model: 'space-bunny-free',
  reasoningEffort: 'high',
}

/** The default source: follows the Settings row's model checkboxes. */
const SETTINGS = { source: 'settings' }

/** The Settings read as `plugin.js` hands it in — the module never reads it itself. */
const readOk = (allowedModels, enabled = true) => ({ kind: 'ok', state: { enabled, allowedModels } })

const SPAWN = { capabilities: { agentOptions: true }, inheritsParentContext: false }
const FORK = { capabilities: { agentOptions: true }, inheritsParentContext: true }
const OUT_OF_PROCESS = { capabilities: { agentOptions: false }, inheritsParentContext: false }

/**
 * Both route sources, each with the authorization the module must derive from
 * it. Every shared case below runs once per entry instead of once per source.
 */
const SOURCES = [
  {
    name: 'pinned',
    config: PINNED,
    read: undefined,
    route: { provider: 'opencodego', model: 'space-bunny-free', reasoningEffort: 'high' },
  },
  {
    name: 'settings',
    config: SETTINGS,
    read: readOk([{ ...CHECKED }]),
    route: {
      provider: 'opencodego',
      model: 'space-bunny-free',
      reasoningEffort: undefined,
      allowedModels: [{ provider: 'opencodego', model: 'space-bunny-free' }],
    },
  },
]

const authorize = (source, read = source.read, config = source.config) => resolveAuthorization(config, read)

function delegated(overrides = {}) {
  return {
    provider: 'spawn',
    request: { parent: { id: 'parent-session' }, prompt: [] },
    ...SPAWN,
    ...overrides,
  }
}

const decided = (authorization, overrides = {}) => decideDelegation(delegated(overrides), authorization)

// ── resolveAuthorization ────────────────────────────────────────────────────

for (const source of SOURCES) {
  test(`${source.name} source resolves the route an unspecified delegation must use`, () => {
    const resolved = authorize(source)

    assert.equal(resolved.ok, true)
    assert.deepEqual(resolved.route, source.route)
  })
}

test('settings source rejects a Host without the Settings row', () => {
  const resolved = authorize(SOURCES[1], { kind: 'unavailable' })

  assert.equal(resolved.ok, false)
  assert.match(resolved.reason, /model-selection-settings is not composed/)
})

test('settings source rejects a row composed in a shape it cannot read', () => {
  const resolved = authorize(SOURCES[1], { kind: 'malformed' })

  assert.equal(resolved.ok, false)
  assert.match(resolved.reason, /composed in a shape this plugin cannot read/)
})

test('settings source reports the reason the Settings row rejected its own list', () => {
  const resolved = authorize(SOURCES[1], { kind: 'failed', message: 'repeats route "a/b"' })

  assert.equal(resolved.ok, false)
  assert.match(resolved.reason, /rejected its own model list: repeats route "a\/b"/)
})

test('settings source rejects a disabled row', () => {
  const resolved = authorize(SOURCES[1], readOk([{ ...CHECKED }], false))

  assert.equal(resolved.ok, false)
  assert.match(resolved.reason, /Settings row is disabled/)
})

test('settings source rejects a list that is not an array of routes', () => {
  const resolved = authorize(SOURCES[1], readOk('opencodego/space-bunny-free'))

  assert.equal(resolved.ok, false)
  assert.match(resolved.reason, /authorizes no subagent model/)
})

test('settings source rejects an empty authorization', () => {
  const resolved = authorize(SOURCES[1], readOk([]))

  assert.equal(resolved.ok, false)
  assert.match(resolved.reason, /authorizes no subagent model/)
})

test('settings source rejects a malformed route and names its index', () => {
  const resolved = authorize(SOURCES[1], readOk([{ ...CHECKED }, { provider: 'kimi-coding' }]))

  assert.equal(resolved.ok, false)
  assert.match(resolved.reason, /malformed route at index 1/)
})

test('settings source rejects a defaultModel the row no longer authorizes', () => {
  const resolved = authorize(SOURCES[1], readOk([{ ...CHECKED }]), { source: 'settings', defaultModel: { ...OTHER } })

  assert.equal(resolved.ok, false)
  assert.match(resolved.reason, /defaultModel "opencodego\/deepseek-v4\.1-flash" is not among the models the Settings row authorizes/)
})

test('settings source prefers defaultModel over the first authorized route', () => {
  const resolved = authorize(SOURCES[1], readOk([{ ...CHECKED }, { ...OTHER }]), { source: 'settings', defaultModel: { ...OTHER } })

  assert.equal(resolved.ok, true)
  assert.equal(resolved.route.model, 'deepseek-v4.1-flash')
})

test('settings source falls back to whichever authorized route comes first', () => {
  const resolved = authorize(SOURCES[1], readOk([{ ...OTHER }, { ...CHECKED }]))

  assert.equal(resolved.ok, true)
  assert.equal(resolved.route.model, 'deepseek-v4.1-flash')
})

test('settings source carries a route from another provider unchanged', () => {
  const resolved = authorize(SOURCES[1], readOk([{ provider: 'kimi-coding', model: 'kimi-k2' }]))

  assert.equal(resolved.ok, true)
  assert.deepEqual(resolved.route.provider, 'kimi-coding')
})

// ── decideDelegation: the pinned route ──────────────────────────────────────

for (const source of SOURCES) {
  test(`${source.name} source pins a delegation that names no route`, () => {
    const decision = decided(authorize(source))

    assert.equal(decision.kind, 'pin')
    assert.deepEqual(decision.request.agentOptions, {
      provider: source.route.provider,
      model: source.route.model,
      ...(source.route.reasoningEffort === undefined ? {} : { reasoningEffort: source.route.reasoningEffort }),
    })
  })
}

test('a configured effort applies only when the caller names none', () => {
  const configured = decided(authorize(SOURCES[0]), { request: { parent: {}, agentOptions: { maxTokens: 32 } } })
  const requested = decided(authorize(SOURCES[0]), { request: { parent: {}, agentOptions: { reasoningEffort: 'max' } } })

  assert.equal(configured.kind, 'pin')
  assert.equal(requested.kind, 'pin')
  assert.equal(configured.request.agentOptions.reasoningEffort, 'high')
  assert.equal(configured.request.agentOptions.maxTokens, 32)
  assert.equal(requested.request.agentOptions.reasoningEffort, 'max')
})

test('the caller request object is never mutated', () => {
  const original = { parent: {}, agentOptions: { maxTokens: 32 } }
  const decision = decided(authorize(SOURCES[0]), { request: original })

  assert.equal(original.agentOptions.provider, undefined)
  assert.notEqual(decision.request, original)
  assert.equal(decision.request.agentOptions.provider, 'opencodego')
})

test('an opaque request is passed through without consulting the authorization', () => {
  const decision = decideDelegation(delegated({ request: 'not-a-request' }), { ok: false, reason: 'the row is unusable' })

  assert.equal(decision.kind, 'pass')
  assert.equal(decision.reason, 'opaque')
  assert.equal(decision.request, 'not-a-request')
})

test('an unresolved authorization rejects with its reason', () => {
  const decision = decided({ ok: false, reason: 'the Settings row is disabled, so no subagent route is authorized' })

  assert.equal(decision.kind, 'reject')
  assert.equal(decision.message, 'subagent-pin: the Settings row is disabled, so no subagent route is authorized')
})

// ── decideDelegation: an explicitly named route ─────────────────────────────

for (const source of SOURCES) {
  test(`${source.name} source passes an explicitly named route through untouched`, () => {
    const options = { provider: source.route.provider, model: source.route.model }
    const decision = decided(authorize(source), { request: { parent: {}, agentOptions: options } })

    assert.equal(decision.kind, 'pass')
    assert.equal(decision.reason, 'named')
    assert.deepEqual(decision.request.agentOptions, options)
  })

  test(`${source.name} source passes a named route outside the list untouched`, () => {
    const options = { ...OTHER }
    const decision = decided(authorize(source), { request: { parent: {}, agentOptions: options } })

    assert.equal(decision.kind, 'pass')
    assert.equal(decision.reason, 'named')
    assert.deepEqual(decision.request.agentOptions, options)
  })
}

test('a model named without its provider is passed through untouched', () => {
  const options = { model: 'space-bunny-free' }
  const decision = decided(authorize(SOURCES[0]), { request: { parent: {}, agentOptions: options } })

  assert.equal(decision.kind, 'pass')
  assert.equal(decision.reason, 'named')
  assert.deepEqual(decision.request.agentOptions, options)
})

test('a provider named without its model is passed through untouched', () => {
  const options = { provider: 'opencodego' }
  const decision = decided(authorize(SOURCES[0]), { request: { parent: {}, agentOptions: options } })

  assert.equal(decision.kind, 'pass')
  assert.equal(decision.reason, 'named')
  assert.deepEqual(decision.request.agentOptions, options)
})

test('a named route is passed through even when no route list can be read', () => {
  for (const authorization of [
    { ok: false, reason: 'the Settings row is disabled, so no subagent route is authorized' },
    { ok: false, reason: 'model-selection-settings is not composed in this Host' },
  ]) {
    const decision = decided(authorization, { request: { parent: {}, agentOptions: { ...OTHER } } })

    assert.equal(decision.kind, 'pass')
    assert.equal(decision.reason, 'named')
  }
})

test('a non-string route field still counts as a named route', () => {
  const options = { provider: 7, model: null }
  const decision = decided(authorize(SOURCES[0]), { request: { parent: {}, agentOptions: options } })

  assert.equal(decision.kind, 'pass')
  assert.equal(decision.reason, 'named')
  assert.deepEqual(decision.request.agentOptions, options)
})

// ── decideDelegation: the two exemptions ────────────────────────────────────

test('a provider that inherits the parent conversation keeps its inherited route', () => {
  const decision = decided(authorize(SOURCES[1]), { provider: 'fork', ...FORK })

  assert.equal(decision.kind, 'exempt')
  assert.equal(decision.reason, 'inherited')
  assert.deepEqual(decision.notices, [
    {
      level: 'info',
      key: 'inherited:fork',
      message: 'subagent-pin: provider "fork" inherits the parent conversation; its child keeps the inherited route so the reused prefix stays cacheable',
    },
  ])
})

test('a provider that cannot honor child agentOptions is left to route its own child', () => {
  const decision = decided(authorize(SOURCES[1]), { provider: 'codex', ...OUT_OF_PROCESS })

  assert.equal(decision.kind, 'exempt')
  assert.equal(decision.reason, 'capability')
  assert.deepEqual(decision.notices, [
    {
      level: 'warn',
      key: 'capability:codex',
      message: 'subagent-pin: provider "codex" cannot honor child agentOptions (out-of-process delegation); its child route is left to that provider',
    },
  ])
})

test('an exempt provider still passes a named route through before the exemption is considered', () => {
  const options = { ...OTHER }
  const decision = decided(authorize(SOURCES[0]), { provider: 'fork', ...FORK, request: { parent: {}, agentOptions: options } })

  assert.equal(decision.kind, 'pass')
  assert.equal(decision.reason, 'named')
  assert.deepEqual(decision.request.agentOptions, options)
})

test('a delegation whose provider is unknown is pinned rather than exempted', () => {
  const decision = decideDelegation(
    { provider: 'spawn', request: { parent: {} }, capabilities: undefined, inheritsParentContext: undefined },
    authorize(SOURCES[0]),
  )

  assert.equal(decision.kind, 'pin')
  assert.equal(decision.request.agentOptions.model, 'space-bunny-free')
})

test('a pinned decision carries no notice and an exempt one carries no rewrite', () => {
  const pinned = decided(authorize(SOURCES[0]))
  const exempt = decided(authorize(SOURCES[0]), { provider: 'fork', ...FORK })

  assert.deepEqual(pinned.notices, [])
  assert.equal(exempt.request.agentOptions, undefined)
})
