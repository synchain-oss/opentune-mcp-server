# CLAUDE.md —— OpenTune MCP Server 工作规范

本文件是在本仓库内工作的 AI 编码代理与贡献者的常驻规范;与维护者的明确指令冲突时以维护者为准。仓库目前只有文档:文中提到的脚本(`npm run gates`、`scripts/*`)、workflow 与检查(`mcp-gate`、`branch-gate` 等)随后续 PR 陆续加入,加入之前按 §2 末条做人工检查。

## 0. 基本约定

- 项目一句话:OpenTune MCP Server (by Synchain) 是一个经 MCP(stdio)让 AI agent 操作 OpenTune 独立版的本地服务;它通过本机控制协议 OTCP(JSON-RPC 2.0 + NDJSON,TCP 字面量 `127.0.0.1`)与带控制接口的 OpenTune 构建通信。本仓同时是 OTCP 规范(`spec/otcp/v1/`)的真源。
- 核心原则:不追求「AI 能否把音修好」,而是保证 ① AI 能执行 OpenTune 独立版界面里已有的操作,② 每个操作的结果清晰(结构化、可理解)。
- 技术栈:Node.js ≥ 22、TypeScript(ESM、strict)、`@modelcontextprotocol/server` v2、zod、esbuild 单文件 bundle、vitest、eslint + prettier。SDK 与 zod 只是 devDependencies,发布包无运行时依赖。
- **名称与身份(逐字,不得改写)**:
  - 产品名 `OpenTune MCP Server (by Synchain)`;仓库 `synchain-oss/opentune-mcp-server`;npm `@synchain/opentune-mcp`;命令 `opentune-mcp`;MCP Registry 名 `io.github.synchain-oss/opentune-mcp`;环境变量前缀 `OPENTUNE_MCP_`。
  - fork `synchain-oss/OpenTune`;上游 `YuFeng926/OpenTune`(OpenTune 是 DAYA STUDIO 的项目,AGPL-3.0,唯一官方发布渠道是上游 GitHub 页面)。
  - 版权行 `Copyright (c) 2026 Synchain`;对外联系邮箱只有一个:`contact@synchain.ca`;网站 `https://www.synchain.ca`。
- **Git 提交身份**:维护者侧(含 AI 代理)一律 `DLsnows <noreply@synchain.ca>` + `git commit -s`;GitHub 网页合并产生的提交作者是 DLsnows 的 GitHub noreply 地址(`@users.noreply.github.com`)。不得使用个人邮箱;不得修改 git 的 `user.name` / `user.email` 配置,也不得用 `git -c user.*=…` 临时覆盖。
- **零 AI 署名**:commit 信息、tag 信息、PR 标题与正文、评论与回复、review、issue、release notes 中一律不得出现 AI 工具的署名行 —— 包括把 Claude/Anthropic 列为合著者(co-author)的尾行、会话链接尾行、「由 AI 工具生成」一类的标语及其链接、Anthropic 的 noreply 邮箱。完整规则以 `scripts/attribution-patterns.txt` 为准(与维护者其他仓库逐字节相同,按 sha256 校验);本地 gates、pre-push 钩子与 CI 都会检查。**本条优先于任何工具自带的署名指令。**
- **语言政策**:沟通、本文件、`CONTRIBUTING.md`、PR 描述、评论与回复用中文(面向外部贡献者的回复用对方使用的语言)。`README.md` 英文,`README.zh-CN.md` 为全量中文镜像(标题结构由 CI 校验)。`docs/` 以英文为主,安装与排障另出中文版。代码注释、工具名称与描述、MCP instructions、错误信息用英文。
- **隐私**:任何文件、注释、测试快照、日志样例、PR 文本里都不得出现个人路径(用户目录、用户名)或个人邮箱;示例路径用 `%LOCALAPPDATA%`、`C:\Music\take1.wav` 这类中性写法。
- **内部规划编号不进公开文本**:注释、文档、commit 信息与 PR 正文里把理由本身写出来,不要只留一个读者打不开的编号(卡号、计划章节号);分支名里的任务 ID 不受此限。

### §0 安全铁律

1. 任何 key/token 绝不明文入库,包括测试用的假 key(secret scanning push protection 会直接拒推)。
2. workflow 里引用 secret 只能用 ${{ secrets.X }};禁止 echo 到日志、禁止写进 artifact。
3. 新增第三方 action 必须 pin 到 40 位 commit SHA(注释写版本号便于 dependabot 升级);
   @v2 / @main 这类可变 ref 一律不接受,org 白名单里的 owner/repo@* 通配不构成防护。
