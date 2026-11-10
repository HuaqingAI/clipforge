# Windows 客户端官方源安装验证记录

验证日期：2026-11-10。应用 0.9.11，Windows x64，Electron 42.4.1，普通 Node 24.18.0 / ABI 137。

## 当前产物

- `release/workbench/ClipForge Setup 0.9.11.exe`：最新官方源在线安装器，125,351,550 bytes，约 119.5 MiB。
- SHA256：`c6da9b1fbbf057c3fea03a1da629784fbebf19f9ff54ef919bb8959f34301b5d`。
- `release/workbench/win-unpacked`：对应应用布局。`release/official` 为此前官方源版本，未包含本次设置改造。
- 清单：schema 2，`installMode: official-sources`，runtimeId `desktop-v2-node24.18.0-win32-x64-884f778a3dadbec8`。
- 官方下载：71 个文件，1,386,958,102 bytes，约 1.29 GiB。37 项固定 Python 依赖；6 个本项目支持文件共 2,882,684 bytes。

`release/fixed` 和 `release` 顶层是旧资源包下载方案的产物，不能用于新的官方源安装。旧的资源草稿已删除，未公开发布；新安装器不依赖本项目 GitHub 托管资源。旧 tar.gz 构建文件不参与新打包。

## 来源和构建校验

实际清单包含 Node.js 1、Python 1、PyPI 36、PyTorch CPU 2、npm 5、Hugging Face 22、NLTK 1、FFmpeg 上游 3 个下载；没有本项目 Release URL。全部 71 个真实 HTTPS 地址通过匿名 Range/大小验证，日志 `.clipforge/desktop-official-urls.log`。

官方源 lock 已入代码，构建默认不访问网络。禁用 fetch 后连续两次构建生成字节一致清单；requirements 漂移会被拒绝。安装器内逐字节核对主进程、官方安装模块和清单，6 个支持文件的 SHA256 与清单一致。app.asar 仅 19 个应用条目，CLI/Python/wheel/模型不在包内；SQLite 仍由普通 Node ABI 137 构建并在打包后实际执行查询。

本次设置改造后，Web 和桌面均已重新完成生产构建，最终进程退出码均为 0。Web 构建 ID 为 `v2TIH77xcp-ed-ZeZJpnO`，桌面为 `8chURoQ1SMKMdkZOeYjKg`。Web `.next` 和桌面 `.next-desktop` 分开，未改写 Web 原生模块；打包后已核对源码、app.asar 和桌面构建 ID 一致。

## 工作台设置改造

Web 和客户端的页面标题统一为「AI 短视频工作台」。平台设置以 HTH 替代 OpenAI 显示名称，HTH 和脚本模型的默认地址均为 `https://hth.huaqing.run/v1`；文本与视觉默认模型为 `gpt-6.1-sol`。品牌设置入口及面板已移除；火山引擎、阿里百炼、硅基流动退出新配置和目录查询，原凭证和历史任务适配器保留。新视频模型只从 Kling CLI 账号目录读取，单次生成花费上限默认 0（关闭上限，并非生成免费）。

设置持久化升级到 v9：保留 Key、自定义端点及模型，迁移明确的旧默认值；旧非 Kling 默认选择清空，避免自动选择另一个付费模型。确认窗口提交遇到网络中断、结果待核对时会阻止重新提交；明确的提交前拒绝仍可重新确认。

本次设置与迁移、平台适配器、目录及本机访问回归均通过。素材页全部 118 项测试通过，覆盖 HTH 图片、新 Kling 视频、旧平台任务恢复、提交结果不明阻止重复提交和明确拒绝后可重试；TypeScript 和改动文件 ESLint 通过。

最终 Web 生产冒烟验证新标题、HTH 默认输入、移除的设置入口、全新数据库和 Web/ASR 模式；向视频目录请求传入 `openai` 返回空列表，未访问上游。日志 `.clipforge/web-workbench-final-smoke.log`。最终桌面使用已验证的同一官方资源环境完成真实渲染器及后端冒烟，退出码 0，包含 `SMOKE_OK`；本地配置存储、React 交互及 18 项静态资源通过，日志 `.clipforge/desktop-workbench-smoke.log`。运行资源清单未变，以下完整图形下载/安装验收继续适用。

