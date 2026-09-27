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

**未指定路由**的委派取默认项的地方，由 `resolveAuthorization()` 算出。来源有两个：Settings 行的模型勾选（`source: "settings"`，默认），或插件行自己的 `provider` + `model`（`source: "pinned"`，给没有该行的 Host）。它只决定默认项，**不是许可证**：指定了路由的委派在查清单之前就原样放行了。

代码里这两个标识符仍叫 `resolveAuthorization()` / `allowedModels`，与 Host 自己的 `subagentModelSelection` / `allowedModels` 对齐 —— 它们是标识符，不是这里的词。

## 豁免（exemption）

**不**被钉住、原样放行的一次委派。两个原因见「决定」。豁免只适用于**未指定路由**的委派。

## 配置接口（config interface）

一行 `config` 可写什么的唯一**机器可读**声明，由 `config-schema.js` 导出的原生 Schemastery 图给出。DSH 在激活前用它校验整行（报错自带字段路径），`Config.listConfigs` 可把它投影成 JSON Schema。

分界线：**一个 schema 节点能表达的归 `config-schema.js`，表达不了的归 `plugin.js` 的 `resolveConfig()`。** Schemastery 会合并未知键、`union` 取第一个能过的分支，所以键闭包与「哪些键能同时出现」只能留在代码里。

由此 `apply()` 的入参契约是**已经过 `Config` 校验的 config**（cordis 的 `resolveConfig` 负责这一步），默认值也由 `Config` 提供。

## Host 契约（host contract）

插件对 Host 的**形状假设**：由 `host-contract.js` 声明一次、`apply()` 激活时检查一次，`test/host-contract.test.mjs` 再对着锁死的 Host 库断言一次。分两级：

- **拒绝激活**（结构类）：`subagents` 存在、`start`/`startContinuable` 是函数、实例可扩展，外加一次自检 —— 用一枚 Symbol 探针确认 `defineProperty` 与 `delete` 真的落到实例上（tracing proxy 只 trap `get`/`set`/`apply`，own shadow 与「卸载总能还原」全靠这一点）。任何一条不成立就激活失败、该行状态 failed，而不是把子代理留在父路由上。
- **只警告一次**（能力类）：`getProvider` 缺席，或 provider 记录缺 `capabilities`/`inheritsParentContext` —— 两个豁免读不出来，未指定路由的委派照常被钉住。核心承诺在这两种情况下仍然成立，所以不拦激活。

Settings 行（另一个服务）**不在契约里**：它由另一行提供、插件刻意不 `inject` 它，缺失或形状不对属于「暂时读不出来」，表现为激活时一条警告 + 每次未指定路由的委派 reject（分 `unavailable` 与 `malformed` 两档），不是激活失败。

运行期断言不了的那一半语义由契约测试覆盖：proxy 的陷阱集与「每次函数读取都新建包装」、`ctx.effect` 立即执行并登记它返回的 disposer、Schemastery 的四条行为（合并未知键 / `union` 首分支 / 对象自带 `{}` 默认 / `.default(undefined)` 清默认）、以及 Host 的 `isNativeConfigSchema` 与 `createConfigProjector` 对 `Config` 的投影。这些库按随包版本精确锁在 `devDependencies` 里（`schemastery` 3.18.4、`cordis` 4.0.4、`dsh-app-boot` 0.1.7-rc.2），升级 Harness 时一并核对，见 README 的「已验证」。

## 入口（origin）

一次委派是**新建**的，还是**冷恢复**的（子会话已不驻留内存，`deliverFollowup` 走 `coldResume`）：

- **新建** —— 必经被包住的两个方法（`start` / `startContinuable`），策略在这里求值一次，算出的路由写进子会话的 `subagent/descriptor`。
- **冷恢复** —— 只从 descriptor 重建 provider / model / effort，不经过被包住的两个方法（`coldResume` 不读任何设置）。**插件在这条路径上不产生任何行为。**

由此定调：**清单只在新建委派时求值一次，路由随该 child 冻结在 descriptor 里。** 在 Settings 里取消勾选某个模型**不会**撤销已经存在的 child；插件启用之前创建的、或本来就跑在父路由上的 child，冷恢复时仍然以父路由继续 —— 它从未进过清单。两个后果都是刻意的，写在这里而不是留在 README 的旁白里。要「撤销」或「迁移」既有 child，得先让 DSH 支持续跑携带路由覆盖，那不是本插件能做的事。

## 已排除

- **不用 `@deepseek-ai/dsh-invariants` 表达这份契约。** Harness 升级必然重启，而激活断言每次启动都跑一遍，invariant 提供的「运行时复查」是重复通道；它又受 config 过滤、`fail()` 只杀自己的子 fiber，接不了「拒绝激活」这一层。两个通道就是第二个权威。
- **`ctx.effect` 的返回值形态与卸载顺序不写进契约。** 真实语义是「立即同步执行回调 + 把返回的函数登记为 disposer」，与替身一致；差异只在返回值形态（Host 返回可 await 的 disposer 包装，替身返回内层 cleanup）与卸载顺序（无参数、跨 effect 逆序并发），而 `plugin.js` 不使用返回值，差异不承重。真正必须成立的那半边由 `test/host-contract.test.mjs` 断言。
