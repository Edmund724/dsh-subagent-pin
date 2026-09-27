/**
 * The documents, held to the code they describe.
 *
 * Part of this plugin's interface is written down only for humans: the `config`
 * row an author copies out of a README, the decision words a reader has to learn
 * before the policy table makes sense, the links between the three Markdown
 * files, the repository paths the prose names by hand, and the shape of the
 * two-language pair. None of that reaches a compiler, so a key added to
 * `config-schema.js`, a decision word added to `route-policy.js`, a path the
 * package stops shipping, or a document that has dropped out of `files` would all
 * ship without a single failing check.
 *
 * Every assertion here is one-way: each document is read, and what it says is
 * required to be *a subset of* what the machine accepts. Nothing here asserts
 * that the machine accepts everything a document mentions, and no wording is
 * compared — a translation is free to say the same thing in other words. The
 * documents also carry no machine marker of their own: no generated block, no
 * reserved comment line, nothing a reader could see. That is what makes the
 * direction safe to enforce — a checker that needed a marker in the prose could
 * only ever prove that the marker was kept up to date.
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Config, KNOWN_KEYS } from '../config-schema.js'
import { codeSpanTokens, isPathShaped, numbered as documentLines, relativeLinks } from '../test-support/document-tokens.mjs'

/** The repository root: every document read here sits beside `package.json`. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** What the repository root actually holds — the only names a path may start with. */
const ROOT_ENTRIES = new Set(readdirSync(ROOT))

/** The two language READMEs — the same document, written twice. */
const READMES = ['README.md', 'README-en.md']

/** Every document this file holds to the code. */
const DOCUMENTS = [...READMES, 'CONTEXT.md']

/** What a `defaultModel` route may carry, from the one place that declares it. */
const ROUTE_KEYS = Object.keys(Config.dict.defaultModel.dict)

/** Read one repository file as text. */
const read = (name) => readFileSync(join(ROOT, name), 'utf8')

/** One repository file, line by line, with the line number each line is on. */
const numbered = (name) => documentLines(ROOT, name)

/** Drop comments from JavaScript source, keeping every line where it was. */
function stripComments(source) {
  let out = ''
  let index = 0
  while (index < source.length) {
    const pair = source.slice(index, index + 2)
    const quote = source[index]
    if (pair === '/*') {
      const close = source.indexOf('*/', index + 2)
      const stop = close === -1 ? source.length : close + 2
      out += source.slice(index, stop).replace(/[^\n]/g, '')
      index = stop
    } else if (pair === '//') {
      const close = source.indexOf('\n', index)
      const stop = close === -1 ? source.length : close
      out += ' '.repeat(stop - index)
      index = stop
    } else if (quote === "'" || quote === '"' || quote === '`') {
      const start = index++
      while (index < source.length && source[index] !== quote) index += source[index] === '\\' ? 2 : 1
      out += source.slice(start, ++index)
    } else {
      out += source[index++]
    }
  }
  return out
}

// ── A1: the keys a README writes under `config:` ───────────────────────────

