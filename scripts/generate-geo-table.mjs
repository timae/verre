// Regenerate the IP→country lookup tables from public RIR delegated-extended
// statistics (the NRO combined file). Public domain: no licence, no
// attribution, no account.
//
// Usage:   node scripts/generate-geo-table.mjs <outDir>
//   Writes three files into <outDir> (default ./geo-data):
//     geo-v4.bin  — sorted fixed-width IPv4 ranges (9 bytes/record)
//     geo-v6.bin  — sorted fixed-width IPv6 ranges (33 bytes/record)
//     geo-cc.json — ccIndex → "CC" mapping (tiny)
//
// These are SEEKABLE binary files: lib/geo.ts binary-searches them by seeking
// to byte offsets and reading a few bytes per lookup, so the ~300k ranges never
// sit in process memory (the OS page cache handles hot pages). That's why the
// format is fixed-width binary, not JSON.
//
// Record layouts (all big-endian, so byte order == numeric order):
//   v4: startUInt32 (4) | endUInt32 (4) | ccIndex UInt8 (1)        = 9 bytes
//   v6: start 16 bytes  | end 16 bytes  | ccIndex UInt8 (1)        = 33 bytes
//
// Delivery (see lib/geo.ts + the deploy job): the deploy job runs this, uploads
// the files to S3; the app downloads them to local disk at boot and queries the
// on-disk files. At REQUEST time nothing is fetched and the IP never leaves the
// server. Run monthly-ish (country allocations barely drift).
//
// Data source: the NRO publishes a single daily-merged file combining all five
// RIRs. Falls back to per-RIR fetch if the combined URL is unreachable.

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const NRO_URL = 'https://ftp.ripe.net/pub/stats/ripencc/nro-stats/latest/nro-delegated-stats'
const RIR_URLS = [
  'https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest',
  'https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-extended-latest',
  'https://ftp.apnic.net/stats/apnic/delegated-apnic-extended-latest',
  'https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-extended-latest',
  'https://ftp.afrinic.net/stats/afrinic/delegated-afrinic-extended-latest',
]

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'verre-geo-table-generator' } })
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return res.text()
}

async function loadData() {
  try {
    process.stderr.write(`Fetching combined NRO file…\n`)
    return await fetchText(NRO_URL)
  } catch (e) {
    process.stderr.write(`Combined fetch failed (${e.message}); falling back to per-RIR…\n`)
    const parts = []
    for (const url of RIR_URLS) {
      process.stderr.write(`  ${url}\n`)
      parts.push(await fetchText(url))
    }
    return parts.join('\n')
  }
}

function ipv4ToInt(ip) {
  const o = ip.split('.').map(Number)
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0
}

// IPv6 string → 16-byte big-endian Buffer.
function ipv6ToBuf(ip) {
  const halves = ip.split('::')
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  const groups = halves.length === 2 ? [...head, ...Array(missing).fill('0'), ...tail] : head
  const buf = Buffer.alloc(16)
  for (let i = 0; i < 8; i++) buf.writeUInt16BE(parseInt(groups[i] || '0', 16), i * 2)
  return buf
}

// Add `count` to a 16-byte big-endian buffer (for v6 end = start + 2^(128-prefix)).
// We only need end = start + size - 1; compute via BigInt then write back.
function bufAddSizeMinus1(startBuf, prefix) {
  const start = BigInt('0x' + startBuf.toString('hex'))
  const end = start + (BigInt(1) << (BigInt(128) - BigInt(prefix))) - BigInt(1)
  // Guard against a >128-bit end (would silently truncate the hex → garbage
  // bytes with end < start, an unsearchable range). Real RIR data never wraps,
  // so this is a defensive assert, not an expected path.
  const MAX = (BigInt(1) << BigInt(128)) - BigInt(1)
  if (end > MAX) throw new Error(`ipv6 range overflow: start=${startBuf.toString('hex')} prefix=${prefix}`)
  const hex = end.toString(16).padStart(32, '0')
  return Buffer.from(hex, 'hex')
}

