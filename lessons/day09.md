> 🎯 **今日目标**：让模型**稳定**输出能被程序直接使用的 JSON：用 pydantic 定义 schema、用 JSON mode 保证格式、校验失败时把错误发回给模型让它自己改。
>
> ⏱ 预计 1~1.5 小时 ｜ 📦 产出：从一段简历文本里抽取姓名、技能、年限，输出通过校验的合法 JSON

## 1. 原理：模型输出 = 不可信的外部请求体（Java 对照）

到目前为止模型回给你的都是"给人看的文字"。但 Agent 要拿模型的输出去**调程序**（存库、调接口、选工具），这时它就和前端传来的请求体一样：**格式可能不对，内容可能缺字段，永远不能直接信**。

| 结构化输出的做法 | Java 里的类比 | 保证到什么程度 |
|---|---|---|
| prompt 里写"只输出 JSON" | 接口文档里写"请传 JSON" | 靠自觉，经常带解释文字或 ``` |
| JSON mode：`response_format={"type": "json_object"}` | 网关只放行 `Content-Type: application/json` | 保证是**合法 JSON**，不保证字段对 |
| structured output：`{"type": "json_schema", ...}` | 网关按 OpenAPI schema 校验 | 保证符合 schema（OpenAI 等支持，DeepSeek 目前只有 JSON mode） |
| pydantic `model_validate_json` | `ObjectMapper.readValue` + `@Valid` Bean Validation | **你自己这一层的最终防线**，什么模型都适用 |
| 校验失败 → 把错误发回去重试 | 返回 400 + 错误详情，让调用方改了再发 | 大多数错误 1 次重试就能修好 |

几个要点：

- **pydantic 一份定义三处用**：`Resume.model_json_schema()` 生成 JSON Schema 塞进 prompt（告诉模型要什么）；`model_validate_json()` 校验（检查它给了什么）；校验通过后拿到的是带类型的 Python 对象（像 Java 反序列化后的 DTO），后面代码不用再 `dict["xxx"]` 猜字段。
- **JSON mode 有个坑**：DeepSeek / OpenAI 要求 prompt 里必须出现 "json" 这个词，否则会报错；`max_tokens` 太小 JSON 会被截断成不合法的。
- **重试的关键是把错误原因发回去**：只说"错了重来"，模型可能犯同样的错；把 pydantic 的报错（哪个字段、什么问题）原样给它，像给新同事看编译报错。
- **一定要设最大重试次数**（今天是 3 次），这和第 12 天"防止死循环"是一个思路。
- 抽取任务用 `temperature=0`：要稳定，不要创意。

## 2. 可运行示例：抽取 → 校验 → 失败重试

没填 Key 时用假模型演示：它第 1 次故意犯两个常见错误（年限写成 `"8年"`、技能写成字符串列表），你会看到 pydantic 报错 → 错误发回 → 第 2 次改对。在 ⚙️ 设置里填上 `LLM_API_KEY` 再运行就是真模型（会开启 JSON mode）。

```python run
"""第 9 天 · 结构化输出：从简历文本里抽取 姓名 / 技能 / 年限，输出合法 JSON
没有 Key 也能跑（假模型故意先犯错，演示"校验失败 → 把错误发回去 → 重试"）；
填了 LLM_API_KEY 就调用真模型（DeepSeek / 通义都支持 JSON mode）。"""
import asyncio
import json
import os
import re

from dotenv import load_dotenv
from pydantic import BaseModel, Field, ValidationError, field_validator

load_dotenv()


# ---------- 1. 用 pydantic 定义 schema（类比 Java 的 DTO + Bean Validation） ----------
class Skill(BaseModel):
    name: str = Field(description="技能名，如 Java、Spring Boot")
    years: float | None = Field(default=None, ge=0, le=50, description="该技能使用年限，不知道就填 null")


