# Troubleshooting(排障)

[English](TROUBLESHOOTING.md) | **简体中文**

`opentune_get_status` 的每个结果和每个工具错误都带有一个 `nextStep`(`actor` 为 `agent` 或 `user`)和一个 `url`,指向下面的某个小节。运行 `opentune-mcp doctor` 可以在不启动服务的情况下检查配置;`opentune-mcp doctor --json` 以 JSON 打印同样的检查。导入、分析、渲染与导出各要多久,见[要等多久](COMPATIBILITY.md#how-long-to-wait)。

本文是 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) 的中文版。小节标题保留英文(状态、错误 kind 与 doctor 检查 ID 本来就是英文标识),这样锚点与英文版逐一对应,错误结果里的 `url` 在两个版本里都能用。

## Statuses of opentune_get_status

### Status READY

OpenTune 带着控制接口在运行,并且本服务已验证过它。有多个实例在运行时,给其他工具传 `instance_id`;服务从不自己挑选实例。

### Status NOT_READY

有实例宣告了自己,但还没能建立会话。`reason` 说明原因:`connect_failed`、`hello_timeout`、`closed_during_hello`、`session_limit` 与 `shutting_down` 通常几秒后会恢复,过几秒再查一次即可。`instance_unverified`(端口上的进程不是发现文件所属的实例)与 `auth_failed` 需要重启 OpenTune。

有两个原因只来自 `opentune_launch`。`launch_timeout`:它启动的 OpenTune 在 30 秒内没有宣告控制接口。进程仍在运行(本服务从不结束进程);请过几秒再查状态,不要再启动一次 OpenTune。`launch_unverified`:有实例为这次启动宣告了自己,但它的发现文件没有带上传给进程的启动 nonce,所以本服务不使用它。请问用户开着哪些 OpenTune 窗口。

### Status PROTOCOL_MISMATCH

OpenTune 使用的控制协议版本本服务不支持。请更新 OpenTune 或本服务,使双方都支持协议主版本 1。

### Status STARTING

某个 OpenTune 进程启动不到 30 秒,还没有发布控制接口。`reason` 为 `launch_pending` 时,它是 `opentune_launch` 启动的进程(`processes` 列出其 pid);再次调用 `opentune_launch` 会等待它,而不是再启动第二个。请稍后再查;如果状态变成 `RUNNING_WITHOUT_API`,说明该构建或启动选项缺少控制接口。

### Status RUNNING_WITHOUT_API

OpenTune 在运行,但没有控制接口:它启动时没带 `--control-api`(或 `OPENTUNE_CONTROL_API=1`),或者该构建没有控制接口。`opentune_launch` 启动、且 30 秒内没有宣告控制接口的进程也算在这里。请保存工作,退出 OpenTune,再用 `opentune_launch` 重新启动(或自己带选项启动带接口的构建)。此类进程在运行时,`opentune_launch` 什么也不会启动,本服务也从不关闭 OpenTune。

### Status NOT_RUNNING

