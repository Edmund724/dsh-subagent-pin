# OpenCode Go 的会话头

本文是 README「深入阅读」的展开：`opencode-session` 这一行为什么长在传输层、
作用域怎么划、值从哪来、配置四个键各管什么、以及怎么核对它真的生效。
为什么落点只能在这里（逐个排除的选项）见
[`.agents/notes/implemented/architecture/2026-09-28-请求头只能落在传输层.md`](../.agents/notes/implemented/architecture/2026-09-28-请求头只能落在传输层.md)；
实现的不变量写在 `opencode-session.js` 的文件头。

## 它解决什么

OpenCode Go 从 2026-09-15 起要求每个推理请求带 `x-opencode-session`，值是**这次会话
自己的** id。在此之前，本环境把这条头写死在路由配置里 —— 全机器一个值：所有会话、
所有子代理共用同一个 id，网关按会话计费、限流与配额的那套语义就无从谈起。

本行把静态头换成当前会话的 id。顶层会话的 id 形如
`session-3f1c…`，子代理与 ACP 子是裸 UUID；两者网关都接受（现场核对过）。

## 作用域：只有这些请求会变

一次请求被改写，必须同时满足：它在一次 `llm/stream` 的作用域里、它是 `POST`、
且它的 provider id 以某个配置前缀开头**或**它落到的域名是配置的网关域名。
三条同时成立才动，其余一律原样透传 —— 包括 gateway 自身的 `GET {baseURL}/models`
发现请求、别的 provider 的所有流量、web fetch 与 MCP。

两个匹配是「或」的关系，因为 provider id 与它实际落到的域名是两件独立的事实：
手写路由可能两者只对上一个。默认只认 `opencode` 前缀与 `opencode.ai`（含子域，
`opencode.ai.evil.test` 不算）。

## 值：当前会话的 id

值就是 `GenerateOptions.sessionId`，也就是会话头里那份 `id`：它随会话持久化，
跨轮次、resume、compaction、自动重试都稳定，同一个会话内每个请求拿到同一个值，
不同会话拿到不同的值。子代理走的是同一个机制，只是它自己的 id 形状不同。

触发 `llm/stream` 的辅助调用（例如会话标题）与正文请求共享同一个作用域，因此也带上
同一个 id —— 少了这条，辅助调用会先被网关挡下来。

## 配置

随包不带 `config`：schema 默认值就是安装形态。四个键都可选：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 关掉就一行代码都不碰传输层 |
| `headerName` | `x-opencode-session` | 要带的头名；值永远是当前会话 id |
| `providers` | `['opencode']` | 按 **provider id 前缀**认领，例如 `opencode` 覆盖 `opencodego`；空列表表示这一维不认领 |
| `hosts` | `['opencode.ai']` | 按域名（本身或子域）认领；空列表表示这一维不认领 |

两个列表都为空时这行是惰性的。

## 与静态头的关系

落到线上的值是本行写的那个：路由里若已经有同名的静态头，它会被**替换**掉。
所以路由配置里那条 `headers: { x-opencode-session: … }` 应该删掉 —— 留着不会报错，
但它只在这行被禁用时生效，等于给排障留一个假象。

## 失效与代价

- 补的是 `globalThis.fetch`。作用域不在、方法不是 POST、两个匹配都不中，全部原样
  透传；判不出来（例如 session id 含非法字符）也透传，**不让一个坏 id 把健康的模型
  调用变成硬失败**。传输层自己的异常照常抛出，不被吞掉。
- Host 没有 `ctx.on`（或加载器拒绝这一行）时只警告一次并保持传输层不动，绝不因为本
  行让 Host 起不来。
- 卸载（禁用 bundle / 移除插件）会还原传输层：多个 profile 同时挂载时按引用计数，
  最后一个卸载的负责还原。

## 怎么核对

单元测试覆盖全部三条 gate、同名头替换、失败透传与并发隔离
（`test/opencode-session.test.mjs`）。桌面运行时那一半无法自动化，做法与期望值见
[测试与现场核对](verification.md) 的那张表：改配置或升级 Harness 后，照表里的
「OpenCode Go 会话头」两行走一遍。
