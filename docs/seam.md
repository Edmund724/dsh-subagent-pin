# 接缝与 Host 契约

改 `plugin.js` 的包装之前先读这份文档与 `CONTEXT.md` 的「Host 契约」；本文是 README「深入阅读」的展开。

Cordis 的 `intercept` 只供服务*配置*，而 `subagents` 的 Config 没有路由字段，所以这两个实例方法就是全部。读 `ctx.subagents` 拿到 tracing proxy：函数值身份每次读取都变，只有属性 descriptor 稳定 —— 包装器因此是 *own shadow*，激活与卸载都基于 descriptor；激活先清掉上一代遗留的 shadow 并警告，**禁用插件总能把服务还原成未包装的形态**。

接缝依赖的每项 Host 形状在 `host-contract.js` 声明一次、激活时检查一次：缺接缝就拒绝激活（行状态 failed），而不是悄悄把子代理留在父路由上；能力退化（`getProvider` 缺席、provider 记录缺字段）只警告一次并点名代价。完整推理、形状清单与词表见 `CONTEXT.md`。
