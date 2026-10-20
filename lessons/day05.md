> 🎯 **今日目标**：搞懂 temperature / top_p / max_tokens，理解 token 和计费，会估算一次调用和一个月的成本。
>
> ⏱ 预计 1~1.5 小时 ｜ 📦 产出：一张记录不同参数下输出差异和花费的小表格

## 1. token 是什么

模型读写文字的单位不是"字"，而是 **token**——分词器切出来的小片段。可以把它理解成模型世界里的"字节"：计费、上下文长度上限、`max_tokens` 都按 token 算。

- 常见英文单词通常 1 个 token
- 一个中文字约 1~2 个 token
- 代码里的驼峰命名会被拆开：`ReentrantLock` → `Re` / `entrant` / `Lock`

下面这段不需要 API Key，直接运行看看（tiktoken 在本 App 里可以直接用）：

```python run
import tiktoken

enc = tiktoken.get_encoding("cl100k_base")   # OpenAI 的分词器，对别家模型只是近似
for s in ["Hello world", "你好，世界", "public static void main(String[] args)", "ReentrantLock"]:
    ids = enc.encode(s)
    print(f"{s!r:45} -> {len(ids):2} tokens {[enc.decode([i]) for i in ids]}")
```

注意"世"字被拆成两个 token，每一半单独解码都不是完整的 UTF-8 字符，所以显示成 `�`——**token 是按字节切的，不是按字切的**。

## 2. 三个采样参数

模型每生成一个 token，都是先给所有候选词打分，再从中"抽签"。下面三个参数控制怎么抽：

| 参数 | 作用 | 什么时候用 |
|---|---|---|
| `temperature`（0~2） | 随机程度。0 几乎每次都选最高分的词 | 0：抽取信息、写 SQL、调用工具；0.7：均衡；1.5+：发散，也更容易胡说 |
| `top_p` | 只在累计概率排前 p 的候选词里抽，0.9 = 砍掉最不可能的 10% | 和 temperature 作用重叠，**一般只调其中一个** |
| `max_tokens` | 输出长度上限，控制成本、防止失控 | 超了会被截断，`finish_reason` 变成 `length` 而不是 `stop` |

> ☕ **Java 类比**：生产代码里一定要检查 `finish_reason`，就像检查 HTTP 状态码一样——`length` 意味着结果不完整。

## 3. 计费

**费用 = 输入 token × 输入单价 + 输出 token × 输出单价**，单价按"元 / 百万 token"计，通常输出比输入贵。

- 准确的 token 数以返回结果里的 `usage` 为准
- tiktoken 数 DeepSeek / 通义的 token 只是近似值，主要用来**发请求之前**做预估（比如判断会不会超上下文长度）

