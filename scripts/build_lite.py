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
print("OK: JupyterLite 已构建到 lite/（记得 git add -A 提交）")
