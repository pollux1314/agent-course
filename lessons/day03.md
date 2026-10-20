> 🎯 **今日目标**：掌握 asyncio、httpx 异步请求和 pydantic。同时调模型和工具要靠 async，接收和校验模型返回的 JSON 要靠 pydantic。
>
> ⏱ 预计 1.5~2 小时 ｜ 📦 产出：并发请求 3 个公开 API，用 pydantic 解析结果

## 1. asyncio：用 CompletableFuture 来理解

| Python | Java |
|---|---|
| `async def f()` | 返回 `CompletableFuture` 的方法 |
| 调用 `f()` | 拿到一个**还没开始跑**的任务（协程对象） |
| `await x` | 等 x 的结果，但**不阻塞线程**——把控制权交还事件循环 |
| `asyncio.gather(a, b, c)` | `CompletableFuture.allOf(...)`，并按传入顺序拿回结果 |
| `asyncio.run(main())` | 启动事件循环的入口 |
| `async with` | 异步版 try-with-resources |

**和 Java 最大的区别**：Java 靠线程池里的多个线程并发；asyncio 是**单线程 + 事件循环**，适合 IO 密集场景——而调大模型 API 恰好是典型的 IO 密集任务（一次请求等好几秒）。

> ⚠️ **最大的坑**：async 函数里绝对不能用 `time.sleep()`、`requests.get()` 这类阻塞调用，否则会卡住整个事件循环。要用 `asyncio.sleep()`，HTTP 请求用 `httpx.AsyncClient`。

先跑一个最小例子，体会串行和并发的耗时差别：

```python run
import asyncio
import time


async def fake_io(name: str, seconds: float) -> str:
    await asyncio.sleep(seconds)          # 模拟慢 IO
    return f"{name} 完成"


async def main() -> None:
    t = time.perf_counter()
    for n in ("A", "B", "C"):
        await fake_io(n, 1)               # 一个一个等：约 3 秒
    print(f"串行耗时 {time.perf_counter() - t:.2f}s")

    t = time.perf_counter()
    results = await asyncio.gather(fake_io("A", 1), fake_io("B", 1), fake_io("C", 1))
    print(f"并发耗时 {time.perf_counter() - t:.2f}s -> {results}")


asyncio.run(main())
```

## 2. pydantic：DTO + Bean Validation

| pydantic | Java |
|---|---|
| 继承 `BaseModel` 声明字段 | 加了 `@Valid` 的 DTO |
| `Field(alias="catchPhrase")` | `@JsonProperty("catchPhrase")` |
| `Field(min_length=1)` | `@NotBlank` / `@Size(min=1)` |
| `@field_validator` | 自定义 `ConstraintValidator` |
| `Model.model_validate(dict)` | `objectMapper.readValue` + 校验，失败抛 `ValidationError` 并列出所有出错字段 |
| `model_dump_json()` | `objectMapper.writeValueAsString` |

```python run
from pydantic import BaseModel, Field, ValidationError


class Post(BaseModel):
    id: int
    user_id: int = Field(alias="userId")
    title: str = Field(min_length=1)


print(Post.model_validate({"id": "1", "userId": 7, "title": "hello"}))   # "1" 会被转成 1

try:
    Post.model_validate({"id": "abc", "userId": 7, "title": ""})
except ValidationError as e:
    for err in e.errors():
        print("字段", err["loc"], "→", err["msg"])
```

## 3. 完整示例

这段代码在浏览器里可以原样运行（httpx 在本 App 的 Python 环境里会走浏览器的 fetch）。正常情况下：串行约 3 秒、并发约 1 秒；然后打印用户 Leanne Graham、10 篇帖子、20 条待办（11 条已完成）；校验失败那段列出 3 个字段错误；最后一段一个成功、一个 `HTTPStatusError`。

