/**
 * 多帧 zstd 读取器。
 *
 * DSH 的 `session.jsonl.zstd` 不是"一个 zstd 压缩的 JSONL"，而是**一帧一帧追加**的
 * 压缩流（每次 flush 追加一个独立 frame）。Node 自带的 `zstdDecompressSync()` 与
 * `createZstdDecompress()` 都只解码**第一帧**就返回，直接读会静默丢掉 99% 的内容——
 * 这是本适配器最容易踩的坑，所以这里手写帧边界扫描。
 *
 * 实现依据 RFC 8878 的帧格式：
 *   Frame = Magic(4) Frame_Header Block+ [Content_Checksum(4)]
 *   Magic = 0xFD2FB528 (LE)；可跳过帧 = 0x184D2A5? (LE)
 * 帧头给出 FCS(帧内容大小) 与 Window_Descriptor 的存在性，随后每个 Block 头的 3 字节
 * 里带 (last_block, block_type, block_size)，据此可以精确跳到下一帧开头。
 *
 * 另有容错设计：DHW 正在写入时，最后一帧可能是**半截**（只写了一半的 block），
 * 此时整段跳过该帧并把 `incomplete` 标出来，让调用方知道"这是未落盘完的尾巴"。
 *
 * @module cyber-overseer/util/zstd-frames
 */

import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
const SKIPPABLE_MIN = 0x184d2a50
const SKIPPABLE_MAX = 0x184d2a5f

/**
 * zstd 是否可用（Node >= 22.15 / 24 才带）。可用性要在运行时判断，
 * 因为 DSH 之外的适配器（codex/opencode/cursor）完全不需要它。
 * @returns {boolean}
 */
export function hasZstd() {
  return typeof zstdDecompressSync === 'function'
}

/**
 * 扫描出所有帧的边界。
 * @param {Buffer} buf 原始文件字节
 * @returns {{start:number,end:number,kind:'frame'|'skippable'|'garbage',complete:boolean}[]}
 */
export function scanFrames(buf) {
  const frames = []
  let off = 0
  while (off + 4 <= buf.length) {
    const magic = buf.readUInt32LE(off)
    if (magic >= SKIPPABLE_MIN && magic <= SKIPPABLE_MAX) {
      if (off + 8 > buf.length) break
      const size = buf.readUInt32LE(off + 4)
      const end = off + 8 + size
      frames.push({ start: off, end: Math.min(end, buf.length), kind: 'skippable', complete: end <= buf.length })
      off = end
      continue
    }
    if (magic !== ZSTD_MAGIC) {
      // 不是帧头：要么文件被截断，要么根本不是 zstd。交给调用方决定怎么报错。
      frames.push({ start: off, end: buf.length, kind: 'garbage', complete: false })
      break
    }
    const start = off
    let q = off + 4
    if (q >= buf.length) { frames.push({ start, end: buf.length, kind: 'frame', complete: false }); break }
    const fhd = buf[q++]
    const fcsFlag = fhd >> 6
    const singleSegment = (fhd >> 5) & 1
    const hasChecksum = (fhd >> 2) & 1
    const dictFlag = fhd & 3
    // FCS 字段长度：0 表示"没有该字段"，除非 Single_Segment 置位（此时 1 字节）
    const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
    q += fcsSize
    if (!singleSegment) q += 1 // Window_Descriptor
    q += dictFlag === 0 ? 0 : dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : 4
    let complete = true
    for (;;) {
      if (q + 3 > buf.length) { complete = false; break }
      const head = buf[q] | (buf[q + 1] << 8) | (buf[q + 2] << 16)
      q += 3
      const last = head & 1
      const type = (head >> 1) & 3
      const size = head >> 3
      q += type === 1 ? 1 : size // RLE 块只有 1 字节负载
      if (q > buf.length) { complete = false; break }
      if (last) break
    }
    if (hasChecksum) q += 4
    const end = Math.min(q, buf.length)
    frames.push({ start, end, kind: 'frame', complete: complete && q <= buf.length })
    off = end
    if (!complete) break
  }
  return frames
}

/**
 * 解压一个多帧 zstd buffer。
 * @param {Buffer} buf
 * @returns {{text:string, frames:number, decoded:number, failures:number, incomplete:number, garbageBytes:number}}
 */
export function decompressFrames(buf) {
  if (!hasZstd()) {
    throw new Error('当前 Node 缺少 zstd 支持（需要 node:zlib 的 zstdDecompressSync，Node >= 22.15）')
  }
  const frames = scanFrames(buf)
  const parts = []
  let decoded = 0
  let failures = 0
  let incomplete = 0
  let garbageBytes = 0
  for (const frame of frames) {
    if (frame.kind === 'garbage') { garbageBytes += frame.end - frame.start; continue }
    if (frame.kind === 'skippable') continue
    if (!frame.complete) incomplete++
    try {
      parts.push(zstdDecompressSync(buf.subarray(frame.start, frame.end)))
      decoded++
    } catch {
      // 半截帧 / 校验失败：跳过。已经解出来的部分仍然是有效历史。
      failures++
    }
  }
  return {
    text: Buffer.concat(parts).toString('utf8'),
    frames: frames.filter(f => f.kind === 'frame').length,
    decoded,
    failures,
    incomplete,
    garbageBytes,
  }
}

/**
 * 把一个多帧 zstd 文件读成文本（带容错）。
 * @param {string} file
 * @param {{fs?: import('node:fs')}} [opts]
 * @returns {{text:string, info:ReturnType<typeof decompressFrames>|null}}
 */
export function readZstdText(file, opts = {}) {
  const fs = opts.fs ?? globalThis.__cwFs
  if (!fs) throw new Error('readZstdText 需要注入 fs（避免在模块顶层依赖具体实现）')
  const buf = fs.readFileSync(file)
  const info = decompressFrames(buf)
  return { text: info.text, info }
}
