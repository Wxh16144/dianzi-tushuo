# 电子图说 · 语音布置清单（dianzi-tushuo）

本机运行的小工具：**左边图片 + 右边文案 + 语音**，按页签分组，一键导出 `PDF + 图片 + 音频 + JSON` 的压缩包。

- 前端：纯 HTML / CSS / 原生 JS，无构建步骤
- 后端：Node + Express（本机 `127.0.0.1:3210`）
- PDF：调用本机 Chrome / Chromium 无头打印
- 音频：浏览器录音 → ffmpeg 转 mp3（没有 ffmpeg 时自动回退为原始 webm/m4a）

## 快速开始

```bash
npm install
npm start          # 只启动服务，不打开浏览器
npm run start:open # 启动并打开 http://127.0.0.1:3210/
```

默认不自动打开浏览器（避免每次重启都弹新标签）。需要时用 `npm run start:open`，
或 `node server/index.js --open` / `OPEN=1 npm start`。

### 工作区（数据放在哪）

默认以**启动时的当前目录**作为工作区，`data/` 与 `exports/` 都在工作区里生成。
想换一个目录，用下面任意一种方式（优先级从高到低）：

```bash
node server/index.js --workdir /path/to/workspace   # 1) 命令行参数（-w 也行）
WORK_DIR=/path/to/workspace npm start                # 2) 环境变量
cd /path/to/workspace && node /path/to/hunlibuzhi/server/index.js   # 3) 当前目录
```

这样数据就不再锁死在应用目录里，方便在不同目录间切换、备份或直接改文件。

## 配置（.env）

服务启动时会自动读取项目根目录的 `.env`（零依赖，不需要 dotenv 包）。
真实环境变量优先于 `.env`，所以临时覆盖可以这样：`LLM_MODEL=qwen3:8b npm start`。

```bash
cp .env.example .env   # 然后按需修改
```

**默认是本地 Ollama，不用改任何东西。** 想换成其他 OpenAI 兼容服务，只改两行：

```ini
# DeepSeek
LLM_PROVIDER=deepseek
LLM_API_KEY=sk-xxxxxxxxxxxx
```

```ini
# OpenAI
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-xxxxxxxxxxxx
```

```ini
# 任意 OpenAI 兼容服务（vLLM、One-API、Cloudflare AI Gateway…）
LLM_PROVIDER=custom
LLM_BASE_URL=https://your-endpoint/v1
LLM_MODEL=your-model
LLM_API_KEY=sk-xxxx
```

