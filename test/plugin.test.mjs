/**
 * Integration tests for the subagent-pin Host plugin.
 *
 * The config shape lives in `config-schema.js` and is tested there; the policy
 * lives in `route-policy.js` and is tested there; the Host shapes the seam needs
 * are declared in `host-contract.js` and asserted against the real Host
 * libraries in `host-contract.test.mjs`. What is tested here is what only this
 * file can do: attaching the seam to the `subagents` service of a real Cordis
 * context, restoring it on disposal, closing the config gaps the schema leaves
 * (`resolveConfig`), and handing the Host's values — the Settings row, the
 * provider registry — to the policy and translating its decision back into a
 * throw, a log line, or a call.
 *
 * The Host itself is not doubled here: `test/support/host-doubles.mjs` builds a
 * real `Service` on a real `Context`, so the tracing proxy, the own shadow and
 * the registered effect are the Host's, not a copy of them.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, Config } from '../plugin.js'
import { DelegationService, fakeSettings, hostDoubles } from '../test-support/host-doubles.mjs'

/**
 * Validate one raw config the way cordis does before `apply()` runs (`fiber.ts`
 * `resolveConfig`), so these tests exercise the same two-stage pipeline the
 * Host does: the schema settles the shape, the plugin settles the policy.
 */
function validated(config) {
  const result = Config['~standard'].validate(config)
  if (result.issues) throw new Error(result.issues.map((issue) => issue.message).join('; '))
  return result.value
}

const PARENT = { id: 'parent-session' }

const CHECKED = { provider: 'opencodego', model: 'space-bunny-free' }
const OTHER = { provider: 'opencodego', model: 'deepseek-v4.1-flash' }

/** The default mode: follow the Settings row, which authorizes one or more models. */
const SETTINGS_CONFIG = { source: 'settings' }

/** The opt-in static mode, kept for a Host without the Settings row. */
const PINNED_CONFIG = {
  source: 'pinned',
  provider: 'opencodego',
  model: 'space-bunny-free',
  reasoningEffort: 'high',
}

function mounted(config = PINNED_CONFIG, options) {
  const doubles = hostDoubles(options)
  apply(doubles.ctx, validated(config))
  return doubles
}

function mountedSettings(routes, enabled) {
  const doubles = hostDoubles({ settings: fakeSettings(routes, enabled) })
  apply(doubles.ctx, validated(SETTINGS_CONFIG))
  return doubles
}

// ── handing the Host's values to the policy ─────────────────────────────────

test('a fresh delegation is pinned end-to-end from the pinned route', () => {
  const doubles = mounted()
  const original = { parent: PARENT, prompt: [{ type: 'text', text: 'hi' }] }

  doubles.ctx.subagents.start('spawn', original)

  assert.equal(doubles.calls.length, 1)
  assert.deepEqual(doubles.calls[0].request.agentOptions, {
    provider: 'opencodego',
    model: 'space-bunny-free',
    reasoningEffort: 'high',
  })
  // The caller's request object is never mutated in place.
  assert.equal(original.agentOptions, undefined)
})

test('a continuable delegation is pinned through the same seam', async () => {
  const doubles = mounted()

  await doubles.ctx.subagents.startContinuable({ provider: 'spawn', label: 'task', request: { prompt: [], parent: PARENT } })

  assert.deepEqual(doubles.calls[0].spec.request.agentOptions, {
    provider: 'opencodego',
    model: 'space-bunny-free',
    reasoningEffort: 'high',
  })
})

test('a continuable spec this plugin cannot reason about is passed through untouched', async () => {
  const doubles = mounted()

  await doubles.ctx.subagents.startContinuable(null)

  assert.equal(doubles.calls.length, 1)
  assert.equal(doubles.calls[0].spec, null)
})

test('a fresh delegation is pinned end-to-end from the Settings row', () => {
  const doubles = mountedSettings()

  doubles.ctx.subagents.start('spawn', { parent: PARENT })

  assert.deepEqual(doubles.calls[0].request.agentOptions, { provider: 'opencodego', model: 'space-bunny-free' })
})

