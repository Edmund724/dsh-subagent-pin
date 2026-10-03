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
 *
 * Each judgement is a function that takes text and returns what it found, and
 * every one of them is also fed a real document with one mechanical edit at the
 * end of this file. A guard nobody has seen fail is a guard nobody knows works,
 * and each rule here — what reads as a path, which span counts, how far a key may
 * nest — was written to make a real document pass.
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Config, KNOWN_KEYS } from '../config-schema.js'
import { Config as SESSION_CONFIG, KNOWN_KEYS as SESSION_KEYS } from '../opencode-header.js'
import { codeSpans, isPathShaped, lines, linkTargets } from '../test-support/document-tokens.mjs'
import { ships } from '../test-support/package-files.mjs'

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

/** What a packed copy contains, which is the second half of a link's claim. */
const MANIFEST = JSON.parse(read('package.json'))

/** The files a packed copy carries. */
const FILES = MANIFEST.files

/**
 * The rows this package ships, and the schema each row's `config:` is held to.
 *
 * A README documents every row, so the block's own `name:` decides which schema
 * its keys are checked against. A block naming a row this file cannot place
 * falls back to every key declared anywhere, which is still one-way and still
 * catches a key no schema declares.
 *
 * The steering row declares an empty key set on purpose: it exports no `Config`
 * at all (`test/subagent-steer.test.mjs`, `test/patch.test.mjs`), so a README
 * block naming it may write no key under `config:` — the row has no interface
 * that could accept one.
 */
const ROW_SCHEMAS = new Map([
  [`${MANIFEST.name}/subagent-pin`, { keys: KNOWN_KEYS, route: 'defaultModel', routeKeys: ROUTE_KEYS }],
  [`${MANIFEST.name}/opencode-header`, { keys: SESSION_KEYS, route: null, routeKeys: [] }],
  [`${MANIFEST.name}/subagent-steer`, { keys: [], route: null, routeKeys: [] }],
])

/** The schema a block falls back to when its row cannot be placed. */
const ANY_ROW = {
  keys: [...new Set([...KNOWN_KEYS, ...SESSION_KEYS])],
  route: 'defaultModel',
  routeKeys: ROUTE_KEYS,
}

/** These documents, each read as text, for the judgements that take a set of them. */
const documents = (names) => names.map((name) => ({ name, text: read(name) }))

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

