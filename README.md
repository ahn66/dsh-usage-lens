# dsh-usage-lens

[![tests](https://github.com/ahn66/dsh-usage-lens/actions/workflows/tests.yml/badge.svg)](https://github.com/ahn66/dsh-usage-lens/actions/workflows/tests.yml)

一个内嵌在 DeepSeek Harness（DSH）会话界面里的**用量与过程可观测性插件**：状态条显示今日 Token 与花费，点开是「本次询问明细 / 今日用量 / 执行过程」三块面板，底层是一份按次调用的 JSONL 账本。

> **English** — `dsh-usage-lens` is a plugin for [DeepSeek Harness](https://github.com/deepseek-ai): it intercepts `llm/stream`, settles one JSONL ledger row per assistant call from the provider's authoritative usage, attributes calls to real `turn`/`step` through `session/event`, prices each Beijing calendar day with an overridable table, and renders one status cell in the shipped composer stats row plus a three-block detail panel (this turn, today, execution process). 372 self checks, no dependencies, MIT. Design notes are in [`dsh-usage-lens/README.md`](dsh-usage-lens/README.md).

- 不新增独立窗口：状态条嵌在 DSH 自带的 `conversation.composer.dock` 统计行右侧，不新增行。
- 账本只存 token 分桶与元数据，**不存金额**；金额按当前价格表在渲染时计算，所以调价会回溯历史而不是篡改历史。
- 一次 `assistant/message` 调用 = 一条账本记录；token 以 provider 上报的 `usage` 为准，绝不累加 `assistant/chunk` 里的片段。
- 每日按北京时间自然日切分，峰谷按北京时间规则判定。

## 四个切片做了什么

| 切片 | 内容 |
|---|---|
| 1 | `llm/stream` 拦截 → 真实 usage 结算 → JSONL 账本 → 状态条「今日 Token / 今日花费」 |
| 2 | 接入 `session/event`：真实 `turn/step` 归属 + 按轮聚合卡与逐次展开 |
| 3 | 「执行过程」：吸顶置顶层（Skill 加载 / 工具失败 / 审批拒绝 / 子 Agent）、折叠过程流、按需原始层；Skill 以**冻结请求**为准交叉验证 |
| 4 | 「今日用量」：24 小时堆叠趋势、缓存命中率、请求次数、会话累计；价格表覆盖与「自定义价格」标注；按大小轮转账本 |

详细设计与内部约定见 [`dsh-usage-lens/README.md`](dsh-usage-lens/README.md)，最初的开发约定见 [`AGENTS.md`](AGENTS.md)。

## 目录

```
dsh-usage-lens/         插件本体（Host 半边 index.js + lib/*，Client 半边 client.js）
  lib/                  time · pricing · ledger · day · turns · skill-parse · aggregator
                        · process · http · 三条路由 · stream-interceptor
  test/                 9 个套件，372 项自检（node test/*.test.mjs，无框架）
  locale/ icon.svg      插件管理页的标题/描述/图标
tools/                  独立核对脚本（手算对账、会话日志比对、现场查看）
AGENTS.md               项目约定（硬性口径与模块划分）
```

## 安装

这是一个本地 bundle，用 DSH 的插件管理器安装（不要手写 profile 的 `package.json`）：

```text
plugin_manager install_bundle  target = <仓库目录>/dsh-usage-lens
```

装好后**刷新一次页面**。状态条出现在输入框下方那条窄信息行的最右端，形如 `◔ 今日 188M tok · ¥6.19`，点它展开面板。

## 配置

写进 profile 的 `cordis.patch.yml`，保存即热重载：

```yaml
- id: usage-lens
  name: dsh-usage-lens
  config:
    ledgerDir: 'F:\Users\me\.dsh\usage-lens'   # 默认 <DSH_HOME>/usage-lens
    ledgerMaxBytes: 8388608                    # 按大小轮转；0 = 只按月
    timeZone: 'Asia/Shanghai'
    pricing:
      version: 'team-2026-11'                  # 声明了版本就按它标注
      holidays: ['2026-10-01']                 # 法定节假日不算高峰
      models:
        deepseek-v4-pro:
          peak: { output: 27 }                 # 部分覆盖内置快照
        'acme/*':
          offPeak: { cacheHit: 0, cacheMiss: 3, output: 9 }
        deepseek-flash: null                   # 删除条目 → 该模型变未定价
```

未声明版本却改了价格，UI 标注为「自定义价格」，不会冒充内置版本；未定价模型的 token 照常统计、花费显示「未定价」，总额标注为下界（`≥`）。

## 数据

- 账本：`<DSH_HOME>/usage-lens/ledger-YYYY-MM.jsonl`（活跃）+ `ledger-YYYY-MM.NNNN.jsonl`（轮转归档，**只读**）。
- 轮转不丢历史：查询层会按「归档（旧→新）→ 活跃文件」顺序读完整月。

## 自查

```powershell
# 插件自检（9 个套件 / 372 项）
node dsh-usage-lens/test/logic.test.mjs
node dsh-usage-lens/test/interceptor.test.mjs
node dsh-usage-lens/test/turns.test.mjs
node dsh-usage-lens/test/process.test.mjs
node dsh-usage-lens/test/day.test.mjs
node dsh-usage-lens/test/client-render.test.mjs
node dsh-usage-lens/test/panel.test.mjs
node dsh-usage-lens/test/process-ui.test.mjs
node dsh-usage-lens/test/today-ui.test.mjs

# 独立核对（不导入插件代码）
node tools/check-day.mjs "<DSH_HOME>/usage-lens"   # 用硬编码价格表手算，与接口对账
node tools/check-today.mjs                         # 日折叠 + 账本分段
node tools/check-turn.mjs <sessionId> [turn]       # 卡片 vs 展开行求和
node tools/check-process.mjs <sessionId>           # 置顶层 + 过程流
node tools/verify-turns.mjs <ledger> <session.v4.jsonl.zstd>
node tools/verify-ledger.mjs <ledger> <session.v4.jsonl.zstd>
```

## 已知限制

- 「执行过程」的工具名、输入输出摘要、Skill 正文是**内存索引**：Host 重载后会丢（token 与 turn/step 仍在账本里）。
- 原始层有硬上限：参数 4 KB、结果与 Skill 正文 8 KB，超出标记 truncated。
- 不接入自动价格同步（有意为之）；节假日表默认空，因为不猜国务院日历。

## License

MIT
