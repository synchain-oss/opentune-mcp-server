[English](README.md) | **简体中文**

[![License](https://img.shields.io/github/license/synchain-oss/opentune-mcp-server?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/status-pre--release-orange?style=flat-square)](#状态)

<!-- badge 行遵循组织模板(synchain-oss/.github 的 branding/badges.md):同顺序、flat-square。
     Build、Release、npm、node 这几个 badge 要等对应的 workflow、Release 与 npm 包真实存在后再加。
     不预告任何尚未发布的东西。 -->

# OpenTune MCP Server (by Synchain)

> 一个让 AI agent 操作开源 AI 人声修音软件 OpenTune 的 MCP 服务,并把每一步操作的结果以清晰、结构化的形式报告出来。

OpenTune MCP Server 是由 [Synchain](https://www.synchain.ca) 主导的开源项目,以 [MIT 许可证](LICENSE) 发布。它是一个与 OpenTune 通信的独立程序,不是 OpenTune 本身的一部分。

## 状态

> **预发布。** 服务、工具与协议规范都在本仓库里,但还没有发布 npm 包、MCPB 包或 Release;下文的安装命令要等首个版本发布后才能用。工具名称与行为在此之前仍可能调整。

| 环境 | 状态 |
| --- | --- |
| Windows x64,配合 [synchain-oss/OpenTune](https://github.com/synchain-oss/OpenTune) 的非官方 OpenTune 测试版(带控制接口) | 支持。 |
| 官方 OpenTune 发布版(没有控制接口) | 不能用:`opentune_get_status` 报告 `NO_API_BUILD`。配置指向测试版、但实际开着的是官方 OpenTune 时,报告 `RUNNING_WITHOUT_API`。 |
| macOS | 暂无。 |
| Linux | 不支持:OpenTune 本身没有 Linux 版。 |
| WSL | 服务必须用 Windows 上的 Node.js 运行,见 [WSL](#wsl)。 |

DAW 内的 OpenTune VST3/ARA 插件不在范围内,只覆盖 OpenTune 独立版。

## 前置条件

- **Node.js 22 或更高**(MCPB 包不需要,Claude Desktop 用自带的运行时运行它)。
- **已安装官方 OpenTune,1.7.9 或更新。** 测试版不含模型与 Direct3D 12 运行库,使用官方安装里的那一份。OpenTune 1.7.9 须装在默认位置,因为它的模型在安装目录下;OpenTune 1.8.1 可以装在任意位置,模型在 `%ProgramData%\OpenTune\Models`。
- **非官方测试版**,是一个 zip,解压到 Program Files 之外的文件夹。确认 `opentune-control.json` 就在 `OpenTune.exe` 旁边。
- **`OPENTUNE_MCP_OPENTUNE_PATH`** 设为测试版里 `OpenTune.exe` 的绝对路径。下面的安装片段会替你设好。

运行 `opentune-mcp doctor` 可以检查以上全部(它不会启动 OpenTune);它报告的每一项检查在 [docs/TROUBLESHOOTING.zh-CN.md](docs/TROUBLESHOOTING.zh-CN.md) 里都有对应小节。

## 首次启动

OpenTune 在全新数据目录下首次启动时,会弹出一次「首次引导」(onboarding)对话框,需要有人在 OpenTune 窗口里回答一次。该对话框(或任何其他模态对话框)开着时,所有写操作都会失败,返回 `BUSY`(原因 `modal_open`)。回答完对话框再重试即可。

## 安装

`opentune-mcp doctor --client <claude-code|claude-desktop|cursor>` 会打印该客户端的配置,并填好你自己的路径;它只打印,从不写客户端的配置文件。下面的片段就是它在 Windows 上打印的内容,其中 `C:\Users\user\Apps\OpenTune\OpenTune.exe` 代表你的测试版路径。

**Claude Desktop(首推):MCPB 包。** 从 [GitHub Releases](https://github.com/synchain-oss/opentune-mcp-server/releases) 页面下载 `opentune-mcp-<version>.mcpb` 与对应的 `.sha256` 文件,核对校验和,打开 `.mcpb` 文件(或拖进 设置 > 扩展)并选择安装。在扩展设置里把「OpenTune executable」设为测试版的 `OpenTune.exe`。详见 [docs/install.md](docs/install.md)。进阶:用 `opentune-mcp doctor --client claude-desktop` 手动注册 npm 包。

**Claude Desktop:skills。** Claude Desktop 的聊天不会运行 Claude Code 插件里的 MCP 服务,所以它的工具来自上面的 MCPB 包。工作流程指引另行提供:从同一个 Release 解压 `opentune-skills-<version>.zip`,把里面的每个 zip 分别作为 skill 上传到 Claude 的设置里。这些 skill 只是说明,实际操作要经 MCP 工具完成,所以在装了 MCPB 包的地方才有用;浏览器里的 claude.ai 没有本机工具。

**Claude Code(首推):插件。** 插件包含 MCP 服务和指导修音流程的 skill,需要 `PATH` 上有 Node.js 22 或更新版本。在终端里运行下面两条命令一次(PowerShell 里写法相同)。`--config` 把「OpenTune executable」选项设为测试版的 `OpenTune.exe`;不写的话,可以之后在 `/config` 里设置,或者只使用你自己启动的 OpenTune。

```text
claude plugin marketplace add synchain-oss/opentune-mcp-server
claude plugin install opentune@synchain-opentune --config opentune_path=C:\Users\user\Apps\OpenTune\OpenTune.exe
```

marketplace 提供的是最新 Release 的插件,版本号与该 Release 的 npm 包、MCPB 包相同。更新不会自动安装:运行 `claude plugin update opentune@synchain-opentune`,或者在 `/plugin` 里为 `synchain-opentune` marketplace 打开自动更新。会话里的工具名形如 `mcp__plugin_opentune_opentune__<工具>`。

**不用插件的 Claude Code:** 在终端里运行一次。`--scope user` 让服务在所有项目里可用(去掉则只注册到当前项目)。Windows 上命令写成 `claude.cmd`,因为 PowerShell 否则会运行 `claude.ps1`,它会吞掉 `--`,并报 `missing required argument`(见[排障](docs/TROUBLESHOOTING.zh-CN.md#claude-code-mcp-add-fails-in-powershell));macOS 与 Linux 写 `claude`。

```text
claude.cmd mcp add opentune --scope user -e OPENTUNE_MCP_OPENTUNE_PATH=C:\Users\user\Apps\OpenTune\OpenTune.exe -- cmd /c npx -y @synchain/opentune-mcp
```

**Cursor:** 把下面的内容放进 `~/.cursor/mcp.json`(所有项目)或 `.cursor/mcp.json`(单个项目):

```json
{
  "mcpServers": {
    "opentune": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "@synchain/opentune-mcp"
      ],
      "env": {
        "OPENTUNE_MCP_OPENTUNE_PATH": "C:\\Users\\user\\Apps\\OpenTune\\OpenTune.exe"
      }
    }
  }
}
```

然后让 agent 检查 OpenTune。它会先调用 `opentune_get_status` 并照结果里的 `nextStep` 做;`opentune_launch` 会用控制接口启动配置好的 OpenTune。

## 示例提示

这些例子只是展示工具会做什么,不承诺修出来的人声听起来如何:请用耳朵判断结果,不满意就让 agent 换一组参数。

1. **「把第二句里跑调的音拉准。」** agent 调用 `opentune_get_project`(各片段及其版本号)、`opentune_analyze_pitch`(逐音符给出唱出的音高与目标相差多少音分,超过阈值的音符会被标出),再对该时间范围调用 `opentune_edit_notes` 或 `opentune_autotune_range`。结果按「改动前后的音分值」以及「能否撤销、如何撤销」来读。用 `dry_run` 可以只预测改动而不应用。
2. **「整体升高 2 个半音,然后导出。」** agent 调用 `opentune_set_clip`(移调 2 个半音,是一个撤销步骤)和 `opentune_export_audio`(kind 为 `clip`)。结果会写明生成的 WAV 文件;已有文件绝不会被覆盖,而是改用下一个空闲的名字。
3. **「把这一段整体提前 30 毫秒。」** agent 对该范围调用 `opentune_edit_timing`,做一次 `shift`,`delta_ms` 为 -30。OpenTune 不检测节拍:时间柄的位置由你给出,或由 `seed` 操作生成。结果会列出时间柄,并说明某次移动是否被限制(`CLAMPED`)。
4. **「打开 `C:\Music\take1.wav`,调到 C 大调。」** agent 调用 `opentune_open_audio`,用 `opentune_get_job` 跟踪导入直到分析结束,再用模式 `regenerate` 与 C 大调调用 `opentune_autotune_range`。较长的音频需要时间,见[要等多久](docs/COMPATIBILITY.md#how-long-to-wait)。

## 与 DAW 配合使用

只通过文件路径交换,没有 DAW 插件。

1. 在 DAW 里把干声导出为 WAV 文件。
2. 让 agent 在 OpenTune 里打开该文件、做修改,再导出 WAV(`opentune_export_audio`;不给 `path` 时写在源文件旁,名为 `<名字>.opentune.wav`)。
3. 把导出的 WAV 导回 DAW,放在新轨道上或替换原来的干声。

## WSL

服务必须用 Windows 上的 Node.js,因为 OpenTune 监听的是 Windows 的 `127.0.0.1`,WSL 访问不到:在 WSL 里 `opentune-mcp doctor` 的 `OT_WSL_RUNTIME` 检查会失败,`opentune_get_status` 会报告 `WSL_UNSUPPORTED_RUNTIME`。请把 MCP 客户端配置成用 Windows 的 Node.js 启动服务(上面的片段在 Windows 上就是这样配的)。工具调用里 `/mnt/c/Music/take1.wav` 形式的路径会被转换成 `C:\Music\take1.wav`。

## 它能做什么

OpenTune 会分析录好的人声,把它显示为音符与音高曲线,并用神经声码器重新渲染修正后的声音。本服务让 AI agent 通过 MCP 工具调用,执行人在 OpenTune 独立版窗口里能做的操作。完整列表见 [docs/reference.md](docs/reference.md)。

- **导入与导出:** 打开音频文件,把片段、轨道或整个混音导出为 WAV。
- **读取分析结果:** 音符、音高曲线、检测到的调性、分析与渲染状态,以及每个乐句的音高摘要,便于 agent 推理。
- **自动修音与音符编辑:** 对指定时间范围运行 OpenTune 的 AUTO 修正;设置音符的目标音高、按音分平移、吸附到音阶、调整回调速度、颤音与漂移;设置片段的调性与移调。
- **时间:** 把一段提前或延后,以及移动时间柄。
- **撤销与重做:** 经接口做出的改动会进入 OpenTune 自己的撤销历史(OpenTune 支持撤销的地方)。某个操作无法撤销时(OpenTune 本身就有些操作不能撤销),结果会写明,并尽可能给出还原的办法。

每次改动都返回结构化结果:改了什么(带单位的前后值)、副作用、警告、能否撤销,以及不能撤销时如何还原。目标不是判断人声「听起来对不对」,而是把 OpenTune 已有的操作提供给 agent,并清楚地报告其效果。

## 工作原理

```text
MCP 客户端(例如 Claude Desktop、Claude Code 或 Cursor)
   |  MCP over stdio
   v
opentune-mcp  (本仓库,Node.js,MIT)
   |  OTCP:JSON-RPC 2.0,每行一条 JSON 消息,TCP 127.0.0.1
   v
带控制接口的 OpenTune 独立版  (synchain-oss/OpenTune,AGPL-3.0)
```

- **两层结构。** 控制接口运行在 OpenTune 内部,使用一个小型、带版本的协议,即 OpenTune 控制协议(OTCP)。本服务把 MCP 工具调用转成 OTCP 请求,再把回复转成可读的结果。两者是独立的程序,所以本仓库不含任何 OpenTune 代码。
- **默认关闭。** 控制接口是一个构建选项。即使构建里包含它,OpenTune 也只有在被明确要求启用时才会打开它。
- **仅限本机。** OpenTune 只监听字面量地址 127.0.0.1,端口由操作系统分配,并且只有在用每次启动随机生成、存放在每用户发现文件里的令牌完成握手后才接受请求。本服务自己不开任何网络端口,只通过 stdio 与你的 MCP 客户端通信。
- **公开规范。** OTCP 规范(JSON Schema、示例与威胁模型)位于本仓库的 `spec/otcp/v1/`,采用 MIT 许可证。

## 已知限制

- **混合模式与小幅修正。** OpenTune 首选项里的「混合模式:小修用dsp,大修用声码器」(英文界面为 Hybrid Mode: Small corrections use DSP, large corrections use vocoder)默认开启。修正量中小于 75 音分的部分走 DSP 移调而不是声码器,这是 OpenTune 自身的设计,在真实人声上这种小修正可能几乎听不出来。想让小修正也明显生效,请在 OpenTune 首选项里关闭该项。见[混合模式](docs/TROUBLESHOOTING.zh-CN.md#hybrid-mode)。
- **`RUNNING_WITHOUT_API` 只做了人工核对。** 「运行着没开控制接口的官方 OpenTune」这一状态是人工验证的,没有自动化测试。
- **源目录只读。** 不给 `path` 的导出会写在源文件旁。该目录只读时导出会报错,不会自动换目录。请指定一个可写的 `path`。
- **首次启动需要人工操作。** 首次引导对话框需要有人回答一次([首次启动](#首次启动))。
- **不在范围内:** 没有控制接口的官方 OpenTune 构建、Linux、VST3/ARA 插件、OpenTune 窗口本身没有的功能,以及绘制式编辑(绘制、拉伸、拆分或合并音符、逐音符 EQ、手绘曲线)。

## 与 OpenTune 的关系

- [OpenTune](https://github.com/YuFeng926/OpenTune) 是一款开源的 AI 修音软件。OpenTune 是 DAYA STUDIO 的项目,采用 AGPL-3.0 许可证,唯一的官方发布渠道是 [YuFeng926/OpenTune](https://github.com/YuFeng926/OpenTune)。
- OpenTune 作者认可这一做法:我们在自己的 fork [synchain-oss/OpenTune](https://github.com/synchain-oss/OpenTune) 中开发控制接口,它是新增的代码,接口关闭时不改变 OpenTune 的行为;我们计划向上游项目提议合入。这不代表它成为 OpenTune 的官方功能,是否合入、如何合入由作者决定。
- 本仓库不含 OpenTune 源码,也不含模型权重。
- 在控制接口进入 OpenTune 官方发布版之前,打过补丁的构建是非官方测试版。它不含模型权重,使用你官方 OpenTune 安装里的模型。
- OpenTune MCP Server 是 Synchain 的项目,不是 OpenTune 或 DAYA STUDIO 的官方产品。

## 文档

- [docs/install.md](docs/install.md):MCP 客户端的安装配置,含 MCPB 包
- [docs/reference.md](docs/reference.md):工具参考,由服务生成
- [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md):哪些 OpenTune 版本、测试版与协议版本可以一起用,以及各操作要等多久
- [docs/TROUBLESHOOTING.zh-CN.md](docs/TROUBLESHOOTING.zh-CN.md)([English](docs/TROUBLESHOOTING.md)):错误、状态与 doctor 检查及处理办法
- [docs/real-opentune-testing.md](docs/real-opentune-testing.md):对真实 OpenTune 运行端到端检查
- `spec/otcp/v1/`:OTCP 规范

## 参与贡献

欢迎提 issue 与 pull request,中英文均可。请见 [CONTRIBUTING.md](CONTRIBUTING.md)(中文)与行为准则([中文版](CODE_OF_CONDUCT.zh-CN.md),以[英文版](CODE_OF_CONDUCT.md)为准)。每个提交都必须签署(`git commit -s`,DCO)。项目处于预发布阶段,开始较大的改动前请先开 issue。关于 [synchain-oss/OpenTune](https://github.com/synchain-oss/OpenTune) 中控制接口及其测试版的问题,也在本仓库跟踪。

## 安全

请按 [SECURITY.md](SECURITY.md) 的说明私下报告漏洞,不要在公开 issue 里提。本机控制通道、其令牌与文件路径处理都在范围内。

## 许可证

[MIT](LICENSE) © 2026 Synchain。`spec/` 下的 OTCP 规范同样采用 MIT 许可证。

OpenTune 采用 AGPL-3.0 许可证,不属于本仓库。OpenTune 使用的模型各有自己的许可证,其中一些为非商业用途;本仓库不分发其中任何一个。

## 相关项目

- [synchain-oss/OpenTune](https://github.com/synchain-oss/OpenTune):我们的 OpenTune fork,控制接口在其中开发
- [synchain-oss/synchain-cli](https://github.com/synchain-oss/synchain-cli):`@synchain/cli`,Synchain 命令行客户端
- [synchain-oss/synchain-bridge](https://github.com/synchain-oss/synchain-bridge):音频插件(VST3/AU),把 DAW 音频推送给远程协作者
- [synchain-oss/scvb](https://github.com/synchain-oss/scvb):Synchain Vocal Balancer,为人声编排自动平衡声像与电平(VST3)
- [synchain.ca](https://www.synchain.ca):Synchain 网站
