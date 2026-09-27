# AGENTS.md

`@local/dsh-subagent-pin` 是装在包外的一行 Host 插件：它包住 `ctx.subagents` 的
`start` / `startContinuable`，给**没有自己指定路由**的新建委派补上路由清单里的
默认项。它跑在 Harness 自带的运行时上，随包安装进某个 profile。

本文件只做两件事：**导航**（哪份文件说什么）与**红线索引**（每条约一句 + 权威
位置）。它不复制别处的正文 —— 一次语义变更仍然只动三样：代码、测试、一份人类
说明；决策理由进 `.agents/notes/`（这条纪律的由来见
`.agents/notes/implemented/architecture/2026-09-27-接缝与已排除.md` 的 (c)）。

## 仓库布局

| 路径 | 职责 |
| --- | --- |
| `plugin.js` | 入口：接缝包装（own shadow）、激活自检、通知去重；`reject` 由它抛出 |
| `route-policy.js` | 决定：`pin` / `pass` / `exempt` / `reject`，以及路由清单的解析 |
| `config-schema.js` | 配置接口的机器可读声明（原生 Schemastery 图）；schema 节点表达不了的划界归 `plugin.js` 的 `resolveConfig()` |
| `host-contract.js` | Host 形状假设的唯一声明处：`SEAM_CONTRACT`、`assertSeam()`、`verifyShadowInstall()` |
| `cordis.patch.yml` | 随包 patch：向 profile insert 一行（`id: subagent-pin`） |
| `README.md` / `README-en.md` | 人类手册（完整互译）：怎么用、为什么这么用 |
| `CONTEXT.md` | 词表与判据：八个决定/原因词，以及划界规则 |
| `.agents/notes/` | 决策记录（为什么这样做、为什么不做）；索引见 `.agents/notes/README.md` |
| `test/` | `node:test` 文件，不启动 Harness；逐文件拆分与总数见 `README.md`「已验证」 |
| `test-support/host-doubles.mjs` | 真实 Cordis 上的替身 |
| `tools/read-session.mjs` | 内部证据读取器：切分拼接的 zstd 帧、按完整 type 选事件 |
| `tools/verify-session.mjs` | `verify` 入口（`exports` 的 `./verify`） |
| `locale/en.json` / `locale/zh.json` | 插件行的标题与描述（双语） |
| `icon.svg` | manifest 顶层 `icon`，画在官方 36×36 viewBox 上 |

## 命令

```powershell
npm install                          # 首次；CI 与本地验证用 npm ci
npm test                             # node --test "test/*.test.mjs"
npm run verify -- --lead <会话日志>   # 现场核对：断言那一次运行里每个 child 的路由
```

`npm test` 不需要 Harness、凭据或网络。`verify` 需要一次真实运行的持久化日志，
指标与期望值见 `README.md` 的「已验证」。

## 文档分层与真源

四层，各层只引用、不复述：

1. **人类手册** —— `README.md`（主，中文）与 `README-en.md`（完整互译），随包发布；
2. **词表与判据** —— `CONTEXT.md` 是 `pin` / `pass` / `exempt` / `reject` 与
   `named` / `opaque` / `inherited` / `capability` 的唯一定义处；
3. **实现者层** —— 各模块 JSDoc（`route-policy.js`、`config-schema.js`、
   `host-contract.js` 的文件头）；
4. **决策记录** ——
   `.agents/notes/{implemented,archived}/{process,architecture,feature,simplification}/YYYY-MM-DD-<slug>.md`。

权威归属：某个词的定义在 `CONTEXT.md`；某条 Host 形状假设在 `host-contract.js`；
某个决定取值的语义在 `route-policy.js`。

## 红线

### 行为承诺

- **决定是值，不是异常。** `route-policy.js` 只返回四种决定；抛出与通知去重归
  `plugin.js`（`CONTEXT.md`「决定」）。
- **路由清单只决定默认项，不是许可证。** 调用方自己指定了 `provider` 或 `model`
  时，在查清单之前就原样放行 —— 连清单读不出来时也一样（`README.md`「策略」）。
- **未指定路由的委派绝不留继承。** 清单不可用时抛错并写明修法，不静默退回父路由。
- **只包 descriptor，不靠函数身份。** `ctx.subagents` 是 tracing proxy，函数值身份
  每次读取都变；包装是 own shadow，安装与撤销都基于 descriptor。
- **Host 形状假设只声明一次。** 在 `host-contract.js`：`fail` 级拒绝激活，`warn` 级
  只点名警告一次。
- **冷恢复不是一次委派。** 路由随 child 冻结在 `subagent/descriptor`，插件不复查、
  不改写（`CONTEXT.md`「入口」）。

### 已排除（完整推理在 `2026-09-27-接缝与已排除.md` 的 (b)）

- 不用 `@deepseek-ai/dsh-invariants` 表达这份契约。
- `ctx.effect` 的返回值形态与卸载顺序不写进契约。
- 插件不按路由校验 `reasoningEffort`（`CONTEXT.md`「已排除」，另见
  `2026-09-27-强度不是插件的承诺.md`）。

### 文档与验证纪律

- 改了 `README.md` / `README-en.md` / `CONTEXT.md` 就必须跑 `npm test`；文档守卫
  （`test/docs.test.mjs`，5 项）会断言：
  - 两份 README 的 `config:` 段写的每个键都是 `config-schema.js` 声明过的；
  - `route-policy.js` 产出的每个决定词都是 `CONTEXT.md` 定义过的；
  - 散文点名的仓库路径与相对链接都真实存在，且落在 `package.json` 的 `files` 里；
  - 两份 README 的 `## ` 章节数量与顺序一致。
- 动了 `files` / `exports` 就同时跑 `test/package.test.mjs`（5 项）：它反向要求每个
  `files` 条目仍匹配仓库里的东西、每个可导入子路径都被 `files` 覆盖。
- 改了本文件或 `.agents/notes/` 下的文档就跑 `test/maintainer-docs.test.mjs`（3 项）：
  它把每条相对链接**从文档自己所在目录**解析（笔记索引指向各条记录用的就是这种），
  再断言引用都仍然存在。它看不到的边界写在那个文件头部。
- 本文件进 `files`：README 的散文点名了它，而文档守卫要求被点名的仓库路径随包。
- 测试数量写在 `README.md`「已验证」那一句里；增删测试时同步它。
- 现场核对的生产证据**无法自动化**：`verify` 验的是"那一次"运行，不是"现在"
  （理由见 `2026-09-27-现场核对的自动化边界.md`）。
- 动了 `host-contract.js` 或升级 Harness 后，先跑 `test/host-contract.test.mjs`
  （对着锁死的 Host 库断言），再按 `README.md`「已验证」表现场核对。
