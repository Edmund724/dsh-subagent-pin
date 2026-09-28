/**
 * The shipped rows: `cordis.patch.yml`, read the way the Host reads it.
 *
 * `package.json` declares this file as the bundle's patch (`dsh.bundle.patch`),
 * and that file — not `apply()`'s defaults — is what an install actually mounts:
 * `source: settings` on the pin row, no knobs at all on the session row, whose
 * schema defaults are the install. Nothing asserted any of it:
 * `package.test.mjs` proves the file exists and ships, `config-schema.test.mjs`
 * and `opencode-header.test.mjs` prove each interface accepts its shape, and
 * between them a row could name another package, mount a third row, or set a key
 * its own schema does not declare without one failure.
 *
 * Every read below goes through the Host's own API rather than a YAML library
 * this repository would have to add: `bundlePatchPaths` is the resolver `boot()`
 * uses to find a bundle's files, and `loadOverlayPatches` is the parser it reads
 * them with (the include's entry-list dialect, `!!js` expressions included). The
 * assertions are therefore about what the Host would mount, not about what a
 * generic reader happens to make of the same bytes.
 *
 * What a row is *called*, and what it is drawn as, is not in the patch at all:
 * DSH reads both from the row's own address (`${name}/locale/*.json`, and the
 * `icon` of `${name}/package.json`), so two rows pointing at the same address
 * show the same name and the same mark, and a row pointing at an address with no
 * dictionary shows its bare specifier. Nothing here saw that either — a row could
 * borrow the whole package's title, which is what the pin row did while the
 * session row could be switched off on its own.
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { bundlePatchFiles, bundlePatchPaths, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

import { Config as PIN_CONFIG, KNOWN_KEYS as PIN_KEYS } from '../config-schema.js'
import { Config as SESSION_CONFIG, KNOWN_KEYS as SESSION_KEYS } from '../opencode-header.js'
import { iconFindings } from '../test-support/manifest-icon.mjs'
import { ships } from '../test-support/package-files.mjs'

/** The repository root, where `package.json` sits. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const { name: PACKAGE_NAME, dsh, files: PACKAGE_FILES } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

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
    name: `${PACKAGE_NAME}/subagent-pin`,
    schema: PIN_CONFIG,
    keys: PIN_KEYS,
    shipped: { source: 'settings' },
  },
  {
    id: 'opencode-header',
    name: `${PACKAGE_NAME}/opencode-header`,
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
  const session = insertedRow('opencode-header')
  assert.equal(session.config, undefined, 'the session row ships no config; its schema defaults are the install')
  assert.deepEqual(SESSION_CONFIG['~standard'].validate(session.config ?? {}).value, {
    enabled: true,
    providers: ['opencode'],
    hosts: ['opencode.ai'],
    headerName: 'x-opencode-session',
  })
})

// ── the name each row shows in the Plugin Manager ──────────────────────────

/** The languages this package ships dictionaries for — the two its READMEs are written in. */
const LANGUAGES = ['en', 'zh']

/** The fields of one dictionary entry DSH reads; anything else in the file is ignored. */
const TEXT_FIELDS = ['title', 'description']

/** The result of a module resolution, or `undefined` when the export map does not admit it. */
function optionalPath(attempt) {
  try {
    return attempt()
  } catch {
    return undefined
  }
}

/**
 * One address's display metadata, read the way DSH reads it.
 *
 * `readPluginMeta()` in `@deepseek-ai/dsh-app-boot` resolves `${specifier}/locale/en.json`
 * and `${specifier}/package.json` through the address's own export map, takes every
 * other `.json` beside the English dictionary as one language, and falls back to the
 * manifest for a field no dictionary carries. A row whose address exports neither
 * carries no metadata at all, and the Plugin Manager then prints the module
 * specifier — which is why a row that names no dictionary of its own still shows
 * something, just nothing anybody wrote.
 *
 * @param specifier - a row's module name, exactly as the patch writes it.
 * @returns the dictionaries by language, and the manifest read from that same address,
 *   with its own path so that an `icon` can be resolved from its neighbourhood.
 */
function addressMeta(specifier) {
  const resolve = (request) => createRequire(join(ROOT, 'package.json')).resolve(request)
  const dictionaries = new Map()
  const english = optionalPath(() => resolve(`${specifier}/locale/en.json`))
  if (english !== undefined) {
    for (const entry of readdirSync(dirname(english))) {
      if (!entry.endsWith('.json')) continue
      const parsed = JSON.parse(readFileSync(resolve(`${specifier}/locale/${entry}`), 'utf8'))
      dictionaries.set(entry.slice(0, -5).toLowerCase(), {
        title: parsed.meta?.title,
        description: parsed.meta?.description,
      })
    }
  }
  const manifestPath = optionalPath(() => resolve(`${specifier}/package.json`))
  return {
    dictionaries,
    manifestPath,
    manifest: manifestPath === undefined ? undefined : JSON.parse(readFileSync(manifestPath, 'utf8')),
  }
}

