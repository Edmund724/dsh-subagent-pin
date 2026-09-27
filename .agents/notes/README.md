# 决策记录

本目录收**决策理由**：「为什么这样做」与「为什么不做」。它不复述代码，也不重复
`README.md` 的内容 —— 一段理由若在代码里有唯一实现、README 已解释，这里只留决策
本身、当时排除的选项、以及支撑结论的核实位置。

读者是未来的维护者与评审。使用者的手册在 `README.md` / `README-en.md`，词汇与
判据在 `CONTEXT.md`。

## 目录与命名

- `implemented/` —— 当前仍然生效的决策；
- `archived/` —— 被后续决定取代的历史；
- 四类子目录：`process/`（流程与验证纪律）、`architecture/`（接缝与结构）、
  `feature/`（功能语义）、`simplification/`（简化与删除）；
- 文件名 `YYYY-MM-DD-<slug>.md`，**日期即决策日**。

**状态由所在的目录承担**，不在正文里再写 `Status:` 字段：两处状态就是第二个真源。
判断归哪一边只看一件事 —— 这份笔记描述的还是不是现在这份代码；只要没有任何后续
决定取代它，就留在 `implemented/`。

## 什么时候写在这里

一次语义变更的目标是**只动三样**：代码、测试、一份人类说明。所以这里收的只有
「为什么」，且它不随之成为第四处需要同步的文档：

- 被排除的方案与代价 → 这里（`CONTEXT.md` 的「已排除」只留标题与一句摘要）；
- 某个词的定义、某条划界判据 → `CONTEXT.md`；
- 怎么用、为什么这么用 → `README.md` / `README-en.md`；
- 某个模块的形状假设与不变量的实现理由 → 该模块的文件头 JSDoc。

## 索引

| 文件 | 主题 |
| --- | --- |
| [implemented/architecture/2026-09-27-接缝与已排除.md](implemented/architecture/2026-09-27-接缝与已排除.md) | 接缝为什么只能落在 `ctx.subagents` 的 `start` / `startContinuable` 实例方法上（六条逐项核实）；两条已排除方案的完整推理；2026-09-27 的文档分区决定 |
| [implemented/architecture/2026-09-27-强度不是插件的承诺.md](implemented/architecture/2026-09-27-强度不是插件的承诺.md) | 配置面为什么只收 Host 的七个 thinking level；为什么插件不按路由校验 `reasoningEffort`（DSH 自己的三层：配置面只认词汇、描述面取不到就当没有、请求面拒绝并点名） |
| [implemented/process/2026-09-27-现场核对的自动化边界.md](implemented/process/2026-09-27-现场核对的自动化边界.md) | 现场核对表怎么拆成两半：生产证据无法自动化，读日志那一半变成 `npm run verify`；期望值为什么只来自那次运行自己的日志 |

## 从 implemented 迁到 archived

触发条件是「有后续决定取代了它」，而不是时间过去多久。做法：把新的一份写进
`implemented/`，把被取代的那份移到 `archived/`，并让两份互相指到对方 —— 新的一份
在开头写明取代了谁，旧的那份在开头写明被谁取代。本文件上表的链接要一起改。

## 本目录随包发布

`.agents/notes/**` 在 `package.json` 的 `files` 里：`README.md` 的散文点名了
`.agents/notes` 这个路径，而 `test/docs.test.mjs` 的守卫要求被点名的仓库路径落在
`files` 里。结果就是打包产物上 `npm install && npm test` 能跑出与仓库一致的
108 项。这里写下的理由因此也是随包发行物的一部分。
