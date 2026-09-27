# @local/dsh-subagent-pin

[English](README-en.md) | **简体中文**

Host 插件：给每一次**全新**（fresh）子代理委派一个被授权的 LLM 路由，不需要模型在提示词上配合。授权集合就是 Settings 里勾选的模型（`subagent-model-selection-settings`），每次委派都重新读取：委派方没有指定路由时（teammate、workflow `agent()`、嵌套委派都是这个情况）补上默认项 —— `config.defaultModel`，没配就是列表第一个；它显式指定的路由只要在授权集合内就原样放行，从而保留「Agent 在授权模型里自己挑」的原意。它以 bundle 形式安装到某个 profile（本环境为 `desktop` profile，bundle `@local/dsh-subagent-pin`，行 id `subagent-pin`）。

## 不用这个插件会怎样

DSH 里「子代理模型」那一行 Settings 是**权限清单 + 发现工具**，它本身不会把任何一次委派引到该模型上。所以即使你在 Settings 里勾好了子代理模型，也很容易直接跑在主 agent 的模型上，设置等于失效：

- `resolveChildAgentOptions(parent, requested, childDepth)` 先铺开**父 agent 的 provider/model**，`requested`（本次委派显式给出的路由）只做覆盖。调用方不带模型字段时，子代理就是主 agent 的模型。
- 权限校验 `assertAllowedModelSelection` 只在「模型显式选了路由」时才介入 —— 源码注释写得很直白：*Pure inheritance remains outside this policy because no model-facing choice occurred*。也就是说，纯继承根本不受 Settings 约束。
- `list_subagent_models` 只是把允许的路由**告诉模型**，用不用完全靠模型自己在每一次调用里写 `provider`/`model`。少写一次，就静默退回主 agent 的模型，没有任何提示。
- 而 `agentTeams.spawnTeammate`、workflow 的 `agent()`、嵌套委派这些路径**根本没有模型入参**，永远走继承。

结果就是：设置看起来生效了（子代理照常跑起来），实际用的却是主 agent 的模型。本插件补上这一步 —— 在 provider 解析子代理 options 之前注入路由，让 Settings 里勾的那个模型对每一次全新委派真正生效。

## 为什么必须是 Host 插件

委派*工具*（`subagent`、`subagent_fork`）从 `tool-subagent.agentOptions` 取路由，但那份配置只存在于工具上。`agentTeams.spawnTeammate`、workflow 的 `agent()` 以及嵌套委派都直接调用 `ctx.subagents`，继承委派方自己的路由；Agent Teams 服务根本没有模型入参，`workflow-ptc` 的 Config 只带一个 provider *名称*。所以改 preset 平面到不了这些路径。

本插件包住它们共用的唯一接缝 —— `ctx.subagents.start()` 与 `ctx.subagents.startContinuable()` —— 在 provider 解析子代理 options 之前注入。注入的 `request.agentOptions` 就是子代理的真实路由，会写进子代理的 `subagent/descriptor`，并且冷恢复时靠读回该 descriptor 而存活。

## 接缝的工作方式（改这个文件前必读）

读取 `ctx.subagents` 拿不到服务实例：Cordis 返回的是 tracing proxy，**函数读取在每次访问时都会被重新包装**。因此包装器永远无法通过比较函数值认出自己 —— 身份检查会静默失败，包装也就永远拆不掉。只有属性 *descriptor* 是稳定的，而通过该 proxy 的 `defineProperty` 会落到所有消费者读到的同一个实例上。

随包发布的 `start`/`startContinuable` 是原型方法，所以包装器是一个 *own shadow*：删掉该属性就重新露出原方法。激活与卸载都基于 shadow：

- 激活时会先删掉上一次激活遗留的 shadow 并记录一条警告，因此崩溃或被替换的上一代不会叠加包装；
- 卸载时删掉自己的 shadow（若该服务的方法是 own property，则写回捕获到的属性），所以**禁用插件总能把服务还原成未包装的形态**。

如果接缝不存在（没有 `start`，或实例不可扩展），激活会显式失败，该行状态变成 failed，而不是悄悄把子代理留在父路由上。

## 模型来源

Settings 的那一行是**权限**清单：它的存在只是为了让面向模型的 `subagent` 调用可以指名其中一条路由，而 DSH 本身从不从中挑一个 —— 纯继承不受它约束。所以本插件接住「没有指名」的那些委派（teammate、workflow `agent()`、嵌套），把路由补成授权集合里的**默认项**：

