/**
 * dsh-jev-screen — 用 Jev（OpenJev / Codiv）对本地文件做语义海选。
 *
 * 定位：**降噪排序器，不是召回放大器**。字面遍历负责"宁多勿少地翻文件"，
 * Jev 负责"把几十个候选收敛成几个"，大模型（Agent）只读收敛后的短名单。
 * 实测（154 个资料文件）：规则层读内容后命中 34 个，Jev 收敛到
 * 4 个高度相关，其中包含 3 个文件名里一个查询词都没有的文件。
 *
 * 三个必须由代码保证、不能交给提示词的性质：
 *
 * 1. **凭据类文件永不外发**。Jev 是第三方端点，送审即外发。`.env`、编辑器与
 *    工具目录（.claude / .opencode / copilot）在遍历阶段就被挡掉——实测踩过：
 *    早期版本把一个知识库的 `.env` 首部发给了对方。
 * 2. **逐文件一次请求**。Jev 的并行是"同一份 state 上问 N 个问题"，不是
 *    "给 N 个对象打分"：把 N 个文件塞进一份 state 问 Choice，只会拿到一个键名，
 *    第 2~N 名全丢。
 * 3. **`Score` 的返回值是 criteria 档位下标**，不是 0~1 归一化分数。按 0~1
 *    解读会直接越界（实测 4 档 rubric 返回 2.84 → 误算成下标 9）。
 *
 * @module dsh-jev-screen
 */

/** Cordis 插件名。 */
export const name = 'jev-screen'

/** 磁盘上本文件的 package.json 版本；读不到时为 null（不阻断加载）。 */
const PKG_VERSION = await readOwnVersion()

/**
 * 读同目录 `package.json` 的版本。
 *
 * 只读本文件旁的一个文件；任何失败都返回 null——版本闸是附加不变量，
 * 不能因为文件被移动或权限不足就让插件装不上。
 *
 * @returns `version` 字段；读不到或非法时为 null。
 */
async function readOwnVersion() {
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(new URL('./package.json', import.meta.url), 'utf8')
    const version = JSON.parse(raw).version
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

/** 硬依赖：工具注册表与沙箱感知文件系统。 */
export const inject = ['tools', 'fs']

/** 注册到模型可见 schema 的工具名。 */
const TOOL_NAME = 'jev_screen'

/**
 * 目录名黑名单。这些目录装的不是被检索的资料，且常含凭据或工具配置。
 */
const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', '.obsidian', '.claude', '.opencode', '.copilot',
  'node_modules', '__pycache__', '.venv', 'venv', 'site-packages',
  '$RECYCLE.BIN', 'System Volume Information', '.idea', '.vscode',
])

/** 文件名黑名单：凭据与本地配置，命中即跳过（不读、不送审）。 */
const SKIP_FILE_NAMES = new Set([
  '.env', '.env.local', '.env.production', 'credentials', 'credentials.json',
  'id_rsa', 'id_ed25519', '.npmrc', '.netrc', '.git-credentials',
])

/** 扩展名黑名单：密钥与证书。 */
const SKIP_EXTS = new Set(['.key', '.pem', '.pfx', '.p12', '.secret'])

/** 默认参与语义评分的文本扩展名。 */
const DEFAULT_TEXT_EXTS = [
  '.md', '.markdown', '.txt', '.rst', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.csv', '.html', '.css',
  '.sql', '.sh', '.bash', '.ps1', '.bat', '.java', '.go', '.rs', '.rb', '.c', '.h',
  '.cpp', '.log',
]

const LEVEL_LABELS = ['高度相关', '部分相关', '弱相关', '无关']

/**
 * 本文件实现对应的插件版本。必须与 `package.json` 的 `version` 一致。
 *
 * 由加载期校验使用：经 junction 加载的模块体与磁盘上的文件可以不是同一代，
 * 版本不一致就说明进程里跑的是旧代码。改版时同时提升两者。
 */
const REQUIRED_VERSION = '0.3.0'

