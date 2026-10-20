/* 90 天 Agent 开发课 · 前端（无构建步骤，直接改 lessons/ 即可） */
(() => {
"use strict";
const { EditorView, basicSetup, keymap, indentWithTab, EditorState, python, oneDark } = window.CM;
const $app = document.getElementById("app");
const LS_PROGRESS = "agentcourse.progress.v1";
const LS_SETTINGS = "agentcourse.settings.v1";
const LS_CODE = "agentcourse.code.v1:";
const DAY_MS = 86400000;
let INDEX = null;
const editors = [];          // 当前页面上的编辑器，换页时销毁

// ---------- 存储 ----------
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const progress = () => load(LS_PROGRESS, { done: {}, tasks: {} });
function setProgress(fn) { const p = progress(); fn(p); save(LS_PROGRESS, p); }
const settings = () => load(LS_SETTINGS, { LLM_BASE_URL: "https://api.deepseek.com", LLM_MODEL: "deepseek-chat" });

function toast(msg) {
  let t = document.querySelector(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 1800);
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- 日期 ----------
function dayDate(n) {
  const [y, m, d] = INDEX.startDate.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n - 1);
  return `${dt.getMonth() + 1}月${dt.getDate()}日 周${"日一二三四五六"[dt.getDay()]}`;
}
function todayDay() {
  const [y, m, d] = INDEX.startDate.split("-").map(Number);
  const now = new Date(); const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((t0 - new Date(y, m - 1, d)) / DAY_MS) + 1;
}
const lessonOf = (n) => INDEX.lessons.find((l) => n >= l.day && n <= (l.dayEnd || l.day));
const dayLabel = (l) => (l.dayEnd ? `第 ${l.day}–${l.dayEnd} 天` : `第 ${l.day} 天`);

// ---------- Python 运行器（Web Worker + Pyodide） ----------
let worker = null, busy = null, runSeq = 0;
function getWorker() {
  if (!worker) {
    worker = new Worker("assets/py-worker.js", { type: "module" });
    worker.onmessage = (e) => busy && busy.onMsg(e.data);
    worker.onerror = (e) => busy && busy.onMsg({ type: "error-fatal", text: e.message || "运行环境加载失败" });
  }
  return worker;
}
function stopWorker() { if (worker) { worker.terminate(); worker = null; } }
function runPython(code, onMsg) {
  return new Promise((resolve) => {
    const id = ++runSeq;
    busy = { onMsg: (d) => {
      if (d.type === "fatal") { stopWorker(); d = { type: "error-fatal", text: d.text }; }
      if (d.type === "done" || d.type === "error" || d.type === "error-fatal" || d.type === "stopped") {
        if (d.type === "error-fatal") onMsg({ type: "stderr", text: d.text });
        busy = null; resolve(d.type); if (d.type !== "stopped") onMsg({ type: "end", ok: d.type === "done" }); else onMsg({ type: "stopped" }); return;
      }
      onMsg(d);
    } };
    const env = {};
    const s = settings();
    for (const k of ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "PRICE_IN_PER_M", "PRICE_OUT_PER_M"]) if (s[k]) env[k] = s[k];
    getWorker().postMessage({ id, code, env });
  });
}

// ---------- 代码块 ----------
function makeCodeBox(container, code, { runnable, storeKey, lang }) {
  const box = document.createElement("div"); box.className = "codebox";
  const bar = document.createElement("div"); bar.className = "bar";
  bar.innerHTML = `<span class="lang">${esc(lang || "text")}${runnable ? " · 可在线运行" : ""}</span>`;
  box.appendChild(bar);
  let view = null, getCode = () => code;
  if (runnable) {
    const saved = storeKey ? localStorage.getItem(LS_CODE + storeKey) : null;
    let timer;
    view = new EditorView({
      doc: saved ?? code,
      extensions: [basicSetup, python(), oneDark, keymap.of([indentWithTab]), EditorView.lineWrapping,
        EditorView.updateListener.of((u) => { if (u.docChanged && storeKey) { clearTimeout(timer); timer = setTimeout(() => localStorage.setItem(LS_CODE + storeKey, view.state.doc.toString()), 400); } })],
      parent: box,
    });
    editors.push(view);
    getCode = () => view.state.doc.toString();
    const out = document.createElement("pre"); out.className = "output";
    const btnRun = mkBtn("▶ 运行", "run"), btnReset = mkBtn("重置"), btnCopy = mkBtn("复制");
    bar.append(btnCopy, btnReset, btnRun);
    if (/\bopenai\b/.test(code) && !settings().LLM_API_KEY) {
      const h = document.createElement("div"); h.className = "hint";
      h.innerHTML = '🔑 这段要调用大模型：先去 <a href="#/settings">⚙️ 设置</a> 填 API Key（不填会走"缺 Key"的报错分支）';
      box.appendChild(h);
    }
    box.appendChild(out);
    btnReset.onclick = () => {
      if (!confirm("恢复成课程里的原始代码？你的修改会丢失。")) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
      if (storeKey) localStorage.removeItem(LS_CODE + storeKey);
      out.textContent = "";
    };
    btnRun.onclick = async () => {
      if (btnRun.classList.contains("stop")) { stopWorker(); busy && busy.onMsg({ type: "stopped" }); line("st", "⏹ 已停止（下次运行会重新加载 Python 环境）"); return; }
      if (busy) { toast("另一段代码还在运行，先等它结束或点停止"); return; }
      out.textContent = ""; const t0 = performance.now();
      let status = line("st", "准备中…");
      btnRun.textContent = "■ 停止"; btnRun.classList.replace("run", "stop");
      await runPython(getCode(), (d) => {
        if (d.type === "status") { status.textContent = d.text; }
        else if (d.type === "stdout") line("", d.text);
        else if (d.type === "stderr") line("err", d.text);
        else if (d.type === "stopped") status.remove();
        else if (d.type === "end") { status.remove(); line(d.ok ? "ok" : "err", d.ok ? `✓ 运行结束（${((performance.now() - t0) / 1000).toFixed(1)}s）` : "✗ 运行出错"); }
      });
      btnRun.textContent = "▶ 运行"; btnRun.classList.replace("stop", "run");
    };
    function line(cls, text) { const s = document.createElement("span"); if (cls) s.className = cls; s.textContent = text + "\n"; out.appendChild(s); out.scrollTop = out.scrollHeight; return s; }
  } else {
    const pre = document.createElement("pre"); pre.textContent = code; box.appendChild(pre);
    const btnCopy = mkBtn("复制"); bar.append(btnCopy);
  }
  bar.querySelectorAll("button").forEach((b) => { if (b.textContent === "复制") b.onclick = () => copy(getCode()); });
  container.replaceWith(box);
}
function mkBtn(text, cls) { const b = document.createElement("button"); b.textContent = text; if (cls) b.className = cls; return b; }
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("已复制"); }
  catch { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); toast("已复制"); }
}

