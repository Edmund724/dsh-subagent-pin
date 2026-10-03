/**
 * Host doubles for the steering row, built on the real Cordis runtime.
 *
 * The steering row reads four Host shapes: `tools.register / guard / get`,
 * `systemPrompt.section / getSectionOrder`, `subagents.sendMessage / interrupt`
 * and the optional `agentTeams.listMembers`. A hand-written object literal can
 * produce those shapes, but only by re-stating them in every file that needs
 * one — so a double here is a real `Service` on a real `Context`, and the
 * members the row reads are the ones the Host actually exposes.
 *
 * Two knobs exist because the row's guard has to abstain in cases the shipped
 * Host produces and a fixed double cannot: `visibility` decides what
 * `tools.get()` answers for a scope, and `teams` replaces the `agentTeams`
 * service (or omits it) so the absent-service path is testable.
 *
 * Unlike a shape-only double, `tools.register()` here performs the two checks
 * the shipped registry performs before it stores anything — `output
 * { schema, render }` and the raw JSON Schema subset — because a double that
 * accepts any definition cannot fail the way the Host fails.
 *
 * This module sits beside `host-doubles.mjs`, which doubles the *delegation*
 * seam the pin row wraps; the two are separate modules because they stand for
 * two different Host seams, and its factory is named `steerDoubles` so a test
 * file can take both without renaming either import.
 *
 * This directory sits beside `test/` rather than inside it because Node's
 * default test glob matches everything under a `test` directory.
 *
 * @module dsh-subagent-pin/test-support/steer-doubles
 */

import { Context, Service } from '@deepseek-ai/cordis'

import { assertSupportedSchema } from './json-schema-subset.mjs'

/** The `tools` registry, shaped like the shipped one for the three members read here. */
class ToolsService extends Service {
  constructor(ctx, state) {
    super(ctx, 'tools')
    this.state = state
    this.parent = ctx
  }

  register(definition) {
    const { registered } = this.state
    const output = definition.output
    if (output === undefined || typeof output !== 'object' || typeof output.render !== 'function') {
      throw new TypeError(`tool "${definition.name}" must declare output { schema, render }`)
    }
    assertSupportedSchema(output.schema, `tool "${definition.name}" output.schema`)
    if (registered.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered in this scope`)
    registered.set(definition.name, definition)
    return this.parent.effect(() => () => {
      registered.delete(definition.name)
    })
  }

  get(name, scope) {
    return this.state.visibility(name, scope) ? this.state.registered.get(name) : undefined
  }

  guard(guard) {
    this.state.guards.push(guard)
    return this.parent.effect(() => () => {
      const index = this.state.guards.indexOf(guard)
      if (index >= 0) this.state.guards.splice(index, 1)
    })
  }
}

/** The `systemPrompt` registry, limited to ordered sections. */
class PromptService extends Service {
  constructor(ctx, state) {
    super(ctx, 'systemPrompt')
    this.state = state
    this.parent = ctx
  }

  getSectionOrder(name) {
    return this.state.orders[name] ?? 100
  }

  section(section) {
    this.state.sections.push(section)
    return this.parent.effect(() => () => {
      const index = this.state.sections.indexOf(section)
      if (index >= 0) this.state.sections.splice(index, 1)
    })
  }
}

/** The `subagents` service, recording every call the row makes. */
class SubagentsService extends Service {
  constructor(ctx, state) {
    super(ctx, 'subagents')
    this.state = state
  }

  sendMessage(sender, targetId, content, options) {
    this.state.calls.push({ method: 'sendMessage', sender, targetId, content, options })
    return Promise.resolve(this.state.messageId)
  }

  interrupt(targetSessionId, authority) {
    this.state.calls.push({ method: 'interrupt', targetSessionId, authority })
  }
}

/** A roster with one Lead and one teammate, the shape `agentTeams.listMembers()` returns. */
export const DEFAULT_MEMBERS = [
  { id: 'session-lead', name: 'lead', role: 'lead', status: 'running', diagnostics: [] },
  { id: 'session-researcher', name: 'researcher', role: 'teammate', status: 'inactive', diagnostics: [] },
]

/**
 * Build one Host context carrying the services this row reads.
 *
 * @param options.members - What `agentTeams.listMembers()` answers with.
 * @param options.visibility - `(name, scope) => boolean`; false hides a tool from `tools.get()`.
 * @param options.orders - Section orders `getSectionOrder()` resolves.
 * @param options.messageId - The inbox id `subagents.sendMessage()` resolves with.
 * @param options.teams - Replace the `agentTeams` service entirely.
 * @param options.withTeams - `false` composes a Host without `agentTeams`.
 * @returns `{ ctx, state, dispose }`, where `dispose()` runs the effects the row
 *   registered and resolves once they are gone — Cordis disposes fibers
 *   asynchronously, so a test that asserts post-disposal state must await it.
 */
export function steerDoubles({ members, visibility, orders, messageId, teams, withTeams = true } = {}) {
  const ctx = new Context()
  const state = {
    registered: new Map(),
    guards: [],
    sections: [],
    calls: [],
    orders: orders ?? { TOOL_SUBAGENT: 42 },
    visibility: visibility ?? (() => true),
    members: members ?? DEFAULT_MEMBERS,
    messageId: messageId ?? 'message-1',
  }
  new ToolsService(ctx, state)
  new PromptService(ctx, state)
  new SubagentsService(ctx, state)
  if (withTeams) ctx.provide('agentTeams', teams ?? { listMembers: () => state.members })
  return { ctx, state, dispose: () => ctx.fiber.dispose() }
}

/**
 * One call input for the guard, with every field the row reads spelled out.
 *
 * @param options.name - The called tool name.
 * @param options.arguments - The parsed model arguments.
 * @param options.agent - The calling Agent.
 * @param options.callerless - `true` forces `agent: undefined`, which a default
 *   parameter alone cannot express.
 * @returns a frozen object shaped like the Host's `ToolExecution`.
 */
export function toolExecution({ name = 'send_message', arguments: args = {}, agent = { id: 'session-lead' }, callerless = false } = {}) {
  return Object.freeze({ callId: 'call-1', name, arguments: args, agent: callerless ? undefined : agent, signal: new AbortController().signal })
}
