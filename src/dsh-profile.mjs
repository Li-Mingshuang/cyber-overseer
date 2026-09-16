/**
 * DSH 的 SDK JSON-RPC profile（`--profile jrpc`）的模板与安装。
 *
 * 背景（见 `docs/recon/dsh-control-surfaces.md` §4.6）：DSH 自带一个 stdio 上的
 * JSON-RPC 2.0 服务端（插件包 `@deepseek-ai/dsh-sdk-jsonrpc-server`），它同时提供
 * **注入**（`session/prompt`）与**观测**（`session.event` 流）——是"可控自律进程"的最佳通道。
 * 但产品 CLI 的 web/headless profile 都没挂它，所以要自建一个 profile。
 *
 * 这里的东西都是**照着 DSH 自己的实现**写的（`packages/boot/app-boot/src/profile.ts`）：
 *  - profile 清单：`<DSH_HOME>/profiles/<name>/package.json`，
 *    形状是 `{ private:true, dependencies:{}, dsh:{ profile:{ bundles:[...] } } }`；
 *  - 用户 patch 层：`<DSH_HOME>/profiles/<name>/cordis.patch.yml`（顶层 YAML 数组）；
 *  - 另外要写 `pnpm-workspace.yaml`（hoisted linker），否则 profile 里的插件解析不到 peer；
 *  - 插件包必须能从 profile 解析到：DSH 只把**安装包依赖闭包**里的包软链到
 *    `profiles/node_modules`，而 `@deepseek-ai/dsh-sdk-jsonrpc-server` 不在其中，
 *    所以要自己做一个软链（Windows 上用 junction，不需要管理员权限）。
 *
 * 设计约束：**只写自己该写的文件**——已存在的文件永不覆盖（除非显式 `force`），
 * 已存在且不是软链的目录永不删除。
 *
 * @module cyber-overseer/dsh-profile
 */

import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** 插件包名（DSH 自己的 package.json 里就是这个）。 */
export const SDK_PACKAGE = '@deepseek-ai/dsh-sdk-jsonrpc-server'
/** 默认 profile 名（`dsh --profile jrpc`）。 */
export const DEFAULT_PROFILE = 'jrpc'
/** dsh-base 是所有 profile 的底座。 */
export const BASE_BUNDLE = '@deepseek-ai/dsh-base'
/** profile 目录里的固定文件名（与 DSH 的实现一致）。 */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'
export const PROFILE_WORKSPACE_FILENAME = 'pnpm-workspace.yaml'

/** DSH 家目录：显式给 → 环境变量 → `~/.dsh`。 */
export function resolveDshHome(explicit) {
  return resolve(explicit ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
}

/** profile 目录。 */
export function profileDir(home, profile = DEFAULT_PROFILE) {
  return join(resolveDshHome(home), 'profiles', profile)
}

/** 生成 profile 清单（形状与 DSH 的 `initProfile` 一致）。 */
export function profileManifest(profile = DEFAULT_PROFILE, bundles = [BASE_BUNDLE]) {
  return {
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...bundles] } },
  }
}

/** 生成用户 patch 层：在 bundle 之上插入 JSON-RPC 服务端。 */
export function profilePatchYaml() {
  return [
    '# 赛博监工的 SDK JSON-RPC profile 补丁层（在 dsh-base 之上插入 stdio JSON-RPC 服务端）。',
    '# 用法：dsh --profile jrpc —— stdin/stdout 就是协议通道，组合里不要再挂 stdout logger。',
    '- insert:',
    '    - id: sdk-jsonrpc-server',
    `      name: '${SDK_PACKAGE}'`,
    '',
  ].join('\n')
}

/** 生成 pnpm 设置（DSH 的 initProfile 也写这个：out-of-tree 插件需要 hoisted linker）。 */
export function profileWorkspaceYaml() {
  return ['packages:', '  - .', '', 'nodeLinker: hoisted', 'autoInstallPeers: false', ''].join('\n')
}

/** 模板文件清单（`cw dsh-profile --install` 会写这些）。 */
export function profileTemplateFiles(profile = DEFAULT_PROFILE) {
  return [
    { file: 'package.json', content: JSON.stringify(profileManifest(profile), null, 2) + '\n' },
    { file: PROFILE_PATCH_FILENAME, content: profilePatchYaml() },
    { file: PROFILE_WORKSPACE_FILENAME, content: profileWorkspaceYaml() },
  ]
}

/** 软链该放的位置（DSH 的 `profiles/node_modules` 回退目录）。 */
export function sdkLinkPath(home) {
  return join(resolveDshHome(home), 'profiles', 'node_modules', ...SDK_PACKAGE.split('/'))
}

/**
 * 猜 DSH 的 checkout 位置（用来找 `packages/sdk/server`）。
 * @param {{cwd?:string, env?:Record<string,string|undefined>}} [opts]
 */
export function findSdkPackage(opts = {}) {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  const guesses = [
    env.CW_DSH_SDK_PATH,
    env.DSH_CHECKOUT ? join(env.DSH_CHECKOUT, 'packages', 'sdk', 'server') : null,
    join(cwd, '..', 'deepseek-harness', 'packages', 'sdk', 'server'),
    'C:\\myFiles\\codes\\github\\deepseek-harness\\packages\\sdk\\server',
    join(homedir(), 'deepseek-harness', 'packages', 'sdk', 'server'),
  ].filter(Boolean)
  for (const guess of guesses) {
    if (existsSync(guess)) return resolve(guess)
  }
  return null
}