// ---------- Markdown 渲染 ----------
let blocks = [];
marked.use({ renderer: { code(tok) { blocks.push(tok); return `<div class="code-ph" data-i="${blocks.length - 1}"></div>`; } } });
function renderMarkdown(md, el, dayKey) {
  blocks = [];
  el.innerHTML = marked.parse(md);
  el.querySelectorAll("a[href^='http']").forEach((a) => { a.target = "_blank"; a.rel = "noopener"; });
  el.querySelectorAll("table").forEach((t) => { const w = document.createElement("div"); w.className = "table-wrap"; t.replaceWith(w); w.appendChild(t); });
  // 练习清单：可勾选，存 localStorage
  el.querySelectorAll("li > input[type=checkbox]").forEach((cb, i) => {
    const li = cb.parentElement; li.classList.add("task");
    const key = `${dayKey}:${i}`;
    const label = document.createElement("label"); const span = document.createElement("span");
    cb.removeAttribute("disabled"); cb.checked = !!progress().tasks[key];
    while (cb.nextSibling) span.appendChild(cb.nextSibling);
    label.append(cb, span); li.prepend(label);
    cb.onchange = () => setProgress((p) => { if (cb.checked) p.tasks[key] = true; else delete p.tasks[key]; });
  });
  let runIdx = 0;
  el.querySelectorAll(".code-ph").forEach((ph) => {
    const tok = blocks[+ph.dataset.i]; const info = (tok.lang || "").trim().split(/\s+/);
    const runnable = info[0] === "python" && info.includes("run");
    makeCodeBox(ph, tok.text, { runnable, lang: info[0] || "text", storeKey: runnable ? `${dayKey}:${runIdx++}` : null });
  });
}

