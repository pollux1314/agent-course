> 🎯 **本周末目标**：把第 1 阶段学的东西整合成一个**命令行助手**：多轮对话 + 流式输出 + 3 个工具（天气、计算器、读本地笔记），工具出错不崩。这是第 1 阶段的毕业作品，也是第 2 阶段手写 Agent 的起点。
>
> ⏱ 两天共 2~4 小时 ｜ 📦 产出：agent-lab 里的 `assistant/` 项目 + README，推到 GitHub

## 1. 原理：今天唯一的新知识点（Java 对照）

前 12 天的零件都学过了，拼起来时只会撞上一个新问题：**流式输出 + function calling 一起用**。

`stream=True` 时，模型的回答是一块一块来的。文字好办，`print` 出去就行；但 **tool_calls 也是碎片**：

```text
chunk 1: tool_calls=[{index: 0, id: "call_a", function: {name: "get_weather", arguments: ""}}]
chunk 2: tool_calls=[{index: 0, function: {arguments: "{\"ci"}}]
chunk 3: tool_calls=[{index: 0, function: {arguments: "ty\": \"北"}}]
chunk 4: tool_calls=[{index: 1, id: "call_b", function: {name: "calculator", arguments: ""}}]   ← 第二个工具
chunk 5: tool_calls=[{index: 0, function: {arguments: "京\"}"}}]
...
```

规则：**第一块带 `id` 和 `name`，后面只带一段 `arguments`，用 `index` 归位**，全部收完才能 `json.loads`。

| 本项目里的东西 | Java 类比 | 说明 |
|---|---|---|
| `accumulate()` 按 index 拼 tool_calls | `StringBuilder[]`，按下标 `append` | 流没结束前 arguments 是半截 JSON，不能解析 |
| `async for kind, value in llm(...)` | Reactor `Flux<Event>` / SSE 订阅 | 边收边打印文字，最后拿到完整消息 |
| `@tool(...)` 装饰器自动注册 | `@Component` + 组件扫描 | 新增工具只写一个函数，不用改循环 |
| `run_tool()` | `@ControllerAdvice` | 第 12 天的统一错误处理，原样复用 |
| `ChatSession` + `_trim()` | 有状态的 Service + 滑动窗口 | 保存多轮历史；裁剪时不能从 tool 消息中间切断 |
| `llm.py / tools.py / main.py` | client 层 / service 层 / controller 层 | 分层，换模型只改 llm.py |

> 💡 `_trim()` 为什么要跳过开头的非 user 消息？因为 `tool` 消息必须紧跟在带 `tool_calls` 的 `assistant` 消息后面，切断了 API 会直接报 400。

## 2. 可运行示例（单文件版）

假模型按剧本跑 4 轮对话：查北京天气 → "那上海呢？"（靠多轮记忆知道问的是天气，同时有一个工具报错）→ 算温差 → 读笔记（先列文件再读）。注意假模型也是把 tool_calls **拆成碎片**流式发出的，和真 API 走同一个 `accumulate()`。填了 Key 就是真模型。