- 默认项默认是 Settings 列表的**第一个**；想固定成别的授权模型，就在插件配置里写 `defaultModel`（必须属于当前授权集合，否则该次委派报错）。
- 列表顺序是存储顺序（UI 里先存的在前、新勾的追加到末尾），`defaultModel` 让默认项不再取决于它。

这个读取每次委派都发生，所以重新勾选模型对下一个子代理立即生效、无需重启 —— 比随包的 `subagent` 工具更新鲜（后者在会话拿到委派工具时采样一次）。

当该行允许 0 个模型、被禁用、或未被组装时，**每一次**全新委派都会失败，并在消息里给出修复方法。这是刻意的：未授权的子代理绝不能悄悄退回委派方的路由。`source: pinned` 是没有该行的 Host 的逃生通道。

## 策略

| 委派 | 结果 |
|---|---|
| 全新子代理（`spawn`），不带模型字段 | 补成授权集合的默认项（`defaultModel`，未配置时是列表第一个） |
| 全新子代理，只给了 `reasoning_effort` | 默认路由，保留调用方的 effort |
| 任何子代理，显式路由属于授权集合 | 完全按请求原样放行 |
| 任何子代理，显式指定授权集合之外的路由 | **抛错** —— 委派可见地失败 |
| Settings 行允许 0 个模型、被禁用、或不存在 | 每次全新委派都**抛错**，并写明修复方法 |
| 配置的 `defaultModel` 不在当前授权集合内 | 每次全新委派都**抛错**，并写明修复方法 |
| Fork 类 provider（`inheritsParentContext`） | 留在继承来的路由上，复用对话前缀仍然命中缓存 |
| 不具备 `agentOptions` 能力的 provider（进程外 `codex`/`claude-code`） | 交给该 provider，只报告一次警告 |

Fork 例外与进程外例外是刻意的：固定这两者花费大于收益，而且都无法在进程内强制。以 `context: "fork"` 生成的 teammate 属于 Fork 例外；全新 teammate（默认的 `freshProvider`）会被路由。两个例外仍然会用授权集合校验*显式*给出的路由。

## 配置

随包发布的配置（默认模式 —— 路由跟随 Settings）：

```yaml
- id: subagent-pin
  name: '@local/dsh-subagent-pin'
  config:
    source: settings            # 默认
    defaultModel:               # 可选；默认取 Settings 列表第一个
      provider: <provider-id>
      model: <model-id>
    reasoningEffort: high       # 可选；不写就交给 provider 配置/模型自己的默认
```

静态模式，用于没有 Settings 那一行的 Host：

```yaml
- id: subagent-pin
  name: '@local/dsh-subagent-pin'
  config:
    source: pinned
    provider: <provider-id>
    model: <model-id>
    reasoningEffort: high          # 可选
    allowedModels:                 # 可选；默认为固定的那条路由
      - provider: <provider-id>
        model: <model-id>
```

`settings` 模式下 `provider`、`model` 和 `allowedModels` 会在激活时被拒绝，因此过期的静态路由无法悄悄生效；`defaultModel` 只在 `settings` 模式有意义，`pinned` 模式下写它会被拒绝（固定路由本身就是默认项）。`pinned` 模式下 `allowedModels` 必须包含固定的那条路由。未知配置键是激活错误，而不是静默忽略。`reasoningEffort` 只在调用方自己没有指定 effort 时套用；随包配置已经不再设置它 —— 未指定时由 DSH 填该模型自己的默认强度（pi-ai 适配器取 provider 配置的 `reasoning` 字段），强度因此不再被本插件钉死。若你在没有该默认值的 Host 上仍想兜底，才需要在这里写。

字段级的权威声明是插件导出的 `Config`（在 `config-schema.js` 里）：DSH 在激活前用它校验整行 `config`，报错自带字段路径；`Config.listConfigs` 可把它投影成 JSON Schema，写配置前先查它即可。Schemastery 会合并未知键、也无法表达「哪些键能同时出现」，所以键闭包与上面的模式规则仍由 `plugin.js` 在 schema 之上执行。

## 已验证

下面每一项都写成可在另一台机器上复现的形式。只需要一个 Node.js（单元测试需 Node ≥ 20；`tools/read-session.mjs` 用到 `zlib.zstdDecompressSync`，需 Node ≥ 22.15）—— `PATH` 上若没有 `node`，用 Harness 自带的运行时（相对 Harness 安装目录）：`<Harness 安装目录>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`。现场核对另需一个已启用该插件的运行中 Harness。