test('every row exports its own dictionaries and manifest, so both rows carry a written name', () => {
  // The row's address is what DSH reads both from, so an address without a
  // dictionary shows the specifier and an address without a manifest loses the
  // icon. Non-empty matters twice over: `textOf` throws on a blank field, and a
  // dictionary that throws leaves the row with an error label instead of a name.
  for (const row of insertedRows()) {
    const { dictionaries, manifest } = addressMeta(row.name)

    for (const language of LANGUAGES) {
      const text = dictionaries.get(language)
      assert.ok(
        text !== undefined,
        `"${row.id}" mounts ${row.name}, which exports no ${language} dictionary, so the Plugin Manager shows the specifier instead of a name`,
      )
      for (const field of TEXT_FIELDS) {
        assert.ok(
          typeof text[field] === 'string' && text[field].trim() !== '',
          `"${row.id}" writes ${language} meta.${field} as ${JSON.stringify(text[field])}, which DSH reads as absent or as a metadata error`,
        )
      }
    }

    assert.notEqual(manifest, undefined, `"${row.id}" mounts ${row.name}, which exports no package.json, so DSH drops the row's icon`)
  }
})

test('no row repeats another row\'s copy: a row names its own function, not its neighbour\'s', () => {
  // Two rows of one package are two features, each switchable on its own, so a
  // row that carries the package's combined title claims the other row too — the
  // pin row did exactly that while the session row could be switched off. The
  // bundle's own title (the card) is `pin + session header`, so a row that
  // repeats it repeats its neighbour; the comparison is per language and field.
  const rows = insertedRows().map((row) => ({ id: row.id, ...addressMeta(row.name) }))
  let compared = 0

  for (const row of rows) {
    for (const other of rows) {
      if (other.id === row.id) continue
      for (const language of LANGUAGES) {
        const mine = row.dictionaries.get(language)
        const theirs = other.dictionaries.get(language)
        if (mine === undefined || theirs === undefined) continue
        for (const field of TEXT_FIELDS) {
          compared += 1
          assert.ok(
            !mine[field].includes(theirs[field]),
            `"${row.id}" writes "${mine[field]}" as its ${language} meta.${field}, which repeats what "${other.id}" writes — one row may not answer for the other's feature`,
          )
        }
      }
    }
  }

  assert.notEqual(compared, 0, 'no two rows carry dictionaries to compare, so this check proves nothing')
})

// ── the artwork each row shows ──────────────────────────────────────────────

test('each row draws its own artwork, inside the family box and shipped by files', () => {
  // The manifest a row's address exports is also where its `icon` comes from, so
  // this is where two rows stop looking alike: DSH draws that image on the row
  // and on the card, and two rows resolving to one file are two identical marks
  // in a list whose whole point is telling the features apart. `iconFindings`
  // holds the file to what the Host's `iconOf()` reads (relative, one of four
  // media types, a regular file inside the manifest directory, at most 256 KiB)
  // and to this package's own 36×36 family box.
  const drawn = new Map()
  for (const row of insertedRows()) {
    const { manifest, manifestPath } = addressMeta(row.name)
    assert.notEqual(manifestPath, undefined, `"${row.id}" mounts ${row.name}, which exports no package.json to take artwork from`)
    assert.deepEqual(
      iconFindings(manifest, manifestPath),
      [],
      `"${row.id}" mounts ${row.name}, whose own manifest declares artwork DSH will not draw`,
    )

    const file = resolve(dirname(manifestPath), manifest.icon)
    const shipped = relative(ROOT, file).replaceAll(sep, '/')
    assert.ok(
      PACKAGE_FILES.some((entry) => ships(entry, shipped)),
      `"${row.id}" draws ${shipped}, which the "files" array does not ship (it ships ${PACKAGE_FILES.join(', ')})`,
    )
    drawn.set(row.id, { shipped, artwork: readFileSync(file, 'utf8') })
  }

  const files = [...drawn.values()].map((entry) => entry.shipped)
  assert.equal(new Set(files).size, files.length, `two rows draw the same file (${files.join(', ')}), so nothing tells their cards apart`)
  const artwork = [...drawn.values()].map((entry) => entry.artwork)
  assert.equal(new Set(artwork).size, artwork.length, 'two rows draw byte-identical artwork, so nothing tells their cards apart')
})
