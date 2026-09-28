/**
 * Verify one run's field evidence without a running Harness.
 *
 * The README's checklist has rows that are pure string comparisons once a run
 * has produced its logs: a fresh child is supposed to run on the default route
 * of the model list the run itself froze, a continuable child records that route
 * in its `subagent/descriptor`, and the delegating session's own
 * `request/header` is supposed to be untouched. This tool reads exactly those
 * three things out of the evidence and asserts them.
 *
 * It reads logs and nothing else: no live Settings, no Harness, no network. The
 * expectation is the **frozen** model list the run recorded
 * (`subagent/model-selection-policy`), so a check says what that run implied, not
 * what the machine says now. `--expect` / `--default-model` / `--lead-expect`
 * override or add expectations the log cannot supply.
 *
 * Children are found in the delegating session's `subagent/catalog` events and
 * resolved to the sibling directory the Host writes beside it — by directory,
 * not by file name, because the format version is the Host's and lives there;
 * `--child` verifies one log on its own.
 *
 * Usage:
 *   node verify-session.mjs --lead <lead log> [--child <child log>]
 *     [--expect provider/model] [--default-model provider/model]
 *     [--lead-expect provider/model]
 *
 * Exit status: 0 every check passed, 1 a check failed, 2 the arguments or a log
 * could not be read.
 *
 * @module dsh-subagent-pin/tools/verify-session
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { readSessionLog } from './read-session.mjs'

/** Every event of one type, in the order the log holds them. */
function eventsOfType(events, type) {
  return events.filter((event) => event.type === type)
}

/** Render one route for a diagnostic. */
function renderRoute(route) {
  return route === undefined ? 'none' : `${route.provider}/${route.model}`
}

/** Whether two routes name the same provider and model. */
function sameRoute(a, b) {
  return a?.provider === b?.provider && a?.model === b?.model
}

/** The route a session's own first request was made on. */
function headerRoute(events) {
  const headers = eventsOfType(events, 'request/header')
  const initial = headers.find((event) => event.data?.reason === 'initial') ?? headers[0]
  const config = initial?.data?.header?.config
  if (config === undefined) return undefined
  return {
    provider: config.provider,
    model: config.model,
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
  }
}

/** The model list the run froze into its own log, or nothing when it recorded none. */
function frozenRoutes(events) {
  const allowed = eventsOfType(events, 'subagent/model-selection-policy').at(-1)?.data?.allowedModels
  return Array.isArray(allowed) ? allowed : undefined
}

/** The route a continuable descriptor pinned, or nothing when it carries no fields. */
function descriptorRoute(descriptor) {
  if (descriptor?.agentProvider === undefined || descriptor?.agentModel === undefined) return undefined
  return {
    provider: descriptor.agentProvider,
    model: descriptor.agentModel,
    ...(descriptor.agentReasoningEffort === undefined ? {} : { reasoningEffort: descriptor.agentReasoningEffort }),
  }
}

/** One session log, whatever format version its name carries. */
const SESSION_LOG = /^session\.v(\d+)\.jsonl\.zstd$/u

/**
 * The newest session log in one session directory, or nothing when it holds none.
 *
 * The version suffix belongs to the Host's session format, not to this tool, so
 * the directory is asked rather than the name assumed: a run that writes a
 * version this tool has never heard of is still verified. Nothing else in the
 * directory is a session log, so a backup or a partial file is never read as one.
 */
function childLog(directory) {
  let names
  try {
    names = readdirSync(directory)
  } catch {
    return undefined
  }
  return names
    .filter((name) => SESSION_LOG.test(name))
    .sort((a, b) => Number(a.match(SESSION_LOG)[1]) - Number(b.match(SESSION_LOG)[1]))
    .at(-1)
}

/** Every child one run delegated to, each with the log the Host writes beside its own. */
function childrenOf(leadFile, events, only) {
  if (only !== undefined) return [{ label: basename(dirname(only)), file: only }]
  return eventsOfType(events, 'subagent/catalog').map(({ data }) => {
    const directory = join(dirname(leadFile), '..', data.childId)
    return {
      label: data.label ?? 'unlabelled',
      mode: data.mode,
      file: join(directory, childLog(directory) ?? 'session.v?.jsonl.zstd'),
    }
  })
}

/** One check, plus the shape a diagnostic needs to explain it. */
function check(name, ok, { expected, observed, note } = {}) {
  return { name, ok, ...(expected === undefined ? {} : { expected }), ...(observed === undefined ? {} : { observed }), ...(note === undefined ? {} : { note }) }
}

/**
 * Verify one run's route evidence.
 *
 * @param options - `{ lead, child?, expect?, defaultModel?, leadExpect? }`, where
 *   the three route values are `{ provider, model }`.
 * @returns `{ ok, expected, checks }` — `expected` names the route the children
 *   are held to and where it came from (`expect`, `default-model`, `log`, or
 *   `none` when the run recorded no list and none was passed).
 */
