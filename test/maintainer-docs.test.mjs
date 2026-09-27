/**
 * The maintainer-facing documents, held to the tree they describe.
 *
 * `AGENTS.md` and `.agents/notes/` carry this repository's navigation: which file
 * does what, where a rule's authoritative text lives, and which decision recorded
 * it. `test/docs.test.mjs` holds the reader-facing documents and its rules do not
 * fit these: it resolves every relative link from the repository root, while the
 * notes index reaches its entries from its own directory, and it reads a
 * backticked path as something the package must ship.
 *
 * The gap that leaves is real. Rename a note, or move one between `implemented/`
 * and `archived/`, and every reference to it breaks while nothing says so — the
 * failure a cross-repository link suffers, one directory down.
 *
 * So this guard reads these documents and asks one question only: does what they
 * name still exist? A Markdown link is resolved from the directory its own
 * document sits in; a backticked path is resolved from the repository root, the
 * way `test/docs.test.mjs` reads those; a decision record cited by bare file name
 * is looked up among the notes.
 *
 * What it cannot see, so that nobody reads this as full coverage: only inline
 * code spans are read, never a fenced block; a span carrying whitespace is a
 * command line rather than a path (`node --test test/docs.test.mjs` written that
 * way is not a claim); and a bare root-level file name counts only while it is a
 * root entry, so renaming `host-contract.js` outright escapes — the trade-off
 * `test/docs.test.mjs` also makes, taken to keep prose vocabulary (`descriptor.js`,
 * `subagent/descriptor`, `apply()`) out of the check. A nested path has no such
 * limit: `test/gone.mjs` is caught, because `test/` still exists. Links have
 * none of these limits — they are read wherever they appear.
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { codeSpanTokens, isPathShaped, markdownUnder, relativeLinks } from '../test-support/document-tokens.mjs'

/** The repository root: every document read here sits beneath it. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Where the decision records live; the directory whose own links are dir-relative. */
const NOTES = '.agents/notes'

/** Every maintainer document: the root navigation file, plus every decision record. */
const DOCUMENTS = ['AGENTS.md', ...markdownUnder(ROOT, NOTES)]

/**
 * Root entries that are not part of this repository's tree.
 *
 * `node_modules/` is where a development checkout is linked from; a document may
 * name a path inside it while describing that environment, and that is not a
 * claim this guard can check against the tree.
 */
const NOT_THE_TREE = new Set(['node_modules'])

/** What the repository root actually holds — the only names a root-relative path may start with. */
const ROOT_ENTRIES = new Set(readdirSync(ROOT).filter((entry) => !NOT_THE_TREE.has(entry)))

/** The file names the notes use; a decision record may be cited without its directory. */
const NOTE_BASENAMES = new Set(markdownUnder(ROOT, NOTES).map((name) => name.split('/').pop()))

/** A decision record's file name: the date it was decided, then its slug. */
const NOTE_FILENAME = /^\d{4}-\d{2}-\d{2}-.+\.md$/u

/** Where one document sits, as the prefix its relative targets resolve from. */
function documentDirectory(name) {
  const directory = dirname(name)
  return directory === '.' ? '' : `${directory}/`
}

/** Every relative link in the maintainer documents, with the file it resolves from. */
function linkClaims() {
  return DOCUMENTS.flatMap((name) =>
    relativeLinks(ROOT, name).map(({ target, number }) => ({
      where: `${name}:${number}`,
      target,
      from: documentDirectory(name),
    })),
  )
}

/** Every repository path the maintainer documents write in a code span, from the root. */
function pathClaims() {
  const claims = []
  for (const name of DOCUMENTS) {
    for (const { token, number } of codeSpanTokens(ROOT, name)) {
      if (!isPathShaped(token)) continue
      if (!ROOT_ENTRIES.has(token.split('/')[0])) continue
      claims.push({ where: `${name}:${number}`, target: token })
    }
  }
  return claims
}

/** Every decision record the maintainer documents cite by bare file name. */
function noteClaims() {
  const claims = []
  for (const name of DOCUMENTS) {
    for (const { token, number } of codeSpanTokens(ROOT, name)) {
      if (!isPathShaped(token)) continue
      if (ROOT_ENTRIES.has(token.split('/')[0])) continue
      if (!NOTE_FILENAME.test(token)) continue
      claims.push({ where: `${name}:${number}`, target: token })
    }
  }
  return claims
}

// ── what the documents point at ────────────────────────────────────────────

test('every relative link the maintainer documents carry resolves', () => {
  const claims = linkClaims()
  assert.notEqual(claims.length, 0, 'no maintainer document carries a relative link, so this test proves nothing')

  for (const { where, target, from } of claims) {
    assert.ok(existsSync(join(ROOT, from, target)), `${where} links ${from}${target}, which is not a file in this repository`)
  }
})

test('every repository path the maintainer documents write in a code span resolves', () => {
  const claims = pathClaims()
  assert.notEqual(claims.length, 0, 'no maintainer document writes a repository path in a code span, so this test proves nothing')

  for (const { where, target } of claims) {
    assert.ok(existsSync(join(ROOT, target)), `${where} writes \`${target}\`, which is not a path in this repository`)
  }
})

test('every decision record the maintainer documents name by bare file name exists', () => {
  const claims = noteClaims()
  assert.notEqual(claims.length, 0, 'no maintainer document names a decision record by file name, so this test proves nothing')

  for (const { where, target } of claims) {
    assert.ok(NOTE_BASENAMES.has(target), `${where} writes \`${target}\`, which names no decision record in ${NOTES}/`)
  }
})
