/**
 * Host plugin row: stamp every request to one conversation's own OpenCode Go
 * session, so the gateway's `x-opencode-session` stops being one value shared by
 * every conversation on the machine.
 *
 * Why a transport-level row exists at all: no documented seam carries a
 * per-request header for pi-ai routes. `llm/stream` hands listeners a
 * `GenerateOptions` with no `headers` field, and the loop deep-freezes it; the
 * pi-ai adapter reads headers from the static route profile alone
 * (`dsh-llm-pi-ai/lib/index.js`, `requestHeaders(profile.headers)`). Upstream
 * pi-ai wraps its *catalog* factories from 0.86.0 on, which a hand-declared
 * route that sets `api:` never goes through — and DSH still pins `^0.85.1`. So
 * the only place left is the process transport, narrowed to exactly the
 * requests a model call makes.
 *
 * The narrowing is the contract, and it is testable without a Host:
 *
 * - The header is attached only inside an `llm/stream` scope. The subscription
 *   runs the continuation in an `AsyncLocalStorage`, and the returned iterable
 *   is re-entered per pull — a streaming adapter reaches its transport when the
 *   consumer pulls, not when the continuation returns.
 * - Only `POST` requests count. Discovery's `GET {baseURL}/models`, web fetch,
 *   MCP traffic and every other provider reach the transport byte-identical.
 * - A request is in scope when the routed provider id starts with a configured
 *   prefix *or* the resolved host is a configured gateway domain. Either match
 *   is enough: the provider id and the host it actually reaches are separate
 *   facts, and a hand-declared route may disagree with the catalog.
 * - The value is derived from the conversation's own `sessionId`
 *   (`SessionHeader.id`): a UUID-shaped digest, because that is the one shape
 *   this gateway has been observed to accept. Being a pure function of the id,
 *   it is stable across turns, resume, compaction and retries and distinct per
 *   conversation, subagent child and ACP child — while the local session id
 *   itself never leaves the machine.
 * - A same-name header already on the request is replaced; nothing else is
 *   touched, and no caller-owned object is mutated.
 * - Everything that can fail while judging a request fails open to the original
 *   arguments, so a malformed session id can never turn a healthy model call
 *   into a hard failure. The transport's own errors are never swallowed.
 *
 * This file owns the seam and the decisions in it; the accepted shape of a
 * `config` row is the `Config` exported here, which DSH projects and validates
 * before `apply()` runs. The reasoning behind the transport seam, and what was
 * ruled out, is in `docs/opencode-header.md`.
 *
 * @module @edmund724/dsh-subagent-pin/opencode-header
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'

import z from '@deepseek-ai/schemastery'

/** Diagnostic prefix, shared with the rest of the package's output. */
export const PREFIX = '[opencode-header] '

/** The header the OpenCode Go gateway requires, and the row's default. */
const DEFAULT_HEADER = 'x-opencode-session'

/** Where the installed patch, and its refcount, live on the transport surface. */
const PATCH = Symbol.for('@edmund724/dsh-subagent-pin/opencode-header/patch')

/** Provider ids this row claims by prefix unless the row says otherwise. */
const DEFAULT_PROVIDERS = ['opencode']

/** Gateway domains this row claims unless the row says otherwise. */
const DEFAULT_HOSTS = ['opencode.ai']

/** The row's configuration interface, as data DSH reads before activation. */
export const Config = z.object({
  enabled: z.boolean().default(true).description('Attach the session header at all; false leaves every request untouched.'),
  providers: z.array(z.string().min(1)).default(DEFAULT_PROVIDERS).description('Provider ids claimed by prefix, e.g. "opencode" for "opencodego"; empty claims nothing by this axis.'),
  hosts: z.array(z.string().min(1)).default(DEFAULT_HOSTS).description('Hosts claimed by exact name or subdomain, e.g. "opencode.ai"; empty claims nothing by this axis.'),
  headerName: z.string().min(1).default(DEFAULT_HEADER).description('Header carrying the conversation id; the value is always the current session id.'),
})

/** The config keys this row understands, from the one place that declares them. */
export const KNOWN_KEYS = Object.keys(Config.dict)

/** Raise one activation-visible configuration failure. */
function fail(message) {
  throw new Error(`${PREFIX}${message}`)
}