function main(text, outDir) {
  const v4 = []  // {s, e, cc}
  const v6 = []  // {sBuf, eBuf, cc}
  const ccSet = new Set()

  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue
    const f = line.split('|')
    const [, cc, type, start, value, , status] = f
    if (type !== 'ipv4' && type !== 'ipv6') continue
    if (start === '*' || value === 'summary') continue
    if (!cc) continue
    if (status !== 'allocated' && status !== 'assigned') continue
    ccSet.add(cc)
    if (type === 'ipv4') {
      const s = ipv4ToInt(start)
      v4.push({ s, e: s + Number(value) - 1, cc })
    } else {
      const sBuf = ipv6ToBuf(start)
      v6.push({ sBuf, eBuf: bufAddSizeMinus1(sBuf, value), cc })
    }
  }

  // Sanity floor BEFORE writing. A successful-but-truncated fetch (200 with a
  // partial body) parses without error into a tiny table; without this guard
  // we'd write it and the deploy job would upload it, overwriting the good S3
  // copy and blanking geo globally. Real data is ~256k v4 / ~70k v6 / 239
  // countries; these floors are far below real values but far above any
  // truncated/garbage parse. Throwing here makes the refresh script keep the
  // existing S3 copy (it only overwrites on a clean exit). These floors are a
  // deliberate static safety net, NOT a moving target — RIR allocations only
  // grow, so a legitimate parse never trips them. If a future parse does fall
  // below, the cause is a bad source/format change to investigate, not a floor
  // to lower.
  if (v4.length < 100_000 || v6.length < 20_000 || ccSet.size < 150) {
    throw new Error(`implausible parse (v4=${v4.length}, v6=${v6.length}, cc=${ccSet.size}) — likely a truncated source; refusing to write`)
  }

  v4.sort((a, b) => a.s - b.s)
  v6.sort((a, b) => Buffer.compare(a.sBuf, b.sBuf))

  // Country index: sorted alpha-2 list → 1-byte index. (≤256 countries; the
  // RIR set is ~240, comfortably under 256, so UInt8 suffices.)
  const ccList = [...ccSet].sort()
  if (ccList.length > 256) throw new Error(`>256 countries (${ccList.length}); UInt8 index insufficient`)
  const ccIndex = new Map(ccList.map((c, i) => [c, i]))

  // Write v4: 9 bytes/record.
  const v4buf = Buffer.alloc(v4.length * 9)
  v4.forEach((r, i) => {
    const o = i * 9
    v4buf.writeUInt32BE(r.s, o)
    v4buf.writeUInt32BE(r.e, o + 4)
    v4buf.writeUInt8(ccIndex.get(r.cc), o + 8)
  })

  // Write v6: 33 bytes/record.
  const v6buf = Buffer.alloc(v6.length * 33)
  v6.forEach((r, i) => {
    const o = i * 33
    r.sBuf.copy(v6buf, o)
    r.eBuf.copy(v6buf, o + 16)
    v6buf.writeUInt8(ccIndex.get(r.cc), o + 32)
  })

  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'geo-v4.bin'), v4buf)
  writeFileSync(join(outDir, 'geo-v6.bin'), v6buf)
  writeFileSync(join(outDir, 'geo-cc.json'), JSON.stringify(ccList))

  process.stderr.write(
    `Wrote ${v4.length} IPv4 (${(v4buf.length / 1e6).toFixed(1)}MB), ` +
    `${v6.length} IPv6 (${(v6buf.length / 1e6).toFixed(1)}MB), ` +
    `${ccList.length} countries → ${outDir}\n`,
  )
}

const outDir = process.argv[2] || 'geo-data'
loadData().then(t => main(t, outDir)).catch(e => { process.stderr.write(`FAILED: ${e.message}\n`); process.exit(1) })
