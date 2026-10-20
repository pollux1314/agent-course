> 🎯 **今日目标**：申请 API Key，用 openai SDK 调通 DeepSeek（或通义），搞懂 messages 的三种角色。
>
> ⏱ 预计 1~1.5 小时 ｜ 📦 产出：脚本问模型一个问题并打印回答

## 1. 原理：调大模型 = 发一个 HTTP POST

调大模型本质上就是发一个 HTTP POST 请求，和你用 RestTemplate 调第三方接口没区别。DeepSeek、通义、Kimi 等国内厂商基本都**兼容 OpenAI 接口格式**，所以用同一个 `openai` SDK 就能调，换厂商只改 `base_url` 和模型名。

> ☕ **Java 类比**：像 JDBC——接口统一，换数据库只换驱动和连接地址。

请求里最核心的是 `messages` 列表，每条消息都有一个 `role`：

| role | 作用 | 类比 |
|---|---|---|
| `system` | 设定人设和规则，模型会一直遵守 | 一份全局配置 |
| `user` | 用户说的话 | 请求参数 |
| `assistant` | 模型之前的回答；下次请求带上，模型才"记得"聊过什么 | 你自己存的会话历史 |

**最关键的一点：模型是无状态的**，就像无状态的 REST 服务，服务端不会帮你存 Session。所谓"多轮记忆"，其实是你每次都把完整的对话历史重新发一遍（第 6 天会用到）。

返回结果里记住两处：

- `choices[0].message.content`：模型的回答
- `usage`：这次用了多少 token，计费按它算

## 2. 准备工作

1. 到 [DeepSeek 开放平台](https://platform.deepseek.com/) 注册，充几块钱，创建 API Key（通义千问或 OpenAI 也行）。
2. 本地项目里：

```bash
uv add openai python-dotenv
echo ".env" >> .gitignore
```

3. 项目根目录建 `.env`：

```bash
LLM_API_KEY=sk-你的key
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
```

用通义千问：`LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1`，`LLM_MODEL=qwen-plus`。

> 📱 **想在手机上直接运行？** 打开右上角 **⚙️ 设置**，填入 API Key（只保存在你这台手机的浏览器里，不会上传到任何服务器，只会直接发给你填的模型服务商）。DeepSeek 和通义的接口都允许浏览器直接调用，下面的代码就能在本页运行。在公共设备上别保存 Key。

## 3. 代码：`day04_first_llm.py`

浏览器里没法传命令行参数，想换问题就直接改 `__main__` 里的默认问题。

```python run
# /// script
# requires-python = ">=3.11"
# dependencies = ["openai>=1.40", "python-dotenv>=1.0"]
# ///
"""第 4 天：第一次调用大模型（Java 对照版）。运行：uv run day04_first_llm.py "你的问题" """
from __future__ import annotations

import os
import sys
import time

from dotenv import load_dotenv
from openai import APIConnectionError, APIStatusError, AuthenticationError, OpenAI

# ---------- 1. 读配置 ≈ Spring 的 application.yml + @Value("${...}") ----------
load_dotenv()  # 把当前目录 .env 里的 KEY=VALUE 加载进环境变量
API_KEY = os.getenv("LLM_API_KEY")
BASE_URL = os.getenv("LLM_BASE_URL", "https://api.deepseek.com")  # 换厂商只改这里
MODEL = os.getenv("LLM_MODEL", "deepseek-chat")

if not API_KEY:
    sys.exit("没找到 LLM_API_KEY：请在同目录建 .env，写入 LLM_API_KEY=sk-xxx（别提交到 Git）")

# ---------- 2. 客户端 ≈ 一个配置好 baseUrl 和 Authorization 头的 RestTemplate ----------
client = OpenAI(api_key=API_KEY, base_url=BASE_URL, timeout=30)


def ask(question: str) -> str:
    # messages 就是“整段对话记录”，每条都是 {role, content}
    messages = [
        {"role": "system", "content": "你是一位资深 Java 架构师，回答简洁，不超过 150 字。"},
        {"role": "user", "content": question},
    ]
    start = time.perf_counter()
    resp = client.chat.completions.create(model=MODEL, messages=messages)
    cost_ms = (time.perf_counter() - start) * 1000

    answer = resp.choices[0].message.content          # 模型回复，role 是 "assistant"
    u = resp.usage                                     # 计费依据：输入/输出 token 数
    print(f"[模型 {resp.model} | 耗时 {cost_ms:.0f} ms | "
          f"输入 {u.prompt_tokens} + 输出 {u.completion_tokens} = {u.total_tokens} tokens | "
          f"结束原因 {resp.choices[0].finish_reason}]")
    return answer


if __name__ == "__main__":
    q = " ".join(sys.argv[1:]) or "用一句话解释 Spring 的 IoC 是什么"
    try:
        print(ask(q))
    except AuthenticationError:
        sys.exit("401：API Key 不对或已失效，检查 .env")
    except APIConnectionError as e:
        sys.exit(f"连不上 {BASE_URL}：{e}")
    except APIStatusError as e:                        # 429 限流、402 余额不足等
        sys.exit(f"HTTP {e.status_code}：{e.message}")
```

本地运行：

```bash
uv run day04_first_llm.py "Java 的 synchronized 和 ReentrantLock 有什么区别"
```

正常会先打印一行耗时和 token 数，然后是回答。Key 填错会提示 401，余额不足一般是 HTTP 402。

## 4. 今日练习（30~45 分钟）

- [ ] 把 system prompt 改成"你是一个只用三句话回答、每句都带一个比喻的老师"，问同一个问题，对比回答和 token 数的变化
- [ ] 手动造两轮对话：messages 里依次放 system、user（"我叫 Jiawei，是 Java 程序员"）、assistant（随便写一句回应）、user（"我叫什么？做什么的？"），看模型能不能答对
- [ ] 再去掉中间两条试一次，体会"记忆就是你自己发过去的历史"
- [ ] 思考题写下答案（见下方）

练习 2 的模板：

```python run
import os

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()
client = OpenAI(api_key=os.getenv("LLM_API_KEY"),
                base_url=os.getenv("LLM_BASE_URL", "https://api.deepseek.com"), timeout=30)

messages = [
    {"role": "system", "content": "你是一个友好的助手，回答简短。"},
    {"role": "user", "content": "我叫 Jiawei，是 Java 程序员"},
    {"role": "assistant", "content": "你好 Jiawei！很高兴认识一位 Java 程序员。"},
    {"role": "user", "content": "我叫什么？做什么的？"},
]
# TODO: 试试把中间两条注释掉再运行
resp = client.chat.completions.create(model=os.getenv("LLM_MODEL", "deepseek-chat"), messages=messages)
print(resp.choices[0].message.content)
print(resp.usage)
```

## 🤔 思考题

如果一次对话聊了 50 轮，每一轮的 token 数和费用会怎么变？为什么？（提示：结合"模型无状态、每次都发完整历史"想一想。）
