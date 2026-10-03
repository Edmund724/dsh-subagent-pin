/**
 * Host plugin row: restore id-addressed subagent steering when Agent Teams owns
 * the `send_message` name.
 *
 * Why it exists: DSH ships two tools called `send_message` with different
 * arguments. `dsh-tool-subagent-control` registers the global one,
 * `send_message({ agent_id })`, which addresses a continuable subagent or parent
 * by **agent id**; Agent Teams registers the scoped one,
 * `send_message({ target })`, which addresses a **teammate name** into every
 * Team member's agent scope. The Agent Teams profile layer this environment
 * mounts disables the global row outright (`tool-subagent-control: disabled:
 * true` in `@deepseek-ai/dsh-experimental-agent-team-profile`), and where both
 * are mounted the tools registry resolves the nearest scope instead — either way
 * a Team member, the Lead included, cannot reach a subagent by the id it was
 * just handed. `subagent` / `subagent_fork` still return that id and still tell
 * the model to continue the child with `send_message`, so the call fails with
 * `active teammate "<uuid>" not found`.
 *
 * What this row does about it, in three parts:
 *
 *  - `send_subagent_message` and `interrupt_subagent` give the missing
 *    capability a name of its own, so no scope collision is involved;
 *  - a global guard turns the dead end into a redirection: when the scope
 *    resolves the name-addressed `send_message` and the target is neither a
 *    live teammate nor `lead`, the call is denied with the tool that can
 *    actually deliver the message;
 *  - a prompt section states the split once, because the misleading sentence
 *    lives in another package's tool description and cannot be edited here.
 *
 * This row is a fix for a Host defect, not a feature: delete it once upstream
 * either stops reusing the `send_message` name or teaches its description the
 * same scope check its return guidance already performs. The three signals are
 * listed in `README.md`「何时删掉这一行」.
 *
 * Both definitions are written in raw JSON Schema, not in `defineTool`'s author
 * dialect: `tools.register()` validates `output.schema` as-is and hands
 * `parameters` to the model as-is, so the author-only per-property
 * `required: true` throws `UNSUPPORTED_SCHEMA` inside `apply` and takes the
 * whole row down with it. Requiredness is the `required` array, and `execute`
 * re-checks the arguments itself, because only `defineTool` installs the
 * argument validator.
 *
 * ## Host shapes this row reads (declared here once, as the delegation seam is
 * in `host-contract.js` and the session-header seam is in `opencode-header.js`)
 *
 * - `tools.register(definition)` — validates `output { schema, render }` and the
 *   raw JSON Schema subset before it stores anything, and its return value is
 *   this row's disposer;
 * - `tools.guard(fn)` — `fn(execution)` returns a denial reason or `undefined`
 *   to abstain; the Host normalizes a *thrown* guard into an error result, which
 *   is why this row's guard never throws;
 * - `tools.get(name, scope)` — resolves the definition one calling agent's scope
 *   really sees, which is the only sound source for "is this the name-addressed
 *   `send_message`?";
 * - `systemPrompt.section({ name, order, text })` and
 *   `systemPrompt.getSectionOrder(name)` — an ordered section whose `text` is a
 *   function of the current scope;
 * - `subagents.sendMessage(sender, targetId, content, options)` and
 *   `subagents.interrupt(targetSessionId, authority)`;
 * - `agentTeams.listMembers(agent)`, read **optionally** through `ctx.get`:
 *   absent means the Host has no Team feature, and the guard then abstains
 *   rather than failing.
 *
 * `test-support/steer-doubles.mjs` stands in for these shapes on a real Cordis
 * context and reproduces the two checks `tools.register()` performs; the
 * registry-held definition shape is what `isNameAddressed()` reads.
 *
 * @module dsh-subagent-pin/subagent-steer
 */

export const name = 'subagent-steer'

/** The three registries this row writes to; all three are hard dependencies. */
export const inject = ['tools', 'subagents', 'systemPrompt']

const SEND_TOOL = 'send_subagent_message'
const INTERRUPT_TOOL = 'interrupt_subagent'
const TEAM_SEND_TOOL = 'send_message'
const LEAD_NAME = 'lead'

const SEND_DESCRIPTION = 'Send a message to one of your direct continuable subagents, addressed by the agent id it returned from subagent / subagent_fork. A running subagent receives it at its next step; an idle one starts a new turn. Returns delivery confirmation, not the subagent\'s answer.'

const INTERRUPT_DESCRIPTION = 'Ask a subagent created under you to stop its current work, addressed by the agent id it returned from subagent / subagent_fork. Returns without waiting for it to stop; its pending inbox and the subagents it started keep running.'

/**
 * Register the two steering tools, the guard, and the prompt section.
 *
 * @param ctx - the row's Cordis context, carrying `tools`, `subagents` and
 *   `systemPrompt` through `inject`.
 */
