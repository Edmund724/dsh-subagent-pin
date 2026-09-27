/**
 * The shipped row: `cordis.patch.yml`, read the way the Host reads it.
 *
 * `package.json` declares this file as the bundle's patch (`dsh.bundle.patch`),
 * and that file — not `apply()`'s defaults — is what an install actually mounts:
 * `source: settings`, no `defaultModel`, no `reasoningEffort`, as the README's
 * "Config" section states. Nothing asserted any of it: `package.test.mjs` proves
 * the file exists and ships, `config-schema.test.mjs` proves the interface
 * accepts that shape, and between the two a row could name another package,
 * drift to a third mode, or set a key the schema does not declare without one
 * failure.
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

import { Config, KNOWN_KEYS } from '../config-schema.js'

/** The repository root, where `package.json` sits. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const { name: PACKAGE_NAME, dsh } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** The row id this plugin mounts; `cordis.patch.yml` and the READMEs name the same one. */
const ROW_ID = 'subagent-pin'

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

// ── the row the Host parses out of it ──────────────────────────────────────

test('the Host parses the patch as one insert entry that targets no existing row', () => {
  const patches = loadOverlayPatches(BIN_NAME, patchPath())
  assert.equal(patches.length, 1)
  // A patch without `insert` is an override: it rewrites a row some other layer
  // owns and warns when it matches nothing. Adding a row takes `insert`.
  assert.equal(patches[0].id, undefined, 'this patch must not target an id; it adds a row')
  assert.equal(patches[0].disabled ?? null, null, 'a disabled patch would mount nothing and say so nowhere')
})

test('the inserted row carries this package name under the id the READMEs use', () => {
  const [row] = insertedRows()
  assert.equal(row.id, ROW_ID)
  assert.equal(row.name, PACKAGE_NAME)
})

// ── the config an install actually gets ────────────────────────────────────

test('every key of the shipped config is one config-schema.js declares, and it validates', () => {
  const [row] = insertedRows()
  for (const key of Object.keys(row.config ?? {})) {
    assert.ok(KNOWN_KEYS.includes(key), `the shipped config sets "${key}", which the schema does not declare`)
  }
  const { issues } = Config['~standard'].validate(row.config)
  assert.equal(issues, undefined, `the shipped config does not validate: ${JSON.stringify(issues)}`)
})

test('the shipped config pins nothing: the settings source and no other key', () => {
  // The README says the bundled row is `source: settings` with no `defaultModel`
  // and no `reasoningEffort`, so the default route is whatever the Settings row
  // lists first. The others are not merely unset: `plugin.js` refuses
  // `provider`/`model` in `settings` mode, so a row that set them would fail
  // activation on a user's machine rather than here.
  const [row] = insertedRows()
  assert.deepEqual(row.config, { source: 'settings' })
})