export function verifySessionLogs(options) {
  const leadEvents = readSessionLog(options.lead)
  const leadRoute = headerRoute(leadEvents)
  const frozen = frozenRoutes(leadEvents)
  const checks = []

  let expected
  if (options.expect !== undefined) expected = { ...options.expect, from: 'expect' }
  else if (options.defaultModel !== undefined) {
    expected = { ...options.defaultModel, from: 'default-model' }
    if (frozen !== undefined) {
      const authorized = frozen.some((route) => sameRoute(route, options.defaultModel))
      checks.push(
        check('expected default is one the frozen list authorizes', authorized, {
          expected: options.defaultModel,
          observed: frozen.map(renderRoute).join(', '),
          note: authorized ? undefined : 'the plugin refuses such a default; pick one the run recorded, or fix the row',
        }),
      )
    } else {
      checks.push(
        check('expected default is one the frozen list authorizes', true, {
          note: 'the log carries no subagent/model-selection-policy event, so membership cannot be checked',
        }),
      )
    }
  } else if (frozen !== undefined) expected = { ...frozen[0], from: 'log' }
  else expected = { from: 'none' }

  const expectedRoute = expected.from === 'none' ? undefined : { provider: expected.provider, model: expected.model }

  if (leadRoute === undefined) {
    checks.push(check('lead: request/header route', false, { note: 'the log carries no request/header' }))
  } else if (options.leadExpect !== undefined) {
    checks.push(
      check('lead: request/header route', sameRoute(leadRoute, options.leadExpect), {
        expected: options.leadExpect,
        observed: leadRoute,
        note: 'the delegator keeps its own route; this plugin never rewrites the delegating session',
      }),
    )
  } else {
    checks.push(check('lead: request/header route', true, { observed: leadRoute, note: 'observed only; pass --lead-expect to assert it' }))
  }

  for (const child of childrenOf(options.lead, leadEvents, options.child)) {
    const name = `child "${child.label}"`
    if (!existsSync(child.file)) {
      checks.push(check(`${name} log is readable`, false, { observed: child.file, note: 'not found; pass --child with the log to check it elsewhere' }))
      continue
    }
    const childEvents = readSessionLog(child.file)
    const childRoute = headerRoute(childEvents)

    checks.push(
      check(`${name} request/header route`, expectedRoute !== undefined && sameRoute(childRoute, expectedRoute), {
        expected: expectedRoute,
        observed: childRoute,
        note:
          childRoute === undefined
            ? 'the child log carries no request/header'
            : expectedRoute === undefined
              ? 'pass --expect or --default-model: the run recorded no model list to imply one'
              : sameRoute(expectedRoute, leadRoute) && sameRoute(childRoute, leadRoute)
                ? 'indistinguishable from inheritance: the default route is also the delegator\'s own route'
                : undefined,
      }),
    )

    const descriptor = eventsOfType(childEvents, 'subagent/descriptor').at(-1)?.data
    const pinned = descriptorRoute(descriptor)
    if (descriptor === undefined) {
      checks.push(check(`${name} continuable descriptor route`, false, { note: 'the child log carries no subagent/descriptor' }))
    } else if (descriptor.mode !== 'continuable') {
      checks.push(
        check(`${name} continuable descriptor route`, true, {
          note: `the descriptor is ${descriptor.mode} and carries no route fields; the child request/header above is the evidence`,
        }),
      )
    } else {
      checks.push(
        check(`${name} continuable descriptor route`, expectedRoute !== undefined && sameRoute(pinned, expectedRoute), {
          expected: expectedRoute,
          observed: pinned,
          note: pinned === undefined ? 'a continuable descriptor is supposed to record the route its child was created on' : undefined,
        }),
      )
      if (pinned !== undefined && childRoute !== undefined) {
        checks.push(
          check(`${name} descriptor agrees with its own header`, sameRoute(pinned, childRoute), {
            expected: { provider: childRoute.provider, model: childRoute.model },
            observed: { provider: pinned.provider, model: pinned.model },
          }),
        )
      }
    }
  }

  return { ok: checks.every((entry) => entry.ok), expected, checks }
}

/** The usage text, shared by `--help` and every argument failure. */
const USAGE = `usage: node verify-session.mjs --lead <lead log> [--child <child log>]
         [--expect provider/model] [--default-model provider/model]
         [--lead-expect provider/model]

Reads one run's session logs and asserts the routes they record. Exit status:
0 all checks passed, 1 a check failed, 2 the arguments or a log could not be read.`

/** Read `--flag value` pairs into the options `verifySessionLogs` takes. */
function parseArgs(argv) {
  const routes = { '--expect': 'expect', '--default-model': 'defaultModel', '--lead-expect': 'leadExpect' }
  const options = {}
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === '--help' || flag === '-h') return { help: true }
    const value = argv[index + 1]
    if (flag === '--lead' || flag === '--child') {
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} expects a path`)
      options[flag.slice(2)] = value
      index += 1
      continue
    }
    if (routes[flag] !== undefined) {
      const slash = value?.indexOf('/') ?? -1
      if (slash <= 0 || slash === value.length - 1) throw new Error(`${flag} expects provider/model, got ${value === undefined ? 'nothing' : `"${value}"`}`)
      options[routes[flag]] = { provider: value.slice(0, slash), model: value.slice(slash + 1) }
      index += 1
      continue
    }
    throw new Error(`unknown argument "${flag}"`)
  }
  if (options.lead === undefined) throw new Error('--lead is required')
  return options
}

if (process.argv[1]?.endsWith('verify-session.mjs')) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      console.log(USAGE)
    } else {
      const result = verifySessionLogs(options)
      for (const entry of result.checks) {
        const line =
          entry.ok && entry.expected === undefined
            ? `${entry.observed === undefined ? '' : renderRoute(entry.observed)}`
            : `observed ${renderRoute(entry.observed)}, expected ${renderRoute(entry.expected)}`
        console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}${line === '' ? '' : ` — ${line}`}${entry.note === undefined ? '' : `; ${entry.note}`}`)
      }
      console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.checks.filter((entry) => entry.ok).length}/${result.checks.length} checks passed; expected ${renderRoute(result.expected)} (from ${result.expected.from})`)
      process.exit(result.ok ? 0 : 1)
    }
  } catch (error) {
    console.error(`verify-session: ${error.message}`)
    console.error(USAGE)
    process.exit(2)
  }
}
