/**
 * The package's two claims about its own contents, held to each other.
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
 * importable has to be shipped.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/** The repository root, where `package.json` sits. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const { exports: subpaths, files } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** Whether one `files` entry names a repository path (its `*` matching one segment). */
function ships(entry, file) {
  return new RegExp(`^${entry.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`).test(file)
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
