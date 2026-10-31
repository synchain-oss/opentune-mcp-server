# Troubleshooting(排障)

[English](TROUBLESHOOTING.md) | **简体中文**

`opentune_get_status` 的每个结果和每个工具错误都带有一个 `nextStep`(`actor` 为 `agent` 或 `user`)和一个 `url`,指向下面的某个小节。运行 `opentune-mcp doctor` 可以在不启动服务的情况下检查配置;`opentune-mcp doctor --json` 以 JSON 打印同样的检查。导入、分析、渲染与导出各要多久,见[要等多久](COMPATIBILITY.md#how-long-to-wait)。

本文是 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) 的中文版。小节标题保留英文(状态、错误 kind 与 doctor 检查 ID 本来就是英文标识),这样锚点与英文版逐一对应,错误结果里的 `url` 在两个版本里都能用。

## Statuses of opentune_get_status

### Status READY

OpenTune 带着控制接口在运行,并且本服务已验证过它。有多个实例在运行时,给其他工具传 `instance_id`;服务从不自己挑选实例。OpenTune 窗口里开着对话框时,所有写操作都会被挡住;这时结果里会带 `blockedBy`,见 [First launch dialog](#first-launch-dialog)。

### Status NOT_READY

有实例宣告了自己,但还没能建立会话。`reason` 说明原因:`connect_failed`、`hello_timeout`、`closed_during_hello`、`session_limit` 与 `shutting_down` 通常几秒后会恢复,过几秒再查一次即可。`instance_unverified`(端口上的进程不是发现文件所属的实例)与 `auth_failed` 需要重启 OpenTune。

有两个原因只来自 `opentune_launch`。`launch_timeout`:它启动的 OpenTune 在 30 秒内没有宣告控制接口。进程仍在运行(本服务从不结束进程);请过几秒再查状态,不要再启动一次 OpenTune。`launch_unverified`:有实例为这次启动宣告了自己,但它的发现文件没有带上传给进程的启动 nonce,所以本服务不使用它。请问用户开着哪些 OpenTune 窗口。

### Status PROTOCOL_MISMATCH

OpenTune 使用的控制协议版本本服务不支持。请更新 OpenTune 或本服务,使双方都支持协议主版本 1。

### Status STARTING

某个 OpenTune 进程启动不到 30 秒,还没有发布控制接口。`reason` 为 `launch_pending` 时,它是 `opentune_launch` 启动的进程(`processes` 列出其 pid);再次调用 `opentune_launch` 会等待它,而不是再启动第二个。请稍后再查;如果状态变成 `RUNNING_WITHOUT_API`,说明该构建或启动选项缺少控制接口。

### Status RUNNING_WITHOUT_API

OpenTune 在运行,但没有控制接口:它启动时没带 `--control-api`(或 `OPENTUNE_CONTROL_API=1`),或者该构建没有控制接口。`opentune_launch` 启动、且 30 秒内没有宣告控制接口的进程也算在这里。请保存工作,退出 OpenTune,再用 `opentune_launch` 重新启动(或自己带选项启动带接口的构建)。此类进程在运行时,`opentune_launch` 什么也不会启动,本服务也从不关闭 OpenTune。

服务按进程名找到这样的进程:Windows 上是 `OpenTune.exe`,macOS 上是 `OpenTune`(app 包内的可执行文件,官方 app 与测试版同名)。所以在 macOS 上,官方 OpenTune.app 也算在内;双击 `OpenTune-ctl.app` 打开的测试版同样算,因为这样启动时没有控制接口。请退出它,再用 `OpenTune-AI.command` 或 `opentune_launch` 启动测试版。

### Status NOT_RUNNING

配置的 OpenTune 构建带有控制接口,但没有在运行。`opentune_launch` 会启动它(见 [Starting OpenTune](#starting-opentune));你也可以自己带 `--control-api` 启动。

`reason` 为 `launch_exited` 时,`opentune_launch` 启动的 OpenTune 在控制接口可用之前就退出了。请手动启动看看发生了什么,并运行 `opentune-mcp doctor`。在 macOS 上,被 Gatekeeper 拦下的测试版可能这样结束,也可能一直不宣告自己(`launch_timeout`);见 [macOS: first start blocked by Gatekeeper](#macos-first-start-blocked-by-gatekeeper)。

当 `processes: null` 且 `nullReasons.processes` 为 `not_listable`(出现在此状态、`NO_API_BUILD` 或 `NOT_INSTALLED` 时),说明服务无法列出正在运行的进程,所以可能仍有一个没开控制接口的 OpenTune 在运行。此时 `opentune_launch` 什么也不启动,直到用户确认没有 OpenTune 在运行(见 [OPENTUNE_NOT_AVAILABLE](#error-opentune_not_available))。

### Status NO_API_BUILD

`OPENTUNE_MCP_OPENTUNE_PATH` 指向的可执行文件旁边没有适用于协议主版本 1 的 `opentune-control.json`(`reason`:`manifest_missing`、`manifest_too_large`、`manifest_invalid` 或 `protocol_mismatch`)。该文件必须是不超过 8 KiB 的 UTF-8 JSON 对象,其 `protocolMajors` 列出 1;其他成员会被忽略。官方 OpenTune 发布版没有控制接口,也会落在这里。请配置带控制接口的构建。`opentune_launch` 从不启动这样的可执行文件。

在 macOS 上遇到 `manifest_missing` 时:测试版不把 `opentune-control.json` 放进 app 包(放进 `OpenTune-ctl.app/Contents/MacOS` 会破坏 app 的签名),而是放在你解压出的文件夹里、`OpenTune-AI.command` 的旁边。所以 `OPENTUNE_MCP_OPENTUNE_PATH` 要指向 `OpenTune-AI.command`,而不是 app 里面的可执行文件。`opentune-mcp doctor` 看到这样的路径时会这样提示(`OT_OPENTUNE_PATH`)。

### Status NOT_INSTALLED

没有配置带控制接口的 OpenTune 构建:`OPENTUNE_MCP_OPENTUNE_PATH` 没有设置(`path_not_configured`),或者没有以绝对路径指向一个存在的可执行文件(`not_absolute`、`not_found`、`not_a_file`)。请在 MCP 客户端对本服务的配置里设置它。

### Status WSL_UNSUPPORTED_RUNTIME

服务运行在 Windows Subsystem for Linux 里,无法通过 `127.0.0.1` 访问 Windows 上的 OpenTune。请把 MCP 客户端配置成用 Windows 的 Node.js 启动服务。

## Starting OpenTune

`opentune_launch` 只启动 `OPENTUNE_MCP_OPENTUNE_PATH` 里的可执行文件,并且只在 [NOT_INSTALLED](#status-not_installed) 与 [NO_API_BUILD](#status-no_api_build) 的检查通过时才启动。它唯一的输入是 `allow_second_instance`;工具调用中的任何内容都改不了可执行文件、参数或环境。它会传入 `--control-api`、一个就绪文件、一个随机的启动 nonce,并在设置了 `OPENTUNE_MCP_DISCOVERY_DIR` 时传入该目录(`--control-api-dir=`),然后最多等 30 秒,等待发现文件带有该 nonce 的实例。等待期间,发现目录里的 `launching` 文件夹保存着 `<pid>.json`(pid、启动时间和 nonce 的哈希,绝无令牌)以及就绪文件,因此 `opentune_get_status` 会报告 [STARTING](#status-starting),重复或并发的调用会等待同一次启动。已有带控制接口的实例在运行(`alreadyRunning`;第二个实例需要 `allow_second_instance` 和用户的明确同意),或有一个没开控制接口的 OpenTune 在运行时,它什么也不启动。服务无法列出正在运行的进程时,无法排除后一种情况,也什么都不启动(错误 [OPENTUNE_NOT_AVAILABLE](#error-opentune_not_available),`reason` 为 `process_list_unavailable`)。`allow_second_instance: true` 不是幂等的:每次带它的调用,在之前的启动完成后都会多启动一个实例,所以每得到一次同意只用一次。它从不结束进程,超时之后也不会。

在 macOS 上,配置的程序是测试版的 `OpenTune-AI.command`。服务直接在它所在的文件夹里启动这个文件,选项和参数相同。脚本是在没有终端的情况下启动的,它会用 `exec` 把自己换成 OpenTune:服务启动的进程以及 `launching` 里的记录,就是 OpenTune 本身。脚本所在的文件夹是工作目录;不使用官方 app 做工作目录,因为 OpenTune 按 app 的路径找已安装的模型(见 [OT_MODELS_MISSING](#doctor-ot_models_missing))。

## Errors

先列 OpenTune 控制协议的各 kind,再列本服务新增的 kind。`executed` 为 false 表示请求没有改动任何东西;`null` 表示不知道是否执行了,所以重试修改之前要先重新读取状态。

### Error AUTH_FAILED

OpenTune 拒绝了发现文件里的凭据,通常是因为它重启过。请检查状态。

### Error PROTOCOL_MISMATCH

OpenTune 使用另一个协议版本。请更新 OpenTune 或本服务。

### Error SHUTTING_DOWN

OpenTune 正在关闭。先检查状态,再做别的。

### Error INVALID_ARGUMENT

参数被拒绝;`detail` 说明原因。原因为 `confirm_required` 时,该操作具有破坏性,需要用户的明确同意。原因为 `option_unavailable`
(`opentune_set_settings`)时,声码器权重或音高模型不是这套安装提供的值;`detail` 指出是哪一项,且没有任何改动。用
`opentune_get_settings` 读取可用的值(`processing.options`),再用其中一个重新调用。即使名称等于当前值,只要它已不在列表里
(例如权重文件被删除),也会被拒绝。`1.0.0-rc.5` 的测试构建完全不认识这些成员,会以原因 `invalid_params` 回答
(见 [Settings tools and the specification versions](COMPATIBILITY.md#settings-tools-and-the-specification-versions))。

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

修改声码器权重或渲染优先级(`opentune_set_settings`)时有两个原因:OpenTune 用一个任务应用这类修改,并等到声码器重新就绪。
两种情况下 OpenTune 都会撤回这些改动,结果里会写明。`vocoder_not_ready`(可重试):等待上限到了,声码器仍然忙;稍等片刻再调用,
若反复出现,运行 `opentune-mcp doctor`。`vocoder_load_failed`(不可重试):声码器无法加载新的权重或后端,例如权重文件损坏或不兼容;
原来的设置已经恢复,再次发送同一个值没有用。请告诉用户,并用 `opentune-mcp doctor` 检查模型。

### Error REVISION_CONFLICT

对象在被读取之后又变了。请重新读取,用新的版本号重试。

### Error UNDO_CONFLICT

撤销历史顶部不是预期的条目。请问用户如何处理。

### Error UNSAVED_CHANGES

该请求会丢弃未保存的改动。请问用户是保存还是丢弃。`opentune_quit` 给出这个错误是有意的:OpenTune 窗口的关闭按钮不会询问就直接退出,而这个工具不会。agent 先用 `opentune_save_project` 写一个自动副本(`autosave`;从未保存过的工程没有文件,写不了副本),再问用户:是正式保存(`save`;从未保存过的工程用 `save_as`)后再调用 `opentune_quit`,还是放弃这些改动;只有用户明确同意丢掉改动时,才带 `discard_unsaved: true` 调用。`opentune_open_project` 给出同样的错误,处理方式相同。

### Error ALREADY_EXISTS

目标已存在,而不允许替换。

### Error BUSY

OpenTune 正被使用:有对话框开着、用户正在拖动,或有导入、导出、工程操作在进行。请在 OpenTune 里完成它,再重试。原因为 `modal_open` 时有模态对话框开着;第一个通常就是一次性的首次引导对话框,见 [First launch dialog](#first-launch-dialog)。`opentune_manage_ui` 的 `dismiss_dialogs` 可以像按 Esc 一样关掉对话框;关闭时会提交所示取值的对话框(轨道颜色对话框)只有带 `accept_commit: true` 才会关,而这需要用户同意。关掉确认框等于取消它询问的操作,所以关闭任何对话框之前都要先问用户。原因为 `job_in_progress`(来自 `opentune_quit`)时,有任务还没结束(例如设置改动),退出会把它中断:等几秒再调用。

### Error TIMEOUT

OpenTune 在截止时间之前没有开始处理该请求。没有任何改动;请重试。

### Error CANCELLED

任务已被取消。它的结果会列出在停止之前已经提交的工作。

### Error IO_ERROR

某个文件无法读取或写入。不带 `path` 的导出写在源文件旁;该文件夹只读时导出会失败,服务不会另选文件夹。请用一个可写文件夹里的 `path` 再次调用 `opentune_export_audio`。来自 `opentune_save_project` 和 `opentune_save_project_overwrite` 的原因 `backup_failed` 表示:这次保存要替换的文件没能复制进它旁边的 `.oldversion` 文件夹,所以什么都没保存,那个文件也没变;见 [Autosave copies and old versions](#autosave-copies-and-old-versions)。来自 `opentune_save_project`(模式 `autosave`)的原因 `write_failed` 表示 `.autosave` 文件夹建不出来或写不进去。

### Error UNSUPPORTED

OpenTune 或该构建不提供这个操作。原因为 `capability_missing` 时,`detail` 指出缺少的能力;原因为 `no_editor_window` 时,OpenTune 是在没有编辑器窗口的情况下运行的,带窗口启动 OpenTune Standalone 后再试;原因为 `job_not_cancellable` 时,任务会继续,可以用 `opentune_get_job` 跟踪。`opentune_manage_ui` 的 op `switch_view` 需要能力 `ui.workspace`,规范 `1.0.0-rc.7` 之前的测试构建没有它:请在 OpenTune 窗口里切换视图(走带栏里的编曲视图与钢琴卷帘按钮),或改用较新的测试构建。`opentune_quit` 需要能力 `app.quit`,规范 `1.0.0-rc.7` 之前的测试构建没有它:请先用 `opentune_save_project` 写一个自动副本(`mode: autosave`),问用户是否正式保存工程,再请用户关闭 OpenTune 窗口(窗口关闭时不会询问未保存的改动)。`opentune_save_project` 的 `mode: autosave` 需要能力 `project.copy`,规范 `1.0.0-rc.8` 之前的测试构建没有它:不会写任何副本;请在用户想保住成果时提醒他保存工程,或改用较新的测试构建。

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

原因为 `read_too_slow` 时(来自带 `output_path` 的 `opentune_get_notes`),是本服务自己停止了分页读取:下一页可能在客户端放弃之后才结束(调用开始后 40 秒)。OpenTune 里没有任何改动,也没有写文件;请缩小范围(`from`、`to`)分成几个文件读取,或等 OpenTune 不忙时再调用。

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

`OPENTUNE_MCP_OPENTUNE_PATH` 必须是带控制接口的构建的 OpenTune 可执行文件的绝对路径,且旁边有 `opentune-control.json`。在 macOS 上,测试版不把该文件放进 app 包(放进去会破坏签名),而是放在 `OpenTune-AI.command` 旁边,也就是存放 `OpenTune-ctl.app` 的那个文件夹:请把变量指向 `OpenTune-AI.command`,不要指向 app 里面的可执行文件。变量指向 app 包内的可执行文件且清单缺失时,检查信息会这样提示。

### Doctor OT_NO_OFFICIAL_INSTALL

是否存在官方 OpenTune 安装(Windows 与 macOS)。在 Windows 上,服务读取注册表里的卸载项,再查看常见的安装文件夹。在 macOS 上,它查找 `/Applications/OpenTune.app`,并从其 `Info.plist`(`CFBundleShortVersionString`)读取版本;不会启动任何东西,也不会安装任何东西。找不到只是警告,不是错误。本服务从不启动这份安装。在 Windows 上,`opentune_launch` 启动的 OpenTune 以该安装为工作目录,这样没有自带 models 文件夹的构建能找到已安装的模型;没有安装时,以及在 macOS 上始终,工作目录是所配置可执行文件所在的文件夹。在 macOS 上,测试版不含模型,使用官方 app 里的模型,所以启动测试版之前请先在 `/Applications` 里安装官方的 macOS 版 OpenTune(1.8.0 或更新)。

### Doctor OT_VERSION_UNSUPPORTED

官方 OpenTune 安装的版本(Windows 读自其卸载项,macOS 读自 `Info.plist`)在 Windows 上必须是 1.7.9 或更新,在 macOS 上必须是 1.8.0 或更新(第一个官方 macOS 版本)。更旧的:请从官方发布页面更新 OpenTune。`warn` 且信息为「Not checked」表示没找到安装或该检查不适用于此系统;`warn` 且信息为「Cannot tell」表示该安装没有报告版本。

### Doctor OT_MODELS_MISSING

官方安装需要这个文件,且不能为空:`fcpe.onnx`。(`GAME` 文件夹里的音符分段模型不再检查:OpenTune 1.8.2 的代码已不使用它们,之后的官方版本也不再附带。)在 Windows 上,OpenTune 1.8 及之后把它放在 `%ProgramData%\OpenTune\Models`;1.7.x 放在安装文件夹的 `models` 文件夹里。在 macOS 上,检查沿用官方 app 的查找顺序,使用下列文件夹中第一个存在的:`/Applications/OpenTune.app/Contents/Resources/models`、`/Applications/OpenTune/models`、`/Library/Application Support/OpenTune/models`。该检查只看是否存在与大小,从不看内容。失败时,信息会指出它查看的文件夹和缺失的文件:请重新运行官方安装程序(或修复安装),让它恢复这个模型;在 macOS 上请重新安装官方 app。在 Windows 上已安装版本未知时,两个文件夹都会尝试,结果是警告。

### Doctor OT_SIDECAR_INCOMPLETE

测试版是一个 zip,可执行文件旁有一个 `SHA256SUMS` 文件(每行 `<sha256>  <相对路径>`;在 macOS 上它在 `OpenTune-AI.command` 旁边、存放 app 的文件夹里,清单里的路径包含 app 文件夹)。`fail` 表示它列出的某个文件缺失或哈希不符(信息会点名),或者清单无法读取。请删除该文件夹,把整个 zip 重新解压到一个空文件夹;不要把单个文件复制到旧版本上。`warn`(「Cannot verify」)表示没有 `SHA256SUMS`,这对你自己构建的可执行文件是正常的,此时无法检查该文件夹。

### Doctor OT_MODELS_SHADOWED

可执行文件旁的 `models` 文件夹会先于已安装的模型被找到。测试版不自带这个文件夹,所以除非是你有意放的,请重命名或删除它;信息会说明它是否包含全部所需的模型文件。在 macOS 上,检查还会查看可执行文件所在 app 包的 `Contents/Resources/models`,以及所配置文件所在文件夹里每个 `.app` 的 `models` 文件夹,因为 app 包会先于官方 app 的模型被查找。

### Doctor OT_D3D12_NOT_COPIED

测试版在 `opentune-control.json`(`d3d12`)里列出了 Direct3D 12 运行库,但没有自带它。没有这个文件时 OpenTune 在 CPU 上做推理,所以这是警告,复制是可选的。在一台有 NVIDIA 显卡的机器上实测:不复制时音高分析(F0)回落到 CPU。请在 PowerShell 里运行该检查打印出的命令,它们把 `D3D12Core.dll` 从官方安装复制到可执行文件旁的 `D3D12` 文件夹,并打印其 SHA-256 哈希,用来与 `opentune-control.json` 对比;请原样使用打印出的命令,因为它们会对含特殊字符的路径做转义。如果复制出的文件哈希不同(`fail`),请删除 `D3D12` 文件夹(回到 CPU),再从官方安装重新复制。`D3D12SDKLayers.dll` 是调试层:不要复制它,如果它在那里就删掉。「Cannot tell」表示 `opentune-control.json` 的 `d3d12` 条目没有列出文件,或哈希不是 64 个十六进制字符,所以什么也检查不了:请重新解压测试版。

在 macOS 上,这个检查始终以 `pass` 报告「Not applicable」:Direct3D 12 运行库是 Windows 组件,没有什么可复制的。

## macOS: first start blocked by Gatekeeper

macOS 测试版是 ad-hoc 签名、没有经过公证(notarize)的,所以 Gatekeeper 可能拒绝首次启动:macOS 提示 `OpenTune-AI.command` 或 `OpenTune-ctl.app`「无法打开,因为无法验证开发者」或「已损坏」,或者 `opentune_launch` 返回 `NOT_RUNNING`、`reason` 为 `launch_exited`(进程在启动后马上结束,因为没有人能回答那个对话框)。对下载来的未公证构建这是预期行为,不是本服务的故障;本服务只启动你配置的那个文件,也从不修改它的属性。

1. 把 zip 解压到你自己的文件夹里(例如用户主目录下),并让这些文件保持在一起:`OpenTune-AI.command`、`opentune-control.json`、`SHA256SUMS` 和 `OpenTune-ctl.app`。不要把 app 挪出这个文件夹。
2. 手动放行一次:在 Finder 里按住 Control 点击 `OpenTune-AI.command`,选择「打开」并确认。macOS 15 及更新版本没有这个捷径:先尝试打开一次该文件,再到「系统设置 > 隐私与安全性」,滚动到关于被拦截项目的提示,选择「仍要打开」。之后如果 macOS 又拦下 `OpenTune-ctl.app`,做法相同。(发布页面上的官方 OpenTune 是另一个 app,不受影响。)
3. 另一种做法:如果你信任这份下载(先把它与发布页面上的 `SHA256SUMS` 比对),可以自己去掉解压出的文件夹的隔离属性:`xattr -dr com.apple.quarantine <文件夹>`。本服务从不运行这条命令。
4. 先手动启动一次测试版,确认它能打开,再运行 `opentune-mcp doctor`,然后让助手再次启动 OpenTune。把 `OPENTUNE_MCP_OPENTUNE_PATH` 指向 `OpenTune-AI.command`(见 [Doctor OT_OPENTUNE_PATH](#doctor-ot_opentune_path))。

测试版需要 Apple 芯片、macOS 13.3 或更新版本,并且在 `/Applications` 里装有官方 OpenTune 1.8.0 或更新版本(见 [Doctor OT_NO_OFFICIAL_INSTALL](#doctor-ot_no_official_install))。

## Claude Code mcp add fails in PowerShell

`claude mcp add` 报 `missing required argument 'commandOrUrl'`(或 `'name'`)。有两个原因:

- 在 PowerShell 里,`claude` 会解析为 npm 生成的 `claude.ps1`,PowerShell 会在程序看到之前吞掉单独的 `--`,于是要注册的命令就丢了。改用 `claude.cmd mcp add …`,`opentune-mcp doctor --client claude-code` 在 Windows 上打印的就是这种写法。在 cmd 以及 macOS、Linux 上,`claude` 可以直接用。
- `-e`(`--env`)可以接任意多个值,写在它后面的名字会被当成又一个变量。名字(`opentune`)必须放在前面,打印出的命令就是这样写的。

## First launch dialog

OpenTune 在全新数据文件夹下首次启动时,会弹出一次性的首次引导(onboarding)对话框。需要有人在 OpenTune 窗口里回答一次。它(或任何其他模态对话框)开着时,所有写操作都会失败,返回 [BUSY](#error-busy),原因 `modal_open`。`opentune_get_settings` 会报告首次引导是否已经显示过。`opentune_get_status` 与 `opentune_launch` 在实例能报告窗口状态时会读一次窗口,并在结果里加上 `blockedBy`(`kind` 为 `onboarding` 或 `dialog`,另有一句提示),摘要会说明在对话框关闭之前写操作都会被拒绝,而不是说一切就绪。请让用户回答该对话框,然后重试。`opentune_manage_ui` 也能像按 Esc 一样把它关掉:首次引导覆盖层用 `dismiss_onboarding`(它同时把首次引导标记为已显示,这是撤销不了的全局设置,所以要先告诉用户 OpenTune 正显示欢迎页,用户同意后再关),其他对话框用 `dismiss_dialogs`。服务从不按对话框里的按钮。读不到窗口状态时,`blockedBy` 为 null,原因 `unavailable` 写在 `nullReasons` 里,状态仍按就绪报告。实例没有 `ui.bridge` 能力时根本无法报告窗口状态:`blockedBy` 同样为 null,原因为 `capability_missing`,这并不表示没有对话框开着。

## Rendering backend and vocoder

`opentune_get_settings`(`processing` 小节)会显示渲染优先级和 OpenTune 当前使用的后端(`processing.backend`)。`gpuFirst` 下,OpenTune 每次加载声码器都会先尝试 GPU,失败时退回 CPU,所以 GPU 并不保证可用。实现了规范 1.0.0-rc.9 的 OpenTune 会在改动之后立即发生这种情况时说明:把优先级改成 `gpuFirst`、结束时后端是 `cpu` 的 `prefs.set` 调用,其作业结果带告警 `BACKEND_FALLBACK`(`data`:`requested`、`actual`),`opentune_set_settings` 会把它转述出来;更早的 OpenTune 什么也不说。优先级是 `gpuFirst`、后端是 `cpu` 且声码器已加载(`processing.vocoderReady` 为 true)时,摘要会指出这一点;声码器没加载时,`backend` 可能还是旧值,所以不据此下结论。想知道原因,请读日志:用 `opentune_get_settings`,`sections` 为 `["log"]`、`log_lines` 为 30,可以看到与后端有关的日志行。Windows 上还可以运行 `opentune-mcp doctor`:它检查测试构建在 `opentune-control.json` 里列出的 Direct3D 12 运行库(见 [OT_D3D12_NOT_COPIED](#doctor-ot_d3d12_not_copied))。改了渲染优先级之后,`opentune_set_settings` 会在作业结束后读一次后端,放进 `rendering_backend`;等了一小会儿声码器仍在重新加载时,会如实说明,而不是猜测。如果改动时声码器还没就绪(刚启动、还没渲染过),OpenTune 可能在声码器重新加载完成之前就结束了作业,这时读到 `cpu` 并不能证明发生了回退:`rendering_backend.confirmed` 为 `false`,要等下一次加载后才能确定后端,请在渲染过一次之后再读 `opentune_get_settings`。

刚启动 OpenTune 时 `vocoderReady: false` 是预期之中的:声码器在第一次渲染需要它时才加载,`opentune_get_status`、`opentune_launch` 与 `opentune_get_settings` 的摘要都会这么说。摘要不说它「正常」,因为 `session.info` 与 `prefs.get` 里没有哪个成员能分辨「还没加载」与「加载失败」或「卡住」。如果渲染过一次(需要渲染的编辑、导出)之后它仍是 false,请告诉用户,并读日志找原因(`opentune_get_settings`,`sections` 为 `["log"]`)。声码器权重或渲染优先级的修改,在 OpenTune 加载不了新权重或后端时,会以 [MODEL_UNAVAILABLE](#error-model_unavailable)(`vocoder_load_failed`)失败。

## Hybrid mode

OpenTune 首选项里的「混合模式:小修用dsp,大修用声码器」(英文界面为 "Hybrid Mode: Small corrections use DSP, large corrections use vocoder")默认开启。修正量中小于 75 音分的部分走 DSP 移调,而不是声码器。这是 OpenTune 自身的设计,在它的窗口里和通过本服务都一样;在真实人声上,这种小修正可能几乎听不出来。如果需要小修正也明显可听,请在 OpenTune 的首选项里关闭该项,或让 agent 用 `opentune_set_settings`(`processing.hybrid_mode`)来关。它是 OpenTune 安装的全局设置而不是工程设置,关掉之后一直保持关闭,直到再把它打开;`opentune_set_settings` 的结果会给出恢复原值的调用。当时的设置会如实报告,位置有三处:`opentune_export_audio` 结果里的 `export.processing.hybridMode`;导出作业在调用内没跑完时,`opentune_get_job` 里的 `job.result.processing.hybridMode`;首选项本身在 `opentune_get_settings` 的 `processing` 小节。不要想当然。

## Autosave copies and old versions

两个文件夹都在工程文件旁边,以去掉 `.otproj` 的工程名命名。`opentune_save_project` 的 `mode: autosave` 写 `<工程名>.autosave/<工程名>-autosave-0001.otproj`、`-0002` 等,保留最新的 10 个;它从不改动工程文件、未保存标记或最近工程列表,只在 `<工程名>.autosave` 里写文件(副本,以及放它音频的文件夹 `<工程名>-autosave-0001_Media` 等:OpenTune 按工程文件的名字给它的音频文件夹命名,所以在实现 1.0.0-rc.9 规范的版本里,每个副本都有自己的文件夹,不会替换别的工程的音频)。出于同一个原因,每个副本都带一整套工程的音频;所以 `<工程名>.autosave` 占用的空间约为音频大小乘以最多 10;服务滚动删除一个旧副本时,会把它的媒体文件夹一起删掉(见下)。实现更早规范的版本(测试版 `synchain-test/v1.8.0-ctl.2` 和 `ctl.3`)不给副本单独的文件夹:所有副本的音频放进同一个共用文件夹 `<工程名>.autosave/Project_Media`,同名文件会被替换,服务也从不删除它。线上的协议版本分不清这两种版本,所以写完一个副本后,服务会去找它的文件夹:`autosave.mediaFolder` 在副本自己的文件夹存在时是它,否则是共用的 `Project_Media`(摘要里会说所有副本共用它),两个都没有则为 null,`nullReasons.mediaFolder` 为 `media_folder_not_found`。被删的副本没有自己的文件夹不算失败;`autosave.audioFoldersCouldNotRemove` 统计被删副本中自己的文件夹没删掉的个数(摘要里会说 "The audio folders of N deleted copies could not be deleted."),与统计删不掉的副本的 `autosave.couldNotRemove` 分开。每次会替换工程文件的保存,都会先把旧文件复制到 `<工程名>.oldversion/<工程名>-<YYYYMMDD-HHMMSS>.otproj`(本地时间,同一秒重名时加 `-2`、`-3`),保留最新的 10 个;如果最新的旧版本已经和要被替换的文件逐字节相同(紧接着一次没有任何改动的保存之后再保存),就不再复制新的一份,结果里会说明(`oldVersion.reused`)。服务只在这两个文件夹里删除名字符合上述模式的普通文件:这样的文件都按副本或旧版本计数,超出最新的 10 个就会被删,不论是谁放进去的;删除一个副本时,会把这个副本的媒体文件夹也删掉:只删名字为副本名(去掉 `.otproj`)加 `_Media` 的那一个文件夹,并且只删直接在里面的普通文件(里面有子文件夹或链接时它们保留,文件夹也就保留);删不掉的副本,它的媒体文件夹也保留。其他文件夹、链接、其他名字的文件、保留下来的副本的媒体文件夹、不属于任何副本的媒体文件夹、本服务在 `<工程名>.oldversion` 里放的媒体文件夹(见下)和其他工程的文件都不会被动。OpenTune 拒绝保存、或报告没有任何改动(`executed` 为 `false`,或对另一个已有文件的拒绝 `confirm_required`)时,工程文件还是原样,所以刚做的那份旧版本会被删掉(只是沿用的旧版本从不删除)。保存以其他方式失败时,旧版本会保留,因为工程文件可能已经写了一部分:它就是退路。被拒绝的保存之后可能留下一个空的 `<工程名>.oldversion` 文件夹;服务删除的文件夹只有它滚动删除的自动副本的媒体文件夹。要找回之前的成果,用 `opentune_open_project` 打开想要的那个文件。

自动副本和旧版本里的音频路径是相对它所在文件夹写的,所以只会在它自己文件夹里的媒体文件夹里找音频。`<工程名>.autosave` 里的副本有这样的文件夹,由 OpenTune 填。旧版本的这个文件夹由本服务填:每次做旧版本(或沿用已有的旧版本)时,在保存开始之前,把被替换文件旁边媒体文件夹里的普通文件复制到 `<工程名>.oldversion` 里同名的文件夹。OpenTune 按工程文件的名字给媒体文件夹命名,即 `<工程名>_Media`。更早的 OpenTune 保存的工程文件把音频写在共用的 `Project_Media` 文件夹里;没有 `<工程名>_Media` 时,服务复制的就是那个,复制到 `<工程名>.oldversion/Project_Media`。服务自己的规则是:文件只在那里缺失、或比来源旧时才复制;更新的文件从不覆盖,什么都不删,链接和子文件夹跳过。音频到位后,即使原始音频文件(例如下载文件夹里的)被删掉了,旧版本照样能打开。被替换的文件没有媒体文件夹时什么都不做。

复制的是整个媒体文件夹,而不只是这个工程用到的音频:要分辨工程用到哪些文件,就得解析工程文件,本服务不这样做。`<工程名>_Media` 只放这个工程文件的音频,所以不会带上别的工程的东西。更早的 OpenTune 的 `Project_Media` 文件夹是同一目录下所有工程文件共用的,所以同目录下其他工程的音频也会被复制进去;而每个工程文件都有自己的 `<工程名>.oldversion/Project_Media`,所以同一目录放多个工程文件时,占用的空间会按工程文件的数量成倍增加。建议一个工程一个文件夹。旧版本的滚动删除从不动那里的媒体文件夹,所以它只增不删;确定不再需要这些旧版本时,可以手动删除。那里的文件会被同名且更新的来源文件替换,所以更早的旧版本此时找到的是那个名字下更新的音频。

复制有 15 秒的时间上限,免得第一次保存一个音频很多的工程时把保存拖住。时间是在两个文件之间检查的,所以单个特别大的文件仍可能超过。到了上限,还没轮到的文件不再复制,保存照常进行:`oldVersion.media.timedOut` 为 `true`,这些文件列在 `oldVersion.media.notCopied` 里(也计入 `notCopiedCount`),结果里有下面说的那条告警行和摘要里的一句话。这不是失败:下一次替换这个工程文件的保存会接着复制剩下的(只复制缺失或更旧的文件),所以再保存一两次就能把一个大文件夹补齐。在那之前,原始音频文件被删掉之后,这个旧版本可能找不全它的音频。

有些音频没能复制(磁盘已满或只读,或文件被占用)时,保存照常进行;除非时间也用完了,否则 `oldVersion.media.timedOut` 为 `false`。结果里会有一条告警行(代码 `OLD_VERSION_MEDIA_NOT_COPIED`,`source: server`;失败和时间上限用同一条告警行,各有一句话)和摘要里的一句话,`oldVersion.media.notCopied` 列出这些文件(形如 `<工程名>_Media/1.wav` 的路径;整个文件夹读不了或建不出来时是媒体文件夹的名字本身;`notCopiedCount` 是完整的数目)。原始音频文件被删掉之后,这个旧版本可能找不到它的音频。排除原因(腾出空间、关掉占用文件的程序)后再保存一次:缺的文件会补上。`oldVersion.media.copied` 是这次保存复制的文件数。

## Slow process discovery

在 Windows 上,服务会读取 OpenTune 进程的启动时间,以区分活着的实例与过期的发现文件。PowerShell 冷启动之后的第一次读取有时很慢,所以发现实例可能比平时多等几秒。这不是错误;客户端等不及放弃的话,再调用一次即可。