/** 全部可调项的默认值；每一项都可由 cordis.yml 的 config 覆盖。 */
const DEFAULTS = {
  apiKeyEnv: 'TYPESAFE_API_KEY',
  baseUrl: 'https://api.codiv.ai',
  model: 'openjev-latest',
  levelOrder: 'descending',
  maxFiles: 400,
  concurrency: 6,
  headBytes: 4096,
  headChars: 500,
  requestTimeoutMs: 120000,
  textExts: DEFAULT_TEXT_EXTS,
  tieWarnRatio: 0.3,
  expectedVersion: REQUIRED_VERSION,
}

/**
 * 把 query 编进档位描述，让 Jev 判"主旨归属"而不是笼统的"相关程度"。
 * 后者在文件含否定句时会被带偏：实测 `06_Jev对量化研究的作用评估.md` 开头写
 * "对量化基本用不上"，纯相关度评分把它判成 0.00 无关。
 *
 * `order` 决定 criteria 的书写方向，因为提供方对这一点的要求不同：Jev 读 criteria
 * 的语义，正反序都行；Laya 的 `score` 原语把 criteria 当作"属性从无到有"的单调刻度
 * （criterion 0 最低），**不读档位文本**，递减书写会让整条轴翻转 —— 实测同一对输入
 * 仅改书写方向：正题得分 2.219→1.723、离题得分 0.911→0.981，即从反向变为正向。
 *
 * @param query - 用户的检索目标描述。
 * @param order - `'descending'`（高度相关在前，Jev）或 `'ascending'`（无关在前，Laya）。
 * @returns 四个档位的 criteria 文本，按 `order` 排列。
 */
function levelsFor(query, order) {
  const descending = [
    `高度相关：该文件的主旨正是「${query}」所指的主题`,
    `部分相关：该文件涉及「${query}」的某些方面，但不是主旨`,
    `弱相关：该文件只是顺带出现「${query}」的词，实质主题不同`,
    `无关：该文件的主旨与「${query}」无关`,
  ]
  return order === 'ascending' ? descending.slice().reverse() : descending
}

/**
 * 去掉 Markdown/YAML frontmatter。
 *
 * frontmatter 里的 `skill_triggers` / `tags` 常写满主题词，不剥掉会同时污染
 * 两侧：规则层被放大成噪音超集，Jev 侧则让元数据挤占摘要预算、并在截断处
 * 造成语义断裂。
 *
 * @param text - 原始文件首部。
 * @returns 去掉 frontmatter 后的正文。
 */
function stripFrontmatter(text) {
  const t = text.replace(/^\uFEFF/, '').replace(/^[\s\r\n]+/, '')
  if (!t.startsWith('---')) return t
  const end = t.indexOf('\n---', 3)
  return end === -1 ? t : t.slice(end + 4).replace(/^[\s\r\n]+/, '')
}

/**
 * 取小写扩展名（含点）。无扩展名时返回空串。
 *
 * @param filename - 文件名。
 * @returns 形如 `.md` 的小写扩展名。
 */
function extOf(filename) {
  const i = filename.lastIndexOf('.')
  return i <= 0 ? '' : filename.slice(i).toLowerCase()
}

/**
 * 校验并补全配置。任何非法值都在加载期抛错，不静默回退。
 *
 * @param raw - cordis.yml 传入的 config。
 * @returns 补全后的配置。
 * @throws 当任一项类型或取值非法时。
 */
function normalizeConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw ?? {}) }

  const requireInt = (key, min, max) => {
    const v = cfg[key]
    if (!Number.isInteger(v) || v < min || v > max) {
      throw new Error(`[jev-screen] config.${key} 必须是 ${min}~${max} 的整数，收到 ${JSON.stringify(v)}`)
    }
  }
  const requireNonEmptyString = (key) => {
    if (typeof cfg[key] !== 'string' || cfg[key].length === 0) {
      throw new Error(`[jev-screen] config.${key} 必须是非空字符串`)
    }
  }

  requireNonEmptyString('apiKeyEnv')
  requireNonEmptyString('model')
  requireNonEmptyString('baseUrl')
  try {
    const url = new URL(cfg.baseUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme')
  } catch {
    throw new Error(`[jev-screen] config.baseUrl 必须是 http(s) URL，收到 ${JSON.stringify(cfg.baseUrl)}`)
  }

  requireInt('maxFiles', 1, 5000)
  requireInt('concurrency', 1, 32)
  requireInt('headBytes', 128, 262144)
  requireInt('headChars', 64, 4000)
  requireInt('requestTimeoutMs', 1000, 600000)

  if (typeof cfg.tieWarnRatio !== 'number' || !(cfg.tieWarnRatio > 0 && cfg.tieWarnRatio <= 1)) {
    throw new Error(`[jev-screen] config.tieWarnRatio 必须是 (0, 1] 内的数字，收到 ${JSON.stringify(cfg.tieWarnRatio)}`)
  }

  if (typeof cfg.expectedVersion !== 'string' || cfg.expectedVersion.length === 0) {
    throw new Error('[jev-screen] config.expectedVersion 必须是非空版本字符串')
  }

  // profile 以 junction 链接本目录，正在加载的模块体可能早于磁盘上的最近一次编辑，
  // 于是调用的是不带同质门控的旧代码 —— 输出里没有任何迹象。让旧代加载即失败：
  // 改版必须同时提升 package.json 的 version 与 REQUIRED_VERSION。
  // 经 cordis.yml 显式降级（config.expectedVersion）是有意的逃生门。
  if (PKG_VERSION !== null && PKG_VERSION !== cfg.expectedVersion) {
    throw new Error(
      `[jev-screen] 运行中的模块版本是 ${PKG_VERSION}，本版代码要求 ${cfg.expectedVersion}：`
      + 'profile 进程里仍是改版前的旧代，输出不含同质门控与失败名单。'
      + '重启 DSH 宿主生效；只有确认要以旧行为运行时才设 config.expectedVersion 为该版本。',
    )
  }

  if (cfg.levelOrder !== 'descending' && cfg.levelOrder !== 'ascending') {
    throw new Error(
      `[jev-screen] config.levelOrder 必须是 'descending' 或 'ascending'，收到 ${JSON.stringify(cfg.levelOrder)}`,
    )
  }

  if (!Array.isArray(cfg.textExts) || cfg.textExts.length === 0) {
    throw new Error('[jev-screen] config.textExts 必须是非空字符串数组')
  }
  cfg.textExts = new Set(cfg.textExts.map((e) => String(e).toLowerCase()))

  return cfg
}

/**
 * 解析 API Key。按调用解析，不跨调用缓存——凭据服务的契约要求每次操作重新解析，
 * 这样换 key 无需重启。
 *
 * @param ctx - 插件上下文。
 * @param cfg - 已校验配置。
 * @returns API Key。
 * @throws 当凭据未配置时。
 */
async function resolveApiKey(ctx, cfg) {
  const credentials = ctx.get('credentials')
  if (credentials) {
    const resolved = await credentials.resolve(cfg.apiKeyEnv)
    if (resolved?.value) return resolved.value
  }
  const fromEnv = process.env[cfg.apiKeyEnv]
  if (fromEnv) return fromEnv
  throw new Error(
    `[jev-screen] 未找到凭据 ${cfg.apiKeyEnv}。` +
    '把它写进 DSH 读取的 .env（如工作区根目录的 .env），或设置同名环境变量。',
  )
}

/**
 * 递归收集候选文件。
 *
 * 遍历与读取都走 fs 服务（由调用方经 `ctx.get('fs')` 取好传入），因此受文件沙箱
 * 约束，不绕过产品边界。
 *
 * @param ctx - 插件上下文（仅用于日志类附属能力）。
 * @param fs - 文件服务。
 * @param rootTarget - 已解析的根目录 target。
 * @param cfg - 已校验配置。
 * @param signal - 取消信号。
 * @returns 候选文件清单。
 */