/** The ` ```yaml ` fences of one document, each row carrying its line number. */
function yamlBlocks(name) {
  const blocks = []
  let open = null
  for (const row of numbered(name)) {
    if (open === null) {
      if (/^```ya?ml\s*$/.test(row.text)) open = { fence: row.number, rows: [] }
    } else if (/^```\s*$/.test(row.text)) {
      blocks.push(open)
      open = null
    } else {
      open.rows.push(row)
    }
  }
  return blocks
}

/**
 * Every key written *under* a `config:` line, with the indent it was written at.
 *
 * The bundle's own `- id:` and `name:` rows sit beside `config:`, not below it,
 * so the scan starts at `config:` and stops at the first row back at its level:
 * they are never collected, and a key is a bare name at the head of a row.
 */
function configKeys(rows) {
  const start = rows.findIndex((row) => /^(\s*)config:\s*(#.*)?$/.test(row.text))
  if (start === -1) return []
  const level = rows[start].text.length - rows[start].text.trimStart().length
  const keys = []
  for (const row of rows.slice(start + 1)) {
    const indent = row.text.length - row.text.trimStart().length
    if (row.text.trim() !== '' && indent <= level) break
    const match = /^(\s*)([A-Za-z][A-Za-z0-9_]*):/.exec(row.text)
    if (match !== null) keys.push({ name: match[2], indent: match[1].length, number: row.number })
  }
  return keys
}

test('every key a README writes under `config:` is one the schema declares', () => {
  for (const name of READMES) {
    const keys = yamlBlocks(name).flatMap((block) => configKeys(block.rows))
    assert.notEqual(keys.length, 0, `${name}: no \`config:\` key was found in a yaml fence, so this test proves nothing`)

    const top = Math.min(...keys.map((key) => key.indent))
    for (const [index, key] of keys.entries()) {
      if (key.indent === top) {
        assert.ok(
          KNOWN_KEYS.includes(key.name),
          `${name}:${key.number} writes config key "${key.name}", which config-schema.js does not declare (it declares ${KNOWN_KEYS.join(', ')})`,
        )
        continue
      }
      // The only nesting the schema allows is a route under `defaultModel`, so
      // a deeper key must belong to that route and be one of its two fields.
      const owner = keys.slice(0, index).reverse().find((other) => other.indent === top)
      assert.equal(owner?.name, 'defaultModel', `${name}:${key.number} nests "${key.name}" under "${owner?.name}", which is not a route`)
      assert.ok(
        ROUTE_KEYS.includes(key.name),
        `${name}:${key.number} writes "${key.name}" under defaultModel, which is a { ${ROUTE_KEYS.join(', ')} } route`,
      )
    }
  }
})

// ── A2: the decision words a README's reader has to learn ──────────────────

/** Every single-word `kind:` / `reason:` literal in a file, with where it was. */
function decisionWords(name) {
  const words = new Map()
  for (const [offset, line] of stripComments(read(name)).split('\n').entries()) {
    for (const [, field, word] of line.matchAll(/\b(kind|reason):\s*'([A-Za-z][A-Za-z0-9_]*)'/g)) {
      if (!words.has(word)) words.set(word, `${name}:${offset + 1} (\`${field}\`)`)
    }
  }
  return words
}

test('every decision word route-policy.js writes is a word CONTEXT.md defines', () => {
  const glossary = read('CONTEXT.md')
  const words = decisionWords('route-policy.js')
  assert.notEqual(words.size, 0, 'route-policy.js declares no `kind:`/`reason:` word, so this test proves nothing')

  for (const [word, where] of words) {
    assert.match(
      glossary,
      new RegExp(`(?<![A-Za-z0-9_])${word}(?![A-Za-z0-9_])`),
      `${where}: the decision word "${word}" is never used in CONTEXT.md, so a reader is asked to learn a word the glossary does not carry`,
    )
  }
})

// ── A3: the links between the documents, and what the package ships ────────

/** The relative link targets of one document, with the line each sits on. */
const links = (name) => relativeLinks(ROOT, name)

/**
 * Whether one `files` entry of `package.json` ships a repository-relative path.
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

test('every relative link a document carries resolves, and the package ships it', () => {
  const { files } = JSON.parse(read('package.json'))
  let linked = 0

  for (const name of DOCUMENTS) {
    for (const { target, number } of links(name)) {
      assert.ok(existsSync(join(ROOT, target)), `${name}:${number} links ${target}, which is not a file in this repository`)
      assert.ok(
        files.some((entry) => ships(entry, target)),
        `${name}:${number} links ${target}, which the "files" array of package.json does not ship`,
      )
      linked += 1
    }
  }
  assert.notEqual(linked, 0, 'no relative link was found in any document, so this test proves nothing')
})

// ── A3b: the repository paths the prose writes in a code span ──────────────

/** npm always packs these, whether or not the `files` array names them. */
const ALWAYS_PACKED = new Set(['package.json'])

/** Whether one `files` entry covers a directory a document names, trailing slash and all. */
function shipsDirectory(entry, directory) {
  const prefix = `${directory.replace(/\/+$/u, '')}/`
  return entry === prefix.slice(0, -1) || entry.startsWith(prefix)
}

/**
 * Every backticked token of one document that reads as a repository path.
 *
 * A path is recognized only when its first segment — or the whole token, for a
 * root file — is an entry the repository root actually holds. That keeps event
 * names (`subagent/descriptor`), identifiers (`apply()`), globs, citations
 * (`plugin.js:108`), absolute paths and anything carrying a URL scheme out of
 * the check: they are the prose's own vocabulary, not a claim about this tree.
 * A path is required to *exist*; that the package ships it is asserted below.
 */
function documentedPaths(name) {
  const paths = []
  for (const { token, number } of codeSpanTokens(ROOT, name)) {
    if (!isPathShaped(token)) continue
    if (!ROOT_ENTRIES.has(token.split('/')[0])) continue
    paths.push({ token, number })
  }
  return paths
}

test('every repository path a document writes in a code span resolves, and ships', () => {
  const { files } = JSON.parse(read('package.json'))
  const written = DOCUMENTS.flatMap((name) => documentedPaths(name).map((path) => ({ name, ...path })))
  assert.notEqual(written.length, 0, 'no document writes a repository path in a code span, so this test proves nothing')

  for (const { name, token, number } of written) {
    const path = join(ROOT, token)
    assert.ok(existsSync(path), `${name}:${number} writes \`${token}\`, which is not a path in this repository`)
    if (ALWAYS_PACKED.has(token)) continue
    // A directory is shipped by whatever entry covers its contents.
    const shipped = statSync(path).isDirectory()
      ? files.some((entry) => shipsDirectory(entry, token))
      : files.some((entry) => ships(entry, token))
    assert.ok(shipped, `${name}:${number} writes \`${token}\`, which the "files" array of package.json does not ship`)
  }
})

// ── A4: the shape the two languages share ─────────────────────────────────

/** Every `## ` heading of one document, in order, with the section it is. */
function sections(name) {
  return numbered(name)
    .filter((row) => /^## /.test(row.text))
    .map((row, index) => ({ ...row, index, title: row.text.slice(3).trim() }))
}

test('the two READMEs carry the same sections in the same order', () => {
  const zh = sections(READMES[0])
  const en = sections(READMES[1])
  assert.notEqual(zh.length, 0, `${READMES[0]} has no \`## \` section, so this test proves nothing`)
  assert.equal(en.length, zh.length, `${READMES[1]} has ${en.length} \`## \` sections, ${READMES[0]} has ${zh.length}`)

  // Only the count and the order are compared: the section at index i has to be
  // the same section in both files. The headings themselves are a translation,
  // so their wording is never asserted on — only where each one sits.
  for (const { index, number } of zh) {
    assert.ok(
      en[index]?.index === index && en[index].number > 0,
      `${READMES[1]} has no section at index ${index}, where ${READMES[0]}:${number} has "${sections(READMES[0])[index].title}"`,
    )
  }
})