class Resume(BaseModel):
    name: str = Field(min_length=1, description="姓名")
    total_years: float = Field(ge=0, le=50, description="总工作年限")
    skills: list[Skill] = Field(min_length=1, description="技能列表")
    email: str | None = Field(default=None, description="邮箱，没有就填 null")

    @field_validator("email")
    @classmethod
    def check_email(cls, v: str | None) -> str | None:
        if v is not None and "@" not in v:
            raise ValueError("邮箱格式不对")
        return v


# 把 schema 直接塞进 prompt：模型照着这个 JSON Schema 输出
SCHEMA_JSON = json.dumps(Resume.model_json_schema(), ensure_ascii=False)

SYSTEM = f"""你是简历信息抽取器。只输出一个 JSON 对象，不要解释，不要用 ``` 包裹。
JSON 必须符合下面的 JSON Schema（数字就写数字，不要写成 "5年" 这种字符串）：
<schema>
{SCHEMA_JSON}
</schema>"""

RESUME_TEXT = """
王小明，男，邮箱 xiaoming.wang@example.com。2018 年毕业后一直做后端，至今约 8 年工作经验。
精通 Java（8 年）和 Spring Boot（6 年），熟悉 MySQL、Redis，近一年开始用 Python 写脚本，
了解 Go。目前在一家电商公司负责订单系统。
"""


# ---------- 2. 解析 + 校验：先容错地拿到 JSON，再交给 pydantic ----------
def extract_json(text: str) -> str:
    """模型有时会包一层 ```json ... ```，先剥掉"""
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    return (m.group(1) if m else text).strip()


def parse(text: str) -> Resume:
    return Resume.model_validate_json(extract_json(text))


# ---------- 3. 模型：有 Key 用真的，没 Key 用假的 ----------
FAKE_ANSWERS = [
    # 第 1 次：故意犯两个常见错误——年限写成字符串、技能写成字符串列表
    '```json\n{"name": "王小明", "total_years": "8年", "skills": ["Java", "Spring Boot"]}\n```',
    # 第 2 次：看到错误信息后改对了
    '{"name": "王小明", "total_years": 8, "email": "xiaoming.wang@example.com", '
    '"skills": [{"name": "Java", "years": 8}, {"name": "Spring Boot", "years": 6}, '
    '{"name": "MySQL", "years": null}, {"name": "Redis", "years": null}, '
    '{"name": "Python", "years": 1}, {"name": "Go", "years": null}]}',
]


async def fake_llm(messages: list[dict]) -> str:
    await asyncio.sleep(0.05)
    tries = sum(1 for m in messages if m["role"] == "assistant")  # 已经回答过几次
    return FAKE_ANSWERS[min(tries, len(FAKE_ANSWERS) - 1)]


async def real_llm(messages: list[dict]) -> str:
    from openai import AsyncOpenAI
    client = AsyncOpenAI(api_key=os.environ["LLM_API_KEY"],
                         base_url=os.getenv("LLM_BASE_URL", "https://api.deepseek.com"))
    resp = await client.chat.completions.create(
        model=os.getenv("LLM_MODEL", "deepseek-chat"),
        messages=messages,
        temperature=0,
        response_format={"type": "json_object"},  # JSON mode：保证是合法 JSON（但不保证字段对）
        max_tokens=800,
    )
    return resp.choices[0].message.content or ""


# ---------- 4. 校验失败就把错误发回去，让模型自己改（最多 3 次） ----------
async def extract_resume(text: str, llm, max_retries: int = 3) -> Resume:
    messages = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": f"<resume>\n{text.strip()}\n</resume>"},
    ]
    for attempt in range(1, max_retries + 1):
        answer = await llm(messages)
        print(f"--- 第 {attempt} 次回答 ---\n{answer}")
        try:
            resume = parse(answer)
            print(f"✅ 校验通过（第 {attempt} 次）")
            return resume
        except (ValidationError, json.JSONDecodeError) as e:
            errors = e.errors() if isinstance(e, ValidationError) else [{"msg": str(e)}]
            brief = "; ".join(f"{'.'.join(map(str, err.get('loc', [])))}: {err['msg']}" for err in errors)
            print(f"❌ 校验失败：{brief}")
            # 关键：把模型的错误回答和错误原因都放回对话，让它"看着报错改代码"
            messages.append({"role": "assistant", "content": answer})
            messages.append({"role": "user", "content":
                             f"你的 JSON 没有通过校验：{brief}\n请修正后重新输出完整 JSON，只输出 JSON。"})
    raise RuntimeError(f"重试 {max_retries} 次仍然失败")