async function collectFiles(ctx, fs, rootTarget, cfg, signal) {
  const files = []
  const queue = [rootTarget]
  let dirs = 0

  while (queue.length > 0 && files.length < cfg.maxFiles) {
    const dir = queue.shift()
    dirs += 1
    let entries
    try {
      entries = await fs.listDir(dir, signal)
    } catch {
      // 无权限/已消失的目录跳过即可，不该让整次海选中止。
      continue
    }
    for (const entry of entries) {
      if (files.length >= cfg.maxFiles) break
      if (entry.type === 'directory') {
        if (!SKIP_DIRS.has(entry.name)) queue.push(entry.target)
        continue
      }
      if (entry.type !== 'file') continue
      if (SKIP_FILE_NAMES.has(entry.name)) continue
      const ext = extOf(entry.name)
      if (SKIP_EXTS.has(ext)) continue
      if (!cfg.textExts.has(ext)) continue
      files.push({
        name: entry.name,
        ext,
        size: entry.size ?? 0,
        target: entry.target,
        displayPath: entry.target.displayPath,
        head: '',
      })
    }
  }
  return { files, dirs }
}

/**
 * 只读文件首部的 headBytes 字节，不整份缓冲。
 *
 * @param fs - 文件服务。
 * @param file - 候选文件。
 * @param cfg - 已校验配置。
 * @param signal - 取消信号。
 * @returns 剥掉 frontmatter 后的正文首部。
 */
async function readHead(fs, file, cfg, signal) {
  const bytes = await fs.readByteRange(file.target, { offset: 0, length: cfg.headBytes }, signal)
  return stripFrontmatter(new TextDecoder('utf-8', { fatal: false }).decode(bytes))
}

/**
 * 渲染送审文本。首部截断到 headChars，与 Jev 侧口径保持一致。
 *
 * @param file - 候选文件（含 head）。
 * @param cfg - 已校验配置。
 * @returns Jev 的 state 文本。
 */
function buildState(file, cfg) {
  const parts = [`文件名: ${file.name}`, `路径: ${file.displayPath}`]
  const excerpt = file.head.replace(/\s+/g, ' ').trim().slice(0, cfg.headChars)
  if (excerpt) parts.push(`内容摘要: ${excerpt}`)
  else parts.push(`扩展名: ${file.ext}  大小: ${file.size}B`)
  return `被评估的文件：\n${parts.join('\n')}`
}

/**
 * 单次 system_one 调用。
 *
 * @param cfg - 已校验配置。
 * @param apiKey - API Key。
 * @param state - 送审文本。
 * @param levels - 档位描述。
 * @param signal - 取消信号（应已合并超时）。
 * @returns `{ relIndex, confidence, inputTokens }`。
 * @throws 当 HTTP 状态非 2xx 或响应结构不符时。
 */
