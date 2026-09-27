/**
 * The row's configuration interface, tested without a Host.
 *
 * `config-schema.js` is the plugin's only machine-readable statement of what a
 * `config` row may contain. DSH projects it as data — `Config.listConfigs`
 * turns a native Schemastery graph into JSON Schema — and cordis validates every
 * activation against it before `apply()` runs (`fiber.ts` `resolveConfig`).
 * Without it both readers find nothing, so this file pins the interface down:
 * the native graph the Host demands, the accepted and rejected shapes, what an
 * omitted field resolves to, and the deliberate gaps `plugin.js` closes instead.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Config, KNOWN_KEYS } from '../config-schema.js'

/**
 * The predicate `dsh-app-boot` applies before it will project a schema
 * (`isNativeConfigSchema`). Anything else reports the row as `unsupported`
 * plus an error diagnostic, so this shape is the whole contract.
 */
function isNativeConfigSchema(value) {
  const meta = value === null || value === undefined ? undefined : Reflect.get(value, 'meta')
  return (
    Reflect.get(value, Symbol.for('schemastery')) === true &&
    typeof Reflect.get(value, 'type') === 'string' &&
    meta !== null &&
    typeof meta === 'object'
  )
}

/** Validate one raw config the way cordis does at activation. */
function validate(config) {
  const result = Config['~standard'].validate(config)
  return { value: result.value, issues: result.issues?.map((issue) => issue.message) }
}

/** Assert one config resolves, and return the value the plugin would receive. */
function accepted(config) {
  const { value, issues } = validate(config)
  assert.equal(issues, undefined, `expected ${JSON.stringify(config)} to validate, got ${JSON.stringify(issues)}`)
  return value
}

/** Assert one config is rejected, and that the message names the field. */
function rejected(config, pattern) {
  const { issues } = validate(config)
  assert.notEqual(issues, undefined, `expected ${JSON.stringify(config)} to be rejected`)
  assert.match(issues.join('; '), pattern)
}

// ── the interface DSH reads ────────────────────────────────────────────────

test('the config schema is the native Schemastery graph DSH projects', () => {
  assert.equal(isNativeConfigSchema(Config), true)
  assert.equal(Config.type, 'object')
})

test('every declared key carries the prose that explains it', () => {
  assert.deepEqual(KNOWN_KEYS, ['source', 'provider', 'model', 'reasoningEffort', 'defaultModel'])
  for (const key of KNOWN_KEYS) {
    assert.equal(typeof Config.dict[key].meta.description, 'string', `${key} has no description`)
    assert.notEqual(Config.dict[key].meta.description.length, 0, `${key} has an empty description`)
  }
})

// ── what an omitted field resolves to ──────────────────────────────────────

test('an omitted config resolves to the default source and nothing else', () => {
  // Schemastery gives objects a `{}` default. It must be cleared: the policy
  // reads "the author wrote nothing" as a distinct state.
  for (const input of [undefined, null, {}]) {
    assert.deepEqual(accepted(input), { source: 'settings' })
  }
})

// ── the accepted domain ────────────────────────────────────────────────────

test('the shape accepts both sources and each optional field', () => {
  assert.deepEqual(accepted({ source: 'settings' }), { source: 'settings' })
  assert.deepEqual(accepted({ source: 'settings', reasoningEffort: 'high' }), { source: 'settings', reasoningEffort: 'high' })
  assert.deepEqual(accepted({ source: 'settings', defaultModel: { provider: 'p', model: 'm' } }), {
    source: 'settings',
    defaultModel: { provider: 'p', model: 'm' },
  })
  assert.deepEqual(accepted({ source: 'pinned', provider: 'p', model: 'm', reasoningEffort: 'low' }), {
    source: 'pinned',
    provider: 'p',
    model: 'm',
    reasoningEffort: 'low',
  })
})

test('a source outside the two modes is rejected at its own path', () => {
  rejected({ source: 'dynamic' }, /\$\.source expected "settings" \| "pinned" but got "dynamic"/)
})

test('a route field is a non-empty string, never a number or an empty value', () => {
  rejected({ source: 'pinned', provider: '', model: 'm' }, /\$\.provider expected string length >= 1/)
  rejected({ source: 'pinned', provider: 5, model: 'm' }, /\$\.provider expected string/)
  rejected({ source: 'settings', reasoningEffort: 3 }, /\$\.reasoningEffort expected string/)
})

test('defaultModel is a route object, not a "provider/model" string', () => {
  rejected({ source: 'settings', defaultModel: 'opencodego/space-bunny-free' }, /\$\.defaultModel expected object/)
  rejected({ source: 'settings', defaultModel: { provider: 'opencodego' } }, /\$\.defaultModel\.model missing required value/)
})

// ── what the schema deliberately leaves to plugin.js ───────────────────────

test('the shape cannot close a key set, so the plugin does', () => {
  // Schemastery objects merge unknown keys rather than rejecting them.
  assert.deepEqual(accepted({ source: 'settings', extra: 1 }).extra, 1)
})

test('the shape cannot express which keys may appear together, so the plugin does', () => {
  // A flat object cannot require `provider` only when `source` is "pinned", and
  // a union of branches cannot reject a key either: both branches are objects
  // that merge what they do not declare.
  assert.deepEqual(accepted({ source: 'settings', provider: 'p', model: 'm' }).provider, 'p')
  assert.deepEqual(accepted({ source: 'pinned', provider: 'p', model: 'm', defaultModel: { provider: 'q', model: 'n' } }).defaultModel, {
    provider: 'q',
    model: 'n',
  })
})
