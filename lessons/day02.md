> 🎯 **今日目标**：把 Java 习惯"翻译"成 Python。下面 6 样东西后面写 Agent 时天天都会用到。
>
> ⏱ 预计 1.5~2 小时 ｜ 📦 产出：用 Python 重写一个你熟悉的 Java 小工具类

## 1. 类型注解和 dataclass ≈ record / Lombok `@Data`

- `amount: float` 这种注解**运行时不会强制检查**，是给 IDE 和 mypy（Python 的静态类型检查工具）用的。
- `@dataclass` 自动生成构造函数、`__repr__`（toString）和 `__eq__`（equals）。
- `@dataclass(frozen=True)` 是不可变的，相当于 `record`。
- **坑**：列表这种可变的默认值必须写成 `field(default_factory=list)`。

```python run
from dataclasses import dataclass, field


@dataclass
class Order:
    order_id: str
    amount: float
    status: str = "NEW"
    tags: list[str] = field(default_factory=list)

    @property
    def is_big(self) -> bool:     # ≈ getter，调用时不加括号：o.is_big
        return self.amount >= 1000


@dataclass(frozen=True)
class Money:
    value: int
    currency: str = "CNY"


o = Order("A002", 1200.0, tags=["vip"])
print(o)                           # 自动 toString
print(o.is_big)
print(Money(100) == Money(100))    # 自动 equals → True

m = Money(1)
try:
    m.value = 2                    # frozen：不可修改
except Exception as e:
    print("不可变：", type(e).__name__)
```

## 2. 推导式 ≈ Stream API

| Python | Java Stream |
|---|---|
| `[o.id for o in orders if o.is_big]` | `orders.stream().filter(...).map(...).toList()` |
| `{o.id: o.amount for o in orders}` | `Collectors.toMap(...)` |
| `{o.status for o in orders}` | `Collectors.toSet()` |
| `sum(o.amount for o in orders)` | `mapToDouble(...).sum()` |

```python run
nums = [3, 8, 1, 12, 7, 20]
evens_squared = [n * n for n in nums if n % 2 == 0]
index = {n: str(n) * 2 for n in nums}
print(evens_squared)
print(index)
print(sum(n for n in nums if n > 5))   # 生成器表达式：不建中间列表，≈ 惰性 Stream
```

## 3. with 上下文管理器 ≈ try-with-resources

最简单的写法是 `@contextmanager` 加 `yield`：`yield` 之前负责"打开"，之后负责"关闭"；with 块里抛出的异常会在 `yield` 那一行冒出来，所以可以在那里回滚。

```python run
from contextlib import contextmanager


@contextmanager
def transaction(name: str):
    print(f"[tx] BEGIN {name}")
    try:
        yield                      # with 块里的代码在这里执行
        print(f"[tx] COMMIT {name}")
    except Exception:
        print(f"[tx] ROLLBACK {name}")
        raise


with transaction("ok"):
    print("  做点事")

try:
    with transaction("boom"):
        raise ValueError("出错了")
except ValueError as e:
    print("外层捕获：", e)
```

## 4. 装饰器 ≈ Spring AOP 的 `@Around`

装饰器就是**一个接收函数、返回包装后新函数的函数**。`@timed` 写在函数上，等价于 `main = timed(main)`。

- 带参数的装饰器（如 `@retry(times=3)`）要**再多包一层**。
- 记得加 `@functools.wraps(func)`，保留原函数名和文档。
- 后面 LangChain 的 `@tool` 就是用装饰器注册工具的。