async def main():
    llm = real_llm if os.getenv("LLM_API_KEY") else fake_llm
    print("使用", "真模型 " + os.getenv("LLM_MODEL", "deepseek-chat") if llm is real_llm else "假模型（没填 Key）")
    resume = await extract_resume(RESUME_TEXT, llm)
    print("\n===== 拿到的是 Python 对象，不是字符串 =====")
    print("姓名:", resume.name, "| 总年限:", resume.total_years)
    for s in resume.skills:
        print(f"  - {s.name}: {s.years if s.years is not None else '未知'} 年")
    print("\n最终 JSON：")
    print(resume.model_dump_json(indent=2))


if __name__ == "__main__":
    asyncio.run(main())
```

**看点**：

1. `Resume` / `Skill` 就是 DTO：`Field(ge=0, le=50)` ≈ `@Min(0) @Max(50)`，`field_validator` ≈ 自定义 `ConstraintValidator`。
2. `SYSTEM` 里直接放了 `Resume.model_json_schema()` 生成的 JSON Schema，schema 改了 prompt 自动跟着变，不会"文档和代码不一致"。
3. `extract_resume()` 的循环：失败时把**模型的错误回答**（assistant）和**报错原因**（user）都追加到 messages，这就是第 6 天多轮对话的用法。
4. 最后拿到的 `resume.skills[0].years` 是 `float`，可以直接参与计算。

## 3. 本地运行

```bash
cd agent-lab
uv add openai python-dotenv pydantic     # 装过就跳过
# .env 里有 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL
uv run day09_structured.py
```

真模型开了 JSON mode 后通常第 1 次就能通过。想亲眼看重试生效，可以把 `RESUME_TEXT` 改成"邮箱：无"这种模糊写法，或者在 `Resume` 里加一条更严格的规则（比如 `total_years` 必须是整数）。**把你的真实输出贴给老师**。

## 今日练习

- [ ] 用真 Key 跑一遍，看第几次通过；再把 `response_format` 那行注释掉跑一次，对比输出有没有带 ``` 或解释文字
- [ ] 给 `Resume` 加两个字段：`current_company: str | None`、`level: Literal["初级", "中级", "高级", "专家"]`（按年限判断），重跑
- [ ] 换一段你自己写的简历（可以是你自己的，脱敏即可），看抽取结果对不对
- [ ] 进阶：把 `extract_resume` 改成通用函数 `extract(text, model_cls)`，传入任意 pydantic 类都能用（提示：`model_cls.model_json_schema()`、`model_cls.model_validate_json()`）
- [ ] 补交第 2~8 天的练习（哪怕只交一个也行）

起步模板（新增字段）：

```python
from typing import Literal

class Resume(BaseModel):
    ...
    current_company: str | None = Field(default=None, description="当前公司，没有就填 null")
    level: Literal["初级", "中级", "高级", "专家"] = Field(description="按总年限：<3 初级，3~5 中级，5~10 高级，>10 专家")
```

## 🤔 思考题

1. JSON mode 已经保证是合法 JSON 了，为什么还要 pydantic 校验？举一个"JSON 合法但业务上是错的"例子。
2. 明天学 function calling：模型返回的 `tool_calls[0].function.arguments` 也是一段 JSON 字符串。今天的哪些代码明天可以直接复用？