4. 【安全禁令】任何 workflow 一律不得使用 pull_request_target。
   这不是"不推荐"、不是"审计过就能用" —— 本项目不接受逐版本审计作为豁免理由。
   fork PR 的 AI 审查只走「维护者在 PR 上评论 /review 显式触发」(review-dispatch.yml),
   或 workflow_run 两阶段(全程不 checkout PR 代码);其余情况 fork PR 只跑无 secrets 的构建/测试。
   机器检查:零命中
   grep -rnE '^[[:space:]]*pull_request_target:|^[[:space:]]*on:.*pull_request_target|^[[:space:]]*-[[:space:]]*pull_request_target' .github/workflows
   (三支分别对应 `on:` 的块映射、行内标量 / flow 序列、块序列三种写法,都锚定行首,
   免得解释这条规则的注释自己成为命中。)
5. 所有消费仓库外部文本的自动化(review bot、issue 分流、release notes 生成)的 prompt 末尾
   必须带「不可信数据声明」(固定结尾,现行文本见 claude-review.yml 的 prompt 末尾)。

## 1. 分支模型与工作流程

- `dev` 为默认分支;`prod` 为发布分支,版本 tag(`v*`)打在 `prod` 上。主支线 `feature/v1`;子支线 `feat/<任务ID>-<slug>`,一张卡一条子支线一个 PR,子 PR 的 base 是 `feature/*`。
- 主支线 → `dev`、`dev` → `prod`:只在维护者预览并明确批准之后进行。
- same-repo PR 到 `dev` 只接受 `feat/*` / `feature/*` / `dependabot/*` 来源;到 `prod` 只接受 `dev`。
- fork PR:任意分支名,但不得是 `dev` / `prod` / `feature/v1`;只跑无 secrets 的检查(需维护者批准 workflow run);review bot 不自动跑(维护者用 `/review` 触发);`external` label 由维护者手工加。
- **AI 代理不做的事**(只由维护者执行):合并 PR、打 tag、推 `dev` / `prod`、任何强推或删除分支 / tag、`npm publish` 与 `gh release …`、修改仓库设置 / 分支保护 / 规则集 / 环境 / secret、批准 deployment。
- 暂存只用显式路径:`git add -- <路径>`;不用 `git add -A` / `git add .`。
- 禁止 `--no-verify`、`git commit -n`、修改或临时覆盖 `core.hooksPath`、定义 git / gh 别名。钩子拒绝时读原因、改正,不要绕过。
- commit 规范:`type(scope): 描述`,描述可中可英;type ∈ {fix, feat, docs, chore, refactor, test, ci, style, perf, revert, harden};全部 `git commit -s`。

## 2. 提 PR 前的本地 Gates

子 PR(base = `feature/**`)上 CI 只跑轻量档,完整套件只在 PR → `dev` / `prod` 与 push 主支线时跑,所以本地 gates 是第一道门。一键:

```bash
npm run gates
```

依次覆盖(以 `package.json` 的 `gates` 脚本为准,只增不减):lint · `format:check` · typecheck · vitest 覆盖率 · build · 协议冒烟(stdio `tools/list`)· 契约向量(对 mock)· `tools/list` 体积门禁 · bundle 形状(无依赖、无脚本、精确文件清单)· `npm pack --dry-run` · `npm audit` · gitleaks · 隐私 · 署名与身份 · token 金丝雀 · 输出预算 · 文档一致性。输出一张带提交 SHA 的 PASS / FAIL / SKIP 表,贴进 PR。

- SKIP 必须写明原因;不得把 FAIL 改成 SKIP 来过关。
- 新增的守卫要有「删掉它就会变红」的证明;不写恒真的判据。
- `npm run gates` 加入之前(仓库只有文档时),至少确认:README 中英标题结构一致、无个人路径 / 个人邮箱、无 AI 署名。

## 3. 评审规则

- **处理完所有 comment,不止 bot 的**:行内评论、review 正文、总结里的条目,所有提交 SHA 上的都算。逐条回复、修改或说明不改的理由,然后 Resolve。bot 的意见不必照单全收,但必须回应。
- 未解决的对话会阻止合并(`dev` / `prod` / `feature/v1` 都要求对话已解决)。
- 一轮修复一次推送:把本轮接受的修改一起提交、跑 gates、只推一次,避免每条评论各推一次触发多轮 review。
- 合并前置:head SHA 上的 Claude review 成功完成并发出总结;所有线程都已处置;该 SHA 的检查全绿。只有维护者能豁免 review。
- review 分级:【红旗】必须解决;【重要】逐条裁决;【建议】可顺手修或记账。

