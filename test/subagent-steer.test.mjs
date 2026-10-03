/**
 * Failure modes this file pins, written before the implementation existed:
 *
 *  1. the row claims the wrong identity or hard dependencies;
 *  2. either tool ships without a required argument or without a renderer;
 *  3. either definition is written in `defineTool`'s author dialect — the
 *     per-property `required: true` the shipped row was first written in —
 *     which `tools.register()` rejects because it validates `output.schema` as
 *     RAW JSON Schema: `apply` throws, every registration rolls back, and the
 *     entry still looks loaded in every inspect surface;
 *  4. `send_subagent_message` forwards the wrong argument order, drops the text
 *     block, or drops the caller's signal;
 *  5. a caller-less execution reaches the service instead of failing loud;
 *  6. a missing or empty `agent_id`, or a non-string `message`, reaches the
 *     service instead of failing before dispatch;
 *  7. `interrupt_subagent` forwards the wrong authority shape or claims more
 *     than the service acknowledges;
 *  8. the guard denies a call it must allow — a live teammate name, `lead`, the
 *     id-addressed `send_message`, another tool, a caller-less call, or a Host
 *     without `agentTeams`;
 *  9. the guard throws instead of abstaining when the roster read fails;
 * 10. the guard denies without naming the tool that can actually deliver;
 * 11. the prompt section speaks while the tool is invisible, or stops naming
 *     the two tools it exists to disambiguate;
 * 12. the row registers outside the Host's effect scope, so unloading it leaves
 *     a tool, a guard or a section behind;
 * 13. the guard judges a definition shape the registry never holds — it looks
 *     for a top-level `parameters.target`, while every shipped definition is
 *     compiled by `defineTool` into `{ type: 'object', properties: { target },
 *     required: [...] }` before registration, so the criterion is false for
 *     every real call and the guard abstains silently. Same one-hidden-shape
 *     class as 3, on the reading side instead of the writing side.
 *
 * @module dsh-subagent-pin/test/subagent-steer.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// A namespace import rather than named ones: the identity test also pins what
// this module must *not* export, which a named import cannot express.
import * as row from '../subagent-steer.js'
import { violationsOf } from '../test-support/json-schema-subset.mjs'
import { DEFAULT_MEMBERS, steerDoubles, toolExecution } from '../test-support/steer-doubles.mjs'

const { apply, inject, name } = row

const SEND = 'send_subagent_message'
const INTERRUPT = 'interrupt_subagent'
const TEAM_SEND = 'send_message'
const AGENT = { id: 'session-lead' }

/**
 * Seed the tool the guard polices, as the running Host resolves it for a Team member.
 *
 * The seeded `parameters` is the registry-held shape, not the author's property
 * map: `defineTool` runs `parameterSchemaSpecToJsonSchema()` at definition time
 * (dsh-tools/lib/index.js:802, called at :848), so `{ target: { type, required } }`
 * becomes `{ type: 'object', properties: { target: { type } }, required: ['target'] }`
 * before anything reaches `tools.register()`. Seeding the author's map instead is
 * what made every guard test pass while the guard abstained on every real call:
 * `target` is never a top-level key of a shipped definition.
 */
function seedSendMessage(state, shape = 'name') {
  const addressed = shape === 'name' ? { target: { type: 'string' } } : { agent_id: { type: 'string' } }
  const properties = { ...addressed, message: { type: 'string' } }
  state.registered.set(TEAM_SEND, {
    name: TEAM_SEND,
    description: 'seeded',
    parameters: { type: 'object', properties, required: Object.keys(properties) },
    output: { schema: {}, render: () => [] },
  })
}

/** The one guard the row registered. */
function guardOf(state) {
  assert.equal(state.guards.length, 1, 'exactly one guard')
  return state.guards[0]
}

test('declares the row identity, its hard dependencies, and no config interface', () => {
  assert.equal(name, 'subagent-steer')
  assert.deepEqual(inject, ['tools', 'subagents', 'systemPrompt'])

  // This row has no knobs: the patch row ships no `config`, and `Config` is the
  // export DSH projects a row's interface from, so exporting one would promise a
  // form that answers nothing. `test/patch.test.mjs` holds the shipped patch to
  // the same claim from the other side.
  assert.equal(row.Config, undefined, 'the steering row must export no Config')
})

