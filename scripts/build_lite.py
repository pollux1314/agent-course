#!/usr/bin/env python3
"""重新生成 Notebook 并构建 JupyterLite 站点到 lite/（会提交进仓库，GitHub Pages 直接托管）

  python3 scripts/build_lite.py

需要 uv（自动拉取固定版本的 jupyterlite，不污染系统环境）。
源文件：jupyterlite/（配置 + content/ 下由 build_notebooks.py 生成的 dayNN.ipynb）
"""
import pathlib, shutil, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LITE_SRC = ROOT / "jupyterlite"
DEPS = ["jupyterlite-core==0.8.7", "jupyterlite-pyodide-kernel==0.8.6", "jupyter-server"]

subprocess.run([sys.executable, str(ROOT / "scripts" / "build_notebooks.py")], check=True)
uv = shutil.which("uv")
if not uv:
    sys.exit("没找到 uv：先装 uv（https://docs.astral.sh/uv/），再运行 python3 scripts/build_lite.py")
cmd = [uv, "run", "--no-project", "--python", "3.12"]
for d in DEPS:
    cmd += ["--with", d]
cmd += ["jupyter", "lite", "build"]
subprocess.run(cmd, cwd=LITE_SRC, check=True)

# 给 JupyterLite 各页面加一个「加载太久」的提示（顺带显示捕获到的 JS 报错，方便截图排查）
HELP = """<script id="agentcourse-slow-hint">
(function () {
  var errs = [];
  addEventListener("error", function (e) { errs.push(String(e.message || (e.target && (e.target.src || e.target.href)) || e)); }, true);
  addEventListener("unhandledrejection", function (e) { errs.push(String(e.reason && (e.reason.stack || e.reason.message) || e.reason)); });
  setTimeout(function () {
    if (document.querySelector(".jp-LabShell, .jp-NotebookPanel, .jp-DirListing, #main")) return;
    var d = document.createElement("div");
    d.style.cssText = "position:fixed;left:12px;right:12px;top:12px;z-index:99999;padding:14px 16px;border-radius:12px;background:#fff7ed;color:#7c2d12;border:1px solid #fdba74;font:14px/1.6 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.12)";
    d.innerHTML = "<b>Notebook 界面加载了 25 秒还没出来</b><br>1. 按 Ctrl+Shift+R（手机：下拉刷新）强制刷新一次；<br>2. 还不行：F12 → Application → Storage → Clear site data，再刷新；<br>3. 关掉翻译 / 划词类浏览器插件，或用无痕窗口打开；<br>4. 把这块提示截图发给老师。" +
      (errs.length ? "<pre style='white-space:pre-wrap;font-size:12px;margin:8px 0 0;max-height:40vh;overflow:auto'>" + errs.slice(0, 8).join("\\n").replace(/[<&]/g, function (c) { return c === "<" ? "&lt;" : "&amp;"; }) + "</pre>" : "");
    document.body.appendChild(d);
  }, 25000);
})();
</script>"""
for page in (ROOT / "lite").glob("*/index.html"):
    html = page.read_text(encoding="utf-8")
    if "agentcourse-slow-hint" not in html and "</head>" in html:
        page.write_text(html.replace("</head>", HELP + "\n</head>", 1), encoding="utf-8")
# JupyterLite 0.8 的 service worker 只在 activate 时读 enableCache；浏览器把空闲的 SW 回收后再唤醒，
# 这个开关就变回 false，缓存形同虚设。改成脚本一加载就从自己的 URL 读，保证每次打开都能命中缓存。
sw = ROOT / "lite" / "service-worker.js"
src = sw.read_text(encoding="utf-8")
OLD = 'let enableCache=!1;'
NEW = 'let enableCache="true"===new URL(location.href).searchParams.get("enableCache");'
if NEW not in src:
    if OLD not in src:
        sys.exit("service-worker.js 结构变了，没法打缓存补丁：检查 build_lite.py")
    sw.write_text(src.replace(OLD, NEW, 1), encoding="utf-8")
print("OK: JupyterLite 已构建到 lite/（记得 git add -A 提交）")