```python run
"""第 13–14 天 · 阶段项目：命令行助手（多轮对话 + 流式输出 + 3 个工具）
没有 Key 也能跑（假模型按剧本流式输出、调用工具）；填了 LLM_API_KEY 就调用真模型。
浏览器里是单文件版；本地请按课程把三段拆成 llm.py / tools.py / main.py。
新知识点：流式输出时 tool_calls 也是"一块一块"来的，要按 index 拼起来。"""
import ast
import asyncio
import json
import operator
import os
import pathlib
from types import SimpleNamespace as NS

from dotenv import load_dotenv
from pydantic import BaseModel, Field, ValidationError, field_validator

load_dotenv()

# ======================= tools.py：工具注册 =======================
REGISTRY: dict[str, tuple] = {}  # name -> (参数模型, 函数, 超时秒数)
TOOLS: list[dict] = []


def tool(args_model, description: str, timeout: float = 2.0):
    """注册工具的装饰器（类比 Spring 的 @Component + 自动扫描）"""
    def deco(func):
        REGISTRY[func.__name__] = (args_model, func, timeout)
        TOOLS.append({"type": "function", "function": {
            "name": func.__name__, "description": description,
            "parameters": args_model.model_json_schema()}})
        return func
    return deco


class ToolError(Exception):
    def __init__(self, message: str, hint: str = ""):
        super().__init__(message)
        self.hint = hint


FAKE_WEATHER = {"北京": {"condition": "晴", "temp_c": 12}, "上海": {"condition": "小雨", "temp_c": 18}}


class WeatherArgs(BaseModel):
    city: str = Field(min_length=1, max_length=10, description="城市中文名，如 北京、上海")

    @field_validator("city")
    @classmethod
    def strip_city(cls, v: str) -> str:
        return v.strip().removesuffix("市")


@tool(WeatherArgs, "查询城市当前天气和气温。")
async def get_weather(city: str) -> dict:
    await asyncio.sleep(0.1)
    if city not in FAKE_WEATHER:
        raise ToolError(f"没有 {city} 的天气数据", hint=f"只支持：{', '.join(FAKE_WEATHER)}")
    return {"city": city, **FAKE_WEATHER[city]}


class CalcArgs(BaseModel):
    expression: str = Field(max_length=100, description="只含数字和 + - * / ** ( ) 的算术表达式")


_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
        ast.Div: operator.truediv, ast.Pow: operator.pow, ast.USub: operator.neg}


def _eval(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
        left, right = _eval(node.left), _eval(node.right)
        if isinstance(node.op, ast.Pow) and (abs(right) > 100 or abs(left) > 10_000):
            raise ToolError("指数太大，拒绝计算", hint="底数绝对值 ≤ 10000、指数绝对值 ≤ 100")
        return _OPS[type(node.op)](left, right)
    if isinstance(node, ast.UnaryOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval(node.operand))
    raise ToolError("表达式里有不允许的内容", hint="只能用数字和 + - * / ** ( )")


@tool(CalcArgs, "精确计算算术表达式，任何算数都用它。", timeout=1.0)
async def calculator(expression: str) -> dict:
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError:
        raise ToolError(f"表达式语法错误：{expression!r}", hint="检查括号是否配对")
    return {"expression": expression, "result": _eval(tree.body)}


NOTES_DIR = pathlib.Path("notes")


class ReadNoteArgs(BaseModel):
    filename: str = Field(description="notes 目录下的文件名，如 todo.md")


@tool(ReadNoteArgs, "读取本地 notes 目录下的笔记文件。不知道文件名时传 '*' 列出所有文件。")
async def read_note(filename: str) -> dict:
    files = sorted(p.name for p in NOTES_DIR.glob("*"))
    if filename == "*":
        return {"files": files}
    path = (NOTES_DIR / filename).resolve()
    if NOTES_DIR.resolve() not in path.parents:  # 防 ../../etc/passwd 这种越权路径
        raise ToolError("只能读 notes 目录里的文件", hint=f"可读文件：{files}")
    if not path.exists():
        raise ToolError(f"没有文件 {filename}", hint=f"可读文件：{files}")
    return {"filename": filename, "content": path.read_text(encoding="utf-8")[:2000]}


def err(kind, message, hint="", retryable=True) -> str:
    return json.dumps({"ok": False, "error_type": kind, "message": message,
                       "hint": hint, "retryable": retryable}, ensure_ascii=False)


async def run_tool(name: str, arguments: str) -> str:
    """第 12 天的执行器：永远返回字符串，绝不抛异常"""
    if name not in REGISTRY:
        return err("unknown_tool", f"没有叫 {name} 的工具", hint=f"可用工具：{', '.join(REGISTRY)}")
    args_model, func, timeout = REGISTRY[name]
    try:
        args = args_model.model_validate_json(arguments or "{}")
    except ValidationError as e:
        return err("invalid_arguments", str(e.errors()[0]["msg"]), hint="按 JSON Schema 重新传参")
    try:
        data = await asyncio.wait_for(func(**args.model_dump()), timeout)
        return json.dumps({"ok": True, "data": data}, ensure_ascii=False)
    except ToolError as e:
        return err("tool_error", str(e), hint=e.hint)
    except asyncio.TimeoutError:
        return err("timeout", f"{name} 超时", retryable=False)
    except Exception as e:
        return err("internal_error", f"{type(e).__name__}: {e}", retryable=False)


# ======================= llm.py：模型调用（流式） =======================
async def accumulate(chunks):
    """把流式 chunk 拼成：边拿到文字边 yield ("text", 片段)，最后 yield ("message", 完整 assistant 消息)。
    tool_calls 在流里是碎片：第一块带 id 和 name，后面每块只带一段 arguments，靠 index 归位。
    类比 Java：StringBuilder[] builders，按下标 append。"""
    text, calls = [], {}  # index -> {"id", "name", "arguments"}
    async for chunk in chunks:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        if delta.content:
            text.append(delta.content)
            yield "text", delta.content
        for tc in delta.tool_calls or []:
            c = calls.setdefault(tc.index, {"id": "", "name": "", "arguments": ""})
            c["id"] = tc.id or c["id"]
            if tc.function and tc.function.name:
                c["name"] += tc.function.name
            if tc.function and tc.function.arguments:
                c["arguments"] += tc.function.arguments
    msg = {"role": "assistant", "content": "".join(text) or None}
    if calls:
        msg["tool_calls"] = [{"id": c["id"], "type": "function",
                              "function": {"name": c["name"], "arguments": c["arguments"]}}
                             for _, c in sorted(calls.items())]
    yield "message", msg


async def real_stream(messages, tools):
    from openai import AsyncOpenAI
    client = AsyncOpenAI(api_key=os.environ["LLM_API_KEY"],
                         base_url=os.getenv("LLM_BASE_URL", "https://api.deepseek.com"))
    stream = await client.chat.completions.create(
        model=os.getenv("LLM_MODEL", "deepseek-chat"), messages=messages, tools=tools,
        temperature=0, stream=True)
    async for event in accumulate(stream):
        yield event


def _chunk(content=None, tool_calls=None):
    return NS(choices=[NS(delta=NS(content=content, tool_calls=tool_calls))])


def _tc_chunks(index, cid, name, args: dict):
    """模拟真实 API：一个工具调用拆成 1 块头 + 若干块 arguments 碎片"""
    raw = json.dumps(args, ensure_ascii=False)
    yield _chunk(tool_calls=[NS(index=index, id=cid, function=NS(name=name, arguments=""))])
    for i in range(0, len(raw), 4):
        yield _chunk(tool_calls=[NS(index=index, id=None, function=NS(name=None, arguments=raw[i:i + 4]))])


def _script(messages):
    """假模型的"大脑"：看最后一条 user 消息和已有的工具结果，决定下一步"""
    last_user = max(i for i, m in enumerate(messages) if m["role"] == "user")
    q = messages[last_user]["content"]
    results = {m["tool_call_id"]: json.loads(m["content"]) for m in messages[last_user:] if m["role"] == "tool"}
    if "北京" in q and "天气" in q:
        if not results:
            return [("t1", "get_weather", {"city": "北京"})]
        d = results["t1"]["data"]
        return f"北京现在{d['condition']}，{d['temp_c']}°C，出门可以穿件外套。"
    if "上海呢" in q:  # 没说"天气"，要靠多轮记忆知道问的是天气
        if not results:
            return [("t2", "get_weather", {"city": "上海"}), ("t3", "get_weather", {"city": "广州"})]
        return (f"上海{results['t2']['data']['condition']}，{results['t2']['data']['temp_c']}°C。"
                f"顺便查了广州，但{results['t3']['message']}（{results['t3']['hint']}）。")
    if "温差" in q:
        if not results:
            return [("t4", "calculator", {"expression": "18-12"})]
        return f"上海比北京高 {results['t4']['data']['result']}°C。"
    if "笔记" in q:
        if not results:
            return [("t5", "read_note", {"filename": "*"})]
        if "t6" not in results:
            return [("t6", "read_note", {"filename": results["t5"]["data"]["files"][0]})]
        return "你的待办：\n" + results["t6"]["data"]["content"].strip()
    return "我是假模型，只会按剧本回答 😄 填上 Key 试试真模型吧。"


async def fake_stream(messages, tools):
    async def chunks():
        plan = _script(messages)
        if isinstance(plan, str):
            for i in range(0, len(plan), 3):
                await asyncio.sleep(0.03)
                yield _chunk(content=plan[i:i + 3])
        else:
            for idx, (cid, name, args) in enumerate(plan):
                for c in _tc_chunks(idx, cid, name, args):
                    await asyncio.sleep(0.01)
                    yield c
    async for event in accumulate(chunks()):
        yield event


# ======================= main.py：对话循环 =======================
SYSTEM = ("你是 Jiawei 的命令行助手，回答简洁。天气、计算、读笔记必须调用工具。"
          "工具返回 ok=false 时读 hint 改正；retryable=false 就如实告诉用户。")
MAX_ROUNDS = 5
MAX_HISTORY = 20  # 只保留最近 20 条（不含 system），防止上下文无限增长


class ChatSession:
    def __init__(self, llm):
        self.llm = llm
        self.messages = [{"role": "system", "content": SYSTEM}]

    def _trim(self):
        rest = self.messages[1:]
        while len(rest) > MAX_HISTORY:
            rest.pop(0)
            while rest and rest[0]["role"] != "user":  # 不能从 tool 消息中间切断
                rest.pop(0)
        self.messages = self.messages[:1] + rest

    async def turn(self, user_input: str) -> None:
        self.messages.append({"role": "user", "content": user_input})
        self._trim()
        seen: dict[tuple, int] = {}
        for _ in range(MAX_ROUNDS):
            print("助手：", end="", flush=True)
            reply = None
            async for kind, value in self.llm(self.messages, TOOLS):
                if kind == "text":
                    print(value, end="", flush=True)  # 逐字输出
                else:
                    reply = value
            self.messages.append(reply)
            if not reply.get("tool_calls"):
                print()
                return
            print("（调用工具）")

            async def handle(c):
                key = (c["function"]["name"], c["function"]["arguments"])
                seen[key] = seen.get(key, 0) + 1
                if seen[key] > 2:
                    return err("repeated_call", "同样的调用已执行过", retryable=False)
                return await run_tool(*key)

            results = await asyncio.gather(*(handle(c) for c in reply["tool_calls"]))
            for c, r in zip(reply["tool_calls"], results):
                print(f"   🔧 {c['function']['name']}({c['function']['arguments']}) → {r}")
                self.messages.append({"role": "tool", "tool_call_id": c["id"], "content": r})
        print(f"\n⚠️ 超过 {MAX_ROUNDS} 轮，强制停止")


def prepare_notes():
    NOTES_DIR.mkdir(exist_ok=True)
    f = NOTES_DIR / "todo.md"
    if not f.exists():
        f.write_text("- 完成第 13–14 天阶段项目\n- 和老师细化第 2 阶段日程\n", encoding="utf-8")


async def main():
    prepare_notes()
    llm = real_stream if os.getenv("LLM_API_KEY") else fake_stream
    print("使用", "真模型" if llm is real_stream else "假模型（没填 Key）", "\n")
    session = ChatSession(llm)
    # 浏览器里没有 input()，用剧本代替；本地版换成 while True: input("你：")
    for q in ["北京天气怎么样？", "那上海呢？顺便看看广州", "两地温差多少？", "看看我的笔记里有什么待办"]:
        print(f"\n你：{q}")
        await session.turn(q)
    print(f"\n（本次会话共 {len(session.messages)} 条消息）")


if __name__ == "__main__":
    asyncio.run(main())
```

