> 🎯 **今日目标**：彻底搞懂 function calling 的一次完整往返：怎么用 JSON Schema 描述函数、模型返回的 `tool_calls` 长什么样、谁来执行函数、结果怎么以 `tool` 角色发回去。
>
> ⏱ 预计 1~1.5 小时 ｜ 📦 产出：画出往返流程图 + 一个能跑通的"查天气"（假数据）完整例子

## 1. 原理：模型不会执行函数，它只会"写调用单"（Java 对照）

最容易误解的一点：**模型从来不执行你的函数**。它只是在回复里说"请帮我调用 `get_weather`，参数是 `{"city": "上海"}`"，真正去执行的是**你的代码**，执行完再把结果告诉它。就像前端调后端接口：前端（模型）只负责发请求，后端（你）负责干活、回结果。

| function calling 里的东西 | Java 里的类比 | 说明 |
|---|---|---|
| `tools=[...]` 参数 | 接口的 OpenAPI / Swagger 文档 | 告诉模型有哪些函数、每个参数什么类型、什么时候该用 |
| `parameters`（JSON Schema） | 方法签名 + Bean Validation 注解 | 可以直接用 pydantic 的 `model_json_schema()` 生成（复用第 9 天） |
| 模型返回 `tool_calls` | 一条 RPC 请求：方法名 + JSON 参数 | `arguments` 是**JSON 字符串**，可能不合法，要校验 |
| `REGISTRY` 字典：名字 → 函数 | Spring 按 bean 名找 Bean / 策略模式 Map | 模型给的名字可能不存在，要兜底 |
| `{"role": "tool", "tool_call_id": ..., "content": ...}` | RPC 响应，带 requestId 对应请求 | `tool_call_id` 必须和请求的 `id` 对上 |
| 第 2 次调用模型 | 拿到数据后渲染页面 | 模型看到工具结果，组织成自然语言回答 |

完整往返流程（这就是今天要画的图）：

```text
 你的代码                                   大模型
 ─────────                                  ──────
 messages = [system, user("上海要带伞吗")]
 + tools = [get_weather 的说明书]  ────①──▶  读问题 + 说明书，决定要查天气
                                   ◀──②────  assistant: content=None,
                                              tool_calls=[{id:"call_001",
                                                name:"get_weather",
                                                arguments:'{"city":"上海"}'}]
 ③ 把这条 assistant 消息原样追加到 messages
 ④ 校验 arguments → 执行 get_weather("上海")
 ⑤ 追加 {role:"tool", tool_call_id:"call_001",
         content:'{"condition":"小雨",...}'}
 再次发送完整 messages + tools  ────⑥──▶   看到工具结果
                                   ◀──⑦────  assistant: "上海小雨 18°C，记得带伞"
```

几个要点：

- **第 ③ 步不能省**：带 `tool_calls` 的 assistant 消息必须放回 messages，否则后面的 `tool` 消息"没有对应的请求"，API 会直接报 400。这和第 6 天说的一样：模型没有记忆，每次都要把完整历史发过去。
- **`tool` 消息的 content 只能是字符串**：dict 要先 `json.dumps(..., ensure_ascii=False)`。
- **执行出错不要抛异常**，而是把错误写成 `{"error": "..."}` 返回给模型，它通常会自己换个参数重试或者如实告诉用户（第 12 天细讲）。
- **`description` 写得好不好，决定模型会不会选对工具**：就像接口文档，要写清"什么时候用"。
- 模型也可能**不调用工具**直接回答（比如你问"你好"），所以代码要先判断有没有 `tool_calls`。

## 2. 可运行示例：查天气的完整往返

没填 Key 时用假模型，它会严格按真实协议返回 `tool_calls`，你能看清 ①~④ 每一步。在 ⚙️ 设置里填上 `LLM_API_KEY` 再运行就是真模型（DeepSeek / 通义都支持 tools）。

