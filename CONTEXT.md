# 领域词表

这个仓库的核心概念。代码、README、提交信息与架构评审都应使用这里的词，而不是同义词。

## 决定（decision）

`route-policy.js` 对**一次委派**给出的唯一结果，取值四种：

- `pin` —— 补上清单里的默认路由后放行（调用方没有指定路由）。
- `pass` —— 原样放行。原因为 `named`（调用方自己指定了 `provider` 或 `model`，路由归调用方）或 `opaque`（请求不是一个可推理的对象）。
- `exempt` —— 原样放行，但原因在 provider 身上：`inherited`（provider 的 `inheritsParentContext`，复用父对话前缀以保持缓存）或 `capability`（provider 不声称支持 `agentOptions`，见 README 的「策略」表）。
- `reject` —— 委派失败，并给出一条写明修复方法的 message。

**「决定」是一个值，不是异常。** `reject` 作为值返回，由 `plugin.js` 负责抛出；同理，notice 由 `plugin.js` 负责去重与打印。

## 路由清单（route list）

**未指定路由**的委派取默认项的地方，由 `resolveAuthorization()` 算出。来源有两个：Settings 行的模型勾选（`source: "settings"`，默认），或插件行自己的 `provider` + `model`（`source: "pinned"`，给没有该行的 Host）。它只决定默认项，**不是许可证**（README「策略」）。

代码里这两个标识符仍叫 `resolveAuthorization()` / `allowedModels`，与 Host 自己的 `subagentModelSelection` / `allowedModels` 对齐 —— 它们是标识符，不是这里的词。

## 豁免（exemption）

**不**被钉住、原样放行的一次委派。两个原因见「决定」，适用面见 README 的「策略」表。

## 配置接口（config interface）

一行 `config` 可写什么的唯一**机器可读**声明：路由那行由 `config-schema.js` 导出的原生 Schemastery 图给出，会话头那行由 `opencode-header.js` 导出的同形状图给出。DSH 在激活前用它校验整行（报错自带字段路径），`Config.listConfigs` 可把它投影成 JSON Schema。**转向那行不导出 `Config`**：它没有旋钮，因此 `Config.listConfigs` 对它报 `absent` 是正常状态，不是加载失败的信号。

分界线：**一个 schema 节点能表达的归 `config-schema.js`，表达不了的归 `plugin.js` 的 `resolveConfig()`。** 这条线为什么划在这里，见 `config-schema.js` 的 JSDoc。

由此 `apply()` 的入参契约是**已经过 `Config` 校验的 config**（cordis 的 `resolveConfig` 负责这一步），默认值也由 `Config` 提供。

## 会话头（session header）

`opencode-header` 那一行在**一次 `llm/stream` 的作用域**内给 OpenCode Go 的请求写上的头：名字由 `headerName` 给（默认 `x-opencode-session`），值由**当前会话的 id**（`GenerateOptions.sessionId`）派生 —— SHA-256 取前 16 字节，按 v4 UUID 形状输出。同一个会话 id 每次都推出同一个值，不同会话不碰撞，原始 id 不出机器；因为是纯函数，这一行不存任何状态，冷恢复也不需要读回。「在作用域内」由三条 gate 收窄 —— 在一次 `llm/stream` 里、方法是 `POST`、provider id 以配置前缀开头**或**落到的域名是配置的网关域名；三条同时成立才改写，其余请求原样透传（README「OpenCode Go 的会话头」）。

落点为什么只能是进程传输层（逐个排除的选项）见 `.agents/notes/implemented/architecture/2026-09-28-请求头只能落在传输层.md`；做判断的那几个纯函数与不变量在 `opencode-header.js` 的文件头。

## 子代理转向（subagent steering）

`subagent-steer` 那一行在 Agent Teams 占用 `send_message` 的会话里补回的能力：两个自带名字的工具（`send_subagent_message` 按 agent id 投递、`interrupt_subagent` 按 agent id 中断）、一个把死路改成指路的全局 guard、一段只在工具对该 scope 可见时说话的 systemPrompt 段。**名字版**指 Agent Teams 注册进每个 Team 成员 agent scope 的 `send_message`（认 `target`），**id 版**指 `dsh-tool-subagent-control` 的全局 `send_message`（认 `agent_id`）；tracing 的解析规则是就近 scope 优先，所以成员只能拿到名字版，而 `subagent` / `subagent_fork` 返回的 id 因此不可寻址。

**guard 只有两种结局：弃权与拒绝，从不抛出。** 判据不成立（别的工具、无调用方、解析到 id 版、没有 `agentTeams`、名单读失败、target 不是可用字符串）一律 `return undefined`；只有「解析到名字版 + target 既不是存活队友名也不是 `lead`」才返回一条点名 `list_agents` 与 `send_subagent_message` 的理由。抛出的守卫会被 Host 规范化成错误结果，等于打坏别人的调用。

这一行是**带删除条件的前修复**：判据（三条）写在 README「何时删掉这一行」，本行不改名、不撤遮蔽、也不改别人的工具描述。

## Host 契约（host contract）

插件对 Host 的**形状假设**：由 `host-contract.js` 声明一次、`apply()` 激活时检查一次，`test/host-contract.test.mjs` 再对着锁死的 Host 库断言一次。分两级：`fail` 级拒绝激活，`warn` 级只警告一次；逐条清单与理由在 `host-contract.js` 的 JSDoc，锁定的库版本见 `docs/verification.md`。

## 入口（origin）

一次委派是**新建**（必经被包住的 `start` / `startContinuable`，策略在这里求值一次，算出的路由写进 `subagent/descriptor`）还是**冷恢复**（`deliverFollowup` → `coldResume`，只从 descriptor 重建，不经过被包住的两个方法，插件不产生任何行为）。清单只在新建委派时求值一次，路由随该 child 冻结在 descriptor 里 —— 推论与接缝地图见 `.agents/notes/implemented/architecture/2026-09-27-接缝与已排除.md`。

## 已排除

- **不用 `@deepseek-ai/dsh-invariants` 表达这份契约。** 完整理由见 `.agents/notes/implemented/architecture/2026-09-27-接缝与已排除.md`。
- **插件不按路由校验思考强度（`reasoningEffort`）。** 配置面只收 Host 自己的七个 thinking level；强度是否被落到的模型接受由 DSH 在请求路径回答（拒绝、不 clamp、不丢弃）。完整理由见 `.agents/notes/implemented/architecture/2026-09-27-强度不是插件的承诺.md`。
- **`ctx.effect` 的返回值形态与卸载顺序不写进契约。** 真实语义是「立即同步执行回调 + 把返回的函数登记为 disposer」；必须成立的那半边由 `test/host-contract.test.mjs` 断言。理由同上。
