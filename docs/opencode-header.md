# OpenCode Go 的会话头

本文是 README「深入阅读」的展开：`opencode-header` 这一行为什么长在传输层、
作用域怎么划、值怎么来、配置四个键各管什么、以及怎么核对它真的生效。
为什么落点只能在这里（逐个排除的选项）、值为什么取派生而不是原始 id，见
[`.agents/notes/implemented/architecture/2026-09-28-请求头只能落在传输层.md`](../.agents/notes/implemented/architecture/2026-09-28-请求头只能落在传输层.md)；
实现的不变量写在 `opencode-header.js` 的文件头。

## 它解决什么

OpenCode Go 从 2026-09-15 起要求每个推理请求带 `x-opencode-session`，值是**这次会话
自己的**标识。在此之前，本环境把这条头写死在路由配置里 —— 全机器一个值：所有会话、
所有子代理共用同一个 id，网关按会话计费、限流与配额的那套语义就无从谈起。

本行把静态头换成当前会话 id 的**派生值**：同一个会话恒定、不同会话不碰撞，而本地 id
不出机器。上游 pi-ai 从 0.86.0 起也带同类逻辑，DSH 从 0.2.0-rc.2 起随包（pi-ai
`^0.87.1`）—— 但那条路只对 catalog 路由生效，且发的是原始 id，所以本行一条都省不掉：
完整推理见[为什么升级了也不跟着走](../.agents/notes/implemented/architecture/2026-09-29-升级了也不跟着走.md)。

## pi-ai 自己会不会带这个头

会被问到的是「模型在 catalog 里，是不是就自动带头、不需要这一行了」。三条路都要看：

| pi-ai 的会话头路径 | 触发条件 | 头名 | 值 | 今天成立吗 |
|---|---|---|---|---|
| catalog 工厂 wrapper `withOpenCodeSessionHeader`（0.86.0 起） | 路由**复用 catalog provider**（不写 `api:`） | `x-opencode-session` | **原始** `options.sessionId` | 会发头，但进不去：本环境路由手写了 `api:`，走协议表现场构造 provider，不复用 catalog provider |
| 按模型 `compat.sendSessionAffinityHeaders`（0.85.1 起就有） | 该模型把这个开关打开 | `x-session-affinity`；OpenAI 形状是 `x-client-request-id` + `x-session-affinity`，其中 openai 再加 `session_id`、openrouter 换 `x-session-id` | **原始** `sessionId` | 不成立：头名不是网关要的这个，opencode-go 的 catalog 里没有一个模型开这个开关，本环境这条手写路由也没有 `compat` |
| OpenAI Responses 的 `sessionAffinityFormat` | 模型讲 Responses 协议、且 `sessionId` 在、cache retention 不是 `none` | `session_id` + `x-client-request-id`（`openai-nosession` 只发后者） | **原始** `sessionId` | 不成立，而且**没有开关可关**：这条路不看任何 `compat` 布尔量 |
| 其余情况 | — | 不发任何会话头 | — | 今天的实装状态 |

所以「进了 catalog 就会自动带头」不成立；三条真会发头的路，发出去的都是**原始 id**。
本行承诺两件事 —— 头名是网关要的那个、值是派生值（原始 id 不出机器）—— 没有任何一条
pi-ai 路径能同时满足，这就是它不构成替代的原因。

今天的位置都在随包 Host 的 `dsh/node_modules/@earendil-works/pi-ai@0.87.1` 里读到
（rc.1 随包的还是 0.85.1，那时 `opencode-headers.js` 还不存在）：
`dist/providers/opencode-headers.js`（`withOpenCodeSessionHeader` 全文，同名头已存在时
跳过）、`dist/providers/opencode-go.js` 与 `dist/providers/opencode.js`（wrapper 只包在
工厂造出的 api map 上）、`dist/api/anthropic-messages.js`（`sendSessionAffinityHeaders`
默认 `false`）、`dist/api/openai-completions.js`（默认 `isOpenRouter`）、
`dist/api/openai-responses.js`（`if (sessionId)`，无开关）、
`dist/providers/data/opencode-go.json`（没有一个模型打开兼容开关）。宿主那侧的岔路在
`packages/llm/llm-pi-ai/src/provider.ts`：只有 `catalog !== undefined && spec.api === undefined`
才复用 catalog provider，其余走协议表 `createProvider`。

