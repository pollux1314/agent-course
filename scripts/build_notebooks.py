#!/usr/bin/env python3
"""把 lessons/dayNN.md 转成 JupyterLite 用的 Notebook：jupyterlite/content/dayNN.ipynb

- 讲解（含表格、只读代码块、练习清单）→ Markdown 格
- ```python run 代码块 → 代码格
- 开头自动加一格「运行环境准备」：按需 %pip install、浏览器兼容补丁；调大模型的课再加一格填 Key
- 只用标准库，不需要安装任何东西：python3 scripts/build_notebooks.py
"""
import ast, json, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent.parent
LESSONS = ROOT / "lessons"
OUT = ROOT / "jupyterlite" / "content"

# import 名 → %pip install 的包名（都在 Pyodide 自带包或 lite/wheels 里）
PKGS = {"pydantic": "pydantic", "httpx": "httpx", "openai": "openai", "tiktoken": "tiktoken",
        "dotenv": "python-dotenv", "requests": "requests"}
FENCE = re.compile(r"^(\s*)(`{3,}|~{3,})(.*)$")
ASYNC_RUN = re.compile(r"^(\s*)asyncio\.run\((.*?)\)\s*(#.*)?$")


def split_blocks(md: str):
    """按 ```python run 切分，返回 [("md", text) | ("code", text), ...]；其他代码块原样留在 Markdown 里"""
    out, buf, code = [], [], None
    fence = None  # 当前打开的围栏（``` 或 ~~~），用来找配对的结束行
    for line in md.splitlines():
        m = FENCE.match(line)
        closing = m and fence and m.group(2)[0] == fence[0] and len(m.group(2)) >= len(fence) and not m.group(3).strip()
        if code is not None:
            if closing:
                out.append(("code", "\n".join(code))); code = fence = None
            else:
                code.append(line)
            continue
        if fence is None and m:
            info = m.group(3).strip().split()
            fence = m.group(2)
            if info[:1] == ["python"] and "run" in info:
                out.append(("md", "\n".join(buf))); buf = []; code = []
                continue
        elif closing:
            fence = None
        buf.append(line)
    out.append(("md", "\n".join(buf)))
    return [(k, t.strip("\n")) for k, t in out if t.strip()]


def _compiles(src: str) -> bool:
    try:
        compile(src, "cell", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT, dont_inherit=True)
        return True
    except SyntaxError:
        return False


def adapt_code(src: str) -> str:
    """Notebook 里事件循环已经在跑：asyncio.run(x) 改成 await x（改了编译不过就保留原样）"""
    lines = src.split("\n")
    for i, line in enumerate(lines):
        m = ASYNC_RUN.match(line)
        if not m:
            continue
        new = lines[:i] + [f"{m.group(1)}await {m.group(2)}  # 本地脚本写 asyncio.run(...)，Notebook 里直接 await"] + lines[i + 1:]
        if _compiles("\n".join(new)):
            lines = new
    return "\n".join(lines)


def setup_cell(codes: list[str]) -> str:
    text = "\n".join(codes)
    pkgs = sorted({p for mod, p in PKGS.items() if re.search(rf"^\s*(from|import)\s+{mod}\b", text, re.M)})
    lines = ["# ⚙️ 运行环境准备：打开 Notebook 后先运行这一格（Shift+Enter）"]
    if pkgs:
        lines.append(f"%pip install -q {' '.join(pkgs)}")
    lines += [
        "import sys",
        'sys.argv = ["main.py"]  # 课程脚本里读命令行参数的地方走默认值',
    ]
    if "httpx" in pkgs or "openai" in pkgs or "requests" in pkgs:
        lines += [
            "try:  # 同步 httpx / openai 在浏览器里走同步 XHR（和课程网页的运行器一致）",
            "    import httpx._transports.jsfetch as _jf",
            "    _jf.can_run_sync = lambda: False",
            "except Exception:",
            "    pass",
        ]
    if "tiktoken" in pkgs:
        lines += [
            "import os, js",
            "from pyodide.http import pyfetch",
            "os.environ['TIKTOKEN_CACHE_DIR'] = '/tmp/tiktoken'; os.makedirs('/tmp/tiktoken', exist_ok=True)",
            "if not os.path.exists('/tmp/tiktoken/9b5ad71b2ce5302211f9c61530b329a4922fc6a4'):",
            "    # cl100k_base 编码文件改从本站下载（免跨域、国内可访问）",
            "    _r = await pyfetch(str(js.location.href).split('/lite/')[0] + '/pyodide/cl100k_base.tiktoken')",
            "    with open('/tmp/tiktoken/9b5ad71b2ce5302211f9c61530b329a4922fc6a4', 'wb') as f:",
            "        f.write(await _r.bytes())",
        ]
    lines.append('print("✓ 环境就绪，可以往下运行了")')
    return "\n".join(lines)


