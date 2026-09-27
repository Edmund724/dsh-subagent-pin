/**
 * The `files` array of `package.json`, read the way npm reads it.
 *
 * Three guards need this and they ask a different question of the answer:
 * `test/docs.test.mjs` proves that the paths the documents name are shipped,
 * `test/package.test.mjs` proves that what is importable is shipped and that
 * every entry still matches the tree, and `test/tarball.test.mjs` proves that
 * the manifest agrees with the tarball npm would actually build. The judgement
 * stays beside each guard; the mechanics — matching an entry, and walking the
 * tree npm packs — are the same, so they live here rather than in three copies
 * where the second and third can drift away from the first.
 */

import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * Whether one `files` entry names a repository path.
 *
 * `*` stays inside one path segment while `**` crosses directories, which is how
 * npm itself reads a `files` entry.
 *
 * @param entry - one `files` entry of `package.json`.
 * @param file - a repository-relative path, with `/` separators.
 * @returns whether the entry covers the path.
 */
export function ships(entry, file) {
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

/**
 * Every path under the repository root that npm's packlist considers at all.
 *
 * `node_modules` and `.git` are left out because npm never packs either one, so
 * an entry naming them would be a claim about nothing. Sorted, so that a guard
 * comparing two of these lists reports a difference rather than an order.
 *
 * @param root - absolute path of the repository root.
 * @returns repository-relative paths with `/` separators, sorted.
 */
export function repositoryPaths(root) {
  const found = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else found.push(path)
    }
  }
  walk(root)
  return found.map((path) => relative(root, path).replaceAll(sep, '/')).sort()
}
