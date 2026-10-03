# dsh-subagent-pin

[English](README-en.md) | **简体中文**

> DeepSeek Harness 的 Host 插件，一个包三行：让 Settings「子代理模型」里勾选的模型，成为每一次**没有自己指定路由**的全新子代理委派的默认路由（指定了 `provider` 或 `model` 的委派原样放行）；把**每个会话自己的** id 送进 OpenCode Go 要求的 `x-opencode-session`；并在 Agent Teams 占用 `send_message` 的会话里，补回按 agent id 给可继续子代理发消息、中断它们的能力。以 bundle 装进 profile（本环境：`desktop` profile，行 id `subagent-pin`、`opencode-header` 与 `subagent-steer`），禁用即恢复原样。第三行是**带删除条件的前修复**（上游修好就删，见「子代理转向」），不是新功能。

## 为什么需要它

Settings 的「子代理模型」行是一份权限清单加发现工具：它约束显式指定的路由，却不把任何委派引向清单内的模型。子代理的选项总是先铺父代理的路由，权限校验又只在显式选择了模型时介入（源码原话：*Pure inheritance remains outside this policy because no model-facing choice occurred*），所以不带模型字段的委派跑的就是主代理的模型；teammate、workflow `agent()` 与嵌套委派甚至没有模型入参，只能继承。于是设置看似生效，子代理实际仍在跑主代理的模型。

要把勾选变成每一次委派的默认项，落点只能在 Host 内部：委派工具、teammate、workflow 与嵌套委派这四条路径，唯一共享的汇合点是 `ctx.subagents.start()` / `startContinuable()`，工具配置与 preset 平面都覆盖不全。本插件正是包在这两个方法上的 Host 插件，在 provider 解析子代理选项之前注入路由；注入的路由随子代理冻结在它的 `subagent/descriptor` 里，冷恢复后依然成立。

## 安装

1. `git clone https://github.com/Edmund724/dsh-subagent-pin.git <克隆目录>`，然后在克隆目录里 `npm install`
2. `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 写 `"dsh-subagent-pin": "link:<克隆目录绝对路径>"`
3. `~/.dsh/profiles/<profile>/cordis.patch.yml` 追加挂载行 —— 行名是**这一行自己的地址**（DSH 从它读这行的标题、描述与图标，所以 `subagent-pin` 写 `…/subagent-pin`，不是包根）；这一行的 `config` 就是本插件的设置表单：`source` / `defaultModel` / `reasoningEffort`，设置页写的就是它；不写则全部用 schema 默认值：

```yaml
- id: subagent-pin
  name: 'dsh-subagent-pin/subagent-pin'
  config:
    source: settings
