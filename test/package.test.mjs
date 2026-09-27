/**
 * The package's claims about its own contents, held to each other.
 *
 * `exports` decides what an importer outside this package may reach, and `files`
 * decides what a packed copy actually contains. The review that produced
 * `tools/verify-session.mjs` found the two disagreeing: the reader was in `files`
 * and shipped, while `exports` knew nothing about `./tools/*`, so every import by
 * package name failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`. A development
 * checkout hides it — DSH links the profile's `node_modules` entry straight at
 * this directory, so no import ever goes through the export map.
 *
 * The test keeps them aligned in the one direction that matters: anything
 * importable has to be shipped. The manifest's display metadata is the third
 * claim: an `icon` DSH cannot read, or cannot find in a packed copy, degrades the
 * Plugin Manager card silently.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/** The repository root, where `package.json` sits. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const { exports: subpaths, files, icon } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/**
 * Whether one `files` entry names a repository path.
 *
 * `*` stays inside one path segment while `**` crosses directories, which is how
 * npm itself reads a `files` entry.
 */
function ships(entry, file) {
  let pattern = ''
  for (let index = 0; index < entry.length; index += 1) {
    const char = entry[index]
    if (char === '*' && entry[index + 1] === '*') {
      pattern += '.*'
      index += 1
    } else if (char === '*') {
      pattern += '[^/]*'
    } else {
      pattern += /[.+?^${}()|[\]\\]/u.test(char) ? `\\${char}` : char
    }
  }
  return new RegExp(`^${pattern}$`).test(file)
}

test('every subpath export resolves to a file in this repository', () => {
  const targets = Object.entries(subpaths).filter(([key]) => key !== './package.json')
  assert.notEqual(targets.length, 0, 'package.json exports nothing, so this test proves nothing')
  for (const [key, target] of targets) {
    if (target.includes('*')) continue
    assert.ok(existsSync(join(ROOT, target)), `exports["${key}"] points at ${target}, which does not exist`)
  }
  assert.equal(subpaths['./verify'], './tools/verify-session.mjs', 'the verify tool is the package\'s one importable entry beside the plugin')
})

test('every importable subpath is also shipped by files', () => {
  for (const [key, target] of Object.entries(subpaths)) {
    if (target === './package.json') continue
    assert.ok(
      files.some((entry) => ships(entry, target.slice(2))),
      `exports["${key}"] is importable as ${target}, which the "files" array does not ship (it ships ${files.join(', ')})`,
    )
  }
})

test('the shipped tools are the ones the export map and the scripts name', () => {
  // `tools/*.mjs` is what puts both tools in a packed copy; a tool added here
  // without being shipped is reachable from the checkout and nowhere else.
  for (const tool of ['tools/read-session.mjs', 'tools/verify-session.mjs']) {
    assert.ok(files.some((entry) => ships(entry, tool)), `${tool} is not among the shipped files`)
    assert.ok(existsSync(join(ROOT, tool)), `${tool} is shipped but missing from the repository`)
  }
})

// ── the display metadata the Plugin Manager reads without activating ────────

/** The extensions and the raw size ceiling DSH admits a manifest icon under. */
const ICON_MEDIA_TYPES = ['.svg', '.png', '.jpg', '.jpeg', '.webp']
const MAX_ICON_BYTES = 256 * 1024

test('the manifest icon is one DSH will render, and it ships', () => {
  // DSH reads the icon through `${specifier}/package.json` and inlines the file
  // as a data URI (`app-boot.js` `iconOf`), so a path DSH would reject, a file
  // outside the manifest directory, or a missing `files` entry all degrade the
  // Plugin Manager card to default artwork without a single failing check.
  assert.equal(typeof icon, 'string', 'package.json declares no top-level `icon`, so the card falls back to default artwork')
  assert.ok(!isAbsolute(icon) && !icon.split(/[\\/]/).includes('..'), `icon "${icon}" must be a relative path inside the manifest directory`)
  assert.ok(ICON_MEDIA_TYPES.includes(extname(icon).toLowerCase()), `icon "${icon}" must be one of ${ICON_MEDIA_TYPES.join(', ')}`)

  // `files` entries are repository-relative, the manifest may write `./icon.svg`.
  const shipped = icon.replace(/^\.\//u, '')
  const file = join(ROOT, icon)
  assert.ok(existsSync(file), `package.json declares icon "${icon}", which is not a file in this repository`)
  assert.ok(statSync(file).size <= MAX_ICON_BYTES, `icon "${icon}" exceeds the ${MAX_ICON_BYTES} byte ceiling DSH reads icons under`)
  assert.ok(files.some((entry) => ships(entry, shipped)), `icon "${icon}" is declared but not shipped by \`files\` (it ships ${files.join(', ')})`)

  if (extname(icon).toLowerCase() === '.svg') {
    // A card renders the artwork at 36px and a row at 30px, the slot the official
    // artwork draws on a 36×36 viewBox; another box would put this glyph out of
    // proportion with the family it sits beside.
    assert.match(readFileSync(file, 'utf8'), /viewBox="0 0 36 36"/u, `icon "${icon}" must draw on the official 36×36 viewBox`)
  }
})