KEY_CELL = """# 🔑 这一课要调用大模型：把 Key 填在引号里再运行这一格（只存在这次打开的浏览器内存里，别分享这个 Notebook）
import os
LLM_API_KEY = ""
os.environ["LLM_BASE_URL"] = "https://api.deepseek.com"   # 通义：https://dashscope.aliyuncs.com/compatible-mode/v1
os.environ["LLM_MODEL"] = "deepseek-chat"                 # 通义：qwen-plus
if LLM_API_KEY:
    os.environ["LLM_API_KEY"] = LLM_API_KEY
print("Key：", "已设置" if os.getenv("LLM_API_KEY") else "未设置（会走缺 Key 的报错分支）")"""

PRICE_LINES = """os.environ.setdefault("PRICE_IN_PER_M", "2")    # 输入单价（元/百万 token），以服务商官网为准
os.environ.setdefault("PRICE_OUT_PER_M", "8")   # 输出单价"""

NOTE = """> 📓 **这是第 {label} 的 Notebook 版**，内容和[课程网页](https://pollux1314.github.io/agent-course/#/day/{day})一样。
> 先运行第一格「运行环境准备」，再从上往下逐格 Shift+Enter。你改的代码自动存在这个浏览器里；想恢复原样，在左侧文件列表右键这个文件 → Delete，刷新后会重新出现原版。
>
> 浏览器里的 Python（Pyodide）的限制：`input()`、`subprocess`、本地文件和数据库要用本地 `uv run`；访问外部网站需要对方允许跨域（DeepSeek、通义、GitHub API、httpbin 都可以）。本地脚本里的 `asyncio.run(main())` 在这里已改成 `await main()`；输出里看到 `SystemExit: ...` 是脚本主动退出（比如没填 Key），不是环境坏了。"""


def cell(kind: str, src: str) -> dict:
    c = {"cell_type": kind, "metadata": {}, "source": src.splitlines(keepends=True)}
    if kind == "code":
        c.update(execution_count=None, outputs=[])
    return c


def build(lesson: dict) -> pathlib.Path:
    md = (LESSONS / lesson["file"]).read_text(encoding="utf-8")
    blocks = split_blocks(md)
    codes = [t for k, t in blocks if k == "code"]
    day = lesson["day"]
    label = f"{day}–{lesson['dayEnd']} 天" if lesson.get("dayEnd") else f"{day} 天"
    cells = [cell("markdown", f"# 第 {label} · {lesson['title']}\n\n" + NOTE.format(label=label, day=day)),
             cell("code", setup_cell(codes))]
    if any(re.search(r"\bopenai\b|LLM_API_KEY", c) for c in codes):
        key = KEY_CELL
        if any("PRICE_" in c for c in codes):
            key = key.replace("\nif LLM_API_KEY:", "\n" + PRICE_LINES + "\nif LLM_API_KEY:")
        cells.append(cell("code", key))
    for kind, text in blocks:
        cells.append(cell(kind, adapt_code(text) if kind == "code" else text))
    nb = {"cells": cells, "nbformat": 4, "nbformat_minor": 5,
          "metadata": {"kernelspec": {"name": "python", "display_name": "Python (Pyodide)", "language": "python"},
                       "language_info": {"name": "python"}}}
    out = OUT / f"day{day:02d}.ipynb"
    out.write_text(json.dumps(nb, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    idx = json.loads((LESSONS / "index.json").read_text(encoding="utf-8"))
    keep = set()
    for l in idx["lessons"]:
        if l.get("status") == "ready" and (LESSONS / l["file"]).exists():
            p = build(l); keep.add(p.name); print("notebook:", p.relative_to(ROOT))
    for p in OUT.glob("day*.ipynb"):
        if p.name not in keep:
            p.unlink()


if __name__ == "__main__":
    main()
