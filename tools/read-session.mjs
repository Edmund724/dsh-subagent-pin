/**
 * Read one DSH session log (`session.v4.jsonl.zstd`) into JSONL events.
 *
 * The log is a concatenation of independently compressed zstd frames, so a
 * single-shot decompress yields only the first frame; this splits on the zstd
 * frame magic and decompresses every frame.
 *
 * Usage: node read-session.mjs <session.v4.jsonl.zstd> [typeFilter]
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
  const filter = process.argv[3]
  if (!file) throw new Error('usage: node read-session.mjs <session.v4.jsonl.zstd> [typeFilter]')
  for (const event of readSessionLog(file)) {
    if (filter && !String(event.type).includes(filter)) continue
    console.log(JSON.stringify(event).slice(0, 1200))
  }
}
