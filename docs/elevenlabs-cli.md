# ElevenLabs CLI 配音

「设置 → 配音」统一管理配音服务，仅提供「微软 TTS · 免费」和「ElevenLabs · 克隆声音 / 官方 CLI」。ElevenLabs 使用当前电脑上官方 CLI 已授权的账号生成配音，声音列表包含账号已有的克隆声音；本接入不创建新的声音克隆。

## 安装与登录

当前验证版本为官方 `@elevenlabs/cli@1.8.0`，需要 Node.js 环境：

```powershell
npm install -g @elevenlabs/cli@1.8.0
elevenlabs auth login --scheme OAuth
elevenlabs auth status --json
```

也可以安装后直接在「设置 → 配音」选择 ElevenLabs、开启配音，再点击 OAuth 登录。在浏览器完成授权即可。ClipForge 复用当前系统用户的 OAuth 凭据，不需要填写 ElevenLabs 账号密码或 API Key。已经完成官方 CLI 授权时，刷新设置中的状态和声音列表即可。

服务端可发现全局安装和已有的 npm/npx 缓存，不会在网页请求期间自动下载程序。如果安装在其他位置，可在启动 ClipForge 前设置 `ELEVENLABS_CLI_PATH` 为官方 CLI 包目录或原生可执行文件的绝对路径，例如：

```powershell
$env:ELEVENLABS_CLI_PATH = 'C:\tools\node_modules\@elevenlabs\cli'
pnpm start
```

## 开启和使用

1. 打开「设置 → 配音」（`/settings?tab=tts`），选择「ElevenLabs · 克隆声音 / 官方 CLI」，开启配音。
2. 点击 OAuth 登录并在浏览器中授权；已登录的账号可直接读取声音和模型。
3. 选择默认声音及模型。设置自动保存；试听由手动点击触发，会消耗账号额度。
4. 打开项目的「视频」页面，确认配音服务、声音和模型后合成。普通合成和批量合成都使用该选择。

视频页默认使用设置中的配音服务和声音，也支持为当前项目单独选择两种服务和声音。当前浏览器保存项目的服务选择及 ElevenLabs 声音、模型 ID；重新打开时会核验它们是否仍在账号中。微软的默认声音保存在设置中，视频页临时调整的微软声音在重新打开页面时恢复默认值。视频页不提供 OAuth 登录入口，ElevenLabs 必须先在设置中选中并开启。

视频页选好 ElevenLabs 声音与模型后，可点击「试听音色」生成并播放短音频，使用与合成相同的声音、模型和设置语速；TIDEWE 项目使用英文试听文案。试听会消耗账号额度，仅手动点击时生成。切换声音、模型或服务会停止旧试听并取消待处理的试听响应。

如果授权失效，前往「设置 → 配音」重新连接，再刷新声音列表。CLI 未安装、未在设置中开启、登录未完成或声音和模型未选择时，ElevenLabs 配音合成不可提交。TIDEWE 的原声优先规则仍适用；高端 CG 模式沿用既有配音限制。

旧版 OpenAI 兼容、Atlas Cloud、MiniMax、fal.ai 配音设置会迁移为微软免费 TTS；Atlas 一键接入不再改写配音设置。

## 运行与计费行为

- 与 Kling CLI 一样，此功能用于本机网页版：通过 `localhost`、`127.0.0.1` 或 `::1` 访问。远程访问和 Electron 打包版暂不支持。
- 生成会消耗 ElevenLabs 账号额度，按选定模型和账号订阅计费。
- 相同文案、声音、模型和语速优先复用本地音频缓存；同一进程内相同的并发生成会合并。
- ElevenLabs 生成失败时会明确报错，不切换为微软声音，也不自动重试可能已经计费的请求。超时后应先查看 ElevenLabs 的生成记录，再决定是否重新提交。
- 文案通过标准输入传给原生 CLI，不放入命令行参数。程序使用独立临时工作目录，避免项目 `.env` 中的 API Key 覆盖 OAuth；ClipForge 不保存或返回 OAuth token。

官方资料：[CLI 仓库与使用说明](https://github.com/elevenlabs/cli)、[API 文档](https://elevenlabs.io/docs/api-reference/introduction)。