test('registers both steering tools with raw schemas, required names and a renderer', () => {
  const { ctx, state, dispose } = steerDoubles()
  apply(ctx)

  const send = state.registered.get(SEND)
  assert.ok(send, `${SEND} registered`)
  assert.equal(send.parameters.type, 'object')
  assert.deepEqual(Object.keys(send.parameters.properties).sort(), ['agent_id', 'message'])
  assert.deepEqual(send.parameters.required, ['agent_id', 'message'])
  assert.equal(send.output.schema.type, 'object')
  assert.deepEqual(send.output.schema.required, ['messageId'])
  assert.equal(typeof send.output.render, 'function')
  assert.equal(typeof send.execute, 'function')

  const interrupt = state.registered.get(INTERRUPT)
  assert.ok(interrupt, `${INTERRUPT} registered`)
  assert.deepEqual(Object.keys(interrupt.parameters.properties), ['agent_id'])
  assert.deepEqual(interrupt.parameters.required, ['agent_id'])
  assert.deepEqual(interrupt.output.schema.required, ['accepted'])
  assert.equal(typeof interrupt.output.render, 'function')

  dispose()
})

test('every registered definition stays inside the raw JSON Schema subset', () => {
  // The failure this pins: the row was first written in `defineTool`'s author
  // dialect and handed straight to `tools.register()`, which validates
  // `output.schema` as raw JSON Schema and threw inside `apply`. The fiber
  // failed, all three registrations rolled back, and nothing about the entry
  // looked wrong from outside.
  const { ctx, state, dispose } = steerDoubles()
  apply(ctx)

  assert.deepEqual([...state.registered.keys()].sort(), [INTERRUPT, SEND])
  for (const definition of state.registered.values()) {
    assert.deepEqual(violationsOf(definition.parameters), [], `${definition.name} parameters`)
    assert.deepEqual(violationsOf(definition.output.schema), [], `${definition.name} output.schema`)
  }
  dispose()
})

test('the ported schema checker rejects the author dialect it exists to catch', () => {
  // A checker that accepts everything pins nothing: this is the exact shape the
  // row shipped, in both the output and the parameters position, next to the
  // raw form the registry accepts.
  assert.deepEqual(
    violationsOf({ type: 'object', additionalProperties: false, properties: { messageId: { type: 'string', required: true } } }),
    ['schema.properties.messageId.required is not supported on type "string"'],
  )
  assert.deepEqual(
    violationsOf({ type: 'object', properties: { agent_id: { type: 'string', required: true } }, required: ['agent_id'] }),
    ['schema.properties.agent_id.required is not supported on type "string"'],
  )
  assert.deepEqual(
    violationsOf({ type: 'object', additionalProperties: false, properties: { messageId: { type: 'string' } }, required: ['messageId'] }),
    [],
  )
  assert.deepEqual(violationsOf({ type: 'object', properties: {}, required: ['missing'] }), ['schema.required names "missing" which is not in properties'])
})

test('the seeded definition is the shape the registry really holds', () => {
  // Failure mode 13, pinned on the fixture itself: the guard's criterion is only
  // as real as the definition it is handed. The author's flat property map —
  // `{ target: {}, message: {} }` — passes no check the registry would apply, so
  // a fixture written that way cannot fail the way the Host fails. The raw subset
  // rejects it, exactly as the compiled shape passes.
  const { ctx, state, dispose } = steerDoubles()
  apply(ctx)
  seedSendMessage(state)

  const seeded = state.registered.get(TEAM_SEND)
  assert.deepEqual(violationsOf(seeded.parameters), [])
  assert.deepEqual(Object.keys(seeded.parameters.properties), ['target', 'message'])

  assert.notDeepEqual(violationsOf({ target: {}, message: {} }), [])
  dispose()
})

