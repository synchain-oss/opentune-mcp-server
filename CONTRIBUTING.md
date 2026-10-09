# Contributing to OpenTune MCP Server

感谢你的关注。本仓库是 OpenTune MCP Server (by Synchain):一个经 MCP(stdio)让 AI agent 操作 OpenTune 独立版的本地服务,同时也是它与 OpenTune 之间的本机控制协议 OTCP 的规范所在地(`spec/otcp/v1/`)。项目处于预发布阶段,代码正在陆续加入;文中提到的 `npm run gates`、脚本与 CI 检查(如 `branch-gate`)随首批代码与 workflow 加入。issue 与 PR 都欢迎;开工之前请把本文读完 —— 尤其是 **§8 冻结契约**。较大的改动请先开 issue 讨论,不要写好一大段再来对齐设计。

## 0. 语言政策

- issue / PR 可以用**中文或英文**;维护者用你使用的语言回复。维护者内部沟通用中文。
- `README.md` 是英文,`README.zh-CN.md` 是它的**全量中文镜像**,两者的标题结构(层级与顺序)必须一致,由 CI 检查。改其中一份,必须在同一个 PR 里同步另一份。
- `docs/` 以英文为主;安装与排障文档另有中文版。
- 代码注释、工具名称与描述、MCP instructions 用英文。
- 本文件与 `CLAUDE.md` 用中文。

## 1. 行为准则

参与本项目即视为同意 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)(Contributor Covenant v2.1;中文译本见 [CODE_OF_CONDUCT.zh-CN.md](./CODE_OF_CONDUCT.zh-CN.md),**英文版为准**)。举报渠道:**contact@synchain.ca**。

## 2. 开发者原创声明(DCO)与署名

每个 commit 必须带 `Signed-off-by:` 尾行:

```
git commit -s
```

本项目采用 DCO,**不采用 CLA**。这条由 `branch-gate` 的 DCO 检查机器强制(PR → `dev` / `prod`;合并提交豁免)。忘签的补救:

```
git commit -s --amend     # 最后一个 commit
git rebase --signoff      # 一段区间
```

提交信息与 PR 标题、正文里**不要带 AI 工具的署名行**(例如把 AI 助手列为合著者(co-author)的尾行、会话链接尾行、「由某某 AI 生成」一类的标语)。你可以借助 AI 工具写代码,但提交由你签署、由你负责;`branch-gate` 会检查署名。

## 3. 分支模型

- 默认分支是 `dev`(研发分支);`prod` 是发布分支,版本 tag 打在 `prod` 上。两者都只由维护者在审核后合入。
- **内部贡献者**:主支线是 `feature/v1`;从它开 `feat/<任务ID>-<slug>` 子支线,PR 回 `feature/v1`。一张卡一条子支线一个 PR。主支线经维护者预览并明确批准后,才合入 `dev`。
- same-repo 的 PR:到 `dev` 只接受来自 `feat/*` / `feature/*`(外加 `dependabot/*`)的分支;到 `prod` 只接受 `dev`。
- **外部贡献者**:fork 本仓 → 用**任意分支名**(请不要用 `dev` / `prod` / `feature/v1`)→ PR 到 `dev`。
  - fork PR 只跑**无 secrets** 的检查,且需维护者批准 workflow run 后才开始跑。
  - AI review 不会对 fork PR 自动运行;需要时由维护者在 PR 上评论 `/review` 触发。
  - 维护者会手工加 `external` label。
  - 本项目**任何 workflow 都不使用 `pull_request_target`**,这是不接受个案豁免的安全禁令;请不要提交「加个 `pull_request_target` 就能给 fork PR 跑 bot 了」的 PR。

## 4. Commit 规范

`type(scope): 描述`,描述可中可英。type 取值:`fix` / `feat` / `docs` / `chore` / `refactor` / `test` / `ci` / `style` / `perf` / `revert` / `harden`。

## 5. 环境搭建

- Node.js ≥ 22、npm。代码加入后:`npm ci` 安装依赖,`npm run build` 产出单文件 bundle。
- 单元测试与契约测试**不需要安装 OpenTune**:它们跑在仓内的模拟 OpenTune(mock)上。
- 端到端测试需要带控制接口的 OpenTune 构建(Windows);测试一律使用临时数据目录,**不得读写你真实的 OpenTune 设置与发现目录**。

## 6. 提 PR 前的本地 gates

