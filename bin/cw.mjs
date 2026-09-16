#!/usr/bin/env node
/**
 * `cw` / `cyber-overseer` 可执行入口。
 *
 * 除了转发给 CLI，这里还负责一件重要的事：把中断信号（Ctrl+C）转成"优雅收尾"——
 * 无人值守的工具最怕被 Ctrl+C 打断后既不落盘也不写报告，所以这里把它变成
 * "停止当前等待 + 走正常收尾流程"。
 *
 * @module cyber-overseer/bin
 */

import { main } from '../src/cli.mjs'

const controller = new AbortController()
let interrupted = false

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (interrupted) {
      process.stderr.write('\n再次收到中断信号，立即退出。\n')
      process.exit(130)
    }
    interrupted = true
    process.stderr.write('\n收到中断信号：正在收尾（写状态与报告）… 再按一次 Ctrl+C 立即退出。\n')
    controller.abort(new Error('用户中断'))
  })
}

try {
  const code = await main(process.argv.slice(2))
  process.exit(typeof code === 'number' ? code : 0)
} catch (error) {
  if (interrupted) {
    process.stderr.write(`已中断：${error?.message ?? error}\n`)
    process.exit(130)
  }
  process.stderr.write(`cyber-overseer 出错：${error?.stack ?? error}\n`)
  process.exit(1)
}