/**
 * Whether one hostname belongs to a configured gateway domain.
 *
 * The domain itself or any subdomain; `opencode.ai.evil.test` and
 * `notopencode.ai` deliberately do not match.
 */
export function isOpencodeHost(hostname, domains = DEFAULT_HOSTS) {
  if (typeof hostname !== 'string') return false
  const host = hostname.toLowerCase()
  return domains.some((domain) => {
    const suffix = String(domain).toLowerCase()
    return host === suffix || host.endsWith(`.${suffix}`)
  })
}

/**
 * Whether one request is in scope: the provider id starts with a configured
 * prefix, or the host is a configured gateway domain.
 */
export function routeMatch(provider, hostname, gate = {}) {
  const prefixes = gate.providers ?? DEFAULT_PROVIDERS
  const domains = gate.hosts ?? DEFAULT_HOSTS
  const id = typeof provider === 'string' ? provider.toLowerCase() : ''
  if (prefixes.some((prefix) => id.startsWith(String(prefix).toLowerCase()))) return true
  return isOpencodeHost(hostname, domains)
}

/** Read method and URL from fetch arguments without touching a body. */
function describeTarget(input, init) {
  const source =
    typeof input === 'string' || input instanceof URL
      ? input
      : input !== null && typeof input === 'object' && typeof input.url === 'string'
        ? input.url
        : undefined
  if (source === undefined) return undefined
  const url = new URL(String(source))
  const method = String(init?.method ?? (input !== null && typeof input === 'object' ? input.method : undefined) ?? 'GET').toUpperCase()
  return { url, method }
}

/** The same fetch arguments with one header set — the caller's objects untouched. */
function withHeader(input, init, name, value) {
  const source = init?.headers ?? (input !== null && typeof input === 'object' ? input.headers : undefined)
  const headers = new Headers(source)
  headers.set(name, value)
  return [input, { ...(init ?? {}), headers }]
}

/**
 * The value one conversation is identified by: a UUID-shaped digest of its
 * session id.
 *
 * The gateway only ever needed "one stable value per conversation", and the raw
 * DSH session id is that conversation's durable name — sending it would hand a
 * third party a handle on the local session log. A digest keeps everything the
 * gateway asks for (same conversation → same value, different conversations →
 * different values, unguessable) and exposes none of the original.
 *
 * It is a pure function of the id, which is the whole reason there is no mapping
 * table to keep: nothing is stored, so cold resume reads nothing back. DSH
 * persists the session id, and the same id always derives the same value.
 *
 * The shape is a v4 UUID because that is the shape already observed to be
 * accepted (`session-<uuid>` at the top level, a bare UUID for a child); the
 * version and variant bits are set so nobody mistakes it for a real v4 the client
 * generated. Unsalted on purpose: session ids are high-entropy UUIDs already, and
 * leaving the digest reproducible is what lets an operator map an id seen in the
 * gateway's logs back to a local session with this same function.
 */