async function callJev(cfg, apiKey, state, levels, signal) {
  const endpoint = new URL('/v1/systemone', cfg.baseUrl)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // Cloudflare 会拦默认的库 UA（error code 1010），与 key 无关。
      'User-Agent': 'curl/8.4.0',
      Accept: '*/*',
    },
    body: JSON.stringify({
      model: cfg.model,
      state,
      questions: {
        rel: {
          type: 'score',
          instructions:
            '判断这个文件的主旨属于以下哪一档。注意：文件里可能出现否定、批评或'
            + '"用不上"之类的表述，那说明它在讨论该主题，不表示它与该主题无关；'
            + '请依据文件谈论的对象来判断主旨归属。',
          criteria: levels,
        },
      },
    }),
    signal,
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status} ${detail.slice(0, 200)}`)
  }
  const payload = await response.json()
  const answer = payload?.answers?.rel
  if (!answer || typeof answer !== 'object') {
    throw new Error('响应缺少 answers.rel')
  }
  const picked = pickLevel(answer, levels.length)
  // 升序 criteria 下，argmax 下标是"无关在前"的空间；这里映射回递减空间，
  // 下游的 LEVEL_LABELS / score / 排序口径因此与 provider 无关。
  const ascending = cfg.levelOrder === 'ascending'
  const flip = (i) => (typeof i === 'number' ? levels.length - 1 - i : i)
  return {
    relIndex: ascending ? flip(picked.relIndex) : picked.relIndex,
    expectedIndex: ascending ? flip(picked.expectedIndex) : picked.expectedIndex,
    levelSource: picked.source,
    confidence: typeof answer.confidence === 'number' ? answer.confidence : null,
    inputTokens: payload?.usage?.input_tokens ?? 0,
  }
}

/**
 * 从一次 Score 应答里取出「离散档位」与「连续分」。
 *
 * 为什么不能只用 `Math.round(answer.score)`：`score` 是 criteria 档位的**期望下标**
 * （连续值，实测与 probabilities 加权求和逐位吻合），而
 * `round(期望下标)` 只是 `argmax(probabilities)` 的**有损代替品** ——
 * 两者在分布尖锐时一致、在**分布摊开时分歧**，也就是恰好在低置信度时失效。
 * 实测一例：`score=0.55`、`probabilities={0:0.77,1:0.06,2:0.04,3:0.13}`，
 * `round` 得 1（该档概率仅 0.06），而真正的众数是 0（0.77）。
 *
 * 因此：离散档位一律取 argmax(probabilities)；`score` 保留为连续信号供排序用。
 * `probabilities` 缺失或键不可解析时，才降级到旧的 round 行为。
 *
 * @param answer - 应答里的某一个答案对象（如 `answers.rel`）。
 * @param levelCount - criteria 档位个数。
 * @returns `{ relIndex, expectedIndex, source }`；无法解析时 relIndex/expectedIndex 为 null。
 */
export function pickLevel(answer, levelCount) {
  const probs = answer && typeof answer.probabilities === 'object' && answer.probabilities !== null
    ? answer.probabilities
    : null
  if (probs !== null) {
    let best = null
    for (const [key, value] of Object.entries(probs)) {
      const idx = Number(key)
      if (!Number.isInteger(idx) || idx < 0 || idx >= levelCount) continue
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      if (best === null || value > best.prob) best = { idx, prob: value }
    }
    if (best !== null) {
      return {
        relIndex: best.idx,
        expectedIndex: typeof answer.score === 'number' && Number.isFinite(answer.score) ? answer.score : null,
        source: 'probabilities',
      }
    }
  }
  const raw = answer ? answer.score : undefined
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return {
      relIndex: Math.max(0, Math.min(levelCount - 1, Math.round(raw))),
      expectedIndex: raw,
      source: 'rounded-score',
    }
  }
  return { relIndex: null, expectedIndex: null, source: 'none' }
}

/**
 * 固定并发的工作池；worker 自身不得抛错。
 *
 * @param items - 待处理项。
 * @param limit - 并发上限。
 * @param worker - `(item, index) => Promise<T>`。
 * @returns 与 items 等长、顺序一致的结果数组。
 */
async function mapPool(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * 合并取消信号与单次调用超时。
 *
 * @param signal - 上层取消信号。
 * @param timeoutMs - 单次调用超时毫秒。
 * @returns 合并后的信号。
 */
function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/**
 * 算「同档并列」占可评分文件数的比例，用于判断这份候选集是否同质。
 *
 * 同质集上判别式模型降不了噪：实测 14 个预设文件里 9 个并列 1.00，grep 24.9 ms
 * 而 jev_screen 6698 ms —— 慢两个数量级且等于没筛。这个比例可以在本地免费算出，
 * 所以它只能**否决**（提示「别用 Jev」），不能批准。
 *
 * @param candidates - 已按分排序的候选。
 * @returns 并列最多的那一档的 `{ level, count, ratio }`；无候选时 `count` 与 `ratio` 为 0。
 */
function topTie(candidates) {
  const counts = new Map(LEVEL_LABELS.map((level) => [level, 0]))
  for (const candidate of candidates) counts.set(candidate.level, (counts.get(candidate.level) ?? 0) + 1)
  let peak = { level: LEVEL_LABELS[0], count: 0 }
  for (const [level, count] of counts) {
    if (count > peak.count) peak = { level, count }
  }
  const ratio = candidates.length === 0 ? 0 : peak.count / candidates.length
  return { ...peak, ratio: Number(ratio.toFixed(3)) }
}

/**
 * 取评分记录对应的显示路径。
 *
 * 失败记录不一定带 `file` 之外的结构（`collectFiles` 的条目恒有 `displayPath`），
 * 但渲染失败名单是纯附加路径，不能因为它抛错吞掉整份结果，故单点防御。
 *
 * @param record - `{ file, error }` 评分记录。
 * @returns 显示路径；取不到时为 `'(unknown path)'`。
 */
function filePathOf(record) {
  return record?.file?.displayPath ?? '(unknown path)'
}

/**
 * 执行一次语义海选。
 *
 * @param ctx - 插件上下文。
 * @param cfg - 已校验配置。
 * @param args - 模型传入的工具参数。
 * @param exec - 工具运行上下文。
 * @returns 可直接交给 `output.schema` 的结果值。
 */
async function runScreen(ctx, cfg, args, exec) {
  const root = typeof args?.root === 'string' ? args.root.trim() : ''
  const query = typeof args?.query === 'string' ? args.query.trim() : ''
  if (!root) throw new Error('jev_screen 需要 root：要检索的目录绝对路径')
  if (!query) throw new Error('jev_screen 需要 query：检索目标的自然语言描述')

  const top = Number.isInteger(args?.top) && args.top > 0 ? Math.min(args.top, 200) : 20
  const apiKey = await resolveApiKey(ctx, cfg)

  const started = Date.now()
  const fs = ctx.get('fs')
  const rootTarget = await fs.resolve(root, { signal: exec.signal })
  const { files, dirs } = await collectFiles(ctx, fs, rootTarget, cfg, exec.signal)
  if (files.length === 0) {
    return {
      text: `在 ${rootTarget.displayPath} 下没有找到可评分的文本文件（已排除 ${[...SKIP_DIRS].length} 类工具/凭据目录与密钥类扩展名）。`,
      candidates: [],
      stats: { scanned: 0, dirs, failed: 0, failedPaths: [], tieRatio: 0, inputTokens: 0, elapsedMs: Date.now() - started },
    }
  }

  for (const file of files) {
    try {
      file.head = await readHead(fs, file, cfg, exec.signal)
    } catch {
      file.head = ''
    }
  }

  const levels = levelsFor(query, cfg.levelOrder)
  const scored = await mapPool(files, cfg.concurrency, async (file) => {
    try {
      const result = await callJev(
        cfg,
        apiKey,
        buildState(file, cfg),
        levels,
        withTimeout(exec.signal, cfg.requestTimeoutMs),
      )
      return { file, ...result, error: null }
    } catch (error) {
      return { file, relIndex: null, expectedIndex: null, levelSource: null, confidence: null, inputTokens: 0, error: String(error?.message ?? error) }
    }
  })

  const failed = scored.filter((r) => r.error !== null)
  const usable = scored.filter((r) => r.error === null && r.relIndex !== null)
  const candidates = usable
    .map((r) => {
      const expected = r.expectedIndex === null || r.expectedIndex === undefined
        ? null
        : Number(r.expectedIndex.toFixed(3))
      return {
        path: r.file.displayPath,
        level: LEVEL_LABELS[r.relIndex],
        // 归一化到 0~1，1 = 高度相关（档位下标 0）。
        score: Number((1 - r.relIndex / (levels.length - 1)).toFixed(3)),
        levelSource: r.levelSource ?? 'unknown',
        confidence: r.confidence === null ? null : Number(r.confidence.toFixed(3)),
        // 连续分（期望下标）。为 null 时省略该键：output schema 是 additionalProperties:false
        // 且 expectedIndex 声明为 number，省略比发 null 更稳。
        ...(expected === null ? {} : { expectedIndex: expected }),
      }
    })
    .sort((a, b) => (b.score - a.score)
      || ((a.expectedIndex ?? Number.POSITIVE_INFINITY) - (b.expectedIndex ?? Number.POSITIVE_INFINITY))
      || ((b.confidence ?? 0) - (a.confidence ?? 0)))

  const inputTokens = scored.reduce((sum, r) => sum + (r.inputTokens || 0), 0)
  const tie = topTie(candidates)
  const stats = {
    scanned: files.length,
    dirs,
    failed: failed.length,
    // 失败文件名。没有它，「没候选」与「有候选但请求失败」在输出里分不清。
    failedPaths: failed.map(filePathOf),
    // 可评分文件里同档并列比例；超过 tieWarnRatio 时在正文里提示「本集合同质」。
    tieRatio: tie.ratio,
    inputTokens,
    elapsedMs: Date.now() - started,
  }

  const header = [
    `Jev 语义海选：${rootTarget.displayPath}`,
    `目标：${query}`,
    `扫描 ${stats.scanned} 个文件 / ${stats.dirs} 个目录，耗时 ${(stats.elapsedMs / 1000).toFixed(1)}s，`
      + `${inputTokens} tokens${failed.length ? `，${failed.length} 个评分失败` : ''}`,
    `分档：${LEVEL_LABELS.map((l) => `${l} ${candidates.filter((c) => c.level === l).length}`).join(' | ')}`,
  ]
  if (candidates.length > 0 && tie.ratio > cfg.tieWarnRatio) {
    header.push(
      `⚠ 同质提示：${tie.count}/${candidates.length} 个可评分文件并列在「${tie.level}」`
        + `（${(tie.ratio * 100).toFixed(0)}% > ${(cfg.tieWarnRatio * 100).toFixed(0)}%）。`
        + '本候选集同质，Jev 降不了噪 —— 这种集合用 grep 或直接读更划算。',
    )
  }
  header.push('', `高相关候选（前 ${Math.min(top, candidates.length)} 个，1.00 = 主旨正中目标）：`)
  for (const c of candidates.slice(0, top)) {
    header.push(`  ${c.score.toFixed(2)}  [${c.level}]  conf=${c.confidence ?? '-'}\n      ${c.path}`)
  }
  if (failed.length > 0) {
    // 失败名单全量列出（上限 maxFiles），避免「失败的恰好是相关文件」被悄悄抹掉。
    header.push('', `评分失败（${failed.length} 个，未参与排序）：`)
    for (const r of failed) header.push(`  ${filePathOf(r)} — ${r.error}`)
  }
  header.push('', '注：这是"快筛"，不是结论。请对上面的候选读完整内容做终审。')

  return { text: header.join('\n'), candidates, stats }
}

/**
 * 以幂等方式占用工具名 `jev_screen`。
 *
 * 同一个工具已经注册时，核心注册表直接抛 "already registered"，而装配层（profile
 * `bundles` 与注入器清单）可以各自装一份本插件：重启后谁先生效由装配顺序决定，
 * 输的那一份连同新代码一起失效，且没有可观察迹象——实测踩过：0.2.0 已加载到宿主，
 * 模型调用的却是另一份 0.1.0 的旧定义。
 *
 * 这里按「最后加载者胜」处理：同名注册存在时先摘掉它，再注册本代定义。摘除用标准
 * Effect Scope 接口（`isActive()` / `dispose()`，见 dsh-scope EffectScope），因此在
 * Cordis 与宿主注入器的任何 ctx 上都成立；旧代被摘除后，它的 fiber 会在自清理时
 * 再次 dispose 同一个记录（记录级幂等），不会造成双重删除。
 *
 * 若拿不到同名注册的 disposer，则**不覆盖**：额外定义的 execute 可能夹带别的副作用，
 * 静默丢掉的代价高于报错。此时直接抛出，让装配问题在加载期可见。
 *
 * @param ctx - 插件上下文（注册与日志的服务来源）。
 * @param register - 注册本代工具定义，返回 disposer。
 * @returns 与 `register` 同形的 disposer。
 * @throws 当同名注册无法被拆除时。
 */
function insertRegistration(ctx, register) {
  const registry = ctx.get('tools')
  const previous = registry?.get?.(TOOL_NAME)
  if (previous === undefined) return register()

  if (typeof previous.isActive === 'function' && !previous.isActive()) return register()
  const disposers = previous.disposers
  if (!Array.isArray(disposers) || disposers.length === 0 || typeof previous.dispose !== 'function') {
    throw new Error(
      `[jev-screen] 工具 ${TOOL_NAME} 已被另一份注册占用，且无法安全拆除；`
      + '请检查 profile 的 bundles 与注入清单是否各装了一份本插件，只保留一处。',
    )
  }

  ctx.logger?.warn?.(
    '[jev-screen] 工具 %C 已存在（重复装配），按「最后加载者胜」替换为当前版本',
    TOOL_NAME,
  )
  previous.dispose()
  return register()
}

/**
 * 插件入口。
 *
 * @param ctx - Cordis 上下文。
 * @param config - cordis.yml 提供的 config（可省略，全部走默认值）。
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  // 与 fs / credentials 一致，经 ctx.get 取服务：属性代理依赖注入拓扑，get 读全局服务表。
  const tools = ctx.get('tools')

  ctx.effect(() => insertRegistration(ctx, () => tools.register({
    name: TOOL_NAME,
    description:
      '用 Jev（判别式模型）对本地目录做语义海选：按目录遍历建候选，逐文件向 Jev 问'
      + '"这份文件的主旨是否落在检索目标上"，返回按相关度排序的短名单。'
      + '适用于"grep 关键词抓不到、逐个读文件又太贵"的批量筛选——它对文件名零线索'
      + '的文件同样有效。返回的是候选清单，仍需你读完整内容做终审。'
      + '注意：文件首部摘要会发送到配置的 Jev 端点；凭据类文件与工具目录在遍历阶段'
      + '已被排除，不会外发。',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', description: '要检索的目录绝对路径。' },
        query: {
          type: 'string',
          description: '检索目标的自然语言描述，例如「量化交易 选股 回测 策略」。会被编进分档标准，建议写清主题而非罗列关键词。',
        },
        top: { type: 'integer', description: '返回的候选条数，默认 20，上限 200。' },
      },
      required: ['root', 'query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                level: { type: 'string' },
                score: { type: 'number' },
                confidence: { type: 'number' },
                // 连续分：Jev 的 score 是 criteria 的「期望下标」，比离散档位信息量大。
                expectedIndex: { type: 'number' },
                // 档位取自 probabilities 的 argmax，还是旧的回退 round(score)。
                levelSource: { type: 'string' },
              },
              required: ['path', 'level', 'score'],
              additionalProperties: false,
            },
          },
          stats: {
            type: 'object',
            properties: {
              scanned: { type: 'integer' },
              dirs: { type: 'integer' },
              failed: { type: 'integer' },
              failedPaths: { type: 'array', items: { type: 'string' } },
              tieRatio: { type: 'number' },
              inputTokens: { type: 'integer' },
              elapsedMs: { type: 'integer' },
            },
            required: ['scanned', 'dirs', 'failed', 'failedPaths', 'tieRatio', 'inputTokens', 'elapsedMs'],
            additionalProperties: false,
          },
        },
        required: ['text', 'candidates', 'stats'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value?.text ?? '' }],
    },
    // 只读目录 + 无共享状态，可与其它调用并行。
    isConcurrencySafe: () => true,
    // 逐文件一次请求，几百个文件按并发 6 估算需要数分钟。
    timeoutMs: 900000,
    async execute(args, exec) {
      return runScreen(ctx, cfg, args, exec)
    },
  })))
}