test('send_subagent_message forwards sender, id, text blocks and the call signal', async () => {
  const { ctx, state, dispose } = steerDoubles({ messageId: 'inbox-7' })
  apply(ctx)
  const signal = new AbortController().signal

  const value = await state.registered.get(SEND).execute(
    { agent_id: 'child-1', message: 'please continue' },
    { agent: AGENT, signal },
  )

  assert.deepEqual(state.calls, [{
    method: 'sendMessage',
    sender: AGENT,
    targetId: 'child-1',
    content: [{ type: 'text', text: 'please continue' }],
    options: { signal },
  }])
  assert.deepEqual(value, { messageId: 'inbox-7' })
  dispose()
})

test('send_subagent_message refuses a caller-less execution without calling the service', async () => {
  const { ctx, state, dispose } = steerDoubles()
  apply(ctx)

  await assert.rejects(
    () => state.registered.get(SEND).execute({ agent_id: 'child-1', message: 'x' }, { signal: new AbortController().signal }),
    new RegExp(SEND),
  )
  assert.deepEqual(state.calls, [])
  dispose()
})

test('send_subagent_message refuses a missing or empty agent_id or a non-string message', async () => {
  const { ctx, state, dispose } = steerDoubles()
  apply(ctx)
  const send = state.registered.get(SEND)
  const caller = { agent: AGENT, signal: new AbortController().signal }

  await assert.rejects(() => send.execute({ message: 'x' }, caller), /agent_id/)
  await assert.rejects(() => send.execute({ agent_id: '   ', message: 'x' }, caller), /agent_id/)
  await assert.rejects(() => send.execute({ agent_id: 42, message: 'x' }, caller), /agent_id/)
  await assert.rejects(() => send.execute({ agent_id: 'child-1' }, caller), /message/)
  await assert.rejects(() => send.execute(undefined, caller), /agent_id/)

  assert.deepEqual(state.calls, [])
  dispose()
})

test('interrupt_subagent refuses a missing or empty agent_id', () => {
  const { ctx, state, dispose } = steerDoubles()
  apply(ctx)
  const interrupt = state.registered.get(INTERRUPT)

  assert.throws(() => interrupt.execute({}, { agent: AGENT }), /agent_id/)
  assert.throws(() => interrupt.execute({ agent_id: '' }, { agent: AGENT }), /agent_id/)
  assert.throws(() => interrupt.execute(undefined, { agent: AGENT }), /agent_id/)

  assert.deepEqual(state.calls, [])
  dispose()
})

test('interrupt_subagent forwards the ancestor authority and reports acceptance', async () => {
  const { ctx, state, dispose } = steerDoubles()
  apply(ctx)

  const value = await state.registered.get(INTERRUPT).execute({ agent_id: 'child-1' }, { agent: AGENT })

  assert.deepEqual(state.calls, [{
    method: 'interrupt',
    targetSessionId: 'child-1',
    authority: { kind: 'ancestor', agent: AGENT },
  }])
  assert.deepEqual(value, { accepted: true })
  dispose()
})

test('interrupt_subagent refuses a caller-less execution without calling the service', () => {
  const { ctx, state, dispose } = steerDoubles()
  apply(ctx)

  assert.throws(
    () => state.registered.get(INTERRUPT).execute({ agent_id: 'child-1' }, {}),
    new RegExp(INTERRUPT),
  )
  assert.deepEqual(state.calls, [])
  dispose()
})

test('the guard abstains for a live teammate name', () => {
  const { ctx, state, dispose } = steerDoubles()
  apply(ctx)
  seedSendMessage(state)

  assert.equal(guardOf(state)(toolExecution({ arguments: { target: 'researcher', message: 'hi' } })), undefined)
  dispose()
})

test('the guard abstains for lead', () => {
  const { ctx, state, dispose } = steerDoubles()
  apply(ctx)
  seedSendMessage(state)

  assert.equal(guardOf(state)(toolExecution({ arguments: { target: 'lead', message: 'hi' } })), undefined)
  dispose()
})

