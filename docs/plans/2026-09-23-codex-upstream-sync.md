# Codex upstream sync + GPT-6 Sol/Luna

## Context

Đồng bộ 3 fix Codex từ upstream `decolua/9router` (v0.5.85) vào fork local, đồng thời thêm 2 model `gpt-6-sol` / `gpt-6-luna`. Local đã có `gpt-5.6-sol/terra/luna` + `gpt-6-astra` và đang chạy ổn.

Kết quả nghiên cứu — cả 3 vấn đề **đều có thật trên bản local**:

1. **`codex-auto-review` misroute (upstream efc80ba2, #1398/#4135)** — CONFIRMED. `open-sse/services/model.js:126-132` `MODEL_PREFIX_PROVIDERS` không có rule cho `codex-auto-review` → rơi về fallback `"openai"` → "No active credentials for provider: openai" khi Codex CLI gửi auto-review. Registry thiếu entry → `getModelUpstreamId("cx","codex-auto-review")` strip `-review` thành `codex-auto` (sai, model này forward verbatim).
2. **Usage không report trên `response.completed` (upstream da004655, #3432)** — CONFIRMED. `openai-responses.js:22` `if (!chunk.choices?.length) return []` drop trailer chunk chứa `usage`; `sendCompleted` (line ~422 upstream shape) không attach usage → Codex CLI gauge "context used" kẹt 0, không auto-compact. Cần thêm `state.targetFormat` trong `utils/stream.js` để phân biệt direct route vs pivot (pivot không nhận terminal null chunk → không được defer).
3. **`findModel` không strip suffix `(level)`** — CONFIRMED. `providerModels.js:30` chỉ exact-match; `chatCore.js:81` gọi `getModelTargetFormat(alias, model)` với model còn suffix (vd `gpt-5.6-sol(max)`) → miss → mất per-model targetFormat/supportedFormats/quotaFamily. `isValidModel` (src wrapper) cũng exact-match nhưng không có caller thực — sửa core `findModel` là đủ.

**Cố ý KHÔNG lấy từ upstream** (upstream revert hardening local của commit ba1d1257):
- `executors/codex.js`: giữ `proxyOptions` trong `refreshCredentials` + policy P-CX-IMG (drop image block khi prefetch fail, không fallback remote URL).
- `imageProviders/codex.js`: giữ fallback `workspaceId`/`accountId` trong accountId resolution.
- `chatCore.js`/`streamingHandler.js`: diffs thuộc cursor/opencode/abort-terminal commits, ngoài phạm vi.

## Approach

- Cherry-pick `-n` efc80ba2 + da004655 (đã verify apply sạch ở lần trước), kèm 2 test file upstream.
- `providerModels.js`: áp hunk `findModel` strip `\([^()]+\)\s*$` trước lookup (không lấy hunk `ocz`/`opencode-zen` — provider chưa có local).
- `registry/codex.js`: thêm `gpt-6-sol`, `gpt-6-sol-review`, `gpt-6-luna`, `gpt-6-luna-review` theo convention 5.6 (`upstreamModelId` + `quotaFamily: "review"`). Đặt sau `gpt-6-astra`, trước nhóm 5.6. Không thêm `-image` variants (chưa có bằng chứng upstream hỗ trợ image).
- `thinkingLevels.js`: thêm `{ provider: "codex", pattern: "*gpt-6-sol*", levels: [...CODEX_GPT_5_6_LEVELS, "ultra"] }` TRƯỚC `*gpt-6*` (first-match-wins). `gpt-6-luna` dùng chung `*gpt-6*` (max, không ultra) — khớp ma trận 5.6. Executor `normalizeReasoningEffort` đã có fallback ultra→max, không cần sửa.
- `capabilities.js`: `*gpt-6*` pattern (line 321) đã cover reasoning/vision/272k — không cần entry mới.
- `cli/src/cli/menus/providers.js`: thêm `gpt-6-sol`, `gpt-6-luna` đầu list `cx`.
- Test: cherry-pick 2 file upstream + extend `thinking-levels-gpt56-sol.test.js` với rows gpt-6.

## Critical files and ownership

| File | Change |
|---|---|
| `open-sse/services/model.js` | prefix rule `codex-auto-review` → codex |
| `open-sse/providers/registry/codex.js` | +codex-auto-review, +gpt-6-sol/luna(+review) |
| `open-sse/translator/response/openai-responses.js` | toResponsesUsage + defer completed |
| `open-sse/utils/stream.js` | state.targetFormat |
| `open-sse/config/providerModels.js` | findModel strip suffix |
| `open-sse/providers/thinkingLevels.js` | gpt-6-sol ultra pattern |
| `cli/src/cli/menus/providers.js` | cx list |
| `tests/unit/codex-auto-review-routing.test.js` | new (upstream) |
| `tests/unit/openai-responses-usage-completed.test.js` | new (upstream) |
| `tests/unit/thinking-levels-gpt56-sol.test.js` | +gpt-6 rows |

## Verification

- AC-01: `getModelInfoCore("codex-auto-review")` → provider `codex`; `getModelUpstreamId("cx","codex-auto-review")` → verbatim; quotaFamily `review`; không phải default model.
- AC-02: `openaiToOpenAIResponsesResponse` attach `usage` vào `response.completed`; trailer chunk usage-only không bị drop; pivot route vẫn emit completed ngay (không defer).
- AC-03: `findModel` resolve `gpt-5.6-sol(max)` → entry `gpt-5.6-sol` (targetFormat/quotaFamily đúng).
- AC-04: `getThinkingLevels("codex","gpt-6-sol")` có `ultra`; `gpt-6-luna` không có `ultra`, có `max`.
- AC-05: vitest green cho: codex-auto-review-routing, openai-responses-usage-completed, thinking-levels-gpt56-sol, codex-fast-capacity, codex-image-policy, codex-image-fetch, codex-account-headers, refresh-egress-codex, openai-responses-empty-toolcalls, responses-abort-terminal.

## Execution checklist

- [x] T-01: cherry-pick -n efc80ba2 da004655 (AC-01, AC-02)
- [x] T-02: findModel suffix strip (AC-03)
- [x] T-03: registry + thinkingLevels + cli menu cho gpt-6-sol/luna (AC-04)
- [x] T-04: extend thinking test + chạy test-runner (AC-05)

## Evidence and handoff

`cd tests && npx vitest run` 12 files (codex-auto-review-routing, openai-responses-usage-completed, thinking-levels-gpt56-sol, codex-fast-capacity, codex-image-policy, codex-image-fetch, codex-account-headers, refresh-egress-codex, openai-responses-empty-toolcalls, responses-abort-terminal, codex-spark-quota-tracking, codex-native-passthrough-thinking) → exit 0, 82/82 pass. Security hardening local (P-CX-IMG, proxy egress) giữ nguyên — codex-image-policy + refresh-egress-codex + codex-account-headers green. Không commit theo yêu cầu user.