test('an omitted row config takes the schema default source', () => {
  const doubles = hostDoubles({ settings: fakeSettings() })
  apply(doubles.ctx, validated(undefined))

  doubles.ctx.subagents.start('spawn', { parent: PARENT })

  assert.deepEqual(doubles.calls[0].request.agentOptions, { provider: 'opencodego', model: 'space-bunny-free' })
})

test('settings mode re-reads the Settings row for every delegation', () => {
  const doubles = mountedSettings()

  doubles.ctx.subagents.start('spawn', { parent: PARENT })
  doubles.settings.state.routes = [{ ...OTHER }]
  doubles.ctx.subagents.start('spawn', { parent: PARENT })

  assert.equal(doubles.calls[0].request.agentOptions.model, 'space-bunny-free')
  assert.equal(doubles.calls[1].request.agentOptions.model, 'deepseek-v4.1-flash')
})

test('an exempt provider is left alone and reported once per activation', () => {
  const doubles = mounted()

  doubles.ctx.subagents.start('codex', { parent: PARENT })
  doubles.ctx.subagents.start('codex', { parent: PARENT })

  assert.equal(doubles.calls[0].request.agentOptions, undefined)
  assert.equal(doubles.logs.filter((entry) => entry.level === 'warn' && entry.message.includes('codex')).length, 1)
})

// The Host reads `capabilities.agentOptions` only inside `start()`; the
// continuable path never reads it (the seam note's (a)-4). Both exemptions are
// therefore this plugin's own reading of the provider record, and the two
// wrapped methods are pinned to apply it identically.
test('a continuable delegation to an out-of-process provider is exempt through the same seam', async () => {
  const doubles = mounted()

  await doubles.ctx.subagents.startContinuable({ provider: 'codex', label: 'task', request: { parent: PARENT } })
  await doubles.ctx.subagents.startContinuable({ provider: 'codex', label: 'task', request: { parent: PARENT } })

  assert.equal(doubles.calls[0].spec.request.agentOptions, undefined)
  assert.equal(doubles.logs.filter((entry) => entry.level === 'warn' && entry.message.includes('codex')).length, 1)
})

test('a continuable delegation to a fork-class provider keeps the inherited route', async () => {
  const doubles = mounted(PINNED_CONFIG, {
    providers: [{ name: 'fork', capabilities: { agentOptions: true }, inheritsParentContext: true }],
  })

  await doubles.ctx.subagents.startContinuable({ provider: 'fork', label: 'task', request: { parent: PARENT } })

  assert.equal(doubles.calls[0].spec.request.agentOptions, undefined)
  assert.equal(doubles.logs.filter((entry) => entry.level === 'info' && entry.message.includes('inherits the parent conversation')).length, 1)
})

test('a provider record the policy cannot read is reported and the delegation is pinned as usual', () => {
  const doubles = mounted(PINNED_CONFIG, { providers: [{ name: 'spawn', inheritsParentContext: false }] })

  doubles.ctx.subagents.start('spawn', { parent: PARENT })

  assert.deepEqual(doubles.calls[0].request.agentOptions, {
    provider: 'opencodego',
    model: 'space-bunny-free',
    reasoningEffort: 'high',
  })
  assert.equal(
    doubles.logs.some((entry) => entry.level === 'warn' && entry.message.includes('carries no capabilities')),
    true,
  )
})

test('a Host without a provider registry still pins, and says which exemptions it lost', () => {
  const calls = []
  const doubles = mounted(PINNED_CONFIG, {
    service: {
      start(name, request) {
        calls.push({ method: 'start', name, request })
        return { id: 'run-1' }
      },
      startContinuable(spec) {
        calls.push({ method: 'startContinuable', spec })
        return Promise.resolve({})
      },
    },
  })

  doubles.ctx.subagents.start('spawn', { parent: PARENT })

  assert.deepEqual(calls[0].request.agentOptions, {
    provider: 'opencodego',
    model: 'space-bunny-free',
    reasoningEffort: 'high',
  })
  assert.equal(
    doubles.logs.some((entry) => entry.level === 'warn' && entry.message.includes('exemptions cannot be read')),
    true,
  )
})

