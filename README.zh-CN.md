[English](README.md) | **简体中文**

[![License](https://img.shields.io/github/license/synchain-oss/opentune-mcp-server?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/status-pre--release-orange?style=flat-square)](#状态)

<!-- badge 行遵循组织模板(synchain-oss/.github 的 branding/badges.md):同顺序、flat-square。
     Build、Release、npm、node 这几个 badge 要等对应的 workflow、Release 与 npm 包真实存在后再加。
     不预告任何尚未发布的东西。 -->

# OpenTune MCP Server (by Synchain)

> 一个开发中的 MCP 服务:将让 AI agent 操作开源 AI 人声修音软件 OpenTune,并把每一步操作的结果以清晰、结构化的形式报告出来。

OpenTune MCP Server 是由 [Synchain](https://www.synchain.ca) 主导的开源项目,以 [MIT 许可证](LICENSE) 发布。它是一个与 OpenTune 通信的独立程序,不是 OpenTune 本身的一部分。

## 状态

> **预发布,开发中。目前尚未发布任何东西。** 本仓库还没有 npm 包、没有 Release,也没有可运行的服务。协议、工具名称以及下文描述的行为在首个版本发布前都可能调整。

| 项目 | 状态 |
| --- | --- |
| 本服务(`@synchain/opentune-mcp`,命令 `opentune-mcp`) | 尚未发布。协议规范、服务本体与测试正在陆续加入本仓库。 |
| 带控制接口的 OpenTune | 必需。OpenTune 官方发布版目前还没有控制接口。补丁版正在 [synchain-oss/OpenTune](https://github.com/synchain-oss/OpenTune) 中开发;在控制接口进入 OpenTune 官方发布版之前,会以明确标注的「非官方测试版」形式提供。 |
| Windows x64 | 首个目标平台。 |
| macOS | 暂无。不会发布 macOS 测试版;macOS 上计划在 OpenTune 官方发布版包含控制接口后可用(或自行从源码构建)。 |
| Linux | 不支持:OpenTune 本身没有 Linux 版。 |
| Node.js | 22 或更高(计划中的要求)。 |

**目前能用的:** 还没有任何可以安装或运行的东西。

**即使首个版本发布后也不能用的:** 没有控制接口的 OpenTune 官方构建、Linux,以及在 DAW 中使用的 OpenTune VST3/ARA 插件(只覆盖 OpenTune 独立版)。

## 它能做什么

OpenTune 会分析录好的人声,把它显示为音符与音高曲线,并用神经声码器重新渲染修正后的声音。本服务计划让 AI agent 通过 MCP 工具调用,完成用户在 OpenTune 独立版窗口里本来就能做的操作:

- **导入与导出**:打开音频文件(单个文件、多个文件顺序排列,或每个文件一条轨道),把片段、轨道或整体混音导出为 WAV。
- **读取分析结果**:音符、音高曲线、检测到的调性、分析与渲染状态,以及 agent 可以据此推理的按乐句音高概要。
- **自动修音**:在指定的时间范围上运行 OpenTune 的 AUTO 修正,音阶与参数都显式给出。
- **音符编辑**:设置音符的目标音高、按音分平移、吸附到音阶,或修改修正速度、颤音与漂移。
- **节奏**:把一段整体提前或推后,移动时间手柄。
- **编排、轨道与走带**:移动、裁剪、切分、合并、删除片段,设置片段增益与淡入淡出;设置每条轨道的静音、独奏、音量与颜色;播放、停止、定位;设置速度与拍号。
- **工程与设置**:保存、另存为、打开工程;读取与修改处理类首选项和音频设备。
- **撤销与重做**:接口做的改动进入 OpenTune 自己的撤销历史(在 OpenTune 支持撤销的地方);不能撤销的操作(其中一些在 OpenTune 本身就不能撤销)会在结果中说明,能还原时附上还原方法。

每次改动都将返回结构化结果:改了什么(改动前后的值与单位)、副作用、告警、能否撤销,以及不能撤销时如何还原。目标不是判断一段人声「修得好不好」,而是把 OpenTune 已有的操作开放给 agent,并把每个操作的效果报告清楚。

首个版本不包含:OpenTune 界面本身没有的功能;以及绘制类编辑(画音符、拉伸、切分或合并音符、单音符 EQ、手绘曲线),这些推迟到后续版本。

## 工作原理

规划中的设计如下:

```text
MCP 客户端(例如 Claude Desktop、Claude Code 或 Cursor)
   |  MCP over stdio
   v
opentune-mcp  (本仓库,Node.js,MIT)
   |  OTCP:JSON-RPC 2.0,每行一条 JSON 消息,经 127.0.0.1 上的 TCP
   v
带控制接口的 OpenTune 独立版  (synchain-oss/OpenTune,AGPL-3.0)
```

- **两层结构。** 控制接口将运行在 OpenTune 内部,使用一个小而有版本号的协议:OpenTune 控制协议(OTCP)。本服务将把 MCP 工具调用转换成 OTCP 请求,再把回复整理成可读的结果。两者是独立的程序,所以本仓库不含任何 OpenTune 代码。
- **默认关闭。** 控制接口将是一个构建选项。即使构建里包含它,也只有在启动 OpenTune 时显式开启,接口才会打开。
- **只在本机。** OpenTune 将只监听字面地址 127.0.0.1,端口由操作系统分配;只有先用随机令牌完成握手,才接受请求。令牌每次启动重新生成,保存在只属于当前用户的发现文件里。本服务自己将不开任何网络端口,只通过 stdio 与你的 MCP 客户端通信。
- **规范公开。** OTCP 规范(JSON Schema、示例与威胁模型)将放在本仓库的 `spec/otcp/v1/`,同样采用 MIT 许可证。

## 与 OpenTune 的关系

- [OpenTune](https://github.com/YuFeng926/OpenTune) 是一款开源 AI 修音软件。OpenTune 是 DAYA STUDIO 的项目,采用 AGPL-3.0 许可证。它唯一的官方发布渠道是 [YuFeng926/OpenTune](https://github.com/YuFeng926/OpenTune)。
- OpenTune 作者同意了这一做法:我们在 fork [synchain-oss/OpenTune](https://github.com/synchain-oss/OpenTune) 中以新增代码的形式开发控制接口(接口关闭时 OpenTune 的行为不变),并计划向上游提交。这并不意味着它是 OpenTune 的官方功能;是否以及如何合入由作者决定。
- 本仓库不含任何 OpenTune 源码,也不含任何模型权重。
- 在控制接口进入 OpenTune 官方发布版之前,我们发布的任何补丁版都会明确标注为「非官方测试版」;其中不含任何模型权重,会使用你已安装的官方 OpenTune 中的模型。
- OpenTune MCP Server 是 Synchain 的项目,不是 OpenTune 或 DAYA STUDIO 的官方产品。

## 路线图

1. OTCP 规范与模拟 OpenTune(mock),让服务在没有 OpenTune 的情况下也能测试。
2. Windows 上的首个版本:读取、导入与导出、自动修音、音符与节奏编辑、撤销与重做,并配套一个 OpenTune 非官方测试版。
3. 第二个版本:编排、轨道、走带、工程保存与打开、设置。
4. macOS:在 OpenTune 官方发布版包含控制接口之后(或自行从源码构建)。
5. 向上游 OpenTune 项目提交控制接口。只有在 OpenTune 官方发布版包含控制接口之后,才会上架各类 MCP 目录。

## 文档

以下文档会随开发进度陆续加入:

- `docs/install-for-agents.md`:面向 MCP 客户端与 AI agent 的配置说明
- `docs/reference.md`:工具参考,由服务自动生成
- `docs/ARCHITECTURE.md`:两层结构如何配合
- `docs/COMPATIBILITY.md`:本服务、协议与 OpenTune 构建之间的版本对应关系
- `docs/TROUBLESHOOTING.md`(另有中文版):按错误码列出的错误与解决办法
- `spec/otcp/v1/`:OTCP 规范

## 贡献

欢迎用中文或英文提 issue 与 PR。见 [CONTRIBUTING.md](CONTRIBUTING.md)(中文)与[行为准则](CODE_OF_CONDUCT.md)([中文译本](CODE_OF_CONDUCT.zh-CN.md),以英文版为准)。所有 commit 必须签署(`git commit -s`,DCO)。项目处于预发布阶段,较大的改动请先开 issue 讨论。[synchain-oss/OpenTune](https://github.com/synchain-oss/OpenTune) 中的控制接口及其测试版的问题也在这里跟踪。

## 安全

安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告,不要开公开 issue。本机控制通道、其令牌以及文件路径处理都在范围之内。

## 许可证

[MIT](LICENSE) © 2026 Synchain。`spec/` 下的 OTCP 规范同样采用 MIT 许可证。

OpenTune 采用 AGPL-3.0 许可证,不属于本仓库。OpenTune 使用的模型各有其许可证,其中一部分仅限非商业用途;本仓库不分发任何模型。

## 相关项目

- [synchain-oss/OpenTune](https://github.com/synchain-oss/OpenTune):我们的 OpenTune fork,控制接口在这里开发
- [synchain-oss/synchain-cli](https://github.com/synchain-oss/synchain-cli):`@synchain/cli`,Synchain 命令行客户端
- [synchain-oss/synchain-bridge](https://github.com/synchain-oss/synchain-bridge):把 DAW 音频实时传给远程协作者的音频插件(VST3/AU)
- [synchain-oss/scvb](https://github.com/synchain-oss/scvb):Synchain Vocal Balancer,多声部人声的自动声像与电平平衡(VST3)
- [synchain.ca](https://www.synchain.ca):Synchain 官网