单元测试 —— 65 项，无需运行 Harness（在 Node 25.8.0 上验证）。在仓库根目录执行：

```powershell
node --test
```

（`node --test test/config-schema.test.mjs` 只跑配置接口：它直接调用 `config-schema.js`，不需要任何替身；`node --test test/route-policy.test.mjs` 只跑策略侧：它直接调用 `route-policy.js`，同样不需要替身；`node --test test/plugin.test.mjs` 只跑接缝与组合侧。）

覆盖内容：配置接口（原生 schema 图、接受与拒绝的取值域、省略字段解析成什么、以及刻意留给 `plugin.js` 的空档）、两种 source、默认路由本身、授权集合内的显式路由原样放行、`defaultModel` 覆盖与「它已不在授权集合内」的报错、每次委派重新读取 Settings 行，Settings 行的所有不可用形态（0 个模型、被禁用、不存在、该行自己就拒绝的清单）、两个例外、授权集合外报错、只警告一次的规则、两种还原形态、治愈上一次激活遗留的 shadow、装在我们的包装之上的包装，以及通过「每次函数读取都重新包装」的 proxy 卸载（正是这个形态打挂了第一版）。

现场核对 —— 人工执行，每项一次工具调用，需要在已启用该插件的 Harness 上做。`<默认模型>` 指当前授权集合的默认项（配置了 `defaultModel` 就是它，否则是列表第一个）；此处用作示例的路由（`opencodego`、`deepseek-v4.1-flash`）是本环境的，请替换为你自己的。会话日志位于 `$DSH_HOME/sessions/<项目目录名>/<会话 id>/session.v4.jsonl.zstd`（`$DSH_HOME` 默认是 `~/.dsh`，Windows 上是 `%USERPROFILE%\.dsh`）。

| 检查项 | 做法 | 期望 |
|---|---|---|
| 全新 `subagent`，不带模型字段 | 用 `subagent` 探测，让它回报自己的 `{{model}}` | `<默认模型>` |
| workflow `agent()`，不带模型字段 | 用 `workflow` 探测，返回子代理的模型 | `<默认模型>` |
| 重新勾选模型 | 在 Settings 里改勾另一个模型，重跑 workflow 探测 | 新的列表第一个（或 `defaultModel`），无需重启 |
| 授权多个模型 + 显式指定 | 勾两个模型，用 `subagent` 显式指定第二个 | 子代理跑第二个模型，不再报错 |
| 配置 `defaultModel` | 插件行里把 `defaultModel` 指向授权集合里的第二个模型，重跑 workflow 探测 | 子代理跑 `defaultModel` |
| continuable 子代理（Agent Teams 接缝） | `subagent` 加 `run_in_background: true`，再对子会话日志跑 `node tools/read-session.mjs <子会话日志>` | `subagent/descriptor`：`"mode":"continuable","agentProvider":"<provider-id>","agentModel":"<默认模型>"` |
| 显式指定其它路由 | `subagent` 显式指定一个不在授权集合内的路由 | 报错，写明该路由与授权集合 |
| Lead 不受影响 | `node tools/read-session.mjs <lead 会话日志> request` | `request/header` 保持 Lead 自己的路由 |
| 禁用 = 不改变 | 禁用该 bundle，然后带显式路由跑一次探测 | 子代理运行该显式路由：没有任何包装 |

`tools/read-session.mjs` 从证据里读一份持久会话日志；它会切分日志中拼接的 zstd 帧 —— 单次解压会丢掉后面的帧。

禁用时拆除包装由单元测试覆盖，并在本环境现场观察过（禁用本插件更早的一代时）：DSH 在 unload 时执行该行的副作用，所以 shadow 会在运行中的进程里被删掉。

## 修改本插件

改这个文件对运行中的 Harness 没有任何影响：DSH 按包名缓存每个插件模块，只有全新的 Host 进程才会加载替换用的模块代。改完代码要重启 Harness，然后重跑上面的表。

## 回滚

用 `plugin_manager` 的 `set_bundle` 禁用 `@local/dsh-subagent-pin`，或用 `remove_bundle` 删除它。禁用会在运行中的进程里卸载包装：委派接缝恢复未包装状态，子代理重新继承委派方的路由。本插件没有改动任何 profile patch 或 preset；移除它之后组合与原来完全一致。
