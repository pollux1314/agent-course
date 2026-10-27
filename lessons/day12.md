> 🎯 **今日目标**：让工具"出错也不崩"：参数校验、把错误**清楚地**告诉模型让它自我纠正、给工具加超时、用最大轮数和重复调用检测防止死循环。
>
> ⏱ 预计 1~1.5 小时 ｜ 📦 产出：故意让工具报错，观察模型如何自我纠正

## 1. 原理（Java 对照）

模型生成的工具参数，本质上就是**不可信的外部输入**：JSON 可能不完整、城市可能不支持、工具名可能拼错、表达式可能是 `9**9**9`。昨天的代码已经能"不崩"，今天要做到"出错后模型能自己改对"。

| 今天的东西 | Java 里的类比 | 说明 |
|---|---|---|
| pydantic `Field(min_length=..)`、`field_validator` | `@NotBlank`、`@Size`、自定义 `ConstraintValidator` | 参数先校验再执行；能宽容的就宽容（`北京市` → `北京`） |
| `run_tool()` 统一 `try/except` | `@ControllerAdvice` 全局异常处理 | 工具**永远返回字符串**，绝不把异常抛进 Agent 循环 |
| `ToolError(message, hint)` | 自定义 `BusinessException` + 错误码 | 区分"可预期的业务错误"和"程序 bug" |
| `{"ok": false, "error_type", "hint", "retryable"}` | 统一响应体 `Result<T>` | 模型和人一样，看到"错在哪、怎么改"才改得对 |
| `asyncio.wait_for(..., timeout)` | `future.get(1, TimeUnit.SECONDS)` / Feign 超时 | 下游卡住时不能让整个对话卡住 |
| `MAX_ROUNDS` + 重复调用计数 | 重试上限 + 熔断器 | 模型"钻牛角尖"反复调同一个工具时强制刹车 |

**好的错误信息 vs 坏的错误信息**：

```text
坏：{"error": "KeyError: '广州'"}             → 模型不知道怎么办，可能瞎猜或编造答案
好：{"ok": false, "error_type": "tool_error",
     "message": "没有 广州 的天气数据",
     "hint": "只支持：北京, 上海",
     "retryable": true}                         → 模型知道换城市，或如实告诉用户查不到
```

错误分 5 类，处理方式不同：

1. **参数不合法**（JSON 坏了、类型不对、超长）：pydantic 拦截，告诉模型按 Schema 重传。
2. **未知工具**（名字拼错）：把可用工具列表放进 `hint`。
3. **业务错误**（城市不支持、指数太大）：工具里 `raise ToolError(..., hint=...)`。
4. **超时**：`retryable: false`，告诉模型别再试了。
5. **程序 bug**（兜底 `except Exception`）：同样不重试；真实项目里要打日志告警。

最后一道保险在循环本身：**最大轮数**防止无限循环，**重复调用检测**（同一个工具 + 同样参数最多执行 2 次）防止模型一直撞同一堵墙、白白烧 token。

## 2. 可运行示例

假模型会故意犯错：第 1 轮一次犯 3 种错，第 2 轮按 `hint` 改正，但又试了 `9**9**9`；第 3 轮改对，最后作答。下半部分是"反面教材"：一个永远重复调用、调用还会超时的模型，看循环怎么把它刹住。整个运行约 3 秒（有两次 1 秒的超时）。

