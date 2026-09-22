# VideoAdGuard Jev

使用 TypeSafe Jev 对哔哩哔哩视频字幕进行结构化广告识别，并在可信度足够高时自动跳过植入广告。

> **衍生项目声明**：本项目基于 [ZeroTang05/VideoAdGuard](https://github.com/ZeroTang05/VideoAdGuard) 二次开发，上游基线为提交 [`1a3956c`](https://github.com/ZeroTang05/VideoAdGuard/commit/1a3956ce7ba695c794cac55ce825c0b19207382a)。原始代码的著作权归上游作者及贡献者所有。本项目不是上游官方版本，也与 TypeSafe AI 没有官方隶属关系。详细来源见 [NOTICE.md](NOTICE.md)。

## 主要变化

- 新增 `TypeSafe Jev` 提供商，默认调用 `https://api.typesafe.ai/v1/systemone` 和 `jev-latest`。
- 使用 Noul 概率完成广告、购买引导、普通内容和商品匹配的独立判断。
- 采用两阶段分析：重叠字幕窗口粗筛，再对候选区域逐字幕细化边界。
- 商品名通过 Choice 从置顶评论或链接标题中选择，不依赖自由文本生成。
- 字幕索引、时间映射、区间合并和安全阈值全部由本地代码确定。
- 只有高置信度且片段数量、总时长均通过检查时才自动跳过。
- Jev 缓存与其他模型缓存隔离，避免旧模型结果触发自动跳过。
- 保留上游的 OpenAI、Anthropic、自定义 Fetch、Groq 转录、白名单和云端缓存能力。

## 工作流程

```text
B站字幕 / Groq 转录
        │
        ▼
重叠窗口粗筛（Noul）
        │
        ▼
候选区域逐字幕细化（Noul）
        │
        ├── 商品候选选择（Choice）
        ▼
本地合并区间并映射为视频时间
        │
        ▼
置信度与结构安全检查 → 标记 / 自动跳过
```

## 安装 Chrome 版

### 使用 Release 成品

1. 从 [Releases](https://github.com/xianggelila177/VideoAdGuard-Jev/releases/latest) 下载 Chrome ZIP 并解压。
2. 打开 `chrome://extensions/`。
3. 开启“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择解压后的目录。

### 从源码构建

需要 Node.js 18 或更高版本。

```bash
npm ci
npm test -- --run
npm run build:chrome
```

Chrome 扩展输出到 `builds/chrome/`，随后可从 `chrome://extensions/` 加载该目录。

## 配置

1. 打开扩展弹窗，SDK 选择 `TypeSafe Jev`。
2. Base URL 保持 `https://api.typesafe.ai`。
3. 模型使用 `jev-latest`。
4. 在 [TypeSafe 控制台](https://console.typesafe.ai/) 创建 API Key，填入插件后会自动保存。
5. 打开或刷新带字幕的哔哩哔哩视频。

没有字幕的视频需要额外启用 Groq 语音识别并配置 Groq API Key。

## 安全与隐私

- 仓库和 Release 均不包含任何 API Key。
- API Key 使用 `chrome.storage.local` 保存在当前浏览器配置中。
- 视频字幕、标题和广告候选信息会发送到用户配置的模型服务商进行分析。
- 请勿提交 `.env`、密钥、浏览器用户目录或包含个人凭据的调试日志。
- 自动跳过由保守阈值控制，但模型判断仍可能出错；重要场景建议关闭自动跳过并手动确认标记。

## 开发与验证

```bash
npm test -- --run
npm run build:chrome
```

当前版本包含 TypeSafe 请求网关、端点规范化、窗口切分、字幕成员概率、区间合并和完整检测流程测试。

关键目录：

- `src/services/typesafe/`：Jev 请求类型、网关和两阶段广告检测器。
- `src/services/llm/`：原有模型提供商及统一配置。
- `src/content.ts`：B站字幕采集、缓存、安全检查和跳过逻辑。
- `src/background.ts`：Manifest V3 后台请求代理。
- `manifests/`：Chrome 与 Firefox 清单。

## 来源与许可

本项目沿用上游的 [GNU General Public License v2.0 or later](LICENSE)。分发修改版或二进制版本时，请同时遵守 GPL 的源码和许可义务，并保留上游归属信息。

- 上游项目：[ZeroTang05/VideoAdGuard](https://github.com/ZeroTang05/VideoAdGuard)
- 上游作者：[ZeroTang05](https://github.com/ZeroTang05)
- Jev 文档：[TypeSafe AI Documentation](https://docs.typesafe.ai/)

感谢 VideoAdGuard 的原作者和所有上游贡献者。
