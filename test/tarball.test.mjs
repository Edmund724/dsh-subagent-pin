/**
 * The `files` array against the tarball npm would actually build.
 *
 * `test/package.test.mjs` holds the manifest to the tree with a matcher written
 * by hand, which is what lets `npm test` promise anything about `files` at all:
 * the suite must not need npm to run. An approximation is exactly where the two
 * can disagree — an entry is not a packed path (`package-lock.json` is never
 * packed, however an entry names it), a `.gitignore` in a subdirectory can still
 * drop a file the whitelist asked for, and the tarball, not the manifest, is what
 * an installer gets. So this file runs the real thing, `npm pack --dry-run
 * --json` in this directory, and asserts the direction the approximation cannot
 * see: every path `files` promises is in the packlist.
 *
 * The other direction is deliberately not asserted. `files` is the packlist's
 * input, so no mistake in this manifest can put a path into the tarball that the
 * array does not cover; what does sit outside it — `package.json`, a README, a
 * licence, `main`, `bin` — is npm including what the manifest declared elsewhere,
 * which is not a leak. Asserting it would be an alarm that no change here can
 * raise and a false one on a working `bin`.
 *
 * This is the one test that reaches for a tool beside Node's own — the npm CLI,
 * which is what runs the suite anyway (a bare `node --test` falls back to the npm
 * packaged with this Node). It still touches no network: `npm pack` on a local
 * directory reads no registry, and this package has no lifecycle script to run.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { repositoryPaths, ships } from '../test-support/package-files.mjs'

/** The repository root, where `package.json` sits. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const { files } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/**
 * The npm CLI entry point to run, or `undefined` if this machine has none.
 *
 * `npm test` hands its own entry point down in `npm_execpath`; a bare `node
 * --test` gets the npm that ships beside this Node. The name is checked because
 * `npm_execpath` is another package manager's path when the suite is started by
 * one, and that entry point has no `pack` command in this sense.
 */
function npmEntry() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  return candidates.find((path) => typeof path === 'string' && /(^|[\\/])npm[^\\/]*\.(c?js|mjs)$/u.test(path) && existsSync(path))
}

/** The paths of the real packlist, repository-relative, from one `npm pack --dry-run --json`. */
function packedPaths() {
  const entry = npmEntry()
  assert.ok(entry, 'no npm CLI was found to run `npm pack` with; run this suite through `npm test`')

  const run = spawnSync(process.execPath, [entry, 'pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(run.status, 0, `\`npm pack --dry-run --json\` exited with ${run.status}: ${run.stderr}`)

  // npm 11 answers with one report in an array and npm 10 with a bare report;
  // the JSON starts after any banner a version prints before it.
  const start = run.stdout.search(/[[{]/u)
  assert.notEqual(start, -1, `\`npm pack --dry-run --json\` printed no JSON report: ${run.stdout.slice(0, 400)}`)
  const parsed = JSON.parse(run.stdout.slice(start))
  const report = Array.isArray(parsed) ? parsed[0] : parsed

  const paths = report.files.map((file) => file.path)
  assert.notEqual(paths.length, 0, '`npm pack` reported no file at all, so this test proves nothing')
  return paths
}

test('every path `files` promises is in the tarball npm would build', () => {
  const packed = new Set(packedPaths())
  const promised = repositoryPaths(ROOT).filter((path) => files.some((entry) => ships(entry, path)))
  assert.notEqual(promised.length, 0, 'no `files` entry matches anything in this repository, so this test proves nothing')

  assert.deepEqual(
    promised.filter((path) => !packed.has(path)),
    [],
    'a path the "files" array promises is missing from the real packlist',
  )
})
