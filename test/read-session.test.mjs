/**
 * The evidence reader, tested against logs this file builds itself.
 *
 * `tools/read-session.mjs` is the only part of this repository that reads a
 * durable session log, and until now it had no consumer and no test: the frame
 * splitting its JSDoc promised, the CLI's type filter, and what the CLI prints
 * were all unverified. The Host writes a log as concatenated zstd frames, so a
 * single decompress yields only the first one — the tests below build that shape
 * on purpose (two frames, then an incomplete trailing one) instead of trusting a
 * fixture nobody regenerates.
 *
 * The CLI is exercised as a process, because what an operator pipes into a
 * terminal is the interface: a filter has to select whole events, and a printed
 * line has to be one complete JSON object.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

import { readSessionLog } from '../tools/read-session.mjs'

/** The repository root, and the tool the CLI tests run. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOOL = join(ROOT, 'tools', 'read-session.mjs')

/** The magic every zstd frame starts with, so a test can forge an incomplete one. */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** One zstd frame carrying exactly the given text. */
const frameText = (text) => zlib.zstdCompressSync(Buffer.from(text))

/** One frame carrying the given events, the way the Host appends them. */
const frame = (events) => frameText(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`)

/** Write one log and hand the test its path, in a directory the test cleans up. */
function logFile(t, bytes) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-pin-read-session-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'session.v4.jsonl.zstd')
  writeFileSync(file, bytes)
  return file
}

/** Run the CLI over one log and parse every printed line back into an event. */
function runCli(file, filter) {
  const argv = [TOOL, file, ...(filter === undefined ? [] : [filter])]
  const stdout = execFileSync(process.execPath, argv, { encoding: 'utf8' })
  return stdout.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
}

test('every concatenated zstd frame is read, in the order it was written', (t) => {
  // One decompress call sees only the first frame, which is exactly the bug the
  // reader exists to avoid.
  const file = logFile(
    t,
    Buffer.concat([
      frame([{ type: 'first', seq: 1 }]),
      frame([{ type: 'second', seq: 2 }, { type: 'third', seq: 3 }]),
    ]),
  )
  assert.deepEqual(readSessionLog(file), [
    { type: 'first', seq: 1 },
    { type: 'second', seq: 2 },
    { type: 'third', seq: 3 },
  ])
})

test('a blank line between events is not an event', (t) => {
  const file = logFile(t, frameText('{"type":"a"}\n\n{"type":"b"}\n'))
  assert.deepEqual(readSessionLog(file).map((event) => event.type), ['a', 'b'])
})

test('an incomplete trailing frame costs only its own events', (t) => {
  // A live log ends with a frame still being written. The reader has to keep
  // what it could read instead of throwing the whole log away.
  const file = logFile(t, Buffer.concat([frame([{ type: 'complete' }]), MAGIC, Buffer.from('half-written')]))
  assert.deepEqual(readSessionLog(file), [{ type: 'complete' }])
})

test('the CLI filter matches a whole event type, never a substring', (t) => {
  // `request` used to select `request/header`, `request/context` and
  // `session/title-llm-request` too, so the printed lines were not the ones the
  // reader asked for.
  const file = logFile(
    t,
    frame([
      { type: 'request/header', data: { header: {} } },
      { type: 'session/title-llm-request', data: {} },
      { type: 'request', data: { asked: true } },
      { type: 'request/context', data: {} },
    ]),
  )
  assert.deepEqual(runCli(file, 'request'), [{ type: 'request', data: { asked: true } }])
})

test('the CLI prints each event whole, as one parseable JSON line', (t) => {
  // The old 1200-character cut turned a real `request/header` (24k–31k) into
  // invalid JSON, so nothing downstream could parse what it printed.
  const text = 'x'.repeat(5000)
  const file = logFile(t, frame([{ type: 'big', data: { text } }]))
  const printed = runCli(file)
  assert.equal(printed.length, 1)
  assert.equal(printed[0].data.text.length, 5000)
})