```python run
"""第 10 天 · Function calling 原理：查天气（假数据）的完整往返
没有 Key 也能跑（假模型照真实协议返回 tool_calls）；填了 LLM_API_KEY 就调用真模型。
往返流程：用户提问 → 模型返回 tool_calls → 我们执行函数 → 以 tool 角色发回结果 → 模型给最终回答"""
import asyncio
import json
import os

from dotenv import load_dotenv
from pydantic import BaseModel, Field, ValidationError

load_dotenv()


# ---------- 1. 真正的函数（类比 Java 里的 Service 方法），用假数据 ----------
FAKE_WEATHER = {
    "北京": {"condition": "晴", "temp_c": 12, "humidity": 30},
    "上海": {"condition": "小雨", "temp_c": 18, "humidity": 85},
    "深圳": {"condition": "多云", "temp_c": 26, "humidity": 70},
}


class WeatherArgs(BaseModel):
    """参数用 pydantic 定义：既能生成 JSON Schema 给模型看，又能校验模型给的参数（复用第 9 天）"""
    city: str = Field(description="城市中文名，如 北京、上海")
    unit: str = Field(default="celsius", pattern="^(celsius|fahrenheit)$", description="温度单位")


def get_weather(city: str, unit: str = "celsius") -> dict:
    data = FAKE_WEATHER.get(city)
    if data is None:
        return {"error": f"没有 {city} 的天气数据，支持：{', '.join(FAKE_WEATHER)}"}
    temp = data["temp_c"] if unit == "celsius" else round(data["temp_c"] * 9 / 5 + 32, 1)
    return {"city": city, "condition": data["condition"], "temp": temp,
            "unit": unit, "humidity": data["humidity"]}


# ---------- 2. tools 参数：用 JSON Schema 把函数"说明书"交给模型（类比 OpenAPI 文档） ----------
TOOLS = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "查询某个城市当前的天气。用户问天气、穿衣、要不要带伞时调用。",
        "parameters": WeatherArgs.model_json_schema(),
    },
}]

# 函数名 → (参数模型, 实现)：类比 Spring 里按 bean 名字找 Bean
REGISTRY = {"get_weather": (WeatherArgs, get_weather)}


def run_tool(name: str, arguments: str) -> str:
    """执行一次工具调用。返回值一定是字符串（tool 消息的 content 只能是文本）"""
    if name not in REGISTRY:
        return json.dumps({"error": f"未知工具 {name}"}, ensure_ascii=False)
    args_model, func = REGISTRY[name]
    try:
        args = args_model.model_validate_json(arguments)  # arguments 是 JSON 字符串，不可信
    except ValidationError as e:
        return json.dumps({"error": f"参数不合法：{e.errors()[0]['msg']}"}, ensure_ascii=False)
    return json.dumps(func(**args.model_dump()), ensure_ascii=False)


# ---------- 3. 模型：统一返回 dict 形式的 assistant 消息 ----------
async def fake_llm(messages: list[dict], tools: list[dict]) -> dict:
    """按真实协议模拟：还没拿到工具结果时返回 tool_calls；拿到了就组织最终回答"""
    await asyncio.sleep(0.05)
    tool_results = [m for m in messages if m["role"] == "tool"]
    if not tool_results:
        return {"role": "assistant", "content": None, "tool_calls": [{
            "id": "call_001", "type": "function",
            "function": {"name": "get_weather",
                         "arguments": json.dumps({"city": "上海"}, ensure_ascii=False)},
        }]}
    w = json.loads(tool_results[-1]["content"])
    tip = "记得带伞" if "雨" in w["condition"] else "不用带伞"
    return {"role": "assistant",
            "content": f"上海现在{w['condition']}，{w['temp']}°C，湿度 {w['humidity']}%，出门{tip}。"}


async def real_llm(messages: list[dict], tools: list[dict]) -> dict:
    from openai import AsyncOpenAI
    client = AsyncOpenAI(api_key=os.environ["LLM_API_KEY"],
                         base_url=os.getenv("LLM_BASE_URL", "https://api.deepseek.com"))
    resp = await client.chat.completions.create(
        model=os.getenv("LLM_MODEL", "deepseek-chat"),
        messages=messages, tools=tools, temperature=0,
    )
    msg = resp.choices[0].message
    out = {"role": "assistant", "content": msg.content}
    if msg.tool_calls:  # SDK 对象 → 普通 dict，方便打印和放回 messages
        out["tool_calls"] = [{"id": c.id, "type": "function",
                              "function": {"name": c.function.name, "arguments": c.function.arguments}}
                             for c in msg.tool_calls]
    return out


# ---------- 4. 一次完整往返 ----------
async def ask(question: str, llm) -> str:
    messages = [
        {"role": "system", "content": "你是出行助手。涉及天气必须调用工具查询，不要编造。"},
        {"role": "user", "content": question},
    ]
    print(f"① 用户：{question}")

    reply = await llm(messages, TOOLS)                      # 第 1 次调用：带上 tools
    if not reply.get("tool_calls"):                         # 模型觉得不需要工具，直接回答
        return reply["content"]
    messages.append(reply)                                  # ⚠️ 带 tool_calls 的 assistant 消息必须放回去
    for call in reply["tool_calls"]:
        name, arguments = call["function"]["name"], call["function"]["arguments"]
        print(f"② 模型要求调用：{name}({arguments})   id={call['id']}")
        result = run_tool(name, arguments)                  # 真正执行函数的是"我们"，不是模型
        print(f"③ 执行结果：{result}")
        messages.append({"role": "tool", "tool_call_id": call["id"], "content": result})

    final = await llm(messages, TOOLS)                      # 第 2 次调用：模型看到结果后作答
    print("④ 最终回答：", end="")
    return final["content"]


async def main():
    llm = real_llm if os.getenv("LLM_API_KEY") else fake_llm
    print("使用", "真模型" if llm is real_llm else "假模型（没填 Key）", "\n")
    print(await ask("我等下要去上海出差，要带伞吗？", llm))

    print("\n--- 直接测一下 run_tool 的容错 ---")
    print(run_tool("get_weather", '{"city": "杭州"}'))
    print(run_tool("get_weather", '{"city": "北京", "unit": "kelvin"}'))
    print(run_tool("get_stock", "{}"))


if __name__ == "__main__":
    asyncio.run(main())
```

