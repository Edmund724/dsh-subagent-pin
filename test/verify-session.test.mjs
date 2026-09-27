/**
 * The offline half of the field checklist, tested against logs built here.
 *
 * `tools/verify-session.mjs` exists so that the rows of the README's checklist
 * that are string comparisons stop being manual: given a run's lead log (and the
 * child logs it names), it asserts that every child actually ran on the route
 * the run's own frozen model list implies. It reads logs and nothing else — no
 * live Settings, no running Harness — so a check is reproducible on any machine
 * that holds the same evidence.
 *
 * What it must get right is the reading, so each test builds the log shape it
 * needs: the frozen list, the delegator's own header, a `subagent/catalog` entry
 * pointing at a sibling child directory, and the child's header/descriptor.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

import { verifySessionLogs } from '../tools/verify-session.mjs'

/** The repository root, and the tool the CLI tests run. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOOL = join(ROOT, 'tools', 'verify-session.mjs')

/** The route the frozen list authorizes, and the route the delegator itself runs. */
const DEFAULT_ROUTE = { provider: 'opencodego', model: 'space-bunny-free' }
const LEAD_ROUTE = { provider: 'opencodego', model: 'deepseek-v4.1-flash' }

/** Write one log as a single zstd frame. */
function writeLog(file, events) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, zlib.zstdCompressSync(Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`)))
}

/** A header event carrying one route. */
const header = (route) => ({ type: 'request/header', data: { reason: 'initial', header: { config: { ...route } } } })

/**
 * A sessions directory holding one delegating session and one child.
 *
 * The child's log is a sibling of the lead's, which is where the Host puts it
 * and where the tool derives it from the catalog entry.
 */
function fixture(t, { child, childId = 'child-1', descriptor } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pin-verify-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const lead = join(root, '--project--', 'lead-session', 'session.v4.jsonl.zstd')
  writeLog(lead, [
    { type: 'subagent/model-selection-policy', data: { allowedModels: [DEFAULT_ROUTE] } },
    header(LEAD_ROUTE),
    { type: 'subagent/catalog', data: { version: 0, childId, mode: descriptor?.mode ?? 'continuable', label: 'probe' } },
  ])
  if (child !== undefined) {
    writeLog(join(root, '--project--', childId, 'session.v4.jsonl.zstd'), [...child(descriptor)])
  }
  return lead
}

/** The continuable child a passing run produces. */
const pinnedChild = (descriptor) => [
  header(DEFAULT_ROUTE),
  {
    type: 'subagent/descriptor',
    data: descriptor ?? {
      version: 3,
      mode: 'continuable',
      provider: 'spawn',
      agentProvider: DEFAULT_ROUTE.provider,
      agentModel: DEFAULT_ROUTE.model,
      agentReasoningEffort: 'high',
    },
  },
]

/** One check by name, or a failure naming the checks that do exist. */
function check(result, name) {
  const found = result.checks.find((entry) => entry.name === name)
  assert.notEqual(found, undefined, `no check named "${name}"; found ${result.checks.map((entry) => entry.name).join(', ')}`)
  return found
}

test('a run whose child holds the frozen default passes, with the expectation read from the log', (t) => {
  const result = verifySessionLogs({ lead: fixture(t, { child: pinnedChild }) })
  assert.equal(result.ok, true)
  assert.deepEqual(result.expected, { ...DEFAULT_ROUTE, from: 'log' })
  assert.equal(check(result, 'child "probe" request/header route').observed.model, DEFAULT_ROUTE.model)
})

test('a child that ran another route fails, naming what was seen and what was expected', (t) => {
  const lead = fixture(t, { child: () => [header(LEAD_ROUTE)] })
  const result = verifySessionLogs({ lead })
  assert.equal(result.ok, false)
  const failed = check(result, 'child "probe" request/header route')
  assert.equal(failed.ok, false)
  assert.deepEqual(failed.expected, DEFAULT_ROUTE)
  assert.equal(failed.observed.model, LEAD_ROUTE.model)
})

test('a continuable descriptor that disagrees with the child\'s own header fails', (t) => {
  const lead = fixture(t, {
    child: pinnedChild,
    descriptor: { version: 3, mode: 'continuable', provider: 'spawn', agentProvider: 'kimi-coding', agentModel: 'k3-256k' },
  })
  const result = verifySessionLogs({ lead })
  assert.equal(result.ok, false)
  assert.equal(check(result, 'child "probe" continuable descriptor route').ok, false)
})

test('an explicit expectation replaces the one the log implies', (t) => {
  const lead = fixture(t, { child: pinnedChild })
  assert.equal(verifySessionLogs({ lead, expect: { provider: 'kimi-coding', model: 'k3-256k' } }).ok, false)
  assert.deepEqual(check(verifySessionLogs({ lead, expect: DEFAULT_ROUTE }), 'child "probe" request/header route').ok, true)
  assert.equal(verifySessionLogs({ lead, expect: DEFAULT_ROUTE }).expected.from, 'expect')
})

test('a configured default outside the frozen list is refused, as the plugin refuses it', (t) => {
  const result = verifySessionLogs({ lead: fixture(t, { child: pinnedChild }), defaultModel: { provider: 'kimi-coding', model: 'k3-256k' } })
  assert.equal(result.ok, false)
  assert.equal(check(result, 'expected default is one the frozen list authorizes').ok, false)
})

test('a one-shot child is judged by its header, and its descriptor says so', (t) => {
  // A one-shot descriptor carries no route fields at all (only continuable
  // ones do), so the child's own `request/header` is the evidence.
  const lead = fixture(t, {
    child: () => [header(DEFAULT_ROUTE), { type: 'subagent/descriptor', data: { version: 3, mode: 'one-shot', provider: 'spawn', label: 'probe' } }],
    descriptor: { mode: 'one-shot' },
  })
  const result = verifySessionLogs({ lead })
  assert.equal(result.ok, true)
  assert.match(check(result, 'child "probe" continuable descriptor route').note, /one-shot/)
})

test('a child named by the catalog but missing from disk fails instead of crashing', (t) => {
  const result = verifySessionLogs({ lead: fixture(t, {}) })
  assert.equal(result.ok, false)
  assert.match(check(result, 'child "probe" log is readable').observed, /child-1/)
})

test('the CLI prints one line per check and exits zero on a passing run', (t) => {
  const good = fixture(t, { child: pinnedChild })
  const output = execFileSync(process.execPath, [TOOL, '--lead', good], { encoding: 'utf8' })
  assert.match(output, /ok\s+child "probe" request\/header route/)
  assert.match(output, /ok\s+lead: request\/header route/)
})

test('the CLI exits non-zero on a failing run', (t) => {
  const bad = fixture(t, { child: () => [header(LEAD_ROUTE)] })
  assert.throws(
    () => execFileSync(process.execPath, [TOOL, '--lead', bad], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    (error) => error.status === 1,
  )
})
