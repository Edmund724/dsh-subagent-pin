# dsh-subagent-pin

[English](README-en.md) | **简体中文**

> DeepSeek Harness 的 Host 插件：让 Settings「子代理模型」里勾选的模型，成为每一次**没有自己指定路由**的全新子代理委派的默认路由；指定了 `provider` 或 `model` 的委派原样放行。同一个包还带第二行 `opencode-header`：把**每个会话自己的** id 送进 OpenCode Go 要求的 `x-opencode-session`。以 bundle 装进 profile（本环境：`desktop` profile，行 id `subagent-pin` 与 `opencode-header`），禁用即恢复原样。

## 为什么需要它

Settings 的「子代理模型」行是一份权限清单加发现工具：它约束显式指定的路由，却不把任何委派引向清单内的模型。子代理的选项总是先铺父代理的路由，权限校验又只在显式选择了模型时介入（源码原话：*Pure inheritance remains outside this policy because no model-facing choice occurred*），所以不带模型字段的委派跑的就是主代理的模型；teammate、workflow `agent()` 与嵌套委派甚至没有模型入参，只能继承。于是设置看似生效，子代理实际仍在跑主代理的模型。

要把勾选变成每一次委派的默认项，落点只能在 Host 内部：委派工具、teammate、workflow 与嵌套委派这四条路径，唯一共享的汇合点是 `ctx.subagents.start()` / `startContinuable()`，工具配置与 preset 平面都覆盖不全。本插件正是包在这两个方法上的 Host 插件，在 provider 解析子代理选项之前注入路由；注入的路由随子代理冻结在它的 `subagent/descriptor` 里，冷恢复后依然成立。

## 安装

1. `git clone https://github.com/Edmund724/dsh-subagent-pin.git <克隆目录>`，然后在克隆目录里 `npm install`
2. `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 写 `"@edmund724/dsh-subagent-pin": "link:<克隆目录绝对路径>"`
3. `~/.dsh/profiles/<profile>/cordis.patch.yml` 追加挂载行 —— 行名是**这一行自己的地址**（DSH 从它读这行的标题与描述，所以 `subagent-pin` 写 `…/subagent-pin`，不是包根）；这一行的 `config` 就是本插件的设置表单：`source` / `defaultModel` / `reasoningEffort`，设置页写的就是它；不写则全部用 schema 默认值：

```yaml
- id: subagent-pin
  name: '@edmund724/dsh-subagent-pin/subagent-pin'
  config:
    source: settings
```

同一个包还会 insert 第二行 `opencode-header`（下一节）：走 `dsh.profile.bundles` 装本包时它随包生效，手写挂载行的话照上面的格式再加一行、不带 `config`。

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

**上游已经修好了，是依赖没升。** pi-ai 从 `0.86.0` 起自带 `withOpenCodeSessionHeader`：它把 `x-opencode-session` 设成这次请求自己的 `options.sessionId`，已经带这个头就不覆盖。DSH 仍钉 `@earendil-works/pi-ai ^0.85.1`（`^0.85.1` = `>=0.85.1 <0.86.0`，0.86/0.87 都被排除），master 上没有一处引用这段逻辑，也没有带它的 release —— 所以这一行现在补的是 DSH 升级前的缺口。**但光升级也够不到本环境这条路由**：那个 wrapper 包的是 catalog 工厂，而 `opencodego` 手写了 `api: anthropic-messages`，走 `PROTOCOLS` 现场构造 provider，不经过 catalog。所以这一行不是「等 DSH 升级就能撤」：那条 wrapper 发的是**原始** `options.sessionId`，本行发的是派生值（原始 id 不出机器）；pi-ai 另一条按模型 `compat` 发的会话头，连头名都不是网关要的这个，catalog 里也没有模型开它（逐个情况见 [docs/opencode-header.md](docs/opencode-header.md)）。

作用域收得很紧：一次请求要**同时**满足三条才改写 —— 在一次 `llm/stream` 的作用域里、方法是 `POST`、且 provider id 以某个配置前缀开头**或**落到的域名是配置的网关域名。所以 gateway 自己的 `GET {baseURL}/models` 发现请求、别的 provider 的全部流量、web fetch 与 MCP 都原样透传。判不出来（例如 session id 含非法字符）也透传：不会让一个坏 id 把健康的模型调用变成硬失败。

随包不带 `config`：下面四个键都可选，schema 默认值就是安装形态（列表留空表示那一维不认领）：

```yaml
- id: opencode-header
  name: '@edmund724/dsh-subagent-pin/opencode-header'
  config:
    enabled: true
    headerName: x-opencode-session
    providers: [opencode]
    hosts: [opencode.ai]
```

这条头为什么只能长在进程传输层（逐个排除的选项）、怎么现场核对它真的生效，见「深入阅读」里的最后两篇。

## 配置

随包配置就是 [`cordis.patch.yml`](cordis.patch.yml) 里 `subagent-pin` 那一节：`source: settings`，不设 `defaultModel`/`reasoningEffort`。字段权威是路由这行导出的 `Config`（`config-schema.js`）：DSH 激活前用它校验整行、报错带字段路径；`Config.listConfigs` 可把它投影成 JSON Schema，写配置前先查它。会话头那行的接口在 `opencode-header.js`，键与默认值见上一节。

下面两块是**示例：所有可写键**，不是随包内容。默认模式 —— 路由跟随 Settings：

```yaml
- id: subagent-pin
  name: '@edmund724/dsh-subagent-pin/subagent-pin'
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
  name: '@edmund724/dsh-subagent-pin/subagent-pin'
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

用 `plugin_manager` 的 `set_bundle` 禁用 `@edmund724/dsh-subagent-pin`，或 `remove_bundle` 删除。禁用会在运行中的进程里卸载包装：接缝恢复未包装状态，子代理重新继承委派方的路由。本插件没动过任何 profile patch 或 preset，移除后组合与原来完全一致。

## 深入阅读

- [接缝与 Host 契约](docs/seam.md) —— 包装为什么落在 descriptor 上、激活时检查什么、能力退化时警告什么。
- [测试与现场核对](docs/verification.md) —— 165 项单元测试的逐文件拆分、`verify` 的用法、Harness 升级后的核对表。
- [OpenCode Go 的会话头](docs/opencode-header.md) —— 会话头那行的作用域、值的来源、四个配置键与核对方法。
- [领域词表](CONTEXT.md) —— 四种决定与两类豁免原因的定义，改策略前先读。