| `LLM_PROVIDER` | 默认 baseUrl | 默认 model |
| --- | --- | --- |
| `ollama`（默认） | `http://127.0.0.1:11434/v1` | `qwen3:4b` |
| `lmstudio` | `http://127.0.0.1:1234/v1` | `local-model` |
| `deepseek` | `https://api.deepseek.com/v1` | `deepseek-chat` |
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` |
| `custom` | 需自行填 `LLM_BASE_URL` | 需自行填 `LLM_MODEL` |

`LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` 始终可以覆盖预设值。
密钥只存在于服务端，`/api/health` 只返回 `hasApiKey: true/false`，不会下发明文。

> 语音转写（`/api/audio/transcribe`）走的是本机 `mlx-whisper`，与 LLM 服务商无关；
> DeepSeek 这类纯文本模型不提供 ASR 能力，不能替代转写。

首次运行会在**工作区**（默认是启动时的当前目录）生成：

```
data/state.json     清单数据（自动保存）
data/images/        粘贴的图片
data/audio/         录音
data/cache/         内容缓存（转写 / 描述 / 音频转码，按内容哈希寻址，可安全清空）
data/logs/app.log   运行日志（含转写 / LLM 分阶段耗时，超过 2MB 自动轮转）
exports/            导出的 zip、PDF 与视频（视频在 exports/videos/）
```

## 用法

| 操作 | 方式 |
| --- | --- |
| 选中一条 | 点击卡片（蓝色高亮 = 当前条目） |
| 改标题 | 序号旁的「标题」输入框，6 字内，用于视频进度条/过渡与文件名 |
| 贴图 | 截图后 `⌘V`，**可一次粘贴多张**（没有选中条目时会自动新建一条） |
| 删图 | 鼠标移到缩略图右上角的 `×`；或点「＋」继续粘贴 |
| 录音 | 选中卡片后**长按空格**说话，松开结束（也可点「录音」按钮） |
| 取消录音 | 录音中按 `Esc` |
| 新建条目 | `⌘↵`（Ctrl+Enter）或点「＋ 添加条目」 |
| 切换条目 | `↑` / `↓` |
| 排序 | 拖动卡片右上角 `⠿` |
| 删除 | 卡片上的「删除」/「删除录音」 |
| 页签 | 顶部「＋ 页签」，双击页签重命名，`×` 删除 |
| 看大图 | 点任意图片打开预览，同一组的图片可左右滑 / ← → 切换，Esc 关闭 |
| 删图片 | 鼠标移到图片右上角点 `×`；触屏设备上删除按钮常显 |
| 语音转文字 | 录音行的「转文字」→ 本地 mlx-whisper 转写 + 本地模型整理成描述，写入文案 |
| 导出 PDF | 右上角「导出 PDF」→ 只生成 PDF 并用浏览器下载，方便先看排版 |
| 导出 Zip | 右上角「导出 Zip」→ 打包成可回导备份（manifest.json + state.json + 图片 + 音频），同时写入 `exports/` |
| 导入备份 | 右上角「导入」或把备份 zip 拖到页面 → 整体替换当前清单 |
| 导出视频 | 右上角「导出视频」→ 把清单合成竖屏 mp4（图文 + 语音 + 文案字幕），可选「每个条目 / 每个章节 / 全部合并」，可「打开所在文件夹」挑文件发微信 |

录音最长 **3 分钟**。一条最多 **12 张图片**，一次粘贴最多 12 张（多出来的会被忽略）。删除条目/清空清单**不会删除**已保存的图片和音频文件（防止误删），需要清理时手动删 `data/images`、`data/audio`。

## 版式

每条是「左图右文」：图片占大部分宽度，文案在窄栏里（PDF 里约 114mm : 60mm）。

| 场景 | 图片尺寸 |
| --- | --- |
| 桌面编辑/浏览，单图 | 约 750 × 560 px（视窗口宽度） |
| 桌面编辑/浏览，多图 | 两列，每张约 370 × 280 px |
| 手机 | 横向滑动，每张约 78vw 宽 |
| PDF 单图 | 114 × 92 mm |
| PDF 多图 | 两列，每张约 56 × 44 mm |

PDF 里图片足够大，打印或屏幕查看都能直接看清，不必再点开放大。

## 导出的 zip（可回导备份）

```
manifest.json   备份版本清单（格式、schema 版本、计数、媒体清单）
state.json      完整清单数据（与 data/state.json 同构，含 version）
images/         被引用的图片（同一批粘贴的图片共享时间戳，-1/-2 后缀区分）
audio/          被引用的音频
```

导出的是「可整体回导的备份包」：在顶栏点「导入」或把 zip 拖到页面上，即可恢复到导出的那一刻（**导入会整体替换当前清单**）。缺失的媒体文件会提示但不会拒绝整包。

- `manifest.json` 里 `format` = `dianzi-tushuo-backup`（旧版 `hunlibuzhi-backup` 仍可导入）、`formatVersion` = 1（容器格式版本）、`schemaVersion` = 1（数据 schema 版本）。
- `state.json` 的 `version` 决定数据字段结构；升级应用后若加字段，靠版本迁移逐级升级，导入时若备份版本**高于**当前应用会拒绝并提示升级。

## 版本迁移

`server/schema.js` 里维护 `CURRENT_STATE_VERSION` 与 `migrations`（`目标版本 -> 升级函数`）。当前版本为 1（无迁移）。上线后加 v2 时，只需在 `migrations` 里追加一步，`migrateState()` 会自动把旧数据逐级升到当前版本，解析逻辑无需改动。

## 导出的视频

「导出视频」把清单合成**竖屏 1080×1920 的 mp4**（H.264 + AAC，微信可直接播放）。入口有两个：

- **每个条目**：条目卡片头部的「视频」按钮 → 只导出这一条，生成 `01-03-背景板.mp4`。
- **每个章节**：页签栏末尾的「⏺ 导出视频」卡片 → 每个页签各导出一个视频。

```
exports/videos/01-03-背景板.mp4      每个条目
exports/videos/01-主舞台.mp4          每个章节
```

规则：

- **多图条目是「相册」风格**：上方一张大图，底部一排缩略图（swiper），右上角显示 `2 / 5` 计数；大图**来回循环滑动**（正向到末尾再反向回来），每张图固定停留约 2 秒。
- 单图条目直接全屏展示。
- 有录音时视频总时长 = 录音时长（每张图仍固定停 2 秒，只是来回循环更多轮）；没有录音时来回循环两轮并补静音。
- **章节/合集视频**里：顶部有一条**斑马纹进度条**，每段对应一个条目、当前段高亮，段上显示条目标题或序号；条目之间会有**屏幕中央的标题过渡**（约 0.9 秒），大字显示条目标题或「第 N 项」+ 章节名。
- 条目可填**可选标题（6 字内）**，用于视频进度条、章节过渡与导出文件名；不填则回退到序号。
- 文案默认烧成大图区底部的字幕条（用本机中文字体，找不到字体时字幕留空，不影响生成）。
- 完整导出会**清空 `exports/videos/` 再重新生成**，单条导出只覆盖同名文件；文件名稳定，不会堆积重复文件。
- 生成后**不自动下载**，点 toast 里的「打开所在文件夹」在 Finder 里定位，挑 mp4 拖进微信即可。

### item 级缓存（加速导出）

每个**条目**渲染成一个小视频片段后，会缓存到 `data/cache/videos/`，后续导出直接复用：

- **章节视频** = 拼接各条目的缓存片段 + 标题过渡片段；
- **全部视频** = 拼接所有条目的缓存片段；
- **单条导出** = 直接复用该条目的缓存片段。

缓存 key 由「图片文件（路径 + 大小 + 修改时间）+ 文案 + 标题 + 音频文件 + 视频配置 + 进度条内容」共同决定：**只要内容没变，就命中缓存**；改了图/文案/标题/音频或换了视频参数，会自动重新生成对应片段。

> 实测：同一清单连续导出章节视频，首次约 45 秒，第二次命中缓存后约 70 毫秒。
> 缓存文件是可再生的，想清理直接删 `data/cache/videos/` 即可（不影响清单数据）。

> 生成视频只依赖 `ffmpeg`（音频转码、拼接），不依赖 Chrome。
> 参数（方向 / 每图秒数 / 滑动过渡时长 / 是否烧字幕 / 字体）都可用 `VIDEO_*` 环境变量覆盖，见下文「环境变量」。

## 只读视图（手机）

```
http://<本机IP或域名>/ ?readonly=1
```

只读视图隐藏所有编辑控件：不能新增/删除/粘贴/录音，可以播放录音、点击图片放大。适合发给别人「看」。

手机上图片排版会自动变成「横向滑动的大图」：一条多图时左右滑动浏览，点开是整组预览，
可继续左右滑动切换，并带 `2 / 5` 计数。

> 注意：手机通过局域网 IP 访问时，浏览器要求 **HTTPS** 才能使用麦克风；只读视图不需要录音权限，因此 HTTP 也能正常浏览。

## 语音转文字（可选）

「转文字」按钮会用两段本地能力：**ASR 转写** → **本地 LLM 整理成描述**。

```bash
# 1) 安装 mlx-whisper（Apple Silicon，用 pipx 隔离环境）
#    注意：包名是 mlx-whisper，不是 huggingface-cli（后者不存在这个包）
pipx install mlx-whisper --python python3.13