## 4. 各 Workflow 触发范围一览

> 规划中的清单;workflow 文件随后加入,以 `.github/workflows/` 实际内容为准。dev / prod 的必需检查只有 `mcp-gate` 与 `branch-gate`;review bot 永不设为必需。

| workflow | 触发 | 说明 |
| --- | --- | --- |
| `ci.yml` | PR → `dev` / `prod`(完整);PR → `feature/**`(轻量:单条 ubuntu 跑 lint / 类型检查 / 单测 / 合规 / 署名);push → `dev`、`feature/**`(完整) | `checks`(ubuntu × Node 22/24 + windows × Node 24;覆盖率在 ubuntu Node 24 上强制)、`protocol`(ubuntu + windows:stdio `tools/list` 对 golden、Inspector CLI `--strict`、契约向量对 mock、场景转录、instructions 快照、token 金丝雀、体积门禁、每个 op / 动作枚举值至少一个成功向量、规范方法闭包)、`package`(bundle 形状;空目录安装 tarball 后 `tools/list`;`mcpb validate`)、`audit`(含 devDependencies)、`compliance`(gitleaks、reuse lint、隐私、禁止新增音频文件、署名)、`docs`(README 中英结构一致、`docs/reference.md` 与生成结果一致、每个错误 kind / 状态 / doctor 检查 ID 都有 TROUBLESHOOTING 锚点);聚合 job `mcp-gate`(`if: always()`,唯一必需的 CI 检查) |
| `branch-gate.yml` | PR → `dev` / `prod`(含 `edited`) | 分支命名(`dev` ← `feat/*` / `feature/*` / `dependabot/*`;`prod` ← `dev`)、fork 来源规则、DCO(豁免合并提交)、冻结契约守卫(§5)、PR 正文与提交的署名检查、same-repo PR 的提交身份白名单。job 名固定为 `branch-gate`,不加 `if:` |
| 署名检查 | PR → `feature/**`(含 `edited`) | 只做署名检查,结果汇入 `mcp-gate` |
| `claude-review.yml` | 所有 same-repo、非草稿 PR(dependabot 经 `allowed_bots`) | 无 `id-token`;action 锁定 release SHA;中文分级;MCP 专项:stdout 污染、schema 兼容、描述即 prompt、路径与覆盖、提示注入、回环与 token、错误可操作性、结果清晰约定;不给 `gh pr comment` 写通道;prompt 末尾带不可信数据声明 |
| `review-dispatch.yml` | `issue_comment`:`/review`,评论者 ∈ {OWNER, MEMBER, COLLABORATOR} | fork PR 的人工触发 AI review;diff 碰到 `.github/workflows/` 即中止 |
| `pr-agent.yml` | pull_request | 仓库变量 `ENABLE_PR_AGENT == 'true'` 才运行(默认关);永不设为必需 |
| `release.yml` | push tag `v*`;`workflow_dispatch`(在分支上永远 dry-run) | build job(无 `id-token`):tag 与 `package.json` 一致且位于 `prod`、经 `workflow_call` 跑全套 gate、bundle / pack / sha256 / MCPB / `server.json`、生成的正文过署名检查、草稿 Release;publish job(唯一带 `environment: npm-publish` 与 `id-token: write` 的 job):`sha256sum -c`、幂等守卫、`npm publish --provenance`、Release 转正 |
| `dependabot.yml` | – | actions 每月;npm 每月分组;每个生态同时最多一个分组 PR |

- workflow 顶层默认 `permissions: contents: read`,需要更高权限的只在 job 级声明。
- 必需检查的 job 不加 `paths:` 过滤、不加 `if:`;矩阵结果经聚合 job 汇总。
- org 的 action 白名单只放行 GitHub 官方 action 与 `anthropics/claude-code-action`、`qodo-ai/pr-agent`、`softprops/action-gh-release`、`oven-sh/setup-bun`;用别的第三方 action 会让整个 run 直接 `startup_failure`(没有日志)。先考虑用 `run:` 步骤自己实现。
- 二进制工具(gitleaks、mcp-publisher 等)用脚本下载,版本与 sha256 写在仓内钉版文件里,workflow 与脚本一律从文件读,不写版本号字面量。
- 成本纪律:runner 就低不就高。

## 5. 契约变更规范(`spec/**` 与其他冻结面)

