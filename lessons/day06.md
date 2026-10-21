> 🎯 **今日目标**：让回答像 ChatGPT 一样逐字蹦出来（流式输出），并且自己维护 messages 列表，做出能连续聊天、记得上文的 `chat.py`。
>
> ⏱ 预计 1~1.5 小时 ｜ 📦 产出：命令行里能连续聊天、逐字输出的 chat.py

## 1. 流式输出是什么（Java 对照）

不加 `stream=True` 时，模型要把整段回答全部生成完，才一次性返回，用户干等好几秒。加上之后，服务端用 **SSE（Server-Sent Events）** 一边生成一边推送，每次推一小段，叫一个 **chunk**。

| Python | Java 里的对应物 |
|---|---|
| `stream=True` 的返回值 | Spring 的 `SseEmitter` / WebFlux 的 `Flux<String>` |
| `async for chunk in stream:` | `flux.subscribe(chunk -> ...)`，或者 `BufferedReader` 一行行读 |
| `chunk.choices[0].delta.content` | 这一次推过来的**增量**文本，不是全文 |
| `print(x, end="", flush=True)` | `System.out.print(x); System.out.flush();` |

三个要点：

- 每个 chunk 里拿的是 `delta`（增量），不是 `message`。最后一个 chunk 的 `content` 往往是 `None`，要写成 `delta.content or ""`。
- 流式只是**传输方式**变了，token 数和费用不变。好处是**首字延迟**（第一个字出来的时间）大幅缩短，用户体验好很多。
- 边打印边把 chunk 拼起来，拼好的完整回答要存回历史，下一轮才用得上。

## 2. 多轮记忆：模型是无状态的

第 4 天说过：模型像一个**无状态的 REST 服务**，服务端不存 Session。所谓"记得上文"，就是你在客户端维护一个 `List<Message>`，每一轮都：

1. 把用户的新问题 `append` 进去
2. 把**整个列表**发给模型
3. 把模型的回答也 `append` 进去

所以聊得越久，每次发出去的 token 越多，费用越高（第 5 天估算题的答案就在这）。实际项目要**裁剪历史**：最简单的是只保留最近 N 轮，system 消息永远保留，类似一个固定容量的队列。

## 3. 先用"假模型"看清原理（不需要 Key）

下面的 `fake_llm` 是一个 **async 生成器**（`async def` 里用 `yield`），每次吐 3 个字，模拟 SSE 推送。它会告诉你它收到了几条消息，你可以直观看到"记忆"是怎么来的：

```python run
"""第 6 天 · 不需要 Key：用一个"假模型"理解流式输出和多轮记忆"""
import asyncio


async def fake_llm(messages: list[dict]):
    """假模型：async 生成器，一次吐一小段，模拟 stream=True 的 chunk"""
    users = [m["content"] for m in messages if m["role"] == "user"]
    reply = f"我一共收到 {len(messages)} 条消息，你说过的话：{'、'.join(users)}"
    for i in range(0, len(reply), 3):          # 每次吐 3 个字，像一个 chunk
        await asyncio.sleep(0.05)              # 模拟网络间隔
        yield reply[i:i + 3]


async def chat_once(messages: list[dict], question: str) -> None:
    messages.append({"role": "user", "content": question})
    print(f"你：{question}\n助手：", end="", flush=True)
    parts: list[str] = []
    async for chunk in fake_llm(messages):     # ≈ Flux.subscribe / 逐行读 SSE
        print(chunk, end="", flush=True)       # 边收边打印
        parts.append(chunk)                    # 同时拼起来
    print("\n")
    messages.append({"role": "assistant", "content": "".join(parts)})  # 回答也要存回历史


async def main() -> None:
    messages = [{"role": "system", "content": "你是一个助手"}]
    for q in ["我叫 Jiawei", "我是 Java 程序员", "我叫什么？"]:
        await chat_once(messages, q)
    print("最终 messages 条数：", len(messages))

    print("\n---- 对照：不保存历史，每次只发当前这一句 ----")
    for q in ["我叫 Jiawei", "我叫什么？"]:
        await chat_once([{"role": "system", "content": "你是一个助手"}], q)


if __name__ == "__main__":
    asyncio.run(main())
```

