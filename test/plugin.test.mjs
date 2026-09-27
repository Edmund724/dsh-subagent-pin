/**
 * Integration tests for the subagent-pin Host plugin.
 *
 * The config shape lives in `config-schema.js` and is tested there; the policy
 * lives in `route-policy.js` and is tested there. What is tested here is what
 * only this file can do: attaching the seam to `ctx.subagents`, restoring it on
 * disposal, closing the config gaps the schema leaves (`resolveConfig`), and
 * handing the Host's values — the Settings row, the provider registry — to the
 * policy and translating its decision back into a throw, a log line, or a call.
 *
 * The plugin only touches `ctx.subagents`, `ctx.get`, `ctx.logger` and
 * `ctx.effect`, so a small double is enough to pin down that contract without
 * booting a Harness.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, Config } from '../plugin.js'

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

const SPAWN = { name: 'spawn', capabilities: { agentOptions: true }, inheritsParentContext: false }
const OUT_OF_PROCESS = { name: 'codex', capabilities: { agentOptions: false }, inheritsParentContext: false }

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
  allowedModels: [{ provider: 'opencodego', model: 'space-bunny-free' }],
}

function fakeSubagents(providers = [SPAWN, OUT_OF_PROCESS]) {
  const calls = []
  return {
    calls,
    providers: new Map(providers.map((provider) => [provider.name, provider])),
    getProvider(name) {
      return this.providers.get(name)
    },
    start(name, request) {
      calls.push({ method: 'start', name, request })
      return { id: 'run-1', result: Promise.resolve({ stopReason: 'completed' }) }
    },
    startContinuable(spec) {
      calls.push({ method: 'startContinuable', spec })
      return Promise.resolve({ childId: 'child-1', messageId: 'message-1' })
    },
  }
}

function fakeCtx(subagents, services = {}) {
  const cleanups = []
  const logs = []
  return {
    subagents,
    logs,
    get: (name) => services[name],
    logger: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
    },
    effect(callback) {
      const cleanup = callback()
      cleanups.push(cleanup)
      return cleanup
    },
    async disposeAll() {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup?.()
    },
  }
}

/** The `subagentModelSelection` service double, mutable so a test can re-check models. */
function fakeSettings(routes = [{ ...CHECKED }], enabled = true) {
  const state = { routes, enabled }
  return {
    state,
    current() {
      return { enabled: state.enabled, allowedModels: state.routes.map((route) => ({ ...route })) }
    },
  }
}

function mounted(config = PINNED_CONFIG, providers) {
  const subagents = fakeSubagents(providers)
  const ctx = fakeCtx(subagents)
  apply(ctx, validated(config))
  return { ctx, subagents }
}

function mountedSettings(routes, enabled) {
  const settings = fakeSettings(routes, enabled)
  const subagents = fakeSubagents()
  const ctx = fakeCtx(subagents, { subagentModelSelection: settings })
  apply(ctx, validated(SETTINGS_CONFIG))
  return { ctx, subagents, settings }
}

// ── handing the Host's values to the policy ─────────────────────────────────

test('a fresh delegation is pinned end-to-end from the pinned route', () => {
  const { subagents } = mounted()
  const original = { parent: PARENT, prompt: [{ type: 'text', text: 'hi' }] }

  subagents.start('spawn', original)

  assert.equal(subagents.calls.length, 1)
  assert.deepEqual(subagents.calls[0].request.agentOptions, {
    provider: 'opencodego',
    model: 'space-bunny-free',
    reasoningEffort: 'high',
  })
  // The caller's request object is never mutated in place.
  assert.equal(original.agentOptions, undefined)
})

test('a continuable delegation is pinned through the same seam', async () => {
  const { subagents } = mounted()

  await subagents.startContinuable({ provider: 'spawn', label: 'task', request: { prompt: [], parent: PARENT } })

  assert.deepEqual(subagents.calls[0].spec.request.agentOptions, {
    provider: 'opencodego',
    model: 'space-bunny-free',
    reasoningEffort: 'high',
  })
})

test('a fresh delegation is pinned end-to-end from the Settings row', () => {
  const { subagents } = mountedSettings()

  subagents.start('spawn', { parent: PARENT })

  assert.deepEqual(subagents.calls[0].request.agentOptions, { provider: 'opencodego', model: 'space-bunny-free' })
})

test('an omitted row config takes the schema default source', () => {
  const subagents = fakeSubagents()
  const ctx = fakeCtx(subagents, { subagentModelSelection: fakeSettings() })
  apply(ctx, validated(undefined))

  subagents.start('spawn', { parent: PARENT })

  assert.deepEqual(subagents.calls[0].request.agentOptions, { provider: 'opencodego', model: 'space-bunny-free' })
})

test('settings mode re-reads the Settings row for every delegation', () => {
  const { subagents, settings } = mountedSettings()

  subagents.start('spawn', { parent: PARENT })
  settings.state.routes = [{ ...OTHER }]
  subagents.start('spawn', { parent: PARENT })

  assert.equal(subagents.calls[0].request.agentOptions.model, 'space-bunny-free')
  assert.equal(subagents.calls[1].request.agentOptions.model, 'deepseek-v4.1-flash')
})

