# AGENTS.md

`dsh-subagent-pin` 是装在包外的 Host 插件，一个包两行：`subagent-pin`
包住 `ctx.subagents` 的 `start` / `startContinuable`，给**没有自己指定路由**的新建
委派补上路由清单里的默认项；`opencode-header` 补在进程传输层上，把每个会话自己的
**派生标识**（原始 id 不出机器）送进 OpenCode Go 要的 `x-opencode-session`。它跑在
Harness 自带的运行时上，随包安装进某个 profile。

本文件只做两件事：**导航**（哪份文件说什么）与**红线索引**（每条约一句 + 权威
位置）。它不复制别处的正文 —— 一次语义变更仍然只动三样：代码、测试、一份人类
说明；决策理由进 `.agents/notes/`（这条纪律的由来见
`.agents/notes/implemented/architecture/2026-09-27-接缝与已排除.md` 的 (c)）。

## 仓库布局

| 路径 | 职责 |
| --- | --- |
| `plugin.js` | 入口：接缝包装（own shadow）、激活自检、通知去重；`reject` 由它抛出 |
| `route-policy.js` | 决定：`pin` / `pass` / `exempt` / `reject`，以及路由清单的解析 |
| `config-schema.js` | 路由那行的配置接口声明（原生 Schemastery 图）；schema 节点表达不了的划界归 `plugin.js` 的 `resolveConfig()` |
| `opencode-header.js` | 会话头那行：传输层接缝（`AsyncLocalStorage` 作用域 + 引用计数）、四键 `Config`、做判断的纯函数与 `deriveSessionValue()` |
| `host-contract.js` | 委派接缝的 Host 形状假设唯一声明处：`SEAM_CONTRACT`、`assertSeam()`、`verifyShadowInstall()` |
| `cordis.patch.yml` | 随包 patch：向 profile insert 两行（`id: subagent-pin`、`id: opencode-header`） |
| `README.md` / `README-en.md` | 人类手册（完整互译）：怎么用、为什么这么用 |
| `CONTEXT.md` | 词表与判据：八个决定/原因词、会话头，以及划界规则 |
| `docs/` | 渐进式披露的深入文档：接缝与 Host 契约、测试与现场核对、OpenCode Go 的会话头（README「深入阅读」指向它们） |
| `.agents/notes/` | 决策记录（为什么这样做、为什么不做）；索引见 `.agents/notes/README.md` |
| `test/` | `node:test` 文件，不启动 Harness；逐文件拆分与总数见 `docs/verification.md` |
| `test-support/host-doubles.mjs` | 真实 Cordis 上的替身 |
| `test-support/manifest-icon.mjs` | `icon` 的判据：DSH 会画成什么样、本包一律画在哪个 viewBox 上（包根与两行共用） |
| `tools/read-session.mjs` | 内部证据读取器：切分拼接的 zstd 帧、按完整 type 选事件 |
| `tools/verify-session.mjs` | `verify` 入口（`exports` 的 `./verify`） |
| `locale/en.json` / `locale/zh.json` | 组合包卡片（整包）的标题与描述（双语） |
| `locale/subagent-pin/{en,zh}.json`、`locale/opencode-header/{en,zh}.json` | 各行自己的标题与描述：DSH 按该行的 `name` 地址读这一份（行名即行地址） |
| `icon.svg` | 组合包卡片（包根 manifest）的 `icon`，画在官方 36×36 viewBox 上 |
| `opencode-header.package.json` / `opencode-header.icon.svg` | `opencode-header` **那一行地址**导出的 manifest 与它声明的图标：DSH 读 `${name}/package.json` 的 `icon`，所以两行的图标不会互相顶掉 |

## 命令

```powershell
npm install                          # 首次；CI 与本地验证用 npm ci
npm test                             # node --test "test/*.test.mjs"
npm run verify -- --lead <会话日志>   # 现场核对：断言那一次运行里每个 child 的路由
```

`npm test` 不需要 Harness、凭据或网络。`verify` 需要一次真实运行的持久化日志，
指标与期望值见 `docs/verification.md`。

## 文档分层与真源

四层，各层只引用、不复述：

1. **人类手册** —— `README.md`（主，中文）与 `README-en.md`（完整互译）是入口，
   `docs/` 放渐进式披露的深入内容（接缝、验证），随包发布；
2. **词表与判据** —— `CONTEXT.md` 是 `pin` / `pass` / `exempt` / `reject` 与
   `named` / `opaque` / `inherited` / `capability` 的唯一定义处；
3. **实现者层** —— 各模块 JSDoc（`route-policy.js`、`config-schema.js`、
   `host-contract.js`、`opencode-header.js` 的文件头）；
4. **决策记录** ——
   `.agents/notes/{implemented,archived}/{process,architecture,feature,simplification}/YYYY-MM-DD-<slug>.md`。

权威归属：某个词的定义在 `CONTEXT.md`；某条**委派接缝**的 Host 形状假设在
`host-contract.js`（会话头那行的形状假设在 `opencode-header.js` 文件头 —— 两条接缝
各声明一次，不互相并入）；某个决定取值的语义在 `route-policy.js`。

## 红线

### 行为承诺

- **决定是值，不是异常。** `route-policy.js` 只返回四种决定；抛出与通知去重归
  `plugin.js`（`CONTEXT.md`「决定」）。