// ---------- 页面 ----------
function destroyEditors() { while (editors.length) editors.pop().destroy(); }

function pageHome() {
  const p = progress(); const today = todayDay();
  const ready = INDEX.lessons.filter((l) => l.status === "ready");
  const doneCount = INDEX.lessons.filter((l) => p.done[l.day]).length;
  const totalDays = 90;
  const doneDays = INDEX.lessons.filter((l) => p.done[l.day]).reduce((s, l) => s + ((l.dayEnd || l.day) - l.day + 1), 0);
  const next = ready.find((l) => !p.done[l.day]) || lessonOf(Math.min(Math.max(today, 1), 90)) || ready[ready.length - 1];
  const curPhase = (INDEX.phases.find((ph) => today >= ph.range[0] && today <= ph.range[1]) || INDEX.phases[0]).id;
  const tab = +(sessionStorage.getItem("tab") || curPhase);
  $app.innerHTML = `
  <section class="card hero">
    <h1>${esc(INDEX.title)}</h1>
    <div class="muted">今天是第 <b>${today}</b> 天 · 已完成 ${doneCount} 课（${doneDays}/${totalDays} 天）</div>
    <div class="progress"><i style="width:${(doneDays / totalDays) * 100}%"></i></div>
    ${next ? `<a class="today-btn" href="#/day/${next.day}">${p.done[next.day] ? "复习" : "继续学习"}：${dayLabel(next)} · ${esc(next.title)}</a>` : ""}
  </section>
  <div class="tabs">${INDEX.phases.map((ph) => `<button data-ph="${ph.id}" class="${ph.id === tab ? "on" : ""}">阶段 ${ph.id}</button>`).join("")}</div>
  <div id="phase"></div>`;
  $app.querySelectorAll(".tabs button").forEach((b) => b.onclick = () => { sessionStorage.setItem("tab", b.dataset.ph); pageHome(); });
  const ph = INDEX.phases.find((x) => x.id === tab);
  const items = INDEX.lessons.filter((l) => l.phase === tab);
  document.getElementById("phase").innerHTML = `
    <section class="card phase-head">
      <h2>阶段 ${ph.id}：${esc(ph.title)}</h2>
      <p>📅 第 ${ph.range[0]}–${ph.range[1]} 天（${dayDate(ph.range[0])} 起）</p>
      <p>🎯 ${esc(ph.goal)}</p>
      <p>📦 阶段成果：${esc(ph.deliverable)}</p>
    </section>
    ${items.length ? items.map((l) => {
      const isToday = today >= l.day && today <= (l.dayEnd || l.day);
      const cls = p.done[l.day] ? "done" : l.status === "outline" ? "outline" : "";
      return `<a class="card lesson-item ${cls}" href="#/day/${l.day}">
        <span class="num">${l.dayEnd ? `${l.day}–${l.dayEnd}` : l.day}<br>天</span>
        <span><span class="t">${esc(l.title)}</span>${isToday ? '<span class="badge today">今天</span>' : ""}${p.done[l.day] ? '<span class="badge ok">已完成</span>' : ""}
          <div class="s">${l.status === "outline" ? "🚧 待更新 · " : ""}${esc(l.summary || "")}</div></span>
        <span class="meta">${dayDate(l.day).replace(/ .*/, "")}</span></a>`;
    }).join("") : `<section class="card muted">🚧 这个阶段的每日课程会在学到这里之前细化，到时自动出现在这里。</section>`}`;
}

