/**
 * Host doubles for the seam tests, built on the real Cordis runtime.
 *
 * The seam is a shape of the *running* Host: a Cordis service read through a
 * tracing proxy whose writes land on the instance, disposed by a registered
 * effect. A hand-written object literal can produce that shape, but only by
 * re-stating it in every file that needs one — which is the failure this module
 * exists to remove. So a double here is a real `Service` on a real `Context`,
 * and the properties the seam reads off it are asserted once, against the real
 * library, in `test/host-contract.test.mjs`.
 *
 * `logger` is the one true double: the seam only ever calls it through optional
 * chaining, and the tests need to read what activation reported.
 *
 * This directory sits beside `test/` rather than inside it because Node's
 * default test glob matches everything under a `test` directory: in
 * `test/support/` this module would be run as a test file, which it is not.
 *
 * @module dsh-subagent-pin/test-support/host-doubles
 */

import { Context, Service } from '@deepseek-ai/cordis'

/** A delegation provider that can honor child agentOptions. */
export const SPAWN = { name: 'spawn', capabilities: { agentOptions: true }, inheritsParentContext: false }

/** A delegation provider that cannot: an out-of-process backend. */
export const OUT_OF_PROCESS = { name: 'codex', capabilities: { agentOptions: false }, inheritsParentContext: false }

/**
 * The `subagents` service, shaped like the shipped one: prototype methods.
 *
 * A `Service` subclass provides itself on construction, so `ctx.subagents` is
 * the real tracing proxy over this very instance.
 */
export class DelegationService extends Service {
  constructor(ctx, { providers = [SPAWN, OUT_OF_PROCESS], calls = [] } = {}) {
    super(ctx, 'subagents')
    this.providers = new Map(providers.map((provider) => [provider.name, provider]))
    this.calls = calls
  }

  getProvider(name) {
    return this.providers.get(name)
  }

  start(name, request) {
    this.calls.push({ method: 'start', name, request })
    return { id: 'run-1', result: Promise.resolve({ stopReason: 'completed' }) }
  }

  startContinuable(spec) {
    this.calls.push({ method: 'startContinuable', spec })
    return Promise.resolve({ childId: 'child-1', messageId: 'message-1' })
  }
}

/** The `subagentModelSelection` service, mutable so a test can re-check models. */
export function fakeSettings(routes = [{ provider: 'opencodego', model: 'space-bunny-free' }], enabled = true) {
  const state = { routes, enabled }
  return {
    state,
    current() {
      return { enabled: state.enabled, allowedModels: state.routes.map((route) => ({ ...route })) }
    },
  }
}

/**
 * Build one Host context carrying the services the plugin reads.
 *
 * @param options.providers - What `getProvider()` answers with.
 * @param options.settings - The `subagentModelSelection` service, when the test
 *   composes one.
 * @param options.shape - `'prototype'` (the shipped shape: a `Service` subclass
 *   behind the real tracing proxy) or `'own'`: the same service as an object
 *   literal, with own methods and no prototype method to expose instead — the
 *   shape a Host presents when a service was composed as a literal.
 * @param options.service - Replace the whole `subagents` service, for a Host
 *   that does not carry the seam, a frozen instance, or a registry with no
 *   `getProvider()`.
 * @returns `{ ctx, subagents, calls, logs, settings, dispose }`, where
 *   `subagents` is the unwrapped instance the seam writes to and `dispose()`
 *   runs the effects the row registered, as unloading it would.
 */
export function hostDoubles({ providers, settings, shape = 'prototype', service } = {}) {
  const ctx = new Context()
  const logs = []
  const calls = []

  Object.defineProperty(ctx, 'logger', {
    configurable: true,
    writable: true,
    value: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
      error: (message) => logs.push({ level: 'error', message }),
    },
  })

  let subagents
  if (service !== undefined) {
    subagents = service
    ctx.provide('subagents', service)
  } else if (shape === 'own') {
    subagents = literalDelegation({ providers, calls })
    ctx.provide('subagents', subagents)
  } else {
    subagents = new DelegationService(ctx, { providers, calls })
  }
  if (settings !== undefined) ctx.provide('subagentModelSelection', settings)

  return { ctx, subagents, calls, logs, settings, dispose: () => ctx.fiber.dispose() }
}

/** The delegation service as an object literal: own methods, nothing to fall back on. */
function literalDelegation({ providers = [SPAWN, OUT_OF_PROCESS], calls = [] } = {}) {
  return {
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