# 2) 确保 Ollama 在跑，并准备好模型
ollama serve
ollama pull qwen3:4b

# 3) 重启本服务，启动日志里 whisper 应为 ✓
npm start
```

点录音行的「转文字」，服务端会：

1. `mlx_whisper` 把 `data/audio/xxx.mp3` 转成中文文本（首次会下载模型）；
2. 把文本发给本地 LLM，整理成 1-3 句「布置描述」；
3. 结果追加到该条文案末尾。

LLM 不可用时仍然会写入原始转写文字。转写只在本机进行，不上传任何音频。

> **结果会缓存**：转写结果按「音频内容哈希 + whisper 模型/语言」缓存，描述按
> 「LLM 配置 + 提示词 + 转写文本」缓存。同一段录音再次「转文字」会直接命中缓存，
> 不再重复跑 whisper / LLM。音频转 mp3 的 ffmpeg 转码同样按内容哈希缓存。
> 缓存位于 `data/cache/`，可安全清空：`npm run clean -- --cache --yes`。

### 先把模型下好（重要）

**转写前必须先下载模型**，否则会直接报 503。

为什么不能「转写时自动下载」：`mlx_whisper` 会在转写过程中下载模型，
而转写有超时（默认 15 分钟）。`large-v3-turbo` 约 1.5GB，慢网络下要一两小时，
必然被超时杀掉，只留下 `.incomplete` 残片，下次重来 —— 永远下不完。

> **中国大陆网络友好下载**：HuggingFace 直连很慢（约 170 KB/s），推荐用国内镜像
> ModelScope 下载到本地目录（约 15 MB/s，快 80 倍），并支持 `WHISPER_MODEL` 直接指向本地目录、
> ollama 在 Clash 假 IP 下的 `redirect target not allowed` 冲突等坑的完整说明，
> 见 **[docs/模型下载指南.md](docs/模型下载指南.md)**。

所以用独立脚本下载（**不受转写超时限制，支持断点续传**）：

```bash
npm run stt:download            # 下载 .env 里配置的模型
npm run stt:download -- --check  # 只看状态，不下载
```

下载中 `Ctrl+C` 不会损坏缓存，下次接着下。慢网络建议挂后台：

```bash
nohup npm run stt:download > stt-download.log 2>&1 &
tail -f stt-download.log
```

**按实际网速选模型**（实测到 HuggingFace 约 170 KB/s 时的耗时）：

| 模型 | 体积 | 下载耗时 | 中文识别 |
| --- | --- | --- | --- |
| `whisper-tiny` | 71 MB | ~7 分钟 | 差（不推荐正式用） |
| `whisper-base-mlx` | 137 MB | ~14 分钟 | 一般 |
| `whisper-small-mlx` | 459 MB | ~46 分钟 | 较好（推荐折中） |
| `whisper-large-v3-turbo` | 1539 MB | ~155 分钟 | 最好（默认） |

```ini
# .env：网络慢就换成小模型
WHISPER_MODEL=mlx-community/whisper-small-mlx
```

### 转写失败怎么办

`mlx_whisper` 的 CLI 有个坑：**出错时也会返回退出码 0**，只把错误打印到输出里。
所以「退出码正常」不代表成功，服务端现在会检查输出文件，并把真实原因带回来。

常见原因与处理：

| 错误提示 | 原因 | 处理 |
| --- | --- | --- |
| 模型下载失败（502） | 模型没下载完 / 网络不通 | 清掉残缺分片后重试，或换小模型 |
| 连接超时（504） | 访问 HuggingFace 超时 | 检查代理，或设 `HF_ENDPOINT` 镜像 |
| 内存不足（507） | 模型太大 | 换 `whisper-small-mlx` / `whisper-tiny` |
| 未安装 mlx-whisper（503） | 没装 CLI | `pipx install mlx-whisper` |
| 模型尚未下载完成（503） | 模型没下完 | `npm run stt:download` |

**下载中断会留下 `.incomplete` 残片**（可能好几个 GB），而且会让模型永远用不了。
查看并清理：

```bash
curl -s localhost:3210/api/audio/status | grep -o '"incompleteCount":[0-9]*'
npm run clean -- --model-cache          # 演练：看看有多少残片、占多少空间
npm run clean -- --model-cache --yes    # 真正删掉残片，下次转写会重新下载
```

想彻底避开下载问题，可以先手动把模型拉下来（可断点续传）：

```bash
# huggingface_hub 自带的命令是 hf（旧版叫 huggingface-cli），
# 已随 mlx-whisper 一起装在 pipx 环境里：
npm run stt:download
```

### 为什么转写很慢？看日志

每次转写都会记录**分阶段耗时**，前端提示也会直接显示：

```
转写完成：转写 2.6s，3.1x 实时 + 描述 0.9s = 3.4s，已写入文案
```

服务端日志（终端 + `data/logs/app.log`）：

```
[stt] phase=start file=01-99-xxx.mp3 size=99KB model=mlx-community/whisper-large-v3-turbo lang=zh cached=no
[stt] phase=done  file=01-99-xxx.mp3 ms=208644 chars=36 downloaded=yes stderr="100%|...|2582frames/s"
[llm] phase=done provider=ollama model=qwen3:4b ms=796 in=127 out=23
[stt] phase=pipeline file=audio/01-99-xxx.mp3 transcribeMs=208644 describeMs=796 totalMs=209440
```

字段含义：

| 字段 | 含义 |
| --- | --- |
| `cached=no` / `downloaded=yes` | **首次使用该模型，正在下载**（最慢的原因） |
| `transcribeMs` | mlx-whisper 转写耗时（含模型下载/加载） |
| `describeMs` | 本地/云端 LLM 整理描述耗时 |
| `frames/s` | whisper 推理速度，几十帧/秒属正常 |

常用查看方式：

```bash
npm run logs                      # 实时跟踪 data/logs/app.log
curl "localhost:3210/api/logs?lines=50&format=text"
```

或者浏览器直接打开 <http://127.0.0.1:3210/api/logs?lines=50&format=text>。

**实测数据（M1 Pro，8 秒音频）**

| 情况 | 转写 | 描述 | 合计 |
| --- | --- | --- | --- |
| 首次（含模型下载，tiny） | 208.6s | 5.3s | 214s |
| 模型已缓存 | 2.5s | 0.8s | 3.3s |

所以「很慢」几乎总是首次下载模型。默认模型 `whisper-large-v3-turbo` 约 1.6GB，
下载完就快。想更快可以换小模型：

```ini
# .env：中等精度与速度的折中
WHISPER_MODEL=mlx-community/whisper-small-mlx
# 或极小，最快但中文识别会差一些
WHISPER_MODEL=mlx-community/whisper-tiny
```

换了模型第一次仍会下载一次，之后就走缓存。

## 环境变量

都建议写在 `.env` 里（见上文），也可以用传统环境变量。

| 变量 | 说明 |
| --- | --- |
| `PORT` | 端口，默认 `3210` |
| `HOST` | 监听地址，默认 `127.0.0.1`；给局域网用可设 `0.0.0.0` |
| `OPEN` | 设为 `1` 时启动后自动打开浏览器（等价于 `--open`） |
| `WORK_DIR` | 工作区目录，默认启动时的当前目录；`WORKDIR` 也认。命令行 `--workdir` 优先级更高 |
| `DATA_DIR` | 数据目录（相对 `WORK_DIR`，也可绝对路径），默认 `data` |
| `EXPORTS_DIR` | 导出目录（相对 `WORK_DIR`，也可绝对路径），默认 `exports` |
| `CHROME_PATH` | 手动指定 Chrome/Chromium 可执行文件 |
| `FFMPEG_PATH` | 手动指定 ffmpeg |
| `FFPROBE_PATH` | 手动指定 ffprobe |
| `WHISPER_BIN` | 手动指定 `mlx_whisper` 可执行文件 |
| `WHISPER_MODEL` | 转写模型，默认 `mlx-community/whisper-large-v3-turbo`；也支持本地目录路径（见 [模型下载指南](docs/模型下载指南.md)） |
| `WHISPER_LANGUAGE` | 转写语言，默认 `zh` |
| `WHISPER_TIMEOUT_MS` | 单次转写超时，默认 `900000`（15 分钟，首次含模型下载） |
| `HF_ENDPOINT` | HuggingFace 镜像地址，如 `https://hf-mirror.com` |
| `VIDEO_WIDTH` | 视频宽，默认 `1080` |
| `VIDEO_HEIGHT` | 视频高，默认 `1920`（竖屏） |
| `VIDEO_FPS` | 视频帧率，默认 `25` |
| `VIDEO_SECONDS_PER_IMAGE` | 无语音条目每张图显示秒数，默认 `2` |
| `VIDEO_TRANS_SECONDS` | 多图条目每张图之间的横向滑动过渡秒数，默认 `0.5` |
| `VIDEO_BURN_TEXT` | 是否把文案烧成字幕，默认 `1`（开启） |
| `VIDEO_FONT_FAMILY` | 字幕字体族，留空用内置中文字体默认值 |
| `LLM_PROVIDER` | `ollama`（默认）/`lmstudio`/`deepseek`/`openai`/`custom` |
| `LLM_BASE_URL` | 覆盖预设地址，如 `https://api.deepseek.com/v1` |
| `LLM_MODEL` | 覆盖预设模型，如 `deepseek-chat` |
| `LLM_API_KEY` | 云端服务密钥；也可用 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` |
| `LLM_REASONING_EFFORT` | 默认 Ollama 用 `none`；云端默认不发送该字段 |
| `LLM_TIMEOUT_MS` | LLM 请求超时，默认 `90000` |

启动日志会打印环境自检结果（ffmpeg / ffprobe / chrome）。缺 Chrome 时导出 PDF 会报错（导出 Zip 备份不受影响），缺 ffmpeg 时录音保存为原始格式、导出视频不可用。

## 部署到服务器（后续）

```bash
# 打包上传，服务器上
npm install --omit=dev
HOST=127.0.0.1 PORT=3210 node server/index.js
```

前面挂 nginx 做 HTTPS 与 Basic Auth 即可；因为写接口没有鉴权，**不要把 3210 端口直接暴露到公网**。

## 清理 data 目录（危险操作）

删除条目时**故意不删**媒体文件（防止误删），所以 `data/` 会慢慢积累"孤儿"文件
——已经没有任何条目引用的图片和音频。

清理是**命令行操作**，页面上没有入口，避免误点：

```bash
npm run clean          # 演练：只列出会删什么，不动文件
npm run clean:run      # 真正删除孤儿文件（被清单引用的会保留）
```

演练输出示例：

```
  模式： 孤儿文件
  图片  26 个  音频  8 个
  将删除 32 个文件，保留 2 个
  预计释放 967.1 KB
