> 🎯 **今日目标**：周复盘。把前 6 天的知识串成一张图，用一个综合小例子把它们拼起来，再用"找 Bug"检验自己是不是真的掌握了。没交的练习今天补上。
>
> ⏱ 预计 1~1.5 小时 ｜ 📦 产出：补完第 2~6 天练习 + 修好今天的找 Bug 题 + 一页笔记

## 1. 一周知识地图（Java 对照）

| 天 | 学了什么 | Java 里的对应物 | 一句话记住 |
|---|---|---|---|
| 1 | uv、pyproject.toml、.env | Maven、pom.xml、application.yml | `uv run main.py` 就是 `mvn exec:java` |
| 2 | 类型注解、dataclass、推导式、with、装饰器 | Lombok `@Data`、Stream、try-with-resources、AOP | Python 是"注解不强制"的 Java |
| 3 | asyncio、httpx、pydantic | CompletableFuture、WebClient、Bean Validation | async 里别用阻塞调用，否则全卡住 |
| 4 | messages 三角色、OpenAI 兼容 SDK | 调一个无状态 REST 接口 | system 定规矩，user 提问，assistant 是回答 |
| 5 | temperature、max_tokens、token、成本 | 按调用量计费的云服务 | 费用 = 输入 token + 输出 token，各有单价 |
| 6 | stream=True、多轮记忆、裁剪历史 | SseEmitter / Flux、客户端维护 Session | 模型不存状态，"记忆"是你每次把历史整个发过去 |

**本周思考题答案**：为什么模型"记得"上文？因为它根本不记得。服务端是无状态的，每次请求你都把整个 `messages` 列表重新发过去，模型在这一次请求里"读到"了前文而已。所以聊得越久，每次请求越贵、越慢，最后会超过上下文窗口。这件事是后面所有"上下文管理"和"记忆"技术的出发点。

## 2. 综合小例子：ChatSession（不需要 Key）

把一周的东西装进一个类：pydantic 校验消息、dataclass 管会话、tiktoken 算 token 和钱、async 流式输出、多轮记忆。

只有一个新东西：**按 token 预算裁剪历史**。第 6 天是"只留最近 N 轮"，但每轮长短差很多，按条数裁不精确。真实项目按 token 裁：从最新一条往前加，超过预算就停，system 永远保留。

```python run
"""第 7 天 · 不需要 Key：把一周所学串成一个 ChatSession
用到：dataclass(第2天) + pydantic(第3天) + messages 三角色(第4天)
     + tiktoken 计费(第5天) + async 流式 & 多轮记忆(第6天)
新东西：按 token 预算裁剪历史（比"只留 N 轮"更精确）"""
import asyncio
from dataclasses import dataclass, field
from typing import Literal

import tiktoken
from pydantic import BaseModel, ValidationError

ENC = tiktoken.get_encoding("cl100k_base")
PRICE_IN_PER_M = 2.0   # 输入单价：元 / 百万 token（示例值，按你用的模型改）


class Message(BaseModel):                       # ≈ 带 Bean Validation 的 DTO
    role: Literal["system", "user", "assistant"]
    content: str


def count_tokens(messages: list[Message]) -> int:
    # 每条消息约多 4 个 token 的格式开销，粗略估算够用
    return sum(len(ENC.encode(m.content)) + 4 for m in messages)


async def fake_llm(messages: list[Message]):
    """假模型：async 生成器，模拟 stream=True 的 chunk"""
    users = [m.content for m in messages if m.role == "user"]
    reply = f"（我收到 {len(messages)} 条消息，最早记得的一句：{users[0]}）"
    for i in range(0, len(reply), 4):
        await asyncio.sleep(0.03)
        yield reply[i:i + 4]


@dataclass                                     # ≈ Lombok @Data
class ChatSession:
    system: str
    budget: int = 120                          # 发出去的历史最多多少 token
    history: list[Message] = field(default_factory=list)

    def window(self) -> list[Message]:
        """system 永远保留；从最新往前加，超出预算就停（像 LRU 的反方向）"""
        sys_msg = Message(role="system", content=self.system)
        picked: list[Message] = []
        used = count_tokens([sys_msg])
        for m in reversed(self.history):
            cost = count_tokens([m])
            if used + cost > self.budget:
                break
            picked.insert(0, m)
            used += cost
        return [sys_msg] + picked

    async def ask(self, question: str) -> str:
        self.history.append(Message(role="user", content=question))
        sent = self.window()
        tokens = count_tokens(sent)
        print(f"你：{question}")
        print(f"   [发出 {len(sent)} 条 / {tokens} token ≈ ¥{tokens * PRICE_IN_PER_M / 1e6:.6f}]")
        print("助手：", end="", flush=True)
        parts = []
        async for chunk in fake_llm(sent):
            print(chunk, end="", flush=True)
            parts.append(chunk)
        print("\n")
        answer = "".join(parts)
        self.history.append(Message(role="assistant", content=answer))
        return answer


async def main() -> None:
    s = ChatSession(system="你是一个助手")
    for q in ["我叫 Jiawei", "我是 Java 程序员", "我在学 Agent 开发", "我叫什么？"]:
        await s.ask(q)
    print(f"本地完整历史 {len(s.history)} 条，但最后一次只发出去了窗口内的部分。")

    try:                                       # pydantic 帮你挡住非法角色
        Message(role="boss", content="hi")
    except ValidationError as e:
        print("\n非法消息被拦下：", e.errors()[0]["msg"])


if __name__ == "__main__":
    asyncio.run(main())
```