async function pageLesson(n) {
  const l = lessonOf(n);
  if (!l) { $app.innerHTML = `<section class="card">还没有第 ${n} 天的课程。<a href="#/">返回目录</a></section>`; return; }
  const ph = INDEX.phases.find((x) => x.id === l.phase);
  $app.innerHTML = `<article class="lesson">
    <div class="sub">${dayLabel(l)} · ${dayDate(l.day)} · 阶段 ${ph.id} ${esc(ph.title)}</div>
    <h1>${esc(l.title)}${l.status === "outline" ? '<span class="badge">待更新</span>' : ""}</h1>
    <div id="md" class="muted">加载中…</div>
    <button class="lesson-done" id="done"></button>
    <div class="pager" id="pager"></div></article>`;
  window.scrollTo(0, 0);
  const res = await fetch(`lessons/${l.file}`, { cache: "no-cache" });
  const md = await res.text();
  const el = document.getElementById("md"); el.classList.remove("muted");
  renderMarkdown(md, el, `d${l.day}`);
  const btn = document.getElementById("done");
  const paint = () => { const on = !!progress().done[l.day]; btn.classList.toggle("on", on); btn.textContent = on ? "✓ 本课已完成（点击撤销）" : "标记本课为已完成"; };
  btn.onclick = () => { setProgress((p) => { if (p.done[l.day]) delete p.done[l.day]; else p.done[l.day] = new Date().toISOString().slice(0, 10); }); paint(); if (progress().done[l.day]) toast("🎉 太棒了！"); };
  paint();
  const i = INDEX.lessons.indexOf(l), prev = INDEX.lessons[i - 1], next = INDEX.lessons[i + 1];
  document.getElementById("pager").innerHTML =
    (prev ? `<a href="#/day/${prev.day}">← ${dayLabel(prev)}</a>` : "") + `<a href="#/">目录</a>` +
    (next ? `<a href="#/day/${next.day}">${dayLabel(next)} →</a>` : "");
}

function pagePlayground() {
  $app.innerHTML = `<article class="lesson"><h1>🧪 代码练习场</h1>
    <div class="sub">随便写点 Python，自动保存在本机。支持 pydantic、httpx、openai、tiktoken、python-dotenv 等课程用到的库。</div>
    <div id="pg"></div></article>`;
  const ph = document.createElement("div"); document.getElementById("pg").appendChild(ph);
  makeCodeBox(ph, 'import sys\nprint("Python", sys.version.split()[0])\nprint("你好，Jiawei！在这里自由练习吧。")\n', { runnable: true, lang: "python", storeKey: "playground" });
}