到你所用厂商官网的价格页（比如 [DeepSeek 开放平台](https://platform.deepseek.com/)）查当前单价，填进本地 `.env`（或本 App 的 ⚙️ 设置）：

```bash
PRICE_IN_PER_M=填输入单价
PRICE_OUT_PER_M=填输出单价
```

## 4. 代码：`day05_params.py`

本地：`uv add tiktoken` 后 `uv run day05_params.py`。在本页运行时，第一段 token 演示不需要 Key；第二段要先在 ⚙️ 设置 里填 Key 才会调模型（三种温度各跑 3 次，共 10 次请求，花费很少）。

```python run
# /// script
# requires-python = ">=3.11"
# dependencies = ["openai>=1.40", "python-dotenv>=1.0", "tiktoken>=0.7"]
# ///
"""第 5 天：参数与计费。运行：uv run day05_params.py "你的问题" """
import os
import sys
import time

import tiktoken
from dotenv import load_dotenv
from openai import APIConnectionError, APIStatusError, AuthenticationError, OpenAI

load_dotenv()
API_KEY = os.getenv("LLM_API_KEY")
BASE_URL = os.getenv("LLM_BASE_URL", "https://api.deepseek.com")
MODEL = os.getenv("LLM_MODEL", "deepseek-chat")
# 单价：元 / 百万 token。去厂商官网“价格”页查当前价格填进 .env，这里不写死
PRICE_IN = float(os.getenv("PRICE_IN_PER_M", "0"))
PRICE_OUT = float(os.getenv("PRICE_OUT_PER_M", "0"))

ENC = tiktoken.get_encoding("cl100k_base")  # OpenAI 的分词器，对别家模型只是近似


def count_tokens(text: str) -> int:
    return len(ENC.encode(text))


def cost(prompt_tokens: int, completion_tokens: int) -> float:
    return (prompt_tokens * PRICE_IN + completion_tokens * PRICE_OUT) / 1_000_000


def demo_tokens() -> None:
    """不需要 API Key：先直观感受一下 token 是什么"""
    for s in ["Hello world", "你好，世界", "public static void main(String[] args)", "ReentrantLock"]:
        ids = ENC.encode(s)
        pieces = [ENC.decode([i]) for i in ids]
        print(f"{s!r:45} -> {len(ids):2} tokens {pieces}")
    print()


def run(client: OpenAI, question: str, temperature: float, max_tokens: int) -> None:
    messages = [
        {"role": "system", "content": "你是一个有创意的文案，回答一句话。"},
        {"role": "user", "content": question},
    ]
    est = sum(count_tokens(m["content"]) for m in messages)
    start = time.perf_counter()
    resp = client.chat.completions.create(
        model=MODEL, messages=messages, temperature=temperature, max_tokens=max_tokens
    )
    ms = (time.perf_counter() - start) * 1000
    u = resp.usage
    c = resp.choices[0]
    print(f"| T={temperature:<3} | 预估输入≈{est:3} | 实际 {u.prompt_tokens:3}+{u.completion_tokens:3} "
          f"| ¥{cost(u.prompt_tokens, u.completion_tokens):.6f} | {ms:5.0f}ms | {c.finish_reason:6} "
          f"| {c.message.content.strip()[:60]!r}")


if __name__ == "__main__":
    demo_tokens()
    if not API_KEY:
        sys.exit("没找到 LLM_API_KEY：上面的 token 演示不需要 Key；要调模型请先配好 .env")
    client = OpenAI(api_key=API_KEY, base_url=BASE_URL, timeout=30)
    q = " ".join(sys.argv[1:]) or "给一家只卖咖啡的程序员主题小店起个名字"
    try:
        for t in (0.0, 0.7, 1.5):
            for _ in range(3):  # 同一个温度跑 3 次，看输出稳不稳定
                run(client, q, temperature=t, max_tokens=60)
        print("\n--- max_tokens=5，看看会发生什么 ---")
        run(client, q, temperature=0.7, max_tokens=5)
    except AuthenticationError:
        sys.exit("401：API Key 不对或已失效，检查 .env")
    except APIConnectionError as e:
        sys.exit(f"连不上 {BASE_URL}：{e}")
    except APIStatusError as e:
        sys.exit(f"HTTP {e.status_code}：{e.message}")
```

最后一次把 `max_tokens` 设成 5，你应该会看到 `finish_reason` 变成 `length`，回答被截在半截。

## 5. 今日练习（30~45 分钟）

- [ ] 把第二段输出整理成表：温度、3 次回答是否一样、平均输出 token 数、平均花费，用一两句话总结温度的影响
- [ ] 把 `temperature` 固定为 1.0，改调 `top_p`，分别试 0.1 和 0.95，比较它和调温度的异同
- [ ] 完成下面的估算题

成本估算小工具（改数字就行）：

```python run
PRICE_IN_PER_M = 2.0    # 示例数字（元 / 百万 token），改成你查到的单价
PRICE_OUT_PER_M = 8.0

req_per_day = 10_000
in_tokens, out_tokens = 2000, 300

per_req = (in_tokens * PRICE_IN_PER_M + out_tokens * PRICE_OUT_PER_M) / 1_000_000
print(f"单次 ¥{per_req:.5f}，每天 ¥{per_req * req_per_day:.2f}，每月 ¥{per_req * req_per_day * 30:.2f}")

# 多轮对话：每一轮都要把历史全部带上
history = 0
for turn in range(1, 11):
    prompt = 2000 + history
    history += 300 + 200          # 上一轮的回答 + 用户新问题，粗略估计
    if turn in (1, 5, 10):
        print(f"第 {turn:2} 轮输入 ≈ {prompt} tokens")
```

## 🤔 估算题

假设做一个客服 Agent，每次请求输入 2000 token、输出 300 token，每天 1 万次，按你查到的单价，一个月大概花多少钱？如果把多轮对话历史全带上，输入会从 2000 涨到多少？（这和第 4 天的思考题是连着的。）
