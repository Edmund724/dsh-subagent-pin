/**
 * The Host shapes the delegation seam depends on, declared in one place.
 *
 * `plugin.js` cannot pin anything without them, the test doubles must produce
 * them, and the upgrade checklist in `README.md` points here. Saying each of
 * them once — instead of in the file header, at every call site, and again in
 * every double — is what keeps a Harness change from failing silently: an
 * assumption that is only described in prose cannot fail, and one that is only
 * mirrored in a double fails only when someone reads it.
 *
 * Items with `level: 'fail'` refuse activation. Items with `level: 'warn'`
 * cost the plugin one property of its policy and say which; they never block
 * activation, because the promise that matters — a delegation which names no
 * route never silently keeps the parent route — still holds without them.
 *
 * `route-policy.js` holds the decisions. This module holds what the Host must
 * look like for those decisions to reach the seam at all.
 *
 * @module @local/dsh-subagent-pin/host-contract
 */

import { PREFIX } from './route-policy.js'

/** The delegated methods every delegation path shares. */
export const METHODS = ['start', 'startContinuable']

/**
 * Probe the two untrapped operations the seam installs with.
 *
 * Cordis reads a service through a tracing proxy that implements only `get`,
 * `set` and `apply`: `defineProperty` and `deleteProperty` reach the service
 * instance, which is what makes a wrapper an *own shadow* that `delete` undoes.
 * Were that to change, the wrapper would land somewhere no consumer reads and
 * disposal would restore nothing — so it is probed, not assumed.
 *
 * The probe uses a symbol of its own and removes it again, leaving a conforming
 * service exactly as it was found.
 *
 * @param subagents - The service instance behind `ctx.subagents`.
 * @returns A failure message, or `undefined` when both operations reach the instance.
 */
function probeShadowMechanism(subagents) {
  const probe = Symbol('subagent-pin:probe')
  try {
    Object.defineProperty(subagents, probe, { value: 'probe', writable: true, configurable: true })
    const installed = Object.getOwnPropertyDescriptor(subagents, probe)?.value === 'probe'
    delete subagents[probe]
    const released = Object.getOwnPropertyDescriptor(subagents, probe) === undefined
    if (installed && released) return undefined
    if (!installed) return 'the `subagents` service does not expose a property installed with defineProperty() — this Harness routes service writes elsewhere, so nothing was pinned'
    return 'the `subagents` service does not release a deleted property — this Harness routes service deletes elsewhere, so disposing this plugin would not restore the seam'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `the \`subagents\` service refused a descriptor probe (${message}) — this Harness no longer carries the shadow mechanism the seam installs with`
  }
}

/**
 * The record `getProvider(name)` must return, or why it cannot be read.
 *
 * A provider that cannot be read cannot be exempted: both exemptions are
 * statements about the provider, so a missing field sends the delegation down
 * the pinned path rather than silently waiving the policy.
 *
 * @param provider - The value `getProvider(name)` returned for a known name.
 * @returns A failure message, or `undefined` when both fields are readable.
 */
export function inspectProviderRecord(provider) {
  if (provider === null || typeof provider !== 'object') return 'the registry returned a value that is not a provider record'
  if (provider.capabilities === null || typeof provider.capabilities !== 'object') return 'the record carries no capabilities, so a provider that cannot honor child agentOptions cannot be recognized'
  if (typeof provider.inheritsParentContext !== 'boolean') return 'the record carries no inheritsParentContext, so a fork-class provider cannot be recognized'
  return undefined
}

/**
 * Every Host shape the seam depends on, in the order activation checks them.
 *
 * Each `check(ctx)` returns a failure message or `undefined`. The table is the
 * declaration: `assertSeam` runs it, and `test-support/host-doubles.mjs` builds
 * its service from the same names.
 */
export const SEAM_CONTRACT = [
  {
    name: 'subagents service',
    level: 'fail',
    check: (ctx) => (ctx.subagents === null || typeof ctx.subagents !== 'object'
      ? 'the `subagents` service is unavailable; load @deepseek-ai/dsh-subagent in the Host composition'
      : undefined),
  },
  {
    name: 'delegation methods',
    level: 'fail',
    check: (ctx) => {
      for (const method of METHODS) {
        if (typeof ctx.subagents[method] !== 'function') {
          return `the \`subagents\` service has no ${method}() method — this Harness moved the delegation seam, so nothing was pinned`
        }
      }
      return undefined
    },
  },
  {
    name: 'extensible instance',
    level: 'fail',
    check: (ctx) => (Object.isExtensible(ctx.subagents)
      ? undefined
      : 'the `subagents` service instance is not extensible, so nothing was pinned'),
  },
  {
    name: 'own shadows',
    level: 'fail',
    check: (ctx) => probeShadowMechanism(ctx.subagents),
  },
  {
    name: 'provider registry',
    level: 'warn',
    check: (ctx) => (typeof ctx.subagents.getProvider === 'function'
      ? undefined
      : `${PREFIX}the \`subagents\` service exposes no getProvider(); the fork and out-of-process exemptions cannot be read, so every route-unspecified delegation is pinned as usual`),
  },
]

/**
 * Assert every failing shape, and collect the warnings.
 *
 * @param ctx - Host context carrying `subagents`.
 * @returns The `warn` items as `{ key, level, message }`, for the caller's
 *   once-per-activation reporter.
 * @throws on the first `fail` item, with the plugin's prefix, so activation
 *   reports a failed row instead of leaving children on the parent route.
 */
export function assertSeam(ctx) {
  const notices = []
  for (const item of SEAM_CONTRACT) {
    const message = item.check(ctx)
    if (message === undefined) continue
    if (item.level === 'fail') throw new Error(message.startsWith(PREFIX) ? message : `${PREFIX}${message}`)
    notices.push({ key: `contract:${item.name}`, level: 'warn', message })
  }
  return notices
}

/**
 * Read back the shadows one activation installed.
 *
 * The probe above proves the mechanism on a symbol of ours; this proves it on
 * the real properties, after the write. A Host that reports a descriptor other
 * than the one just written leaves the service wrapped in a way disposal cannot
 * undo, so the caller restores from `own` and fails after.
 *
 * @param subagents - The service instance the shadows were installed on.
 * @param wrappers - The wrappers this activation installed, keyed by method.
 * @returns A failure message, or `undefined` when every shadow is readable.
 */
export function verifyShadowInstall(subagents, wrappers) {
  for (const method of METHODS) {
    if (Object.getOwnPropertyDescriptor(subagents, method)?.value === wrappers[method]) continue
    return `the \`subagents\` service did not keep the ${method}() shadow this activation installed — this Harness routes descriptor writes elsewhere, so the plugin could not restore the seam`
  }
  return undefined
}
