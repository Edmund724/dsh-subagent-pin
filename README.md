# @local/dsh-subagent-pin

[English](README-en.md) | **简体中文**

Host 插件：给每一次**没有自己指定路由**的全新子代理委派补上路由 —— 补上 Settings「子代理模型」勾选清单的默认项（`config.defaultModel`，未配置时是列表第一个），清单每次委派都重新读取。自己指定了 `provider` 或 `model` 的委派原样放行：不查清单、不改写、不报错。以 bundle 装进 profile（本环境：`desktop` profile，行 id `subagent-pin`）。

## 不用这个插件会怎样

Settings 的「子代理模型」行只是**权限清单 + 发现工具**，它自身不把任何委派引向清单内的模型：

- 子代理 options 先铺**父代理的路由**，调用方的指定只做覆盖 —— 不带模型字段时，子代理跑的就是主代理的模型；
- 权限校验只在「显式选了模型」时介入（源码原话：*Pure inheritance remains outside this policy because no model-facing choice occurred*），纯继承不受 Settings 约束；
- `agentTeams.spawnTeammate`、workflow `agent()`、嵌套委派**没有模型入参**，永远继承。

结果：设置看似生效，子代理实际跑主代理的模型。本插件在 provider 解析子代理 options 之前注入路由，让勾选对每一次未指定路由的全新委派真正生效。

## 为什么必须是 Host 插件

委派*工具*（`subagent`、`subagent_fork`）从 `tool-subagent.agentOptions` 取路由，但那份配置只存在于工具上；teammate、workflow、嵌套委派直接调 `ctx.subagents`，preset 平面够不到它们。四条路径唯一的汇合点是 `ctx.subagents.start()` / `startContinuable()`，本插件就包在这里。注入的 `request.agentOptions` 写进子代理的 `subagent/descriptor`，冷恢复靠读回它存活。

## 接缝（改代码前先读 CONTEXT 的「Host 契约」）

Cordis 的 `intercept` 只供服务*配置*，而 `subagents` 的 Config 没有路由字段，所以这两个实例方法就是全部。读 `ctx.subagents` 拿到 tracing proxy：函数值身份每次读取都变，只有属性 descriptor 稳定 —— 包装器因此是 *own shadow*，激活与卸载都基于 descriptor；激活先清掉上一代遗留的 shadow 并警告，**禁用插件总能把服务还原成未包装的形态**。

接缝依赖的每项 Host 形状在 `host-contract.js` 声明一次、激活时检查一次：缺接缝就拒绝激活（行状态 failed），而不是悄悄把子代理留在父路由上；能力退化（`getProvider` 缺席、provider 记录缺字段）只警告一次并点名代价。完整推理、形状清单与词表见 `CONTEXT.md`。

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

## 配置

随包配置就是 [`cordis.patch.yml`](cordis.patch.yml) 的那一节：`source: settings`，不设 `defaultModel`/`reasoningEffort`。字段权威是插件导出的 `Config`（`config-schema.js`）：DSH 激活前用它校验整行、报错带字段路径；`Config.listConfigs` 可把它投影成 JSON Schema，写配置前先查它。

下面两块是**示例：所有可写键**，不是随包内容。默认模式 —— 路由跟随 Settings：

```yaml
- id: subagent-pin
  name: '@local/dsh-subagent-pin'
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
  name: '@local/dsh-subagent-pin'
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

## 已验证

前提只有一个 Node ≥ 22.15（`package.json` 的 `engines`；两个工具要 zstd。`PATH` 上没有 `node` 时用 Harness 自带的运行时：`<Harness 安装目录>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`；插件**运行时**不加载本仓库的 Node，它跑在 Harness 自带运行时上）。运行时依赖 `@deepseek-ai/schemastery`、契约测试依赖真实 Host 库（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-app-boot`）都按精确版本锁在 `package.json`（后两者只给测试用），全新克隆先 `npm install`。测试不启动 Harness、不要凭据或网络；现场核对另需一个已启用本插件的运行中 Harness。

