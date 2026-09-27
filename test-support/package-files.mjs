/**
 * Reading one `files` entry of `package.json` the way npm reads it.
 *
 * Two guards ask this same question — `test/docs.test.mjs` to prove that the
 * paths the documents name are shipped, and `test/package.test.mjs` to prove
 * that what is importable is shipped and that every entry still matches the tree
 * — and the two copies of this matcher were byte-identical. What they ask *of*
 * the answer differs, and stays beside each; the reading of an entry doesn't, so
 * the second copy cannot drift away from the first here.
 *
 * This is an approximation of npm's own packlist, kept because a test must not
 * need npm to run. `test/tarball.test.mjs` exists to hold the approximation to
 * the real thing.
 */

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