```python run
import functools
import time


def timed(func):
    @functools.wraps(func)
    def wrapper(*args, **kwargs):           # *args ≈ 可变参数，**kwargs ≈ 命名参数 Map
        start = time.perf_counter()
        try:
            return func(*args, **kwargs)
        finally:
            print(f"[timed] {func.__name__} 耗时 {(time.perf_counter() - start) * 1000:.2f} ms")
    return wrapper


def retry(times: int = 3):                  # 第一层：接收装饰器参数
    def decorator(func):                    # 第二层：接收被装饰的函数
        @functools.wraps(func)
        def wrapper(*args, **kwargs):       # 第三层：真正执行
            for attempt in range(1, times + 1):
                try:
                    return func(*args, **kwargs)
                except ValueError as e:
                    print(f"[retry] 第 {attempt} 次失败：{e}")
                    if attempt == times:
                        raise
        return wrapper
    return decorator


calls = 0


@timed
@retry(times=3)
def flaky() -> str:
    global calls
    calls += 1
    if calls < 3:
        raise ValueError("网关超时")
    return "成功"


print(flaky())
```

## 5. 异常

- `except` ≈ `catch`；`finally` 一样。
- `else` 是 Java 没有的：**只在没出异常时执行**。
- Python **没有受检异常**，不用写 `throws`。
- 自定义异常：`class OrderError(Exception)` ≈ `extends RuntimeException`。

## 6. 模块和包

- 一个 `.py` 文件就是一个**模块**，一个目录就是一个**包**，不用写 `package` 声明。
- `from utils.strings import slugify` ≈ `import com.xxx.utils.Strings`。
- `if __name__ == "__main__":` ≈ `main` 方法，只有直接运行这个文件时才执行，被 import 时不执行。

## 7. 完整示例：把上面全部串起来

对照输出看看：重试了几次？事务什么时候提交、什么时候回滚？

```python run
"""第 2 天：Python 关键语法（Java 对照版）。运行：uv run day02_basics.py"""
from __future__ import annotations

import functools
import time
from contextlib import contextmanager
from dataclasses import dataclass, field


# 1. 类型注解 + dataclass  ≈ Java record / Lombok @Data
@dataclass
class Order:
    order_id: str
    amount: float
    status: str = "NEW"                                # 默认值
    tags: list[str] = field(default_factory=list)      # 可变默认值必须这样写

    @property
    def is_big(self) -> bool:                          # ≈ getter
        return self.amount >= 1000


@dataclass(frozen=True)                                # ≈ 不可变 record
class Money:
    value: int
    currency: str = "CNY"


# 2. 自定义异常  ≈ class OrderException extends RuntimeException
class OrderError(Exception):
    def __init__(self, order_id: str, reason: str) -> None:
        super().__init__(f"订单 {order_id} 异常：{reason}")
        self.order_id = order_id


# 3. 装饰器  ≈ Spring AOP 的 @Around
def timed(func):
    @functools.wraps(func)                             # 保留原函数名和文档
    def wrapper(*args, **kwargs):
        start = time.perf_counter()
        try:
            return func(*args, **kwargs)
        finally:
            cost = (time.perf_counter() - start) * 1000
            print(f"[timed] {func.__name__} 耗时 {cost:.2f} ms")
    return wrapper


def retry(times: int = 3):                             # 带参数的装饰器 = 再包一层
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            for attempt in range(1, times + 1):
                try:
                    return func(*args, **kwargs)
                except OrderError as e:
                    print(f"[retry] 第 {attempt} 次失败：{e}")
                    if attempt == times:
                        raise
        return wrapper
    return decorator


# 4. 上下文管理器  ≈ try-with-resources + AutoCloseable
@contextmanager
def transaction(name: str):
    print(f"[tx] BEGIN {name}")
    try:
        yield                                          # with 块里的代码在这里执行
        print(f"[tx] COMMIT {name}")
    except Exception:
        print(f"[tx] ROLLBACK {name}")
        raise


_calls = {"n": 0}


@retry(times=3)
def pay(order: Order) -> str:
    _calls["n"] += 1
    if _calls["n"] < 3:                                # 前两次故意失败
        raise OrderError(order.order_id, "支付网关超时")
    order.status = "PAID"
    return f"{order.order_id} 支付成功"


@timed
def main() -> None:
    orders = [
        Order("A001", 99.5),
        Order("A002", 1200.0, tags=["vip"]),
        Order("A003", 3500.0),
        Order("A004", 15.0, status="CANCELLED"),
    ]
    print(orders[1])                                   # dataclass 自带 toString

    # 5. 推导式  ≈ Stream API
    big_ids = [o.order_id for o in orders if o.is_big]                   # filter + map + toList
    amount_by_id = {o.order_id: o.amount for o in orders}                # Collectors.toMap
    total = sum(o.amount for o in orders if o.status != "CANCELLED")     # mapToDouble().sum()
    print("大额订单：", big_ids)
    print("金额表：", amount_by_id)
    print(f"有效总额：{total:.2f}")

    print(Money(100) == Money(100))                    # True，自动 equals

    # 6. 异常处理 + with
    with transaction("pay-A002"):
        print(pay(orders[1]))

    try:
        with transaction("refund-A004"):
            raise OrderError("A004", "已取消订单不能退款")
    except OrderError as e:                            # ≈ catch (OrderError e)
        print("捕获到：", e, "| order_id =", e.order_id)
    else:
        print("没有异常时才执行")
    finally:
        print("finally 一定执行")


if __name__ == "__main__":                             # ≈ public static void main
    main()
```

