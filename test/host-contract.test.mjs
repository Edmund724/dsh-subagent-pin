/**
 * The Host contract, asserted against the real Host libraries.
 *
 * Everything the seam does rests on properties of code this repository does not
 * own: Cordis hands a service read through a tracing proxy whose `defineProperty`
 * and `deleteProperty` are not trapped, registers `ctx.effect`'s returned
 * function for disposal, and Schemastery merges what an object schema does not
 * declare. DSH reads the plugin's `Config` through its own predicate and
 * projector. None of that can be checked *at activation* — a plugin cannot make
 * the Host prove its own semantics — so it is checked here, once, against the
 * libraries pinned to the versions the Host ships.
 *
 * `test/support/host-doubles.mjs` builds the doubles the other files use out of
 * these same libraries, so what is pinned here is what those tests stand on.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createConfigProjector, isNativeConfigSchema } from '@deepseek-ai/dsh-app-boot'
import z from '@deepseek-ai/schemastery'

import { Config } from '../config-schema.js'
import { SEAM_CONTRACT, assertSeam, inspectProviderRecord, verifyShadowInstall } from '../host-contract.js'
import { DelegationService, hostDoubles } from '../test-support/host-doubles.mjs'

// ── the table itself ───────────────────────────────────────────────────────

test('every contract item declares a name, a level and a check', () => {
  for (const item of SEAM_CONTRACT) {
    assert.equal(typeof item.name, 'string')
    assert.equal(item.level === 'fail' || item.level === 'warn', true, `${item.name} has no level`)
    assert.equal(typeof item.check, 'function', `${item.name} has no check`)
  }
})

test('the shared Host double satisfies the contract it stands for', () => {
  const { ctx } = hostDoubles()

  assert.deepEqual(assertSeam(ctx), [])
})

test('the contract refuses activation when the delegation methods are absent', () => {
  const { ctx } = hostDoubles({ service: { getProvider: () => undefined } })

  assert.throws(() => assertSeam(ctx), /has no start\(\) method/)
})

test('the contract reports a degraded registry as a warning, not a refusal', () => {
  const { ctx } = hostDoubles({ service: { start() {}, startContinuable() {} } })

  const notices = assertSeam(ctx)

  assert.deepEqual(notices.map((notice) => notice.level), ['warn'])
  assert.match(notices[0].message, /getProvider/)
  assert.match(notices[0].message, /exemptions cannot be read/)
})

test('a provider record the policy cannot read is reported field by field', () => {
  assert.equal(inspectProviderRecord({ capabilities: { agentOptions: true }, inheritsParentContext: false }), undefined)
  assert.match(inspectProviderRecord({ inheritsParentContext: false }), /carries no capabilities/)
  assert.match(inspectProviderRecord({ capabilities: {} }), /carries no inheritsParentContext/)
  assert.match(inspectProviderRecord('spawn'), /not a provider record/)
})

test('a service whose writes are redirected away from the instance is refused', () => {
  const raw = { start() {}, startContinuable() {}, getProvider: () => undefined }
  const ctx = { subagents: new Proxy(raw, { defineProperty: () => true }) }

  assert.throws(() => assertSeam(ctx), /does not expose a property installed with defineProperty/)
})

test('a service whose deletes are redirected away from the instance is refused', () => {
  const raw = { start() {}, startContinuable() {}, getProvider: () => undefined }
  const ctx = { subagents: new Proxy(raw, { deleteProperty: () => true }) }

  assert.throws(() => assertSeam(ctx), /does not release a deleted property/)
})

test('a host that does not keep the shadow it was given is reported after installation', () => {
  const wrappers = { start: () => {}, startContinuable: () => {} }
  const kept = { ...wrappers }
  const dropped = new Proxy({}, { getOwnPropertyDescriptor: () => undefined })

  assert.equal(verifyShadowInstall(kept, wrappers), undefined)
  assert.match(verifyShadowInstall(dropped, wrappers), /did not keep the start\(\) shadow/)
})

// ── the tracing proxy the seam installs through ─────────────────────────────

test('a service read yields a fresh wrapper every time, so only descriptors are stable', () => {
  const { ctx } = hostDoubles()
  const service = ctx.subagents

  assert.notEqual(service.start, service.start)
  assert.equal(Object.getOwnPropertyDescriptor(service, 'start'), undefined)
})

test('defineProperty and delete reach the service instance, which is what an own shadow needs', () => {
  const { ctx, subagents } = hostDoubles()

  assert.equal(Object.isExtensible(ctx.subagents), true)
  Object.defineProperty(ctx.subagents, 'start', { value: () => 'shadow', writable: true, configurable: true })
  assert.equal(subagents.start(), 'shadow')

  delete ctx.subagents.start

  assert.equal(Object.hasOwn(subagents, 'start'), false)
  assert.equal(subagents.start, DelegationService.prototype.start)
})

// ── the effect the seam disposes through ───────────────────────────────────

test('an effect runs its callback at activation and keeps the returned function for disposal', async () => {
  const { ctx } = hostDoubles()
  let disposed = false

  ctx.effect(() => () => {
    disposed = true
  })

  assert.equal(disposed, false)
  await ctx.fiber.dispose()
  assert.equal(disposed, true)
})

// ── the Schemastery behaviours the config split rests on ───────────────────

test('schemastery merges unknown keys into an object, which is why plugin.js closes the key set', () => {
  const schema = z.object({ a: z.string() })

  assert.deepEqual(schema({ a: 'x', b: 1 }), { a: 'x', b: 1 })
})

test('schemastery takes the first union branch that resolves', () => {
  const schema = z.union([z.object({ k: z.string().required() }), z.object({ k: z.number().required() })])

  assert.deepEqual(schema({ k: 5 }), { k: 5 })
})

test('a schemastery object carries a {} default, and .default(undefined) clears it', () => {
  const withDefault = z.object({ a: z.string() })
  const cleared = z.object({ a: z.string() }).default(undefined)

  assert.deepEqual(withDefault.meta.default, {})
  assert.equal(cleared.meta.default, undefined)
  assert.deepEqual(withDefault(undefined), {})
  assert.equal(cleared(undefined), undefined)
})

// ── the projection the upgrade checklist used to read by hand ──────────────

test('the Host recognizes our Config as a native graph and projects it without limitations', async () => {
  assert.equal(isNativeConfigSchema(Config), true)

  const project = await createConfigProjector()
  const { schema, acceptsMissing, limitations } = project(Config, 'config')
  const properties = schema.anyOf[0].properties

  assert.deepEqual(limitations, [])
  assert.equal(acceptsMissing, true)
  assert.deepEqual(Object.keys(properties), Object.keys(Config.dict))
  assert.equal(properties.source.default, 'settings')
  assert.equal(properties.provider.anyOf[0].minLength, 1)
  assert.deepEqual(properties.defaultModel.anyOf[0].required, ['provider', 'model'])
})
