# 领域词表

这个仓库的核心概念。代码、README、提交信息与架构评审都应使用这里的词，而不是同义词。

## 决定（decision）

`route-policy.js` 对**一次委派**给出的唯一结果，取值四种：

- `pin` —— 补上授权路由后放行（调用方没有指定路由）。
- `pass` —— 原样放行。原因为 `authorized`（显式指定的路由本就在授权集合内）或 `opaque`（请求不是一个可推理的对象）。
- `exempt` —— 原样放行，但原因在 provider 身上：`inherited`（provider 的 `inheritsParentContext`，复用父对话前缀以保持缓存）或 `capability`（provider 不声称支持 `agentOptions`，见 README 的「策略」表）。
- `reject` —— 委派失败，并给出一条写明修复方法的 message。

**「决定」是一个值，不是异常。** `reject` 作为值返回，由 `plugin.js` 负责抛出；同理，notice 由 `plugin.js` 负责去重与打印。

## 授权集合（authorization set）

一次委派被允许使用的路由集合，由 `resolveAuthorization()` 算出。来源有两个：Settings 行的模型勾选（`source: "settings"`，默认），或插件行自己的 `allowedModels`（`source: "pinned"`，给没有该行的 Host）。显式请求的路由必须落在这个集合内。

## 豁免（exemption）

**不**被钉住、原样放行的一次委派。两个原因见「决定」。豁免仍然会用授权集合校验*显式*给出的路由。

## 配置接口（config interface）

一行 `config` 可写什么的唯一**机器可读**声明，由 `config-schema.js` 导出的原生 Schemastery 图给出。DSH 在激活前用它校验整行（报错自带字段路径），`Config.listConfigs` 可把它投影成 JSON Schema。

分界线：**一个 schema 节点能表达的归 `config-schema.js`，表达不了的归 `plugin.js` 的 `resolveConfig()`。** Schemastery 会合并未知键、`union` 取第一个能过的分支、`z.array(...).min(1)` 在元素带默认值时被跳过，所以键闭包、模式互斥、`allowedModels` 非空与「必须含 pinned 路由」只能留在代码里。

由此 `apply()` 的入参契约是**已经过 `Config` 校验的 config**（cordis 的 `resolveConfig` 负责这一步），默认值也由 `Config` 提供。

## 暂缓的词

- **入口（origin）** —— 一次委派是新建的还是冷恢复的。冷恢复（`coldResume`）绕过被包住的两个方法，因此落在当前接缝的可见范围之外。这个词在它的策略定调之前不使用。
