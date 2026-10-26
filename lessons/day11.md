> 🎯 **今日目标**：同时注册多个工具让模型自己选；处理模型**一次返回多个 `tool_calls`** 的情况（并发执行）；把昨天的"两次调用"升级成"循环到模型不再要工具为止"。
>
> ⏱ 预计 1~1.5 小时 ｜ 📦 产出：天气 + 计算器 + 当前时间 三个工具的助手

## 1. 原理（Java 对照）

昨天只有一个工具，模型的选择题只有"调 / 不调"。今天有三个工具，模型要根据每个工具的 `description` 自己选，有时还会**一次选好几个**。

| 今天的东西 | Java 里的类比 | 说明 |
|---|---|---|
| `REGISTRY` 一处登记、自动生成 `TOOLS` | Spring 扫描 `@Component`，自动注册 Bean | 加工具只改一处，不会出现"注册了但说明书里没有" |
| `description` | 接口文档里的"使用场景" | 多工具时最重要：写清**什么时候用**，模型才不会选错 |
| 一次返回多个 `tool_calls` | 前端一次发多个互不依赖的请求 | 比如"北京和上海哪个暖和"→ 两个 `get_weather` |
| `asyncio.gather(...)` 并发执行 | `CompletableFuture.allOf(...)` | 3 个各耗时 0.5 秒的调用，串行 1.5 秒，并发 0.5 秒 |
| 每个 `tool_call_id` 都要回一条 `tool` 消息 | 每个 requestId 都要有响应 | 少回一条，API 直接报 400 |
| `for round in range(MAX_ROUNDS)` 循环 | 带最大重试次数的 while 循环 | 有依赖的调用（先查温度、再算温差）要分多轮 |

**并行 vs 多轮**，这是今天的核心区别：

```text
用户：北京和上海哪个暖和？现在几点？温差乘以 3 是多少？

第 1 轮（互不依赖 → 模型一次发 3 个，我们并发执行）
  get_weather(北京)  get_weather(上海)  get_current_time()
第 2 轮（依赖第 1 轮的温度 → 只能下一轮再要）
  calculator("(18-12)*3")
第 3 轮：没有 tool_calls 了 → 最终回答，退出循环
```

几个要点：

- **同一轮的多个调用之间没有依赖**，所以可以放心并发；有依赖的，模型会自己拆到下一轮。
- **`gather` 返回结果的顺序和传入顺序一致**，用 `zip(calls, results)` 就能对上 `tool_call_id`。
- 计算器**绝对不能用 `eval()`**：参数是模型生成的，等同于用户输入。示例里用 `ast` 只放行数字和四则运算，类比 Java 里不要拼 SQL。
- 时间工具用 `timezone(timedelta(hours=8))` 而不是时区名，浏览器环境里没有时区数据库也能跑。

## 2. 可运行示例

没填 Key 时用假模型，它会模拟真实模型的典型行为：第 1 轮并行要 3 个工具，第 2 轮要计算器，第 3 轮作答。注意看"⏱ 并发执行耗时"：3 个工具各睡 0.5 秒，总共只用 0.5 秒左右。