配置的 OpenTune 构建带有控制接口,但没有在运行。`opentune_launch` 会启动它(见 [Starting OpenTune](#starting-opentune));你也可以自己带 `--control-api` 启动。

`reason` 为 `launch_exited` 时,`opentune_launch` 启动的 OpenTune 在控制接口可用之前就退出了。请手动启动看看发生了什么,并运行 `opentune-mcp doctor`。

当 `processes: null` 且 `nullReasons.processes` 为 `not_listable`(出现在此状态、`NO_API_BUILD` 或 `NOT_INSTALLED` 时),说明服务无法列出正在运行的进程,所以可能仍有一个没开控制接口的 OpenTune 在运行。此时 `opentune_launch` 什么也不启动,直到用户确认没有 OpenTune 在运行(见 [OPENTUNE_NOT_AVAILABLE](#error-opentune_not_available))。

### Status NO_API_BUILD

`OPENTUNE_MCP_OPENTUNE_PATH` 指向的可执行文件旁边没有适用于协议主版本 1 的 `opentune-control.json`(`reason`:`manifest_missing`、`manifest_too_large`、`manifest_invalid` 或 `protocol_mismatch`)。该文件必须是不超过 8 KiB 的 UTF-8 JSON 对象,其 `protocolMajors` 列出 1;其他成员会被忽略。官方 OpenTune 发布版没有控制接口,也会落在这里。请配置带控制接口的构建。`opentune_launch` 从不启动这样的可执行文件。

### Status NOT_INSTALLED

没有配置带控制接口的 OpenTune 构建:`OPENTUNE_MCP_OPENTUNE_PATH` 没有设置(`path_not_configured`),或者没有以绝对路径指向一个存在的可执行文件(`not_absolute`、`not_found`、`not_a_file`)。请在 MCP 客户端对本服务的配置里设置它。

### Status WSL_UNSUPPORTED_RUNTIME

服务运行在 Windows Subsystem for Linux 里,无法通过 `127.0.0.1` 访问 Windows 上的 OpenTune。请把 MCP 客户端配置成用 Windows 的 Node.js 启动服务。

## Starting OpenTune

`opentune_launch` 只启动 `OPENTUNE_MCP_OPENTUNE_PATH` 里的可执行文件,并且只在 [NOT_INSTALLED](#status-not_installed) 与 [NO_API_BUILD](#status-no_api_build) 的检查通过时才启动。它唯一的输入是 `allow_second_instance`;工具调用中的任何内容都改不了可执行文件、参数或环境。它会传入 `--control-api`、一个就绪文件、一个随机的启动 nonce,并在设置了 `OPENTUNE_MCP_DISCOVERY_DIR` 时传入该目录(`--control-api-dir=`),然后最多等 30 秒,等待发现文件带有该 nonce 的实例。等待期间,发现目录里的 `launching` 文件夹保存着 `<pid>.json`(pid、启动时间和 nonce 的哈希,绝无令牌)以及就绪文件,因此 `opentune_get_status` 会报告 [STARTING](#status-starting),重复或并发的调用会等待同一次启动。已有带控制接口的实例在运行(`alreadyRunning`;第二个实例需要 `allow_second_instance` 和用户的明确同意),或有一个没开控制接口的 OpenTune 在运行时,它什么也不启动。服务无法列出正在运行的进程时,无法排除后一种情况,也什么都不启动(错误 [OPENTUNE_NOT_AVAILABLE](#error-opentune_not_available),`reason` 为 `process_list_unavailable`)。`allow_second_instance: true` 不是幂等的:每次带它的调用,在之前的启动完成后都会多启动一个实例,所以每得到一次同意只用一次。它从不结束进程,超时之后也不会。

## Errors

先列 OpenTune 控制协议的各 kind,再列本服务新增的 kind。`executed` 为 false 表示请求没有改动任何东西;`null` 表示不知道是否执行了,所以重试修改之前要先重新读取状态。

### Error AUTH_FAILED

OpenTune 拒绝了发现文件里的凭据,通常是因为它重启过。请检查状态。

### Error PROTOCOL_MISMATCH

OpenTune 使用另一个协议版本。请更新 OpenTune 或本服务。

### Error SHUTTING_DOWN

OpenTune 正在关闭。先检查状态,再做别的。

### Error INVALID_ARGUMENT

参数被拒绝;`detail` 说明原因。原因为 `confirm_required` 时,该操作具有破坏性,需要用户的明确同意。

### Error NOT_FOUND

对象已不存在,或其 id 已过期(打开工程后 id 会变)。请重新读取状态。已结束的任务保留 30 分钟。

### Error NOT_READY

OpenTune 仍在分析音频或生成音符。请等待后重试。原因 `f0_failed` 与 `f0_empty` 不会恢复:该片段无法编辑。

### Error ANALYSIS_FAILED

OpenTune 无法分析这段音频的音高。

### Error RENDER_FAILED

OpenTune 无法渲染修正后的音频,自动重试一次后仍然失败。

### Error MODEL_UNAVAILABLE

OpenTune 需要的模型或推理后端缺失。请运行 `opentune-mcp doctor`。

### Error REVISION_CONFLICT

对象在被读取之后又变了。请重新读取,用新的版本号重试。

### Error UNDO_CONFLICT

撤销历史顶部不是预期的条目。请问用户如何处理。

### Error UNSAVED_CHANGES

该请求会丢弃未保存的改动。请问用户是保存还是丢弃。

### Error ALREADY_EXISTS

目标已存在,而不允许替换。

### Error BUSY

OpenTune 正被使用:有对话框开着、用户正在拖动,或有导入、导出、工程操作在进行。请在 OpenTune 里完成它,再重试。原因为 `modal_open` 时有模态对话框开着;第一个通常就是一次性的首次引导对话框,见 [First launch dialog](#first-launch-dialog)。`opentune_manage_ui` 的 `dismiss_dialogs` 可以像按 Esc 一样关掉对话框;关闭时会提交所示取值的对话框(轨道颜色对话框)只有带 `accept_commit: true` 才会关,而这需要用户同意。关掉确认框等于取消它询问的操作,所以关闭任何对话框之前都要先问用户。

### Error TIMEOUT

OpenTune 在截止时间之前没有开始处理该请求。没有任何改动;请重试。

### Error CANCELLED

任务已被取消。它的结果会列出在停止之前已经提交的工作。

### Error IO_ERROR

某个文件无法读取或写入。不带 `path` 的导出写在源文件旁;该文件夹只读时导出会失败,服务不会另选文件夹。请用一个可写文件夹里的 `path` 再次调用 `opentune_export_audio`。

### Error UNSUPPORTED

OpenTune 或该构建不提供这个操作。原因为 `capability_missing` 时,`detail` 指出缺少的能力;原因为 `job_not_cancellable` 时,任务会继续,可以用 `opentune_get_job` 跟踪。

### Error INTERNAL

OpenTune 或本服务里发生了意外错误。本服务不认识的错误 kind 也按此处理。重试之前先检查状态并重新读取状态。

### Error OPENTUNE_NOT_AVAILABLE

没有带控制接口的实例在运行。请检查状态并照其 next step 做。

来自 `opentune_launch` 且 `reason` 为 `process_list_unavailable` 时(并有 `processes: null`、`nullReasons.processes` 为 `not_listable`,如 [NOT_RUNNING](#status-not_running) 所述):服务无法列出正在运行的进程,因此无法判断是否已有一个没开控制接口的 OpenTune 在运行,而此时启动会在它旁边打开第二个实例。什么也没有启动。请确认没有 OpenTune 在运行;只有在用户确认之后,才带 `allow_second_instance: true` 再次调用 `opentune_launch`。这是绕过该检查的唯一办法。

### Error MULTIPLE_INSTANCES

有多个实例在运行,而没有给出 `instance_id`。错误里列出这些实例;请问用户用哪一个。

### Error INSTANCE_NOT_FOUND

`instance_id`(或任务 id 里的实例部分)指向的实例不存在:它已被关闭或重启。服务不会改用别的实例;请问用户。

### Error INSTANCE_UNVERIFIED

监听在宣告端口上的进程没能证明自己就是发现文件所属的实例(服务端证明、实例 id 或进程 id 不一致)。服务不会再向它发送任何内容。请重启 OpenTune。

### Error CONNECTION_LOST

与 OpenTune 的连接失败或已关闭。正在处理的请求可能执行了也可能没有;重试修改之前先重新读取状态。

### Error REQUEST_TIMEOUT

OpenTune 没有及时回答。请求可能仍在运行;重试修改之前先重新读取状态。

### Error CONFIG_INVALID

服务的配置无效,例如 `OPENTUNE_MCP_DISCOVERY_DIR` 或 `OPENTUNE_DATA_DIR` 不是绝对路径,或发现目录无法读取(`reason` 为 `discovery_dir`;`opentune_launch` 在无法于其中创建 `launching` 文件夹时也会报告它)。`reason` 为 `launch_failed` 时,`OPENTUNE_MCP_OPENTUNE_PATH` 里的可执行文件通过了检查,但系统无法启动它;`detail` 给出系统的错误码。请运行 `opentune-mcp doctor`。

## Doctor checks

### Doctor OT_NODE_VERSION

需要 Node.js 22 或更高。

### Doctor OT_WSL_RUNTIME

在 WSL 里服务无法访问 Windows 上的 OpenTune;请用 Windows 的 Node.js 运行。

### Doctor OT_DISCOVERY_DIR

OpenTune 宣告运行中实例的目录必须可读。在带控制接口的 OpenTune 启动过一次之前,它并不存在。`OPENTUNE_MCP_DISCOVERY_DIR` 可以覆盖它。

### Doctor OT_OPENTUNE_PATH

`OPENTUNE_MCP_OPENTUNE_PATH` 必须是带控制接口的构建的 OpenTune 可执行文件的绝对路径,且旁边有 `opentune-control.json`。

### Doctor OT_NO_OFFICIAL_INSTALL

是否存在官方 OpenTune 安装(仅 Windows):服务读取注册表里的卸载项,再查看常见的安装文件夹。找不到只是警告,不是错误。本服务从不启动这份安装;`opentune_launch` 启动的 OpenTune 以它为工作目录,这样没有自带 models 文件夹的构建能找到已安装的模型。没有安装时,工作目录是所配置可执行文件所在的文件夹。

### Doctor OT_VERSION_UNSUPPORTED

官方 OpenTune 安装的版本(读自其卸载项;仅 Windows)必须是 1.7.9 或更新。更旧的:请从官方发布页面更新 OpenTune。`warn` 且信息为「Not checked」表示没找到安装或该检查不适用于此系统;`warn` 且信息为「Cannot tell」表示该安装没有报告版本。

### Doctor OT_MODELS_MISSING

官方安装需要下列文件,且都不能为空:`fcpe.onnx`,以及 `GAME\bd2dur.onnx`、`GAME\dur2bd.onnx`、`GAME\encoder.onnx`、`GAME\estimator.onnx`、`GAME\segmenter.onnx`。OpenTune 1.8 及之后把它们放在 `%ProgramData%\OpenTune\Models`;1.7.x 放在安装文件夹的 `models` 文件夹里。该检查只看是否存在与大小,从不看内容。失败时,信息会指出它查看的文件夹和缺失的文件:请重新运行官方安装程序(或修复安装),让它恢复这些模型。已安装版本未知时,两个文件夹都会尝试,结果是警告。

### Doctor OT_SIDECAR_INCOMPLETE

测试版是一个 zip,可执行文件旁有一个 `SHA256SUMS` 文件(每行 `<sha256>  <相对路径>`)。`fail` 表示它列出的某个文件缺失或哈希不符(信息会点名),或者清单无法读取。请删除该文件夹,把整个 zip 重新解压到一个空文件夹;不要把单个文件复制到旧版本上。`warn`(「Cannot verify」)表示没有 `SHA256SUMS`,这对你自己构建的可执行文件是正常的,此时无法检查该文件夹。

### Doctor OT_MODELS_SHADOWED

可执行文件旁的 `models` 文件夹会先于已安装的模型被找到。测试版不自带这个文件夹,所以除非是你有意放的,请重命名或删除它;信息会说明它是否包含全部所需的模型文件。

### Doctor OT_D3D12_NOT_COPIED

测试版在 `opentune-control.json`(`d3d12`)里列出了 Direct3D 12 运行库,但没有自带它。没有这个文件时 OpenTune 在 CPU 上做推理,所以这是警告,复制是可选的。在一台有 NVIDIA 显卡的机器上实测:不复制时音高分析(F0)回落到 CPU。请在 PowerShell 里运行该检查打印出的命令,它们把 `D3D12Core.dll` 从官方安装复制到可执行文件旁的 `D3D12` 文件夹,并打印其 SHA-256 哈希,用来与 `opentune-control.json` 对比;请原样使用打印出的命令,因为它们会对含特殊字符的路径做转义。如果复制出的文件哈希不同(`fail`),请删除 `D3D12` 文件夹(回到 CPU),再从官方安装重新复制。`D3D12SDKLayers.dll` 是调试层:不要复制它,如果它在那里就删掉。「Cannot tell」表示 `opentune-control.json` 的 `d3d12` 条目没有列出文件,或哈希不是 64 个十六进制字符,所以什么也检查不了:请重新解压测试版。

## Claude Code mcp add fails in PowerShell

`claude mcp add` 报 `missing required argument 'commandOrUrl'`(或 `'name'`)。有两个原因:

- 在 PowerShell 里,`claude` 会解析为 npm 生成的 `claude.ps1`,PowerShell 会在程序看到之前吞掉单独的 `--`,于是要注册的命令就丢了。改用 `claude.cmd mcp add …`,`opentune-mcp doctor --client claude-code` 在 Windows 上打印的就是这种写法。在 cmd 以及 macOS、Linux 上,`claude` 可以直接用。
- `-e`(`--env`)可以接任意多个值,写在它后面的名字会被当成又一个变量。名字(`opentune`)必须放在前面,打印出的命令就是这样写的。

## First launch dialog

OpenTune 在全新数据文件夹下首次启动时,会弹出一次性的首次引导(onboarding)对话框。需要有人在 OpenTune 窗口里回答一次。它(或任何其他模态对话框)开着时,所有写操作都会失败,返回 [BUSY](#error-busy),原因 `modal_open`。`opentune_get_settings` 会报告首次引导是否已经显示过。请让用户回答该对话框,然后重试。`opentune_manage_ui` 也能像按 Esc 一样把它关掉(`dismiss_dialogs`;首次引导覆盖层用 `dismiss_onboarding`,它同时把首次引导标记为已显示,这是撤销不了的全局设置,先问用户)。服务从不按对话框里的按钮。

## Hybrid mode

OpenTune 首选项里的「混合模式:小修用dsp,大修用声码器」(英文界面为 "Hybrid Mode: Small corrections use DSP, large corrections use vocoder")默认开启。修正量中小于 75 音分的部分走 DSP 移调,而不是声码器。这是 OpenTune 自身的设计,在它的窗口里和通过本服务都一样;在真实人声上,这种小修正可能几乎听不出来。如果需要小修正也明显可听,请在 OpenTune 的首选项里关闭该项,或让 agent 用 `opentune_set_settings`(`processing.hybrid_mode`)来关。它是 OpenTune 安装的全局设置而不是工程设置,关掉之后一直保持关闭,直到再把它打开;`opentune_set_settings` 的结果会给出恢复原值的调用。当时的设置会如实报告,位置有三处:`opentune_export_audio` 结果里的 `export.processing.hybridMode`;导出作业在调用内没跑完时,`opentune_get_job` 里的 `job.result.processing.hybridMode`;首选项本身在 `opentune_get_settings` 的 `processing` 小节。不要想当然。

## Slow process discovery

在 Windows 上,服务会读取 OpenTune 进程的启动时间,以区分活着的实例与过期的发现文件。PowerShell 冷启动之后的第一次读取有时很慢,所以发现实例可能比平时多等几秒。这不是错误;客户端等不及放弃的话,再调用一次即可。