/** The ` ```yaml ` fences of one document text, each row carrying its line number. */
function yamlBlocks(text) {
  const blocks = []
  let open = null
  for (const row of lines(text)) {
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

/** The row name one yaml block declares beside its `config:`, if any. */
function blockRowName(rows) {
  for (const row of rows) {
    const match = /^\s*-?\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(row.text)
    if (match !== null) return match[1]
  }
  return undefined
}

/**
 * Every `config:` key of one README that the block's own row schema does not declare.
 *
 * The block's `name:` picks the schema, and a nested key is only legal under the
 * route the schema names, so a key that belongs to the other row of this package
 * is reported here instead of passing on the strength of its neighbour.
 */
function configKeyFindings(name, text) {
  const blocks = yamlBlocks(text)
    .map((block) => ({ block, keys: configKeys(block.rows) }))
    .filter(({ keys }) => keys.length > 0)
  if (blocks.length === 0) return [`${name}: no \`config:\` key was found in a yaml fence, so this check proves nothing`]

  const findings = []
  for (const { block, keys } of blocks) {
    const schema = ROW_SCHEMAS.get(blockRowName(block.rows)) ?? ANY_ROW
    const top = Math.min(...keys.map((key) => key.indent))
    for (const [index, key] of keys.entries()) {
      if (key.indent === top) {
        if (!schema.keys.includes(key.name)) {
          findings.push(`${name}:${key.number} writes config key "${key.name}", which no schema of this package declares (this row declares ${schema.keys.join(', ')})`)
        }
        continue
      }
      // The only nesting any row allows is a route under `defaultModel`, so a
      // deeper key must belong to that route and be one of its fields.
      const owner = keys.slice(0, index).reverse().find((other) => other.indent === top)
      if (owner?.name !== schema.route) {
        findings.push(`${name}:${key.number} nests "${key.name}" under "${owner?.name}", which is not a route`)
        continue
      }
      if (!schema.routeKeys.includes(key.name)) {
        findings.push(`${name}:${key.number} writes "${key.name}" under defaultModel, which is a { ${schema.routeKeys.join(', ')} } route`)
      }
    }
  }
  return findings
}

test('every key a README writes under `config:` is one the schema declares', () => {
  for (const name of READMES) {
    assert.deepEqual(configKeyFindings(name, read(name)), [], `${name} writes a config key the schema does not declare:`)
  }
})

// ── A2: the decision words a README's reader has to learn ──────────────────

/** Every single-word `kind:` / `reason:` literal in one source text, with where it was. */
function decisionWords(name, source) {
  const words = new Map()
  for (const [offset, line] of stripComments(source).split('\n').entries()) {
    for (const [, field, word] of line.matchAll(/\b(kind|reason):\s*'([A-Za-z][A-Za-z0-9_]*)'/g)) {
      if (!words.has(word)) words.set(word, `${name}:${offset + 1} (\`${field}\`)`)
    }
  }
  return words
}

/** Every decision word one source text writes that the glossary never uses. */
function decisionWordFindings(name, source, glossary) {
  const words = decisionWords(name, source)
  if (words.size === 0) return [`${name} declares no \`kind:\`/\`reason:\` word, so this check proves nothing`]

  const findings = []
  for (const [word, where] of words) {
    if (!new RegExp(`(?<![A-Za-z0-9_])${word}(?![A-Za-z0-9_])`).test(glossary)) {
      findings.push(`${where}: the decision word "${word}" is never used in CONTEXT.md, so a reader is asked to learn a word the glossary does not carry`)
    }
  }
  return findings
}

test('every decision word route-policy.js writes is a word CONTEXT.md defines', () => {
  assert.deepEqual(decisionWordFindings('route-policy.js', read('route-policy.js'), read('CONTEXT.md')), [])
})

// ── A3: the links between the documents, and what the package ships ────────

/** Every relative link of these documents that is missing, or that the package does not ship. */
function linkFindings(docs) {
  const findings = []
  let linked = 0

  for (const { name, text } of docs) {
    for (const { target, number } of linkTargets(lines(text))) {
      linked += 1
      if (!existsSync(join(ROOT, target))) {
        findings.push(`${name}:${number} links ${target}, which is not a file in this repository`)
      } else if (!FILES.some((entry) => ships(entry, target))) {
        findings.push(`${name}:${number} links ${target}, which the "files" array of package.json does not ship`)
      }
    }
  }
  if (linked === 0) findings.push('no relative link was found in any document, so this check proves nothing')
  return findings
}

test('every relative link a document carries resolves, and the package ships it', () => {
  assert.deepEqual(linkFindings(documents(DOCUMENTS)), [])
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
 * Every backticked token of one document text that reads as a repository path.
 *
 * A path is recognized only when its first segment — or the whole token, for a
 * root file — is an entry the repository root actually holds. That keeps event
 * names (`subagent/descriptor`), identifiers (`apply()`), globs, citations
 * (`plugin.js:108`), absolute paths and anything carrying a URL scheme out of
 * the check: they are the prose's own vocabulary, not a claim about this tree.
 * A path is required to *exist*; that the package ships it is asserted below.
 */
function pathClaims(text) {
  const claims = []
  for (const { token, number } of codeSpans(lines(text))) {
    if (!isPathShaped(token)) continue
    if (!ROOT_ENTRIES.has(token.split('/')[0])) continue
    claims.push({ token, number })
  }
  return claims
}

/** Every path these documents claim that is missing, or that the package does not ship. */
function pathClaimFindings(docs) {
  const findings = []
  let checked = 0

  for (const { name, text } of docs) {
    for (const { token, number } of pathClaims(text)) {
      checked += 1
      const path = join(ROOT, token)
      if (!existsSync(path)) {
        findings.push(`${name}:${number} writes \`${token}\`, which is not a path in this repository`)
        continue
      }
      if (ALWAYS_PACKED.has(token)) continue
      // A directory is shipped by whatever entry covers its contents.
      const shipped = statSync(path).isDirectory()
        ? FILES.some((entry) => shipsDirectory(entry, token))
        : FILES.some((entry) => ships(entry, token))
      if (!shipped) findings.push(`${name}:${number} writes \`${token}\`, which the "files" array of package.json does not ship`)
    }
  }
  if (checked === 0) findings.push('no document writes a repository path in a code span, so this check proves nothing')
  return findings
}

test('every repository path a document writes in a code span resolves, and ships', () => {
  assert.deepEqual(pathClaimFindings(documents(DOCUMENTS)), [])
})

// ── A4: the shape the two languages share ─────────────────────────────────

/** Every `## ` heading of one document text, in order, with the section it is. */
function sections(text) {
  return lines(text)
    .filter((row) => /^## /.test(row.text))
    .map((row, index) => ({ ...row, index, title: row.text.slice(3).trim() }))
}

/** Every way one README's section shape differs from the other's. */
function sectionShapeFindings(zh, en) {
  const zhSections = sections(zh.text)
  const enSections = sections(en.text)
  if (zhSections.length === 0) return [`${zh.name} has no \`## \` section, so this check proves nothing`]

  const findings = []
  if (enSections.length !== zhSections.length) {
    findings.push(`${en.name} has ${enSections.length} \`## \` sections, ${zh.name} has ${zhSections.length}`)
  }
  // Only the count and the order are compared: the section at index i has to be
  // the same section in both files. The headings themselves are a translation,
  // so their wording is never asserted on — only where each one sits.
  for (const { index, number, title } of zhSections) {
    if (!(enSections[index]?.index === index && enSections[index].number > 0)) {
      findings.push(`${en.name} has no section at index ${index}, where ${zh.name}:${number} has "${title}"`)
    }
  }
  return findings
}

test('the two READMEs carry the same sections in the same order', () => {
  const [zh, en] = documents(READMES)
  assert.deepEqual(sectionShapeFindings(zh, en), [])
})

// ── the guard's own bad baselines ─────────────────────────────────────────

/**
 * Each check above is fed the real document with one edit and has to report it,
 * and an empty one and has to say it had nothing to look at.
 *
 * The tests above run every judgement on every real document, so this is not
 * coverage: it is the evidence that the judgements *can* fail. Each fixture is
 * the real file with one token replaced, so a document that changes shape takes
 * its own bad baseline down with it instead of quietly stopping to test anything.
 */

/** One document with its first `from` replaced by `to`, or a failure to say so. */
function edited(name, from, to) {
  const text = read(name)
  const changed = text.replace(from, to)
  assert.notEqual(changed, text, `${name} no longer contains ${from}, so this bad baseline would test nothing`)
  return changed
}

test('a config key the schema does not declare is reported', () => {
  // The anchor names the key only, so an example that changes its value keeps this
  // baseline working; an example that stops writing a key at all takes it down.
  const findings = configKeyFindings('README.md', edited('README.md', /^(\s*)source: /mu, '$1routeSource: '))

  assert.equal(findings.length, 1, findings.join('\n'))
  assert.match(findings[0], /routeSource/)
})

test('a config key that belongs to the package\'s other row is reported', () => {
  // The two rows' key sets are disjoint, and the block's `name:` is what decides
  // which schema a key is checked against — a key borrowed from the neighbour
  // must not pass on the strength of the block it sits in.
  const text = `${read('README.md')}\n\n\`\`\`yaml\n- id: opencode-header\n  name: 'dsh-subagent-pin/opencode-header'\n  config:\n    source: settings\n\`\`\`\n`
  const findings = configKeyFindings('README.md', text)

  assert.equal(findings.length, 1, findings.join('\n'))
  assert.match(findings[0], /source/)
})

test('a decision word CONTEXT.md does not define is reported', () => {
  const source = edited('route-policy.js', /kind: '[a-z]+'/u, "kind: 'bogusKind'")
  const findings = decisionWordFindings('route-policy.js', source, read('CONTEXT.md'))

  assert.equal(findings.length, 1, findings.join('\n'))
  assert.match(findings[0], /bogusKind/)
})

test('a relative link that is missing is reported', () => {
  const findings = linkFindings([{ name: 'README.md', text: edited('README.md', '](README-en.md)', '](README-missing.md)') }])

  assert.equal(findings.length, 1, findings.join('\n'))
  assert.match(findings[0], /README-missing\.md/)
})

test('a path a document writes that is not in this repository is reported', () => {
  const text = `${read('README.md')}\n\n改完之后见 \`test/no-such-file.test.mjs\`。\n`
  const findings = pathClaimFindings([{ name: 'README.md', text }])

  assert.equal(findings.length, 1, findings.join('\n'))
  assert.match(findings[0], /test\/no-such-file\.test\.mjs/)
})

test('a renamed root-level name is not read as a path, which is the trade-off this rule made', () => {
  // `pathClaims` requires a token's first segment to be an entry the root really
  // holds, which is what keeps `descriptor.js` and `subagent/descriptor` — the
  // prose's own vocabulary — out of the check. A root-level file that was renamed
  // therefore stops reading as a claim instead of failing. Pinned so that loosening
  // the rule is a decision someone makes, not a cleanup someone does.
  const text = `${read('README.md')}\n\n另见 \`plugin-renamed.js\`。\n`

  assert.deepEqual(pathClaimFindings([{ name: 'README.md', text }]), [])
})

test('a README that lost a section is reported', () => {
  const zh = { name: 'README.md', text: read('README.md') }
  const en = { name: 'README-en.md', text: edited('README-en.md', /^## .+$/mu, '') }

  assert.notEqual(sectionShapeFindings(zh, en).length, 0)
})

test('a check that had nothing to look at says so instead of passing', () => {
  const empty = [{ name: 'EMPTY.md', text: '' }]

  assert.notEqual(configKeyFindings('EMPTY.md', '').length, 0)
  assert.notEqual(decisionWordFindings('EMPTY.md', '', read('CONTEXT.md')).length, 0)
  assert.notEqual(linkFindings(empty).length, 0)
  assert.notEqual(pathClaimFindings(empty).length, 0)
  assert.notEqual(sectionShapeFindings(empty[0], empty[0]).length, 0)
})
