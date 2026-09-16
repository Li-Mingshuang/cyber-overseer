# DSH 的 SDK JSON-RPC profile（`jrpc`）

这份模板让 DSH 起一个 **stdio JSON-RPC 2.0** 服务端（插件包
`@deepseek-ai/dsh-sdk-jsonrpc-server`），赛博监工用 `dsh-jsonrpc` 适配器接它：

- **注入**：`session/prompt` —— 服务端内部就是 `agent.followup`，等于"把下一句话塞进信箱"；
- **观测**：`session.event` / `session.status` 逐条推事件，能还原忙/闲与最后一次回答；
- **零侵入**：独立进程、全新会话，完全不碰你正在用的会话。

为什么需要自建 profile：产品 CLI 的 `web` / `headless` profile 都没有挂这个插件包
（细节见 `docs/recon/dsh-control-surfaces.md` §4.6）。

## 一键安装（推荐）

```bash
cw dsh-profile --install --sdk-path <deepseek-harness>/packages/sdk/server
cw dsh-profile            # 体检：还差什么会说清楚
```

它只写三件事，**已存在的文件一律不覆盖**（除非 `--force`）：

| 文件 | 作用 |
|---|---|
| `package.json` | profile 清单：`dsh.profile.bundles = ['@deepseek-ai/dsh-base']`（形状与 DSH 的 `initProfile` 一致） |
| `cordis.patch.yml` | 用户补丁层：`insert` 一个 `sdk-jsonrpc-server` |
| `pnpm-workspace.yaml` | `nodeLinker: hoisted` / `autoInstallPeers: false`（out-of-tree 插件要能解析到 peer） |

再自动把插件包软链到 `<DSH_HOME>/profiles/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-server`
（Windows 用 junction，**不需要管理员**）。DSH 只会把"安装包依赖闭包"里的包软链过去，
而这个 SDK 服务端不在其中，所以这一步不能省。

## 手动安装

```bash
DSH_HOME=${DSH_HOME:-~/.dsh}
mkdir -p "$DSH_HOME/profiles/jrpc"
cp package.json cordis.patch.yml pnpm-workspace.yaml "$DSH_HOME/profiles/jrpc/"
mkdir -p "$DSH_HOME/profiles/node_modules/@deepseek-ai"
ln -s /path/to/deepseek-harness/packages/sdk/server \
      "$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-server"
```

Windows（不需要管理员）：

```powershell
New-Item -ItemType Junction -Path "$env:DSH_HOME\profiles\node_modules\@deepseek-ai\dsh-sdk-jsonrpc-server" `
         -Target 'C:\path\to\deepseek-harness\packages\sdk\server'
```

## 用法

```js
// cw.config.mjs
export default {
  agent: {
    adapter: 'dsh-jsonrpc',
    options: {
      profile: 'jrpc',
      workspace: 'C:/path/to/被监工的项目',   // DSH 的工作目录
      // dshHome: 'C:/Users/you/.dsh',
      // dshEntry: 'C:/path/to/deepseek-harness/apps/cli/lib/bin.js',
    },
  },
}
```

然后 `cw watch`（演练） → `cw run`（真抽）。需要 `DEEPSEEK_API_KEY`。

## 三个必须知道的协议事实

1. **必须等 `initialize` 的响应再发 `session/prompt`**：DSH 对同一批到达的帧是
   `void handleLine(line)` **并发**处理的，抢跑会撞上"用了默认模型"的 400。
   本仓库的客户端所有请求都带 id 且等响应，天然满足（`fixtures/fake-dsh-jsonrpc.mjs`
   里把 initialize 的响应延迟 60ms，专门用来钉死这一点）。
2. **没有 resume**：`session/prompt` 里给一个不存在的 `sessionId` 会**新建**会话，
   不会载入历史。所以"记忆"靠工作区与提示词，和 headless 一样。
3. **没有 cancel / close**：放弃只能杀进程；stdout 被协议独占，profile 组合里
   **不能**有 stdout logger（日志要走 stderr）。

## 相关

- 协议实测记录：`docs/recon/dsh-control-surfaces.md` §4.6、§5③
- 适配器：`src/adapters/dsh-jsonrpc.mjs`
- profile 生成/体检：`src/dsh-profile.mjs`、`cw dsh-profile`
