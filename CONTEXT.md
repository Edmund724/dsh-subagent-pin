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

## 暂缓的词

- **入口（origin）** —— 一次委派是新建的还是冷恢复的。冷恢复（`coldResume`）绕过被包住的两个方法，因此落在当前接缝的可见范围之外。这个词在它的策略定调之前不使用。
