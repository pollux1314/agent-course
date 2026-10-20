#!/usr/bin/env python3
"""新增或更新一课：把 Markdown 放进 lessons/，并在 lessons/index.json 里登记。

用法：
  python3 scripts/add_lesson.py 6 "流式输出与多轮对话" path/to/day06.md \
      --summary "stream=True 逐字输出，自己维护 messages 实现多轮记忆" [--phase 1] [--day-end 14]

- 已存在同一天的条目会被覆盖（status 改为 ready），不存在则按天数顺序插入。
- 会同时把 index.json 的 updated 字段改成今天。
"""
import argparse, datetime, json, pathlib, shutil

ROOT = pathlib.Path(__file__).resolve().parent.parent
LESSONS = ROOT / "lessons"

ap = argparse.ArgumentParser()
ap.add_argument("day", type=int)
ap.add_argument("title")
ap.add_argument("markdown", help="课程 Markdown 文件路径（可以已经在 lessons/ 里）")
ap.add_argument("--summary", default="")
ap.add_argument("--phase", type=int, help="默认按天数自动判断阶段")
ap.add_argument("--day-end", type=int, help="跨多天的课，比如 13–14 天的阶段项目")
ap.add_argument("--status", default="ready", choices=["ready", "outline"])
a = ap.parse_args()

idx = json.loads((LESSONS / "index.json").read_text())
fname = f"day{a.day:02d}.md"
src = pathlib.Path(a.markdown).resolve()
if src != (LESSONS / fname).resolve():
    shutil.copyfile(src, LESSONS / fname)
phase = a.phase or next(p["id"] for p in idx["phases"] if p["range"][0] <= a.day <= p["range"][1])
item = {"day": a.day, "phase": phase, "title": a.title, "file": fname, "status": a.status, "summary": a.summary}
if a.day_end:
    item["dayEnd"] = a.day_end
old = next((l for l in idx["lessons"] if l["day"] == a.day), None)
if old:
    if not a.summary:
        item["summary"] = old.get("summary", "")
    if "dayEnd" in old and not a.day_end:
        item["dayEnd"] = old["dayEnd"]
    idx["lessons"][idx["lessons"].index(old)] = item
else:
    idx["lessons"].append(item)
idx["lessons"].sort(key=lambda l: l["day"])
idx["updated"] = datetime.date.today().isoformat()
(LESSONS / "index.json").write_text(json.dumps(idx, ensure_ascii=False, indent=2) + "\n")
print(f"OK: 第 {a.day} 天《{a.title}》→ lessons/{fname}（阶段 {phase}，{a.status}）")
