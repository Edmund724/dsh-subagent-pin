/**
 * Unit tests for the subagent-pin Host plugin.
 *
 * The plugin only touches `ctx.subagents`, `ctx.get`, `ctx.logger` and
 * `ctx.effect`, so a small double is enough to pin down its contract without
 * booting a Harness.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../plugin.js'

const PARENT = { id: 'parent-session' }

const SPAWN = { name: 'spawn', capabilities: { agentOptions: true }, inheritsParentContext: false }
const FORK = { name: 'fork', capabilities: { agentOptions: true }, inheritsParentContext: true }
const OUT_OF_PROCESS = { name: 'codex', capabilities: { agentOptions: false }, inheritsParentContext: false }

const CHECKED = { provider: 'opencodego', model: 'space-bunny-free' }
const OTHER = { provider: 'opencodego', model: 'deepseek-v4.1-flash' }

/** The default mode: follow the Settings row, which must allow exactly one model. */
const SETTINGS_CONFIG = { source: 'settings', reasoningEffort: 'high' }

/** The opt-in static mode, kept for a Host without the Settings row. */
const PINNED_CONFIG = {
  source: 'pinned',
  provider: 'opencodego',
  model: 'space-bunny-free',
  reasoningEffort: 'high',
  allowedModels: [{ provider: 'opencodego', model: 'space-bunny-free' }],
}

function fakeSubagents(providers = [SPAWN, FORK, OUT_OF_PROCESS]) {
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
  apply(ctx, config)
  return { ctx, subagents }
}

function mountedSettings(routes, enabled) {
  const settings = fakeSettings(routes, enabled)
  const subagents = fakeSubagents()
  const ctx = fakeCtx(subagents, { subagentModelSelection: settings })
  apply(ctx, SETTINGS_CONFIG)
  return { ctx, subagents, settings }
}