```python run
"""第 12 天 · 工具的健壮性：参数校验 + 错误回传 + 超时 + 防死循环
没有 Key 也能跑（假模型故意犯错，再根据错误信息自我纠正）；填了 LLM_API_KEY 就调用真模型。
要点：① 工具永不抛异常，错误统一变成 JSON 告诉模型 ② 错误信息要写清"错在哪、怎么改"
      ③ 每个工具有超时 ④ 最大轮数 + 重复调用检测，防止死循环"""
import ast
import asyncio
import json
import operator
import os

from dotenv import load_dotenv
from pydantic import BaseModel, Field, ValidationError, field_validator

load_dotenv()


# ---------- 1. 工具参数：用 pydantic 约束（类比 @NotBlank @Pattern @Max） ----------
FAKE_WEATHER = {"北京": {"condition": "晴", "temp_c": 12}, "上海": {"condition": "小雨", "temp_c": 18}}


class WeatherArgs(BaseModel):
    city: str = Field(min_length=1, max_length=10, description="城市中文名，如 北京、上海；不要带'市'字")

    @field_validator("city")
    @classmethod
    def strip_city(cls, v: str) -> str:
        return v.strip().removesuffix("市")  # 能宽容的就宽容：'北京市' → '北京'


async def get_weather(city: str) -> dict:
    await asyncio.sleep(0.1)
    if city not in FAKE_WEATHER:
        # 业务错误：告诉模型"支持哪些"，它才能改对
        raise ToolError(f"没有 {city} 的天气数据", hint=f"只支持：{', '.join(FAKE_WEATHER)}")
    return {"city": city, **FAKE_WEATHER[city]}


class CalcArgs(BaseModel):
    expression: str = Field(max_length=100, description="只含数字和 + - * / ** ( ) 的算术表达式，如 (18-12)*3")


_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
        ast.Div: operator.truediv, ast.Pow: operator.pow, ast.USub: operator.neg}


def _eval(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
        left, right = _eval(node.left), _eval(node.right)
        if isinstance(node.op, ast.Pow) and (abs(right) > 100 or abs(left) > 10_000):
            raise ToolError("指数太大，拒绝计算", hint="底数绝对值 ≤ 10000、指数绝对值 ≤ 100")  # 防 9**9**9
        return _OPS[type(node.op)](left, right)
    if isinstance(node, ast.UnaryOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval(node.operand))
    raise ToolError("表达式里有不允许的内容", hint="只能用数字和 + - * / ** ( )")


async def calculator(expression: str) -> dict:
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError:
        raise ToolError(f"表达式语法错误：{expression!r}", hint="检查括号是否配对，例如 (18-12)*3")
    return {"expression": expression, "result": _eval(tree.body)}


class SlowArgs(BaseModel):
    query: str = Field(description="要查询的内容")


async def slow_search(query: str) -> dict:
    await asyncio.sleep(10)  # 模拟一个卡住的下游接口
    return {"query": query, "items": []}


# ---------- 2. 统一的错误类型和执行器（类比 @ControllerAdvice 全局异常处理） ----------
class ToolError(Exception):
    """可预期的业务错误：带一句给模型看的修改建议"""
    def __init__(self, message: str, hint: str = ""):
        super().__init__(message)
        self.hint = hint


REGISTRY = {
    "get_weather": (WeatherArgs, get_weather, "查询城市当前天气和气温。", 2.0),
    "calculator": (CalcArgs, calculator, "精确计算算术表达式，任何算数都用它。", 1.0),
    "slow_search": (SlowArgs, slow_search, "搜索网页（可能很慢）。", 1.0),
}  # 每项：(参数模型, 函数, 说明, 超时秒数)

TOOLS = [{"type": "function",
          "function": {"name": n, "description": d, "parameters": m.model_json_schema()}}
         for n, (m, _, d, _) in REGISTRY.items()]


def err(kind: str, message: str, hint: str = "", retryable: bool = True) -> str:
    return json.dumps({"ok": False, "error_type": kind, "message": message,
                       "hint": hint, "retryable": retryable}, ensure_ascii=False)


async def run_tool(name: str, arguments: str) -> str:
    """无论发生什么都返回字符串，绝不把异常抛给 Agent 循环"""
    if name not in REGISTRY:
        return err("unknown_tool", f"没有叫 {name} 的工具", hint=f"可用工具：{', '.join(REGISTRY)}")
    args_model, func, _, timeout = REGISTRY[name]
    try:
        args = args_model.model_validate_json(arguments or "{}")       # ① JSON 解析 + 参数校验
    except ValidationError as e:
        problems = "; ".join(f"{'.'.join(map(str, x['loc'])) or '参数'}: {x['msg']}" for x in e.errors())
        return err("invalid_arguments", problems, hint="按 tools 里的 JSON Schema 重新传参")
    try:
        result = await asyncio.wait_for(func(**args.model_dump()), timeout)  # ② 超时
        return json.dumps({"ok": True, "data": result}, ensure_ascii=False)
    except ToolError as e:                                              # ③ 业务错误：可改正
        return err("tool_error", str(e), hint=e.hint)
    except asyncio.TimeoutError:                                        # ④ 超时：别再试了
        return err("timeout", f"{name} 超过 {timeout}s 没响应", hint="换别的办法或直接告诉用户", retryable=False)
    except Exception as e:                                              # ⑤ 兜底：程序 bug
        return err("internal_error", f"{type(e).__name__}: {e}", retryable=False)


# ---------- 3. 模型 ----------
def _call(cid, name, args):
    raw = args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)
    return {"id": cid, "type": "function", "function": {"name": name, "arguments": raw}}


async def fake_llm(messages, tools):
    """剧本：先犯 3 种错，看到错误信息后逐个改正，最后作答"""
    await asyncio.sleep(0.05)
    done = {m["tool_call_id"]: json.loads(m["content"]) for m in messages if m["role"] == "tool"}
    if not done:  # 第 1 轮：参数 JSON 坏了 + 城市不支持 + 工具名写错
        return {"role": "assistant", "content": None, "tool_calls": [
            _call("c1", "get_weather", '{"city": "北京"'),          # 少了 }
            _call("c2", "get_weather", {"city": "广州"}),
            _call("c3", "get_wether", {"city": "上海"}),
        ]}
    if "c4" not in done:  # 第 2 轮：根据 hint 改正
        return {"role": "assistant", "content": None, "tool_calls": [
            _call("c4", "get_weather", {"city": "北京市"}),
            _call("c5", "get_weather", {"city": "上海"}),
            _call("c6", "calculator", {"expression": "9**9**9"}),  # 又犯一个错
        ]}
    if "c7" not in done:
        bj, sh = done["c4"]["data"]["temp_c"], done["c5"]["data"]["temp_c"]
        return {"role": "assistant", "content": None,
                "tool_calls": [_call("c7", "calculator", {"expression": f"{sh}-{bj}"})]}
    return {"role": "assistant", "content":
            f"广州暂时查不到。上海 {done['c5']['data']['temp_c']}°C，北京 {done['c4']['data']['temp_c']}°C，"
            f"上海高 {done['c7']['data']['result']}°C。"}


async def stubborn_llm(messages, tools):
    """反面角色：不管返回什么，永远重复同一个调用"""
    return {"role": "assistant", "content": None,
            "tool_calls": [_call(f"s{len(messages)}", "slow_search", {"query": "广州天气"})]}


async def real_llm(messages, tools):
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


# ---------- 4. Agent 循环：最大轮数 + 重复调用检测 ----------
MAX_ROUNDS = 5
MAX_SAME_CALL = 2  # 同一个工具 + 同样参数最多执行 2 次


async def ask(question: str, llm) -> str:
    messages = [
        {"role": "system", "content": "你是助手。天气和计算必须调用工具。工具返回 ok=false 时，"
                                      "读 hint 改正参数再试；retryable=false 就别再试，直接如实告诉用户。"},
        {"role": "user", "content": question},
    ]
    seen: dict[tuple, int] = {}
    print(f"用户：{question}")
    for round_no in range(1, MAX_ROUNDS + 1):
        reply = await llm(messages, TOOLS)
        if not reply.get("tool_calls"):
            return reply["content"]
        messages.append(reply)
        print(f"\n第 {round_no} 轮：")

        async def handle(c):
            key = (c["function"]["name"], c["function"]["arguments"])
            seen[key] = seen.get(key, 0) + 1
            if seen[key] > MAX_SAME_CALL:
                return err("repeated_call", "同样的调用已经执行过，结果不会变", retryable=False)
            return await run_tool(*key)

        results = await asyncio.gather(*(handle(c) for c in reply["tool_calls"]))
        for c, result in zip(reply["tool_calls"], results):
            print(f"  → {c['function']['name']}({c['function']['arguments']})")
            print(f"  ← {result}")
            messages.append({"role": "tool", "tool_call_id": c["id"], "content": result})
    return f"⚠️ 超过 {MAX_ROUNDS} 轮还没得出答案，强制停止（真实项目里这里要打告警日志）。"


async def main():
    llm = real_llm if os.getenv("LLM_API_KEY") else fake_llm
    print("使用", "真模型" if llm is real_llm else "假模型（没填 Key）", "\n")
    answer = await ask("北京、上海、广州现在多少度？北京和上海差几度？", llm)
    print("\n最终回答：", answer)

    print("\n===== 反面教材：一直重复调用的模型 =====")
    print("\n最终回答：", await ask("广州天气怎么样？", stubborn_llm))


if __name__ == "__main__":
    asyncio.run(main())
```

