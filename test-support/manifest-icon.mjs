/**
 * What a manifest's `icon` must satisfy before the Host draws it.
 *
 * `readPluginMeta()` in `@deepseek-ai/dsh-app-boot` reads the icon a
 * `${specifier}/package.json` declares and inlines the file as a data URI
 * (`iconOf`), so every rule here is one the Host applies: a relative path with no
 * URL scheme or drive letter, one of four media types, a regular file that stays
 * inside the manifest directory after realpath resolution, and at most 256 KiB.
 * A manifest that breaks one still activates and still carries a name — the
 * artwork alone silently falls back to the default picture, which is why the
 * rules are asserted rather than left to the Host's per-field diagnostic.
 *
 * The last rule is this package's own, not the Host's: every piece of artwork
 * here draws on the official 36×36 viewBox, the slot the cards and rows render
 * at, so a glyph added from another canvas does not sit out of proportion beside
 * the rest of the family.
 *
 * Two Host rules cannot be reported from a unit test without a fixture nobody
 * would keep: an icon that only *resolves* outside its manifest directory through
 * a symlink, and a directory that happens to be named like an icon file. The
 * first needs a symlink this suite does not create; the second is answered by the
 * `is not a file` rule wherever the entry exists at all.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve, sep, win32 } from 'node:path'

/** The extensions and the raw size ceiling DSH admits a manifest icon under. */
const ICON_MEDIA_TYPES = ['.svg', '.png', '.jpg', '.jpeg', '.webp']
export const MAX_ICON_BYTES = 256 * 1024

/** The box every piece of this package's artwork draws on, cards and rows alike. */
const FAMILY_VIEW_BOX = 'viewBox="0 0 36 36"'

/**
 * Every way one manifest's declared `icon` would not be drawn.
 *
 * The icon is resolved from the manifest's own directory, exactly as the Host
 * resolves it, so a manifest kept somewhere other than the repository root is
 * judged by its own neighbourhood.
 *
 * @param manifest - the parsed manifest, whose `icon` is under test.
 * @param manifestPath - the absolute path of that same file.
 * @returns one line per failure, empty when the Host would inline the icon.
 */
export function iconFindings(manifest, manifestPath) {
  const findings = []
  const icon = manifest?.icon
  if (typeof icon !== 'string' || icon.trim() === '') {
    return [`${manifestPath}: declares no non-empty \`icon\`, so DSH draws its default artwork`]
  }
  if (isAbsolute(icon) || win32.isAbsolute(icon) || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon)) {
    return [`${manifestPath}: icon "${icon}" must be a relative file path`]
  }
  if (!ICON_MEDIA_TYPES.includes(extname(icon).toLowerCase())) {
    findings.push(`${manifestPath}: icon "${icon}" must be SVG, PNG, JPEG, or WebP`)
  }

  const directory = realpathSync(dirname(manifestPath))
  const file = resolve(directory, icon)
  if (!existsSync(file)) {
    return [...findings, `${manifestPath}: icon "${icon}" is not a file in ${directory}`]
  }

  const local = relative(directory, realpathSync(file))
  if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    findings.push(`${manifestPath}: icon "${icon}" must remain inside its manifest directory`)
  }
  if (!statSync(file).isFile()) {
    return [...findings, `${manifestPath}: icon "${icon}" is not a regular file`]
  }
  const bytes = readFileSync(file)
  if (bytes.length > MAX_ICON_BYTES) {
    findings.push(`${manifestPath}: icon "${icon}" exceeds the 256 KiB ceiling DSH reads icons under`)
  }
  if (extname(icon).toLowerCase() === '.svg' && !bytes.toString('utf8').includes(FAMILY_VIEW_BOX)) {
    findings.push(`${manifestPath}: icon "${icon}" must draw on the official 36×36 viewBox`)
  }
  return findings
}
