# dsh-usage-lens

Session-embedded usage lens for DeepSeek Harness.

- **Slice 1** — intercept `llm/stream`, settle one JSONL ledger row per
  conversation call from the provider's authoritative usage, price the Beijing
  calendar day, and show **今日 Token 总量 / 今日花费** as one extra cell in the
  existing `conversation.composer.dock` stats row.
- **Slice 2** — join `session/event` for real turn/step attribution, project each
  session's turns, and open a detail panel from the status pill with one
  aggregated card per turn that expands into its per-call rows.
- **Slice 3** — the **执行过程** block: a sticky pinned key-step layer (Skill load,
  tool failure, approval or permission denial, sub-agent dispatch), a folded
  process flow whose rows expand to input/output summaries, and an on-demand raw
  layer. Skill "loaded" is decided by parsing the frozen request, not by trusting
  the `skill` tool result.
- **Slice 4** — the **今日用量** block (day totals, an hour-stacked trend, cache
  hit rate, session share), a price-table override with an honest label
  (`按 <version> 价格表估算` / `自定义价格`), unpriced handling in both blocks, and
  size-based ledger rotation that keeps history readable.

Still out of scope: a pricing editor. Automatic price syncing exists as an
**opt-in** layer (see [Remote price sync](#remote-price-sync-opt-in)); it is off
unless a profile asks for it, so the default remains no-network.

## Files

| File | Role |
|---|---|
| `index.js` | Host half: collector + ledger + interceptor + tool-denial observer + three routes |
| `client.js` | Client half: the status pill, the detail panel, the execution block |
| `lib/config.js` | Defensive config normalization (`ledgerDir`, `ledgerMaxBytes`, three route paths, `timeZone`, `pricing`) |
| `lib/time.js` | Beijing wall-clock, day/month keys, ISO with offset, peak windows |
| `lib/pricing.js` | Built-in snapshot, override merge/replace, lookup order, label, amount math |
| `lib/pricing-sync.js` | Opt-in remote price layer: fetch, validate, alias, cache, degrade |
| `lib/ledger.js` | `ledger-YYYY-MM.jsonl` append (serialized), month + size rotation, cross-segment queries |
| `lib/day.js` | The one day fold: buckets, money, hour trend, cache hit rate |
| `lib/stream-interceptor.js` | `llm/stream` wrap: live estimate, usage capture, status, attribution, frozen-request hook |
| `lib/turns.js` | `session/event` collector: turn/step index, tool detail, the four pin rules |
| `lib/skill-parse.js` | Frozen-request `<skill_content>` extraction and placeholder rejection |
| `lib/aggregator.js` | Pure turn projection with per-call rows and money |
| `lib/process.js` | Pure execution-process projection (pins + folded flow) |
| `lib/http.js` | Shared route plumbing (loopback guard, JSON responses) |
| `lib/status-route.js` · `lib/session-route.js` · `lib/raw-route.js` | The three JSON routes |
| `test/*.test.mjs` | 451 self checks across ten suites |

## Where the data lives

`<DSH_HOME>/usage-lens/ledger-YYYY-MM.jsonl`, one line per settled call:

```json
{"sessionId":"session-…","turn":3,"step":52,"model":"deepseek-flash","provider":"deepseek-account","inputTokens":200,"cacheReadTokens":388096,"cacheWriteTokens":0,"outputTokens":716,"reasoningTokens":0,"timestamp":"2026-10-18T14:49:35+08:00","durationMs":3916,"status":"completed"}
```

The ledger holds token buckets and metadata only — never money, and never tool
payloads. Process detail lives in the collector's bounded memory index; raw
payloads are capped (4 KB arguments, 8 KB results and skill bodies) and served
only by the raw route.

## How a call settles

`llm/stream` is a waterfall; the interceptor wraps the adapter stream, passes
every chunk through untouched, and settles in a `finally`, so a consumer that
abandons the stream (an aborted turn) is still recorded.

- **Tokens** come from the stream's single authoritative `usage` chunk, and only
  from it. The agent loop stamps that same value on `assistant/message.usage`,
  and chunk fragments are never summed.
- **turn/step** come from the turn collector. The loop appends `step/start`
  *before* dispatching the model call and `session/event` dispatches
  post-commit, so the current step is known when the stream settles.
- **Status** is `completed` for `stop` / `tool-calls` / `max-tokens`, `failed`
  for a terminal `error` finish, and `cancelled` for an `aborted` finish.
- **Live estimate** (characters ÷ 4) exists only for the status bar while a call
  streams; it never reaches the ledger.
- Auxiliary calls (`purpose: 'compaction' | 'session-title'`) are not written.

## The four pinned key-step rules

Fixed, not configurable.

| Rule | Source | Pin |
|---|---|---|
| Skill load | `skill` tool call + the next frozen request | `skill-loaded` (ok) or `skill-not-effective` (error) |
| Tool failure | `tool/result` with `isError` or an `error` field | `tool-error` (error), carrying the error code |
| Approval / permission | `approval/asked` + `approval/decided`, and a `tools/pre-execute` deny or cancel | `approval-asked` (info) upgraded to `approval-allowed` (ok) or `approval-denied` (error); `permission-denied` (warn) |
| Sub-agent dispatch | `subagent/catalog` on the parent session | `subagent` (info), carrying the child id |

### Skill cross-validation

A successful `skill` tool call is only a **claim**. The verdict comes from the
next frozen request:

1. on a successful `skill` result, the skill name (from the arguments, else from
   the result's `<skill_content name>`) becomes a pending claim;
2. the next `llm/stream` request is parsed for `<skill_content name="…">` blocks;
3. present → `skill-loaded` citing the tool-call step and the request step that
   confirmed it; absent → `skill-not-effective`, detail "调用未生效".

Parsing rules: only the canonical block counts (`<available_skills>` is a
catalog, never a load), the name must be a real skill id, and a body carrying the
template placeholder is documentation. That last rule matters: a README quoting
`<skill_content name="<escaped-name>">` inside a fence must not look like a load.

## Turn boundaries

| Boundary | Behaviour |
|---|---|
| `turn/start` | opens the turn; an earlier still-open turn is closed as `superseded` |
| `step/start` | records the step and makes it the current step |
| `tool/call` / `tool/result` | attaches the call, its summaries, its timing and its error |
| `assistant/message` | records the reasoning/text summary of the step |
| `turn/end` | closes the turn with its reason |
| no `turn/end` | the turn stays `open` and the panel marks it 进行中 |

Only settled calls reach the ledger, so an interrupted turn contributes exactly
the calls that reached a settlement — never a placeholder row.

## Panel projection

`lib/aggregator.js` joins ledger rows with collector entries and returns turns
newest first; `lib/process.js` projects the execution block of one turn:

- **pin layer** — sticky at the top of the panel body, one compact row per pin,
  each citing the step it jumps to;
- **folded flow** — one row per step: `第 N 步 · 工具名 · 耗时 · Token`; expanding
  shows the reasoning summary and, per tool call, the input and output summaries
  plus a per-call raw toggle;
- **raw layer** — nothing is in the polling document; a click fetches one payload
  from `/plugins/dsh-usage-lens/raw`.

Amounts are summed over the rendered rows, so "card total === sum of the expanded
rows" holds by construction. **Tool names and payloads are a live index, not
durable data** — a Host reload forgets the detail of finished steps (tokens,
turn and step stay in the ledger).

## The 今日用量 block

One fold (`lib/day.js`) feeds both the status pill and this block, so the two can
never disagree. It shows:

- **the day** — token total and amount for the Beijing calendar day, with `未定价`
  and `≥` when part of the day is unpriced;
- **an hour-stacked trend** — 24 columns, each stacked by the four token buckets
  (input / cache read / cache write / output), scaled to the busiest hour, with
  peak-priced hours marked;
- **cache hit rate** — cache read ÷ billable input, `—` before anything is billed;
- **request count** and **the session's own cumulative** tokens and amount.

Hour over model was chosen deliberately: the bucket series are fixed, so the
chart needs no palette allocation or dynamic legend, and 24 columns show the
day's shape even when a single model did all the work. Model-by-hour would have
needed a colour per model for strictly less information.

## Ledger rotation

Rotation is by Beijing month, then by size: when the active file would cross
`ledgerMaxBytes`, it is renamed to `ledger-YYYY-MM.NNNN.jsonl` and marked
read-only, and a fresh active file starts. An archive is never appended to again.

Reads span every segment of a month in order (archives oldest first, then the
active file), so rotation costs no history: day queries, session queries and the
panel all see a continuous log. Nothing about a rotation touches record content.

## Pricing overrides

`pricing` may patch specific models or replace the whole table:

```yaml
pricing:
  version: 'team-2026-11'      # declare the table's own name…
  mode: merge                  # …or 'replace' to become the complete table
  models:
    deepseek-v4-pro:
      peak: { output: 99 }     # partial merge over the snapshot
    'acme/*':
      offPeak: { cacheHit: 0, cacheMiss: 3, output: 9 }
    old-model: null            # merge mode: drop the entry
```

The UI annotates every amount from `pricingLabel`, which is derived, never
guessed:

| Table state | Label |
|---|---|
| untouched snapshot | `按 builtin-2026-10-18 价格表估算` |
| prices changed **and** `version` declared | `按 <declared version> 价格表估算` |
| prices changed, no version declared | `自定义价格` |

Removing a model counts as a change: the table stops claiming the snapshot's
provenance. Overrides are read-only with respect to the ledger — the same rows
are repriced on every render, which is why a price edit is retroactive and
harmless.

## Pricing

Built-in snapshot `builtin-2026-10-18` (yuan per million tokens):

| model | window | cacheHit | cacheMiss | output |
|---|---|---|---|---|
| `deepseek-flash` | offPeak | 0.02 | 1.0 | 4.0 |
| `deepseek-flash` | peak | 0.04 | 2.0 | 8.0 |
| `deepseek-v4-pro` | offPeak | 0.15 | 4.5 | 13.5 |
| `deepseek-v4-pro` | peak | 0.30 | 9.0 | 27.0 |

Lookup: exact model → `provider/model` → longest wildcard prefix. Peak is
Monday–Friday excluding configured holidays, 09:00–12:00 and 14:00–18:00
Beijing. Cache writes are billed at the miss rate; reasoning is display-only.

Each record is priced at its own instant. Unpriced models are counted and named,
never billed as zero: the affected total is labelled a lower bound (`≥¥…`).

## Routes

| Route | Purpose |
|---|---|
| `GET /plugins/dsh-usage-lens/today` | day aggregate for the pill (optional `?date=`) |
| `GET /plugins/dsh-usage-lens/session?sessionId=…` | turns + today block + session share + the execution block |
| `GET /plugins/dsh-usage-lens/raw?sessionId=…&turn=…&step=…&kind=args\|result\|request\|skill[&callId=…][&name=…]` | one raw payload, fetched only on click |

All three answer only a loopback request whose Origin (when present) is loopback
too, and all are `Cache-Control: no-store`.

## Config

```yaml
- id: usage-lens
  name: dsh-usage-lens
  config:
    ledgerDir: 'F:\Users\me\.dsh\usage-lens'       # default <DSH_HOME>/usage-lens
    ledgerMaxBytes: 8388608                        # size rotation; 0 disables it
    statusPath: '/plugins/dsh-usage-lens/today'    # default
    sessionPath: '/plugins/dsh-usage-lens/session' # default
    rawPath: '/plugins/dsh-usage-lens/raw'         # default
    timeZone: 'Asia/Shanghai'                      # default
    pricing:
      version: 'builtin-2026-10-18+cn'             # shown beside every amount
      holidays: ['2026-10-01', '2026-10-02']
      models:
        deepseek-flash:
          peak: { cacheMiss: 2.1 }
        'acme/*':
          offPeak: { cacheHit: 0, cacheMiss: 3, output: 9 }
        old-model: null
```

A config change reloads the plugin through the normal Loader path; no restart is
needed.

## Remote price sync (opt-in)

The plugin ships no network behaviour by default — an untouched profile prices
only from the built-in snapshot and its own `pricing` section. A profile can opt
into a fetched price layer:

```yaml
pricing:
  sync:
    enabled: true                    # default false: no request is ever made
    sources: ['openrouter', 'litellm']
    usdToCny: 7.1                    # both sources quote USD, the ledger is CNY
    maxAgeMs: 604800000              # one week; a fresher cache is used as-is
    refresh: true                    # false = never refresh, cache only
  version: 'official-2026-10-24'
  models:                            # local entries still win
    'qwen-token-plan-cn/deepseek-v4.1-flash': { offPeak: { cacheMiss: 1, output: 4 } }
```

Two public sources ship, and neither needs a key:

| source | what it is | host |
|---|---|---|
| `openrouter` | OpenRouter's own model list | `openrouter.ai` |
| `litellm` | LiteLLM's community-maintained table, ~4000 rows | `cdn.jsdelivr.net` (mirrors the GitHub branch) |

Sources are merged in the order written, so the last one wins a contested key —
put the source you trust more last. `litellm` is fetched through jsDelivr rather
than `raw.githubusercontent.com`, which resolves to a non-public address on some
restricted networks.

What it guarantees, in the same spirit as the rest of the plugin:

- **No number is ever invented.** An unreachable source, a malformed payload, or
  a missing model contributes nothing. An unpriced model stays unpriced and the
  total keeps its `≥` lower bound.
- **A failed refresh never erases a good cache.** The last payload plus its
  fetch instant live in `<ledgerDir>/pricing-cache.json`; a stale cache is
  served while a refresh runs in the background, so activation never waits on
  the network.
- **Local always wins.** A hand-written `pricing.models` entry suppresses any
  fetched alias that would otherwise shadow it.
- **A first-party rate beats a reseller's.** LiteLLM lists one model under many
  resellers — a provider charging a hundredth of DeepSeek's own rate sits beside
  DeepSeek's row. The provider that actually serves a model claims its bare name,
  and listing order never decides the winner, so a promotional price cannot
  masquerade as the model's price.
- **Aliases are widened, never fabricated.** A remote catalogue names models its
  own way (`deepseek/deepseek-v4.1-flash-1017`), while the ledger records the
  configured route id (`deepseek-v4.1-flash`). The sync registers both spellings
  against the same real rates, because a sync that loads thousands of models and
  still prices nothing is worse than no sync at all.

Peak schedules survive both sources. OpenRouter encodes DeepSeek's windows in
`pricing.overrides` as UTC hundredths of an hour, and LiteLLM states them in
`off_peak_pricing`. In both cases the peak window is chosen as the *dearer*
weekday band — never by position, since most bands repeat the cheap rate — which
decodes to exactly the plugin's own Beijing 09:00–12:00 and 14:00–18:00 windows.

## Verify

```powershell
node dsh-usage-lens/test/logic.test.mjs         # time, pricing, ledger round trip
node dsh-usage-lens/test/interceptor.test.mjs   # completed / failed / cancelled, route guards
node dsh-usage-lens/test/turns.test.mjs         # attribution, boundaries, projection
node dsh-usage-lens/test/process.test.mjs       # skill cross-check, the four pin rules, raw route
node dsh-usage-lens/test/client-render.test.mjs # pill rendered against the live route
node dsh-usage-lens/test/panel.test.mjs         # pill → panel → cards → rows
node dsh-usage-lens/test/process-ui.test.mjs    # sticky pins, folded flow, raw gate
node dsh-usage-lens/test/day.test.mjs           # day fold, override, rotation, cross-midnight
node dsh-usage-lens/test/today-ui.test.mjs      # 今日用量 numbers, hour trend, labels
node dsh-usage-lens/test/pricing-sync.test.mjs  # opt-in gate, wire validation, aliases, peak bands, cache

node tools/check-day.mjs  "<DSH_HOME>/usage-lens/ledger-2026-10.jsonl"
node tools/check-today.mjs
node tools/check-turn.mjs <sessionId> [turn]
node tools/check-process.mjs <sessionId>
node tools/check-skill-check.mjs
node tools/verify-turns.mjs "<DSH_HOME>/usage-lens/ledger-2026-10.jsonl" <session.v4.jsonl.zstd>
node tools/verify-ledger.mjs "<DSH_HOME>/usage-lens/ledger-2026-10.jsonl" <session.v4.jsonl.zstd>
```