**看点**：

1. `run_tool()` 里 ①~⑤ 五个出口，每个都返回 JSON 字符串。Agent 循环里**没有一个 `try`**，因为异常在工具这一层就被消化掉了。
2. 第 1 轮三个错误各不相同，但模型拿到的都是同一种格式，第 2 轮就全改对了。`北京市` 被 `field_validator` 自动修成 `北京`，连一次重试都省了。
3. `9**9**9` 如果真算，会卡死很久还吃光内存。我们在 `_eval` 里限制了底数和指数的大小，这就是昨天思考题 2 的答案。
4. 反面教材里：第 1~2 轮是超时（1 秒），第 3 轮起触发"重复调用"直接返回、不再真的执行，第 5 轮到上限强制停止。真模型一般看到 `retryable: false` 就会停手，但你不能指望它，循环必须自己兜底。

## 3. 本地运行

```bash
cd agent-lab
uv add openai python-dotenv pydantic     # 装过就跳过
uv run day12_robust_tools.py
```

用真 Key 跑时，真模型不会像假模型那样故意犯错。想观察自我纠正，可以把 `FAKE_WEATHER` 改成只有 `"北京"`，再问"上海多少度"，看它拿到 `hint` 之后怎么回答你。

## 今日练习

- [ ] 用真 Key 跑一遍，把 `FAKE_WEATHER` 删到只剩北京，问"上海多少度"，把模型的回答贴给老师
- [ ] 把 `get_weather` 里的 `hint=...` 删掉、只留 `"没有数据"`，对比真模型的回答有什么变化（看它会不会编一个温度出来）
- [ ] 给 `WeatherArgs` 加一个参数 `unit: Literal["C", "F"] = "C"`，让假模型传 `"K"`，看 pydantic 返回的错误信息长什么样
- [ ] 进阶：给 `run_tool` 加"可重试错误自动重试 1 次"：超时以外的网络错误（自己模拟一个随机抛 `ConnectionError` 的工具）先在本地重试，还失败再告诉模型
- [ ] 补交第 2~11 天的练习（哪怕只交一个也行）

起步模板（随机失败的工具）：

```python
import random

async def flaky_api(query: str) -> dict:
    if random.random() < 0.5:
        raise ConnectionError("下游接口抖了一下")
    return {"query": query, "answer": "ok"}

# 在 run_tool 的 ⑤ 之前加一个 except ConnectionError，重试 1 次后再返回 err(...)
```

## 🤔 思考题

1. 错误信息里该不该带完整的 Python 堆栈？（提示：想想 token 成本、泄露内部信息，以及模型到底需要什么）
2. 重复调用检测用的是"工具名 + 参数字符串"。如果模型把 `{"city":"北京"}` 写成 `{ "city": "北京" }`（多了空格），还能识别出是同一个调用吗？怎么改？
3. 如果工具是"转账"这种**有副作用**的操作，超时后能不能自动重试？（Java 里你会怎么做幂等？）
