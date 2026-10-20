# 90 天 Agent 开发课 · 手机学习 App

给 Jiawei 的 90 天 Agent 开发课程的在线学习站：纯静态网站，手机打开即可学习，课程里的 Python 代码可以直接在浏览器里编辑和运行（Pyodide / WebAssembly）。

## 功能

- 课程目录：按阶段（1–6）切换，显示每天日期、"今天"标记、完成状态，首页有总进度和"继续学习"按钮
- 课程页：讲解（Java 对照）、表格、练习清单（可勾选）、思考题，"标记本课为已完成"
- 在线代码：每个 ```` ```python run ```` 代码块都是 CodeMirror 6 编辑器，带 运行 / 停止 / 重置 / 复制；修改自动保存在本机
- 浏览器 Python 环境（Pyodide 314.0.7 = Python 3.14，全部自托管在 `pyodide/`，不依赖外部 CDN）：
  pydantic、httpx（同步 + 异步）、openai、tiktoken（cl100k_base 编码文件已自托管）、python-dotenv、requests 等
- ⚙️ 设置：填 `LLM_API_KEY / LLM_BASE_URL / LLM_MODEL / PRICE_*`，运行时会作为环境变量和虚拟 `.env` 注入，课程代码不用改就能调 DeepSeek / 通义（两家都允许浏览器跨域调用）；Key 只存在本机 localStorage
- 🧪 代码练习场：一个自由编辑器
- 进度导出 / 导入（换手机时用）

## 目录结构

```
index.html              单页应用入口（hash 路由：#/、#/day/N、#/settings、#/playground）
assets/app.js           页面逻辑（无构建步骤，直接改）
assets/py-worker.js     Pyodide 运行器（module Web Worker，可随时终止）
assets/vendor.js        CodeMirror 6 + marked 的打包文件（esbuild 生成）
assets/style.css
lessons/index.json      课程目录（阶段 + 每课元数据）
lessons/dayNN.md        每一课的正文（Markdown）
pyodide/                自托管的 Pyodide 核心 + 课程用到的 wheel
scripts/add_lesson.py   新增 / 更新一课的脚本
```

## 新增一课（每日任务照这个做）

1. 写好 `lessons/dayNN.md`（NN 两位数，比如 `day06.md`）。**不要**在正文里写一级标题，页面会自动显示"第 N 天 · 日期 · 阶段"和标题。
2. 登记到目录：

   ```bash
   python3 scripts/add_lesson.py 6 "流式输出与多轮对话" lessons/day06.md --summary "stream=True 逐字输出 + 多轮记忆"
   ```

   已存在的"待更新"条目会被替换为 `ready`；跨天的课用 `--day-end 14`。
3. 提交并推送，GitHub Pages 约 1 分钟后生效：

   ```bash
   git add -A && git commit -m "第 6 天：流式输出与多轮对话" && git push
   ```

页面用 `cache: no-cache` 拉取 `index.json` 和课程 Markdown，推送后刷新即可看到新课。

### Markdown 约定

| 写法 | 效果 |
|---|---|
| ```` ```python run ```` | 可编辑、可在浏览器运行的代码块 |
| ```` ```python ```` / ```` ```bash ```` / ```` ```text ```` | 只读代码块（带复制按钮），用于本地命令、预期输出等 |
| `- [ ] 练习内容` | 可勾选的练习清单（进度存 localStorage） |
| `> 🎯 ...` | 提示框（开头放今日目标、注意事项） |
| 表格 | 自动横向滚动，适合 Java 对照表 |

推荐结构：`> 🎯 今日目标` → 原理（Java 对照） → 可运行示例 → 本地运行说明 → `## 今日练习`（`- [ ]` 清单 + 起步模板） → `## 🤔 思考题`。

### 浏览器运行的注意事项（写课时参考）

- 用户代码在全新的 `__main__` 模块里运行，并写成工作目录下的 `main.py`（`/home/pyodide/agent-lab`），所以 `if __name__ == "__main__":`、`load_dotenv()`、pydantic 前向引用都正常。
- `asyncio.run(main())` 可以直接用（运行器会接管事件循环）。
- `sys.argv` 固定为 `["main.py"]`，需要命令行参数的脚本会走默认值。
- 同步 httpx / openai 在 Worker 里走同步 XHR：能用，但 `stream=True` 的同步流式输出会等全部返回后一次性打印；要演示逐字输出建议用 `AsyncOpenAI` + `async for`（走 fetch 流式读取；写第 6 天前请用真实 Key 验证一次）。
- `input()` 不可用；读写文件只在浏览器内存里的虚拟文件系统；`subprocess`、多进程、本地数据库等需要本地 `uv run`。
- 只能加载 `pyodide/` 里已有的包。要新增包：从 `https://cdn.jsdelivr.net/pyodide/v314.0.7/full/` 下载对应 wheel（文件名见 `pyodide/pyodide-lock.json`，记得带上依赖）放进 `pyodide/`；纯 Python 包也可以放 wheel 后在 `py-worker.js` 里用 micropip 安装（参考 python-dotenv 的处理）。
- 访问外部 API 需要对方允许 CORS：GitHub API、jsonplaceholder、httpbin、DeepSeek、通义 DashScope 都可以。

## 本地预览

```bash
python3 -m http.server 8765   # 然后打开 http://localhost:8765/
```

## 重新生成 vendor.js（一般不需要）

```bash
npm i codemirror @codemirror/lang-python @codemirror/theme-one-dark marked esbuild
# 入口文件见 scripts/vendor-entry.js
npx esbuild scripts/vendor-entry.js --bundle --minify --format=iife --outfile=assets/vendor.js
```