看第 4 轮：本地历史里还有"我叫 Jiawei"，但它超出了 120 token 的预算没被发出去，模型就"忘了"你的名字。把 `budget` 改成 300 再跑一次对比一下。

> 💡 真实项目里预算一般设成"上下文窗口 − 预留给回答的 max_tokens"，比如 64K 窗口留 4K 给回答，历史最多 60K。

## 3. 找 Bug：检验这一周

下面这段代码有 **3 个 bug**，全是前 6 天讲过的坑。直接运行会报错，改到最后打印 `✅ 全部修好了` 为止。先自己想，别急着看提示。

```python run
"""第 7 天 · 找 Bug：这段代码有 3 个 bug（都是前 6 天讲过的坑），改到最后打印 ✅ 为止"""
import asyncio
import time


async def fake_stream(messages: list[dict]):
    """模拟真实 API：最后一个 chunk 的 content 是 None"""
    n = sum(1 for m in messages if m["role"] == "user")
    for piece in ["收到", f"第 {n} 个", "问题", None]:
        time.sleep(0.2)                  # 模拟网络等待
        yield piece


async def chat(messages: list[dict], question: str) -> str:
    messages.append({"role": "user", "content": question})
    parts = []
    async for content in fake_stream(messages):
        parts.append(content)
    answer = "".join(parts)
    return answer


async def main() -> None:
    a, b = [], []
    start = time.perf_counter()
    # 两个用户同时聊天，应该并发执行
    r1, r2 = await asyncio.gather(chat(a, "你好"), chat(b, "在吗"))
    cost = time.perf_counter() - start
    await chat(a, "我刚才说了什么？")
    print(r1, r2, f"耗时 {cost:.2f}s", f"a 有 {len(a)} 条消息")
    assert cost < 1.2, "两个请求没有并发起来"
    assert len(a) == 4, "历史里少了东西"
    print("✅ 全部修好了")


if __name__ == "__main__":
    asyncio.run(main())
```

<details>
<summary>卡住了？点开看提示（不是答案）</summary>

1. 报错 `NoneType`：真实 API 最后一个 chunk 的 `content` 是什么？第 6 天强调过的写法。
2. 并发不起来：在 `async` 函数里，哪个调用会把整个事件循环卡住？第 3 天的坑。
3. 历史条数不对：多轮记忆要往 `messages` 里存几样东西？

</details>

## 4. 今日练习（补课为主）

先补欠的，按顺序来，做不完就把最重要的那几个做了：

- [ ] 第 2 天：用 Python 重写一个你熟悉的 Java 小工具类（用上 dataclass 和类型注解）
- [ ] 第 3 天：并发请求 3 个公开 API，用 pydantic 解析结果
- [ ] 第 4、5 天：本地 `uv run` 调通一次真模型，对比 temperature=0 和 1.2 的输出，记下 token 数和花费
- [ ] 第 6 天：本地跑通 `chat.py`，连续聊 5 轮
- [ ] 今天：修好上面的找 Bug 题，把改动的 3 行发给老师
- [ ] 今天：把 `ChatSession.window()` 改一下，保证窗口里的第一条非 system 消息一定是 `user`（不要以一条孤零零的 assistant 开头）
- [ ] 笔记：用自己的话写 5 句话，说清楚"一次多轮流式对话从输入到输出发生了什么"

做完把代码、运行输出或报错（Key 记得打码）发给老师批改。

## 🤔 思考题

1. 按 token 裁剪时，如果用户这一句本身就超过了预算，应该怎么办？直接报错、截断，还是别的？
2. 第 6 天思考题回顾：裁剪时 system 为什么要永远保留？（提示：它是"规矩"，丢了模型就不知道自己是谁、该守什么规则了。）
3. 下周开始学 Prompt、结构化输出和 function calling。你猜：模型"调用工具"时，真的是模型在执行你的代码吗？