```

同一个包还会 insert 另外两行 —— `opencode-header` 与 `subagent-steer`（各见后文一节）：走 `dsh.profile.bundles` 装本包时它们随包生效，手写挂载行的话照上面的格式再加两行、都不带 `config`。

三行在插件列表里各画各的图标 —— `subagent-pin` 那行是图钉（包根 `package.json` 的 `icon.svg`），`opencode-header` 那行是 OpenCode 的标记（它自己地址导出的 `opencode-header.package.json` 声明的 `opencode-header.icon.svg`，官方几何、本包蓝色），`subagent-steer` 那行是同法的 `subagent-steer.package.json` / `subagent-steer.icon.svg`（目标节点 + 出射箭头）。DSH 按地址读每个 `package.json` 的 `icon`，所以地址不同，画出来的标记就可以不同；几行共用一个图标，卡片上就只能靠标题分辨。

4. 在 `~/.dsh/profiles/<profile>` 执行 `pnpm install`，然后重启 Harness

更新：`git pull && npm install` → 重启 Harness 即可（host 插件按包名缓存模块代数，改文件只有重启才加载新一代）。切回 npm 通道时，把依赖改回 npm 上的版本号再执行 pnpm install。

## 模型来源

- 默认项是清单的**第一个**（存储顺序：先存的在前、新勾的追加）；要固定成别的已勾选模型就配 `config.defaultModel`，它必须在当前清单内，否则未指定路由的委派报错。
- 清单每次委派都重读：改勾模型对下一个子代理立即生效，无需重启（随包的 `subagent` 工具只在会话拿到委派工具时采样一次）。
- 清单允许 0 个模型、行被禁用或未组装时，每一次未指定路由的全新委派**抛错并写明修法** —— 绝不静默退回父路由。`source: pinned` 是没有该行的 Host 的逃生通道。

## 策略

| 委派 | 结果 |
|---|---|
| 全新子代理，不带模型字段 | 补成清单默认项 |
| 全新子代理，只给了 effort（`agentOptions.reasoningEffort`） | 默认路由，保留调用方的 effort —— effort 不算「指定了路由」（工具层算作显式选择，本插件刻意相反） |
| `provider` 或 `model` 任一被指定 | **原样放行**，不查清单（连清单读不出来时也一样） |
| 未指定路由，且清单不可用（0 模型 / 禁用 / 未组装 / 行自拒） | **抛错**，写明修法 |
| 未指定路由，`defaultModel` 不在当前清单 | **抛错**，写明修法 |
| 未指定路由，Fork 类 provider（`inheritsParentContext`） | 留继承路由，复用前缀仍命中缓存 |
| 未指定路由，无 `agentOptions` 能力的 provider（进程外 `codex`/`claude-code`） | 交给该 provider，只警告一次 |
| 已存在的 child（冷恢复 / 续跑） | 保持创建时冻结在 `subagent/descriptor` 的路由；取消勾选**不**撤销它 |

**清单只决定默认项，不是许可证。** 指定了路由的委派归调用方负责：DSH 自己的 `subagent` 工具仍按该会话冻结的清单拦一次越界的显式路由 —— 那是工具层策略，本插件解不开也不该解；workflow `agent()` 这类绕过工具层的调用完全自负。两个例外（Fork 与进程外）都只适用于未指定路由的委派：`context: "fork"` 的 teammate 属于 Fork 例外，全新 teammate（默认 `freshProvider`）会被路由。

## OpenCode Go 的会话头

OpenCode Go 要求每个推理请求带 `x-opencode-session`，值是**这次会话自己的**标识。以前这条头写死在路由配置里 —— 全机器一个值，所有会话与子代理共用；本包第二行 `opencode-header` 把它换成当前会话的**派生值**：拿会话 id 做一次 SHA-256、取前 16 字节、按 v4 UUID 形状输出。值只由会话 id 决定，所以同一个会话每次都相同、不同会话必不相同，而本地会话 id 本身不出机器（网关被实测接受过 `session-<uuid>` 与裸 UUID，因此沿用 UUID 形状）。静态头则应该从路由里删掉。

派生是纯函数，这一行因此**不存任何东西**：没有映射表要写、要清理、要防并发，冷恢复也不用读回什么 —— 会话 id 由 DSH 自己持久化，恢复后同一个 id 推出同一个值。想把网关日志里看到的值对回本地会话，用同一个函数算一遍即可（刻意不加盐，保持可复现）。

**升级也撤不掉这一行。** pi-ai 从 `0.86.0` 起自带 `withOpenCodeSessionHeader`：它把 `x-opencode-session` 设成这次请求自己的 `options.sessionId`，已经带这个头就不覆盖；DSH 从 `0.2.0-rc.2` 起随包 pi-ai `^0.87.1`，这段逻辑就在场。它**仍然够不到本环境这条路由**：wrapper 只包在 catalog 工厂造出的 provider 上，而 `opencodego` 手写了 `api: anthropic-messages`，走协议表现场构造 provider，不复用 catalog。就算够得到，它发的也是**原始** `options.sessionId`，本行发的是派生值（原始 id 不出机器）；pi-ai 另一条按模型 `compat` 发的会话头，连头名都不是网关要的这个，Responses 那条更是连开关都没有（逐个情况见 [docs/opencode-header.md](docs/opencode-header.md)，取舍与排除见[决策记录](.agents/notes/implemented/architecture/2026-09-29-升级了也不跟着走.md)）。

作用域收得很紧：一次请求要**同时**满足三条才改写 —— 在一次 `llm/stream` 的作用域里、方法是 `POST`、且 provider id 以某个配置前缀开头**或**落到的域名是配置的网关域名。所以 gateway 自己的 `GET {baseURL}/models` 发现请求、别的 provider 的全部流量、web fetch 与 MCP 都原样透传。判不出来（例如 session id 含非法字符）也透传：不会让一个坏 id 把健康的模型调用变成硬失败。

随包不带 `config`：下面四个键都可选，schema 默认值就是安装形态（列表留空表示那一维不认领）：

```yaml
- id: opencode-header
  name: 'dsh-subagent-pin/opencode-header'
  config:
    enabled: true
    headerName: x-opencode-session
    providers: [opencode]
    hosts: [opencode.ai]
