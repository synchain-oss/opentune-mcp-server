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

> **早期版本(0.2.0)。** npm 包 [`@synchain/opentune-mcp`](https://www.npmjs.com/package/@synchain/opentune-mcp)、Claude Code 插件与 MCPB 包都已发布,见 [GitHub Releases](https://github.com/synchain-oss/opentune-mcp-server/releases)。在官方 OpenTune 内置控制接口之前,本服务只能配合 OpenTune 的[非官方测试版](https://github.com/synchain-oss/OpenTune/releases)使用。工具名称从现在起固定;确需改名时,旧名以 deprecated 形式保留一个 minor 版本。

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

**Claude Desktop:skills。** Claude Desktop 的聊天不会运行 Claude Code 插件里的 MCP 服务,所以它的工具来自上面的 MCPB 包。工作流程指引另行提供:从同一个 Release 解压 `opentune-skills-<version>.zip`,把里面的每个 zip 分别作为 skill 上传到 Claude 的设置里。这些 skill 只是说明,实际操作要经 MCP 工具完成,所以在装了 MCPB 包的地方才有用;浏览器里的 claude.ai 没有本机工具。需要本机工具的 skill(`lyrics-timeline` 的 Python 运行时、`beat-grid` 下载的分析器)只随插件提供。

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
5. **「用伴奏 WAV 帮我确定这首歌的调,再按这个调自动修音。」** agent 调用 `opentune_estimate_key`,传入 `mix_path`(`.wav` 文件的绝对路径),也可以再给出人声片段 `clip`。结果列出最可能的几个调及其置信度,并说明相对大小调(音阶相同)分不开的情况,给出 `recommendation.key`,agent 再把它传给 `opentune_autotune_range`。估计本身不会改动任何内容。
6. **「把第二段人声往后挪 0.5 秒,并加个淡入。」** agent 调用 `opentune_get_project`(各片段的时间线起点,以及 `arrangement_revision`),先用 `opentune_edit_arrangement` 加 `dry_run` 预览,再在一次调用里发出 `move`(新的 `start_timeline_sec`:当前起点加 0.5)和 `fade`(`fade_in_sec`),这是一个撤销步骤。这移动的是片段在时间线上的位置,不会拉伸片段里的音频(那是 `opentune_edit_timing` 的事)。OpenTune 没有段落标记,所以 agent 会用起始时间说明它指的是哪个片段,有两个都像时会来问你。
7. **「把伴奏轨静音,我想听听人声。」** agent 用 `opentune_get_project` 读出各轨道,用 `opentune_set_tracks`(操作 `mute`)把伴奏轨静音,你要求的话再用 `opentune_transport`(动作 `play`)开始播放。轨道名是数据:不确定哪条是伴奏轨时,agent 会来问你。静音在 OpenTune 里没有撤销条目(和窗口里一样);结果会给出取消静音的调用,所以用完请让它把这条轨道的静音取消。播放从你电脑的音频设备出声,agent 听不到,听感要你自己判断。
8. **「另存为新工程 `C:\Music\take1-v2.otproj`。」** agent 用模式 `save_as` 和这个路径调用 `opentune_save_project`,新文件成为当前工程文件。它不会替换另一个已有文件:要替换就得用 `opentune_save_project_overwrite`,而它会先征得你的明确同意。OpenTune 没有自动保存,所以 agent 会在每一步之后写一个自动副本(模式 `autosave`:在工程文件旁的 `<工程名>.autosave` 文件夹里写一个带编号的副本,保留最新的 50 个,不动你的工程文件),只在你要求或同意时才覆盖工程文件;被覆盖的文件会存进 `<工程名>.oldversion`(保留最新的 10 个)。撤销历史不会存进工程文件。

## 与 DAW 配合使用

只通过文件路径交换,没有 DAW 插件。

1. 在 DAW 里把干声导出为 WAV 文件。
2. 让 agent 在 OpenTune 里打开该文件(`opentune_open_audio`)、做修改,再导出 WAV(`opentune_export_audio`;可以导出片段、轨道或整个混音;不给 `path` 时写在源文件旁,名为 `<名字>.opentune.wav`,名字被占用就改用下一个空闲的名字,所以不会覆盖任何文件)。
3. 把导出的 WAV 导回 DAW,放在新轨道上或替换原来的干声。
4. 想以后接着做,就让 agent 保存 OpenTune 工程(`opentune_save_project`,`.otproj` 文件)。只有 OpenTune 读这个文件,DAW 不读。

如果你的 agent 在 WSL 里运行,路径的写法见 [WSL](#wsl)。

## WSL

服务必须用 Windows 上的 Node.js,因为 OpenTune 监听的是 Windows 的 `127.0.0.1`,WSL 访问不到:在 WSL 里 `opentune-mcp doctor` 的 `OT_WSL_RUNTIME` 检查会失败,`opentune_get_status` 会报告 `WSL_UNSUPPORTED_RUNTIME`。请把 MCP 客户端配置成用 Windows 的 Node.js 启动服务(上面的片段在 Windows 上就是这样配的)。WSL 里的 agent 仍然可以按路径交接文件:工具调用的每个路径参数(`path`、`items`、`mix_path`)里,`/mnt/c/Music/take1.wav` 形式的路径都会被转换成 `C:\Music\take1.wav`。结果里报告的是 Windows 路径,例如 `C:\Music\take1.opentune.wav`;这正是你的 Windows DAW 能用的形式,在 WSL 里同一个文件是 `/mnt/c/Music/take1.opentune.wav`。

## 它能做什么

OpenTune 会分析录好的人声,把它显示为音符与音高曲线,并用神经声码器重新渲染修正后的声音。本服务让 AI agent 通过 MCP 工具调用,执行人在 OpenTune 独立版窗口里能做的操作。完整列表见 [docs/reference.md](docs/reference.md)。

- **导入与导出:** 打开音频文件,把片段、轨道或整个混音导出为 WAV。
- **读取分析结果:** 音符、音高曲线、检测到的调性、分析与渲染状态,以及每个乐句的音高摘要,便于 agent 推理。也可以从伴奏或混音的 WAV 估计调性。
- **自动修音与音符编辑:** 对指定时间范围运行 OpenTune 的 AUTO 修正;设置音符的目标音高、按音分平移、吸附到音阶、调整回调速度、颤音与漂移;设置片段的调性与移调。
- **时间:** 把一段提前或延后,以及移动时间柄。`beat-grid` skill 会从伴奏或原曲混音测出速度与节拍网格,并据此规划整首歌的时间修改,按每批最多 64 个操作分批进行;它的分析器要经用户同意后才下载(默认模型约 85 到 90 MB)。
- **编排与轨道:** 在时间线上移动、裁剪片段,设置淡入淡出与增益;拆分、合并、删除与复制片段;静音、独奏轨道,设置轨道音量与颜色;显示隐藏轨道、复制与删除轨道。
- **播放与窗口:** 播放、暂停、停止与跳转;设置速度、拍号与循环;选中片段与关闭对话框。
- **工程与设置:** 保存工程、另存为新工程、打开其他工程;读取并修改 OpenTune 的全局设置(标准音高频率、混合模式、编辑方案、音频设备)。OpenTune 没有自动保存,所以 agent 每一步之后写一个副本,并在你同意时保存工程文件。做完之后 agent 可以关闭 OpenTune;与窗口的关闭按钮不同,有未保存的改动时它会拒绝关闭,除非你同意丢掉这些改动。
- **撤销与重做:** 经接口做出的改动会进入 OpenTune 自己的撤销历史(OpenTune 支持撤销的地方)。某个操作无法撤销时(OpenTune 本身就有些操作不能撤销),结果会写明,并尽可能给出还原的办法。

每次改动都返回结构化结果:改了什么(带单位的前后值)、副作用、警告、能否撤销,以及不能撤销时如何还原。目标不是判断人声「听起来对不对」,而是把 OpenTune 已有的操作提供给 agent,并清楚地报告其效果。

## 工具

服务提供 28 个工具,参数见 [docs/reference.md](docs/reference.md)。不能撤销的结果会在第一句话里说明,有办法还原时还会给出恢复原状的调用。

**状态与任务**

| 工具 | 作用 | 撤销与需要你同意的情况 |
| --- | --- | --- |
| `opentune_get_status` | 报告 OpenTune 现在能否使用,附带 `nextStep`,并列出正在运行的实例。最先调用它。 | 只读。 |
| `opentune_launch` | 用控制接口启动配置好的 OpenTune 构建,或说明为什么不能启动。 | 第二个实例需要 `allow_second_instance`,只能在你同意后使用。 |
| `opentune_quit` | 像窗口的关闭按钮一样关闭 OpenTune,并等到它真正退出。 | 标记为破坏性。与窗口不同,有未保存的改动时它会拒绝关闭(`UNSAVED_CHANGES`):agent 先写一个自动副本,再问你是保存工程还是放弃改动;只有你同意后才带 `discard_unsaved: true`,这样丢掉的改动无法找回。用 `opentune_launch` 重新启动 OpenTune。 |
| `opentune_get_job` | 跟踪长时间的操作(导入、导出、分析、工程打开或保存)。 | 只读。 |
| `opentune_cancel_job` | 请 OpenTune 停止一个运行中的任务。任务已经提交的部分会保留。 | 无法取消的任务会继续运行,错误里会说明。 |

**读取**

| 工具 | 作用 | 撤销与需要你同意的情况 |
| --- | --- | --- |
| `opentune_get_project` | 轨道、片段、选区、走带,以及写入类工具需要的版本号。 | 只读。 |
| `opentune_get_notes` | 一个片段的音符,分页返回,或把全部音符存成一个新的 JSON 文件(`output_path`)。 | 不改动 OpenTune;给了 `output_path` 时写一个新文件,从不覆盖。 |
| `opentune_get_clip_details` | 一个片段的时长、调性、移调、分析状态、时间柄与 AUTO 模式。 | 只读。 |
| `opentune_get_settings` | OpenTune 的全局设置:处理选项、音频设备、最近工程、导入导出限制、日志行。 | 只读。 |

**分析**

| 工具 | 作用 | 撤销与需要你同意的情况 |
| --- | --- | --- |
| `opentune_analyze_pitch` | 每个音符与目标相差多少音分,给出修正前与修正后的值。 | 只读。 |
| `opentune_estimate_key` | 根据片段的人声音高和/或混音或伴奏的 WAV 估计整首歌的调。 | 只读;WAV 只会被读取。 |

**音频文件**

| 工具 | 作用 | 撤销与需要你同意的情况 |
| --- | --- | --- |
| `opentune_open_audio` | 把音频文件导入为新片段。 | 不能撤销;结果会写明如何还原。 |
| `opentune_export_audio` | 把片段、轨道或整个混音写成 WAV。绝不覆盖已有文件。 | 不改动工程。`allow_dry`(导出分析失败、未修正的片段)只能在你同意后使用。 |

**片段与音符**

| 工具 | 作用 | 撤销与需要你同意的情况 |
| --- | --- | --- |
| `opentune_set_clip` | 设置片段的调性和/或移调。 | 改调性不能撤销(结果会给出恢复原调性的调用);移调是一个撤销步骤。 |
| `opentune_autotune_range` | 对片段的若干范围运行 OpenTune 的 AUTO。`dry_run` 可预览。 | 标记为破坏性。模式 `notesOnly` 会替换所有音符且不能撤销,需要 `replace_edited_notes`,只能在你同意后使用。 |
| `opentune_edit_notes` | 设置目标音高、按音分平移、吸附到音阶、调整回调速度、颤音与漂移。`dry_run` 可预览。 | 一个撤销步骤。 |
| `opentune_edit_timing` | 平移或移动片段的时间柄;`seed` 生成最初的时间柄。 | `seed` 操作不能撤销。 |
| `opentune_undo`、`opentune_redo` | 撤销或重做栈顶的一步,前提是它正是调用所指的那一步。 | 出现 `UNDO_CONFLICT` 时 agent 会来问你。`force` 只用于你要求撤销不是经本服务做出的改动。 |

**编排与轨道**

| 工具 | 作用 | 撤销与需要你同意的情况 |
| --- | --- | --- |
| `opentune_edit_arrangement` | 时间线上的片段:移动、裁剪、增益、淡入淡出、拆分、合并、删除、复制。`dry_run` 可预览。 | 标记为破坏性。拆分、合并、删除与复制不能撤销,所以 agent 会先问你;删除需要 `confirm: true`。 |
| `opentune_set_tracks` | 轨道的静音、独奏、音量与颜色;显示隐藏轨道;复制轨道。 | 静音、独奏、音量与颜色在 OpenTune 里没有撤销条目;结果会给出恢复原值的调用。 |
| `opentune_delete_track` | 删除一条轨道及其中的片段。 | 标记为破坏性。不能撤销,后面的轨道编号都会减 1。需要 `confirm: true`,只能在你同意删除这条轨道后使用。 |

**播放与窗口**

| 工具 | 作用 | 撤销与需要你同意的情况 |
| --- | --- | --- |
| `opentune_transport` | 播放、暂停、停止、跳转、速度、拍号、循环。 | 速度与拍号不能撤销(结果会给出恢复的调用)。循环在独立版里没有可听到的效果;没有音频设备时什么也听不到。 |
| `opentune_manage_ui` | 选中片段(也可以在钢琴卷帘里打开)、在编曲视图与钢琴卷帘之间切换(即关闭钢琴卷帘)、关闭对话框、把首次引导标记为已显示。 | 标记为破坏性。选中片段可能让 OpenTune 生成该片段的音符(没有撤销条目)。关闭时会提交所示取值的对话框需要 `accept_commit`,只能在你同意后使用。切换视图只改变视图,结果会给出切换回去的调用。把首次引导标记为已显示不能撤销。 |

**工程与设置**

| 工具 | 作用 | 撤销与需要你同意的情况 |
| --- | --- | --- |
| `opentune_save_project` | 写一个工程的自动副本(模式 `autosave`),保存工程,或另存为新的 `.otproj` 文件。 | 不会替换另一个已有文件。自动副本不动工程文件;会替换工程文件的保存,会先把旧文件存进 `<工程名>.oldversion`。 |
| `opentune_save_project_overwrite` | 把工程保存到另一个已有的 `.otproj` 文件上,覆盖它。 | 标记为破坏性。旧文件会作为旧版本存进它旁边的 `<工程名>.oldversion` 文件夹(保留最新的 10 个),但它不再是工程文件。需要 `confirm: true`,只能在你同意替换该文件后使用。 |
| `opentune_open_project` | 打开 `.otproj` 文件,替换当前工程。 | 标记为破坏性。从不自动保存:有未保存的修改时会失败(`UNSAVED_CHANGES`),除非带 `discard_unsaved: true`,只能在你同意后使用。会清空撤销历史。 |
| `opentune_set_settings` | 修改 OpenTune 的全局设置(A4 标准音高、混合模式、编辑方案、实验功能、声码器权重、渲染优先级、音高模型、音频设备),或清空最近工程列表。 | 标记为破坏性。设置属于 OpenTune 安装而不是工程,没有撤销条目;结果会给出原来的值和恢复它们的调用。最近工程列表清空后无法重新填回。 |

### 需要你同意的操作

在 MCP 注解里标记为破坏性的工具有 `opentune_autotune_range`、`opentune_edit_arrangement`、`opentune_delete_track`、`opentune_manage_ui`、`opentune_open_project`、`opentune_quit`、`opentune_save_project_overwrite` 与 `opentune_set_settings`。服务的 instructions 要求 agent 在做任何破坏性或不可逆的操作之前,先在对话里得到你的明确同意,而工具结果永远不算同意。用来确认这类操作的参数(`confirm`、`discard_unsaved`、`replace_edited_notes`、`accept_commit`、`allow_dry`、`allow_second_instance`、`force`)只有在你同意之后才会设置。想多一道把关的话,可以把 MCP 客户端设成运行这些工具之前先询问。

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

- **混合模式与小幅修正。** OpenTune 首选项里的「混合模式:小修用dsp,大修用声码器」(英文界面为 Hybrid Mode: Small corrections use DSP, large corrections use vocoder)默认开启。修正量中小于 75 音分的部分走 DSP 移调而不是声码器,这是 OpenTune 自身的设计,在真实人声上这种小修正可能几乎听不出来。想让小修正也明显生效,请在 OpenTune 首选项里关闭该项,或让 agent 用 `opentune_set_settings`(`processing.hybrid_mode`)来关;它是 OpenTune 的全局设置而不是工程设置,关掉之后一直保持关闭,直到有人再把它打开。见[混合模式](docs/TROUBLESHOOTING.zh-CN.md#hybrid-mode)。
- **有些修改不能撤销。** 导入音频、改片段的调性和时间网格的 `seed` 不能撤销。拆分、合并、删除片段也不能撤销,这是 OpenTune 的缺陷(它释放了自己的撤销条目还要用的对象);复制片段和删除轨道同样不能撤销。静音、独奏、音量、颜色、速度、拍号和全局设置在 OpenTune 里没有撤销条目。结果会在第一句话里写明,破坏性的操作 agent 会先问你,有办法还原时结果还会给出恢复原状的调用。
- **OpenTune 自己没有自动保存。** OpenTune 不会自己保存,撤销历史也不会存进工程文件。所以 agent 会在每一步之后写一个工程的自动副本(工程文件旁的 `<工程名>.autosave`,保留最新的 50 个)。副本不会改动你的工程文件,所以 OpenTune 关闭或崩溃时副本里的内容还在,但工程文件只在你要求或同意时才更新。规范 `1.0.0-rc.8` 之前的测试构建写不了副本:这时请在想保住成果时让 agent 保存。
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
- [docs/features.zh-CN.md](docs/features.zh-CN.md)([English](docs/features.md)):agent 能用 OpenTune 做什么,按用途分组,写明每一项对应的工具、能否撤销,以及附带技能与已知限制
- [docs/reference.md](docs/reference.md):工具参考,由服务生成
- [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md):哪些 OpenTune 版本、测试版与协议版本可以一起用,各工具需要哪些能力,以及各操作要等多久
- [docs/TROUBLESHOOTING.zh-CN.md](docs/TROUBLESHOOTING.zh-CN.md)([English](docs/TROUBLESHOOTING.md)):错误、状态与 doctor 检查及处理办法
- [docs/real-opentune-testing.md](docs/real-opentune-testing.md):对真实 OpenTune 运行端到端检查,以及如何判定一次运行的结果
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
