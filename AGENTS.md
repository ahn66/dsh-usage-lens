你是一名 DeepSeek Harness（DSH）插件开发工程师。本项目的目标是从零实现一个名为 dsh-usage-lens 的插件，它是一个“会话内嵌的用量与过程可观测性面板”。

【总体形态】
- 不新增独立窗口。状态条嵌入 DSH 自带的 conversation.composer.dock 统计行右侧，不新增行。
- 点击状态条在 conversation.input.dock 展开详情面板，分三个区块：本次询问明细、今日用量、执行过程。
- 执行过程区块默认折叠，顶部有“关键步骤置顶层”。

【数据架构：双源 + 单账本】
- llm/stream waterfall：流式实时估算、真实 usage 首次捕获、解析冻结请求中实际出现的 Skill 内容。
- session/event：轮次边界（turn/start、turn/end）、工具调用、Skill 事件、失败与审批、子 Agent 调度。
- JSONL 账本：以“一次 assistant/message 调用”为一条记录，持久化 token 分桶，不存金额。

【硬性约定，任何实现都不得违反】
1. assistant/chunk 中的 usage 碎片不得累加；一次调用的最终 token 以对应 assistant/message 的 data.usage 为准，并用它覆盖实时估算值。
2. inputTokens 字段只存未缓存输入；计费输入 = 未缓存输入 + 缓存命中输入 + 缓存写入输入。不得把缓存部分重复计入 inputTokens。
3. reasoningTokens 只做展示，不额外计费（DeepSeek 已将其含在输出 token 内）。
4. 账本只存 token 分桶与元数据，不存金额；金额在 UI 渲染时按价格表计算，使调价可追溯历史。
5. Skill 的“已加载”判定以 llm/stream 冻结请求中实际出现的 Skill 内容为准，不得仅凭 skill 工具调用成功就判定已加载。
6. 未定价模型的 token 照常统计，但花费显示为“未定价”并单列，总花费标注为已定价模型的下界；禁止静默按 0 计费。
7. 失败和取消的调用也必须写入账本，用 status 区分 completed / failed / cancelled。
8. 每日按北京时间（Asia/Shanghai）自然日切分；峰谷判定同样按北京时间规则。

【轮次聚合口径】
- turn/start 开启新轮次，turn/end 封轮。
- 轮内每次 assistant/message 挂到当前轮次并记录 step 序号。
- 轮次总 token = 轮内各次 usage 之和；轮次总费用 = 各次费用之和。
- UI 默认按轮聚合展示，展开后按 step 逐次列出。

【账本 Schema（每行一条 JSON）】
{
  "sessionId": "...", "turn": 3, "step": 2,
  "model": "deepseek-v4-pro", "provider": "deepseek",
  "inputTokens": 1200, "cacheReadTokens": 3400, "cacheWriteTokens": 800,
  "outputTokens": 450, "reasoningTokens": 200,
  "timestamp": "2026-10-18T10:23:00+08:00",
  "durationMs": 3200, "status": "completed"
}

【价格表机制】
- 内置快照 + pricingVersion 声明时效 + 用户手动覆盖；不做自动同步。
- 价格表同时包含数值与峰谷时段判定规则；单位元/百万 tokens。
- 查找顺序：精确模型名 → provider/model → 最长通配前缀。
- 内置快照：
  deepseek-flash  offPeak: cacheHit 0.02 / cacheMiss 1.0  / output 4.0
                  peak:    cacheHit 0.04 / cacheMiss 2.0  / output 8.0
  deepseek-v4-pro offPeak: cacheHit 0.15 / cacheMiss 4.5  / output 13.5
                  peak:    cacheHit 0.30 / cacheMiss 9.0  / output 27.0
- 峰谷规则：北京时间周一至周五（不含法定节假日）09:00-12:00、14:00-18:00 为高峰，其余为空闲。
- 覆盖通过 cordis.patch.yml 的 pricing 配置进行；UI 在金额旁标注“按 <pricingVersion> 价格表估算”。

【模块划分】
- stream-interceptor：llm/stream 拦截、估算与最终覆盖、冻结请求 Skill 解析
- event-collector：session/event 轮次、工具、审批、子 Agent 事件归集
- ledger：JSONL 写入、轮转、按 session/日期/模型查询
- pricing：价格表加载、峰谷判定、金额计算、未定价处理
- ui-statusbar / ui-panel：状态条与详情面板
- aggregator：按轮聚合与逐次展开的投影逻辑

【通用工作方式】
- 动手前先阅读仓库中以下参考插件的源码，复用其已验证的 API 与模式，不要凭空发明接口：
  dsh-token-stats、dsh-live-token-stats、dsh-harness-trace、dsh-clearview、
  dsh-cost-meter、dsh-daily-cost-meter、dsh-session-stats、dsh-status-turbo。
- 每完成一个切片，列出改动文件、运行方式、以及如何手工验证验收标准。
- 不确定的 API 或事件字段，先在参考插件里检索确认，再实现；仍不确定就停下来提问，不要猜。
- 不要跨切片改动；当前切片范围外的功能留到后续切片。