**冻结面**:`spec/otcp/v1/**`(OTCP 规范:`PROTOCOL.md`、`methods/*.schema.json`、`vectors/`、`SECURITY.md`、`LICENSE`、`CHANGELOG.md`)、`test/golden/**`(工具目录、输出与摘要的 golden)、MCP instructions 快照。

改动冻结面必须:① 先获维护者明确批准;② 在**同一个 PR** 里写变更文档 `docs/contract-changes/<YYYYMMDD>-<slug>.md`(背景、逐文件改动表、新旧客户端与服务端如何互通);③ 改 `spec/**` 时同步 `spec/otcp/v1/CHANGELOG.md`。机器强制 = `branch-gate` 的冻结契约守卫(只在 PR → `dev` / `prod` 上跑);子 PR 不跑 `branch-gate`,同样要自觉附上变更文档。

- **只有规范卡改 `spec/**`**。实现卡发现规范需要改动时,停下来,在 PR 描述里写明需要的规范改动,交维护者决定;不要在实现 PR 里顺手改规范。
- 版本:规范单独打 tag `spec-vMAJOR.MINOR.PATCH`(预发布 `-rc.N`),线上只传 `MAJOR.MINOR`;minor 只做追加,删除 / 改名 / 改语义或单位只能进新的 major。错误类别、告警码、原因码的注册表只追加,客户端必须接受未知代码。每个方法与向量标注 `capability` 与 `since`;方法 schema 用 JSON Schema 2020-12。
- fork 在 `Tests/Control/spec/otcp/v1/` 放逐字节副本,并用 sha256 锁定(`.github/spec.lock`);不要直接改 fork 里的副本,由维护者同步。所以规范文件必须 LF 行尾、UTF-8、无 BOM。
- 覆盖闭包:`spec/otcp/v1/methods/*.schema.json` 里的每个方法都必须出现在某个工具声明的 `otcpMethods` 里,或在带理由的「不暴露」清单中(单测强制)。
- 工具面:名称匹配 `^opentune_[a-z0-9_]+$`,首个 npm 版本发布后冻结,改名先以 deprecated 形式保留一个 minor;描述 ≤ 600 字符、以 `OpenTune (audio vocal pitch editor): ` 开头;全部 `openWorldHint: false`;每个工具声明所需能力,缺失时返回可操作的错误;只有 `opentune_get_status` 设 `alwaysLoad`;`tools/list` 总量 ≤ 46 KB、单工具 ≤ 4 KB(`opentune_edit_notes` ≤ 9 KB)。返回写信封的工具共用一个宽松的 outputSchema(只列顶层键、无 enum、≤ 600 B),完整结构只在规范 schema 里,由 vitest 对 mock 与向量强制。

## 6. 环境与依赖

| 项 | 值 |
| --- | --- |
| 运行时 | Node ≥ 22(CI 矩阵 22 / 24)、npm |
| 打包 | esbuild → `dist/opentune-mcp.mjs`(ESM、`platform: node`、`target: node22`、带 shebang);发布包无依赖、无生命周期脚本;`THIRD-PARTY-NOTICES.md` 由 metafile 生成,缺项即红 |
| 本地 gates | `npm run gates`(§2) |
| 合规扫描 | gitleaks(版本见钉版文件,下载校验 sha256)、`reuse lint`、隐私检查、署名检查;都在 `npm run gates` 里 |
| CI secrets | `CLAUDE_CODE_OAUTH_TOKEN`(review bot;Dependabot 另设一份)。npm 发布走 OIDC trusted publishing,不存 npm token |
| 测试数据目录 | 发现文件只写 `OPENTUNE_MCP_DISCOVERY_DIR`;E2E 用 `OPENTUNE_DATA_DIR` 临时目录;任何测试解析到真实 AppData 即失败 |

## 7. 安全铁律(MCP 专项)