/**
 * 检查 profile 是否就绪（`cw dsh-profile` / 适配器 probe 共用）。
 * @param {{home?:string, profile?:string, fs?:any}} [opts]
 */
export function inspectProfile(opts = {}) {
  const fs = { existsSync, readFileSync, lstatSync, readlinkSync, ...(opts.fs ?? {}) }
  const home = resolveDshHome(opts.home)
  const profile = opts.profile ?? DEFAULT_PROFILE
  const dir = profileDir(home, profile)
  const manifestPath = join(dir, 'package.json')
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  const files = {
    manifest: fs.existsSync(manifestPath),
    patch: fs.existsSync(patchPath),
  }
  let patchMentionsServer = false
  try {
    patchMentionsServer = fs.existsSync(patchPath) && String(fs.readFileSync(patchPath, 'utf8')).includes(SDK_PACKAGE)
  } catch { /* 读不动就当没有 */ }

  const link = sdkLinkPath(home)
  let linkTarget = null
  try {
    if (fs.lstatSync(link).isSymbolicLink()) linkTarget = fs.readlinkSync(link)
  } catch { /* 不存在或不是软链 */ }
  // 软链之外，也接受"该包在 profiles/node_modules 里真实存在"（例如 pnpm 装进去的）
  const resolvable = Boolean(linkTarget) || fs.existsSync(join(link, 'package.json'))
  const loose = !linkTarget && !resolvable && fs.existsSync(link) ? 'exists-but-not-symlink' : undefined

  const hints = []
  if (!files.manifest || !files.patch) {
    hints.push(`profile 还没建：cw dsh-profile --install --profile ${profile} --dsh-home "${home}"`)
  } else if (!patchMentionsServer) {
    hints.push(`patch 里没有 ${SDK_PACKAGE}：把 templates/dsh-profile-jrpc/${PROFILE_PATCH_FILENAME} 的内容合并进 ${patchPath}`)
  }
  if (!resolvable) {
    hints.push(`插件包解析不到，需要把 checkout 里的 packages/sdk/server 软链到：${link}`)
    hints.push('安装命令（不需要管理员）：cw dsh-profile --install --sdk-path <deepseek-harness>/packages/sdk/server')
  }
  if (loose === 'exists-but-not-symlink') {
    hints.push(`${link} 已存在且不是软链：监工**不会**动它，请你自行确认它是不是正确的包`)
  }

  return {
    home, profile, dir, link, linkTarget, resolvable,
    files, patchMentionsServer,
    ok: files.manifest && files.patch && patchMentionsServer && resolvable,
    hints,
  }
}

/**
 * 安装（或修复）profile。已存在的文件不覆盖；软链只会在"不存在"或"指向别处"时更新。
 * @param {{home?:string, profile?:string, force?:boolean, sdkPath?:string|null, cwd?:string,
 *   env?:any, fs?:any, win?:boolean}} [opts]
 * @returns {{ok:boolean, home:string, profile:string, dir:string, link:string, created:string[],
 *   skipped:string[], linked:string|null, warnings:string[], hints:string[]}}
 */
export function installProfile(opts = {}) {
  const fs = {
    existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync,
    ...(opts.fs ?? {}),
  }
  const home = resolveDshHome(opts.home)
  const profile = opts.profile ?? DEFAULT_PROFILE
  const force = opts.force === true
  const dir = profileDir(home, profile)
  const created = []
  const skipped = []
  const warnings = []

  fs.mkdirSync(dir, { recursive: true })
  for (const entry of profileTemplateFiles(profile)) {
    const target = join(dir, entry.file)
    if (fs.existsSync(target) && !force) { skipped.push(entry.file); continue }
    fs.writeFileSync(target, entry.content, 'utf8')
    created.push(entry.file)
  }

  let linked = null
  const sdkPath = opts.sdkPath === undefined ? findSdkPackage({ cwd: opts.cwd, env: opts.env }) : opts.sdkPath
  if (sdkPath) {
    const link = sdkLinkPath(home)
    fs.mkdirSync(dirname(link), { recursive: true })
    let action = 'created'
    let skipLink = false
    try {
      const stat = fs.lstatSync(link)
      if (stat.isSymbolicLink()) {
        const current = fs.readlinkSync(link)
        if (resolve(String(current)) === resolve(sdkPath)) skipLink = true
        else { fs.unlinkSync(link); action = 'replaced' }
      } else {
        warnings.push(`${link} 已存在且不是软链：监工不会删别人的东西，请自行处理`)
        skipLink = true
      }
    } catch { /* 不存在 → 新建 */ }
    if (!skipLink) {
      try {
        // Windows 上用 junction：不需要管理员权限，且能被 Node 正常解析
        fs.symlinkSync(resolve(sdkPath), link, opts.win === false ? 'dir' : 'junction')
        linked = `${action} → ${resolve(sdkPath)}`
      } catch (error) {
        warnings.push(`软链创建失败（${error?.code ?? ''} ${error?.message ?? error}）：请手动把 ${resolve(sdkPath)} 链到 ${link}`)
      }
    }
  } else {
    warnings.push('没找到 DSH 的 packages/sdk/server：用 --sdk-path 指定，或手动做软链')
  }

  const status = inspectProfile({ home, profile, fs })
  return {
    ok: status.ok, home, profile, dir, link: status.link,
    created, skipped, linked, warnings, hints: status.hints,
  }
}

/** 一行话描述适配器该怎么指向这个 profile。 */
export function profileRunHint(home, profile = DEFAULT_PROFILE) {
  return `cw run --adapter dsh-jsonrpc   （DSH_HOME=${resolveDshHome(home)}，profile=${profile}）`
}