test('the guard denies an unknown target and names both tools', () => {
  const { ctx, state, dispose } = steerDoubles()
  apply(ctx)
  seedSendMessage(state)

  const reason = guardOf(state)(toolExecution({
    arguments: { target: 'ba26b4a7-1103-4643-95e6-63b4651d1a9a', message: 'hi' },
  }))

  assert.equal(typeof reason, 'string')
  assert.match(reason, new RegExp(SEND))
  assert.match(reason, /list_agents/)
  assert.match(reason, /ba26b4a7-1103-4643-95e6-63b4651d1a9a/)
  dispose()
})

test('the guard abstains when the agent resolves the id-addressed send_message', () => {
  const { ctx, state, dispose } = steerDoubles()
  apply(ctx)
  seedSendMessage(state, 'id')

  assert.equal(guardOf(state)(toolExecution({ arguments: { agent_id: 'child-1', message: 'hi' } })), undefined)
  dispose()
})

test('the guard abstains without the agentTeams service', () => {
  const { ctx, state, dispose } = steerDoubles({ withTeams: false })
  apply(ctx)
  seedSendMessage(state)

  assert.equal(guardOf(state)(toolExecution({ arguments: { target: 'nobody', message: 'hi' } })), undefined)
  dispose()
})

test('the guard abstains for a caller-less or malformed call', () => {
  const { ctx, state, dispose } = steerDoubles()
  apply(ctx)
  seedSendMessage(state)
  const guard = guardOf(state)

  assert.equal(guard(toolExecution({ callerless: true, arguments: { target: 'nobody' } })), undefined)
  assert.equal(guard(toolExecution({ arguments: undefined })), undefined)
  assert.equal(guard(toolExecution({ arguments: { target: 42 } })), undefined)
  assert.equal(guard(toolExecution({ arguments: { target: '   ' } })), undefined)
  assert.equal(guard({ name: TEAM_SEND }), undefined)
  dispose()
})

test('the guard abstains for other tool names', () => {
  const { ctx, state, dispose } = steerDoubles()
  apply(ctx)
  seedSendMessage(state)

  assert.equal(guardOf(state)(toolExecution({ name: 'spawn_teammate', arguments: { target: 'nobody' } })), undefined)
  dispose()
})

test('the guard abstains when the roster read fails', () => {
  const { ctx, state, dispose } = steerDoubles({
    teams: { listMembers: () => { throw new Error('journal unavailable') } },
  })
  apply(ctx)
  seedSendMessage(state)

  assert.equal(guardOf(state)(toolExecution({ arguments: { target: 'nobody' } })), undefined)
  dispose()
})

test('the prompt section is silent until the tool is visible and then names both tools', () => {
  const visible = steerDoubles()
  apply(visible.ctx)
  assert.equal(visible.state.sections.length, 1)
  const section = visible.state.sections[0]
  assert.equal(section.order, 42)

  const text = section.text({ scope: {} })
  assert.match(text, new RegExp(SEND))
  assert.match(text, new RegExp(TEAM_SEND))
  assert.match(text, /agent id/)
  visible.dispose()

  const hidden = steerDoubles({ visibility: (toolName) => toolName !== SEND })
  apply(hidden.ctx)
  assert.equal(hidden.state.sections[0].text({ scope: {} }), '')
  hidden.dispose()
})

test('disposing the row unregisters the tools, the guard and the section', async () => {
  const { ctx, state, dispose } = steerDoubles()
  apply(ctx)
  assert.deepEqual([...state.registered.keys()].sort(), [INTERRUPT, SEND])
  assert.equal(state.guards.length, 1)
  assert.equal(state.sections.length, 1)

  await dispose()

  assert.deepEqual([...state.registered.keys()], [])
  assert.deepEqual(state.guards, [])
  assert.deepEqual(state.sections, [])
})

test('the roster shape the guard reads matches the shipped view', () => {
  // The guard compares names only; this pins the field it relies on so a Host
  // rename of `name` shows up as a red test rather than a silent abstention.
  assert.ok(DEFAULT_MEMBERS.every((member) => typeof member.name === 'string'))
})