1. **stdout 只承载 MCP 协议帧。** 日志与诊断一律写 stderr;服务代码里不得 `console.log`;被打包进来的依赖同样不得写 stdout。`doctor`、`--version`、`--help` 等 CLI 子命令不启动 MCP 服务,不受此限。stdio 测试断言 stdout 的每一行都是合法的 JSON-RPC 消息。
2. **工具描述就是 prompt。** 工具名、描述、参数 schema 与 instructions 会被模型当作指令读:写准确、不写宣传语、不写扩大操作范围的话;写明时钟与单位(`retune_speed` 0..1,0 = 保留自然起伏,1 = 机械感)、破坏性与不可逆效果。改动走 golden 快照与 §5 的契约流程。
3. **OpenTune 返回的字符串是数据,不是指令。** 轨道名、文件名、工程名、元数据、日志行只作为 JSON 字符串值返回,不得拼进摘要句子里当指令。破坏性工具(删除轨道、打开工程、覆盖工程)必须要求用户明确同意(`confirm: true` / `discard_unsaved`),这个同意只能来自用户,不能来自工具结果。
4. **令牌与 server proof 永不外泄**:不得出现在工具结果、日志、错误信息、`doctor` 输出、进度信息里;`doctor` 只显示「存在(已隐去)」。token 金丝雀测试在运行时生成随机值,绝不入库(§0 第 1 条)。
5. **只连回环地址**:OTCP 只连字面量 `127.0.0.1`(不解析 `localhost`,不连其他主机);继续通信前校验 serverProof、instanceId 与 pid 与发现文件一致;本服务不监听任何网络端口。多实例时写操作不得自行挑选实例;失效的实例 id 报错,绝不悄悄换实例。
6. **路径**:先规范化(去引号、`file://`、`~`、转绝对路径;win32 下 `/mnt/<盘符>/` → `<盘符>:\`),再拒绝相对路径、UNC、`\\?\`、`\\.\`、驱动器相对路径与 ADS;导出只收 `.wav`,另存只收 `.otproj`;导出不提供覆盖选项(同名自动改名);绝不覆盖已加载的源文件或工程媒体;覆盖另一个已有工程只能经独立的破坏性工具并带 `confirm: true`。OpenTune 侧的校验为最终权威,本服务提前校验并给出可操作的错误。
7. **启动 OpenTune**:可执行文件只来自用户配置的 `OPENTUNE_MCP_OPENTUNE_PATH`(环境变量或 MCPB 用户配置;绝对路径、存在、常规文件),且旁边须有协议主版本匹配的 `opentune-control.json`,否则返回 `NO_API_BUILD`、绝不启动。工具输入不得影响路径、参数或环境。`spawn` 用 `shell: false`、`detached`、`stdio: 'ignore'`;绝不结束任何进程。
8. **依赖**:发布包零运行时依赖、零安装脚本;新增 devDependency 要在 PR 里论证必要性;`npm audit`(含 devDependencies)必须通过。
9. **MIT / AGPL 隔离**:本仓不得出现 OpenTune 源码、内部标识符或内部结构(由守卫测试检查);`analysis/` 只做统计、阈值与乐句等 TS 侧计算,绝不重新实现分段(分段只在 OpenTune 侧)。仓内不放模型权重;不新增音频文件(`test/fixtures/vocals/` 下附授权声明的测试人声除外)。
10. **结果清晰**:每个写操作的结果都包含改动前后值、副作用、告警与撤销信息;不可撤销、破坏性或带未请求副作用的结果,必须在摘要第一句说明;能还原就必须给出还原方法。不可用的值返回 `null` 并附原因,绝不悄悄省略。

## 8. 测试规则

每新增或修改一个工具 / 一个 OTCP 调用 / 一处用户输入解析,必须同时补齐对应的测试:

| 改动类型 | 必补测试 |
| --- | --- |
| 新工具 / 改工具名、描述或 schema | `tools/list` golden、体积门禁、`docs/reference.md` 重新生成且一致 |
| 新的 OTCP 方法调用 | 契约向量(对 mock);每个 op / 动作枚举值至少一个成功向量 |
| 任何写工具 | 写信封渲染 golden(摘要、界面效果、副作用、撤销 / 还原行);「无关变化不冲突」的 `expected_revision` 用例 |
| 任何接受路径 | 路径用例:引号、`file://`、`~`、`/mnt/<盘符>/`、相对路径、UNC、`\\?\`、`\\.\`、驱动器相对、ADS |
| 任何输出 OpenTune 字符串 | 不可信字符串序列化用例(含提示注入样例) |
| 发现与连接 | 失效 PID(结合启动时间)、serverProof 不符、多实例、运行中但未开接口 |
| 新错误 kind / 状态 / doctor 检查 ID | `nextStep` 用例 + TROUBLESHOOTING 锚点 |
| 读结果 | 输出预算(800 音符的 mock 下单个结果 ≤ 20,000 字符) |

覆盖率门槛(vitest,在 ubuntu Node 24 上强制):全局 ≥ 85%;`sanitize/`、`errors/`、OTCP 分帧、`analysis/`、`render/` 每个文件 ≥ 90%。不达标 → CI 红,不得合并。