test('an exempt provider is left alone and reported once per activation', () => {
  const { ctx, subagents } = mounted()

  subagents.start('codex', { parent: PARENT })
  subagents.start('codex', { parent: PARENT })

  assert.equal(subagents.calls[0].request.agentOptions, undefined)
  assert.equal(ctx.logs.filter((entry) => entry.level === 'warn' && entry.message.includes('codex')).length, 1)
})

// ── the Settings row it could not use ──────────────────────────────────────

test('settings mode fails loudly when the Settings row is absent from the Host', () => {
  const subagents = fakeSubagents()
  const ctx = fakeCtx(subagents)
  apply(ctx, validated(SETTINGS_CONFIG))

  assert.throws(() => subagents.start('spawn', { parent: PARENT }), /model-selection-settings is not composed/)
  assert.equal(subagents.calls.length, 0)
})

test('settings mode fails loudly when the service exposes no current()', () => {
  const subagents = fakeSubagents()
  const ctx = fakeCtx(subagents, { subagentModelSelection: {} })
  apply(ctx, validated(SETTINGS_CONFIG))

  assert.throws(() => subagents.start('spawn', { parent: PARENT }), /model-selection-settings is not composed/)
})

test('settings mode reports a rejected Settings list instead of pinning nothing', () => {
  const subagents = fakeSubagents()
  const ctx = fakeCtx(subagents, {
    subagentModelSelection: {
      current() {
        throw new Error('subagent model selection repeats route "opencodego/space-bunny-free"')
      },
    },
  })
  apply(ctx, validated(SETTINGS_CONFIG))

  assert.throws(() => subagents.start('spawn', { parent: PARENT }), /rejected its own model list: subagent model selection repeats route/)
})

// ── activation reporting ───────────────────────────────────────────────────

test('activation reports the pinned route and its allowlist', () => {
  const { ctx } = mounted()

  assert.equal(ctx.logs.some((entry) => entry.level === 'info' && entry.message.includes('pinned to opencodego/space-bunny-free') && entry.message.includes('effort high')), true)
})

test('activation reports the Settings route, the default and every authorized model', () => {
  const subagents = fakeSubagents()
  const ctx = fakeCtx(subagents, { subagentModelSelection: fakeSettings([{ ...CHECKED }, { ...OTHER }]) })
  apply(ctx, { source: 'settings', defaultModel: { ...OTHER } })

  assert.equal(
    ctx.logs.some((entry) => entry.level === 'info' && entry.message.includes('default opencodego/deepseek-v4.1-flash') && entry.message.includes('opencodego/space-bunny-free')),
    true,
  )
})

test('activation warns while the Settings row cannot authorize anything', () => {
  const { ctx } = mountedSettings([{ ...CHECKED }], false)

  assert.equal(ctx.logs.some((entry) => entry.level === 'warn' && entry.message.includes('will fail')), true)
})

// ── the seam: install, heal, restore ───────────────────────────────────────

test('disposal restores the original service methods', async () => {
  const subagents = fakeSubagents()
  const originalStart = subagents.start
  const originalContinuable = subagents.startContinuable
  const ctx = fakeCtx(subagents)
  apply(ctx, validated(PINNED_CONFIG))

  assert.notEqual(subagents.start, originalStart)
  assert.notEqual(subagents.startContinuable, originalContinuable)
  await ctx.disposeAll()

  assert.equal(subagents.start, originalStart)
  assert.equal(subagents.startContinuable, originalContinuable)
})

test('a prototype-shaped service is restored by dropping the own shadow', async () => {
  class FakeRuntime {
    getProvider() {
      return undefined
    }
    start() {}
    startContinuable() {}
  }
  const subagents = new FakeRuntime()
  const ctx = fakeCtx(subagents)
  apply(ctx, validated(PINNED_CONFIG))

  assert.equal(Object.hasOwn(subagents, 'start'), true)
  await ctx.disposeAll()

  assert.equal(Object.hasOwn(subagents, 'start'), false)
  assert.equal(subagents.start, FakeRuntime.prototype.start)
})

test('a service without the delegation seam fails at activation instead of pinning nothing', () => {
  const ctx = fakeCtx({ getProvider: () => undefined })

  assert.throws(() => apply(ctx, validated(PINNED_CONFIG)), /has no start\(\) method/)
})

test('a frozen service instance fails at activation', () => {
  const subagents = Object.freeze(fakeSubagents())
  const ctx = fakeCtx(subagents)

  assert.throws(() => apply(ctx, validated(PINNED_CONFIG)), /not extensible/)
})