test('a context without a logger still pins', () => {
  const doubles = hostDoubles({ settings: fakeSettings() })
  Object.defineProperty(doubles.ctx, 'logger', { value: undefined, configurable: true, writable: true })
  apply(doubles.ctx, validated(SETTINGS_CONFIG))

  doubles.ctx.subagents.start('spawn', { parent: PARENT })

  assert.equal(doubles.calls.length, 1)
})

// ── the Settings row it could not use ──────────────────────────────────────

test('settings mode fails loudly when the Settings row is absent from the Host', () => {
  const doubles = mounted(SETTINGS_CONFIG)

  assert.throws(() => doubles.ctx.subagents.start('spawn', { parent: PARENT }), /model-selection-settings is not composed/)
  assert.equal(doubles.calls.length, 0)
})

test('settings mode fails loudly when the service is composed in a shape it cannot read', () => {
  const doubles = mounted(SETTINGS_CONFIG, { settings: {} })

  assert.throws(() => doubles.ctx.subagents.start('spawn', { parent: PARENT }), /composed in a shape this plugin cannot read/)
})

test('settings mode reports a rejected Settings list instead of pinning nothing', () => {
  const doubles = mounted(SETTINGS_CONFIG, {
    settings: {
      current() {
        throw new Error('subagent model selection repeats route "opencodego/space-bunny-free"')
      },
    },
  })

  assert.throws(() => doubles.ctx.subagents.start('spawn', { parent: PARENT }), /rejected its own model list: subagent model selection repeats route/)
})

// ── activation reporting ───────────────────────────────────────────────────

test('activation reports the pinned route', () => {
  const doubles = mounted()

  assert.equal(
    doubles.logs.some((entry) => entry.level === 'info' && entry.message.includes('pinned to opencodego/space-bunny-free') && entry.message.includes('effort high')),
    true,
  )
})

test('activation reports the Settings route, the default and every authorized model', () => {
  const doubles = hostDoubles({ settings: fakeSettings([{ ...CHECKED }, { ...OTHER }]) })
  apply(doubles.ctx, { source: 'settings', defaultModel: { ...OTHER } })

  assert.equal(
    doubles.logs.some((entry) => entry.level === 'info' && entry.message.includes('default opencodego/deepseek-v4.1-flash') && entry.message.includes('opencodego/space-bunny-free')),
    true,
  )
})

test('activation warns while the Settings row cannot authorize anything', () => {
  const doubles = mountedSettings([{ ...CHECKED }], false)

  assert.equal(doubles.logs.some((entry) => entry.level === 'warn' && entry.message.includes('will fail')), true)
})

// ── the seam: install, heal, restore ───────────────────────────────────────

test('disposal restores a service whose methods are own properties', async () => {
  const doubles = hostDoubles({ shape: 'own' })
  const ownStart = doubles.subagents.start
  apply(doubles.ctx, validated(PINNED_CONFIG))

  assert.notEqual(Object.getOwnPropertyDescriptor(doubles.subagents, 'start').value, ownStart)
  await doubles.dispose()

  assert.equal(Object.hasOwn(doubles.subagents, 'start'), true)
  assert.equal(doubles.subagents.start, ownStart)
})

test('a prototype-shaped service is restored by dropping the own shadow', async () => {
  const doubles = mounted()

  assert.equal(Object.hasOwn(doubles.subagents, 'start'), true)
  await doubles.dispose()

  assert.equal(Object.hasOwn(doubles.subagents, 'start'), false)
  assert.equal(doubles.subagents.start, DelegationService.prototype.start)
})