```python run
"""第 11 天 · 多工具与并行调用：天气 + 计算器 + 当前时间
没有 Key 也能跑（假模型照真实协议返回 tool_calls）；填了 LLM_API_KEY 就调用真模型。
要点：① 注册多个工具让模型自己选 ② 一次返回多个 tool_calls 时并发执行 ③ 循环直到模型不再要工具"""
import ast
import asyncio
import json
import operator
import os
import time
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv
from pydantic import BaseModel, Field, ValidationError

load_dotenv()


# ---------- 1. 三个工具的实现（类比三个 Service 方法） ----------
FAKE_WEATHER = {
    "北京": {"condition": "晴", "temp_c": 12},
    "上海": {"condition": "小雨", "temp_c": 18},
    "深圳": {"condition": "多云", "temp_c": 26},
}


class WeatherArgs(BaseModel):
    city: str = Field(description="城市中文名，如 北京、上海")


async def get_weather(city: str) -> dict:
    await asyncio.sleep(0.5)  # 假装是一次耗时 0.5 秒的网络请求
    data = FAKE_WEATHER.get(city)
    if data is None:
        return {"error": f"没有 {city} 的天气数据，支持：{', '.join(FAKE_WEATHER)}"}
    return {"city": city, **data}


class CalcArgs(BaseModel):
    expression: str = Field(description="只含数字和 + - * / ** ( ) 的算术表达式，如 (18-12)*3")


_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
        ast.Div: operator.truediv, ast.Pow: operator.pow, ast.USub: operator.neg}


def _eval(node):
    """只允许数字和四则运算的安全求值；千万别用 eval()，模型给的字符串不可信"""
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval(node.left), _eval(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval(node.operand))
    raise ValueError("表达式里有不允许的内容")


async def calculator(expression: str) -> dict:
    try:
        return {"expression": expression, "result": _eval(ast.parse(expression, mode="eval").body)}
    except (ValueError, SyntaxError, ZeroDivisionError) as e:
        return {"error": f"无法计算 {expression!r}：{e}"}


class TimeArgs(BaseModel):
    utc_offset: int = Field(default=8, ge=-12, le=14, description="时区相对 UTC 的小时数，北京时间是 8")


async def get_current_time(utc_offset: int = 8) -> dict:
    now = datetime.now(timezone(timedelta(hours=utc_offset)))
    return {"now": now.strftime("%Y-%m-%d %H:%M:%S"), "weekday": now.strftime("%A"),
            "utc_offset": utc_offset}


# ---------- 2. 注册表：一处登记，自动生成 tools 说明书（类比 Spring 扫描 @Component） ----------
REGISTRY = {
    "get_weather": (WeatherArgs, get_weather, "查询城市当前天气和气温。问天气、冷热、带不带伞时用。"),
    "calculator": (CalcArgs, calculator, "精确计算算术表达式。任何需要算数的地方都用它，不要心算。"),
    "get_current_time": (TimeArgs, get_current_time, "获取当前日期、时间和星期。问现在几点、今天几号时用。"),
}

TOOLS = [{"type": "function",
          "function": {"name": name, "description": desc, "parameters": model.model_json_schema()}}
         for name, (model, _, desc) in REGISTRY.items()]


async def run_tool(name: str, arguments: str) -> str:
    if name not in REGISTRY:
        return json.dumps({"error": f"未知工具 {name}"}, ensure_ascii=False)
    args_model, func, _ = REGISTRY[name]
    try:
        args = args_model.model_validate_json(arguments or "{}")
    except ValidationError as e:
        return json.dumps({"error": f"参数不合法：{e.errors()[0]['msg']}"}, ensure_ascii=False)
    return json.dumps(await func(**args.model_dump()), ensure_ascii=False)


# ---------- 3. 模型 ----------
def _call(cid: str, name: str, args: dict) -> dict:
    return {"id": cid, "type": "function",
            "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}


async def fake_llm(messages: list[dict], tools: list[dict]) -> dict:
    """模拟真实模型的典型行为：第 1 轮并行要 3 个工具；第 2 轮根据结果要计算器；第 3 轮作答"""
    await asyncio.sleep(0.05)
    results = {m["tool_call_id"]: json.loads(m["content"]) for m in messages if m["role"] == "tool"}
    if not results:
        return {"role": "assistant", "content": None, "tool_calls": [
            _call("call_1", "get_weather", {"city": "北京"}),
            _call("call_2", "get_weather", {"city": "上海"}),
            _call("call_3", "get_current_time", {"utc_offset": 8}),
        ]}
    if "call_4" not in results:
        bj, sh = results["call_1"]["temp_c"], results["call_2"]["temp_c"]
        return {"role": "assistant", "content": None,
                "tool_calls": [_call("call_4", "calculator", {"expression": f"({sh}-{bj})*3"})]}
    t, calc = results["call_3"], results["call_4"]
    return {"role": "assistant", "content":
            f"现在是 {t['now']}。上海 {results['call_2']['temp_c']}°C，北京 {results['call_1']['temp_c']}°C，"
            f"上海更暖和；温差乘以 3 等于 {calc['result']}。"}


async def real_llm(messages: list[dict], tools: list[dict]) -> dict:
    from openai import AsyncOpenAI
    client = AsyncOpenAI(api_key=os.environ["LLM_API_KEY"],
                         base_url=os.getenv("LLM_BASE_URL", "https://api.deepseek.com"))
    resp = await client.chat.completions.create(
        model=os.getenv("LLM_MODEL", "deepseek-chat"), messages=messages, tools=tools, temperature=0)
    msg = resp.choices[0].message
    out = {"role": "assistant", "content": msg.content}
    if msg.tool_calls:
        out["tool_calls"] = [{"id": c.id, "type": "function",
                              "function": {"name": c.function.name, "arguments": c.function.arguments}}
                             for c in msg.tool_calls]
    return out


# ---------- 4. 循环：模型要工具就执行（同一轮的多个调用并发），直到它给出最终回答 ----------
MAX_ROUNDS = 5  # 防死循环，第 12 天细讲


async def ask(question: str, llm) -> str:
    messages = [
        {"role": "system", "content": "你是助手。天气、时间、计算都必须调用工具，不要编造或心算。"
                                      "互不依赖的工具调用请在同一轮一起发出。"},
        {"role": "user", "content": question},
    ]
    print(f"用户：{question}")
    for round_no in range(1, MAX_ROUNDS + 1):
        reply = await llm(messages, TOOLS)
        if not reply.get("tool_calls"):
            return reply["content"]
        messages.append(reply)  # 带 tool_calls 的 assistant 消息必须放回去
        calls = reply["tool_calls"]
        print(f"\n第 {round_no} 轮：模型一次要了 {len(calls)} 个工具")
        for c in calls:
            print(f"  → {c['id']}: {c['function']['name']}({c['function']['arguments']})")

        start = time.perf_counter()
        # 并发执行（类比 CompletableFuture.allOf），gather 返回顺序和传入顺序一致
        results = await asyncio.gather(*(run_tool(c["function"]["name"], c["function"]["arguments"])
                                         for c in calls))
        print(f"  ⏱ 并发执行耗时 {time.perf_counter() - start:.2f}s")
        for c, result in zip(calls, results):
            print(f"  ← {c['id']}: {result}")
            # 每个 tool_call 都必须有一条对应 tool_call_id 的回复，少一条 API 就报 400
            messages.append({"role": "tool", "tool_call_id": c["id"], "content": result})
    return f"超过 {MAX_ROUNDS} 轮还没得出答案，停止。"


async def main():
    llm = real_llm if os.getenv("LLM_API_KEY") else fake_llm
    print("使用", "真模型" if llm is real_llm else "假模型（没填 Key）", "\n")
    answer = await ask("北京和上海现在哪个更暖和？顺便告诉我现在几点，再算一下两地温差乘以 3。", llm)
    print("\n最终回答：", answer)

    print("\n--- 计算器的安全性测试 ---")
    print(await run_tool("calculator", '{"expression": "2**10 + 1/4"}'))
    print(await run_tool("calculator", '{"expression": "__import__(\'os\').system(\'ls\')"}'))
    print(await run_tool("calculator", '{"expression": "1/0"}'))


if __name__ == "__main__":
    asyncio.run(main())
```