```

这条头为什么只能长在进程传输层（逐个排除的选项）、怎么现场核对它真的生效，见「深入阅读」里的最后两篇。

## 子代理转向

`send_message` 这个名字在 DSH 里有两份、参数不同：`dsh-tool-subagent-control` 的全局版认 `{ agent_id }`（按 id 投递可继续子代理或父代理），Agent Teams 的 scope 版认 `{ target }`（按队友名投递，注册进**每个 Team 成员（含 Lead）的 agent scope**）。本环境装的 Agent Teams profile 层**直接禁用了前者**（`@deepseek-ai/dsh-experimental-agent-team-profile` 里 `tool-subagent-control: disabled: true`）；两份同时挂着时，tools 注册表则**就近 scope 优先**，成员一样只解析到名字版。两种情形下结果相同 —— `subagent` / `subagent_fork` 仍然返回 id、并在描述里无条件写「用 `send_message` 续跑」，那个刚拿到的 id 因此不可寻址：调用报 `active teammate "<uuid>" not found`。

本包第三行 `subagent-steer` 把这条死路补回来，三件事：新增 `send_subagent_message({ agent_id, message })` 与 `interrupt_subagent({ agent_id })`（名字与 Team 版不同，因此不参与 scope 争名）；一个全局 guard 只在「该 agent 解析到名字版 `send_message`」且「target 既不是存活队友名、也不是 `lead`」时拒绝，理由点名 `list_agents` 与 `send_subagent_message`，把死路改成指路；一段 systemPrompt 只在 `send_subagent_message` 对该 scope 可见时输出，一句话写清两个工具的分工。这一行**不改名、不撤遮蔽、也不改别人的工具描述** —— 它只加名字、只拒绝、只补一句话。

边界：服务层只认直接的 continuable 父子（非直接关系抛 `UNAUTHORIZED`，一次性子代理不可续 `NOT_RESUMABLE`）；`agentTeams` 服务缺席时它静默弃权（那时 `send_message` 也不会是名字版）；「队友名字写错」的报错文案会被这一行改写得更清楚、更长，若某个部署依赖那句原文做匹配，需要知道这一点。这一行**没有 `config`**（没有旋钮，`subagent-steer.js` 不导出 `Config`），插件列表里它的 Config 状态显示 `absent` 属正常。

### 何时删掉这一行

出现下面任一条，这一行就失去价值，应当连同它的代码、测试与文档一起删掉：

- `send_message` 的 schema 同时接受 `target` 与 `agent_id`，或 Team 版改用别的名字；
- `subagent` / `subagent_fork` 的描述改成像工具返回值那样按 scope 判断（不再无条件叫人用 `send_message`）；
- tools 注册表对「跨层同名、schema 不同」给出诊断或直接失败。

## 配置

随包配置就是 [`cordis.patch.yml`](cordis.patch.yml) 里 `subagent-pin` 那一节：`source: settings`，不设 `defaultModel`/`reasoningEffort`。字段权威是路由这行导出的 `Config`（`config-schema.js`）：DSH 激活前用它校验整行、报错带字段路径；`Config.listConfigs` 可把它投影成 JSON Schema，写配置前先查它。会话头那行的接口在 `opencode-header.js`，键与默认值见上一节；转向那行没有接口可查 —— 它不导出 `Config`，也就没有可写的键。

下面两块是**示例：所有可写键**，不是随包内容。默认模式 —— 路由跟随 Settings：

```yaml
- id: subagent-pin
  name: 'dsh-subagent-pin/subagent-pin'
  config:
    source: settings            # 默认
    defaultModel:               # 可选；默认取 Settings 列表第一个
      provider: <provider-id>
      model: <model-id>
    reasoningEffort: high       # 可选；DSH 的七个 thinking level 之一；不写就交给 provider 配置/模型默认
```

静态模式，用于没有 Settings 行的 Host：

```yaml
- id: subagent-pin
  name: 'dsh-subagent-pin/subagent-pin'
  config:
    source: pinned
    provider: <provider-id>
    model: <model-id>
    reasoningEffort: high          # 可选；DSH 的七个 thinking level 之一
```

规则（Schemastery 会合并未知键、也无法表达键的组合，所以这部分由 `plugin.js` 在激活时执行）：

- `settings` 模式拒收 `provider`/`model`，过期静态路由无法悄悄生效；`pinned` 模式要求这两个键、并拒收 `defaultModel`（固定路由本身就是默认项）。
- 未知配置键是激活错误，不是静默忽略 —— `allowedModels` 已不再是配置键。
- `reasoningEffort` 只在调用方没给 effort 时套用，取值限七个 thinking level（`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`，与 pi-ai profile 的 `reasoning` 同一组词）；写别的值是**激活错误**并带字段路径。它只声明「想用哪个强度」：落到的模型是否接受由 DSH 在请求路径判定（拒绝并点名 provider/model/effort，不 clamp、不丢弃），插件不校验、不改写、也不因此改路由。

## 修改本插件

改文件对运行中的 Harness 没有影响：DSH 按包名缓存每个插件模块，只有全新的 Host 进程才加载新一代。改完重启 Harness，再按[测试与现场核对](docs/verification.md)的核对表核对一遍。

## 回滚

用 `plugin_manager` 的 `set_bundle` 禁用 `dsh-subagent-pin`，或 `remove_bundle` 删除。禁用会在运行中的进程里卸载包装：接缝恢复未包装状态，子代理重新继承委派方的路由。转向那行的三样注册（两个工具、guard、提示段）同样挂在 Host 的 effect 上，随禁用一起注销，`send_message` 回到只有名字版可用、id 不可寻址的原状。本插件没动过任何 profile patch 或 preset，移除后组合与原来完全一致。

## 深入阅读

- [接缝与 Host 契约](docs/seam.md) —— 包装为什么落在 descriptor 上、激活时检查什么、能力退化时警告什么。
- [测试与现场核对](docs/verification.md) —— 190 项单元测试的逐文件拆分、`verify` 的用法、Harness 升级后的核对表。
- [OpenCode Go 的会话头](docs/opencode-header.md) —— 会话头那行的作用域、值的来源、四个配置键与核对方法。
- [领域词表](CONTEXT.md) —— 四种决定与两类豁免原因的定义，改策略前先读。