单元测试 —— 128 项（`config-schema` 10 · `route-policy` 32 · `plugin` 29 · `host-contract` 17 · `docs` 12 · `read-session` 5 · `verify-session` 9 · `package` 5 · `patch` 5 · `maintainer-docs` 3 · `tarball` 1；在 Node 25.8.0 上验证）：

```powershell
npm install
npm test
```

`npm test` 就是 `node --test "test/*.test.mjs"`（显式 glob；替身与 helper 放 `test-support/`）。测试、`test-support/` 与 `.agents/notes` 的决策记录都在 `files` 里，所以打包产物上 `npm install && npm test` 跑出同一个数字。每个文件都可单跑（`node --test test/<名字>.test.mjs`），职责：

- `test/config-schema.test.mjs` —— 配置接口：原生 schema 图、接受/拒绝的取值域、省略字段的解析、刻意留给 `plugin.js` 的空档；
- `test/route-policy.test.mjs` —— 策略：两种 source、默认项、指定路由原样放行（含半条路由、非字符串值、清单读不出来）、`defaultModel` 覆盖与失效、Settings 行的所有不可用形态、两个豁免；
- `test/plugin.test.mjs` —— 接缝与组合：真实 Cordis 替身（`test-support/host-doubles.mjs`）上的安装、两种还原、治愈上一代遗留 shadow、装在我们之上的包装、通知去重；
- `test/host-contract.test.mjs` —— Host 契约：对着锁死的库断言 proxy 陷阱、descriptor 落点、`ctx.effect`、Schemastery 行为与 `Config` 投影；契约表五条各有测试点名；
- `test/docs.test.mjs` —— 文档守卫：README 的 config 键被 schema 声明、决定词在 `CONTEXT.md` 词表、相对链接与散文点名的仓库路径存在且随包、两份 README 章节同形同序；自带坏基线，每条判断都被喂一次改坏的真实文档证明它会红；
- `test/read-session.test.mjs` / `test/verify-session.test.mjs` —— 证据工具：自造多帧/坏尾帧日志跑读取器与 `verify`（含 child 日志缺失、descriptor 与 header 不一致、期望越出冻结清单）；
- `test/package.test.mjs` / `test/patch.test.mjs` / `test/tarball.test.mjs` / `test/maintainer-docs.test.mjs` —— 分别钉 `exports` 与 `files` 一致（含 icon 随包且画在官方 36×36 viewBox 上）、随包 patch（用 Host 自己的 API 读成恰好一行 `source: settings` 的 insert）、真实 packlist 对拍 `files`（唯一动用 npm 的一项，不联网）、维护者文档（`AGENTS.md` 与 `.agents/notes/` 的笔记）里的引用。

现场核对 —— 人工执行，每项一次工具调用。生产证据无法自动化（日志要真跑才有），但读日志是一条命令：

```powershell
npm run verify -- --lead <lead 会话日志>   # 另有 --child / --expect / --default-model / --lead-expect
```

它从那次运行自己的 `subagent/model-selection-policy` 读出冻结清单，经 `subagent/catalog` 定位每个 child 的日志（Host 写成兄弟目录、以 childId 命名），断言每个 child 的 `request/header` 与 continuable descriptor 落在默认项上。不读活 Settings、不启动 Harness —— 验的是那一次，不是现在。会话日志在 `$DSH_HOME/sessions/<项目目录>/<会话 id>/session.v4.jsonl.zstd`（`$DSH_HOME` 默认 `~/.dsh`，Windows 为 `%USERPROFILE%\.dsh`）。`<默认模型>` 指清单默认项；示例路由（`opencodego`、`deepseek-v4.1-flash`）是本环境的，请替换。

