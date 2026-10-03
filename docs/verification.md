# 测试与现场核对

本文是 README「深入阅读」的展开：单元测试怎么跑、每个文件测什么、现场核对怎么做、升级 Harness 后先看什么。

前提只有一个 Node ≥ 22.15（`package.json` 的 `engines`；两个工具要 zstd。`PATH` 上没有 `node` 时用 Harness 自带的运行时：`<Harness 安装目录>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`；插件**运行时**不加载本仓库的 Node，它跑在 Harness 自带运行时上）。运行时依赖 `@deepseek-ai/schemastery`、契约测试依赖真实 Host 库（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-app-boot`）都按精确版本锁在 `package.json`（后两者只给测试用），全新克隆先 `npm install`。测试不启动 Harness、不要凭据或网络；现场核对另需一个已启用本插件的运行中 Harness。

单元测试 —— 190 项（`config-schema` 10 · `route-policy` 32 · `plugin` 29 · `host-contract` 17 · `docs` 13 · `opencode-header` 31 · `subagent-steer` 22 · `read-session` 5 · `verify-session` 12 · `package` 7 · `patch` 8 · `maintainer-docs` 3 · `tarball` 1；在 Node 25.8.0 上验证）：

```powershell
npm install
npm test
```

`npm test` 就是 `node --test "test/*.test.mjs"`（显式 glob；替身与 helper 放 `test-support/`）。测试、`test-support/` 与 `.agents/notes` 的决策记录都在 `files` 里，所以打包产物上 `npm install && npm test` 跑出同一个数字。每个文件都可单跑（`node --test test/<名字>.test.mjs`），职责：

- `test/config-schema.test.mjs` —— 配置接口：原生 schema 图、接受/拒绝的取值域、省略字段的解析、刻意留给 `plugin.js` 的空档；
- `test/route-policy.test.mjs` —— 策略：两种 source、默认项、指定路由原样放行（含半条路由、非字符串值、清单读不出来）、`defaultModel` 覆盖与失效、Settings 行的所有不可用形态、两个豁免；
- `test/plugin.test.mjs` —— 接缝与组合：真实 Cordis 替身（`test-support/host-doubles.mjs`）上的安装、两种还原、治愈上一代遗留 shadow、装在我们之上的包装、通知去重；
- `test/host-contract.test.mjs` —— Host 契约：对着锁死的库断言 proxy 陷阱、descriptor 落点、`ctx.effect`、Schemastery 行为与 `Config` 投影；契约表五条各有测试点名；
- `test/opencode-header.test.mjs` —— 会话头那一行：三条 gate（作用域、`POST`、provider 前缀或网关域名）、同名头被替换、不改调用方对象、派生值的 UUID 形状与钉死的向量、同一会话跨请求恒定而不同会话不碰撞、判断失败时透传而传输层异常照抛、懒 pull 的流式作用域、并发会话互不串号、订阅是 `global` 的（真实 Cordis 上把一个 isolate 到别的作用域的 llm 运行时接进来）、四个配置键的默认与拒绝、装卸的引用计数；
- `test/subagent-steer.test.mjs` —— 转向那一行：两个工具的 raw 定义与渲染器、`execute` 自己兜的必填与调用方、转发给服务的参数与文本块、guard 的弃权面（存活队友名、`lead`、解析到 id 版、别的工具、无调用方、缺 `agentTeams`、名单读失败、target 不可用）与唯一那条拒绝（点名 `list_agents` 与 `send_subagent_message`）、prompt 段随可见性说话、卸载时三样注册一起注销；另把「判据读注册表持有的形状」钉在 seed 上（`test-support/steer-doubles.mjs` 与 `test-support/json-schema-subset.mjs` 复刻真身的写入侧校验）；
- `test/docs.test.mjs` —— 文档守卫：README 的 `config:` 键被**该块自己那行**的 schema 声明（块里的 `name:` 决定认哪一份，每行各一份）、决定词在 `CONTEXT.md` 词表、相对链接与散文点名的仓库路径存在且随包、两份 README 章节同形同序；自带坏基线，每条判断都被喂一次改坏的真实文档证明它会红；
- `test/read-session.test.mjs` / `test/verify-session.test.mjs` —— 证据工具：自造多帧/坏尾帧日志跑读取器与 `verify`（含 child 日志缺失、child 目录里换一个格式版本或同时摆着两个版本、名字不是会话日志的文件不被当成日志、descriptor 与 header 不一致、期望越出冻结清单）；
- `test/package.test.mjs` / `test/patch.test.mjs` / `test/tarball.test.mjs` / `test/maintainer-docs.test.mjs` —— 分别钉 `exports` 与 `files` 一致（含组合包卡片的 `icon` 随包且画在官方 36×36 viewBox 上，另有一组坏基线证明读不出/画不出的 `icon` 会被报出来）、随包 patch（用 Host 自己的 API 读成三行 insert：`subagent-pin` 带 `source: settings`、`opencode-header` 与 `subagent-steer` 都不带 config，逐行对着它自己那份 schema 校验，不导出 schema 的那行则要求它不带 config；并按住行名的读法 —— 每行的地址要导出它自己的双语 locale 与 `package.json`，一行的标题/描述不得复述另一行，三行各自的 `icon` 要能被 Host 画出来、随包、且互不相同（见 `test-support/manifest-icon.mjs`））、真实 packlist 对拍 `files`（唯一动用 npm 的一项，不联网）、维护者文档（`AGENTS.md` 与 `.agents/notes/` 的笔记）里的引用。

现场核对 —— 人工执行，每项一次工具调用。生产证据无法自动化（日志要真跑才有），但读日志是一条命令：

```powershell
npm run verify -- --lead <lead 会话日志>   # 另有 --child / --expect / --default-model / --lead-expect
```

它从那次运行自己的 `subagent/model-selection-policy` 读出冻结清单，经 `subagent/catalog` 定位每个 child 的日志（Host 写成兄弟目录、以 childId 命名；文件名里的格式版本由目录里实际存在的那个决定，不写死），断言每个 child 的 `request/header` 与 continuable descriptor 落在默认项上。不读活 Settings、不启动 Harness —— 验的是那一次，不是现在。会话日志在 `$DSH_HOME/sessions/<项目目录>/<会话 id>/session.v<N>.jsonl.zstd`（`$DSH_HOME` 默认 `~/.dsh`，Windows 为 `%USERPROFILE%\.dsh`）。`<默认模型>` 指清单默认项；示例路由（`opencodego`、`deepseek-v4.1-flash`）是本环境的，请替换。

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
| OpenCode Go 会话头：值来自本行 | — | 路由里**不写** `x-opencode-session` 静态头，重启后用一个 `opencodego` 模型发一条消息 | 正常返回（网关收不到头会 400）：值只能来自本行，且是非原值的派生串。手写 `api:` 的路由在随包 pi-ai `^0.87.1` 上同样不会有上游发的同名头（为什么，见 [OpenCode Go 的会话头](opencode-header.md)） |
| OpenCode Go 会话头：每个会话一份 | — | 再开一个会话发一条，并起一个子代理 | 三处都正常返回；不同会话的派生值不同（要核对某个值属于哪次会话，本地用同一个摘要函数算一遍即可） |
| 转向行真的加载了 | — | 重启后看 `plugin_manager list_plugins` 里该行（本环境 `include:subagent-steer`）的 `fiberPhase`，再看 `Tool.listTools` | `fiberPhase: active`，且 `send_subagent_message` 与 `interrupt_subagent` 都在。`Config.listConfigs` 对该行报 `absent` 属正常（它不导出 `Config`，与有没有加载无关） |
| 转向行把死路改成指路 | — | 在 Team 会话里调 `send_message({ target: "<某个 uuid>", message: "…" })` | 收到一条点名 `list_agents` 与 `send_subagent_message` 的拒绝理由，而不是 `active teammate "…" not found` |
| 按 id 投递真的能唤醒子代理 | — | 用一个已结束的 continuable 子代理 id 调 `send_subagent_message({ agent_id, message })` | 它真的重新开始一轮，并把结果发回（它那一侧一直解析到 id 版 `send_message`） |
| Harness 升级后的投影契约（先看这一行） | — | 用 `Config.listConfigs` 查 `entry: include:subagent-pin`（离线部分由 `test/host-contract.test.mjs` 钉住，`status` 只有活 Host 看得到） | `status: "schema"` 且 `limitations: []`；`provider` 带 `minLength: 1`，`defaultModel` 带 `required: [provider, model]`，`source` 带 `default: "settings"`，`reasoningEffort` 带七个 level |

升级 Harness 后先看最后一行，再跑整张表。转向那三行是**带删除条件的前修复**：三条判据在 README「何时删掉这一行」，上游修好后连同这一行的代码、测试与文档一起删，本节这三行核对项也随之删掉。四点注意：

- 契约测试对着**锁死的三个包**跑 —— `@deepseek-ai/schemastery`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-app-boot`（本环境：3.18.4 / 4.0.4 / 0.2.0-rc.2，读自 asar 内 `/dsh/node_modules/@deepseek-ai/*/package.json`），必须与随包 Host 同版本，否则测的是另一个 Host。**`npm view <包> version` 会骗人** —— 它给 `latest` 标签，本环境的 latest 是更旧的 0.1.0-rc.6，所以 `devDependencies` 必须写精确版本；升级时核对三个版本、重跑单元测试。
- `Config` 用本仓库自己锁定的 schemastery，校验不经过 Host 那份，**版本号不同本身不会让插件挂掉**；但 Host 的 `createConfigProjector` 按跨版本契约读图的节点形状（`type`/`meta`/`dict`/`inner`/`list`），`limitations` 非空或 `status` 不再是 `schema` 即为投影退化。
- 一处不靠包版本的耦合：`config-schema.js` 的 `THINKING_LEVELS` 就是 pi-ai profile `reasoning` 字段那组词 —— Host 新增 level 要在这里补上，否则 schema 会拒掉 Host 已认识的强度。
- pi-ai 是随包版本，不在那三个包里：本环境（`0.2.0-rc.2`）随包 `^0.87.1`，那条 catalog wrapper 因此**在场**；`0.2.0-rc.1` 随包的还是 `^0.85.1`，那时 `opencode-headers.js` 还不存在。升级后把 `docs/opencode-header.md` 那张会话头路径表对着实际随包的那一份重读：本行的设计**不依赖**「wrapper 不在场」（理由见[升级了也不跟着走](../.agents/notes/implemented/architecture/2026-09-29-升级了也不跟着走.md)），所以升级不会让这一行失效，但表里「今天成立吗」一列的措辞要跟着随包版本改。

辅助工具：`tools/read-session.mjs` 切分日志里拼接的 zstd 帧（单次解压只得第一帧，坏尾帧只损失它自己），第二参数按**完整** type 过滤，每条事件整条打印成可解析的一行 JSON；`verify` 从包外调用走 `exports` 的 `./verify` 入口。禁用时的拆包装有单元测试覆盖，并在本环境现场观察过：DSH 在 unload 时执行该行的副作用，shadow 在运行中的进程里被删掉。
