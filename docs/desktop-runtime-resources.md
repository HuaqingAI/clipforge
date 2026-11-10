# 桌面版官方源在线安装

客户端安装时从受控国内镜像和工具、模型的上游发行源下载，自动配置独立环境。PyTorch、PyPI 文件及对齐、Whisper Tiny 模型优先使用清单内的国内镜像，失败时回退原始上游地址；所有来源都校验同一组固定大小与 SHA256。安装器不包含 Node、CLI、Python、第三方依赖或模型，也不依赖本项目 GitHub 的资源 Release。旧的五份自建资源归档分发方案已取消。

## 下载来源与固定版本

| 内容 | 来源 |
| --- | --- |
| Node 24.18.0 / ABI 137 | nodejs.org 官方 Windows x64 ZIP |
| Kling 0.2.0、ElevenLabs 1.8.0 | 官方发布的 npm 包及 ElevenLabs Windows 平台包 |
| Python 3.12.10 | python.org 官方 Windows x64 embeddable ZIP |
| pip、音频对齐 Python 依赖 | 清华 PyPI 文件镜像 → 阿里云 PyPI 文件镜像 → PyPI 原始文件源 |
| CPU torch/torchaudio 2.8.0+cpu | 南京大学 PyTorch CPU 镜像 → 阿里云 PyTorch CPU 镜像 → PyTorch 原始文件源；固定 CPython 3.12 / Windows x64 wheel |
| 英文 wav2vec2 对齐模型 | ModelScope AI-ModelScope/wav2vec2-base-960h 固定 commit → Hugging Face facebook/wav2vec2-base-960h 固定 revision |
| Whisper Tiny 本地转写 | ModelScope onnx-community/whisper-tiny_timestamped 固定 commit → Hugging Face 同名模型固定 revision |
| ONNX Runtime Web | 与应用版本匹配的 npm 发行包 |
| NLTK 英文分词数据 | nltk/nltk_data 上游仓库的固定 commit |
| FFmpeg/FFprobe Windows 二进制 | 项目锁定媒体依赖的上游发行渠道 |

Python 3.12.12 是仅提供源码的安全维护版本，因此使用最后提供官方 Windows 二进制的 3.12.10；不再使用第三方重打包的便携 Python。FFmpeg 项目本身不发布 Windows 可执行文件，使用当前媒体依赖的上游维护者发行包，不在本项目重复托管。

版本、原始 URL、按优先顺序排列的 `mirrors`、大小和 SHA256 保存在受版本控制的官方源 lock 中。镜像必须与该原始资源的受控映射一致，不能替换成任意下载地址。客户端安装时不查询 latest、不依赖 npm/pip 在线解析版本，也不接受远端返回的新校验值。

ModelScope 对齐模型固定 commit 为 `0c5dbe4bd2fc93cfaf7caf14bba8758bc433ae2b`，Whisper Tiny 固定 commit 为 `57245b55a20850977898baf6d5cdcc24d98a44e5`，分别覆盖原清单中的 7 个和 15 个文件。它们的文件大小及平台公布的 SHA256 与原清单一致；镜像分发不改变模型、量化档位或推理流程。安装器继续使用原清单 SHA256 验证实际下载内容。

这些镜像用于安装器预下载固定文件，不依赖系统 `pip` 配置、`PIP_INDEX_URL` 或 `HF_ENDPOINT`。下载后仍从受管 wheelhouse 离线安装 Python 依赖。Node、Python 本体、npm 包、NLTK 与 FFmpeg 的下载来源保持上游发行地址。

## 构建

在 Windows x64、Node 24.18.0 / ABI 137 环境执行：

```powershell
pnpm desktop:runtime
pnpm desktop:verify-downloads
pnpm dist
pnpm desktop:smoke
```

`desktop:runtime` 从已审核的 lock 生成 `artifacts/runtime/desktop-runtime-manifest.json`，并准备 `artifacts/runtime/support` 下少量本项目脚本和自检字体。不下载或生成大型资源归档；无需 `--base-url`。

只有维护者主动更新锁时才运行构建脚本的 `--refresh-lock`。更新后必须核对来源、版本、许可证及 SHA256，并通过完整实际安装验证。不要在安装阶段动态生成 lock。

`desktop:verify-downloads` 不带登录凭据逐一访问清单中的所有镜像与原始上游 URL，检查状态、Range 和大小；任何候选地址失败都会报告错误，避免回退掩盖失效镜像。`--hash` 会流式下载所有候选来源的资源并校验原始 SHA256，不保存副本。完整安装冒烟会按镜像优先、上游回退的顺序实际下载资源并校验，覆盖配置、模型推理、CLI、媒体、数据库和页面交互。正式安装器交付前应至少完成一次真实资源安装。

## 安装过程

1. 读取安装器内置的 schema 2 清单，检查平台、路径和固定 SHA256。
2. 按清单顺序优先尝试受控国内镜像，失败后回退原始上游地址；将原始 ZIP、npm tgz、wheel、权重文件下载到受管缓存，支持校验复用、重试和服务器支持的断点续传。每个候选来源都必须通过同一组大小与 SHA256 校验。
3. 在独立 staging 目录展开 Node、CLI 和 Python，拒绝越界路径、链接、重复文件与超量展开。
4. 配置独立 Python 搜索路径，用已固定下载的 pip/wheels 本地安装依赖；禁止再次联网解析依赖，不修改系统 Python、PATH 或注册表。
5. 安装模型、英文 NLTK 数据、ORT 与媒体工具，复制本项目支持脚本和字体。
6. 真实检查 Node ABI、CLI 版本、Python 依赖、CPU 对齐推理、FFmpeg 滤镜和短片渲染；启动隔离 Next 后端检查数据库。
7. 所有检查成功后原子提交目录并完成安装。失败不标记就绪，不覆盖可用版本。

安装中显示下载来源对应的阶段、字节进度、Python 配置和模型自检。连接 30 秒无响应、下载 60 秒无数据或校验失败时，镜像直接切换至下一候选来源，上游来源最多尝试 3 次；所有候选均失败时明确报错。同一地址支持跨安装断点续传；若上次回退来源留下有效断点且该地址仍在受控候选中，重试先续传该来源，避免丢失已下载的大文件。切换地址会重新下载部分文件，避免混用不同来源的数据；已完整校验的缓存仍可复用。Windows 目录切换的临时占用最多重试 15 秒。取消终止本次安装，已校验下载可在重试时复用。

## 目录与兼容

资源缓存位于 `%LOCALAPPDATA%\ClipForge\downloads`，可用版本位于 `runtimes/<runtimeId>`；业务数据和账号不在资源中。安装就绪记录包含实际文件库存与清单摘要，深度检查校验文件内容并执行原生自检。Python 禁止写入字节码缓存，使用 Windows 扩展路径处理深层依赖导入。

官方 embedded Python 会把 `._pth` 中的路径还原成普通 Windows 路径。安装器因此在其独立目录生成可搬迁的 `sitecustomize.py`，在每次脚本或 pip 导入第三方库前统一扩展路径，覆盖安装自检与正常音频对齐；不记录临时目录、不依赖用户环境变量。已用真实深层中文目录及迁移后的路径验证。

安装器仍支持读取旧 schema 1 资源记录以便诊断兼容，但新构建只允许官方源 schema 2，不能再打包依赖自建 Release 的安装器。Web `start.cmd` 保留原启动和模型策略，共用业务页面、API、任务和合成逻辑。

安装过程中不登录 Kling/ElevenLabs，不读取用户项目或提交付费生成。正常运行使用已经安装的本地资源；云端生成和账号授权仍需要用户自己的网络及账号。
