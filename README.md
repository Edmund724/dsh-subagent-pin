# @local/dsh-subagent-pin

[English](README-en.md) | **简体中文**

Host 插件：给每一次**全新**（fresh）子代理委派补上一条路由 —— 但只补**没有自己指定路由**的那些。路由清单就是 Settings 里勾选的模型（`subagent-model-selection-settings`），每次委派都重新读取：委派方没有指定路由时（teammate、workflow `agent()`、嵌套委派都是这个情况）补上默认项 —— `config.defaultModel`，没配就是列表第一个。调用方**自己指定了** `provider` 或 `model` 时请求原样放行，插件不查清单、不改写、不报错：路由由调用方负责。它以 bundle 形式安装到某个 profile（本环境为 `desktop` profile，bundle `@local/dsh-subagent-pin`，行 id `subagent-pin`）。

## 不用这个插件会怎样

DSH 里「子代理模型」那一行 Settings 是**权限清单 + 发现工具**，它本身不会把任何一次委派引到该模型上。所以即使你在 Settings 里勾好了子代理模型，也很容易直接跑在主 agent 的模型上，设置等于失效：

- `resolveChildAgentOptions(parent, requested, childDepth)` 先铺开**父 agent 的 provider/model**，`requested`（本次委派显式给出的路由）只做覆盖。调用方不带模型字段时，子代理就是主 agent 的模型。
- 权限校验 `assertAllowedModelSelection` 只在「模型显式选了路由」时才介入 —— 源码注释写得很直白：*Pure inheritance remains outside this policy because no model-facing choice occurred*。也就是说，纯继承根本不受 Settings 约束。
- `list_subagent_models` 只是把允许的路由**告诉模型**，用不用完全靠模型自己在每一次调用里写 `provider`/`model`。少写一次，就静默退回主 agent 的模型，没有任何提示。
- 而 `agentTeams.spawnTeammate`、workflow 的 `agent()`、嵌套委派这些路径**根本没有模型入参**，永远走继承。

结果就是：设置看起来生效了（子代理照常跑起来），实际用的却是主 agent 的模型。本插件补上这一步 —— 在 provider 解析子代理 options 之前注入路由，让 Settings 里勾的那个模型对每一次**未指定路由的**全新委派真正生效。

## 为什么必须是 Host 插件

委派*工具*（`subagent`、`subagent_fork`）从 `tool-subagent.agentOptions` 取路由，但那份配置只存在于工具上。`agentTeams.spawnTeammate`、workflow 的 `agent()` 以及嵌套委派都直接调用 `ctx.subagents`，继承委派方自己的路由；Agent Teams 服务根本没有模型入参，`workflow-ptc` 的 Config 只带一个 provider *名称*。所以改 preset 平面到不了这些路径。

本插件包住它们共用的唯一接缝 —— `ctx.subagents.start()` 与 `ctx.subagents.startContinuable()` —— 在 provider 解析子代理 options 之前注入。注入的 `request.agentOptions` 就是子代理的真实路由，会写进子代理的 `subagent/descriptor`，并且冷恢复时靠读回该 descriptor 而存活。

## 接缝（改代码前先读 CONTEXT 的「Host 契约」）

本插件包住 `ctx.subagents.start()` / `startContinuable()` —— Cordis 的 `intercept` 只供服务*配置*，而 `subagents` 的 Config 里没有路由字段，所以这两个方法就是全部委派路径唯一的汇合点。读 `ctx.subagents` 拿到的是 tracing proxy：函数值身份不稳定，只有属性 *descriptor* 稳定 —— 包装器因此是一个 *own shadow*，激活与卸载都基于 descriptor，不靠捕获的函数身份；激活时会先清掉上一代遗留的 shadow 并记一条警告，而**禁用插件总能把服务还原成未包装的形态**。

接缝依赖的每一项 Host 形状都在 `host-contract.js` 里声明一次、激活时检查一次：接缝不存在就显式失败（该行状态 failed），而不是悄悄把子代理留在父路由上；能力类退化（`getProvider` 缺席、provider 记录缺字段）只记一条点名的警告，因为「未指定路由的委派绝不留继承」在那种情况下仍然成立。完整推理、形状清单与词表见 `CONTEXT.md` 的「Host 契约」。

## 模型来源

