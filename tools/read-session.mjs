/**
 * Read one DSH session log (`session.v4.jsonl.zstd`) into JSONL events.
 *
 * The log is a concatenation of independently compressed zstd frames, so a
 * single-shot decompress yields only the first frame; this splits on the zstd
 * frame magic and decompresses every frame. A trailing frame that is still being
 * written costs only its own events.
 *
 * Usage: node read-session.mjs <session.v4.jsonl.zstd> [type]
 *
 * The optional `type` selects events whose `type` is exactly that string, and
 * every selected event is printed whole — one complete JSON object per line, so
 * the output is parseable and can be piped. A log holds a `request/header` of
 * 24k–31k characters, so printing is not trimmed: redirect it or pipe it.
 */
import fs from 'node:fs'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Split a concatenated-frame zstd buffer into its frames and decompress each. */
export function readSessionLog(file) {
  const raw = fs.readFileSync(file)
  const starts = []
  for (let index = 0; index + 4 <= raw.length; index++) if (raw.compare(MAGIC, 0, 4, index, index + 4) === 0) starts.push(index)
  const parts = starts.length === 0 ? [raw] : starts.map((start, index) => raw.subarray(start, starts[index + 1] ?? raw.length))
  const text = parts
    .map((frame) => {
      try {
        return zlib.zstdDecompressSync(frame).toString('utf8')
      } catch {
        return '' // a live log's trailing frame may still be incomplete
      }
    })
    .join('')
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
}

if (process.argv[1]?.endsWith('read-session.mjs')) {
  const file = process.argv[2]
  const type = process.argv[3]
  if (!file) throw new Error('usage: node read-session.mjs <session.v4.jsonl.zstd> [type]')
  for (const event of readSessionLog(file)) {
    if (type && event.type !== type) continue
    console.log(JSON.stringify(event))
  }
}