test('a stale shadow from a previous activation is dropped before pinning again', async () => {
  class FakeRuntime {
    getProvider() {
      return undefined
    }
    start() {
      return 'first'
    }
    startContinuable() {}
  }
  const subagents = new FakeRuntime()
  const first = fakeCtx(subagents)
  apply(first, validated(PINNED_CONFIG))
  const firstWrapper = Object.getOwnPropertyDescriptor(subagents, 'start').value
  const second = fakeCtx(subagents)

  apply(second, validated(PINNED_CONFIG))

  const secondWrapper = Object.getOwnPropertyDescriptor(subagents, 'start').value
  assert.notEqual(secondWrapper, firstWrapper)
  assert.equal(second.logs.some((entry) => entry.level === 'warn' && entry.message.includes('previous activation')), true)
  await second.disposeAll()
  assert.equal(Object.hasOwn(subagents, 'start'), false)
  assert.equal(subagents.start, FakeRuntime.prototype.start)
})

test('a context proxy that re-wraps every function read still restores on disposal', async () => {
  // Mirrors Cordis `getTraceable`: reading a method yields a fresh wrapper, so
  // function identity never survives a read.
  const tracing = (target) =>
    new Proxy(target, {
      get(inner, prop, receiver) {
        const value = Reflect.get(inner, prop, receiver)
        if (typeof value !== 'function') return value
        return (...args) => Reflect.apply(value, receiver, args)
      },
    })
  const raw = fakeSubagents()
  const originalStart = raw.start
  const originalContinuable = raw.startContinuable
  const ctx = fakeCtx(tracing(raw))
  apply(ctx, validated(PINNED_CONFIG))

  assert.notEqual(Object.getOwnPropertyDescriptor(raw, 'start').value, originalStart)
  assert.equal(ctx.subagents.start('spawn', { parent: PARENT }).id, 'run-1')
  assert.deepEqual(raw.calls[0].request.agentOptions, {
    provider: 'opencodego',
    model: 'space-bunny-free',
    reasoningEffort: 'high',
  })
  await ctx.disposeAll()

  assert.equal(raw.start, originalStart)
  assert.equal(raw.startContinuable, originalContinuable)
})

test('a wrapper installed over ours is still removed on disposal', async () => {
  class FakeRuntime {
    getProvider() {
      return undefined
    }
    start() {
      return 'proto'
    }
    startContinuable() {}
  }
  const subagents = new FakeRuntime()
  const ctx = fakeCtx(subagents)
  apply(ctx, validated(PINNED_CONFIG))
  Object.defineProperty(subagents, 'start', { value: () => 'interloper', writable: true, configurable: true })

  await ctx.disposeAll()

  assert.equal(subagents.start, FakeRuntime.prototype.start)
  assert.equal(ctx.logs.some((entry) => entry.level === 'warn' && entry.message.includes('another wrapper')), true)
})

test('settings mode is restored on disposal like the pinned mode', async () => {
  class FakeRuntime {
    getProvider() {
      return undefined
    }
    start() {}
    startContinuable() {}
  }
  const subagents = new FakeRuntime()
  const ctx = fakeCtx(subagents, { subagentModelSelection: fakeSettings() })
  apply(ctx, validated(SETTINGS_CONFIG))

  assert.equal(Object.hasOwn(subagents, 'start'), true)
  await ctx.disposeAll()

  assert.equal(subagents.start, FakeRuntime.prototype.start)
})

// ── the config gaps `config-schema.js` leaves to this file ──────────────────

test('the key set is closed here, because the schema merges unknown keys', () => {
  assert.throws(() => apply(fakeCtx(fakeSubagents()), validated({ ...PINNED_CONFIG, extra: 1 })), /unknown config key "extra"/)
  assert.throws(
    () => apply(fakeCtx(fakeSubagents()), validated({ source: 'settings', defaultModel: { ...CHECKED, extra: 1 } })),
    /config.defaultModel has unknown key "extra"/,
  )
})

test('pinned mode requires the route it cannot get from Settings', () => {
  assert.throws(
    () => apply(fakeCtx(fakeSubagents()), validated({ source: 'pinned', model: 'space-bunny-free' })),
    /config.provider must be a non-empty string/,
  )
  assert.throws(
    () => apply(fakeCtx(fakeSubagents()), validated({ source: 'pinned', provider: 'opencodego' })),
    /config.model must be a non-empty string/,
  )
})

test('pinned mode must allow the route it pins to', () => {
  assert.throws(
    () => apply(fakeCtx(fakeSubagents()), validated({ ...PINNED_CONFIG, allowedModels: [{ provider: 'other', model: 'other' }] })),
    /allowedModels must include the pinned route/,
  )
})

test('settings mode rejects a static route instead of hiding it', () => {
  assert.throws(
    () => apply(fakeCtx(fakeSubagents()), validated({ source: 'settings', provider: 'opencodego', model: 'space-bunny-free' })),
    /config.provider is fixed by the Settings row/,
  )
  assert.throws(
    () => apply(fakeCtx(fakeSubagents()), validated({ source: 'settings', allowedModels: [{ ...CHECKED }] })),
    /config.allowedModels is fixed by the Settings row/,
  )
  assert.throws(
    () => apply(fakeCtx(fakeSubagents()), validated({ ...PINNED_CONFIG, defaultModel: { ...CHECKED } })),
    /config.defaultModel is redundant while config.source is "pinned"/,
  )
})