看对照部分：不保存历史时，模型只收到 2 条消息，自然不知道你叫什么。

## 4. 真模型：流式 + 多轮（需要 Key）

先在 ⚙️ 设置 里填好 Key。为了能在手机浏览器里逐字输出，这里用的是 **`AsyncOpenAI` + `async for`**。网页里不能用 `input()`，所以脚本自动问 3 轮，第 3 轮专门考它记不记得你：

```python run
# /// script
# requires-python = ">=3.11"
# dependencies = ["openai>=1.40", "python-dotenv>=1.0"]
# ///
"""第 6 天：真模型 + 流式输出 + 多轮记忆（脚本自动问 3 轮，网页和本地都能跑）"""
import asyncio
import os
import sys
import time

from dotenv import load_dotenv
from openai import APIConnectionError, APIStatusError, AsyncOpenAI, AuthenticationError

load_dotenv()
API_KEY = os.getenv("LLM_API_KEY")
BASE_URL = os.getenv("LLM_BASE_URL", "https://api.deepseek.com")
MODEL = os.getenv("LLM_MODEL", "deepseek-chat")

SYSTEM = "你是一位耐心的 Agent 开发老师，学生是 Java 后端程序员。每次回答不超过 80 字。"


async def ask_stream(client: AsyncOpenAI, messages: list[dict]) -> str:
    """发出整段历史，流式打印回答，返回完整回答文本"""
    start = time.perf_counter()
    first_ms = None
    parts: list[str] = []
    stream = await client.chat.completions.create(
        model=MODEL, messages=messages, stream=True, temperature=0.7, max_tokens=300
    )
    async for chunk in stream:                      # 每个 chunk 是一小段增量
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta.content or ""  # 注意：可能是 None
        if delta and first_ms is None:
            first_ms = (time.perf_counter() - start) * 1000
        print(delta, end="", flush=True)
        parts.append(delta)
    total_ms = (time.perf_counter() - start) * 1000
    print(f"\n   [首字 {first_ms or 0:.0f} ms | 总耗时 {total_ms:.0f} ms]\n")
    return "".join(parts)


async def main() -> None:
    if not API_KEY:
        sys.exit("没找到 LLM_API_KEY：本地写进 .env，网页里在 ⚙️ 设置 填 Key")
    client = AsyncOpenAI(api_key=API_KEY, base_url=BASE_URL, timeout=60)
    messages: list[dict] = [{"role": "system", "content": SYSTEM}]
    questions = [
        "我叫 Jiawei，是 Java 后端程序员。用一句话告诉我 Agent 是什么。",
        "和我平时写的 Spring 定时任务比，最大的区别是什么？",
        "我叫什么名字？我是做什么的？",           # 考验"记忆"
    ]
    try:
        for i, q in enumerate(questions, 1):
            messages.append({"role": "user", "content": q})
            print(f"第 {i} 轮（这次发出 {len(messages)} 条消息）\n你：{q}\n助手：", end="", flush=True)
            answer = await ask_stream(client, messages)
            messages.append({"role": "assistant", "content": answer})
    except AuthenticationError:
        sys.exit("401：API Key 不对或已失效")
    except APIConnectionError as e:
        sys.exit(f"连不上 {BASE_URL}：{e}")
    except APIStatusError as e:
        sys.exit(f"HTTP {e.status_code}：{e.message}")


if __name__ == "__main__":
    asyncio.run(main())
```

留意每轮打印的"首字"时间和"总耗时"：首字通常远小于总耗时，这就是流式的意义。

## 5. 本地产出：`chat.py`（真正的命令行聊天）

在电脑上的 `agent-lab` 里新建 `chat.py`，然后 `uv run chat.py`，就可以一直聊下去。这段要用 `input()`，所以只能在本地跑：

