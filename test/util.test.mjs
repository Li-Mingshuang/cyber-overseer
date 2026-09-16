/**
 * 基础工具测试：多帧 zstd、文本、时间与静默期。
 * 跑法：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zstdCompressSync } from 'node:zlib'
import { decompressFrames, scanFrames, hasZstd } from '../src/util/zstd-frames.mjs'
import { clip, extractJson, hash, normalize, oneLine, stripAnsi, tail } from '../src/util/text.mjs'
import { humanDuration, inWindow, minutesOfDay, msUntilWindow, parseHhMm } from '../src/util/time.mjs'

test('scanFrames/decompressFrames 能解开拼接的多帧 zstd（Node 自带解码器只吃第一帧）', { skip: !hasZstd() }, () => {
  const parts = ['{"type":"session","id":"a"}\n', '{"type":"turn/start","data":{"turn":1}}\n', '{"type":"assistant/message","data":{}}\n']
  const buffer = Buffer.concat(parts.map(part => zstdCompressSync(Buffer.from(part, 'utf8'))))
  const frames = scanFrames(buffer)
  assert.equal(frames.length, 3)
  assert.ok(frames.every(f => f.kind === 'frame' && f.complete))

  const result = decompressFrames(buffer)
  assert.equal(result.decoded, 3)
  assert.equal(result.failures, 0)
  assert.equal(result.text, parts.join(''))
})

test('decompressFrames 容忍半截的最后一帧（写入中）', { skip: !hasZstd() }, () => {
  const first = zstdCompressSync(Buffer.from('{"a":1}\n', 'utf8'))
  const second = zstdCompressSync(Buffer.from('{"b":2}\n', 'utf8'))
  const truncated = Buffer.concat([first, second.subarray(0, Math.floor(second.length / 2))])
  const result = decompressFrames(truncated)
  assert.equal(result.text, '{"a":1}\n')
  assert.equal(result.incomplete, 1)
})

test('文本工具：哈希稳定、截断保头保尾、JSON 抠取容错', () => {
  assert.equal(hash('赛博监工'), hash('赛博监工'))
  assert.notEqual(hash('a'), hash('b'))
  assert.equal(stripAnsi('\u001B[31m红\u001B[0m'), '红')
  assert.equal(normalize('a\r\n\r\n\r\nb  '), 'a\n\n\nb')
  const long = 'x'.repeat(100)
  const clipped = clip(long, 20)
  assert.ok(clipped.includes('省略'))
  assert.equal(tail('abcdef', 3), 'def')
  assert.equal(oneLine('a\nb\tc', 100), 'a b c')
  assert.deepEqual(extractJson('```json\n{"status":"done"}\n```'), { status: 'done' })
  assert.deepEqual(extractJson('前言 {"status":"continue"} 后语'), { status: 'continue' })
  assert.equal(extractJson('没有 json'), null)
})

test('时间工具：静默期跨零点判定正确', () => {
  assert.equal(parseHhMm('23:00'), 1380)
  assert.equal(parseHhMm('24:00'), null)
  assert.equal(inWindow(null), true)
  // 23:00–08:00 覆盖 23:30 与 03:00，不覆盖 12:00
  assert.equal(inWindow({ from: '23:00', to: '08:00' }, new Date(2026, 0, 1, 23, 30)), true)
  assert.equal(inWindow({ from: '23:00', to: '08:00' }, new Date(2026, 0, 1, 3, 0)), true)
  assert.equal(inWindow({ from: '23:00', to: '08:00' }, new Date(2026, 0, 1, 12, 0)), false)
  // 09:00–18:00 是普通白天时段
  assert.equal(inWindow({ from: '09:00', to: '18:00' }, new Date(2026, 0, 1, 12, 0)), true)
  assert.equal(inWindow({ from: '09:00', to: '18:00' }, new Date(2026, 0, 1, 20, 0)), false)
  assert.equal(minutesOfDay(new Date(2026, 0, 1, 1, 30)), 90)
  // 02:00 时距离 23:00 还有 21 小时
  assert.equal(Math.round(msUntilWindow({ from: '23:00', to: '08:00' }, new Date(2026, 0, 1, 2, 0)) / 3600000), 21)
  assert.match(humanDuration(3 * 3600_000 + 65_000), /3小时/)
})