function pageSettings() {
  const s = settings();
  const presets = { deepseek: ["https://api.deepseek.com", "deepseek-chat"], qwen: ["https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"] };
  $app.innerHTML = `<article class="lesson"><h1>⚙️ 设置</h1>
  <section class="card form">
    <b>大模型配置</b>（相当于本地项目里的 <code>.env</code>）
    <label>服务商</label>
    <select id="preset"><option value="deepseek">DeepSeek</option><option value="qwen">通义千问（DashScope）</option><option value="custom">自定义（OpenAI 兼容）</option></select>
    <label>LLM_API_KEY</label><input id="LLM_API_KEY" type="password" autocomplete="off" placeholder="sk-..." value="${esc(s.LLM_API_KEY || "")}">
    <small>只保存在这台设备的浏览器里（localStorage），运行代码时直接发给你填的服务商，不经过任何其他服务器。公共设备上别保存。</small>
    <label>LLM_BASE_URL</label><input id="LLM_BASE_URL" value="${esc(s.LLM_BASE_URL || "")}">
    <label>LLM_MODEL</label><input id="LLM_MODEL" value="${esc(s.LLM_MODEL || "")}">
    <label>PRICE_IN_PER_M（输入单价，元/百万 token）</label><input id="PRICE_IN_PER_M" inputmode="decimal" value="${esc(s.PRICE_IN_PER_M || "")}">
    <label>PRICE_OUT_PER_M（输出单价，元/百万 token）</label><input id="PRICE_OUT_PER_M" inputmode="decimal" value="${esc(s.PRICE_OUT_PER_M || "")}">
    <small>单价去服务商官网价格页查，第 5 天的计费示例会用到。</small>
    <button class="btn" id="save">保存</button><button class="btn ghost" id="test">测试连接</button><button class="btn ghost" id="clearkey">清除 Key</button>
    <pre id="testout" class="muted" style="white-space:pre-wrap"></pre>
  </section>
  <section class="card form"><b>学习进度</b>
    <small>进度、练习勾选和你改过的代码都保存在本机浏览器里。换手机或清缓存前可以先导出。</small>
    <button class="btn ghost" id="export">导出进度</button><button class="btn ghost" id="import">导入进度</button><button class="btn ghost" id="reset">清空进度</button>
  </section>
  <section class="card"><small class="muted">课程更新于 ${esc(INDEX.updated || "")}。浏览器里的 Python 由 Pyodide 提供（Python 3.14 / WebAssembly），首次运行需下载约 10MB，之后有缓存。</small></section>
  </article>`;
  const ids = ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "PRICE_IN_PER_M", "PRICE_OUT_PER_M"];
  const $ = (id) => document.getElementById(id);
  const pre = $("preset");
  pre.value = Object.keys(presets).find((k) => presets[k][0] === s.LLM_BASE_URL) || "custom";
  pre.onchange = () => { if (presets[pre.value]) { $("LLM_BASE_URL").value = presets[pre.value][0]; $("LLM_MODEL").value = presets[pre.value][1]; } };
  const collect = () => Object.fromEntries(ids.map((k) => [k, $(k).value.trim()]));
  $("save").onclick = () => { save(LS_SETTINGS, collect()); toast("已保存"); };
  $("clearkey").onclick = () => { $("LLM_API_KEY").value = ""; save(LS_SETTINGS, collect()); toast("已清除 Key"); };
  $("test").onclick = async () => {
    const c = collect(); const out = $("testout");
    if (!c.LLM_API_KEY) { out.textContent = "先填 API Key"; return; }
    out.textContent = "请求中…";
    try {
      const r = await fetch(c.LLM_BASE_URL.replace(/\/$/, "") + "/chat/completions", { method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + c.LLM_API_KEY },
        body: JSON.stringify({ model: c.LLM_MODEL, messages: [{ role: "user", content: "用一句话打个招呼" }], max_tokens: 30 }) });
      const j = await r.json();
      out.textContent = r.ok ? `✓ 连接成功（HTTP ${r.status}）\n${j.choices?.[0]?.message?.content || ""}` : `✗ HTTP ${r.status}：${j.error?.message || JSON.stringify(j)}`;
    } catch (e) { out.textContent = "✗ 请求失败（网络问题，或该服务商不允许浏览器直接调用 / CORS）：" + e.message; }
  };
  $("export").onclick = () => {
    const data = { progress: progress(), code: Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith(LS_CODE)).map((k) => [k, localStorage.getItem(k)])) };
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "agent-course-progress.json"; a.click();
  };
  $("import").onclick = () => {
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".json,application/json";
    inp.onchange = async () => { try { const d = JSON.parse(await inp.files[0].text()); if (d.progress) save(LS_PROGRESS, d.progress); for (const [k, v] of Object.entries(d.code || {})) if (k.startsWith(LS_CODE)) localStorage.setItem(k, v); toast("已导入"); } catch { toast("文件格式不对"); } };
    inp.click();
  };
  $("reset").onclick = () => { if (confirm("清空所有完成记录和练习勾选？（代码修改和设置保留）")) { localStorage.removeItem(LS_PROGRESS); toast("已清空"); } };
}

// ---------- 路由 ----------
async function route() {
  destroyEditors();
  if (!INDEX) {
    try { INDEX = await (await fetch("lessons/index.json", { cache: "no-cache" })).json(); }
    catch (e) { $app.innerHTML = `<section class="card">课程目录加载失败：${esc(e.message)}，请刷新重试。</section>`; return; }
  }
  const h = location.hash.replace(/^#/, "") || "/";
  let m;
  if ((m = h.match(/^\/day\/(\d+)/))) await pageLesson(+m[1]);
  else if (h === "/settings") pageSettings();
  else if (h === "/playground") pagePlayground();
  else pageHome();
}
window.addEventListener("hashchange", route);
route();
})();