- **路由清单只决定默认项，不是许可证。** 调用方自己指定了 `provider` 或 `model`
  时，在查清单之前就原样放行 —— 连清单读不出来时也一样（`README.md`「策略」）。
- **未指定路由的委派绝不留继承。** 清单不可用时抛错并写明修法，不静默退回父路由。
- **只包 descriptor，不靠函数身份。** `ctx.subagents` 是 tracing proxy，函数值身份
  每次读取都变；包装是 own shadow，安装与撤销都基于 descriptor。
- **Host 形状假设只声明一次。** 委派接缝的在 `host-contract.js`：`fail` 级拒绝激活，
  `warn` 级只点名警告一次；会话头那行的在 `opencode-header.js` 文件头，缺 `ctx.on`
  时只警告并保持传输层不动。
- **冷恢复不是一次委派。** 路由随 child 冻结在 `subagent/descriptor`，插件不复查、
  不改写（`CONTEXT.md`「入口」）。
- **会话头只改该改的请求。** 只有在一个 `llm/stream` 作用域内、方法是 `POST`、且
  provider 前缀或网关域名命中时，才把 `headerName` 写成当前会话 id 的**派生值**
  （SHA-256 前 16 字节的 v4 UUID 形状；纯函数，不落任何存储）；其余请求原样透传，
  判断失败也透传（`opencode-header.js` 文件头、README「OpenCode Go 的会话头」）。
- **值不跟着上游走。** pi-ai 在场的那条路（catalog 工厂 wrapper）够不到手写 `api:` 的路由、
  发的是原始 id，Responses 那条连开关都没有；本行自己在传输层写派生值，不把承诺寄望于上游的
  可配置项（`opencode-header.js` 文件头、`.agents/notes/implemented/architecture/2026-09-29-升级了也不跟着走.md`）。

### 已排除（完整推理在 `2026-09-27-接缝与已排除.md` 的 (b)）

- 不用 `@deepseek-ai/dsh-invariants` 表达这份契约。
- `ctx.effect` 的返回值形态与卸载顺序不写进契约。
- 插件不按路由校验 `reasoningEffort`（`CONTEXT.md`「已排除」，另见
  `2026-09-27-强度不是插件的承诺.md`）。

### 文档与验证纪律

- 改了 `README.md` / `README-en.md` / `CONTEXT.md` 就必须跑 `npm test`；文档守卫
  （`test/docs.test.mjs`）会断言：
  - 两份 README 的 `config:` 段写的每个键都是**该块自己那行**的 schema 声明过的
    （块里的 `name:` 决定认哪一份，认不出就退回两份的并集）；
  - `route-policy.js` 产出的每个决定词都是 `CONTEXT.md` 定义过的；
  - 散文点名的仓库路径与相对链接都真实存在，且落在 `package.json` 的 `files` 里；
  - 两份 README 的 `## ` 章节数量与顺序一致。
  它自己带一组坏基线（改坏的真实文档必须报出来、空文档必须说没得可查），改那些判断
  函数时要一起看 —— 判断函数收文本、返回 findings，就是为了这个。
- 动了 `files` / `exports` 就同时跑 `test/package.test.mjs`：它反向要求每个
  `files` 条目仍匹配仓库里的东西、每个可导入子路径都被 `files` 覆盖。
- 动了 `files` 也跑 `test/tarball.test.mjs`：它拿真实 packlist（`npm pack --dry-run
  --json`）与 `files` 对拍，断言承诺的每个路径都在包里。那一面手写匹配器看不到，
  而打包产物才是装进 profile 的东西；它是唯一要动用 npm 的一项，仍不联网。
- 改了本文件或 `.agents/notes/` 下的文档就跑 `test/maintainer-docs.test.mjs`：
  它把每条相对链接**从文档自己所在目录**解析（笔记索引指向各条记录用的就是这种），
  再断言引用都仍然存在。它看不到的边界写在那个文件头部。
- 本文件进 `files`：README 的散文点名了它，而文档守卫要求被点名的仓库路径随包。
- 测试数量写在 `docs/verification.md` 的那一句里；增删测试时同步它。
- 现场核对的生产证据**无法自动化**：`verify` 验的是"那一次"运行，不是"现在"
  （理由见 `2026-09-27-现场核对的自动化边界.md`）。
- 动了 `host-contract.js` 或升级 Harness 后，先跑 `test/host-contract.test.mjs`
  （对着锁死的 Host 库断言），再按 `docs/verification.md` 的核对表现场核对。
- 只有一条链**纯靠人工同步**，没有任何测试会因它落后而变红：改了
  `host-contract.js` 的形状假设清单（增删一项、改 level）→ `docs/verification.md`
  里讲这份清单、锁死的三个包版本与 `config-schema.js` 的 `THINKING_LEVELS` 耦合的
  部分要跟着改。随包配置那一条已有守卫：`test/patch.test.mjs` 钉死
  `cordis.patch.yml` 两行的 id、`name` 与 config 取值（并逐行对着它自己那份 schema
  校验），`test/docs.test.mjs` 钉 README 示例写出的每个键都被对应 schema 声明；
  没人管的只剩示例键的**覆盖面**（schema 增键而示例没写不变红，
  守卫是单向的）与示例里的注释措辞。
