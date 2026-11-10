# Windows 客户端在线安装与迁移

当前客户端适配目标为 **Windows x64**。Electron 客户端与 `start.cmd` 本机网页版共用 Next 页面、API、数据库和生成任务逻辑；macOS/Linux 的在线运行资源尚需独立构建与验收。源码启动方式继续见 [Windows 源码双击启动](local-launcher.md)。

## 安装与首次使用

1. 下载当前版本的 Windows `.exe` 安装程序，选择安装目录。安装到当前 Windows 用户，无需预先安装 Node.js、Python、npm 或 pip。
2. 保持联网。安装过程中会打开资源准备界面，下载并校验工具、依赖和模型，自动配置独立环境。PyTorch 优先使用南京大学、阿里云镜像，pip 等 PyPI 文件优先使用清华、阿里云镜像，对齐模型和 Whisper Tiny 优先从 ModelScope 的固定版本下载；镜像失败后回退对应上游发行源，所有来源使用相同的固定大小与 SHA256 校验。其他资源继续从 Node.js、Python、npm 等上游发行源下载。**大资源不内置在安装包中，也无需本项目 GitHub 托管。**
3. 等待所有下载、本机模型推理、CLI、FFmpeg 和数据库检查通过。失败时安装不能报告成功；可按界面提示重试，已校验的下载会复用，服务器支持时可续传。
4. 打开客户端，在设置中启用 Kling 官方 CLI，检测环境并完成自己的账号登录；使用 ElevenLabs 时在「设置 → 配音」开启并完成 OAuth，选择声音与模型。授权链接通过系统浏览器打开，安装程序不会登录账号或触发计费生成。

正常启动只验证已有资源；缺失或损坏时会显示修复入口，由用户点击开始在线修复。安装后的本地对齐、Tiny 转写与 FFmpeg 使用已安装资源；云端生成、免费在线 TTS、OAuth 和素材搜索仍需要网络。桌面版当前提供 Tiny 转写，不会在正常转写期间偷偷下载其他模型档位。

关闭窗口后，客户端通过托盘继续运行后台任务；需要停止时使用托盘或「文件 → 彻底退出」。有运行中任务时会确认退出，本机处理将中断。已受理的云端生成不会因退出而取消，重新打开后按原任务查询、保存，避免重复提交。Kling 支持单镜头、批量镜头和后续标准合成，已移除的 Kling 一键整片流程不在此适配中恢复。

## 安装界面长时间没有进度

“读取安装资源清单”只读取安装目录中的本地 JSON，不需要联网，不应持续数分钟。安装日志位于 `%APPDATA%\ClipForge\logs\install.log`。

2026-11-10 修复了图形安装入口的 Windows 路径大小写问题：例如从 `d:\ClipForge` 启动时，Chromium 会将页面 URL 的盘符规范成 `D:`，旧版错误拒绝界面就绪通知，使安装尚未开始就停在初始提示。修复后的入口按 Windows 路径规则校验来源，并对界面加载或就绪通知失败给出明确错误。

连接下载来源、下载、缓存校验、解压、Python 依赖配置及模型自检分别显示实际阶段。国内镜像失败后会尝试后续镜像及上游地址；所有候选均失败时明确报错，可以重试。无需在系统配置 pip 国内源或 `HF_ENDPOINT`。旧版指向本项目 Release 的资源清单已取消；旧安装器中的 404 需要使用新的固定资源安装包解决。新清单中的所有镜像与上游地址可用 `pnpm desktop:verify-downloads` 逐一检查。

如果最后显示“等待文件释放”，程序正在处理 Windows 临时文件占用，最多等待 15 秒后明确报错。重试可以复用已校验的下载缓存；目录切换失败时会恢复原运行资源。

## 目录与设置

在线资源位于 `%LOCALAPPDATA%\ClipForge\runtimes\<runtimeId>`，下载缓存位于 `%LOCALAPPDATA%\ClipForge\downloads`，与应用安装目录和业务数据分开。升级使用版本化资源目录，验证失败不会替换已经可用的版本。

新客户端默认在 Electron 用户数据目录下的 `data` 保存项目、素材、成片、任务回执及任务密钥，可通过「文件 → 打开当前数据目录」查看实际位置。日志位于同一 Electron 用户数据目录下的 `logs`；安装日志是 `install.log`，日常运行日志是 `server.log`。卸载程序保留用户数据。