export function apply(ctx) {
  ctx.tools.register({
    name: SEND_TOOL,
    description: SEND_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'The agent id returned by subagent / subagent_fork for one of your direct continuable children, or your direct parent\'s agent id when you are a continuable child.',
        },
        message: {
          type: 'string',
          description: 'The message to deliver to the subagent.',
        },
      },
      required: ['agent_id', 'message'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { messageId: { type: 'string' } },
        required: ['messageId'],
      },
      render: (args, value) => [{ type: 'text', text: `message delivered to subagent ${args.agent_id} (${value.messageId})` }],
    },
    async execute(args, exec) {
      const sender = exec?.agent
      if (sender === undefined) throw new Error(`${SEND_TOOL} requires a calling agent (exec.agent was undefined)`)
      const agentId = readAgentId(SEND_TOOL, args)
      const message = args?.message
      if (typeof message !== 'string') throw new Error(`${SEND_TOOL} requires a string message`)
      const messageId = await ctx.subagents.sendMessage(
        sender,
        agentId,
        [{ type: 'text', text: message }],
        { signal: exec.signal },
      )
      return { messageId }
    },
  })

  ctx.tools.register({
    name: INTERRUPT_TOOL,
    description: INTERRUPT_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'The agent id of a subagent created under you: a direct child or a deeper descendant.',
        },
      },
      required: ['agent_id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { accepted: { type: 'boolean' } },
        required: ['accepted'],
      },
      render: (args) => [{ type: 'text', text: `interrupt requested for subagent ${args.agent_id}` }],
    },
    execute(args, exec) {
      const sender = exec?.agent
      if (sender === undefined) throw new Error(`${INTERRUPT_TOOL} requires a calling agent (exec.agent was undefined)`)
      ctx.subagents.interrupt(readAgentId(INTERRUPT_TOOL, args), { kind: 'ancestor', agent: sender })
      return Promise.resolve({ accepted: true })
    },
  })

  ctx.tools.guard((execution) => nameAddressedMiss(ctx, execution))

  ctx.systemPrompt.section({
    name: `tool:${SEND_TOOL}`,
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: (context) => (ctx.tools.get(SEND_TOOL, context?.scope) === undefined ? '' : splitText()),
  })
}

/**
 * Read the one argument both tools address their target with.
 *
 * The raw schema above states requiredness to the model, but the registry only
 * validates arguments for `defineTool` definitions, so the check that keeps a
 * malformed call away from the subagent service lives here.
 *
 * @param toolName - the tool being executed, named in the failure.
 * @param args - the parsed model arguments, of unknown shape.
 * @returns the agent id as the model supplied it.
 */
function readAgentId(toolName, args) {
  const agentId = args?.agent_id
  if (typeof agentId !== 'string' || agentId.trim() === '') {
    throw new Error(`${toolName} requires a non-empty agent_id: pass the id returned by subagent / subagent_fork`)
  }
  return agentId
}

/**
 * Decide whether one pre-execution guard call must be denied.
 *
 * Abstains (returns `undefined`) for every call it cannot fully judge: another
 * tool, a caller-less call, a scope that resolves the id-addressed
 * `send_message`, a missing roster, a roster read that fails, or a target that
 * is not a usable string. It denies only the one case it can judge — the
 * name-addressed tool, a live Team member, and a target no member answers to.
 *
 * @param ctx - the row's context, read for the resolved tool and the roster.
 * @param execution - the Host's frozen pre-execution call snapshot.
 * @returns a denial reason, or `undefined` to abstain.
 */
function nameAddressedMiss(ctx, execution) {
  if (execution?.name !== TEAM_SEND_TOOL) return undefined
  const agent = execution.agent
  if (agent === undefined) return undefined
  if (!isNameAddressed(ctx.tools.get(TEAM_SEND_TOOL, agent))) return undefined
  const target = readTarget(execution.arguments)
  if (target === undefined || target === LEAD_NAME) return undefined
  const teams = ctx.get('agentTeams')
  if (teams === undefined || typeof teams.listMembers !== 'function') return undefined
  let members
  try {
    members = teams.listMembers(agent)
  } catch {
    return undefined
  }
  if (!Array.isArray(members)) return undefined
  if (members.some((member) => member?.name === target)) return undefined
  return `"${target}" is not a live teammate name: ${TEAM_SEND_TOOL} addresses Team members by name only (see list_agents) and cannot address a subagent by id. To message or continue a subagent whose agent id came from subagent / subagent_fork, deliver it with ${SEND_TOOL}({ agent_id, message }).`
}

/**
 * Read whether one resolved definition is the name-addressed `send_message`.
 *
 * Reads `parameters.properties` — the shape the registry actually holds. Every
 * shipped definition is compiled by `defineTool` before registration
 * (`parameterSchemaSpecToJsonSchema`, dsh-tools/lib/index.js:802, called at
 * :848), which moves the author's property map under `properties` and collects
 * the required names into `required`. A criterion that looks for a top-level
 * `parameters.target` therefore finds nothing on any real definition and leaves
 * the guard silently abstaining for every call it exists to catch.
 *
 * @param definition - the definition the calling scope resolves, if any.
 * @returns whether its arguments name a `target`.
 */
function isNameAddressed(definition) {
  const properties = definition?.parameters?.properties
  return properties !== null && typeof properties === 'object' && 'target' in properties
}

/**
 * Read the trimmed `target` argument of a call that may not be shaped yet.
 *
 * @param args - the parsed model arguments, of unknown shape.
 * @returns the trimmed target, or `undefined` when there is no usable one.
 */
function readTarget(args) {
  if (args === null || typeof args !== 'object') return undefined
  if (typeof args.target !== 'string') return undefined
  const target = args.target.trim()
  return target.length === 0 ? undefined : target
}

/**
 * The one sentence that states the split between the two tools.
 *
 * @returns the prompt text, naming both tools so the split cannot drift.
 */
function splitText() {
  return `To message or continue a subagent, pass the agent id returned by subagent / subagent_fork to ${SEND_TOOL}({ agent_id, message }); an idle child resumes on delivery. ${TEAM_SEND_TOOL} addresses Team members by name only and cannot address a subagent id, and ${INTERRUPT_TOOL}({ agent_id }) stops a running subagent.`
}
