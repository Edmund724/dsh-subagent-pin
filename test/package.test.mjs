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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { iconFindings, MAX_ICON_BYTES } from '../test-support/manifest-icon.mjs'
import { repositoryPaths, ships } from '../test-support/package-files.mjs'

/** The repository root, where `package.json` sits. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const {
  exports: subpaths,
  files,
  name,
  publishConfig,
  private: isPrivate,
} = MANIFEST

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

test('the manifest icon is one DSH will render, and it ships', () => {
  // DSH reads the icon through `${specifier}/package.json` and inlines the file
  // as a data URI (`app-boot.js` `iconOf`), so a path DSH would reject, a file
  // outside the manifest directory, or a missing `files` entry all degrade the
  // Plugin Manager card to default artwork without a single failing check. The
  // rules themselves live in `test-support/manifest-icon.mjs`, where every row's
  // own manifest is held to the same ones.
  assert.deepEqual(iconFindings(MANIFEST, join(ROOT, 'package.json')), [])

  // `files` entries are repository-relative, the manifest may write `./icon.svg`.
  const shipped = MANIFEST.icon.replace(/^\.\//u, '')
  assert.ok(files.some((entry) => ships(entry, shipped)), `icon "${MANIFEST.icon}" is declared but not shipped by \`files\` (it ships ${files.join(', ')})`)
})

test('an icon DSH could not draw is reported, not assumed fine', () => {
  // The rule set above is only a guard while a manifest that breaks one is
  // reported, and every case here is a way a hand-written `icon` degrades the
  // artwork silently: the Host keeps the row, its name, and its switch, and
  // quietly substitutes the default picture.
  const manifestPath = join(ROOT, 'package.json')
  const directory = mkdtempSync(join(tmpdir(), 'dsh-manifest-icon-'))
  try {
    const local = join(directory, 'package.json')
    writeFileSync(join(directory, 'wrong-box.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>')
    writeFileSync(join(directory, 'oversized.svg'), Buffer.concat([Buffer.from('<svg viewBox="0 0 36 36">'), Buffer.alloc(MAX_ICON_BYTES, 0x78)]))

    const cases = [
      ['declares no icon', {}, manifestPath, /no non-empty/u],
      ['names an absolute path', { icon: join(ROOT, 'icon.svg') }, manifestPath, /must be a relative file path/u],
      ['names a file type DSH does not inline', { icon: './package.json' }, manifestPath, /must be SVG, PNG, JPEG, or WebP/u],
      ['names a file that is not there', { icon: './no-such-icon.svg' }, manifestPath, /is not a file/u],
      ['draws off the family box', { icon: './wrong-box.svg' }, local, /official 36×36 viewBox/u],
      ['inlines more than the ceiling', { icon: './oversized.svg' }, local, /exceeds the 256 KiB ceiling/u],
    ]
    for (const [what, manifest, where, expected] of cases) {
      const findings = iconFindings(manifest, where)
      assert.equal(findings.length, 1, `${what}: expected one finding, got ${JSON.stringify(findings)}`)
      assert.match(findings[0], expected, `${what}: the finding does not say why: ${findings[0]}`)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

// ── the manifest npm has to accept before a name can be installed ───────────

test('the manifest is publishable under a name a registry can resolve', () => {
  // The Plugin Manager's first field resolves a bare name against a registry
  // (`pluginManager.inspect`); a manifest npm refuses to publish can never be
  // installed that way. `private: true` refuses outright, and npm defaults a
  // scoped name to restricted access, so `npm publish` fails for an account
  // without a paid plan unless the manifest asks for public access. The `@local`
  // scope is the placeholder this repository used while the profile linked the
  // directory directly (`link:D:/DSH/dsh-subagent-pin`); no npm org serves it, so
  // a lookup by that name answers 404 on every registry the dialog offers.
  assert.equal(isPrivate ?? false, false, 'package.json sets `private: true`, so npm refuses to publish it')
  assert.notEqual(name.split('/')[0], '@local', `package.json is named "${name}", a scope no registry serves`)
  if (name.startsWith('@')) {
    assert.equal(
      publishConfig?.access,
      'public',
      `scoped name "${name}" needs publishConfig.access "public", or npm publishes it restricted`,
    )
  }
})

// ── the `files` array against the tree it names ─────────────────────────────

test('every files entry still matches something in this repository', () => {
  // A stale entry ships nothing and hides the disappearance: the document guard
  // recognizes a path by its first segment, so a directory that is gone takes the
  // check with it instead of failing. Only a pattern needs the walk; a plain name
  // is matched against the tree directly.
  const present = repositoryPaths(ROOT)
  for (const entry of files) {
    assert.ok(
      entry.includes('*') ? present.some((path) => ships(entry, path)) : existsSync(join(ROOT, entry)),
      `the "files" entry "${entry}" matches nothing in this repository`,
    )
  }
})