**看点**：

1. `TOOLS` 里的 `parameters` 是 `WeatherArgs.model_json_schema()` 生成的，你改了参数模型，"接口文档"自动跟着变。
2. `run_tool()` 是整个例子最"后端"的部分：查注册表 → 校验参数 → 执行 → 序列化结果，每一步失败都返回错误 JSON 而不是抛异常。
3. `ask()` 里一共调用了**两次**模型：第 1 次拿到调用单，第 2 次拿到最终回答。这就是 Agent 循环的雏形，第 2 阶段我们会把它改成 `while` 循环，直到模型不再要工具为止。
4. 最下面三行故意传了不存在的城市、非法单位、不存在的工具，看看容错输出。

## 3. 本地运行

```bash
cd agent-lab
uv add openai python-dotenv pydantic     # 装过就跳过
# .env 里有 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL
uv run day10_function_calling.py
```

用真 Key 跑时，把 `②` 那行打印的 `arguments` 仔细看一下：模型自己把"上海出差"理解成了 `{"city": "上海"}`。**把你的真实输出贴给老师**。

## 今日练习

- [ ] 用真 Key 跑一遍；再把问题改成"你好，介绍一下你自己"，确认模型这次**不调用**工具、直接回答
- [ ] 把问题改成"杭州今天冷吗？"（假数据里没有杭州），观察模型拿到 `{"error": ...}` 后怎么回答
- [ ] 在纸上或任意画图工具里画出今天的往返流程图（①~⑦），拍照发给老师
- [ ] 进阶：在 `ask()` 里把每次发给模型的 `messages` 用 `json.dumps(messages, ensure_ascii=False, indent=2)` 打印出来，数一数第 2 次调用时一共有几条消息、分别是什么角色
- [ ] 补交第 2~9 天的练习（哪怕只交一个也行）

起步模板（打印 messages）：

```python
import json

def dump(messages):
    print(json.dumps(messages, ensure_ascii=False, indent=2))

# 在 ask() 里第 2 次调用 llm 之前加一行：
# dump(messages)
```

## 🤔 思考题

1. 如果第 ③ 步忘了把 assistant 消息放回 messages，会发生什么？（提示：试试看，真模型会返回什么错误？）
2. 明天学多工具：如果用户问"北京和上海哪个更暖和？"，模型一次会返回几个 `tool_calls`？今天的代码哪里已经支持了这种情况？
