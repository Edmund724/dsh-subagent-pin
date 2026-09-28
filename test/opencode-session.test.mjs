/**
 * The `opencode-session` row: which requests it rewrites, which it must not, and
 * how the conversation's id survives a lazily pulled stream.
 *
 * The row exists because no documented seam carries a per-request header for
 * pi-ai routes, so the transport is the only place left. That makes the
 * *narrowing* the contract: everything here is an assertion that some request
 * is either in scope and carries this conversation's id, or is byte-identical to
 * what the caller passed. Nothing here needs a Host, a network, or the real
 * `globalThis.fetch`; the desktop-runtime half is the checkout table in
 * `docs/verification.md`.
 */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { test } from 'node:test'

import {
  Config,
  KNOWN_KEYS,
  applyWith,
  createHandler,
  inScope,
  isOpencodeHost,
  resolveConfig,
  routeMatch,
} from '../opencode-session.js'

/** One recorded call to the transport the row stands in front of. */
function fakeFetch(reply = { ok: true }) {
  const calls = []
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ input, init })
      return reply
    },
  }
}

/** The scope one `llm/stream` call hands the transport. */
const SCOPE = {
  sessionId: 'session-11111111-1111-4111-8111-111111111111',
  provider: 'opencodego',
}

const MESSAGES_URL = 'https://opencode.ai/zen/go/v1/messages'

/** One handler over a fake transport. */
function probe({ als = new AsyncLocalStorage(), config = {}, realFetch } = {}) {
  const transport = realFetch === undefined ? fakeFetch() : { calls: [], fetch: realFetch }
  const handler = createHandler({
    ...resolveConfig(config),
    realFetch: transport.fetch,
    als,
  })
  return { calls: transport.calls, handler, als }
}

/** The Host surface the row actually uses, faked down to what it reads. */
function fakeCtx() {
  const handlers = new Map()
  const disposers = []
  const logs = []
  return {
    on(name, listener) {
      handlers.set(name, listener)
      return () => handlers.delete(name)
    },
    effect(callback) {
      disposers.push(callback())
    },
    logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message), error: (message) => logs.push(message) },
    listener: (name) => handlers.get(name),
    logs,
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
  }
}

// ── the config interface ───────────────────────────────────────────────────

test('the schema declares every key the row reads, and the defaults the row ships', () => {
  const { value, issues } = Config['~standard'].validate({})
  assert.equal(issues, undefined, 'an empty row must validate')
  assert.deepEqual(value, {
    enabled: true,
    providers: ['opencode'],
    hosts: ['opencode.ai'],
    headerName: 'x-opencode-session',
  })
  assert.deepEqual(KNOWN_KEYS.sort(), ['enabled', 'headerName', 'hosts', 'providers'])
})

test('the schema refuses a configuration the row cannot honour', () => {
  for (const [row, message] of [
    [{ providers: [''] }, /providers/],
    [{ providers: 'opencode' }, /providers/],
    [{ hosts: [''] }, /hosts/],
    [{ headerName: '' }, /headerName/],
  ]) {
    const { issues } = Config['~standard'].validate(row)
    assert.notEqual(issues, undefined, `${JSON.stringify(row)} must not validate`)
    assert.match(issues.map((issue) => issue.message).join(' '), message)
  }
})

test('an empty claim list is a choice, not a refusal', () => {
  const { value, issues } = Config['~standard'].validate({ providers: [] })
  assert.equal(issues, undefined)
  assert.deepEqual(value.providers, [], 'the schema default must not win over an explicit empty list')
  assert.deepEqual(resolveConfig({ providers: [] }).providers, [])
})

test('the row reader fills the same defaults the schema declares', () => {
  assert.deepEqual(resolveConfig(undefined), resolveConfig(Config['~standard'].validate({}).value))
  assert.deepEqual(resolveConfig({ enabled: false }).enabled, false)
})

test('the row reader refuses a list or header it cannot use', () => {
  for (const row of [{ providers: [''] }, { hosts: [''] }, { headerName: '' }, { providers: 'opencode' }]) {
    assert.throws(() => resolveConfig(row), /\[opencode-session\]/u, `${JSON.stringify(row)} must be refused`)
  }
})

// ── the gate ───────────────────────────────────────────────────────────────

test('a host belongs to a gateway domain only under that domain', () => {
  assert.equal(isOpencodeHost('opencode.ai'), true)
  assert.equal(isOpencodeHost('zen.opencode.ai'), true)
  assert.equal(isOpencodeHost('OPENCODE.AI'), true)
  assert.equal(isOpencodeHost('opencode.ai.evil.test'), false)
  assert.equal(isOpencodeHost('notopencode.ai'), false)
  assert.equal(isOpencodeHost('api.deepseek.com'), false)
  assert.equal(isOpencodeHost(undefined), false)
  assert.equal(isOpencodeHost('gateway.example', ['gateway.example']), true, 'the configured list is what decides')
})