export function deriveSessionValue(sessionId) {
  const bytes = createHash('sha256').update(String(sessionId), 'utf8').digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Build the fetch-shaped handler at the row's seam.
 *
 * @param config - The row's resolved `headerName`, `providers` and `hosts`.
 * @param realFetch - The transport this handler stands in front of.
 * @param als - The scope `llm/stream` fills; an empty scope means "not a model call".
 */
export function createHandler({ headerName, providers, hosts, realFetch, als }) {
  const gate = { providers, hosts }
  return async function patched(input, init) {
    const store = als.getStore()
    if (store === undefined) return realFetch(input, init)

    let args
    try {
      const target = describeTarget(input, init)
      if (target === undefined || target.method !== 'POST') return realFetch(input, init)
      if (!routeMatch(store.provider, target.url.hostname, gate)) return realFetch(input, init)
      const value = typeof store.sessionId === 'string' && store.sessionId.length > 0 ? deriveSessionValue(store.sessionId) : undefined
      if (value === undefined) return realFetch(input, init)
      args = withHeader(input, init, headerName, value)
    } catch {
      return realFetch(input, init)
    }
    return realFetch(args[0], args[1])
  }
}

/**
 * Run one `llm/stream` continuation inside the scope, and keep it there for the
 * whole iteration.
 *
 * The waterfall continuation returns an `AsyncIterable` whose transport is often
 * reached only when the consumer pulls it — so a scope that ends when `next()`
 * returns is not enough. Each pull is re-entered in the scope, and the source's
 * own `return()` is forwarded so cancellation still closes it.
 */
export function inScope(als, store, source) {
  if (source === null || typeof source !== 'object' || typeof source[Symbol.asyncIterator] !== 'function') return source
  return (async function* iterate() {
    const iterator = source[Symbol.asyncIterator]()
    try {
      for (;;) {
        const step = await als.run(store, () => iterator.next())
        if (step.done === true) return step.value
        yield step.value
      }
    } finally {
      if (typeof iterator.return === 'function') {
        try {
          await als.run(store, () => iterator.return())
        } catch {
          // The source's own teardown result is not this row's to report.
        }
      }
    }
  })()
}

/**
 * The row's config with its defaults filled in.
 *
 * The schema carries these defaults for DSH's own validation and projection;
 * this reader keeps `apply()` honest for a Host that hands a row in raw.
 */
export function resolveConfig(config) {
  const record = config ?? {}
  const headerName = record.headerName ?? DEFAULT_HEADER
  if (typeof headerName !== 'string' || headerName.length === 0) fail('config.headerName must be a non-empty string')
  const providers = record.providers ?? DEFAULT_PROVIDERS
  const hosts = record.hosts ?? DEFAULT_HOSTS
  for (const [field, list] of [['providers', providers], ['hosts', hosts]]) {
    // An empty list is a meaningful choice — "claim nothing by this axis" — so
    // only the entries have to be usable.
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
      fail(`config.${field} must be a list of non-empty strings`)
    }
  }
  return { enabled: record.enabled !== false, headerName, providers, hosts }
}

/** Install the handler on a transport surface once, refcounted. */
function install(surface, handler, original) {
  const current = surface[PATCH]
  if (current !== undefined) {
    current.refs += 1
    return
  }
  Object.defineProperty(surface, PATCH, { value: { original, handler, refs: 1 }, writable: true, configurable: true })
  surface.fetch = handler
}

/** Drop one reference to the installed patch, restoring the transport at zero. */
function uninstall(surface) {
  const state = surface[PATCH]
  if (state === undefined) return
  state.refs -= 1
  if (state.refs > 0) return
  if (surface.fetch === state.handler) surface.fetch = state.original
  delete surface[PATCH]
}

/**
 * Mount the row.
 *
 * @param ctx - Host context; only `on`, `effect` and `logger` are used.
 * @param config - The row's config.
 * @param deps - Test seam: `surface` (defaults to `globalThis`) and `als`.
 */
export function applyWith(ctx, config, deps = {}) {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) {
    ctx.logger?.info?.(`${PREFIX}disabled by config; no request is touched`)
    return
  }
  if (typeof ctx.on !== 'function') {
    // A plugin must never be the reason a Host cannot boot: report and leave the
    // transport alone rather than throwing here.
    ctx.logger?.warn?.(`${PREFIX}this Host exposes no ctx.on(); refusing to touch the transport`)
    return
  }
  const surface = deps.surface ?? globalThis
  const als = deps.als ?? new AsyncLocalStorage()

  const original = surface.fetch
  const existing = surface[PATCH]
  const handler =
    existing?.handler ??
    createHandler({ headerName: resolved.headerName, providers: resolved.providers, hosts: resolved.hosts, realFetch: (input, init) => original(input, init), als })
  install(surface, handler, original)

  ctx.on('llm/stream', (options, next) => {
    const store = { provider: options?.provider, sessionId: options?.sessionId }
    return inScope(als, store, als.run(store, () => next()))
  })

  ctx.effect?.(() => () => uninstall(surface))

  ctx.logger?.info?.(
    `${PREFIX}${resolved.headerName} carries each conversation's session id for providers [${resolved.providers.join(', ')}] ` +
      `and hosts [${resolved.hosts.join(', ')}]; every other request reaches the transport unchanged`,
  )
}

/** The Host entry point. */
export function apply(ctx, config) {
  applyWith(ctx, config, {})
}