| 检查项 | verify | 做法 | 期望 |
|---|---|---|---|
| 全新 `subagent`，不带模型字段 | 默认项 | 用 `subagent` 探测，让它回报自己的 `{{model}}` | `<默认模型>` |
| workflow `agent()`，不带模型字段 | 默认项 | 用 `workflow` 探测，返回子代理的模型 | `<默认模型>` |
| 重新勾选模型 | 默认项 | 在 Settings 改勾另一个模型，重跑 workflow 探测 | 新的默认项，无需重启 |
| 勾多个模型 + 显式指定 | `--expect <第二个路由>` | 勾两个模型，用 `subagent` 显式指定第二个 | 子代理跑第二个模型，不报错 |
| 配置 `defaultModel` | `--default-model <第二个路由>` | 把 `defaultModel` 指向清单第二个模型，重跑 workflow 探测 | 子代理跑 `defaultModel` |
| continuable 子代理（Agent Teams 接缝） | 默认项 | `subagent` 加 `run_in_background: true`，再对子会话日志跑 `node tools/read-session.mjs <子会话日志>` | `subagent/descriptor`：`"mode":"continuable","agentProvider":…,"agentModel":"<默认模型>"`（`verify` 同时断言它与 header 一致） |
| 显式指定清单外的路由 | `--expect <越界路由>` | 用 workflow `agent()` 指定清单外路由（`subagent` 工具那条路先被 DSH 自己拦，验不到本插件） | 子代理**原样跑该路由**，插件不报错 |
| Lead 不受影响 | `--lead-expect <Lead 路由>` | 核对同一次运行的 lead 日志 | `request/header` 保持 Lead 自己的路由 |
| 禁用 = 不改变 | — | 禁用 bundle，再带显式路由跑一次探测 | 子代理跑显式路由：没有任何包装 |
| Harness 升级后的投影契约（先看这一行） | — | 用 `Config.listConfigs` 查 `entry: include:subagent-pin`（离线部分由 `test/host-contract.test.mjs` 钉住，`status` 只有活 Host 看得到） | `status: "schema"` 且 `limitations: []`；`provider` 带 `minLength: 1`，`defaultModel` 带 `required: [provider, model]`，`source` 带 `default: "settings"`，`reasoningEffort` 带七个 level |

升级 Harness 后先看最后一行，再跑整张表。三点注意：

- 契约测试对着**锁死的三个包**跑 —— `@deepseek-ai/schemastery`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-app-boot`（本环境：3.18.4 / 4.0.4 / 0.1.7-rc.2，读自 asar 内 `/dsh/node_modules/@deepseek-ai/*/package.json`），必须与随包 Host 同版本，否则测的是另一个 Host。**`npm view <包> version` 会骗人** —— 它给 `latest` 标签，本环境的 latest 是更旧的 0.1.0-rc.6，所以 `devDependencies` 必须写精确版本；升级时核对三个版本、重跑单元测试。
- `Config` 用本仓库自己锁定的 schemastery，校验不经过 Host 那份，**版本号不同本身不会让插件挂掉**；但 Host 的 `createConfigProjector` 按跨版本契约读图的节点形状（`type`/`meta`/`dict`/`inner`/`list`），`limitations` 非空或 `status` 不再是 `schema` 即为投影退化。
- 一处不靠包版本的耦合：`config-schema.js` 的 `THINKING_LEVELS` 就是 pi-ai profile `reasoning` 字段那组词 —— Host 新增 level 要在这里补上，否则 schema 会拒掉 Host 已认识的强度。

辅助工具：`tools/read-session.mjs` 切分日志里拼接的 zstd 帧（单次解压只得第一帧，坏尾帧只损失它自己），第二参数按**完整** type 过滤，每条事件整条打印成可解析的一行 JSON；`verify` 从包外调用走 `exports` 的 `./verify` 入口。禁用时的拆包装有单元测试覆盖，并在本环境现场观察过：DSH 在 unload 时执行该行的副作用，shadow 在运行中的进程里被删掉。

## 修改本插件

改文件对运行中的 Harness 没有影响：DSH 按包名缓存每个插件模块，只有全新的 Host 进程才加载新一代。改完重启 Harness，重跑上面的表。

## 回滚

用 `plugin_manager` 的 `set_bundle` 禁用 `@local/dsh-subagent-pin`，或 `remove_bundle` 删除。禁用会在运行中的进程里卸载包装：接缝恢复未包装状态，子代理重新继承委派方的路由。本插件没动过任何 profile patch 或 preset，移除后组合与原来完全一致。
