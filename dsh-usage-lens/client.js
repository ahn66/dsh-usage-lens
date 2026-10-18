/**
 * dsh-usage-lens — Client half.
 *
 * Two cells of one feature:
 * - `conversation.composer.dock`, order 10: the status pill, to the right of the
 *   shipped activity and usage pills, inside the same single row.
 * - `conversation.input.dock`, order 15: the detail panel this pill toggles.
 *   That slot renders as a full-width block *before* the composer card in the
 *   composer stack, so an open panel pushes the input down instead of covering
 *   it, and its body scrolls instead of growing without bound.
 *
 * Inside the panel, "本次询问明细" lists one aggregated card per turn and
 * "执行过程" carries the three-layer execution view: a sticky pinned key-step
 * layer, a folded process flow, and an on-demand raw layer.
 *
 * Both cells read Host-computed documents over the package's JSON routes; the
 * Client never folds session events and never invents an amount.
 *
 * @module dsh-usage-lens/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-usage-lens',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Host route behind the status pill. */
    const STATUS_PATH = '/plugins/dsh-usage-lens/today'
    /** Host route behind the detail panel. */
    const SESSION_PATH = '/plugins/dsh-usage-lens/session'
    /** Host route behind the raw layer; fetched only on request. */
    const RAW_PATH = '/plugins/dsh-usage-lens/raw'
    /** Poll cadence: a small local JSON document, one request in flight. */
    const POLL_MS = 8000

    const STYLE =
      '.dsh-usage-lens-anchor{min-width:0;max-width:100%;overflow:hidden;'
      + 'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);'
      + 'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));'
      + 'display:inline-flex;flex:0 1 auto}'
      + '.dsh-usage-lens-pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);'
      + 'max-width:100%;min-width:0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));'
      + 'font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;'
      + 'background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}'
      + '.dsh-usage-lens-pill svg{flex:none;width:14px;height:14px}'
      + 'button.dsh-usage-lens-pill{cursor:pointer}'
      + 'button.dsh-usage-lens-pill:hover,button.dsh-usage-lens-pill[aria-expanded="true"]{'
      + 'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}'
      + '.dsh-usage-lens-label{text-overflow:ellipsis;min-width:0;overflow:hidden}'

      + '.dsh-usage-lens-panel{box-sizing:border-box;flex:none;margin:0 auto;'
      + 'width:calc(100% - 2 * var(--dsh-composer-side-clearance,16px));'
      + 'max-width:calc(var(--dsh-composer-card-max-width,920px) - 2 * var(--dsh-composer-dock-inset,8px));'
      + 'border-radius:var(--dsw-radius-lg);border:1px solid var(--dsw-alias-border-l1);'
      + 'background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel,none);'
      + '--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);'
      + '--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);overflow:hidden}'
      + '.dsh-usage-lens-panel-head{align-items:center;gap:8px;padding:8px 12px;display:flex;'
      + 'border-bottom:1px solid var(--dsw-alias-border-l1)}'
      + '.dsh-usage-lens-panel-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;'
      + 'line-height:20px;flex:none}'
      + '.dsh-usage-lens-panel-note{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;'
      + 'line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}'
      + '.dsh-usage-lens-panel-close{flex:none;cursor:pointer;border:none;background:0 0;'
      + 'border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);'
      + 'font:inherit;font-size:13px;line-height:20px;padding:0 6px}'
      + '.dsh-usage-lens-panel-close:hover{background:var(--dsw-alias-bg-layer-2);'
      + 'color:var(--dsw-alias-label-secondary)}'
      + '.dsh-usage-lens-panel-body{box-sizing:border-box;max-height:min(52vh,460px);overflow-y:auto;'
      + 'overscroll-behavior:contain;scrollbar-gutter:stable;display:flex;flex-direction:column;'
      + 'gap:6px;padding:6px}'
      + '.dsh-usage-lens-panel-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;'
      + 'line-height:20px;padding:6px 8px}'

      + '.dsh-usage-lens-turn{flex:none;border-radius:var(--dsw-radius-sm);'
      + 'border:1px solid var(--dsw-alias-border-l1);overflow:hidden}'
      + '.dsh-usage-lens-turn-head{cursor:pointer;text-align:left;width:100%;border:none;'
      + 'background:0 0;color:inherit;font:inherit;display:flex;flex-wrap:wrap;align-items:baseline;'
      + 'gap:4px 10px;padding:6px 8px}'
      + '.dsh-usage-lens-turn-head:hover{background:var(--dsw-alias-bg-layer-2)}'
      + '.dsh-usage-lens-turn-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;'
      + 'line-height:20px;flex:none}'
      + '.dsh-usage-lens-turn-meta{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;'
      + 'line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}'
      + '.dsh-usage-lens-turn-tokens,.dsh-usage-lens-turn-cost{flex:none;font-size:12px;line-height:20px;'
      + 'color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}'
      + '.dsh-usage-lens-turn-chevron{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;'
      + 'line-height:20px;width:12px;text-align:center}'
      + '.dsh-usage-lens-badge{flex:none;border-radius:var(--dsw-radius-sm);font-size:11px;'
      + 'line-height:16px;padding:1px 6px;border:1px solid var(--dsw-alias-border-l1);'
      + 'color:var(--dsw-alias-label-tertiary)}'
      + '.dsh-usage-lens-badge[data-tone="open"]{color:var(--dsw-alias-brand-primary);'
      + 'border-color:var(--dsw-alias-brand-primary)}'
      + '.dsh-usage-lens-badge[data-tone="failed"]{color:var(--dsw-alias-state-error-primary);'
      + 'border-color:var(--dsw-alias-state-error-primary)}'

      + '.dsh-usage-lens-steps{display:flex;flex-direction:column;gap:2px;padding:2px 8px 6px;'
      + 'border-top:1px solid var(--dsw-alias-border-l1)}'
      + '.dsh-usage-lens-step{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px;'
      + 'padding:3px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}'
      + '.dsh-usage-lens-step:last-child{border-bottom:none}'
      + '.dsh-usage-lens-step-no{flex:none;color:var(--dsw-alias-label-primary);font-size:12px;'
      + 'line-height:20px;font-variant-numeric:tabular-nums;min-width:32px}'
      + '.dsh-usage-lens-step-model{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;'
      + 'line-height:20px}'
      + '.dsh-usage-lens-step-tokens{min-width:0;flex:1 1 auto;color:var(--dsw-alias-label-tertiary);'
      + 'font-size:12px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
      + 'font-variant-numeric:tabular-nums}'
      + '.dsh-usage-lens-step-cost{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;'
      + 'line-height:20px;font-variant-numeric:tabular-nums}'
      + '.dsh-usage-lens-step-status{flex:none;font-size:11px;line-height:20px;'
      + 'color:var(--dsw-alias-label-tertiary)}'
      + '.dsh-usage-lens-step-status[data-status="failed"]{color:var(--dsw-alias-state-error-primary)}'
      + '.dsh-usage-lens-step-status[data-status="cancelled"]{color:var(--dsw-alias-state-warn-primary)}'
      + '.dsh-usage-lens-step-tools{flex:0 1 auto;min-width:0;color:var(--dsw-alias-label-tertiary);'
      + 'font-size:11px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'

      // --- execution process: section, sticky pins, folded flow, raw layer --
      + '.dsh-usage-lens-process{flex:none;border-radius:var(--dsw-radius-sm);'
      + 'border:1px solid var(--dsw-alias-border-l1);overflow:hidden}'
      + '.dsh-usage-lens-process-head{cursor:pointer;text-align:left;width:100%;border:none;'
      + 'background:0 0;color:inherit;font:inherit;display:flex;flex-wrap:wrap;align-items:baseline;'
      + 'gap:4px 10px;padding:6px 8px}'
      + '.dsh-usage-lens-process-head:hover{background:var(--dsw-alias-bg-layer-2)}'
      + '.dsh-usage-lens-process-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;'
      + 'line-height:20px;flex:none}'
      + '.dsh-usage-lens-process-meta{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;'
      + 'line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}'
      // Sticky inside the panel body's scroll container: the pinned key steps
      // stay reachable however far the flow is scrolled.
      + '.dsh-usage-lens-pins{position:sticky;top:0;z-index:2;display:flex;flex-direction:column;'
      + 'gap:2px;padding:4px;background:var(--dsw-alias-bg-layer-1);'
      + 'border-bottom:1px solid var(--dsw-alias-border-l1)}'
      + '.dsh-usage-lens-pin{cursor:pointer;text-align:left;width:100%;border:none;background:0 0;'
      + 'font:inherit;color:inherit;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;'
      + 'border-radius:var(--dsw-radius-sm);padding:2px 6px;min-width:0}'
      + '.dsh-usage-lens-pin:hover{background:var(--dsw-alias-bg-layer-2)}'
      + '.dsh-usage-lens-pin-badge{flex:none;font-size:11px;line-height:16px;padding:0 6px;'
      + 'border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l1);'
      + 'color:var(--dsw-alias-label-tertiary)}'
      + '.dsh-usage-lens-pin[data-tone="ok"] .dsh-usage-lens-pin-badge{color:var(--dsw-alias-state-success-primary);'
      + 'border-color:var(--dsw-alias-state-success-primary)}'
      + '.dsh-usage-lens-pin[data-tone="error"] .dsh-usage-lens-pin-badge{color:var(--dsw-alias-state-error-primary);'
      + 'border-color:var(--dsw-alias-state-error-primary)}'
      + '.dsh-usage-lens-pin[data-tone="warn"] .dsh-usage-lens-pin-badge{color:var(--dsw-alias-state-warn-primary);'
      + 'border-color:var(--dsw-alias-state-warn-primary)}'
      + '.dsh-usage-lens-pin-label{min-width:0;flex:0 1 auto;color:var(--dsw-alias-label-secondary);'
      + 'font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
      + '.dsh-usage-lens-pin-detail{min-width:0;flex:1 1 60px;color:var(--dsw-alias-label-tertiary);'
      + 'font-size:11px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'

      + '.dsh-usage-lens-flow{display:flex;flex-direction:column;gap:2px;padding:4px}'
      + '.dsh-usage-lens-flow-step{border-radius:var(--dsw-radius-sm);'
      + 'border:1px solid var(--dsw-alias-border-l1);overflow:hidden}'
      + '.dsh-usage-lens-flow-head{cursor:pointer;text-align:left;width:100%;border:none;background:0 0;'
      + 'color:inherit;font:inherit;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px;'
      + 'padding:4px 8px}'
      + '.dsh-usage-lens-flow-head:hover{background:var(--dsw-alias-bg-layer-2)}'
      + '.dsh-usage-lens-flow-no{flex:none;color:var(--dsw-alias-label-primary);font-size:12px;'
      + 'line-height:20px;font-variant-numeric:tabular-nums;min-width:52px}'
      + '.dsh-usage-lens-flow-tools{min-width:0;flex:1 1 auto;color:var(--dsw-alias-label-secondary);'
      + 'font-size:12px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
      + '.dsh-usage-lens-flow-time,.dsh-usage-lens-flow-tokens{flex:none;font-size:12px;line-height:20px;'
      + 'color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}'
      + '.dsh-usage-lens-flow-badge{flex:none;font-size:11px;line-height:16px;padding:0 6px;'
      + 'border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-state-error-primary);'
      + 'color:var(--dsw-alias-state-error-primary)}'
      + '.dsh-usage-lens-flow-body{display:flex;flex-direction:column;gap:4px;padding:4px 8px 6px;'
      + 'border-top:1px solid var(--dsw-alias-border-l1)}'
      + '.dsh-usage-lens-flow-reasoning{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;'
      + 'line-height:18px;overflow-wrap:anywhere}'
      + '.dsh-usage-lens-tool{display:flex;flex-direction:column;gap:2px;padding:3px 0;'
      + 'border-top:1px dashed var(--dsw-alias-border-l1)}'
      + '.dsh-usage-lens-tool:first-child{border-top:none}'
      + '.dsh-usage-lens-tool-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px}'
      + '.dsh-usage-lens-tool-name{flex:none;color:var(--dsw-alias-label-primary);font-size:12px;'
      + 'line-height:18px}'
      + '.dsh-usage-lens-tool-time{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;'
      + 'line-height:18px}'
      + '.dsh-usage-lens-tool-error{flex:none;color:var(--dsw-alias-state-error-primary);font-size:11px;'
      + 'line-height:18px}'
      + '.dsh-usage-lens-tool-ios{min-width:0;display:flex;flex-direction:column;gap:1px}'
      + '.dsh-usage-lens-tool-io{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:11px;'
      + 'line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
      + 'font-family:var(--dsw-font-family-mono,monospace)}'
      + '.dsh-usage-lens-raw-toggle{flex:none;cursor:pointer;border:none;background:0 0;'
      + 'color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:16px;'
      + 'padding:0 4px;border-radius:var(--dsw-radius-sm);text-decoration:underline}'
      + '.dsh-usage-lens-raw-toggle:hover{background:var(--dsw-alias-bg-layer-2);'
      + 'color:var(--dsw-alias-label-secondary)}'
      + '.dsh-usage-lens-raw{box-sizing:border-box;margin:0;padding:6px;max-height:180px;overflow:auto;'
      + 'border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);'
      + 'color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;'
      + 'font-family:var(--dsw-font-family-mono,monospace);white-space:pre-wrap;overflow-wrap:anywhere}'

      // --- today block: stats, hour trend, legend --------------------------
      + '.dsh-usage-lens-today{flex:none;border-radius:var(--dsw-radius-sm);'
      + 'border:1px solid var(--dsw-alias-border-l1);overflow:hidden}'
      + '.dsh-usage-lens-today-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;'
      + 'padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}'
      + '.dsh-usage-lens-today-title{flex:none;color:var(--dsw-alias-label-primary);font-size:13px;'
      + 'font-weight:500;line-height:20px}'
      + '.dsh-usage-lens-today-note{min-width:0;flex:1 1 auto;color:var(--dsw-alias-label-tertiary);'
      + 'font-size:12px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
      + '.dsh-usage-lens-today-body{display:flex;flex-direction:column;gap:4px;padding:6px 8px}'
      + '.dsh-usage-lens-today-stat{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 12px;'
      + 'font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);'
      + 'font-variant-numeric:tabular-nums}'
      + '.dsh-usage-lens-today-stat strong{font-weight:500;color:var(--dsw-alias-label-primary)}'
      + '.dsh-usage-lens-hours{display:flex;align-items:flex-end;gap:1px;height:56px;margin-top:2px}'
      + '.dsh-usage-lens-hour{flex:1 1 0;min-width:0;height:100%;display:flex;align-items:flex-end;'
      + 'justify-content:center;border-radius:2px;background:var(--dsw-alias-bg-layer-2)}'
      + '.dsh-usage-lens-hour[data-peak="true"]{background:var(--dsw-alias-bg-base)}'
      + '.dsh-usage-lens-hour-stack{display:flex;flex-direction:column-reverse;width:100%;'
      + 'min-height:0;border-radius:2px;overflow:hidden}'
      + '.dsh-usage-lens-seg{display:block;width:100%;flex:none;background:var(--dsw-alias-brand-primary)}'
      + '.dsh-usage-lens-seg[data-bucket="input"]{opacity:1}'
      + '.dsh-usage-lens-seg[data-bucket="cacheRead"]{opacity:.72}'
      + '.dsh-usage-lens-seg[data-bucket="cacheWrite"]{opacity:.5}'
      + '.dsh-usage-lens-seg[data-bucket="output"]{opacity:.3}'
      + '.dsh-usage-lens-hours-axis{display:flex;justify-content:space-between;'
      + 'color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px}'
      + '.dsh-usage-lens-today-legend{display:flex;flex-wrap:wrap;gap:2px 10px;'
      + 'color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}'
      + '.dsh-usage-lens-swatch{display:inline-block;width:8px;height:8px;margin-right:4px;'
      + 'border-radius:2px;background:var(--dsw-alias-brand-primary)}'

    const DICT = {
      zh: {
        // status pill
        tokens: '今日 {count} tok',
        approximateTokens: '今日 ≈{count} tok',
        unpriced: '未定价',
        lowerBound: '≥{amount} 未定价',
        title: '今日用量 · 北京时间 {date}',
        titleTokens: 'Token 总量 {total}（未缓存输入 {input} · 缓存命中 {cacheRead} · 缓存写入 {cacheWrite} · 输出 {output}）',
        titleLive: '含实时估算 ≈{count} tokens（流式进行中）',
        titleCost: '按 {version} 价格表估算',
        titleUnpriced: '另有 {calls} 次调用为未定价模型（{models}；{tokens} tokens 未计费），总花费为已定价模型的下界',
        titleStale: '状态接口暂不可用，显示最近一次成功读取',
        ariaLabel: '今日 Token {count}，花费 {cost}',
        pillHint: '点击查看本次询问明细',
        unavailable: '用量不可用',
        // detail panel
        panelTitle: '本次询问明细',
        panelPricing: '按 {version} 价格表估算',
        panelEmpty: '还没有可显示的调用',
        panelClose: '收起',
        panelStale: '面板接口暂不可用，显示最近一次成功读取',
        turnTitle: '第 {turn} 轮',
        turnUnattributed: '未归属轮次',
        turnCalls: '{count} 次调用',
        turnTools: '{count} 个工具',
        turnOpen: '进行中',
        turnFailed: '{count} 次异常',
        stepTitle: '第 {step} 步',
        bucketInput: '入',
        bucketCacheRead: '缓存读',
        bucketCacheWrite: '缓存写',
        bucketOutput: '出',
        bucketReasoning: '推理',
        statusCompleted: '完成',
        statusFailed: '失败',
        statusCancelled: '已取消',
        expand: '展开',
        collapse: '收起',
        // execution process
        processTitle: '执行过程',
        processMeta: '{steps} 步 · {pins} 个置顶',
        processEmpty: '这一轮还没有可显示的执行步骤',
        processTurn: '第 {turn} 轮',
        flowStep: '第 {step} 步',
        flowThink: '思考',
        flowReasoningLabel: '思考摘要',
        flowInput: '输入',
        flowOutput: '输出',
        flowEmptyIO: '（无摘要）',
        rawToggle: '查看原始',
        rawToggleClose: '收起原始',
        rawLoading: '读取中…',
        rawFailed: '原始数据不可用',
        rawTruncated: '（已截断）',
        pinSkillLoaded: 'Skill 已加载',
        pinSkillIneffective: 'Skill 调用未生效',
        pinToolError: '工具失败',
        pinApprovalAsked: '需人工审批',
        pinApprovalAllowed: '审批已允许',
        pinApprovalDenied: '审批拒绝',
        pinPermissionDenied: '权限拒绝',
        pinSubagent: '子 Agent 调度',
        pinBadgeSkill: 'Skill',
        pinBadgeTool: '失败',
        pinBadgeApproval: '审批',
        pinBadgePermission: '权限',
        pinBadgeSubagent: '子 Agent',
        pinIneffectiveDetail: '工具调用成功，但后续冻结请求中未出现该 Skill 内容',
        jumpToStep: '跳到第 {step} 步',
        // pricing label + today block
        pricingVersion: '按 {version} 价格表估算',
        pricingCustom: '自定义价格',
        todayTitle: '今日用量',
        todayDay: '北京时间 {date}',
        todayCalls: '请求 {count} 次',
        todayHitRate: '缓存命中率 {percent}',
        todayHitRateEmpty: '缓存命中率 —',
        todaySession: '会话累计 {tokens} tok / {cost}',
        todayLegend: '按小时堆叠：输入 / 缓存命中 / 缓存写入 / 输出',
        todayEmpty: '今天还没有调用',
        hourTitle: '{hour}:00 · {tokens} tok · {calls} 次调用',
        peakMark: '高峰',
      },
      en: {
        tokens: 'Today {count} tok',
        approximateTokens: 'Today ≈{count} tok',
        unpriced: 'unpriced',
        lowerBound: '≥{amount} unpriced',
        title: 'Today · Beijing {date}',
        titleTokens: 'Total tokens {total} (uncached input {input} · cache read {cacheRead} · cache write {cacheWrite} · output {output})',
        titleLive: 'Includes a live estimate of ≈{count} tokens (streaming now)',
        titleCost: 'Estimated with pricing table {version}',
        titleUnpriced: '{calls} call(s) used unpriced models ({models}; {tokens} tokens billed at zero), so the total is a lower bound over priced models',
        titleStale: 'Status route unavailable; showing the last successful read',
        ariaLabel: 'Today {count} tokens, cost {cost}',
        pillHint: 'Open this request’s detail',
        unavailable: 'usage unavailable',
        panelTitle: 'This request',
        panelPricing: 'Estimated with pricing table {version}',
        panelEmpty: 'No calls recorded yet',
        panelClose: 'Close',
        panelStale: 'Panel route unavailable; showing the last successful read',
        turnTitle: 'Turn {turn}',
        turnUnattributed: 'Unattributed',
        turnCalls: '{count} call(s)',
        turnTools: '{count} tool(s)',
        turnOpen: 'running',
        turnFailed: '{count} abnormal',
        stepTitle: 'Step {step}',
        bucketInput: 'in',
        bucketCacheRead: 'cache read',
        bucketCacheWrite: 'cache write',
        bucketOutput: 'out',
        bucketReasoning: 'reasoning',
        statusCompleted: 'done',
        statusFailed: 'failed',
        statusCancelled: 'cancelled',
        expand: 'Expand',
        collapse: 'Collapse',
        processTitle: 'Execution process',
        processMeta: '{steps} step(s) · {pins} pinned',
        processEmpty: 'No execution steps recorded for this turn yet',
        processTurn: 'Turn {turn}',
        flowStep: 'Step {step}',
        flowThink: 'thinking',
        flowReasoningLabel: 'Reasoning summary',
        flowInput: 'input',
        flowOutput: 'output',
        flowEmptyIO: '(no summary)',
        rawToggle: 'View raw',
        rawToggleClose: 'Hide raw',
        rawLoading: 'Loading…',
        rawFailed: 'Raw data unavailable',
        rawTruncated: ' (truncated)',
        pinSkillLoaded: 'Skill loaded',
        pinSkillIneffective: 'Skill call had no effect',
        pinToolError: 'Tool failed',
        pinApprovalAsked: 'Needs approval',
        pinApprovalAllowed: 'Approval granted',
        pinApprovalDenied: 'Approval denied',
        pinPermissionDenied: 'Permission denied',
        pinSubagent: 'Sub-agent dispatched',
        pinBadgeSkill: 'Skill',
        pinBadgeTool: 'fail',
        pinBadgeApproval: 'approval',
        pinBadgePermission: 'permission',
        pinBadgeSubagent: 'sub-agent',
        pinIneffectiveDetail: 'The tool call succeeded, but the skill never appeared in a later frozen request',
        jumpToStep: 'Jump to step {step}',
        pricingVersion: 'Estimated with pricing table {version}',
        pricingCustom: 'Custom pricing',
        todayTitle: 'Today',
        todayDay: 'Beijing {date}',
        todayCalls: '{count} call(s)',
        todayHitRate: 'cache hit {percent}',
        todayHitRateEmpty: 'cache hit —',
        todaySession: 'Session {tokens} tok / {cost}',
        todayLegend: 'Stacked by hour: input / cache read / cache write / output',
        todayEmpty: 'No calls today yet',
        hourTitle: '{hour}:00 · {tokens} tok · {calls} call(s)',
        peakMark: 'peak',
      },
    }

    const exactNumber = new Intl.NumberFormat('en-US')

    function exact(value) {
      return exactNumber.format(Number.isFinite(value) ? value : 0)
    }

    function trimDecimal(value) {
      return String(Number(value.toFixed(1)))
    }

    /** Compact token count: `987`, `12.3k`, `1.2M`. */
    function formatTokens(value) {
      const n = Number.isFinite(value) ? Math.max(0, value) : 0
      if (n < 1000) return String(Math.round(n))
      if (n < 1_000_000) return `${trimDecimal(n / 1000)}k`
      return `${trimDecimal(n / 1_000_000)}M`
    }

    /** Money kept legible below one yuan: `¥0.0123`, `¥0.512`, `¥12.35`. */
    function formatMoney(value) {
      const n = Number.isFinite(value) && value > 0 ? value : 0
      if (n === 0) return '¥0.00'
      if (n < 0.0001) return '¥<0.0001'
      if (n < 0.1) return `¥${n.toFixed(4)}`
      if (n < 1) return `¥${n.toFixed(3).replace(/0$/u, '')}`
      return `¥${n.toFixed(2)}`
    }

    /** Compact duration: `820ms`, `3.2s`, `1m 12s`. */
    function formatDuration(value) {
      const ms = Number.isFinite(value) && value > 0 ? value : 0
      if (ms === 0) return '—'
      if (ms < 1000) return `${Math.round(ms)}ms`
      if (ms < 60_000) return `${trimDecimal(ms / 1000)}s`
      const minutes = Math.floor(ms / 60_000)
      return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`
    }

    function activeLanguage(localeService) {
      try {
        const active = localeService?.getLocale?.()?.active
        if (typeof active === 'string' && active !== '') return active.startsWith('zh') ? 'zh' : 'en'
      } catch {
        // An unavailable locale service falls through to the default language.
      }
      return 'zh'
    }

    function makeTranslate(localeService) {
      const dict = DICT[activeLanguage(localeService)]
      return (key, variables) => {
        let text = dict[key] ?? DICT.en[key] ?? key
        if (variables !== undefined) {
          for (const [name, value] of Object.entries(variables)) {
            text = text.split(`{${name}}`).join(String(value))
          }
        }
        return text
      }
    }

    /** A lens over a minus: "read this figure closely". */
    function UsageLensIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          'aria-hidden': true,
        },
        h('circle', { cx: 7, cy: 7, r: 4.3 }),
        h('path', { d: 'M10.3 10.3 13.5 13.5' }),
        h('path', { d: 'M5 7h4' }),
      )
    }

    /** Which session's panel is open. One Client run owns one store. */
    function createPanelStore() {
      const open = new Set()
      const listeners = new Set()
      const notify = () => {
        for (const listener of [...listeners]) listener()
      }
      return {
        isOpen(sessionId) {
          return typeof sessionId === 'string' && open.has(sessionId)
        },
        toggle(sessionId) {
          if (typeof sessionId !== 'string') return
          if (open.has(sessionId)) open.delete(sessionId)
          else open.add(sessionId)
          notify()
        },
        close(sessionId) {
          if (typeof sessionId !== 'string') return
          if (open.delete(sessionId)) notify()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
    }

    /** Fetch one Host JSON document, with a poll loop that never overlaps. */
    function usePolledDocument(path, enabled, deps) {
      const [document, setDocument] = React.useState(null)
      const [stale, setStale] = React.useState(false)
      React.useEffect(() => {
        if (!enabled) return undefined
        let alive = true
        let busy = false
        let timer
        const run = async () => {
          if (busy) return
          busy = true
          try {
            const response = await fetch(path, {
              headers: { accept: 'application/json' },
              cache: 'no-store',
              credentials: 'same-origin',
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const body = await response.json()
            if (!alive) return
            if (body !== null && typeof body === 'object' && body.ok !== false) {
              setDocument(body)
              setStale(false)
            }
          } catch {
            if (alive) setStale(true)
          } finally {
            busy = false
            if (alive) timer = window.setTimeout(run, POLL_MS)
          }
        }
        const refreshNow = () => {
          if (!alive) return
          window.clearTimeout(timer)
          void run()
        }
        const onVisibility = () => {
          if (window.document.visibilityState === 'visible') refreshNow()
        }
        window.document.addEventListener('visibilitychange', onVisibility)
        void run()
        return () => {
          alive = false
          window.clearTimeout(timer)
          window.document.removeEventListener('visibilitychange', onVisibility)
        }
        // deps carry the path and the open flag; the loop itself is stable.
      }, deps)
      return { document, stale }
    }

    function useTranslate(localeService) {
      const [revision, setRevision] = React.useState(0)
      React.useEffect(() => {
        if (localeService === undefined || localeService === null) return undefined
        return localeService.subscribe(() => setRevision((value) => value + 1))
      }, [])
      return React.useMemo(() => makeTranslate(localeService), [revision])
    }

    function usePanelOpen(store, sessionId) {
      const [open, setOpen] = React.useState(store.isOpen(sessionId))
      React.useEffect(
        () => store.subscribe(() => setOpen(store.isOpen(sessionId))),
        [sessionId],
      )
      return open
    }

    /** Scroll one element into view when the browser can; a no-op otherwise. */
    function scrollToId(id) {
      try {
        const element = window.document.getElementById?.(id)
        if (element !== undefined && element !== null && typeof element.scrollIntoView === 'function') {
          element.scrollIntoView({ block: 'nearest' })
        }
      } catch {
        // Scrolling is a convenience; a missing element is not an error.
      }
    }

    // --- status pill -------------------------------------------------------

    function createUsageLensCell(localeService, store) {
      return function UsageLensCell(props) {
        const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined
        const t = useTranslate(localeService)
        const open = usePanelOpen(store, sessionId)
        const { document, stale } = usePolledDocument(STATUS_PATH, true, [STATUS_PATH])

        // One panel id per conversation, so two mounted sessions cannot collide.
        const panelId = sessionId === undefined
          ? 'dsh-usage-lens-panel'
          : `dsh-usage-lens-panel-${sessionId}`

        if (document === null) {
          // Before the first poll there is nothing to say, so the cell stays out
          // of the row. Once a poll has failed, vanishing would look like the
          // plugin is not installed at all; say so instead.
          if (stale !== true) return null
          return h(
            'span',
            { className: 'dsh-usage-lens-anchor', 'data-composer-stat': 'usage-lens' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-usage-lens-pill',
                title: t('titleStale'),
                'aria-label': t('unavailable'),
                'aria-expanded': open,
                'aria-controls': panelId,
                onClick: () => store.toggle(sessionId),
              },
              h(UsageLensIcon),
              h('span', { className: 'dsh-usage-lens-label' }, t('unavailable')),
            ),
          )
        }

        const today = document.today ?? {}
        const tokens = today.tokens ?? {}
        const cost = today.cost ?? {}
        const live = document.live ?? {}

        const ledgerTotal = Number.isFinite(tokens.total) ? tokens.total : 0
        const liveTokens = Number.isFinite(live.estimatedTokens) ? live.estimatedTokens : 0
        const shownTotal = ledgerTotal + liveTokens
        const pricedCalls = Number.isFinite(cost.pricedCalls) ? cost.pricedCalls : 0
        const unpricedCalls = Number.isFinite(cost.unpricedCalls) ? cost.unpricedCalls : 0
        const pricedAmount = Number.isFinite(cost.pricedAmount) ? cost.pricedAmount : 0
        const unpricedModels = Array.isArray(cost.unpricedModels) ? cost.unpricedModels : []

        const tokenLabel = liveTokens > 0
          ? t('approximateTokens', { count: formatTokens(shownTotal) })
          : t('tokens', { count: formatTokens(shownTotal) })

        let costLabel
        if (unpricedCalls > 0 && pricedCalls > 0) {
          // Part of the day is priced: the sum is a lower bound, never a total.
          costLabel = t('lowerBound', { amount: formatMoney(pricedAmount) })
        } else if (unpricedCalls > 0) {
          costLabel = t('unpriced')
        } else {
          costLabel = formatMoney(pricedAmount)
        }

        const label = `${tokenLabel} · ${costLabel}`

        const titleLines = [
          t('title', { date: String(document.date ?? '') }),
          t('titleTokens', {
            total: exact(ledgerTotal),
            input: exact(tokens.input),
            cacheRead: exact(tokens.cacheRead),
            cacheWrite: exact(tokens.cacheWrite),
            output: exact(tokens.output),
          }),
        ]
        if (liveTokens > 0) titleLines.push(t('titleLive', { count: exact(liveTokens) }))
        titleLines.push(pricingText(t, document.pricingLabel ?? {
          mode: 'builtin',
          version: String(document.pricingVersion ?? ''),
        }))
        if (unpricedCalls > 0) {
          titleLines.push(t('titleUnpriced', {
            calls: exact(unpricedCalls),
            models: unpricedModels.length > 0 ? unpricedModels.join(', ') : '-',
            tokens: exact(cost.unpricedTokens),
          }))
        }
        if (stale) titleLines.push(t('titleStale'))
        titleLines.push(t('pillHint'))

        return h(
          'span',
          { className: 'dsh-usage-lens-anchor', 'data-composer-stat': 'usage-lens' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-usage-lens-pill',
              title: titleLines.join('\n'),
              'aria-label': t('ariaLabel', { count: exact(shownTotal), cost: costLabel }),
              'aria-expanded': open,
              'aria-controls': panelId,
              onClick: () => store.toggle(sessionId),
            },
            h(UsageLensIcon),
            h('span', { className: 'dsh-usage-lens-label' }, label),
          ),
        )
      }
    }

    // --- detail panel ------------------------------------------------------

    function statusLabel(t, status) {
      if (status === 'failed') return t('statusFailed')
      if (status === 'cancelled') return t('statusCancelled')
      return t('statusCompleted')
    }

    function bucketText(t, tokens) {
      const parts = [
        `${t('bucketInput')} ${formatTokens(tokens?.input ?? 0)}`,
        `${t('bucketCacheRead')} ${formatTokens(tokens?.cacheRead ?? 0)}`,
        `${t('bucketCacheWrite')} ${formatTokens(tokens?.cacheWrite ?? 0)}`,
        `${t('bucketOutput')} ${formatTokens(tokens?.output ?? 0)}`,
      ]
      if (Number.isFinite(tokens?.reasoning) && tokens.reasoning > 0) {
        parts.push(`${t('bucketReasoning')} ${formatTokens(tokens.reasoning)}`)
      }
      return parts.join(' · ')
    }

    /** Badge text of one pinned key step. */
    function pinBadge(t, kind) {
      if (kind === 'skill-loaded' || kind === 'skill-not-effective') return t('pinBadgeSkill')
      if (kind === 'tool-error') return t('pinBadgeTool')
      if (kind === 'approval-asked' || kind === 'approval-allowed' || kind === 'approval-denied') return t('pinBadgeApproval')
      if (kind === 'permission-denied') return t('pinBadgePermission')
      return t('pinBadgeSubagent')
    }

    /** Row text of one pinned key step. */
    function pinLabel(t, pin) {
      if (pin.kind === 'skill-loaded') return `${t('pinSkillLoaded')} · ${pin.name}`
      if (pin.kind === 'skill-not-effective') return `${t('pinSkillIneffective')} · ${pin.name}`
      if (pin.kind === 'tool-error') return `${t('pinToolError')} · ${pin.name}`
      if (pin.kind === 'approval-asked') return `${t('pinApprovalAsked')} · ${pin.name}`
      if (pin.kind === 'approval-allowed') return `${t('pinApprovalAllowed')} · ${pin.name}`
      if (pin.kind === 'approval-denied') return `${t('pinApprovalDenied')} · ${pin.name}`
      if (pin.kind === 'permission-denied') return `${t('pinPermissionDenied')} · ${pin.name}`
      return `${t('pinSubagent')} · ${pin.name}`
    }

    function pinDetail(t, pin) {
      if (pin.kind === 'skill-not-effective') return t('pinIneffectiveDetail')
      return typeof pin.detail === 'string' && pin.detail !== '' ? pin.detail : ''
    }

    /** Percent with one decimal, or `—` when there is no denominator yet. */
    function formatPercent(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      return `${trimDecimal(value * 100)}%`
    }

    /**
     * How the amount is labelled. A user override that names its own table is
     * quoted; one that does not is called custom rather than borrowing the
     * snapshot's version.
     */
    function pricingText(t, label) {
      if (label === undefined || label === null) return ''
      if (label.mode === 'custom') return t('pricingCustom')
      return t('pricingVersion', { version: String(label.version ?? '') })
    }

    function createUsagePanel(localeService, store) {
      return function UsagePanel(props) {
        const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined
        const t = useTranslate(localeService)
        const open = usePanelOpen(store, sessionId)
        const [expanded, setExpanded] = React.useState({})
        const [processOpen, setProcessOpen] = React.useState(false)
        const [expandedSteps, setExpandedSteps] = React.useState({})
        const [rawOpen, setRawOpen] = React.useState({})
        const [rawCache, setRawCache] = React.useState({})

        const path = sessionId === undefined
          ? SESSION_PATH
          : `${SESSION_PATH}?sessionId=${encodeURIComponent(sessionId)}`
        const { document, stale } = usePolledDocument(path, open && sessionId !== undefined, [path, open])

        if (!open) return null

        const turns = document !== null && Array.isArray(document.turns) ? document.turns : []
        const process = document !== null && document.process !== null && typeof document.process === 'object'
          ? document.process
          : undefined
        const today = document !== null && document.today !== null && typeof document.today === 'object'
          ? document.today
          : undefined
        const sessionTotals = document !== null && document.session !== null && typeof document.session === 'object'
          ? document.session
          : undefined
        const pricingVersion = document !== null ? String(document.pricingVersion ?? '') : ''
        const priceLabel = (document !== null && document.pricingLabel !== null && typeof document.pricingLabel === 'object')
          ? document.pricingLabel
          : { mode: 'builtin', version: pricingVersion }
        const panelId = sessionId === undefined
          ? 'dsh-usage-lens-panel'
          : `dsh-usage-lens-panel-${sessionId}`

        const toggleTurn = (turn) => {
          setExpanded((current) => ({ ...current, [turn]: current[turn] !== true }))
        }
        const toggleStep = (step) => {
          setExpandedSteps((current) => ({ ...current, [step]: current[step] !== true }))
        }

        /** Raw payloads are fetched once per key, and only after a click. */
        const toggleRaw = (key, query) => {
          const nextOpen = rawOpen[key] !== true
          setRawOpen((current) => ({ ...current, [key]: nextOpen }))
          if (!nextOpen || rawCache[key] !== undefined) return
          void (async () => {
            try {
              const response = await fetch(`${RAW_PATH}?${new URLSearchParams(query).toString()}`, {
                headers: { accept: 'application/json' },
                cache: 'no-store',
                credentials: 'same-origin',
              })
              const body = await response.json()
              setRawCache((current) => ({
                ...current,
                [key]: body !== null && body.ok === true
                  ? { text: String(body.text ?? ''), truncated: body.truncated === true }
                  : { failed: true },
              }))
            } catch {
              setRawCache((current) => ({ ...current, [key]: { failed: true } }))
            }
          })()
        }

        /** A pinned row jumps to its step, expanding it and its failing raw result. */
        const jumpToPin = (pin) => {
          if (typeof pin.step !== 'number') return
          setExpandedSteps((current) => ({ ...current, [pin.step]: true }))
          if (pin.kind === 'tool-error' && typeof pin.callId === 'string') {
            setRawOpen((current) => ({ ...current, [`result:${pin.callId}`]: true }))
            void (async () => {
              try {
                const response = await fetch(`${RAW_PATH}?${new URLSearchParams({
                  sessionId: sessionId ?? '',
                  turn: String(pin.turn ?? process?.turn ?? ''),
                  step: String(pin.step),
                  kind: 'result',
                  callId: pin.callId,
                }).toString()}`, { headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' })
                const body = await response.json()
                setRawCache((current) => ({
                  ...current,
                  [`result:${pin.callId}`]: body !== null && body.ok === true
                    ? { text: String(body.text ?? ''), truncated: body.truncated === true }
                    : { failed: true },
                }))
              } catch {
                setRawCache((current) => ({ ...current, [`result:${pin.callId}`]: { failed: true } }))
              }
            })()
          }
          scrollToId(`dsh-usage-lens-step-${sessionId ?? ''}-${pin.step}`)
        }

        const rawBlock = (key) => {
          const cached = rawCache[key]
          return h(
            'pre',
            { className: 'dsh-usage-lens-raw', 'data-raw': key },
            cached === undefined
              ? t('rawLoading')
              : cached.failed === true
                ? t('rawFailed')
                : `${cached.text}${cached.truncated ? t('rawTruncated') : ''}`,
          )
        }

        // --- today: stats, the hour trend, and the price label --------------

        const renderToday = () => {
          if (today === undefined) return null
          const hours = Array.isArray(today.hours) ? today.hours : []
          const maxHour = Number.isFinite(today.maxHourTokens) ? today.maxHourTokens : 0
          const tokens = today.tokens ?? {}
          const cost = today.cost ?? {}
          const totals = sessionTotals?.tokens ?? {}
          const sessionCost = sessionTotals?.cost ?? {}

          const pricedCalls = Number.isFinite(cost.pricedCalls) ? cost.pricedCalls : 0
          const unpricedCalls = Number.isFinite(cost.unpricedCalls) ? cost.unpricedCalls : 0
          const pricedAmount = Number.isFinite(cost.pricedAmount) ? cost.pricedAmount : 0
          const dayTokens = Number.isFinite(tokens.total) ? tokens.total : 0

          let costLabel
          if (unpricedCalls > 0 && pricedCalls > 0) costLabel = `≥${formatMoney(pricedAmount)}`
          else if (unpricedCalls > 0) costLabel = t('unpriced')
          else costLabel = formatMoney(pricedAmount)

          const sessionCostLabel = sessionCost.lowerBound === true
            ? `≥${formatMoney(sessionCost.pricedAmount ?? 0)}`
            : formatMoney(sessionCost.pricedAmount ?? 0)

          const hitRate = formatPercent(today.cacheHitRate)
          const hitText = hitRate === null ? t('todayHitRateEmpty') : t('todayHitRate', { percent: hitRate })

          const columns = hours.map((hour) => {
            const total = Number.isFinite(hour.total) ? hour.total : 0
            const share = (value) => (total > 0 ? Math.round((value / total) * 1000) / 10 : 0)
            const height = maxHour > 0 ? Math.round((total / maxHour) * 1000) / 10 : 0
            return h(
              'div',
              {
                className: 'dsh-usage-lens-hour',
                key: hour.hour,
                'data-hour': hour.hour,
                'data-total': total,
                'data-calls': hour.calls,
                'data-peak': hour.peakCalls > 0 ? 'true' : undefined,
                title: t('hourTitle', {
                  hour: hour.hour,
                  tokens: exact(total),
                  calls: hour.calls,
                }),
              },
              h('div', { className: 'dsh-usage-lens-hour-stack', style: { height: `${height}%` } },
                h('span', { className: 'dsh-usage-lens-seg', 'data-bucket': 'input', style: { height: `${share(hour.input)}%` } }),
                h('span', { className: 'dsh-usage-lens-seg', 'data-bucket': 'cacheRead', style: { height: `${share(hour.cacheRead)}%` } }),
                h('span', { className: 'dsh-usage-lens-seg', 'data-bucket': 'cacheWrite', style: { height: `${share(hour.cacheWrite)}%` } }),
                h('span', { className: 'dsh-usage-lens-seg', 'data-bucket': 'output', style: { height: `${share(hour.output)}%` } })),
            )
          })

          const legend = h(
            'div',
            { className: 'dsh-usage-lens-today-legend', title: t('todayLegend') },
            [
              ['input', t('bucketInput'), '1'],
              ['cacheRead', t('bucketCacheRead'), '.72'],
              ['cacheWrite', t('bucketCacheWrite'), '.5'],
              ['output', t('bucketOutput'), '.3'],
            ].map(([bucket, label, opacity]) => h(
              'span',
              { key: bucket, 'data-legend': bucket },
              h('span', { className: 'dsh-usage-lens-swatch', 'data-bucket': bucket, style: { opacity } }),
              label,
            )),
          )

          return h(
            'div',
            { className: 'dsh-usage-lens-today', 'data-today-block': 'true' },
            h('div', { className: 'dsh-usage-lens-today-head' },
              h('span', { className: 'dsh-usage-lens-today-title' }, t('todayTitle')),
              h('span', { className: 'dsh-usage-lens-today-note' },
                `${t('todayDay', { date: String(today.date ?? '') })} · ${pricingText(t, priceLabel)}`)),
            h('div', { className: 'dsh-usage-lens-today-body' },
              h('div', { className: 'dsh-usage-lens-today-stat', 'data-today-total': 'true' },
                h('strong', null, `${formatTokens(dayTokens)} tok`),
                h('strong', null, costLabel),
                unpricedCalls > 0
                  ? h('span', { 'data-today-unpriced': 'true' },
                    `${t('pinBadgeTool')} · ${(cost.unpricedModels ?? []).join(', ')}`)
                  : null),
              h('div', { className: 'dsh-usage-lens-today-stat', 'data-today-stats': 'true' },
                h('span', null, t('todayCalls', { count: exact(today.calls ?? 0) })),
                h('span', { 'data-today-hit': 'true' }, hitText),
                h('span', { 'data-today-session': 'true' },
                  t('todaySession', { tokens: formatTokens(totals.total ?? 0), cost: sessionCostLabel }))),
              hours.length === 0
                ? h('div', { className: 'dsh-usage-lens-panel-empty' }, t('todayEmpty'))
                : h('div', { className: 'dsh-usage-lens-hours', 'data-hour-chart': 'true' }, columns),
              hours.length === 0 ? null : h('div', { className: 'dsh-usage-lens-hours-axis' },
                [0, 6, 12, 18, 23].map((hour) => h('span', { key: hour }, `${hour}:00`))),
              legend),
          )
        }

        // --- execution process -------------------------------------------

        const renderProcess = () => {
          if (process === undefined) return null
          const pins = Array.isArray(process.pins) ? process.pins : []
          const steps = Array.isArray(process.steps) ? process.steps : []
          const turnLabel = typeof process.turn === 'number' && process.turn > 0
            ? t('processTurn', { turn: process.turn })
            : t('turnUnattributed')

          const head = h('button', {
            type: 'button',
            className: 'dsh-usage-lens-process-head',
            'aria-expanded': processOpen,
            'data-process-head': 'true',
            onClick: () => setProcessOpen((current) => current !== true),
          },
          h('span', { className: 'dsh-usage-lens-process-title' }, t('processTitle')),
          h('span', { className: 'dsh-usage-lens-process-meta' }, [
            turnLabel,
            t('processMeta', { steps: steps.length, pins: pins.length }),
          ].join(' · ')),
          h('span', { className: 'dsh-usage-lens-turn-chevron' }, processOpen ? '▾' : '▸'))

          if (!processOpen) return h('div', { className: 'dsh-usage-lens-process', 'data-process-open': 'false' }, head)

          const pinLayer = pins.length === 0 ? null : h(
            'div',
            { className: 'dsh-usage-lens-pins', 'data-pin-layer': 'true' },
            pins.map((pin) => h(
              'button',
              {
                type: 'button',
                className: 'dsh-usage-lens-pin',
                key: pin.id,
                'data-kind': pin.kind,
                'data-tone': pin.tone,
                title: pin.step === undefined ? undefined : t('jumpToStep', { step: pin.step }),
                onClick: () => jumpToPin(pin),
              },
              h('span', { className: 'dsh-usage-lens-pin-badge' }, pinBadge(t, pin.kind)),
              h('span', { className: 'dsh-usage-lens-pin-label' }, pinLabel(t, pin)),
              h('span', { className: 'dsh-usage-lens-pin-detail' }, pinDetail(t, pin)),
            )),
          )

          const flow = steps.length === 0
            ? h('div', { className: 'dsh-usage-lens-panel-empty' }, t('processEmpty'))
            : h('div', { className: 'dsh-usage-lens-flow' }, steps.map((step) => {
              const isOpen = expandedSteps[step.step] === true
              const toolNames = (step.tools ?? []).map((tool) => tool.name).filter((name) => name !== '')
              const toolsText = toolNames.length > 0 ? toolNames.join(', ') : t('flowThink')
              return h(
                'div',
                {
                  className: 'dsh-usage-lens-flow-step',
                  key: step.step,
                  id: `dsh-usage-lens-step-${sessionId ?? ''}-${step.step}`,
                  'data-flow-step': step.step,
                },
                h('button', {
                  type: 'button',
                  className: 'dsh-usage-lens-flow-head',
                  'aria-expanded': isOpen,
                  onClick: () => toggleStep(step.step),
                },
                h('span', { className: 'dsh-usage-lens-flow-no' }, t('flowStep', { step: step.step })),
                h('span', { className: 'dsh-usage-lens-flow-tools' }, toolsText),
                h('span', { className: 'dsh-usage-lens-flow-time' }, formatDuration(step.durationMs)),
                h('span', { className: 'dsh-usage-lens-flow-tokens' }, `${formatTokens(step.tokens?.total ?? 0)} tok`),
                step.failed === true ? h('span', { className: 'dsh-usage-lens-flow-badge' }, t('statusFailed')) : null),
                isOpen ? h('div', { className: 'dsh-usage-lens-flow-body' },
                  step.reasoning !== '' ? h('div', { className: 'dsh-usage-lens-flow-reasoning' },
                    `${t('flowReasoningLabel')}：${step.reasoning}`) : null,
                  (step.tools ?? []).length === 0
                    ? h('div', { className: 'dsh-usage-lens-tool-io' }, t('flowEmptyIO'))
                    : (step.tools ?? []).map((tool) => {
                      const argsKey = `args:${tool.callId}`
                      const resultKey = `result:${tool.callId}`
                      return h('div', { className: 'dsh-usage-lens-tool', key: tool.callId },
                        h('div', { className: 'dsh-usage-lens-tool-head' },
                          h('span', { className: 'dsh-usage-lens-tool-name' }, tool.name),
                          h('span', { className: 'dsh-usage-lens-tool-time' }, formatDuration(tool.durationMs)),
                          tool.isError === true
                            ? h('span', { className: 'dsh-usage-lens-tool-error' }, tool.errorCode ?? t('statusFailed'))
                            : null,
                          h('button', {
                            type: 'button',
                            className: 'dsh-usage-lens-raw-toggle',
                            'data-raw-toggle': argsKey,
                            onClick: () => toggleRaw(argsKey, {
                              sessionId: sessionId ?? '',
                              turn: String(process.turn ?? ''),
                              step: String(step.step),
                              kind: 'args',
                              callId: tool.callId,
                            }),
                          }, rawOpen[argsKey] === true ? t('rawToggleClose') : t('rawToggle')),
                          h('button', {
                            type: 'button',
                            className: 'dsh-usage-lens-raw-toggle',
                            'data-raw-toggle': resultKey,
                            onClick: () => toggleRaw(resultKey, {
                              sessionId: sessionId ?? '',
                              turn: String(process.turn ?? ''),
                              step: String(step.step),
                              kind: 'result',
                              callId: tool.callId,
                            }),
                          }, rawOpen[resultKey] === true ? t('rawToggleClose') : t('rawToggle'))),
                        h('div', { className: 'dsh-usage-lens-tool-ios' },
                          h('span', { className: 'dsh-usage-lens-tool-io' }, `${t('flowInput')}: ${tool.argsSummary !== '' ? tool.argsSummary : t('flowEmptyIO')}`),
                          h('span', { className: 'dsh-usage-lens-tool-io' }, `${t('flowOutput')}: ${tool.resultSummary !== '' ? tool.resultSummary : t('flowEmptyIO')}`)),
                        rawOpen[argsKey] === true ? rawBlock(argsKey) : null,
                        rawOpen[resultKey] === true ? rawBlock(resultKey) : null)
                    }),
                  step.request !== undefined && step.request !== null
                    ? h('div', { className: 'dsh-usage-lens-tool-ios' },
                      h('span', { className: 'dsh-usage-lens-tool-io' },
                        `${step.request.provider}/${step.request.model} · ${step.request.messages} messages · ${step.request.tools} tools`))
                    : null,
                ) : null,
              )
            }))

          return h('div', { className: 'dsh-usage-lens-process', 'data-process-open': 'true' },
            head,
            h('div', { className: 'dsh-usage-lens-process-body' }, pinLayer, flow))
        }

        const header = h(
          'div',
          { className: 'dsh-usage-lens-panel-head' },
          h('span', { className: 'dsh-usage-lens-panel-title' }, t('panelTitle')),
          h('span', {
            className: 'dsh-usage-lens-panel-note',
            title: stale ? t('panelStale') : undefined,
          }, document !== null ? pricingText(t, priceLabel) : ''),
          h('button', {
            type: 'button',
            className: 'dsh-usage-lens-panel-close',
            'aria-label': t('panelClose'),
            onClick: () => store.close(sessionId),
          }, '×'),
        )

        const body = h(
          'div',
          { className: 'dsh-usage-lens-panel-body' },
          turns.length === 0
            ? h('div', { className: 'dsh-usage-lens-panel-empty' }, t('panelEmpty'))
            : turns.map((turn) => {
              const isOpenTurn = expanded[turn.turn] === true
              const isRunning = turn.open === true
              const abnormal = (turn.statuses?.failed ?? 0) + (turn.statuses?.cancelled ?? 0)
              const headChildren = [
                h('span', { className: 'dsh-usage-lens-turn-title' }, turn.attributed === false
                  ? t('turnUnattributed')
                  : t('turnTitle', { turn: turn.turn })),
                isRunning ? h('span', { className: 'dsh-usage-lens-badge', 'data-tone': 'open' }, t('turnOpen')) : null,
                abnormal > 0 ? h('span', { className: 'dsh-usage-lens-badge', 'data-tone': 'failed' }, t('turnFailed', { count: abnormal })) : null,
                h('span', { className: 'dsh-usage-lens-turn-meta' }, [
                  t('turnCalls', { count: turn.calls }),
                  t('turnTools', { count: turn.toolCount }),
                ].join(' · ')),
                h('span', { className: 'dsh-usage-lens-turn-tokens' }, `${formatTokens(turn.tokens?.total ?? 0)} tok`),
                h('span', { className: 'dsh-usage-lens-turn-cost' }, turn.cost?.lowerBound === true
                  ? `≥${formatMoney(turn.cost.pricedAmount)}`
                  : formatMoney(turn.cost?.pricedAmount ?? 0)),
                h('span', { className: 'dsh-usage-lens-turn-chevron' }, isOpenTurn ? '▾' : '▸'),
              ].filter((child) => child !== null)

              return h(
                'div',
                {
                  className: 'dsh-usage-lens-turn',
                  'data-turn': turn.turn,
                  'data-open': isRunning ? 'true' : 'false',
                },
                h('button', {
                  type: 'button',
                  className: 'dsh-usage-lens-turn-head',
                  'aria-expanded': isOpenTurn,
                  'aria-label': `${turn.attributed === false ? t('turnUnattributed') : t('turnTitle', { turn: turn.turn })} ${isOpenTurn ? t('collapse') : t('expand')}`,
                  onClick: () => toggleTurn(turn.turn),
                }, headChildren),
                isOpenTurn
                  ? h('div', { className: 'dsh-usage-lens-steps' }, turn.steps.map((step) => h(
                    'div',
                    {
                      className: 'dsh-usage-lens-step',
                      'data-step': step.step,
                      'data-status': step.status,
                    },
                    h('span', { className: 'dsh-usage-lens-step-no' }, `#${step.step}`),
                    h('span', { className: 'dsh-usage-lens-step-model' }, step.model),
                    h('span', {
                      className: 'dsh-usage-lens-step-tokens',
                      title: bucketText(t, step.tokens),
                    }, bucketText(t, step.tokens)),
                    h('span', { className: 'dsh-usage-lens-step-cost' }, step.cost?.priced === false
                      ? t('unpriced')
                      : formatMoney(step.cost?.amount ?? 0)),
                    step.tools.length > 0
                      ? h('span', { className: 'dsh-usage-lens-step-tools', title: step.tools.join(', ') }, step.tools.join(', '))
                      : null,
                    h('span', {
                      className: 'dsh-usage-lens-step-status',
                      'data-status': step.status,
                    }, statusLabel(t, step.status)),
                  )))
                  : null,
              )
            }),
          renderToday(),
          renderProcess(),
        )

        return h('div', {
          className: 'dsh-usage-lens-panel',
          id: panelId,
          'data-usage-lens-panel': 'true',
          role: 'region',
          'aria-label': t('panelTitle'),
        }, header, body)
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const localeService = ctx.get('locale')
        const store = createPanelStore()
        const UsageLensCell = createUsageLensCell(localeService, store)
        const UsagePanel = createUsagePanel(localeService, store)

        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = 'dsh-usage-lens'
          style.textContent = STYLE
          document.head.appendChild(style)
          return () => {
            style.remove()
          }
        }, 'dsh-usage-lens: styles')

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'usage-lens',
          order: 10,
        }, UsageLensCell))

        // Full-width entry above the composer card: an open panel pushes the
        // input down instead of overlaying it.
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'usage-lens-panel',
          order: 15,
        }, UsagePanel))
      },
    }
  },
})