预期输出（最后一行耗时会不一样）：

```text
Order(order_id='A002', amount=1200.0, status='NEW', tags=['vip'])
大额订单： ['A002', 'A003']
金额表： {'A001': 99.5, 'A002': 1200.0, 'A003': 3500.0, 'A004': 15.0}
有效总额：4799.50
True
[tx] BEGIN pay-A002
[retry] 第 1 次失败：订单 A002 异常：支付网关超时
[retry] 第 2 次失败：订单 A002 异常：支付网关超时
A002 支付成功
[tx] COMMIT pay-A002
[tx] BEGIN refund-A004
[tx] ROLLBACK refund-A004
捕获到： 订单 A004 异常：已取消订单不能退款 | order_id = A004
finally 一定执行
[timed] main 耗时 0.07 ms
```

## 8. 今日练习（约 40 分钟）

挑一个你用 Java 写过的小工具类（字符串工具、日期工具，或者一个简单的 LRU 缓存），用 Python 重写：

- [ ] 至少用一个 `@dataclass`，所有函数都写类型注解
- [ ] 至少用两次推导式代替 for 循环
- [ ] 自己写一个装饰器，比如打印入参和返回值的 `@log_args`
- [ ] 用 `with` 管理一个资源（读写文件或者自己写一个计时器）
- [ ] 定义一个自定义异常，并在调用处处理掉
- [ ] 本地拆成两个文件：`utils/xxx.py` 放实现，`main.py` 用 import 调用

可以先在这里写（浏览器里只有单文件，拆文件的部分在本地做）：

```python run
from dataclasses import dataclass
import functools


def log_args(func):
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        # TODO: 打印入参，调用 func，打印返回值
        return func(*args, **kwargs)
    return wrapper


@dataclass
class LRUCache:
    capacity: int
    # TODO: 用 dict 实现（Python 3.7+ 的 dict 保持插入顺序）


@log_args
def demo() -> None:
    print("开始写你的工具类吧")


demo()
```

## 🤔 思考题

把 `field(default_factory=list)` 改成 `= []` 会发生什么？先在下面试试（提示：Python 会直接报错，想想它为什么要拦住你；再想想普通函数 `def f(x=[])` 为什么是个经典坑）：

```python run
from dataclasses import dataclass

# 经典坑：函数默认值只在定义时创建一次，所有调用共享同一个列表
def f(x=[]):
    x.append(1)
    return x

print(f(), f(), f())

# dataclass 直接拦住了这种写法
try:
    @dataclass
    class Bad:
        tags: list[str] = []
except ValueError as e:
    print("dataclass 报错：", e)
```