**看点**：

1. `REGISTRY` 的每一项是 `(参数模型, 函数, 说明)`，`TOOLS` 用一行推导式自动生成。明天想加工具，只加一行。
2. `ask()` 里的 `for round_no in range(...)` 就是 Agent 循环的雏形：模型要工具就执行，不要了就返回。第 2 阶段我们手写的 Agent 本质上就是这个循环加上更多工具。
3. 三个工具都写成了 `async def`，这样才能用 `gather` 并发。真实项目里工具多半是网络请求或查库，并发收益很明显。
4. 最下面的安全性测试：`__import__('os').system('ls')` 被拦下了，`1/0` 返回错误 JSON 而不是让程序崩溃。

## 3. 本地运行

```bash
cd agent-lab
uv add openai python-dotenv pydantic     # 装过就跳过
uv run day11_multi_tools.py
```

用真 Key 跑时重点看第 1 轮：DeepSeek 一般会一次返回多个 `tool_calls`，但不同模型行为不一样，有的会一个一个要。**把你的真实输出贴给老师**，我们一起看它分了几轮。

## 今日练习

- [ ] 用真 Key 跑一遍，记下模型分了几轮、每轮要了几个工具
- [ ] 把 `asyncio.gather(...)` 改成普通 `for` 循环逐个 `await`，对比"⏱ 并发执行耗时"变化
- [ ] 加第 4 个工具 `get_exchange_rate(currency)`（假数据即可，比如 USD=7.1、EUR=7.7），然后问"100 美元和 100 欧元换成人民币一共多少？"，看模型是不是先并行查两个汇率、再调计算器
- [ ] 进阶：把 `get_weather` 的 `description` 改成很含糊的"天气"二字，用真模型试几次，看它会不会选错或乱填参数
- [ ] 补交第 2~10 天的练习（哪怕只交一个也行）

起步模板（第 4 个工具）：

```python
FAKE_RATES = {"USD": 7.1, "EUR": 7.7}

class RateArgs(BaseModel):
    currency: str = Field(description="货币代码，如 USD、EUR")

async def get_exchange_rate(currency: str) -> dict:
    rate = FAKE_RATES.get(currency.upper())
    if rate is None:
        return {"error": f"不支持 {currency}"}
    return {"currency": currency.upper(), "cny_per_unit": rate}

# 然后在 REGISTRY 里加一行，假模型的剧本也要跟着改（或者直接用真 Key）
```

## 🤔 思考题

1. 如果同一轮里一个工具报错、另外两个成功，应该怎么回复模型？（提示：示例已经这样做了，看看是哪几行）
2. 计算器已经挡住了 `__import__`，但 `9**9**9` 会怎样？怎么防？（明天"工具的健壮性"会讲）
3. 如果两个工具会**修改**数据（比如"转账"和"查余额"），还能放心并发吗？