```

**安全设计：**

1. **默认是演练**，不加 `--yes` 绝不删文件
2. 执行前把**整个 data 目录**完整备份到系统临时目录，并打印恢复命令
3. `state.json` 解析失败时直接中止，避免把好文件当孤儿删掉
4. 只删 `data/images`、`data/audio` 下的文件，不动 `state.json`

更多参数：

```bash
npm run clean -- --logs              # 顺便清空 data/logs
npm run clean -- --exports           # 顺便清空历史导出
npm run clean -- --model-cache       # 清掉 whisper 下载中断的残片（不动完整模型）
npm run clean -- --backup-dir ~/bk   # 指定备份位置
npm run clean -- --no-backup         # 跳过备份（更危险）

# 删除全部媒体（清单里的图片/音频会失效，页面变 404）
npm run clean:all                    # 交互式：需要手打 DELETE ALL 确认
npm run clean -- --all --yes --force # 非交互环境（脚本/CI）必须加 --force
```

恢复（先停服务）：

```bash
cp -R "/path/to/backup/data-20261101-043548/." "data"
```

备份默认位置：`$TMPDIR/dianzi-tushuo-backups/data-<时间戳>/`。
系统清理临时目录后备份会消失，重要数据请自己再存一份。

> 建议先停掉服务再执行清理，避免服务端同时读写 `state.json`。

## 测试

```bash
npm test           # 全部（90 个用例）
npm run test:unit  # 纯函数：配置解析 / zod 校验 / 图片处理 / 导出清单
npm run test:api   # HTTP 接口（supertest，不监听真实端口）
npm run test:e2e   # 真实 PDF / Zip（需要本机 Chrome，缺失时自动跳过）
npm run test:watch # 改代码时持续跑
```

测试全部跑在临时目录里（`DATA_DIR` / `EXPORTS_DIR` 指向 `os.tmpdir()`），
不会污染仓库的 `data/`，也不会写日志。

| 文件 | 覆盖内容 |
| --- | --- |
| `test/config.test.js` | 5 种 LLM 预设、覆盖优先级、旧变量兼容、密钥不外泄 |
| `test/schema.test.js` | 宽松读取（坏条目丢弃、去重、上限、旧单图迁移）、严格写入（非法路径 400）、seq 补全 |
| `test/media.test.js` | 文件命名、音频扩展名推断、jpg/png 选择、长边 2000 限制、无 ffmpeg 回退 |
| `test/export.test.js` | 媒体收集去重、清单序号跨页签连续、manifest 字段 |
| `test/api.test.js` | 状态读写校验、上传（单/多图）、转写前置校验、导出 503、404 与并发写入完整性 |
| `test/export-e2e.test.js` | 真实生成 PDF（校验 `%PDF-` 魔数）与 Zip（校验内部文件） |
| `test/ui.test.js` | 真实浏览器：渲染、选中、页签切换、灯箱翻页、只读视图、打印模式 |
| `test/stt.test.js` | 失败原因提取、错误翻译（502/504/507）、模型缓存不被 `.incomplete` 残片骗 |
| `test/cleanup.test.js` | 孤儿识别、all/orphans 模式、演练不删文件、备份内容、损坏 state 时中止、`--all` 需 `--force` |

没有 Chrome 的机器（如 CI）会自动跳过 11 个依赖浏览器的用例：

```bash
HUBZ_TEST_NO_CHROME=1 npm test   # 本地验证跳过逻辑
```

`.github/workflows/ci.yml` 在 Node 22 / 24 上跑 `test:unit` + `test:api`。

## 技术栈

服务端全部用成熟的库，不自己造轮子：

| 用途 | 依赖 | 说明 |
| --- | --- | --- |
| HTTP 框架 | `express` 5 | Express 5 会自动把 async 异常交给错误中间件，路由里不用写 try/catch |
| 配置 | `dotenv` + `zod` | `.env` 解析交给 dotenv，类型与范围校验交给 zod |
| 找可执行文件 | `which` | Chrome / ffmpeg / whisper 的 PATH 查找 |
| 日志 | `pino` + `pino-pretty` + `pino-roll` + `pino-http` | 结构化日志、终端彩色输出、按天轮转、请求日志 |
| 日志读取 | `read-last-lines` | `/api/logs` 只读尾部，不把大文件读进内存 |
| 数据持久化 | `lowdb` + `steno` | JSON 文件数据库，写入是原子的且自动串行 |
| 数据校验 | `zod` | 清单 schema 与 LLM 响应结构 |
| ID / 时间 | `nanoid` / `dayjs` | 短 ID、时间戳格式化 |
| 子进程 | `execa` | 调用 ffmpeg / ffprobe / mlx-whisper，自带超时与错误信息 |
| 上传 | `multer` | 内存暂存 + 大小/数量限制 |
| 图片 | `sharp` | 缩放、透明通道判断、JPEG/PNG 编码，以及视频字幕的 SVG 渲染 |
| MIME | `mime-types` | 录音扩展名推断 |
| Zip | `archiver` | 流式打包备份 |
| 解压 | `adm-zip` | 导入备份时解析 zip |
| PDF | `puppeteer-core` | 驱动本机 Chrome 打印 A4 |
| 视频 | `sharp` + `execa`(ffmpeg) | 图片预渲染成帧 + ffmpeg 拼接 H.264/AAC mp4 |
| HTTP 错误 | `http-errors` | 统一 `createError(400, ...)`，错误中间件按 status 输出 |
| 压缩 / 打开浏览器 | `compression` / `open` | gzip 静态资源；`npm run start:open` 打开页面 |

## 目录结构

```
server/index.js        启动入口（读配置 → 初始化数据 → 监听 → 优雅退出）
server/config.js       .env + zod 校验 + 路径 + 可执行文件探测 + LLM 预设
server/logger.js       pino 日志（终端 + data/logs 轮转文件）
server/schema.js       zod 数据模型（读取宽松、写入严格）+ 版本迁移
server/db.js           lowdb 持久化 + 目录初始化 + 媒体路径解析
server/media.js        sharp 图片处理、ffmpeg 转码（execa）
server/pdf.js          puppeteer-core 打印 A4
server/export.js       archiver 打包可回导备份
server/import.js       adm-zip 解包校验 + 版本迁移 + 安全落盘 + 整体替换
server/video.js        sharp 帧渲染 + ffmpeg 拼接视频
server/stt.js          mlx-whisper 转写 + OpenAI 兼容 LLM 整理
server/app.js          express 5 应用装配、静态服务、错误中间件
server/routes/*.js     按领域拆分的路由（health/state/media/audio/export/import）
public/                前端页面（原生 JS，无构建）
test/                  测试（node:test + supertest + puppeteer-core）
scripts/clean.js       危险操作：备份 + 清理孤儿媒体（命令行）
```

## 环境要求

- Node **>= 22.9**（`.nvmrc` 里是 22.14.0）
- Chrome / Chromium（导出 PDF；`CHROME_PATH` 可指定）
- ffmpeg（录音转 mp3，可选）
- mlx-whisper（语音转文字，可选，仅 Apple Silicon）

全部可执行文件都会自动探测，找不到时服务仍能启动，只是对应功能会给出提示。

## 数据一致性

- **读取宽松、写入严格**：启动时读到脏数据只丢弃坏条目并继续运行；`PUT /api/state`
  遇到非法媒体路径（例如 `../../etc/passwd`）直接返回 400，不会静默丢弃后覆盖好数据。
- 写入由 `lowdb`（steno）保证原子性与串行，不会出现半截 JSON。
- `state.json` 解析失败时自动备份为 `state.json.broken-<时间>` 并重建空清单。

## 已知限制

- 单工作区（一个清单），不保存历史版本；清空后旧媒体文件仍在 `data/` 里
- 条目字段有「序号 + 标题（6 字内）+ 文案」，没有预算等其他业务字段
- 语音转文字需要自行安装 `mlx-whisper`，未安装时点「转文字」会提示安装命令
- 修改代码后需要手动刷新页面（服务端不自动热更新前端）
- 需要 Node **>= 22.9**（`execa` / `nanoid` / `which` 的版本要求）
- 前端仍是原生 JS（无打包），所以没有引入前端框架依赖
