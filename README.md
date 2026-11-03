# dsh-jev-screen

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![DSH plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B9CD3)](https://github.com/chaoguang668/dsh-jev-screen)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](./package.json)

> **一句话**：让 Jev 帮你把几十个候选文件收敛到几个，Agent 只读短名单——不是找全，是排序。

用 [Jev](https://github.com/razorback16/openjev)（OpenJev / Codiv 的判别式模型）对本地目录做**语义海选**：代码负责翻文件夹，Jev 负责把几十个候选收敛成几个，Agent 只读收敛后的短名单。

DeepSeek Harness（DSH）插件，零依赖、零构建——`index.js` 刻意不 import 任何包，没有解析风险，改动即生效。

**目录**

- [定位：降噪排序器，不是召回放大器](#定位降噪排序器不是召回放大器)
- [安装](#安装) · [凭据](#凭据) · [用法](#用法)
- [配置](#配置) · [本地 Laya（离线、零成本）](#本地-laya离线零成本)
- [已知限制](#已知限制)

## 定位：降噪排序器，不是召回放大器

这一条必须先记住，否则会误判它的价值。

字面遍历（glob / grep）**已经能读文件内容**，所以它本身就是个召回超集；Jev 不提供召回优势，它提供的是**精度**。一次实测（154 个资料文件，query `量化交易 选股 回测 策略`）：

| | 规则层（读文件头部） | Jev 语义层 |
|---|---|---|
| 命中 | 34 | 高度相关 **4** + 部分相关 3 |
| 其余 | — | 147 判无关 |
| Jev 高相关但规则层漏掉的 | — | **0** |

Jev 做的事是**把 34 收敛到 4**。典型例子：

- `Obsidian使用指南.md` 正文里有一行字面文本 `量化 OR 炒股 OR 投资`（其实是个 Dataview 查询示例）——规则层给 1.80 分，Jev 判 **0.00**。
- 某工具清单文档——"量化交易"字面出现十几次，但主题是工具用法——规则 1.20，Jev 0.00。

真正无法替代的是**文件名零线索**的文件。上面那次实测里，`Agent记忆/02_金融数据源与实证方法论红线.md`（文件名一个查询词都没有）被 Jev 排到**第 1 名**，conf 0.964。

所以：**别用它找全（找全交给 grep），用它排序。**

## 安装

### 方式一：从 GitHub 直接装入（推荐）

把仓库克隆到本地任意位置，然后作为 bundle 登记进你的 profile：

```sh
git clone https://github.com/chaoguang668/dsh-jev-screen.git
```

在 profile 的 `package.json` 里加依赖（路径换成你 clone 到的实际位置）：

```json
{
  "dependencies": {
    "dsh-jev-screen": "file:/absolute/path/to/dsh-jev-screen"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-jev-screen"]
    }
  }
}
```

### 方式二：作为 tarball 安装

```sh
# 从仓库打包
git clone https://github.com/chaoguang668/dsh-jev-screen.git
cd dsh-jev-screen && npm pack
# 得到 dsh-jev-screen-0.3.0.tgz，然后在 profile 里
# "dsh-jev-screen": "file:/absolute/path/to/dsh-jev-screen-0.3.0.tgz"
```

### 方式三：插件管理器

如果宿主装了 `plugin_manager` 工具（DSH 桌面版自带）：

```
plugin_manager install_bundle  /absolute/path/to/dsh-jev-screen
```

### 生效

`cordis.patch.yml` 会向组合树插入一行 loader entry：

```yaml
- insert:
    - id: jev-screen
      name: dsh-jev-screen
```

登记完让 profile 重新解析依赖（`pnpm install` 或插件管理器的安装命令），**宿主重启后 entry 生效**。

验证是否装好——问模型调一次：

```
jev_screen(root = "/path/to/some/dir", query = "这类文件是干什么的", top = 5)
```

## 凭据

工具按 `apiKeyEnv`（默认 `TYPESAFE_API_KEY`）从 DSH 凭据服务解析密钥，分层顺序为：

```
进程环境  >  $DSH_HOME/.credentials.yaml（可写）  >  <宿主 cwd>/.env  >  $DSH_HOME/.env
```

注意第二层是**唯一可写**的一层；宿主的 cwd 通常不是你的工作区根目录，所以往工作区根 `.env` 写 key 不一定被读到。最稳的是通过凭据服务写：

```js
// 值从你自己的安全位置取，插件本身不内置任何密钥
await ctx.credentials.set('TYPESAFE_API_KEY', process.env.MY_JEV_KEY)
```

或直接用环境变量：

```sh
export TYPESAFE_API_KEY=<your-key>
```

每次调用都重新解析，**换 key 无需重启**。

> 本插件不含任何内置密钥，也不会读取除 `apiKeyEnv` 指定名字之外的凭据。

## 用法

```
jev_screen(root = "/path/to/knowledge-base", query = "用量化方法做股票投资决策", top = 20)
```

- `root`：要检索的目录绝对路径
- `query`：检索目标的自然语言描述。会被编进分档标准，**建议写清主题而非罗列关键词** —— 写 `用量化方法做股票投资决策` 比写 `量化 选股 回测` 更能压住"顺带出现关键词"的噪音
- `top`：返回候选条数，默认 20，上限 200

返回按相关度排序的候选（路径 / 档位 / 归一化分 / 连续分 / 档位来源 / 置信度）与统计（扫描数、失败数、失败文件清单 `failedPaths`、并列比例 `tieRatio`、tokens、耗时）。

## 同质门控与失败名单

这两样是**输出可信度的边界**，都由代码算、不靠调用者自觉：

1. **同质提示。** 同档并列最多的那一档占可评分文件的比例 `tieRatio` 超过 `tieWarnRatio`（默认 30%）时，正文会写明「本候选集同质，Jev 降不了噪」。依据是实测：14 个文件里 9 个并列 1.00，grep 24.9 ms 而本工具 6698 ms——**慢两个数量级且等于没筛**。
   这个比例**只能否决**（告诉你别用 Jev），不能批准；「排序对不对」本地算不出来，只能来自带标注的留出集。
2. **失败名单。** 请求失败的文件在正文里**逐个列出**（路径 + 原因），并计入 `stats.failedPaths`。早期版本只报一个「失败示例」，于是「没找到相关文件」与「相关文件恰好请求失败」在输出里分不清——实测踩过：某目录 28 个文件里有 2 个 `fetch failed`，只显示一个示例。

两者都用受控替身钉死（`fetch` 与 `ctx.fs` 打桩，断言插件自己的判定与渲染）。

## 三件由代码保证、不交给提示词的事

1. **凭据类文件永不外发。** Jev 是第三方端点，送审即外发。`.env`、`credentials*`、`id_rsa`、`.key/.pem`、`.npmrc`、`.netrc`、`.git-credentials` 等文件名与扩展名，以及 `.git` / `.claude` / `.opencode` / `copilot` / `node_modules` 等目录，在**遍历阶段**就被挡掉，不读也不送。
   > 实测教训：早期实验版本把一个知识库的 `.env` 首部发给了对方（该文件恰好只含一个本地路径，未造成凭据泄露）。
2. **逐文件一次请求。** Jev 的并行是"同一份 state 上问 N 个问题"，**不是**"给 N 个对象打分"——把 N 个文件塞进一份 state 问 Choice，只会拿到一个键名，第 2~N 名全丢。所以 N 个文件 = N 次请求，靠并发摊薄。
3. **`Score` 的 `score` 是 criteria 档位的「期望下标」（连续值）**，不是 0~1 归一化分数，**也不是整数下标**。实测：它与 `probabilities` 的加权求和**逐位吻合**。
   **因此不能用 `round(score)` 取档位** —— 那只是 `argmax(probabilities)` 的有损代替品，在分布尖锐时一致、**在分布摊开时分歧**，也就是**恰好在低置信度时失效**。
   实测一例：`score=0.55`、`probabilities={0:0.77,1:0.06,2:0.04,3:0.13}` → `round` 得 **1**（该档概率仅 0.06），而真正的众数是 **0**（0.77）。
   现在档位一律取 `argmax(probabilities)`（`pickLevel()`）；`score` 作为**连续分**从 `expectedIndex` 字段一并返回，用于同级并列时的次级排序；`probabilities` 缺失或键不可解析时才降级到旧的 round 行为（此时 `levelSource` 为 `rounded-score`）。

另外，档位描述里默认写入了"否定/批评表述说明它在讨论该主题，不代表无关"，用来绕过语义陷阱（实测：某篇标题写"对量化基本用不上"的评估文档，纯相关度标尺会把它判成无关）。

## 配置

全部可调项都有默认值，需要覆盖时在 profile 的 `cordis.patch.yml` 里加 `config` 块：

| 键 | 默认 | 说明 |
|---|---|---|
| `apiKeyEnv` | `TYPESAFE_API_KEY` | 凭据引用名 |
| `baseUrl` | `https://api.codiv.ai` | OpenJev 兼容端点 |
| `model` | `openjev-latest` | 也可用 `openjev-0.1`（固定版本、答案不漂移） |
| `levelOrder` | `descending` | criteria 的书写方向。`descending` = 高度相关在前（Jev）；指向 **Laya 必须改 `ascending`**，见下 |
| `maxFiles` | `400` | 送审文件数上限 |
| `concurrency` | `6` | 并发请求数 |
| `headBytes` | `4096` | 每个文件读取的字节数（走 `ctx.fs.readByteRange`，不整份缓冲） |
| `headChars` | `500` | 送审摘要字符数 |
| `requestTimeoutMs` | `120000` | 单次调用超时 |
| `textExts` | 见代码 | 参与评分的文本扩展名 |
| `tieWarnRatio` | `0.3` | 同档并列比例超过它就在正文里提示「本集合同质」；取值 `(0, 1]`，非法值在加载期报错 |
| `expectedVersion` | 与 `index.js` 的 `REQUIRED_VERSION` 相同 | 版本闸的期望值；只用于显式降级到旧行为，见「热更新与版本闸」 |

## 本地 Laya（离线、零成本）

`convaiinnovations/laya-multilingual` 是 Jev 兼容的开源判别式模型，可完全本地跑。两条硬约束：

1. **必须显式带 `model`。** Laya 服务端按 state 的语言路由：中文 → `multilingual`，英文 → `english`。若英文检查点未完整下载，英文 state 会 `HTTP 500 inference failed`（`IncompleteSnapshotError`）。显式指定 `model: multilingual` 可绕过路由，中英文都能处理。
2. **`levelOrder` 必须是 `ascending`。** Laya 的 `score` 原语把 criteria 当作"属性从无到有"的单调刻度（criterion 0 最低），**不读档位文本的语义**。用默认的递减书写会让整条轴翻转 —— 实测同一对输入仅改方向：正题 2.219→1.723、离题 0.911→0.981。插件在 `ascending` 下会把 argmax 映射回递减空间，下游口径不变。

```yaml
- id: jev-screen
  name: dsh-jev-screen
  config:
    baseUrl: http://127.0.0.1:11500
    model: multilingual
    levelOrder: ascending
```

实测对照（8 候选重排 + 4 文件端到端，2026-10）：

| | Laya-local | Jev(codiv) |
|---|---|---|
| 单次延迟 | **52–103 ms** | 413–1488 ms |
| Spearman ρ | 0.851 | **0.923** |
| cap=6 短名单命中 | 5/6 | **6/6** |

**代价**：Laya 会把"关键词邻近但主旨无关"的假朋友抬进短名单（实测某案例得分 1.72 vs 正题 1.95）。它的 `choice` 原语（语义互斥选项）接近满分，`score` 的细粒度档位则不可靠，置信度普遍偏低。**适合当第一级快速粗筛，不适合替代终审。**

## 热更新与版本闸

profile 以 junction 链接本目录时装的不是拷贝；但若 profile 的 `node_modules/<name>` 是**真实拷贝**而非 junction，改源目录不会生效——必须先同步拷贝或改成链接。

Node 对同一路径的 ES 模块只保留**第一次加载**的实例，而运行的宿主进程可能早已加载过旧代，于是：

- **重新安装不保证换掉已加载的旧代码**；旧工具定义会一直服务到这个宿主进程退出。
- **不要用强制丢缓存的"热重载"来验证本插件**：重载会重新执行模块体，而模块体里的 `await readOwnVersion()` 是顶层求值——重载会把插件自身的事务弄成未知状态，整轮调用挂死（实测 3/3 卡住）。
- **正确的验证顺序**：改文件 → `node --check` → **重启 DSH 宿主** → 再调 `jev_screen` 看输出。

为了防止"以为改了、其实还在跑旧代码"，本插件有**版本闸**：`index.js` 里的 `REQUIRED_VERSION` 必须等于 `package.json` 的 `version`，加载期不一致直接报错并说明是旧代。于是：

| 情况 | 结果 |
|---|---|
| 改了 `index.js` 忘了提升版本 | 重启后加载失败，报版本不一致（不会静默跑混合代码） |
| 提升了 `package.json` 但宿主未重启 | 旧代模块体的 `REQUIRED_VERSION` 仍是旧值，与新的 `package.json` 不一致 → 加载失败，错误信息提示重启 |
| 确实要以旧行为运行 | 在 profile 的 `cordis.patch.yml` 里显式设 `config.expectedVersion: <旧版本>` |

### 重复装配：最后加载者胜

同一个工具名可能被装配两次（profile `bundles` 与注入器清单各装一份），核心注册表面对重名直接抛错，**输的那一份连同它的新代码一起失效**——实测踩过：0.2.0 已加载到宿主，模型调用的却是 0.1.0 的定义（无同质提示、无失败名单）。

现在插件自己处理：发现同名注册时先按标准 Effect Scope 接口（`isActive()` / `dispose()`）摘掉它，再注册当前版本，并写一条 warn。若同名注册**拆不掉**，则直接报错而不是覆盖——静默丢掉别人的 `execute` 代价更高。

根治仍建议**只保留一处装配**：查 profile 的 `bundles` 与注入清单，重复的删掉一条。

## 已知限制

- **延迟**：单次调用实测 **p50 ≈ 2.0s**（2026-09 复测；官方宣传 70~500ms，早期文档记录 1201ms，服务变慢了）。延迟靠并发摊薄，不适合交互式实时场景。
- **成本**：输入 $0.042 / 百万 tokens，输出免费。154 文件 ≈ 80k tokens ≈ **$0.0034**。1 亿免费额度约可跑 120 万次文件评分。
- **数据出境**：文件首部摘要会发送到 `baseUrl`。不要把含敏感内容的目录指给它，除非你自建 OpenJev 端点。
- **服务稳定性**：Codiv 的 OpenJev 跑在社区维护者的个人 GPU 上，底座是 v0.1 + 未合并的 vLLM PR。
- **不做终审**：返回的是候选清单，最终判断仍要读完整内容。

## 文件

```
dsh-jev-screen/
├── package.json        # dsh.bundle 声明
├── cordis.patch.yml    # 插入一行 loader entry
├── index.js            # 全部实现（零依赖、零构建）
├── README.md
└── LICENSE             # MIT
```

`index.js` 刻意**不 import 任何包**（不引 `@deepseek-ai/*`，也不引 schemastery），因此没有解析风险、没有构建步骤，改动即生效。

## License

MIT. 见 [LICENSE](./LICENSE)。