Settings 的那一行是**清单**：它的存在只是为了让面向模型的 `subagent` 调用可以指名其中一条路由，而 DSH 本身从不从中挑一个 —— 纯继承不受它约束。所以本插件接住「没有指名」的那些委派（teammate、workflow `agent()`、嵌套），把路由补成清单里的**默认项**：

- 默认项默认是 Settings 列表的**第一个**；想固定成别的已勾选模型，就在插件配置里写 `defaultModel`（必须属于当前清单，否则该次**未指定路由的**委派报错）。
- 列表顺序是存储顺序（UI 里先存的在前、新勾的追加到末尾），`defaultModel` 让默认项不再取决于它。

这个读取每次委派都发生，所以重新勾选模型对下一个子代理立即生效、无需重启 —— 比随包的 `subagent` 工具更新鲜（后者在会话拿到委派工具时采样一次）。

当该行允许 0 个模型、被禁用、或未被组装时，每一次**未指定路由的**全新委派都会失败，并在消息里给出修复方法。这是刻意的：一个没指定路由的子代理绝不能悄悄退回委派方的路由。**自己指定了路由的委派不受影响** —— 清单只决定默认项，不是许可证。`source: pinned` 是没有该行的 Host 的逃生通道。

## 策略

| 委派 | 结果 |
|---|---|
| 全新子代理（`spawn`），不带模型字段 | 补成路由清单的默认项（`defaultModel`，未配置时是列表第一个） |
| 全新子代理，只给了 effort（工具参数 `reasoning_effort`，内部字段 `agentOptions.reasoningEffort`） | 默认路由，保留调用方的 effort —— effort 不算「指定了路由」（工具层把它算作显式选择，本插件刻意相反） |
| 任何子代理，`provider` 或 `model` 任一被指定 | **原样放行**：不查清单、不改写、不报错 |
| 未指定路由的委派，且 Settings 行允许 0 个模型、被禁用、不存在、或清单被该行自己拒绝 | **抛错**，并写明修复方法 |
| 未指定路由的委派，且配置的 `defaultModel` 不在当前清单内 | **抛错**，并写明修复方法 |
| 未指定路由的委派，Fork 类 provider（`inheritsParentContext`） | 留在继承来的路由上，复用对话前缀仍然命中缓存 |
| 未指定路由的委派，不具备 `agentOptions` 能力的 provider（进程外 `codex`/`claude-code`） | 交给该 provider，只报告一次警告 |
| 已存在的 child（冷恢复 / 续跑） | 保持创建时写进 `subagent/descriptor` 的路由 —— 插件不复查、不改写；取消勾选模型**不会**撤销它 |

**路由清单只决定默认项，不是许可证。** 指定了路由的委派由调用方负责：它们在查清单之前就原样放行了，连 Settings 行读不出来时也一样。DSH 自己的 `subagent` 工具仍会用**该会话冻结的**那份清单拦一次模型显式指定的越界路由 —— 那是工具层的策略，本插件解不开，也不该解；workflow `agent()` 这类绕过工具层的调用则完全由调用方负责。已经存在的 child 更不是一次委派：它的路由在创建时就冻结在 descriptor 里了（见 `CONTEXT.md` 的「入口」）。

两个例外（Fork 与进程外 provider）都只适用于**未指定路由**的委派：固定这两者花费大于收益，而且都无法在进程内强制。以 `context: "fork"` 生成的 teammate 属于 Fork 例外；全新 teammate（默认的 `freshProvider`）会被路由。

## 配置

随包发布的配置就是 [`cordis.patch.yml`](cordis.patch.yml) 的那一节：`source: settings`，不设 `defaultModel`、不设 `reasoningEffort` —— 未指定路由的委派取 Settings 列表第一个，强度交给模型自己的默认值。

字段级的权威声明是插件导出的 `Config`（在 `config-schema.js` 里）：DSH 在激活前用它校验整行 `config`，报错自带字段路径；`Config.listConfigs` 可把它投影成 JSON Schema，写配置前先查它即可。

下面两块是**示例：所有可写键**，不是随包内容。默认模式 —— 路由跟随 Settings：

```yaml
- id: subagent-pin
  name: '@local/dsh-subagent-pin'
  config:
    source: settings            # 默认
    defaultModel:               # 可选；默认取 Settings 列表第一个
      provider: <provider-id>
      model: <model-id>
    reasoningEffort: high       # 可选；DSH 的七个 thinking level 之一；不写就交给 provider 配置/模型自己的默认
```