## 3. 本地拆成项目（这两天的主任务）

在 agent-lab 里建 `assistant/`，把上面三段代码按注释分隔线拆开：

```text
agent-lab/assistant/
├── llm.py      # accumulate、real_stream、fake_stream
├── tools.py    # tool 装饰器、ToolError、3 个工具、run_tool、TOOLS
├── main.py     # ChatSession + 输入循环
├── notes/todo.md
└── README.md
```

`main.py` 的 `main()` 换成真正的交互循环（本地有 `input()`）：

```python
from llm import real_stream, fake_stream
from tools import TOOLS, run_tool, err

async def main():
    llm = real_stream if os.getenv("LLM_API_KEY") else fake_stream
    session = ChatSession(llm)
    while True:
        q = (await asyncio.to_thread(input, "\n你：")).strip()   # input 是阻塞的，放线程里
        if q in ("/exit", "/quit"):
            break
        if q == "/clear":
            session.messages = session.messages[:1]
            print("（已清空历史）")
            continue
        if q:
            await session.turn(q)
```

```bash
cd agent-lab && uv add openai pydantic python-dotenv
cd assistant && uv run main.py
```

## 今日练习（两天的项目）

- [ ] 拆成 `llm.py / tools.py / main.py` 三个文件，`uv run main.py` 能交互聊天
- [ ] 加 `/exit`、`/clear` 两个命令
- [ ] **自己加第 4 个工具**，比如 `query_db`：用 Python 自带的 `sqlite3` 建一张 orders 表，让模型查"最近 3 笔订单"（只允许 SELECT，其他语句 `raise ToolError`）
- [ ] 用真 Key 跑一遍自测清单：
  - [ ] 能连续聊 10 轮不出错
  - [ ] 模型能正确选择工具（问天气不去调计算器）
  - [ ] 工具报错时不会崩溃（问广州天气、算 `9**9**9`、读 `../../etc/passwd`）
  - [ ] 能用自己的话说清楚 function calling 的完整流程