命令清单的单一真源是 [CLAUDE.md](./CLAUDE.md) §2,本节只是转述。一键命令 `npm run gates` 随首批代码加入,覆盖:

lint · 格式检查 · 类型检查 · 单测与覆盖率 · 构建 · 协议冒烟(stdio `tools/list`)· 契约向量 · `tools/list` 体积门禁 · bundle 形状 · `npm pack --dry-run` · `npm audit` · gitleaks · 隐私 · 署名与身份 · token 金丝雀 · 输出预算 · 文档一致性

它输出一张带提交 SHA 的 PASS / FAIL / SKIP 表,请把这张表贴进 PR。

子 PR(base = `feature/**`)上 CI 只跑轻量档(lint、类型检查、单测、合规、署名);完整套件只在 PR → `dev` / `prod` 与 push 到主支线时跑。所以**本地 gates 是子 PR 的第一道门**,请不要不跑就提。

## 7. 评审流程与期望响应时间

- 维护者一般在 3 个工作日内首次响应;小改动更快,大改动请先开 issue 对齐。
- 每个 same-repo PR 都会跑自动化 review。**处理完所有 comment,不止 bot 的**:行内评论、review 正文与总结里的条目都算,逐条回复、修改或说明不改的理由,然后 Resolve。bot 的意见不必照单全收,但必须回应。
- 未解决的对话会阻止合并。PR 的合并由维护者执行,不使用 auto-merge。
- 安全问题**不要**开公开 issue,走 [SECURITY.md](./SECURITY.md)。

## 8. ★ 冻结契约:哪些 PR 一定不会被接受

**契约面**:`spec/**`(OTCP 规范)、`test/golden/**`(工具目录、输出与摘要的 golden)、MCP instructions 快照。改动其中任何一处,必须在**同一个 PR** 里附上变更文档 `docs/contract-changes/<YYYYMMDD>-<slug>.md`,并先获维护者明确同意。`branch-gate` 在 PR → `dev` / `prod` 上机器检查这一条;子 PR 不跑 `branch-gate`,同样要自觉附上。

以下改动不会被接受:

- **不兼容的协议改动**:删除或改名 OTCP 方法与字段、改变字段语义或单位。这类改动只能进入新的主版本。错误类别、告警码与原因码的注册表**只追加**,客户端必须接受未知代码。
- **工具改名**:工具名(`opentune_*`)在首个 npm 版本发布后冻结;确需改名时,旧名先以 deprecated 形式保留一个 minor 版本。
- **往 stdout 写入 MCP 协议帧以外的任何内容**(日志与诊断一律走 stderr)。
- **让控制令牌或 server proof 出现在**工具结果、日志、错误信息、`doctor` 输出或进度信息里。
- **让工具输入影响**被启动的程序、启动参数或环境变量;让本服务监听网络端口,或连接 `127.0.0.1` 以外的地址。
- **给发布包加入运行时依赖或安装生命周期脚本**(发布包是无依赖的单文件 bundle)。
- **把 OpenTune 的源码、内部标识符或内部结构复制进本仓**(本仓是 MIT,OpenTune 是 AGPL-3.0,两者必须保持隔离)。
- **加入模型权重,或新增音频文件**(`test/fixtures/vocals/` 下附授权声明的测试人声除外)。
- **降低安全相关测试的覆盖**。

## 9. 发布流程(仅维护者)

- 版本号真源是 `package.json`;遵循 SemVer;`CHANGELOG.md` 采用 Keep a Changelog 格式。
- `dev` → `prod` 经维护者审核批准。在 `prod` 上推 `vX.Y.Z` tag 触发 `release.yml`:校验 tag 与 `package.json` 一致且位于 `prod` → 全套门禁 → bundle、`npm pack`、sha256、MCPB 包、`server.json` → 草稿 Release → `npm-publish` 环境由维护者人工批准 → npm 发布(带 provenance)→ Release 转正。
- 首个 npm 版本由维护者在本地发布 CI 构建、核对过 sha256 的 tarball(npm 无法经 OIDC 创建新包);之后的版本一律经 CI 的 npm trusted publishing 发布。
- OTCP 规范单独打 `spec-vMAJOR.MINOR.PATCH` tag(预发布为 `-rc.N`),与服务的版本号相互独立。
- MCP Registry 等目录:等 OpenTune 官方发布版内置控制接口之后再上架。