示例二 —— 静态模式，用于没有 Settings 那一行的 Host：

```yaml
- id: subagent-pin
  name: '@local/dsh-subagent-pin'
  config:
    source: pinned
    provider: <provider-id>
    model: <model-id>
    reasoningEffort: high          # 可选；DSH 的七个 thinking level 之一
```

`settings` 模式下 `provider` 与 `model` 会在激活时被拒绝，因此过期的静态路由无法悄悄生效；`defaultModel` 只在 `settings` 模式有意义，`pinned` 模式下写它会被拒绝（固定路由本身就是默认项）。未知配置键是激活错误，而不是静默忽略 —— `allowedModels` 已不再是配置键：清单只决定默认项，指定了路由的委派不查清单，所以「显式路由可以指名哪些」不再是一条规则。`reasoningEffort` 只在调用方自己没有指定 effort 时套用，取值必须是 DSH 自己的七个 thinking level 之一（`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`，与 pi-ai profile 的 `reasoning` 字段同一组词）：写别的值是**激活错误**并带字段路径，而不是等到请求时才失败。随包配置不设它，未指定时由 DSH 填该模型自己的默认强度（pi-ai 适配器取 provider 配置的 `reasoning` 字段）。**这个键只声明「想用哪个强度」，不保证落到的模型接受它** —— 是否接受由 DSH 在请求路径判定：不支持即拒绝，消息点名 provider/model/effort，不 clamp、不丢弃；插件不校验、不改写，也不因此改路由。Schemastery 会合并未知键、也无法表达「哪些键能同时出现」，所以键闭包与上面的模式规则仍由 `plugin.js` 在 schema 之上执行。

## 已验证