```python
# /// script
# requires-python = ">=3.11"
# dependencies = ["openai>=1.40", "python-dotenv>=1.0"]
# ///
"""第 6 天产出：命令行连续聊天 + 逐字输出。运行：uv run chat.py
命令：/history 看历史  /reset 清空  /exit 退出"""
import asyncio
import os
import sys

from dotenv import load_dotenv
from openai import APIConnectionError, APIStatusError, AsyncOpenAI, AuthenticationError

load_dotenv()
API_KEY = os.getenv("LLM_API_KEY")
BASE_URL = os.getenv("LLM_BASE_URL", "https://api.deepseek.com")
MODEL = os.getenv("LLM_MODEL", "deepseek-chat")
SYSTEM = {"role": "system", "content": "你是一位简洁的编程助手，学生是 Java 后端程序员。"}
MAX_TURNS = 10  # 只保留最近 10 轮（20 条消息），防止历史无限变长


def trim(messages: list[dict]) -> list[dict]:
    """system 永远保留，其余只留最近 MAX_TURNS 轮"""
    return [messages[0]] + messages[1:][-MAX_TURNS * 2:]


async def ask_stream(client: AsyncOpenAI, messages: list[dict]) -> str:
    parts: list[str] = []
    stream = await client.chat.completions.create(model=MODEL, messages=messages, stream=True)
    async for chunk in stream:
        if chunk.choices and (delta := chunk.choices[0].delta.content):
            print(delta, end="", flush=True)
            parts.append(delta)
    print()
    return "".join(parts)


async def main() -> None:
    if not API_KEY:
        sys.exit("没找到 LLM_API_KEY，请先配置 .env")
    client = AsyncOpenAI(api_key=API_KEY, base_url=BASE_URL, timeout=60)
    messages = [SYSTEM]
    print(f"已连接 {MODEL}，输入 /exit 退出")
    while True:
        try:
            q = (await asyncio.to_thread(input, "\n你：")).strip()  # input 会阻塞，丢到线程里
        except (EOFError, KeyboardInterrupt):
            break
        if not q:
            continue
        if q == "/exit":
            break
        if q == "/reset":
            messages = [SYSTEM]
            print("（历史已清空）")
            continue
        if q == "/history":
            for m in messages:
                print(f"  [{m['role']}] {m['content'][:50]}")
            continue
        messages.append({"role": "user", "content": q})
        print("助手：", end="", flush=True)
        try:
            answer = await ask_stream(client, trim(messages))
        except AuthenticationError:
            sys.exit("401：API Key 不对或已失效")
        except (APIConnectionError, APIStatusError) as e:
            print(f"\n（请求失败：{e}，这句不计入历史，可以重试）")
            messages.pop()
            continue
        messages.append({"role": "assistant", "content": answer})
    print("再见！")


if __name__ == "__main__":
    asyncio.run(main())
```

几个细节：

- `input()` 是阻塞调用，在 async 程序里用 `asyncio.to_thread` 丢到线程里执行，避免卡住事件循环（第 3 天讲的坑）。
- 请求失败时把刚加进去的用户消息 `pop()` 掉，历史就不会留下一句没有回答的问题。
- `trim()` 只裁剪**发出去**的内容，完整历史仍然留在本地，`/history` 能看到。

## 6. 今日练习（30~45 分钟）

- [ ] 本地跑通 `chat.py`，连续聊 5 轮以上，中间问一句"我刚才第一句问了什么"，确认它记得
- [ ] 加一个 `/tokens` 命令：用第 5 天的 tiktoken 估算当前历史一共多少 token，并按你的单价算出"下一次请求至少要花多少钱"
- [ ] 把 `MAX_TURNS` 改成 2，聊 4 轮后再问第一句的内容，观察它"失忆"，用一句话解释原因
- [ ] 加分项：把同步版 `OpenAI` + `stream=True` 也写一遍（`for chunk in stream:`），和 async 版对比写法

做完把代码和运行输出（Key 记得打码）发给老师批改。

## 🤔 思考题

1. 裁剪历史时，为什么 system 消息要永远保留？如果直接删掉最早的消息，会出什么问题？
2. 流式输出时用户中途按 Ctrl+C，已经生成的那半段要不要算进历史？费用怎么算？
3. 只保留最近 N 轮会丢掉早期的重要信息（比如用户的名字）。你能想到什么更聪明的办法？（第 3 阶段讲"长期记忆"时会正式学）