## 作用域：只有这些请求会变

一次请求被改写，必须同时满足：它在一次 `llm/stream` 的作用域里、它是 `POST`、
且它的 provider id 以某个配置前缀开头**或**它落到的域名是配置的网关域名。
三条同时成立才动，其余一律原样透传 —— 包括 gateway 自身的 `GET {baseURL}/models`
发现请求、别的 provider 的所有流量、web fetch 与 MCP。

两个匹配是「或」的关系，因为 provider id 与它实际落到的域名是两件独立的事实：
手写路由可能两者只对上一个。默认只认 `opencode` 前缀与 `opencode.ai`（含子域，
`opencode.ai.evil.test` 不算）。

作用域本身也要求订阅真的收得到事件，所以这条 `llm/stream` 带 `{ global: true }`：
Cordis 按**发出事件的服务**所在的隔离作用域过滤监听器，而 `llm/stream` 由 llm 运行时
以自身为 `this` 发出 —— 一旦有 bundle 把 `llm` isolate 进自己的作用域，不带这个选项的
监听器就再收不到（DSH 自己的 `llm/stream` 监听器同样带着它）。

## 值：由会话 id 派生

送出去的不是会话 id 本身，而是它的摘要：`SHA-256(sessionId)` 的前 16 字节，按 v4 UUID 形状输出（版本位与变体位照 v4 置好，免得被当成客户端真生成的 UUID）。形状沿用 UUID，是因为网关实测接受过 `session-<uuid>` 与裸 UUID；摘要保证了网关真正要求的两条性质 —— 同一会话恒定、不同会话不碰撞。

这是**纯函数**，所以本行不持有任何状态：

- 没有映射表要存、要清理、要防并发写；
- 冷恢复不需要读回任何东西 —— 会话 id 由 DSH 持久化，恢复后同一个 id 推出同一个值（换成随机 id + 映射表恰恰会在这里破功：存储被清、换机器或重建 profile，同一个会话就会拿到新值）；
- 未加盐：网关日志里看到一个值，用同一个函数就能算回本地会话。代价是知道会话 id 的人也能算出同一个值 —— 它防的是日志与网关侧直读原 id，不是不可反推。

触发 `llm/stream` 的辅助调用（例如会话标题）与正文请求共享同一个作用域，因此带上同一个派生值 —— 少了这条，辅助调用会先被网关挡下来。

## 配置

随包不带 `config`：schema 默认值就是安装形态。四个键都可选：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 关掉就一行代码都不碰传输层 |
| `headerName` | `x-opencode-session` | 要带的头名；值永远是当前会话 id 的派生值 |
| `providers` | `['opencode']` | 按 **provider id 前缀**认领，例如 `opencode` 覆盖 `opencodego`；空列表表示这一维不认领 |
| `hosts` | `['opencode.ai']` | 按域名（本身或子域）认领；空列表表示这一维不认领 |

两个列表都为空时这行是惰性的。

## 与静态头的关系

落到线上的值是本行写的那个：路由里若已经有同名的静态头，它会被**替换**掉。
所以路由配置里那条 `headers: { x-opencode-session: … }` 应该删掉 —— 留着不会报错，
但它只在这行被禁用时生效，等于给排障留一个假象。

## 失效与代价

- 补的是 `globalThis.fetch`。作用域不在、方法不是 POST、两个匹配都不中、会话 id 缺失，
  或者这次请求根本判不出来（落点不是一个能解析的 URL），全部原样透传，**不让一次判错
  把健康的模型调用变成硬失败**。传输层自己的异常照常抛出，不被吞掉。会话 id 里的任何
  字符也不会成为问题：它先过摘要再进 `Headers`，注入不了第二个头。
- Host 没有 `ctx.on`（或加载器拒绝这一行）时只警告一次并保持传输层不动，绝不因为本
  行让 Host 起不来。
- 卸载（禁用 bundle / 移除插件）会还原传输层：多个 profile 同时挂载时按引用计数，
  最后一个卸载的负责还原。

## 怎么核对

单元测试覆盖全部三条 gate、同名头替换、派生值的形状与钉死的向量、失败透传与并发隔离
（`test/opencode-header.test.mjs`）。桌面运行时那一半无法自动化，做法与期望值见
[测试与现场核对](verification.md) 的那张表：改配置或升级 Harness 后，照表里的
「OpenCode Go 会话头」两行走一遍。