下面每一项都写成可在另一台机器上复现的形式。只需要一个 Node.js（**本仓库的测试与工具都需 Node ≥ 22.15**：`tools/read-session.mjs` 用 `zlib.zstdDecompressSync`，测试用 `zlib.zstdCompressSync` 造帧；`package.json` 的 `engines` 写的就是这个下限。插件**运行时**不加载本仓库的 Node —— 它跑在 Harness 自带的运行时上）—— `PATH` 上若没有 `node`，用 Harness 自带的运行时（相对 Harness 安装目录）：`<Harness 安装目录>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`。另外，插件运行时要 `@deepseek-ai/schemastery`，契约测试要对真实的 Host 库跑（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-app-boot`），三者都按版本号精确锁在 `package.json` 里（只给测试用，运行时不加载），全新克隆先装一次依赖：`npm install`。现场核对另需一个已启用该插件的运行中 Harness。

单元测试 —— 107 项（`config-schema` 10 · `route-policy` 32 · `plugin` 27 · `host-contract` 15 · `docs` 5 · `read-session` 5 · `verify-session` 9 · `package` 4），无需运行 Harness（在 Node 25.8.0 上验证）。在仓库根目录执行：

```powershell
npm install
npm test
```

（`npm test` 就是 `node --test "test/*.test.mjs"`：目标写成显式 glob，不依赖 Node 的默认测试 glob；测试文件一律叫 `test/*.test.mjs`，替身与辅助代码放 `test-support/`。测试、`test-support/` 与 `.agents/notes` 的决策记录都在 `files` 里，所以打包产物 `npm install && npm test` 能跑出同一个数字。）

（`node --test test/config-schema.test.mjs` 只跑配置接口：直接调用 `config-schema.js`，不需要任何替身；`node --test test/route-policy.test.mjs` 只跑策略侧：直接调用 `route-policy.js`，同样不需要替身；`node --test test/plugin.test.mjs` 只跑接缝与组合侧，用的是真实 Cordis 上的替身（`test-support/host-doubles.mjs`）；`node --test test/host-contract.test.mjs` 只跑 Host 契约：对着下面锁死的库断言代理、effect、Schemastery 与投影，不经过插件；`node --test test/docs.test.mjs` 只跑文档守卫：把两份 README 与 `CONTEXT.md` 读成文本，断言其中的 config 键被 schema 声明、决定词在词表里、相对链接与散文里手写的仓库路径都存在且随包发布、两份 README 的章节数相等；`node --test test/read-session.test.mjs` 自己造日志来跑证据读取器（拼接的多帧 zstd、写坏了的尾帧、CLI 的精确过滤与整条打印）；`node --test test/verify-session.test.mjs` 自己造一次运行的两份日志来跑下面那条 `verify`；`node --test test/package.test.mjs` 断言 `exports` 的每个入口都真实存在、而且都在 `files` 里。以上都不经过插件。）

覆盖内容：配置接口（原生 schema 图、接受与拒绝的取值域、省略字段解析成什么、以及刻意留给 `plugin.js` 的空档）、两种 source、默认路由本身、指定了路由的请求原样放行（含只给一半路由、非字符串值、以及清单读不出来时）、`defaultModel` 覆盖与「它已不在清单内」的报错、每次委派重新读取 Settings 行，Settings 行的所有不可用形态（0 个模型、被禁用、不存在、该行自己就拒绝的清单）、两个例外、只警告一次的规则、两种还原形态、治愈上一次激活遗留的 shadow、装在我们的包装之上的包装、通过「每次函数读取都重新包装」的 proxy 卸载（正是这个形态打挂了第一版），以及 Host 契约本身：proxy 的三条陷阱与「每次读取都新建包装」、`defineProperty`/`delete` 落到实例、`ctx.effect` 立即执行并登记它返回的 disposer、Schemastery 的四条行为、Host 的 `isNativeConfigSchema` 与 `createConfigProjector` 对 `Config` 的投影，还有激活期的自检（写入被改道就拒绝激活、provider 记录读不出来就点名警告）；证据侧则覆盖拼接 zstd 帧的读取、CLI 的精确过滤与整条打印、`verify` 对一次运行的路由断言（含 child 日志缺失、descriptor 与 header 不一致、期望值越出冻结清单这些失败形态）、以及 `exports` 与 `files` 的一致性、manifest 的 `icon` 存在且随包。

现场核对 —— 人工执行，每项一次工具调用，需要在已启用该插件的 Harness 上做。**生产证据这一步无法自动化**（日志要真跑才有），但「读日志」那一半已经是一条命令：跑完一项之后，`npm run verify -- --lead <lead 会话日志>` 会从那次运行自己的 `subagent/model-selection-policy` 读出它当时冻结的清单，从 `subagent/catalog` 找到每个 child 的日志（Host 写在同一个项目目录下、以 childId 命名），断言每个 child 的 `request/header` 与 continuable descriptor 都落在默认项上；`--expect`、`--default-model`、`--lead-expect` 用于日志给不出的期望，`--child` 指向别处的日志。它不读活 Settings、不启动 Harness —— 验的是**那一次**，不是现在。下表的「verify」列就是这个命令的用法。

`<默认模型>` 指当前清单的默认项（配置了 `defaultModel` 就是它，否则是列表第一个）；此处用作示例的路由（`opencodego`、`deepseek-v4.1-flash`）是本环境的，请替换为你自己的。会话日志位于 `$DSH_HOME/sessions/<项目目录名>/<会话 id>/session.v4.jsonl.zstd`（`$DSH_HOME` 默认是 `~/.dsh`，Windows 上是 `%USERPROFILE%\.dsh`）；会话目录名有 `<uuid>` 与 `session-<uuid>` 两种形态，同一次运行里的 child 是并列的兄弟目录。

| 检查项 | verify | 做法 | 期望 |
|---|---|---|---|
| 全新 `subagent`，不带模型字段 | 默认项 | 用 `subagent` 探测，让它回报自己的 `{{model}}` | `<默认模型>` |
| workflow `agent()`，不带模型字段 | 默认项 | 用 `workflow` 探测，返回子代理的模型 | `<默认模型>` |
| 重新勾选模型 | 默认项 | 在 Settings 里改勾另一个模型，重跑 workflow 探测 | 新的列表第一个（或 `defaultModel`），无需重启 |
| 勾多个模型 + 显式指定 | `--expect <第二个路由>` | 勾两个模型，用 `subagent` 显式指定第二个 | 子代理跑第二个模型，不再报错 |
| 配置 `defaultModel` | `--default-model <第二个路由>` | 插件行里把 `defaultModel` 指向清单里的第二个模型，重跑 workflow 探测 | 子代理跑 `defaultModel` |
| continuable 子代理（Agent Teams 接缝） | 默认项 | `subagent` 加 `run_in_background: true`，再对子会话日志跑 `node tools/read-session.mjs <子会话日志>`（`verify` 同时断言 descriptor 与它自己的 header 一致） | `subagent/descriptor`：`"mode":"continuable","agentProvider":"<provider-id>","agentModel":"<默认模型>"` |
| 显式指定清单外的路由 | `--expect <越界路由>` | 用 workflow 的 `agent()` 显式指定一个不在清单内的路由（`subagent` 工具那条路先被 DSH 自己拦，验不到本插件） | 子代理**原样跑该路由**，插件不报错 |
| Lead 不受影响 | `--lead-expect <Lead 路由>` | 核对同一次运行的 lead 会话日志 | `request/header` 保持 Lead 自己的路由 |
| 禁用 = 不改变 | — | 禁用该 bundle，然后带显式路由跑一次探测 | 子代理运行该显式路由：没有任何包装 |
| Harness 升级后的投影契约（先看这一行） | — | 用 `Config.listConfigs` 查 `entry: include:subagent-pin`（其中可离线判断的部分由 `test/host-contract.test.mjs` 对着锁死的库断言；`status` 只有在运行的 Host 上才看得到） | `status: "schema"` 且 `limitations: []`；`provider` 带 `minLength: 1`，嵌套的 `defaultModel` 带 `required: [provider, model]`，`source` 带 `default: "settings"`，`reasoningEffort` 带七个 level 的 `const` 取值域 |

最后一行是升级 Harness 之后要先看的。`Config` 用的是本仓库自己那份 `@deepseek-ai/schemastery`（`package.json` 里精确锁死），运行时校验不经过 Host 自带的那份，所以**版本号不同本身不会让插件挂掉**。但 Host 新版的 `createConfigProjector` 是按一份跨版本契约读我们图的节点形状（`type`/`meta`/`dict`/`inner`/`list`），改了约定就在这里显形：`limitations` 非空即为投影退化，`status` 不再是 `schema` 即为新 Host 不接受这份图。

契约测试同理，而且更早：`test/host-contract.test.mjs` 是对着**锁死的三个包**跑的 —— `@deepseek-ai/schemastery`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-app-boot`。它们必须与随包的那份同版本，否则测的是另一个 Host。随包版本读自 `app.asar` 内的 `/dsh/node_modules/@deepseek-ai/*/package.json`（本环境：`schemastery` 3.18.4、`cordis` 4.0.4、`dsh-app-boot` 0.1.7-rc.2）。两点注意：**`npm view <包> version` 会骗人** —— 它给的是 `latest` 标签，本环境的 `dsh-app-boot` 是 `0.1.0-rc.6`，比随包的 `0.1.7-rc.2` 旧，所以 `devDependencies` 必须写精确版本号、不能写范围；升级 Harness 时把这三个版本一并核对、重跑单元测试，再跑上面整张表。另有一处**不靠包版本**的耦合：`config-schema.js` 的 `THINKING_LEVELS` 就是 pi-ai profile `reasoning` 字段的那组词（`llm-pi-ai` 的 `z.union(THINKING_LEVELS)`）—— Host 新增一个 level 就要在这里补上，否则 schema 会拒掉一个 Host 已经认识的强度。

`tools/read-session.mjs` 从证据里读一份持久会话日志：它切分日志中拼接的 zstd 帧（单次解压只得到第一帧，写了一半的尾帧只损失它自己），第二个参数按**完整 type** 选事件（不是子串 —— 旧写法让 `request` 同时命中 `request/context` 与 `session/title-llm-request`），并且整条打印、每行一个可解析的 JSON 对象（旧的 1200 字符截断把 24k–31k 的 `request/header` 打成非法 JSON）。要从包外调用 `verify`，用 `exports` 里的 `./verify` 入口；`read-session.mjs` 保持内部实现，只被 `verify` 相对导入。

禁用时拆除包装由单元测试覆盖，并在本环境现场观察过（禁用本插件更早的一代时）：DSH 在 unload 时执行该行的副作用，所以 shadow 会在运行中的进程里被删掉。

## 修改本插件

改这个文件对运行中的 Harness 没有任何影响：DSH 按包名缓存每个插件模块，只有全新的 Host 进程才会加载替换用的模块代。改完代码要重启 Harness，然后重跑上面的表。

## 回滚

用 `plugin_manager` 的 `set_bundle` 禁用 `@local/dsh-subagent-pin`，或用 `remove_bundle` 删除它。禁用会在运行中的进程里卸载包装：委派接缝恢复未包装状态，子代理重新继承委派方的路由。本插件没有改动任何 profile patch 或 preset；移除它之后组合与原来完全一致。