test('the wrapped method still reaches the provider through the tracing proxy', async () => {
  const doubles = mounted()

  doubles.ctx.subagents.start('spawn', { parent: PARENT })
  await doubles.dispose()

  assert.equal(doubles.calls[0].method, 'start')
  assert.equal(doubles.subagents.start, DelegationService.prototype.start)
})

test('a service without the delegation seam fails at activation instead of pinning nothing', () => {
  const doubles = hostDoubles({ service: { getProvider: () => undefined } })

  assert.throws(() => apply(doubles.ctx, validated(PINNED_CONFIG)), /has no start\(\) method/)
})

test('a frozen service instance fails at activation', () => {
  const doubles = hostDoubles()
  Object.freeze(doubles.subagents)

  assert.throws(() => apply(doubles.ctx, validated(PINNED_CONFIG)), /not extensible/)
})

test('a stale shadow from a previous activation is dropped before pinning again', async () => {
  const doubles = mounted()
  const firstWrapper = Object.getOwnPropertyDescriptor(doubles.subagents, 'start').value

  apply(doubles.ctx, validated(PINNED_CONFIG))

  const secondWrapper = Object.getOwnPropertyDescriptor(doubles.subagents, 'start').value
  assert.notEqual(secondWrapper, firstWrapper)
  assert.equal(doubles.logs.some((entry) => entry.level === 'warn' && entry.message.includes('previous activation')), true)
  await doubles.dispose()
  assert.equal(Object.hasOwn(doubles.subagents, 'start'), false)
  assert.equal(doubles.subagents.start, DelegationService.prototype.start)
})

test('a wrapper installed over ours is still removed on disposal', async () => {
  const doubles = mounted()
  Object.defineProperty(doubles.subagents, 'start', { value: () => 'interloper', writable: true, configurable: true })

  await doubles.dispose()

  assert.equal(doubles.subagents.start, DelegationService.prototype.start)
  assert.equal(doubles.logs.some((entry) => entry.level === 'warn' && entry.message.includes('another wrapper')), true)
})

test('settings mode is restored on disposal like the pinned mode', async () => {
  const doubles = mountedSettings()

  assert.equal(Object.hasOwn(doubles.subagents, 'start'), true)
  await doubles.dispose()

  assert.equal(doubles.subagents.start, DelegationService.prototype.start)
})

// ── the config gaps `config-schema.js` leaves to this file ──────────────────

test('the key set is closed here, because the schema merges unknown keys', () => {
  assert.throws(() => apply(hostDoubles().ctx, validated({ ...PINNED_CONFIG, extra: 1 })), /unknown config key "extra"/)
  assert.throws(
    () => apply(hostDoubles().ctx, validated({ source: 'settings', defaultModel: { ...CHECKED, extra: 1 } })),
    /config.defaultModel has unknown key "extra"/,
  )
  assert.throws(
    () => apply(hostDoubles().ctx, validated({ source: 'settings', allowedModels: [{ ...CHECKED }] })),
    /unknown config key "allowedModels"/,
  )
})

test('pinned mode requires the route it cannot get from Settings', () => {
  assert.throws(
    () => apply(hostDoubles().ctx, validated({ source: 'pinned', model: 'space-bunny-free' })),
    /config.provider must be a non-empty string/,
  )
  assert.throws(
    () => apply(hostDoubles().ctx, validated({ source: 'pinned', provider: 'opencodego' })),
    /config.model must be a non-empty string/,
  )
})

test('settings mode rejects a static route instead of hiding it', () => {
  assert.throws(
    () => apply(hostDoubles().ctx, validated({ source: 'settings', provider: 'opencodego', model: 'space-bunny-free' })),
    /config.provider is fixed by the Settings row/,
  )
  assert.throws(
    () => apply(hostDoubles().ctx, validated({ ...PINNED_CONFIG, defaultModel: { ...CHECKED } })),
    /config.defaultModel is redundant while config.source is "pinned"/,
  )
})