- [ ] 写 README（做什么、怎么跑、项目结构、一张流程图），推到 GitHub

README 起步模板：

```text
# 命令行助手（Agent 学习第 1 阶段作品）
多轮对话 + 流式输出 + function calling（天气 / 计算器 / 读笔记 / 查数据库）

## 运行
cp .env.example .env   # 填 LLM_API_KEY
uv run main.py

## 结构
llm.py   模型调用：流式输出，按 index 拼接 tool_calls
tools.py 工具注册（装饰器）+ 统一错误处理
main.py  对话循环：多轮历史、最大轮数、重复调用检测

## 流程
用户输入 → 模型 → (tool_calls? → 执行工具 → 结果发回模型 → ...) → 最终回答
```

做完把 **GitHub 仓库链接**，或者运行截图 / 报错发给老师批改。

## 🤔 思考题

1. 流式输出时，为什么不能每收到一块 arguments 就 `json.loads` 一次？
2. 模型先输出了一句"我帮你查一下"，**然后**又给了 tool_calls，你的代码会怎么处理这句话？要不要存进历史？
3. 现在的 `turn()` 里，"调模型 → 执行工具 → 再调模型"这个循环，其实已经是一个最简单的 **Agent 循环**了。第 2 阶段要在它上面加什么，才能让它"自己规划多步任务"？