test('a request is in scope by provider prefix, by gateway host, or both', () => {
  const gate = { providers: ['opencode'], hosts: ['opencode.ai'] }
  assert.equal(routeMatch('opencodego', 'api.deepseek.com', gate), true, 'the provider prefix alone is enough')
  assert.equal(routeMatch('deepseek-official', 'opencode.ai', gate), true, 'the gateway host alone is enough')
  assert.equal(routeMatch('deepseek-official', 'zen.opencode.ai', gate), true)
  assert.equal(routeMatch('opencodego', 'opencode.ai', gate), true)
  assert.equal(routeMatch('kimi-coding', 'api.kimi.com', gate), false)
  assert.equal(routeMatch('kimi-coding', 'opencode.ai', { providers: [], hosts: ['example.test'] }), false)
  assert.equal(routeMatch(undefined, undefined, gate), false)
})

// ── what must not change ───────────────────────────────────────────────────

test('a request outside any llm/stream scope is never touched', async () => {
  const { calls, handler } = probe()
  const init = { method: 'POST', headers: { authorization: 'Bearer x' } }
  await handler(MESSAGES_URL, init)
  assert.equal(calls[0].init, init, 'the arguments must reach the transport unchanged')
})

test('a discovery GET is never touched even inside the scope', async () => {
  const { calls, handler, als } = probe()
  await als.run(SCOPE, () => handler('https://opencode.ai/zen/go/v1/models', { method: 'GET' }))
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.headers, undefined)
})

test('a POST outside the gateway from an unrelated provider is untouched', async () => {
  const { calls, handler, als } = probe()
  const init = { method: 'POST' }
  await als.run({ ...SCOPE, provider: 'kimi-coding' }, () => handler('https://api.kimi.com/chat/completions', init))
  assert.equal(calls[0].init, init)
})

test('a scope without a session id attaches nothing', async () => {
  const { calls, handler, als } = probe()
  const init = { method: 'POST' }
  await als.run({ provider: 'opencodego' }, () => handler(MESSAGES_URL, init))
  assert.equal(calls[0].init, init)
})

// ── what changes ───────────────────────────────────────────────────────────

test('an in-scope POST carries the conversation id, preserving every other header', async () => {
  const { calls, handler, als } = probe()
  await als.run(SCOPE, () =>
    handler(MESSAGES_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
    }),
  )
  const headers = new Headers(calls[0].init.headers)
  assert.equal(headers.get('x-opencode-session'), SCOPE.sessionId)
  assert.equal(headers.get('authorization'), 'Bearer x')
  assert.equal(headers.get('content-type'), 'application/json')
})

test('a same-name header the route already carried is replaced', async () => {
  const { calls, handler, als } = probe()
  await als.run(SCOPE, () => handler(MESSAGES_URL, { method: 'POST', headers: { 'x-opencode-session': 'one-value-for-everyone' } }))
  assert.equal(new Headers(calls[0].init.headers).get('x-opencode-session'), SCOPE.sessionId)
})

test('the rewrite never mutates the caller\'s objects', async () => {
  const { calls, handler, als } = probe()
  const init = { method: 'POST', headers: { 'content-type': 'application/json' } }
  await als.run(SCOPE, () => handler(MESSAGES_URL, init))
  assert.notEqual(calls[0].init, init)
  assert.equal(init.headers['x-opencode-session'], undefined)
  assert.equal(new Headers(calls[0].init.headers).get('content-type'), 'application/json')
})

test('a configured header name and gate are what the row uses', async () => {
  const { calls, handler, als } = probe({
    config: { headerName: 'x-session', providers: [], hosts: ['gateway.example'] },
  })
  await als.run({ ...SCOPE, provider: 'anything' }, () => handler('https://gateway.example/v1/messages', { method: 'POST' }))
  assert.equal(new Headers(calls[0].init.headers).get('x-session'), SCOPE.sessionId)
})

// ── failure discipline ─────────────────────────────────────────────────────

test('a session id the Headers constructor refuses fails open, not hard', async () => {
  const { calls, handler, als } = probe()
  await als.run({ ...SCOPE, sessionId: 'bad\r\nx-injected: 1' }, () => handler(MESSAGES_URL, { method: 'POST' }))
  assert.equal(calls.length, 1, 'the request still reaches the transport')
  assert.equal(calls[0].init.headers, undefined, 'and carries no header the row could not build')
})

test('a transport error is not swallowed by the fail-open path', async () => {
  const boom = new Error('transport down')
  const { handler, als } = probe({
    realFetch: async () => {
      throw boom
    },
  })
  await assert.rejects(() => als.run(SCOPE, () => handler(MESSAGES_URL, { method: 'POST' })), boom)
})

