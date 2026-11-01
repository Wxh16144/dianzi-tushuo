# 电子图说 · 语音布置清单

> 图片 + 文案 + 语音，一键合成一份能「讲清楚」的视频说明书。

本机运行的小工具。左边放图、右边写文案、录一段语音，然后导出 PDF、备份包，或者直接合成一条竖屏视频发到微信里。

适合这些场景：远程教长辈用新买的东西、给同事朋友说明一件事、把零散的截图整理成带讲解的清单。

## Demo

下面这条视频就是用它自己生成的（截图 + 配音 + 文案字幕，自动合成）：

https://github.com/user-attachments/assets/73f105b5-2f9f-4a01-99ae-3bb90bf36fae

## 快速开始

```bash
npm install
npm start          # 启动服务，浏览器打开 http://127.0.0.1:3210/
npm run start:open # 或启动并自动打开浏览器
```

默认使用本机 Ollama（无需配置）；想要语音转文字，额外装一个 `mlx-whisper` 即可（见下方文档）。

## 环境准备

| 组件 | 是否必须 | 用途 | 安装 |
| --- | --- | --- | --- |
| Node.js ≥ 22.9 | **必须** | 运行服务 | [nodejs.org](https://nodejs.org/) |
| ffmpeg（含 ffprobe） | **必须** | 视频合成、录音转码 | `brew install ffmpeg` · [其它平台](https://ffmpeg.org/download.html) |
| Chrome / Chromium | 导出 PDF 时 | 渲染 A4 PDF | [google.com/chrome](https://www.google.com/chrome/) |
| Ollama | 可选 | 默认本地 LLM | [ollama.com](https://ollama.com/) |
| mlx-whisper | 可选 | 语音转文字（Apple Silicon） | `pipx install mlx-whisper --python python3.13` |
| `say` | 无需安装 | TTS 配音（macOS 内置） | — |

缺少的可执行文件不影响启动，只会让对应功能给出提示。装在非标准路径时可用
`FFMPEG_PATH` / `CHROME_PATH` / `WHISPER_BIN` 指定，详见 [配置](docs/配置.md)。

## 基本用法

| 想做什么 | 怎么做 |
| --- | --- |
| 建一条说明 | 点「＋ 添加条目」，左边 `⌘V` 粘贴截图，右边写文案 |
| 录一段讲解 | 选中条目后**长按空格**说话，松开结束 |
| 语音转文字 | 录音行的「转文字」→ 本地转写 + 整理，自动写进文案 |
| 整理成清单 | 顶部「＋ 页签」分组，条目可拖拽排序 |
| 导出 PDF | 右上角「导出 PDF」，直接下载排版好的 PDF |
| 导出备份 | 右上角「导出 Zip」，生成可回导的备份包 |
| 合成视频 | 右上角「导出视频」→ 图文 + 语音 + 字幕的竖屏 mp4 |

- 录音最长 **3 分钟**，一条最多 **12 张图片**（一次粘贴多张）。
- 删除条目不会误删图片和音频文件，需要时再手动清理。

## 语音转文字（可选）

点「转文字」后，本地 `mlx-whisper` 先把录音转成文字，再交给本地 LLM 整理成一段描述，追加到文案末尾。全程在本机完成，音频不上传。

首次使用前需要：

```bash
pipx install mlx-whisper --python python3.13   # 安装转写工具
npm run stt:download                            # 预下载模型
```

安装与模型下载的完整说明见 [docs/语音转文字.md](docs/语音转文字.md)。

## 技术文档

| 文档 | 内容 |
| --- | --- |
| [配置](docs/配置.md) | 工作区、`.env`、LLM 服务商、全部环境变量 |
| [语音转文字](docs/语音转文字.md) | mlx-whisper 安装、模型下载、常见问题 |
| [视频导出](docs/视频导出.md) | 视频规则与缓存 |
| [模型下载指南](docs/模型下载指南.md) | 国内镜像加速等完整说明 |
| [开发](docs/开发.md) | 测试、技术栈、目录结构、部署、已知限制 |

## License

[MIT](LICENSE)
