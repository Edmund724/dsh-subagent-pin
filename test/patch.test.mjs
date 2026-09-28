/**
 * The shipped rows: `cordis.patch.yml`, read the way the Host reads it.
 *
 * `package.json` declares this file as the bundle's patch (`dsh.bundle.patch`),
 * and that file — not `apply()`'s defaults — is what an install actually mounts:
 * `source: settings` on the pin row, no knobs at all on the session row, whose
 * schema defaults are the install. Nothing asserted any of it:
 * `package.test.mjs` proves the file exists and ships, `config-schema.test.mjs`
 * and `opencode-session.test.mjs` prove each interface accepts its shape, and
 * between them a row could name another package, mount a third row, or set a key
 * its own schema does not declare without one failure.
 *
 * Every read below goes through the Host's own API rather than a YAML library
 * this repository would have to add: `bundlePatchPaths` is the resolver `boot()`
 * uses to find a bundle's files, and `loadOverlayPatches` is the parser it reads
 * them with (the include's entry-list dialect, `!!js` expressions included). The
 * assertions are therefore about what the Host would mount, not about what a
 * generic reader happens to make of the same bytes.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { bundlePatchFiles, bundlePatchPaths, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

import { Config as PIN_CONFIG, KNOWN_KEYS as PIN_KEYS } from '../config-schema.js'
import { Config as SESSION_CONFIG, KNOWN_KEYS as SESSION_KEYS } from '../opencode-session.js'

/** The repository root, where `package.json` sits. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const { name: PACKAGE_NAME, dsh } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/**
 * Every row this bundle mounts: the id and specifier the READMEs name, the
 * schema its `config` is held to, and the config an install actually gets.
 *
 * `config: undefined` is a claim, not an omission: the session row ships no
 * knobs because its schema defaults *are* the install, and the READMEs document
 * every key a reader may add.
 */
const ROWS = [
  {
    id: 'subagent-pin',
    name: PACKAGE_NAME,
    schema: PIN_CONFIG,
    keys: PIN_KEYS,
    shipped: { source: 'settings' },
  },
  {
    id: 'opencode-session',
    name: `${PACKAGE_NAME}/opencode-session`,
    schema: SESSION_CONFIG,
    keys: SESSION_KEYS,
    shipped: undefined,
  },
]

/** The diagnostic prefix the Host prints when this patch fails to read. */
const BIN_NAME = 'dsh'

/** The file name the bundled patch must keep: the README cites it by that name. */
const PATCH_FILE = 'cordis.patch.yml'

/** The absolute path of the single patch file the bundle declaration resolves to. */
function patchPath() {
  const paths = bundlePatchPaths(ROOT, dsh.bundle)
  assert.equal(paths.length, 1, `the bundle declares ${paths.length} patch files; this file reads one`)
  return paths[0]
}

/** The rows the shipped patch inserts, as the Host parses them. */
function insertedRows() {
  const patches = loadOverlayPatches(BIN_NAME, patchPath())
  assert.equal(patches.length, 1, `the bundle patch holds ${patches.length} patch entries, not 1`)
  assert.equal(Array.isArray(patches[0].insert), true, 'the bundle patch is not an insert patch')
  return patches[0].insert
}

/** The one inserted row carrying an id, or a failure naming what was found instead. */
function insertedRow(id) {
  const rows = insertedRows().filter((row) => row.id === id)
  assert.equal(rows.length, 1, `the patch inserts ${rows.length} rows under "${id}" (it inserts ${insertedRows().map((row) => row.id).join(', ')})`)
  return rows[0]
}

// ── the file the manifest declares ─────────────────────────────────────────

test('the bundle declaration resolves to the patch file this repository keeps', () => {
  const files = bundlePatchFiles(dsh.bundle)
  assert.equal(files.length, 1, `the bundle declares ${files.length} patch files`)
  assert.equal(basename(files[0]), PATCH_FILE)

  const absolute = patchPath()
  assert.ok(existsSync(absolute), `the declared patch ${absolute} does not exist`)
  // A declaration that escaped the package directory would ship a patch the
  // tarball does not carry — the packed copy is where this has to hold.
  assert.ok(absolute.startsWith(ROOT), `the declared patch ${absolute} is outside ${ROOT}`)
})

// ── the rows the Host parses out of it ─────────────────────────────────────

test('the Host parses the patch as one insert entry that targets no existing row', () => {
  const patches = loadOverlayPatches(BIN_NAME, patchPath())
  assert.equal(patches.length, 1)
  // A patch without `insert` is an override: it rewrites a row some other layer
  // owns and warns when it matches nothing. Adding a row takes `insert`.
  assert.equal(patches[0].id, undefined, 'this patch must not target an id; it adds rows')
  assert.equal(patches[0].disabled ?? null, null, 'a disabled patch would mount nothing and say so nowhere')
})

test('the patch inserts every row this package ships, each under its own id and specifier', () => {
  const rows = insertedRows()
  assert.deepEqual(
    rows.map((row) => row.id).sort(),
    ROWS.map((row) => row.id).sort(),
    'the patch mounts a different set of rows than this file knows',
  )
  for (const expected of ROWS) {
    const row = insertedRow(expected.id)
    assert.equal(row.name, expected.name, `"${expected.id}" must mount ${expected.name}`)
  }
})

// ── the config an install actually gets ────────────────────────────────────

test('every key of a shipped config is one that row\'s own schema declares, and it validates', () => {
  for (const expected of ROWS) {
    const row = insertedRow(expected.id)
    for (const key of Object.keys(row.config ?? {})) {
      assert.ok(
        expected.keys.includes(key),
        `the shipped "${expected.id}" config sets "${key}", which its schema does not declare (it declares ${expected.keys.join(', ')})`,
      )
    }
    const { issues } = expected.schema['~standard'].validate(row.config ?? {})
    assert.equal(issues, undefined, `the shipped "${expected.id}" config does not validate: ${JSON.stringify(issues)}`)
  }
})

test('the shipped configs are the ones the READMEs document', () => {
  // The README says the pin row is `source: settings` with no `defaultModel` and
  // no `reasoningEffort`, so the default route is whatever the Settings row lists
  // first. The others are not merely unset: `plugin.js` refuses
  // `provider`/`model` in `settings` mode, so a row that set them would fail
  // activation on a user's machine rather than here.
  assert.deepEqual(insertedRow('subagent-pin').config, { source: 'settings' })

  // The session row ships no config at all: its defaults are the install, and
  // the value it stamps is the live session id, which no static row could name.
  const session = insertedRow('opencode-session')
  assert.equal(session.config, undefined, 'the session row ships no config; its schema defaults are the install')
  assert.deepEqual(SESSION_CONFIG['~standard'].validate(session.config ?? {}).value, {
    enabled: true,
    providers: ['opencode'],
    hosts: ['opencode.ai'],
    headerName: 'x-opencode-session',
  })
})