test('a fresh delegation with no model fields is pinned to the configured route', () => {
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

test('a continuable delegation is pinned the same way', async () => {
  const { subagents } = mounted()

  await subagents.startContinuable({ provider: 'spawn', label: 'task', request: { prompt: [], parent: PARENT } })

  assert.deepEqual(subagents.calls[0].spec.request.agentOptions, {
    provider: 'opencodego',
    model: 'space-bunny-free',
    reasoningEffort: 'high',
  })
})

test('an explicitly requested effort survives the pin', () => {
  const { subagents } = mounted()

  subagents.start('spawn', { parent: PARENT, agentOptions: { reasoningEffort: 'max' } })

  assert.deepEqual(subagents.calls[0].request.agentOptions, {
    reasoningEffort: 'max',
    provider: 'opencodego',
    model: 'space-bunny-free',
  })
})

test('an explicitly requested allowed route is left untouched', () => {
  const { subagents } = mounted()
  const options = { provider: 'opencodego', model: 'space-bunny-free' }

  subagents.start('spawn', { parent: PARENT, agentOptions: options })

  assert.equal(subagents.calls[0].request.agentOptions, options)
})

test('an explicitly requested route outside the allowlist fails loudly', () => {
  const { subagents } = mounted()

  assert.throws(
    () => subagents.start('spawn', { parent: PARENT, agentOptions: { provider: 'opencodego', model: 'deepseek-v4.1-flash' } }),
    /child LLM route "opencodego\/deepseek-v4\.1-flash" is not allowed/,
  )
  assert.equal(subagents.calls.length, 0)
})

test('a route named without its counterpart fails instead of half-applying', () => {
  const { subagents } = mounted()

  assert.throws(() => subagents.start('spawn', { parent: PARENT, agentOptions: { model: 'deepseek-v4.1-flash' } }), /is not allowed/)
})

test('a fork-class child keeps its inherited route so its prefix cache survives', () => {
  const { subagents } = mounted()
  const original = { parent: PARENT, prompt: [] }

  subagents.start('fork', original)

  assert.equal(subagents.calls[0].request, original)
  assert.equal(subagents.calls[0].request.agentOptions, undefined)
})

test('a provider that cannot honor child agentOptions is left alone and reported once', () => {
  const { ctx, subagents } = mounted()

  subagents.start('codex', { parent: PARENT })
  subagents.start('codex', { parent: PARENT })

  assert.equal(subagents.calls[0].request.agentOptions, undefined)
  const warnings = ctx.logs.filter((entry) => entry.level === 'warn' && entry.message.includes('codex'))
  assert.equal(warnings.length, 1)
})

test('disposal restores the original service methods', async () => {
  const subagents = fakeSubagents()
  const originalStart = subagents.start
  const originalContinuable = subagents.startContinuable
  const ctx = fakeCtx(subagents)
  apply(ctx, PINNED_CONFIG)

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
  apply(ctx, PINNED_CONFIG)

  assert.equal(Object.hasOwn(subagents, 'start'), true)
  await ctx.disposeAll()

  assert.equal(Object.hasOwn(subagents, 'start'), false)
  assert.equal(subagents.start, FakeRuntime.prototype.start)
})

test('a service without the delegation seam fails at activation instead of pinning nothing', () => {
  const ctx = fakeCtx({ getProvider: () => undefined })

  assert.throws(() => apply(ctx, PINNED_CONFIG), /has no start\(\) method/)
})

test('a frozen service instance fails at activation', () => {
  const subagents = Object.freeze(fakeSubagents())
  const ctx = fakeCtx(subagents)

  assert.throws(() => apply(ctx, PINNED_CONFIG), /not extensible/)
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
  apply(first, PINNED_CONFIG)
  const firstWrapper = Object.getOwnPropertyDescriptor(subagents, 'start').value
  const second = fakeCtx(subagents)

  apply(second, PINNED_CONFIG)

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
  apply(ctx, PINNED_CONFIG)

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
  apply(ctx, PINNED_CONFIG)
  Object.defineProperty(subagents, 'start', { value: () => 'interloper', writable: true, configurable: true })

  await ctx.disposeAll()

  assert.equal(subagents.start, FakeRuntime.prototype.start)
  assert.equal(ctx.logs.some((entry) => entry.level === 'warn' && entry.message.includes('another wrapper')), true)
})

test('config problems fail at activation', () => {
  assert.throws(() => apply(fakeCtx(fakeSubagents()), { source: 'pinned', model: 'space-bunny-free' }), /config.provider/)
  assert.throws(() => apply(fakeCtx(fakeSubagents()), { source: 'pinned', provider: 'opencodego' }), /config.model/)
  assert.throws(() => apply(fakeCtx(fakeSubagents()), { ...PINNED_CONFIG, extra: 1 }), /unknown config key "extra"/)
  assert.throws(
    () => apply(fakeCtx(fakeSubagents()), { ...PINNED_CONFIG, allowedModels: [{ provider: 'other', model: 'other' }] }),
    /allowedModels must include the pinned route/,
  )
})

test('the default source follows the Settings row', () => {
  const subagents = fakeSubagents()
  const ctx = fakeCtx(subagents, { subagentModelSelection: fakeSettings() })
  apply(ctx, undefined)

  subagents.start('spawn', { parent: PARENT })

  assert.deepEqual(subagents.calls[0].request.agentOptions, { provider: 'opencodego', model: 'space-bunny-free' })
})

test('settings mode pins the one checked model', () => {
  const { subagents } = mountedSettings()

  subagents.start('spawn', { parent: PARENT })

  assert.deepEqual(subagents.calls[0].request.agentOptions, {
    provider: 'opencodego',
    model: 'space-bunny-free',
    reasoningEffort: 'high',
  })
})

test('settings mode pins a continuable delegation too', async () => {
  const { subagents } = mountedSettings()

  await subagents.startContinuable({ provider: 'spawn', label: 'task', request: { prompt: [], parent: PARENT } })

  assert.deepEqual(subagents.calls[0].spec.request.agentOptions, {
    provider: 'opencodego',
    model: 'space-bunny-free',
    reasoningEffort: 'high',
  })
})

test('settings mode re-reads the checked model for every delegation', () => {
  const { subagents, settings } = mountedSettings()

  subagents.start('spawn', { parent: PARENT })
  settings.state.routes = [{ ...OTHER }]
  subagents.start('spawn', { parent: PARENT })

  assert.equal(subagents.calls[0].request.agentOptions.model, 'space-bunny-free')
  assert.equal(subagents.calls[1].request.agentOptions.model, 'deepseek-v4.1-flash')
})

test('settings mode follows a model re-checked to another provider', () => {
  const { subagents, settings } = mountedSettings()

  settings.state.routes = [{ provider: 'kimi-coding', model: 'kimi-k2' }]
  subagents.start('spawn', { parent: PARENT })

  assert.deepEqual(subagents.calls[0].request.agentOptions, {
    provider: 'kimi-coding',
    model: 'kimi-k2',
    reasoningEffort: 'high',
  })
})

test('settings mode fails every delegation while several models are checked', () => {
  const { subagents } = mountedSettings([{ ...CHECKED }, { ...OTHER }])

  assert.throws(
    () => subagents.start('spawn', { parent: PARENT }),
    /must allow exactly one subagent model; 2 are checked/,
  )
  assert.equal(subagents.calls.length, 0)
})

test('settings mode fails every delegation while no model is checked', () => {
  const { subagents } = mountedSettings([])

  assert.throws(() => subagents.start('spawn', { parent: PARENT }), /exactly one subagent model; 0 are checked/)
})

test('settings mode fails every delegation while the Settings row is disabled', () => {
  const { subagents } = mountedSettings(undefined, false)

  assert.throws(() => subagents.start('spawn', { parent: PARENT }), /Settings row is disabled/)
})

test('settings mode fails loudly when the Settings row is absent from the Host', () => {
  const subagents = fakeSubagents()
  const ctx = fakeCtx(subagents)
  apply(ctx, SETTINGS_CONFIG)

  assert.throws(() => subagents.start('spawn', { parent: PARENT }), /model-selection-settings is not composed/)
})

test('settings mode fails loudly when the service exposes no current()', () => {
  const subagents = fakeSubagents()
  const ctx = fakeCtx(subagents, { subagentModelSelection: {} })
  apply(ctx, SETTINGS_CONFIG)

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
  apply(ctx, SETTINGS_CONFIG)

  assert.throws(() => subagents.start('spawn', { parent: PARENT }), /repeats route/)
})

test('activation warns while the Settings row cannot pin anything', () => {
  const { ctx } = mountedSettings([{ ...CHECKED }, { ...OTHER }])

  assert.equal(ctx.logs.some((entry) => entry.level === 'warn' && entry.message.includes('exactly one') && entry.message.includes('will fail')), true)
})

test('activation reports the checked model once the Settings row is usable', () => {
  const { ctx } = mountedSettings()

  assert.equal(ctx.logs.some((entry) => entry.level === 'info' && entry.message.includes('opencodego/space-bunny-free')), true)
})

test('settings mode rejects an explicit route other than the checked one', () => {
  const { subagents } = mountedSettings()

  assert.throws(
    () => subagents.start('spawn', { parent: PARENT, agentOptions: { provider: 'opencodego', model: 'deepseek-v4.1-flash' } }),
    /child LLM route "opencodego\/deepseek-v4\.1-flash" is not allowed/,
  )
  assert.equal(subagents.calls.length, 0)
})

test('settings mode leaves an explicit request for the checked route untouched', () => {
  const { subagents } = mountedSettings()
  const options = { provider: 'opencodego', model: 'space-bunny-free' }

  subagents.start('spawn', { parent: PARENT, agentOptions: options })

  assert.equal(subagents.calls[0].request.agentOptions, options)
})

test('settings mode without a configured effort leaves the effort unset', () => {
  const subagents = fakeSubagents()
  const ctx = fakeCtx(subagents, { subagentModelSelection: fakeSettings() })
  apply(ctx, { source: 'settings' })

  subagents.start('spawn', { parent: PARENT })

  assert.deepEqual(subagents.calls[0].request.agentOptions, { provider: 'opencodego', model: 'space-bunny-free' })
})

test('settings mode keeps an explicitly requested effort', () => {
  const { subagents } = mountedSettings()

  subagents.start('spawn', { parent: PARENT, agentOptions: { reasoningEffort: 'max' } })

  assert.deepEqual(subagents.calls[0].request.agentOptions, {
    reasoningEffort: 'max',
    provider: 'opencodego',
    model: 'space-bunny-free',
  })
})

test('settings mode still exempts a fork-class child', () => {
  const { subagents } = mountedSettings()
  const original = { parent: PARENT, prompt: [] }

  subagents.start('fork', original)

  assert.equal(subagents.calls[0].request, original)
})

test('settings mode still exempts a provider without child agentOptions', () => {
  const { ctx, subagents } = mountedSettings()

  subagents.start('codex', { parent: PARENT })
  subagents.start('codex', { parent: PARENT })

  assert.equal(subagents.calls[0].request.agentOptions, undefined)
  assert.equal(ctx.logs.filter((entry) => entry.level === 'warn' && entry.message.includes('codex')).length, 1)
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
  apply(ctx, SETTINGS_CONFIG)

  assert.equal(Object.hasOwn(subagents, 'start'), true)
  await ctx.disposeAll()

  assert.equal(subagents.start, FakeRuntime.prototype.start)
})

test('concurrent delegations each resolve the route they were called with', async () => {
  const { subagents, settings } = mountedSettings()
  const first = subagents.start('spawn', { parent: PARENT })
  settings.state.routes = [{ ...OTHER }]
  const second = subagents.start('spawn', { parent: PARENT })

  assert.deepEqual([first.id, second.id], ['run-1', 'run-1'])
  assert.equal(subagents.calls[0].request.agentOptions.model, 'space-bunny-free')
  assert.equal(subagents.calls[1].request.agentOptions.model, 'deepseek-v4.1-flash')
})

test('settings mode config rejects a static route instead of hiding it', () => {
  assert.throws(
    () => apply(fakeCtx(fakeSubagents()), { source: 'settings', provider: 'opencodego', model: 'space-bunny-free' }),
    /config.provider is fixed by the Settings row/,
  )
  assert.throws(
    () => apply(fakeCtx(fakeSubagents()), { source: 'settings', allowedModels: [{ ...CHECKED }] }),
    /config.allowedModels is fixed by the Settings row/,
  )
})

test('an unknown source fails at activation', () => {
  assert.throws(() => apply(fakeCtx(fakeSubagents()), { source: 'dynamic' }), /config.source must be "settings" or "pinned"/)
})
