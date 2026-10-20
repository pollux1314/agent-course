/* Pyodide 运行器（Web Worker）：避免死循环卡住页面，可随时终止重建 */
import { loadPyodide } from "../pyodide/pyodide.mjs";
const BASE = new URL("../pyodide/", self.location.href).href;
let pyReady = null;

function out(type, text) { self.postMessage({ type, text }); }
// Pyodide 致命错误时会写 console.error 并卡住：转告主线程，由主线程重建 Worker
const _cerr = console.error.bind(console);
console.error = (...a) => { _cerr(...a); if (String(a[0]).includes("fatal error")) self.postMessage({ type: "fatal", text: "Python 运行环境崩溃了，已自动重置，请再点一次运行。" }); };

async function init() {
  const py = await loadPyodide({
    indexURL: BASE,
    stdout: (t) => out("stdout", t),
    stderr: (t) => out("stderr", t),
  });
  // tiktoken 的编码文件改为本站自托管，提前放进缓存目录（免跨域、国内可访问）
  py.FS.mkdirTree("/tmp/tiktoken");
  const tk = await fetch(BASE + "cl100k_base.tiktoken");
  if (tk.ok) py.FS.writeFile("/tmp/tiktoken/9b5ad71b2ce5302211f9c61530b329a4922fc6a4", new Uint8Array(await tk.arrayBuffer()));
  py.runPython(`
import os, sys, asyncio
os.environ["TIKTOKEN_CACHE_DIR"] = "/tmp/tiktoken"
os.makedirs("/home/pyodide/agent-lab", exist_ok=True)
os.chdir("/home/pyodide/agent-lab")
`);
  return py;
}

// 用户代码跑在一个全新的 __main__ 模块里（pydantic / dataclass 解析注解需要 sys.modules 能找到它）
const DRIVER = `
import ast, asyncio, inspect, sys, traceback, types
_m = types.ModuleType("__main__"); _m.__file__ = "main.py"
sys.modules["__main__"] = _m
sys.argv = ["main.py"]
_g = _m.__dict__
_pending_runs = []
exec(_PRELUDE, _g)
async def _drive(code):
    import linecache
    with open("main.py", "w", encoding="utf-8") as f:   # 落盘：dotenv 找路径、traceback 显示源码行都要用
        f.write(code)
    linecache.checkcache("main.py")
    try:
        r = eval(compile(code, "main.py", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT), _g)
        if inspect.iscoroutine(r):
            await r
        for t in _g.get("_pending_runs", []):
            await t
        return 0
    except SystemExit as e:
        if e.code not in (None, 0):
            print(e.code, file=sys.stderr)
        return 0
    except BaseException as e:
        tb = e.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename != "main.py":
            tb = tb.tb_next
        print("".join(traceback.format_exception(type(e), e, tb or e.__traceback__)), file=sys.stderr, end="")
        return 1
    finally:
        sys.stdout.flush(); sys.stderr.flush()
await _drive(_user_code)
`;
const PRELUDE = `
import os, sys, asyncio
_pending_runs = []
def _browser_asyncio_run(coro, *a, **k):
    # 浏览器里事件循环已在运行：把协程排进去，运行器最后统一 await
    t = asyncio.ensure_future(coro); _pending_runs.append(t); return t
asyncio.run = _browser_asyncio_run
try:
    # 同步 httpx（含 openai 同步客户端）统一走 Worker 里的同步 XHR：
    # 不依赖 JSPI，iPhone Safari / 安卓 Chrome / 桌面浏览器行为一致
    import httpx._transports.jsfetch as _jf
    _jf.can_run_sync = lambda: False
except Exception:
    pass
`;

self.onmessage = async (ev) => {
  const { id, code, env } = ev.data;
  try {
    if (!pyReady) { out("status", "正在加载 Python 运行环境（首次约 10MB，之后有缓存）…"); pyReady = init(); }
    const py = await pyReady;
    out("status", "正在加载依赖…");
    py.globals.set("_PRELUDE", PRELUDE);
    await py.loadPackagesFromImports(code, { messageCallback: () => {}, errorCallback: (m) => out("stderr", m) });
    if (/\b(from|import)\s+dotenv\b/.test(code)) {
      await py.loadPackage("micropip", { messageCallback: () => {} });
      const mp = py.pyimport("micropip");
      await mp.install(BASE + "python_dotenv-1.2.4-py3-none-any.whl");
    }
    // 设置页里填的配置 → 环境变量 + .env 文件（与本地 uv 项目行为一致）
    const envObj = env || {};
    const dotenv = Object.entries(envObj).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("\n");
    py.FS.writeFile("/home/pyodide/agent-lab/.env", dotenv + "\n");
    py.globals.set("_env_js", py.toPy(envObj));
    py.runPython(`import os\nfor _k in list(os.environ):\n    if _k.startswith(("LLM_", "PRICE_")): del os.environ[_k]\nfor _k, _v in _env_js.items():\n    if _v: os.environ[_k] = str(_v)\ndel _env_js`);
    out("status", "运行中…");
    py.globals.set("_user_code", code);
    const rc = await py.runPythonAsync(DRIVER);
    self.postMessage({ type: rc === 0 ? "done" : "error", id });
  } catch (e) {
    let msg = String(e && e.message ? e.message : e);
    const m = msg.match(/SystemExit: ?(.*)\n?$/s);
    if (m) { if (m[1].trim() && m[1].trim() !== "0") out("stderr", m[1].trim()); self.postMessage({ type: "done", id, exit: true }); return; }
    // 精简 Pyodide 内部堆栈，只保留用户代码相关部分
    const i = msg.indexOf('File "main.py"');
    if (i > 0) msg = "Traceback (most recent call last):\n  " + msg.slice(i);
    out("stderr", msg);
    self.postMessage({ type: "error", id });
  }
};
