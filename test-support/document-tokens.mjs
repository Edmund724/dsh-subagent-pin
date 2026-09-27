/**
 * Reading a Markdown document as text, for the guards that hold documents to code.
 *
 * Two guards do that and they look for different things: `test/docs.test.mjs`
 * holds the reader-facing documents (the two READMEs and `CONTEXT.md`) and also
 * asserts that the package ships what they name, while
 * `test/maintainer-docs.test.mjs` holds the maintainer-facing ones (`AGENTS.md`
 * and `.agents/notes/`) and asserts existence alone, because not all of those
 * files ship. What the two share is purely mechanical — open the file, keep each
 * line's number, pull the backticked tokens and the relative link targets out of
 * it — so it lives here rather than twice, where the second copy could drift.
 *
 * Nothing here decides whether a token *is* a claim about this repository: that
 * judgement differs between the guards and stays beside each one.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * One text, line by line, with the number each line is on.
 *
 * The primitive: the guards run their judgement on a document they may have
 * edited first, so what they read is text, and only the convenience below goes
 * back to the file.
 *
 * @param text - the whole document.
 * @returns the lines, in order, as `{ text, number }`.
 */
export function lines(text) {
  return text.split(/\r?\n/).map((line, offset) => ({ text: line, number: offset + 1 }))
}

/**
 * One file, line by line, with the number each line is on.
 *
 * @param root - absolute path of the repository root.
 * @param name - repository-relative path of the document.
 * @returns the lines, in order, as `{ text, number }`.
 */
export function numbered(root, name) {
  return lines(readFileSync(join(root, name), 'utf8'))
}

/**
 * The relative link targets of one already-split text, with the line each sits on.
 *
 * A target that is only a fragment, or that carries a URL scheme, is not a claim
 * about this repository and is dropped. What remains is written relative to the
 * directory the document sits in — that is how `.agents/notes/README.md` links
 * its own entries — so the caller resolves it from there.
 *
 * @param rows - the document, as `lines()` returned it.
 * @returns the targets, with any `#fragment` stripped, as `{ target, number }`.
 */
export function linkTargets(rows) {
  const found = []
  for (const row of rows) {
    for (const [, target] of row.text.matchAll(/\]\(\s*<?([^)\s>]+)>?/g)) {
      if (target.startsWith('#') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) continue
      found.push({ target: target.split('#')[0], number: row.number })
    }
  }
  return found
}

/**
 * The relative link targets of one file, with the line each sits on.
 *
 * @param root - absolute path of the repository root.
 * @param name - repository-relative path of the document.
 * @returns the targets, with any `#fragment` stripped, as `{ target, number }`.
 */
export function relativeLinks(root, name) {
  return linkTargets(numbered(root, name))
}

/**
 * Every backticked token of one already-split text, with the line it sits on.
 *
 * Raw: the guards that consume this decide what counts, because one of them
 * requires its tokens to be shipped and the other only that they exist.
 *
 * @param rows - the document, as `lines()` returned it.
 * @returns every `` `token` `` on every line, as `{ token, number }`.
 */
export function codeSpans(rows) {
  const tokens = []
  for (const row of rows) {
    for (const [, token] of row.text.matchAll(/`([^`\n]+)`/g)) tokens.push({ token, number: row.number })
  }
  return tokens
}

/**
 * Every backticked token of one file, with the line it sits on.
 *
 * @param root - absolute path of the repository root.
 * @param name - repository-relative path of the document.
 * @returns every `` `token` `` on every line, as `{ token, number }`.
 */
export function codeSpanTokens(root, name) {
  return codeSpans(numbered(root, name))
}

/**
 * Whether a backticked token is shaped like a path at all.
 *
 * Both guards need this before their own, different test — one asks whether the
 * package ships the file, the other only whether it exists — so the shape lives
 * here and the judgement stays with each. A token carrying a space, a glob
 * (`*`), a `:` citation (`plugin.js:108`), an angle placeholder (`<slug>`), a
 * brace pattern (`{a,b}/x.md`) or a prompt template (`{{model}}`) is the prose's
 * own vocabulary, not a claim about a file.
 *
 * @param token - one backticked token.
 * @returns whether the token can be a repository path.
 */
export function isPathShaped(token) {
  return !/[\s*:`<>{}]/u.test(token)
}

/**
 * Every Markdown file under one repository directory, repository-relative, sorted.
 *
 * Enumerated rather than listed so a document added to the tree is guarded
 * without anyone remembering to register it.
 *
 * @param root - absolute path of the repository root.
 * @param directory - repository-relative directory to walk.
 * @returns repository-relative paths with `/` separators, depth-first, sorted.
 */
export function markdownUnder(root, directory) {
  const found = []
  const walk = (relative) => {
    const entries = readdirSync(join(root, relative), { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (entry.name.endsWith('.md')) found.push(child)
    }
  }
  walk(directory)
  return found
}