// ── the scope survives a lazy stream ───────────────────────────────────────

test('a transport reached only on the first pull still sees the scope', async () => {
  const { calls, handler, als } = probe()
  const source = (async function* lazy() {
    // The shape pi-ai's streaming adapters take: the HTTP call happens when the
    // iterable is pulled, not when the continuation returns it.
    await handler(MESSAGES_URL, { method: 'POST' })
    yield 'chunk'
  })()
  const stream = inScope(als, SCOPE, source)
  for await (const _ of stream) {
    void _
  }
  assert.equal(calls.length, 1, 'the lazy transport must have run')
  assert.equal(new Headers(calls[0].init.headers).get('x-opencode-session'), SCOPE.sessionId)
})

test('two concurrent scopes do not share an id', async () => {
  const { calls, handler, als } = probe()
  const run = (id, delay) =>
    als.run({ ...SCOPE, sessionId: id }, async () => {
      await new Promise((resolve) => setTimeout(resolve, delay))
      await handler(MESSAGES_URL, { method: 'POST' })
    })
  await Promise.all([run('session-aaaa', 5), run('session-bbbb', 1)])
  const seen = calls.map((call) => new Headers(call.init.headers).get('x-opencode-session')).sort()
  assert.deepEqual(seen, ['session-aaaa', 'session-bbbb'])
})

// ── the row ────────────────────────────────────────────────────────────────

test('the row subscribes, patches once, and restores the transport at the last dispose', () => {
  const surface = { fetch: async () => ({ ok: true }) }
  const original = surface.fetch
  const first = fakeCtx()
  applyWith(first, {}, { surface })
  const patched = surface.fetch
  assert.equal(typeof first.listener('llm/stream'), 'function', 'the row must subscribe to llm/stream')
  assert.notEqual(patched, original, 'the transport must be patched')

  const second = fakeCtx()
  applyWith(second, {}, { surface })
  assert.equal(surface.fetch, patched, 'a second activation must not stack patches')

  first.dispose()
  assert.equal(surface.fetch, patched, 'one live reference still needs the patch')
  second.dispose()
  assert.equal(surface.fetch, original, 'the last dispose must restore the original')
})

test('a disabled row patches nothing and subscribes to nothing', () => {
  const surface = { fetch: async () => ({ ok: true }) }
  const original = surface.fetch
  const ctx = fakeCtx()
  applyWith(ctx, { enabled: false }, { surface })
  assert.equal(surface.fetch, original)
  assert.equal(ctx.listener('llm/stream'), undefined)
})

test('a Host without ctx.on is reported, not thrown at', () => {
  const surface = { fetch: async () => ({ ok: true }) }
  const original = surface.fetch
  const ctx = { logger: { warn: () => {} } }
  assert.doesNotThrow(() => applyWith(ctx, {}, { surface }))
  assert.equal(surface.fetch, original)
})

test('the row carries the scope through a lazy adapter stream', async () => {
  const ctx = fakeCtx()
  const calls = []
  const surface = {
    fetch: async (input, init) => {
      calls.push({ input, init })
      return { ok: true }
    },
  }
  applyWith(ctx, {}, { surface })

  const stream = ctx.listener('llm/stream')(
    { provider: 'opencodego', sessionId: 'session-abc' },
    () =>
      (async function* adapter() {
        await surface.fetch(MESSAGES_URL, { method: 'POST' })
        yield { type: 'finish' }
      })(),
  )
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)

  assert.deepEqual(chunks, [{ type: 'finish' }], 'the stream must pass through untouched')
  assert.equal(new Headers(calls[0].init.headers).get('x-opencode-session'), 'session-abc')
})

test('the row leaves several concurrent conversations on their own ids', async () => {
  const ctx = fakeCtx()
  const calls = []
  const surface = {
    fetch: async (input, init) => {
      const id = new Headers(init.headers).get('x-opencode-session')
      await new Promise((resolve) => setTimeout(resolve, id.endsWith('1') ? 1 : 5))
      calls.push({ input, init })
      return { ok: true }
    },
  }
  applyWith(ctx, {}, { surface })
  const listen = ctx.listener('llm/stream')

  const run = (id) =>
    listen({ provider: 'opencodego', sessionId: id }, () =>
      (async function* adapter() {
        await surface.fetch(MESSAGES_URL, { method: 'POST' })
        yield { type: 'finish' }
      })(),
    )
  const drain = async (id) => {
    for await (const _ of run(id)) void _
  }
  await Promise.all([drain('session-1'), drain('session-2')])
  const seen = calls.map((call) => new Headers(call.init.headers).get('x-opencode-session')).sort()
  assert.deepEqual(seen, ['session-1', 'session-2'])
})