客户端中的服务配置、品牌、资料库和界面偏好通过系统凭据机制加密保存，不依赖后端端口。Web 仍使用当前浏览器和访问地址下的存储，两个入口的配置不会自动合并。可在设置页「Web 与客户端之间迁移设置」中导出 JSON，再在另一端导入并覆盖同名配置。

导出默认排除服务密钥；勾选「导出时包含服务密钥」才会包含它们，该 JSON 是可读取的备份文件，应妥善保管。配置导入不包含项目媒体或 OAuth 凭据。ElevenLabs OAuth 继续使用当前系统用户的官方 CLI 凭据库；Kling 的独立账号与任务绑定信息保存在工作区中，安装资源包不携带任何账号凭据。

## 打开旧版 Web 项目

1. 在原 `start.cmd` 控制台按 **Ctrl+C** 停止 Web 服务，备份完整 `data` 目录。
2. 打开客户端，选择「文件 → 打开已有工作目录…」，选择旧源码根目录或其中完整的 `data` 目录。
3. 确认切换。客户端原地使用该目录，保留数据库、任务密钥、登录资料、素材和已有的绝对路径引用，不复制一个孤立的 `sqlite.db`。
4. 如需原浏览器中的服务/品牌等配置，先在 Web 设置导出，再到客户端设置导入；检查账号登录状态和默认模型后继续使用。

同一工作目录同时只能由一个 ClipForge 服务使用。目录中必须有 `sqlite.db`；损坏的任务密钥会阻止打开，有历史生成任务而缺失 `generation-task.key` 时必须恢复原始完整备份。不能删除密钥让程序新建，否则旧任务快照无法解密。客户端保存的目录指针为 Electron 用户数据目录内的 `workspace.json`；损坏或读失败时明确报错，不会自动切到空项目。切换失败会尝试回到原工作目录。

## 构建与发布

安装器在 Windows x64、**Node 24.18.0 / ABI 137** 环境构建，客户端 Next 后端和 Kling 使用该普通 Node 运行。Electron 只负责桌面壳，不为业务数据库重新编译 Electron ABI。固定来源、版本与自动配置详见 [官方源在线安装规范](desktop-runtime-resources.md)。

```powershell
pnpm install --frozen-lockfile
pnpm test:desktop-runtime

# 从受版本控制的 lock 生成固定官方源清单，不下载大资源
pnpm desktop:runtime
pnpm desktop:verify-downloads

# 自动执行 desktop:build，再生成 release 下的 Windows NSIS 在线安装器
pnpm dist

# 打包程序按清单下载固定资源，测试配置、后端及页面
pnpm desktop:smoke
```

`pnpm build` 构建 Web 的 `.next`；`pnpm desktop:build` 单独构建 `.next-desktop` 并生成 `artifacts/desktop/win32-x64`，二者互不覆盖。`pnpm pack:dir` 自动执行桌面构建并输出 `release/win-unpacked`，用于布局调试；它没有执行 NSIS 安装阶段，可显式运行其中的 `ClipForge.exe --install-runtime` 准备资源，或使用 `desktop:smoke` 做隔离验证。

`artifacts/runtime` 的新产物只有官方源清单和少量本项目 `support` 脚本/字体，无需生成或上传运行资源压缩包。打包钩子不允许把开发机 Python、模型、wheel、业务 `data`、`.env` 或账号资料复制进安装包。旧构建留下的 tar.gz 不是新安装器的资源，不参与打包与发布。

`.github/workflows/release.yml` 使用同一固定 lock，依次验证下载地址、构建、执行真实资源安装冒烟，最后上传安装器草稿。无需发布资源 Release 即可安装；客户端按清单访问受控镜像与上游地址。

`desktop:smoke` 对新清单保留固定 HTTPS 下载地址及镜像顺序，使用隔离目录与实际图形窗口完成首次下载和配置、资源复用、缺失清单失败及深度验证。随后检查客户端页面、加密配置、React 交互和普通 Node 后端；同一后端再以 Web 模式验证全新数据库、ASR 远端资源策略、HTML 和媒体接口。正式发布还需在无系统 Node/Python 的干净 Windows 环境完成安装与断网本地功能验收；OAuth 与付费生成由使用者自行确认。