## 已完成验证

- 35 项 Node 桌面测试全部通过、无跳过，覆盖官方清单、ZIP CRC 与越界/链接拒绝、npm tgz/PAX、下载续传、永久 HTTP 错误、连接/停滞超时、取消、Python 配置调用、文件库存、损坏修复、目录占用和原子恢复、Windows 盘符及 IPC 来源；通过 `CLIPFORGE_TEST_EMBEDDED_PYTHON_DIR` 指定实际官方 Python，额外验证超过 260 字符的模块导入、移动目录后继续导入和禁用 pyc。
- 19 项 bundle、shell、renderer 的 Vitest 全部通过，相关入口语法检查通过。
- 官方 Python 3.12.10 ZIP 使用新安装模块的解压器真实解包；配置独立 `._pth`；从固定 pip 25.0.1 wheel 启动，使用已下载且锁定 hash 的 37 个 wheels 离线安装，未用系统 Python、npm/pip 或在线依赖解析。
- 新 Python 实际完成 torch/WhisperX 导入、NLTK、CPU wav2vec2 推理；Node/Kling/ElevenLabs 版本和 FFmpeg 滤镜、字幕字体短片渲染全部通过。
- 完整图形安装已从原始官方 HTTPS URL 实际下载并校验全部 71 个文件。首次自检发现 embedded Python 长路径问题后，修复使用同一已校验缓存继续复验；最终安装和第二次启动均输出 `GUI_SETUP_OK`，第二次复用完整环境且下载缓存未改变。
- 最终安装冒烟退出码为 0，日志 `.clipforge/desktop-official-install-smoke.log` 包含 `DESKTOP_INSTALL_SMOKE_OK`。客户端页面成功 hydration、本地存储正常、18 项静态资源加载成功；`WEB_BACKEND_SMOKE_OK` 确认 Web 生产服务、新数据库、Web 模型策略、页面和媒体路由导入均通过。

## 已修复的安装缺陷

原图形安装入口把小写 `d:` 的本地路径与 Chromium 规范成大写 `D:` 的 URL 严格比较，拒绝合法就绪通知。本地清单读取约 252 ms，卡顿发生在安装启动前；现按 Windows 规则比较路径，仍绑定 exact sender/mainFrame，界面初始化 15 秒超时报错。

原资源 URL 指向未创建的本项目 Release，因此 HTTP 404。用户明确选择官方源后，已完全替换为各上游固定原始发行文件，安装器自动配置环境。正式新构建拒绝旧 schema 1 自托管资源包清单。

官方 embedded Python 的 `._pth` 会丢失扩展路径前缀，使深层 Transformers 模块导入失败。安装配置现生成可搬迁的 `sitecustomize.py`，在任何第三方导入前统一扩展路径。真实 175 字符的 Python 目录使用普通文件硬链接（无目录 junction/symlink）复现原错误，修复后 `-I` 隔离导入和完整 CPU 自检通过；同一深目录实际执行 `align.py` 成功输出 6 个英文单词的真实时间戳。

Windows 原生自检后偶发 EPERM 目录占用，备份/提交/恢复现最多重试 15 秒并显示等待进度。真实子进程占用目录测试确认释放后提交成功，持续占用则超时恢复原目录并释放安装锁。

## 范围

此前全量 Vitest 5,027 项通过、3 项既有失败、2 项跳过；3 项失败已以改造前 HEAD `2a99bf61978b2044d1077d4a3ab0066c2a2b33a1` 原文件复现（1 项 asset-context 状态码旧断言、2 项 video-selection UI 旧断言）。未恢复已移除的 Kling 一键整片。

测试不登录云账号、不提交计费生成、不读取用户项目。干净 Windows 的完整 NSIS 安装、断网转写/合成及账号授权仍需发布验收。Windows x64 为当前范围；macOS/Linux 需独立适配。使用方式见 [客户端安装与迁移](desktop-online-install.md)。