```python run
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27", "pydantic>=2.7"]
# ///
"""第 3 天：asyncio + httpx + pydantic（Java 对照版）。运行：uv run day03_async.py"""
from __future__ import annotations

import asyncio
import time

import httpx
from pydantic import BaseModel, Field, ValidationError, field_validator


# ---------- 1. pydantic 模型 ≈ DTO + Bean Validation ----------
class Company(BaseModel):
    name: str
    catch_phrase: str = Field(alias="catchPhrase")     # ≈ @JsonProperty("catchPhrase")


class User(BaseModel):
    id: int
    name: str
    email: str
    company: Company                                    # 嵌套对象自动解析

    @field_validator("email")                           # ≈ 自定义 @Email 校验器
    @classmethod
    def must_have_at(cls, v: str) -> str:
        if "@" not in v:
            raise ValueError("邮箱格式不对")
        return v.lower()


class Post(BaseModel):
    id: int
    user_id: int = Field(alias="userId")
    title: str = Field(min_length=1)                    # ≈ @NotBlank


class Todo(BaseModel):
    id: int
    title: str
    completed: bool


BASE = "https://jsonplaceholder.typicode.com"


# ---------- 2. async 函数 ≈ 返回 CompletableFuture 的方法 ----------
async def fetch_json(client: httpx.AsyncClient, path: str) -> dict | list:
    resp = await client.get(f"{BASE}{path}")            # await ≈ future.join()，但不阻塞线程
    resp.raise_for_status()                             # 4xx/5xx 抛 httpx.HTTPStatusError
    return resp.json()


async def fake_io(name: str, seconds: float) -> str:
    await asyncio.sleep(seconds)                        # 模拟一次慢 IO（不能用 time.sleep！）
    return f"{name} 完成"


async def demo_sequential_vs_gather() -> None:
    print("== 串行 vs 并发 ==")
    t = time.perf_counter()
    for n in ("A", "B", "C"):
        await fake_io(n, 1)                             # 一个一个等：约 3 秒
    print(f"串行耗时 {time.perf_counter() - t:.2f}s")

    t = time.perf_counter()
    results = await asyncio.gather(                     # ≈ CompletableFuture.allOf(...)
        fake_io("A", 1), fake_io("B", 1), fake_io("C", 1)
    )
    print(f"并发耗时 {time.perf_counter() - t:.2f}s -> {results}")


async def demo_real_api() -> None:
    print("\n== 并发请求 3 个接口 + pydantic 解析 ==")
    # async with ≈ try-with-resources，结束时自动关闭连接池
    async with httpx.AsyncClient(timeout=10) as client:
        t = time.perf_counter()
        user_raw, posts_raw, todos_raw = await asyncio.gather(
            fetch_json(client, "/users/1"),
            fetch_json(client, "/posts?userId=1"),
            fetch_json(client, "/todos?userId=1"),
        )
        print(f"3 个请求并发完成，耗时 {time.perf_counter() - t:.2f}s")

    user = User.model_validate(user_raw)                # ≈ objectMapper.readValue + @Valid
    posts = [Post.model_validate(p) for p in posts_raw]
    todos = [Todo.model_validate(x) for x in todos_raw]
    done = sum(x.completed for x in todos)

    print(f"用户：{user.name} <{user.email}>，公司：{user.company.name}")
    print(f"帖子 {len(posts)} 篇，第一篇：{posts[0].title[:30]}...")
    print(f"待办 {len(todos)} 条，已完成 {done} 条")
    print("转回 JSON：", user.model_dump_json(by_alias=True)[:80], "...")


def demo_validation_error() -> None:
    print("\n== 校验失败长什么样 ==")
    bad = {"id": "不是数字", "name": "Tom", "email": "no-at-sign",
           "company": {"name": "X"}}                    # 少了 catchPhrase
    try:
        User.model_validate(bad)
    except ValidationError as e:                        # ≈ MethodArgumentNotValidException
        for err in e.errors():
            print(f"  字段 {err['loc']}: {err['msg']}")


async def demo_error_isolation() -> None:
    print("\n== 某个请求失败时不拖垮其它请求 ==")
    async with httpx.AsyncClient(timeout=10) as client:
        results = await asyncio.gather(
            fetch_json(client, "/users/2"),
            fetch_json(client, "/users/99999"),          # 404
            return_exceptions=True,                      # 异常作为结果返回，而不是直接抛出
        )
    for r in results:
        if isinstance(r, Exception):
            print("  失败：", type(r).__name__)
        else:
            print("  成功：", r["name"])


async def main() -> None:
    await demo_sequential_vs_gather()
    await demo_real_api()
    demo_validation_error()
    await demo_error_isolation()


if __name__ == "__main__":
    asyncio.run(main())                                 # 启动事件循环 ≈ 入口
```

本地运行：`uv add httpx pydantic` 后 `uv run day03_async.py`。

## 4. 值得停下来想一想

1. 把 `fake_io` 里的 `asyncio.sleep` 换成 `time.sleep`，并发耗时变成多少？为什么？（建议在本地 uv 里试，浏览器环境的 `time.sleep` 行为和本地不完全一样。）
2. 去掉 `return_exceptions=True` 会怎样？和 `allOf` 里有一个 future 异常结束是不是很像？
3. pydantic 默认会把字符串 `"1"` 转成整数 1，但 `"不是数字"` 就转不了。对比一下 Jackson 的默认行为。

## 5. 今日练习（30~60 分钟）：`github_stats.py`

- [ ] 用 pydantic 定义 `Repo` 模型：`full_name`、`stargazers_count`、`forks_count`、`language`（可能为空，`str | None`）、`pushed_at`（`datetime`，让 pydantic 自动解析）
- [ ] 用 `httpx.AsyncClient` + `asyncio.gather` 同时请求 `python/cpython`、`langchain-ai/langgraph`、`spring-projects/spring-boot` 三个仓库
- [ ] 按 star 数从高到低打印成一个小表格
- [ ] 加分：加一个故意写错的仓库名，用 `return_exceptions=True` 保证它不影响其它结果
- [ ] 加分：用 `asyncio.Semaphore(2)` 限制最多同时 2 个请求

起步模板：

```python run
from __future__ import annotations

import asyncio
from datetime import datetime

import httpx
from pydantic import BaseModel

REPOS = ["python/cpython", "langchain-ai/langgraph", "spring-projects/spring-boot"]


class Repo(BaseModel):
    full_name: str
    stargazers_count: int
    # TODO: forks_count / language / pushed_at


async def fetch_repo(client: httpx.AsyncClient, name: str) -> Repo:
    resp = await client.get(f"https://api.github.com/repos/{name}")
    resp.raise_for_status()
    return Repo.model_validate(resp.json())


async def main() -> None:
    async with httpx.AsyncClient(timeout=10) as client:
        repos = await asyncio.gather(*(fetch_repo(client, n) for n in REPOS))
    for r in sorted(repos, key=lambda r: r.stargazers_count, reverse=True):
        print(f"{r.full_name:35} ⭐ {r.stargazers_count:>7}")


asyncio.run(main())
```
