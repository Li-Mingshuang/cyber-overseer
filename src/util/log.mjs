/**
 * 日志与终端着色。零依赖，输出可被 `--json` 或重定向降级为纯文本。
 * @module cyber-overseer/util/log
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 }

/** 终端是否支持颜色（含 NO_COLOR 约定）。 */
export function supportsColor(stream = process.stdout) {
  if (process.env.NO_COLOR) return false
  if (process.env.FORCE_COLOR) return true
  return Boolean(stream?.isTTY)
}

const CODES = {
  reset: '\u001B[0m', bold: '\u001B[1m', dim: '\u001B[2m',
  red: '\u001B[31m', green: '\u001B[32m', yellow: '\u001B[33m',
  blue: '\u001B[34m', magenta: '\u001B[35m', cyan: '\u001B[36m', gray: '\u001B[90m',
}

/** 创建 logger。 */
export function createLogger(opts = {}) {
  const color = opts.color ?? supportsColor(opts.stream ?? process.stdout)
  const threshold = LEVELS[opts.level ?? process.env.CW_LOG_LEVEL ?? 'info'] ?? LEVELS.info
  const stream = opts.stream ?? process.stdout
  const errStream = opts.errStream ?? process.stderr
  const onLine = typeof opts.onLine === 'function' ? opts.onLine : null

  const paint = (name, text) => (color ? `${CODES[name]}${text}${CODES.reset}` : text)
  const emit = (level, prefix, args) => {
    const line = `${paint('gray', new Date().toLocaleTimeString('zh-CN', { hour12: false }))} ${prefix} ${format(args)}`
    const plain = `${new Date().toISOString()} ${level} ${format(args)}`
    if (level === 'error' || level === 'warn') errStream.write(line + '\n')
    else stream.write(line + '\n')
    onLine?.({ level, text: format(args), plain })
  }

  return {
    level: opts.level ?? 'info',
    enabled: lvl => (LEVELS[lvl] ?? 99) <= threshold,
    error: (...a) => threshold >= LEVELS.error && emit('error', paint('red', '✖'), a),
    warn: (...a) => threshold >= LEVELS.warn && emit('warn', paint('yellow', '▲'), a),
    info: (...a) => threshold >= LEVELS.info && emit('info', paint('cyan', '•'), a),
    ok: (...a) => threshold >= LEVELS.info && emit('info', paint('green', '✔'), a),
    step: (...a) => threshold >= LEVELS.info && emit('info', paint('magenta', '»'), a),
    debug: (...a) => threshold >= LEVELS.debug && emit('debug', paint('gray', '·'), a),
    trace: (...a) => threshold >= LEVELS.trace && emit('trace', paint('gray', '  '), a),
    raw: (text) => { stream.write(String(text) + '\n') },
    banner: (text) => {
      const lines = String(text).split('\n')
      stream.write('\n' + lines.map(l => paint('bold', l)).join('\n') + '\n')
    },
  }
}

function format(args) {
  return args.map(a => {
    if (typeof a === 'string') return a
    if (a instanceof Error) return a.stack ?? a.message
    try { return JSON.stringify(a) } catch { return String(a) }
  }).join(' ')
}

/** 进度行（覆盖同一行），非 TTY 时降级为普通日志。 */
export function createSpinner(logger, text) {
  const tty = Boolean((logger.streamActive ?? process.stdout).isTTY)
  if (!tty) { logger.info(text); return { update: () => {}, stop: () => {} } }
  let current = text
  const render = () => process.stdout.write(`\r\u001B[K${current}`)
  render()
  return {
    update(next, suffix = '') { current = `${next}${suffix}`; render() },
    stop(final) { process.stdout.write(`\r\u001B[K${final ?? current}\n`) },
  }
}
