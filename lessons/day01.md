> 🎯 **今日目标**：装好 Python 3.12 和 uv，建好 `agent-lab` 项目，能 `uv run main.py` 打印 Hello，并学会 python-dotenv 和 httpx 两个后面天天用的库。
>
> ⏱ 预计 1~1.5 小时 ｜ 📦 产出：GitHub 上的 `agent-lab` 仓库

## 1. 先建立 Java 对照表

你已经会 Java，学 Python 工具链最快的办法是"翻译"：

| Python | Java 里的对应物 | 说明 |
|---|---|---|
| **uv** | Maven + JDK 版本管理（类似 SDKMAN） | 一个工具管 Python 版本、虚拟环境、依赖、运行 |
| `pyproject.toml` | `pom.xml` | 项目元信息和依赖声明 |
| `uv.lock` | 被锁定的依赖树 | 记录每个依赖的确切版本，团队装出来一模一样 |
| `.venv/` | 项目自己的一套 jar 包 | 每个项目独立的依赖，互不污染 |
| `uv run main.py` | `mvn exec:java` | 自动准备环境再运行 |
| `uv add httpx` | 在 pom 里加 `<dependency>` 再 `mvn install` | 一条命令完成"声明 + 下载 + 锁版本" |

为什么用 uv 而不是 pip？pip 只会装包，虚拟环境、版本锁定要自己拼凑；uv 是 Rust 写的，速度快 10 倍以上，而且一个工具全包，体验最接近 Maven。

## 2. 安装 uv

macOS / Linux：

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Windows（PowerShell）：

```bash
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
```

装完重开终端，确认：

```bash
uv --version
```

> 💡 国内网络慢的话，可以给 uv 配镜像：在环境变量里设置 `UV_DEFAULT_INDEX=https://mirrors.aliyun.com/pypi/simple/`（相当于给 Maven 配阿里云 mirror）。

## 3. 建项目

```bash
uv python install 3.12
uv init agent-lab --python 3.12
cd agent-lab
```

打开目录会看到：

- `pyproject.toml`：项目配置，相当于 pom.xml
- `main.py`：入口文件
- `.python-version`：锁定这个项目用的 Python 版本
- `README.md`、`.gitignore`

## 4. 跑起来

```bash
uv run main.py
```

第一次运行会自动创建 `.venv` 并打印 `Hello from agent-lab!`。`main.py` 的内容大概是这样，你可以直接在下面的编辑器里点 **▶ 运行** 试试：

```python run
def main():
    print("Hello from agent-lab!")


if __name__ == "__main__":   # ≈ public static void main，只有直接运行这个文件才执行
    main()
```

## 5. 装依赖

```bash
uv add httpx python-dotenv
```

再看 `pyproject.toml`，依赖已经自动写进 `dependencies` 里了，同时生成的 `uv.lock` 锁住了确切版本。删掉 `.venv` 再 `uv run`，uv 会按 lock 文件原样装回来——这就是"可复现构建"。

## 6. python-dotenv 是干嘛的

它把项目根目录下 `.env` 文件里的配置加载成环境变量，最主要的用途是存 **API Key** 这类密钥，让密钥不用写死在代码里。

Java 类比：有点像 Spring 的 `application.properties` + `@Value("${...}")`，只不过专门用来放敏感配置。

先在项目根目录建 `.env`：

```bash
DEEPSEEK_API_KEY=sk-xxxx
```

代码里这样读（在本 App 里，"⚙️ 设置"页填写的配置会自动写成虚拟的 `.env`，所以下面这段在浏览器也能跑）：

```python run
import os
from dotenv import load_dotenv

load_dotenv()  # 读取 .env，把里面的键值放进环境变量
api_key = os.getenv("LLM_API_KEY")
if api_key:
    print("读到了：", api_key[:6] + "...")  # 只打印前几位，确认读到了
else:
    print("没读到 LLM_API_KEY（本地：检查 .env；App 里：去 ⚙️ 设置 填写）")
```

> ⚠️ **一定要把 `.env` 写进 `.gitignore`**，否则密钥会被推到 GitHub 上，几分钟内就会被扫描程序盗用。

## 7. httpx 怎么用

httpx 是 Python 里发 HTTP 请求的库，相当于 Java 的 OkHttp 或 Spring 的 `RestTemplate` / `WebClient`，同步、异步两种写法都支持，后面调大模型时很常用。

**最简单的 GET（同步）：**

```python run
import httpx

resp = httpx.get("https://api.github.com/users/torvalds")
print(resp.status_code)        # 200
data = resp.json()             # 把返回的 JSON 转成 dict
print(data["public_repos"])
```

**带参数、请求头、超时，再检查状态码：**

```python run
import httpx

resp = httpx.get(
    "https://api.github.com/search/repositories",
    params={"q": "agent", "per_page": 3},     # 会拼成 ?q=agent&per_page=3
    headers={"Accept": "application/vnd.github+json"},
    timeout=10.0,
)
resp.raise_for_status()   # 4xx/5xx 时直接抛异常，≈ RestTemplate 默认行为
for repo in resp.json()["items"]:
    print(repo["full_name"])
```

**POST 一个 JSON 请求体**（httpbin 会把你发的内容原样返回）：

```python run
import httpx

resp = httpx.post("https://httpbin.org/post", json={"name": "jiawei"})
print(resp.json()["json"])
```

**复用连接，用 Client**（相当于把 OkHttpClient 建成单例来用）：

```python run
import httpx

with httpx.Client(base_url="https://api.github.com", timeout=10) as client:
    r = client.get("/users/torvalds")
    print(r.json()["name"])
```

异步写法几乎一样：换成 `httpx.AsyncClient` 再加 `await`，第 3 天讲 async 时细讲。

> 📱 **浏览器运行说明**：GitHub API 未登录时每小时限 60 次请求，看到 403 就是被限流了，过一会儿再试。

## 8. 今日练习

- [ ] 安装 uv，`uv --version` 能输出版本号
- [ ] `uv init agent-lab` 并成功 `uv run main.py`
- [ ] `uv add httpx python-dotenv`，看懂 `pyproject.toml` 和 `uv.lock` 的变化
- [ ] 把 `main.py` 改成：用 httpx 请求 `https://api.github.com/users/你的GitHub用户名`，打印 `public_repos`（可以先在下面的编辑器里写好再抄到本地）
- [ ] 在 GitHub 建仓库 `agent-lab` 并推上去；推之前确认 `.gitignore` 里有 `.env` 和 `.venv`

练习编辑器（把用户名改成你自己的）：

```python run
import httpx

USERNAME = "torvalds"  # TODO: 改成你的 GitHub 用户名


def main() -> None:
    resp = httpx.get(f"https://api.github.com/users/{USERNAME}", timeout=10)
    resp.raise_for_status()
    data = resp.json()
    print(f"{data['login']} 有 {data['public_repos']} 个公开仓库")


if __name__ == "__main__":
    main()
```

## 🤔 思考题

1. `uv.lock` 要不要提交到 Git？（提示：想想 Maven 项目里为什么要固定依赖版本。）
2. 如果不用虚拟环境，两个项目分别需要 httpx 0.27 和 0.28，会发生什么？
