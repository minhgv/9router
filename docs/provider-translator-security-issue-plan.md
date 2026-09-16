# Báo cáo lỗi và kế hoạch kiểm chứng Provider / Translator / Security

## 1. Phạm vi

Báo cáo này chỉ tập trung vào sáu nhóm provider được yêu cầu:

1. **OpenAI-Codex** (`codex`)
2. **Antigravity** (`antigravity`)
3. **MiMo-Coding-Plan** (`xiaomi-mimo` và luồng token-plan liên quan)
4. **Zai-Coding-Plan** (registry hiện dùng provider id `glm`, endpoint `api.z.ai`)
5. **Devin** (`devin`)
6. **Anthropic** (`anthropic` / Claude-format)

Phạm vi kiểm tra:

- Registry, endpoint, auth/header, executor, retry/failover, image handling và OAuth/token refresh.
- Translator trực tiếp và translator bridge qua OpenAI nếu execution path thực sự đi qua translator.
- Security liên quan secret/API key, OAuth callback, proxy, token refresh, MITM lock, image/SSRF và test security.
- Viết lại hoặc bổ sung test case theo observable behavior; không chấp nhận test chỉ pin implementation detail.

Ngoài phạm vi:

- Các provider không thuộc sáu nhóm trên, trừ khi dùng chung một module có ảnh hưởng trực tiếp đến provider mục tiêu.
- Devin translator riêng: Devin dùng ConnectRPC/protobuf native, không đi qua generic translator path.
- Snapshot mismatch của provider registry không mặc nhiên được kết luận là lỗi runtime; phải xác định expected contract trước khi cập nhật snapshot.

## 2. Bằng chứng và trạng thái hiện tại

Lần chạy test trước đó trong `tests/` ghi nhận:

- 2.482 test được phát hiện.
- 2.182 pass, 241 fail, 59 skip.
- Khi chuẩn hóa relative test path, có 217 active failures được phân loại liên quan provider/registry/executor/translator/OAuth và 14 known baseline failures.
- `verify-no-regression.mjs` không chuẩn hóa được absolute path ngoài môi trường có `/app/`; không dùng exit code thô của script này làm kết luận cuối.

Các con số test trên là bằng chứng lịch sử. Source survey bounded trên working tree hiện tại được ưu tiên khi test và source mâu thuẫn; chưa chạy lại suite trong lượt survey này.

### 2.1 Source survey working tree hiện tại

- **Codex:** registry `codex`/`cx` dùng Responses và executor riêng. Chat image prefetch khi thất bại vẫn giữ lại URL gốc qua `fetched?.url || url`; image-generation path dùng `toDataUrl` riêng và không đi qua chat prefetch. Đây là discrepancy thực tế cần test/fix theo policy, không còn mô tả chung là “chưa có bằng chứng”. `open-sse/executors/codex.js:249-267`; `open-sse/handlers/imageProviders/codex.js:130-184`.
- **Antigravity:** registry/executor/image path là native; retry 403/404/429 và transient 5xx có bounded handling. Image edit chỉ nhận data URI/raw base64, remote URL bị bỏ qua; image-generation adapter gọi `useExecutor` nhưng không truyền `proxyOptions`, nên cần kiểm tra egress qua adapter → executor → refresh, không neo vào nhánh refresh thủ công của core. `open-sse/handlers/imageProviders/antigravity.js:6-75`; `open-sse/executors/antigravity.js:390-421,520-553`.
- **MiMo:** provider id canonical là `xiaomi-mimo`; preview model dùng executor/session cookie riêng, model cloud delegate `DefaultExecutor`; registry có cả OpenAI và Claude transport. Không thấy thiếu registration/dispatch. `open-sse/providers/registry/xiaomi-mimo.js:1-90`; `open-sse/executors/index.js:39-93`.
- **Zai-Coding-Plan:** provider id canonical là `glm`, không phải `zai`; `glm` dùng `api.z.ai`, OpenAI Bearer và Claude `x-api-key`, đi qua `DefaultExecutor`. `glm-cn` là provider khác. Không thấy specialized executor bị thiếu. `open-sse/providers/registry/glm.js:1-90`; `open-sse/executors/default.js:55-173`.
- **Devin:** dùng native ConnectRPC/protobuf; custom URL yêu cầu HTTPS và loại userinfo/localhost/loopback/numeric IPv4; frame compressed/decompressed có giới hạn 16 MiB và stream tail được kiểm tra. DNS rebinding/private resolution vẫn là gap cần runtime test, không phải defect đã chứng minh. `open-sse/executors/devin.js:90-183,429-683`; `open-sse/utils/devinProtobuf.js:499-573,559-653`.
- **Anthropic/Claude:** `anthropic` API-key và `claude` OAuth đều dùng generic/default transport tới `/v1/messages`; Claude request/response translators hiện xử lý system, multimodal base64, tool, reasoning/thinking và usage. `open-sse/providers/registry/anthropic.js:1-44`; `open-sse/providers/registry/claude.js:1-105`; `open-sse/translator/request/claude-to-openai.js:1-270`; `open-sse/translator/response/openai-to-claude.js:1-265`.

### 2.2 Điều chỉnh các finding cũ

- MiMo OAuth renderer hiện tại dùng HTML cố định/escape message ở các nhánh đã khảo sát; finding “unescaped MiMo XSS” trong report cũ **không còn được source hiện tại xác nhận**. Cần bỏ mức HIGH và chỉ giữ callback consumer/PKCE audit nếu có path chưa khảo sát.
- Usage SQL summary hiện mask key và trả `apiKeyMasked`/`apiKeyKey`; raw key vẫn tồn tại trong metadata aggregation nội bộ. Vì vậy không được kết luận raw key đang lộ trong JSON summary nếu chưa có API-level reproduction.
- Token-refresh proxy asymmetry vẫn source-confirmed cho Codex: executor gọi credential manager không nhận `proxyOptions`; generic/default path có proxy-aware refresh. Antigravity image adapter gọi executor nhưng bỏ qua options; cần kiểm tra adapter → executor → refresh. Anthropic/provider-specific caller cần kiểm chứng riêng.
- MITM stale-lock chưa được source survey hiện tại chứng minh; các persisted model locks và in-memory refresh dedupe có cleanup/expiry behavior khác nhau. Hạ từ finding confirmed xuống **NEEDS VERIFICATION**.
- Proxy input validation là finding còn hiệu lực ở mức source: runtime normalization và proxy-pool routes lỏng hơn utility allowlist; chưa kết luận exploitability nếu chưa kiểm tra middleware/schema toàn tuyến.

## 3. Ma trận tổng quan

| Provider | Mã/đường chạy thực tế | Trạng thái | Module chính | Ảnh hưởng |
|---|---|---|---|---|
| OpenAI-Codex | `codex`, Responses API, native executor | SOURCE DISCREPANCY; needs deterministic verification | `open-sse/executors/codex.js`, Responses translator, image handler | Chat prefetch thất bại vẫn fallback về remote URL; image-generation dùng path riêng không qua prefetch |
| Antigravity | `antigravity`, Gemini/image/search, native executor | SOURCE CONFIRMED; no current retry defect proven | `open-sse/executors/antigravity.js`, image handler, MITM manager | Image edit chỉ nhận data URI/base64; image adapter → executor refresh cần kiểm tra proxy options |
| MiMo-Coding-Plan | `xiaomi-mimo` / preview và cloud transports | SOURCE CONFIRMED; no missing dispatch | `open-sse/executors/xiaomi-mimo.js`, `shared/mimoAccount.js`, OAuth renderer | Preview cookie/session; cloud transport OpenAI/Claude; API summary projection đã mask key |
| Zai-Coding-Plan | provider id `glm`, `api.z.ai`, OpenAI + Claude transports | SOURCE CONFIRMED; coverage gap | `open-sse/providers/registry/glm.js`, `executors/default.js`, Claude normalization | Generic transport; cần test dual transport/tool-history boundary |
| Devin | `devin`, ConnectRPC/protobuf native | SOURCE CONFIRMED; security gap cần kiểm chứng | `open-sse/executors/devin.js`, `open-sse/utils/devinProtobuf.js` | HTTPS/custom URL và frame caps hiện có; DNS rebinding/private resolution chưa được chứng minh |
| Anthropic | `anthropic` / Claude-format | KNOWN BASELINE + translator compatibility risk | `open-sse/translator/request/*`, `response/*`, `proxyFetch.js`, `executors/default.js` | Header/proxy baseline; generic bridge edge cases; refresh caller scope cần xác minh |

## 4. Chi tiết theo provider

### 4.1 OpenAI-Codex

#### Bằng chứng source

- Registry: `open-sse/providers/registry/codex.js:1-~120`.
  - Dùng OAuth/deprecated provider configuration.
  - Dùng Responses endpoint, `forceStream`, session/account headers và model image support.
- Executor: `open-sse/executors/codex.js:212-267`.
  - Bổ sung session/account headers.
  - Refresh token và prefetch remote image.
- Retry/stream handling: `open-sse/executors/codex.js:268-372`.
  - Retry các lỗi overload/capacity trong SSE path.

#### Lỗi và rủi ro cần kiểm chứng

1. **SOURCE DISCREPANCY — remote image fetch/prefetch và SSRF boundary**
   - Codex chat prefetch dùng helper có kiểm soát URL, nhưng khi fetch thất bại executor vẫn dùng URL gốc qua `fetched?.url || url`: `open-sse/executors/codex.js:249-267`.
   - Image-generation adapter là path độc lập, chuyển `body.image`/`body.images` qua `toDataUrl`, không gọi chat prefetch: `open-sse/handlers/imageProviders/codex.js:130-184`.
   - Đây là hành vi source-confirmed cần chốt policy và test deterministic; không mô tả là test cũ tự chứng minh runtime defect.

2. **KNOWN XFAIL / NEEDS VERIFICATION — Responses translator edge cases**
   - Test: `tests/translator/bugs-codexCli-responses.test.js:10-45` có `it.fails` cho function_call chỉ có name rỗng/thiếu.
   - Source: `open-sse/translator/request/openai-responses.js:~90-120` có logic bỏ function call rỗng, nhưng xfail cho thấy cần kiểm chứng output cuối cùng.
   - Ảnh hưởng: payload Codex/OpenAI có thể còn `tool_calls: []` không hợp lệ; generic normalization baseline cũng ảnh hưởng khi client Claude đi qua OpenAI pivot.

3. **SECURITY — account boundary và token refresh proxy**
   - Account header precedence cần test: `workspaceId > chatgptAccountId > accountId` và không leak header giữa accounts.
   - Token refresh source: `open-sse/services/tokenRefresh/providers.js:260-280`; bare `fetch()` có thể bypass outbound proxy.

#### Test case viết lại

   - Remote image timeout/failure/private address; assert observable policy đã chọn: reject/inline-only hoặc preserve URL có kiểm soát. Không khẳng định source hiện tại tự động loại URL thất bại.
   - Function call rỗng/thiếu name; assert output cuối không phát sinh `tool_calls` rỗng.
   - Account-id precedence và Codex refresh qua proxy; assert credential/header isolation.

### 4.2 Antigravity

#### Bằng chứng source

- Registry: `open-sse/providers/registry/antigravity.js:1-140`.
- Executor: `open-sse/executors/antigravity.js:1-433,444-549`.
- Image path: `open-sse/handlers/imageProviders/antigravity.js:1-~100`.
- Focused tests hiện có retry hook, endpoint failover, IDE UA, schema sanitizer, labels, wire/envelope parity và usage headers.

#### Lỗi và rủi ro cần kiểm chứng

1. **SOURCE CONFIRMED — retry/failover contract hiện chưa có defect mới**
   - Executor xử lý 403/404/429 và transient 5xx với Retry-After/body parsing, bounded retry: `open-sse/executors/antigravity.js:520-553`.
   - Không dùng receipt cũ về số attempt để đổi retry constant khi chưa xác định contract.

2. **SOURCE DISCREPANCY — image input và refresh proxy**
   - Image edit chỉ nhận data URI/raw base64; remote URL trả `null` và bị bỏ qua tại `open-sse/handlers/imageProviders/antigravity.js:6-52`. Test phải xác định đây là policy mong muốn, không giả định remote URL được fetch.
   - Executor có `proxyAwareFetch` cho refresh tại `open-sse/executors/antigravity.js:390-421`, nhưng image adapter gọi `useExecutor` mà không truyền `proxyOptions`: `open-sse/handlers/imageProviders/antigravity.js:20-75`. Không dùng nhánh manual refresh của `imageGenerationCore` làm execution path đại diện.

3. **NEEDS VERIFICATION — MITM startup lock**
   - Chưa có source survey đủ để kết luận stale-lock exploitable; cần behavioral test pre-spawn failure và process ownership.

4. **NEEDS VERIFICATION — translator/tool/schema boundary**
   - Source: `open-sse/translator/request/antigravity-to-openai.js:1-223`; focused guards hiện bảo vệ co-located functionResponse/functionCall, stable tool index, nested schema và default prompt.

#### Test case viết lại

Ba host: 403/404 rồi success; assert URL, header, body được rebuild đúng.
System prompt obfuscation bounded, không mutate user content ngoài policy.
Image data URI và remote URL; assert rõ remote URL bị reject/bỏ qua hoặc được xử lý theo policy đã chọn; assert không stream và không forward tools.
OAuth refresh qua proxy trên cả chat và image-generation caller; assert proxy options không bị mất.

### 4.3 MiMo-Coding-Plan

#### Bằng chứng source

- Executor: `open-sse/executors/xiaomi-mimo.js:21-96`.
  - Preview models dùng account cookie.
  - 401 invalidate account và retry một lần.
  - Non-preview delegate sang `DefaultExecutor`.
- Registry/executor/OAuth dispatch đầy đủ; không thấy missing registration.
- Renderer ở các nhánh đã khảo sát dùng HTML cố định hoặc `escapeHtml(message)`: `src/lib/oauth/utils/server.js:159-273`. Các anchor cũ 770-800,890-905 không còn được source hiện tại xác nhận là unescaped sink.

#### Trạng thái source hiện tại

- Preview 401 invalidate session cache và retry một lần; non-preview delegate `DefaultExecutor`: `open-sse/executors/xiaomi-mimo.js:21-96`.
- Registry/executor/OAuth dispatch đầy đủ; không thấy missing registration.
- OAuth result renderer ở các nhánh đã khảo sát dùng HTML cố định hoặc `escapeHtml(message)`: `src/lib/oauth/utils/server.js:159-273`. Finding XSS cũ tại các anchor 770-800,890-905 không còn được source hiện tại xác nhận.
- SQL usage summary projection trả `apiKeyMasked`/`apiKeyKey` và áp dụng `maskApiKey`; raw `entry.apiKey` còn tồn tại trong metadata aggregation nội bộ, không đủ chứng minh leakage ra JSON: `src/lib/db/repos/usageRepo.js:69-148,574-663`.

#### Lỗi và rủi ro cần kiểm chứng
1. **NEEDS VERIFICATION — anti-abuse/live gateway mismatch**
   - `tests/unit/mimo-free.live.test.js` là live/network-dependent observation; không dùng để kết luận source defect.

2. **NEEDS VERIFICATION — credential isolation và URL boundary**
   - Preview dùng Cookie/service token; cloud OpenAI dùng Bearer; cloud Claude dùng auth descriptor theo registry. Cần test CRLF/control chars, credential isolation và provider-specific override theo từng transport.

3. **RECLASSIFIED — OAuth renderer XSS**
   - Không còn mức HIGH/source-confirmed trên working tree hiện tại. Giữ behavioral regression test nếu callback consumer vẫn nhận dữ liệu attacker-controlled.

4. **RECLASSIFIED — usage API-key leakage**
   - Không còn bằng chứng raw key xuất hiện trong summary JSON projection. Cần API-level test cho mọi period và route auth trước khi gọi là exposed hoặc fixed.

#### Test case cần giữ

- Preview 401 một lần rồi success; assert cache invalidation/refetch đúng một lần.
- Assert preview Cookie/service token, cloud OpenAI Bearer và cloud Claude auth descriptor chỉ xuất hiện trên transport tương ứng; reject CRLF/control chars.
- Assert region/base URL không bị override bởi arbitrary credential/providerSpecificData URL.
- OAuth callback: attacker-controlled message không trở thành executable HTML.
- Usage masking: raw key không xuất hiện trong serialized summary; masked identity vẫn group đúng.
- Anti-abuse: deterministic policy tests cho UA hợp lệ/thiếu/malformed; live test chỉ là smoke test có prerequisite.


### 4.4 Zai-Coding-Plan

#### Bằng chứng source

- Provider id thực tế là `glm`, không phải `zai`:
  - `open-sse/providers/registry/glm.js:1-~80`.
  - Claude endpoint `api.z.ai/api/anthropic/v1/messages?beta=true` dùng `x-api-key`.
  - OpenAI coding endpoint `api.z.ai/api/coding/paas/v4/chat/completions` dùng Bearer.
- `open-sse/providers/registry/glm-cn.js:1-~60` là provider khác, OpenAI-compatible tại `open.bigmodel.cn`.
- Không có specialized executor; provider đi qua `executors/default.js` và registry-driven transport selection.

#### Trạng thái và ảnh hưởng

- **NEEDS VERIFICATION**: không có failure riêng trong known baseline; rủi ro chính là dual-transport và translator/tool-history boundary.
- `tests/unit/claude-foreign-server-tool-use.test.js` bảo vệ trường hợp GLM/OpenAI-style foreign `server_tool_use` id bị loại cùng orphan `tool_result`.
- Nếu source format khớp transport, tránh bridge; nếu mismatch, generic OpenAI pivot có thể làm mất image/thinking/tool semantics.
- Không gộp `glm-cn` với Zai Coding Plan `glm`; endpoint và auth khác nhau.

#### Test case bắt buộc

- OpenAI source → coding endpoint: assert URL, Bearer và không có Claude wrapper.
- Claude source → Anthropic endpoint: assert URL, `x-api-key`, beta query và không leak Bearer.
- GLM foreign `server_tool_use` + orphan `tool_result`: assert sanitized history không làm upstream 400.
- Reasoning low/medium/high/max và invalid; assert native fields hợp lệ.
- Claude tool_use/tool_result round-trip, web-search tool stream và error redaction.

### 4.5 Devin

#### Bằng chứng source

- Registry: `open-sse/providers/registry/devin.js:1-~140`.
- Executor: `open-sse/executors/devin.js:~1-220,290-510`; native ConnectRPC/protobuf, auth/JWT, optional model assignment và stream.
- Protobuf URL sanitizer: `open-sse/utils/devinProtobuf.js:~620-710`; reject non-HTTPS, localhost/loopback custom server.
- Tests hiện có: `tests/unit/devin-executor.test.js`, `tests/unit/devin-protobuf.test.js`, model/usage/OAuth tests.

#### Trạng thái và ảnh hưởng

- **NEEDS VERIFICATION; chưa chứng minh defect hiện tại**.
- Devin không dùng generic upstream translator dù registry format là OpenAI; không gán lỗi Claude/OpenAI bridge trực tiếp cho Devin.
- Rủi ro cần kiểm chứng: SSRF/custom URL, protobuf frame allocation, JWT/auth failure, model assignment và mid-stream error/retry.

#### Test case cần bổ sung

- Reject userinfo, disallowed ports, IPv4-mapped IPv6/decimal loopback và DNS-rebinding-sensitive custom URL trước khi gửi credential.
- Oversized protobuf frame phải bị từ chối trước allocation/decoding.
- JWT/auth failure, assignment failure, mid-stream Connect error: terminal error bounded, không replay prompt vô hạn.
- Tool/reasoning request: decode protobuf để assert order, IDs và model-specific parallel-tool flag.
- Stream text/tool/usage/trailer: assert OpenAI-compatible SSE và `[DONE]`.

### 4.6 Anthropic

#### Bằng chứng source

- Claude format normalization: `open-sse/translator/formats/claude.js:197-335,418+`.
- OpenAI → Claude response: `open-sse/translator/response/openai-to-claude.js:182-240`.
- Proxy utility: `open-sse/utils/proxyFetch.js:12-27,351-353`.
- Header/foreign-tool focused tests: `tests/unit/claude-header-forwarding.test.js`, `tests/unit/claude-foreign-server-tool-use.test.js`.

#### Lỗi và rủi ro

1. **KNOWN BASELINE — proxy/header routing**
   - `tests/unit/claude-header-forwarding.test.js` nằm trong `tests/__baseline__/known-fails.txt`.
   - `api.anthropic.com` routing hiện không gọi `gotScraping` như test kỳ vọng; source native fetch tại `open-sse/utils/proxyFetch.js:351-353`.
   - Phải xác định policy trước khi sửa source hoặc rebaseline test; không coi call-count là runtime contract mặc định.

2. **KNOWN XFAIL / NEEDS VERIFICATION — generic Claude bridge**
   - `tests/translator/bugs-openai-bridge.test.js` có xfail cho Claude image `source.type=url` bị drop.
   - `tests/translator/bugs-toClaude-context.test.js` có xfail về việc luôn inject Claude Code system prompt vào compatible provider.
   - Các lỗi này ảnh hưởng Anthropic trực tiếp và Claude transport của Zai/MiMo chỉ khi execution path đi qua bridge.

3. **KNOWN BASELINE — request normalization**
   - `tests/unit/translator-request-normalization.test.js` và `known-fails.txt:21-24`: text-array flattening, raw NDJSON parse, Claude→OpenAI string safety.
   - Có thể ảnh hưởng Codex/OpenAI pivot hoặc mismatched Zai/MiMo path; không gán cho Devin native executor.

4. **NEEDS VERIFICATION — caller-specific refresh egress**
   - Một số nhánh token refresh dùng bare `fetch()` trong `open-sse/services/tokenRefresh/providers.js`; đây là source observation cần kiểm chứng theo từng caller, chưa phải bằng chứng bypass. Tách riêng Codex, Antigravity, Anthropic API-key và Claude OAuth; reproduction phải chứng minh direct egress trái proxy policy.

#### Test case viết lại

- Claude → OpenAI với image URL; assert URL sống qua bridge.
- Claude thinking/redacted_thinking + text/tool_use; assert block semantics và tool IDs.
- OpenAI → Claude với target `glm`; assert không inject Claude Code prompt nếu target không yêu cầu official behavior.
- Official Anthropic multimodal body với cache/tool history; assert strict shape.
- Foreign `server_tool_use` và orphan `tool_result`; assert sanitize không tạo upstream 400.
- Proxy contract: assert policy behavior, không chỉ số lần gọi implementation.

## 5. Ma trận Translator

| Path | Provider áp dụng | Trạng thái | Ảnh hưởng cần kiểm chứng |
|---|---|---|---|
| Claude → OpenAI | Anthropic source; Claude transport của Zai/MiMo cloud khi mismatch | KNOWN BASELINE + KNOWN XFAIL | Text arrays, URL image, tool_result image/is_error, thinking/redacted thinking |
| OpenAI → Claude | Anthropic target; Claude transport của Zai/MiMo cloud khi mismatch | KNOWN XFAIL / NEEDS VERIFICATION | Claude Code prompt pollution, tool choice, thinking, empty Read |
| OpenAI Responses | Codex | KNOWN XFAIL / NEEDS VERIFICATION | Empty tool calls, arguments, continuity, stream terminal ordering |
| Antigravity → OpenAI / Claude | Antigravity | REGRESSION-SENSITIVE; no current defect proven | Stable tool id, co-located function call/response, schema/image boundary |
| OpenAI ↔ MiMo cloud | MiMo cloud | REGRESSION-SENSITIVE; no current defect proven | Cloud OpenAI/Claude transport, flattenContent, Bearer/Claude-auth isolation, endpoint and 401 behavior |
| MiMo preview/native cookie | MiMo preview | NOT APPLICABLE to generic translator | Preview endpoint, Cookie/service-token isolation and bounded 401 retry; do not apply cloud translator assertions |
| OpenAI ↔ Zai (`glm`) | Zai-Coding-Plan | NEEDS VERIFICATION | Dual transport/auth, foreign tool history, thinking and web-search stream |
| Generic translator → Devin | Không áp dụng cho upstream wire | NOT APPLICABLE | Devin native ConnectRPC/protobuf; test executor and pre-normalization only |

Translator registry dispatch tại `open-sse/translator/index.js:62-110,171-226`: direct route được ưu tiên, nếu không có mới bridge qua OpenAI. MiMo preview/native-cookie là executor path riêng, không thuộc các translator rows cloud ở trên. Mỗi test phải xác nhận source format, target format và provider executor; không suy diễn provider từ tên translator.

## 6. Security findings và kế hoạch test

### S1 — RECLASSIFIED: MiMo OAuth callback XSS

- Source survey hiện tại không xác nhận finding HIGH cũ: renderer dùng HTML cố định hoặc escape message ở các nhánh đã khảo sát (`src/lib/oauth/utils/server.js:159-273`).
- Không gọi là fixed cho toàn bộ callback flow nếu chưa audit consumer; giữ behavioral regression test với payload HTML.

### S2 — RECLASSIFIED: API key trong usage summary

- SQL summary projection hiện áp dụng `maskApiKey` và trả `apiKeyMasked`/`apiKeyKey` (`src/lib/db/repos/usageRepo.js:574-663`).
- Raw key còn trong metadata aggregation nội bộ (`usageRepo.js:69-148`); chưa có bằng chứng raw key lộ ra JSON API. Cần API-level test và auth audit.

### S3 — MEDIUM: Antigravity MITM lock cleanup — NEEDS VERIFICATION

- Source survey không đủ chứng minh stale lock exploitable. Cần test pre-spawn failure, lần start thứ hai và process ownership trước khi xếp production defect.

### S4 — MEDIUM: NO_PROXY và proxy scheme validation thiếu chặt

- Runtime `normalizeProxyUrl` chỉ parse/chuẩn hóa URL; proxy-pool routes yêu cầu nonempty string nhưng utility allowlist riêng tại `src/lib/network/proxyTest.js` chưa được chứng minh là áp dụng toàn tuyến.
- Anchors: `open-sse/utils/proxyFetch.js:99-205`; `src/lib/network/proxyTest.js:1-110`; `src/app/api/proxy-pools/route.js:1-113`.
- Đây là source gap, chưa kết luận exploitability nếu chưa kiểm tra middleware/schema và runtime.

 - Generic/default refresh có `proxyAwareFetch`; Codex executor gọi credential manager không truyền `proxyOptions` (`open-sse/executors/codex.js:237-243`; `open-sse/services/oauthCredentialManager.js:149-170`).
 - Antigravity executor hỗ trợ proxy-aware refresh nhưng image adapter bỏ qua options trong đường `useExecutor` (`open-sse/executors/antigravity.js:390-421`; `open-sse/handlers/imageProviders/antigravity.js:20-75`).
 - Anthropic API-key request/transport egress và Claude OAuth refresh là credential paths khác nhau; source chưa đủ chứng minh API-key path có refresh. SEC-03C không được suy diễn token rotation; chỉ kiểm tra request/transport egress nếu caller tồn tại, còn SEC-03D kiểm tra OAuth refresh caller.
 - Acceptance: mỗi caller chỉ nhận contract phù hợp với source evidence; khi proxy policy yêu cầu proxy, không direct egress ngoài contract; non-strict mode và NO_PROXY phải có expected behavior riêng.
### False positive cần tách riêng

- Một số `tests/unit/security-audit.test.js` failure là test path/setup (`tests/src/...` thay vì `src/...`), không phải bằng chứng production vulnerability.
- Không đánh dấu audit item là fixed chỉ vì static test path được sửa; phải có behavioral security test.
- Các test live/network-dependent và snapshot mismatch không override source behavior nếu không xác định contract.
- Không đưa live provider test vào pass/fail deterministic nếu thiếu credential hoặc upstream không ổn định.


## 7. Kế hoạch thực hiện và tiêu chí nghiệm thu

### P0 — Security verification trước, fix sau khi tái hiện

**Mapping bắt buộc:** S1 → SEC-01 (OAuth callback), S2 → SEC-02 (usage projection), S3 → SEC-05 (MITM lifecycle), S4 → SEC-04 (proxy/NO_PROXY). SEC-03 là parent roll-up, bắt buộc đạt đủ `SEC-03A` (Codex), `SEC-03B` (Antigravity), `SEC-03C` (Anthropic API-key) và `SEC-03D` (Claude OAuth); SEC-06 là boundary riêng cho Devin DNS/redirect và protobuf frame cap.

1. Chốt contract observable cho OAuth callback, usage projection, proxy strict/fallback/NO_PROXY, refresh egress và MITM ownership.
2. Viết SEC-01..06 bằng mock deterministic; các DEV-01..04 case kiểm chứng riêng contract Devin, trong đó chỉ phần DNS/redirect/frame-security thuộc gate SEC-06.
3. Nếu reproduction xác nhận defect, áp dụng FIX-SEC-01..06 tương ứng; nếu không, giữ test regression và ghi rõ reclassified/no defect proven.

**Nghiệm thu P0:** SEC-01, SEC-02, SEC-04, SEC-05 và SEC-06 pass security assertions deterministic; SEC-03 chỉ pass khi cả SEC-03A..03D pass độc lập; không có raw secret/XSS execution trong output; live/network/setup failures không thay thế behavioral proof.

### P1 — Provider discrepancy và translator compatibility

1. Codex image policy, Responses edge cases, capacity/account rotation và refresh propagation.
2. Antigravity adapter→executor image path, retry/failover và translator tool/schema behavior.
3. MiMo preview 401/concurrent account isolation, credential boundary và anti-abuse policy.
4. Anthropic/Claude thinking, empty Read, multimodal bridge và caller-specific refresh.

**Nghiệm thu P1:** `NEW`/`EXTEND` cases phải pass deterministic. `KNOWN-BASELINE` và `KNOWN-XFAIL` chỉ là accepted legacy status, không tính là pass, không block release ngoài phần contract mới; `REPLACE-XFAIL` chỉ trở thành blocking sau reproduction và contract decision. Với `CODEX-04`, giữ accepted `KNOWN-XFAIL` cho đến khi đủ hai điều kiện đó; khi promote thành `REPLACE-XFAIL`, `FIX-CX-02` mới có gate blocking. `ANT-04` baseline là informational/nonblocking; chỉ các header/proxy assertions mới được thêm với trạng thái `NEW` là blocking, và `FIX-AN-01` chỉ gate các assertion mới đó cùng `SEC-03C..03D`. `FIX-ANT-01` sở hữu bridge/dispatch (`ANT-01..03`, `ANT-05`); không dùng một gate để che defect của owner kia. Retry bounded; error/log không lộ secret; không đổi retry constant khi chưa có contract decision.

### P2 — Provider coverage chưa có failure đủ mạnh

1. Zai-Coding-Plan qua `glm`: OpenAI coding và Claude transport độc lập.
2. Devin native ConnectRPC/protobuf: URL/DNS, frame, request/auth/stream/error; không ép generic translator.
3. Cross-provider bridge chỉ kiểm tra route thực sự đi qua translator; mỗi case ghi rõ source format → target format → executor.

**Nghiệm thu P2:** mỗi transport/native path có deterministic contract tests; live tests ghi rõ prerequisite và không làm sai baseline gate.

### Cách chạy và báo cáo kết quả

- Chạy test file mục tiêu trước, sau đó chạy suite `tests/`.
- Dùng relative test paths khi so baseline.
- Mỗi failure phải ghi:
  - test path + full name;
  - provider/execution path;
  - source anchor;
  - expected/actual observable behavior;
  - active, known baseline, fixed hoặc unverified;
  - security impact nếu có.
- Không cập nhật snapshot URL/header chỉ để làm suite xanh nếu chưa xác định contract mới.
- Không đưa live provider test vào pass/fail deterministic nếu thiếu credential hoặc upstream không ổn định.

### 7.1 Checklist fix theo ưu tiên

#### P0 — Security và transport boundary

| ID | Việc phải làm | Owner | Phụ thuộc | Tiêu chí hoàn tất | Regression gate / rollback |
|---|---|---|---|---|---|
| FIX-SEC-01 | Verify rồi chỉ fix nếu callback reproduction xác nhận defect; audit toàn bộ OAuth callback consumer và escape dữ liệu message hoặc chuyển sang response text an toàn | OAuth/server | Không có | Payload HTML/attribute/script không executable ở mọi callback path; message hợp lệ vẫn hiển thị đúng | SEC-01 và MIMO-05 pass; rollback riêng renderer nếu callback contract thay đổi |
| FIX-SEC-02 | Verify rồi chỉ fix nếu API-level reproduction xác nhận exposure; giữ raw API key ngoài mọi summary/API projection | DB usage/API | Không có | Serialized response của mọi period không chứa raw key; group count/tổng usage không đổi | SEC-02 pass cho `7d`, `30d`, `60d`, `all`; không sửa metadata nội bộ nếu không cần |
| FIX-SEC-03 | Chuẩn hóa proxy-aware refresh/egress boundary và truyền proxy policy qua từng provider caller | Network/OAuth + provider owners | FIX-SEC-04 | SEC-03A/03B/03D có refresh contract; SEC-03C chỉ có request/transport egress contract nếu caller được xác định; token/error bounded; không direct egress ngoài policy | `SEC-03A`, `SEC-03B`, `SEC-03C`, `SEC-03D` pass độc lập rồi mới roll up SEC-03; revert propagation độc lập, không đổi token contract |
| FIX-SEC-04 | Validate proxy URL và NO_PROXY tại mọi input boundary; chặn scheme không cho phép, control characters, malformed host/port và ambiguous bypass | Network/API proxy-pools | Không có | Chỉ `http`, `https`, `socks5` hợp lệ; CR/LF, `file:`, `javascript:`, unsupported scheme, malformed host/port bị reject hoặc normalize an toàn; không ghi input độc vào env | SEC-04 pass utility và route-level; giữ compatibility URL hợp lệ |
| FIX-SEC-05 | Verify rồi chỉ fix nếu lifecycle reproduction xác nhận stale-lock; làm MITM lock transactional với owner-aware cleanup | MITM manager | Không có | Spawn fail không để lock; lock owner khác không bị xóa/kill; start thứ hai không bị lockout giả | SEC-05 concurrency/pre-spawn tests pass; rollback lifecycle riêng, không nới lock policy |
| FIX-SEC-06 | Verify rồi chỉ fix nếu Devin DNS/redirect hoặc framing reproduction xác nhận security defect; chặn private destination trước credential send và giữ frame cap trước decode | Devin executor/protobuf | Không có | HTTPS/custom URL policy và DNS rebinding an toàn; redirect không gửi credential tới private đích; frame cap trước decode | SEC-06 pass; DEV-01/02 security assertions trace về SEC-06; rollback riêng URL/framing, không bỏ native ConnectRPC |

#### P1 — Provider và translator đang có discrepancy

| ID | Việc phải làm | Owner | Phụ thuộc | Tiêu chí hoàn tất | Regression gate / rollback |
|---|---|---|---|---|---|
| FIX-CX-01 | Chốt policy trước; nếu reproduction xác nhận unsafe fallback thì thực thi image policy inline-only sau fetch/SSRF validation | Codex image/executor | FIX-SEC-04 | Success gửi inline data; timeout/private/invalid/fetch failure có kết quả bounded theo policy, không submit URL gốc khi policy cấm | CODEX-01..02 pass; không thay đổi image-generation path ngoài phạm vi |
| FIX-CX-02 | Chuẩn hóa Responses function call thiếu/rỗng name và arguments | Codex Responses translator | Không có | Nếu reproduction và contract decision promote `CODEX-04` từ KNOWN-XFAIL thành REPLACE-XFAIL, output cuối không tạo `tool_calls: []` hoặc function call không hợp lệ; call hợp lệ giữ đủ id/name/arguments | `CODEX-04` là accepted nonblocking KNOWN-XFAIL trước khi promote; sau promote mới là blocking gate; không xóa tool call hợp lệ |
| FIX-CX-03 | Bảo vệ account-header precedence/isolation, outer-handler rotation và refresh caller | Codex executor/chatCore/credential manager | FIX-SEC-03 cho refresh | Mỗi request chỉ gửi account header của account được chọn; fallback/rotation không giữ header hoặc capacity state cũ; refresh tuân thủ proxy policy | CODEX-03 và CODEX-05..06 pass; SEC-03A pass cho refresh |
| FIX-AG-01 | Chốt policy trước; giữ image input policy nhất quán tại adapter | Antigravity image | FIX-SEC-04 | Data URI/raw base64 hợp lệ; remote/malformed input deterministic; không silently fetch ngoài policy, không forward tools | AG-01 pass; rollback adapter riêng |
| FIX-AG-02 | Truyền proxy options qua image adapter → `useExecutor` → executor refresh/egress | Antigravity image/executor | FIX-SEC-03 | Chat và image adapter quan sát cùng proxy behavior; không direct bypass | AG-02 và SEC-03B pass; revert caller-only nếu upstream API contract bất tương thích |
| FIX-AG-03 | Giữ retry/failover bounded và rebuild URL/header/body đúng sau 403/404/429/5xx | Antigravity executor | Không có | Retry-After/body parsing không vượt giới hạn; terminal error không lộ secret và không duplicate stream | AG-03 pass; không đổi retry constant nếu chưa có contract decision |
| FIX-AG-04 | Kiểm chứng translator tool/schema contract độc lập với retry path | Antigravity translator | Không có | Co-located/reordered tool calls giữ id/index/schema; user content không bị mutate ngoài policy | AG-04 pass; rollback translator riêng |
| FIX-MM-01 | Giữ preview 401 invalidate session và retry đúng một lần; cô lập account concurrent; cloud route vẫn dùng DefaultExecutor | MiMo executor/account | Không có | 401 một lần rồi success; 401 lặp lại terminal bounded; invalidation không xóa nhầm account đang chạy; preview Cookie/service-token path không trộn | MIMO-01..02 pass; MIMO-03 auth/transport thuộc FIX-MM-02; không retry vô hạn |
| FIX-MM-02 | Chặn CRLF/control chars và arbitrary provider-specific URL/region override trong từng credential/transport path | MiMo/gateway | FIX-SEC-04 | Preview Cookie, cloud OpenAI Bearer, cloud Claude auth descriptor đúng path; endpoint không bị override tùy ý | MIMO-03..04 pass; MIMO-05 thuộc FIX-SEC-01; giữ endpoint mặc định |
| FIX-MM-03 | Tách policy deterministic khỏi live smoke của MiMo free flow | MiMo gateway | Không có | UA hợp lệ/thiếu/malformed có kết quả policy ổn định; upstream live response không quyết định deterministic gate | MIMO-06 deterministic pass; LIVE-SMOKE chỉ informational |
| FIX-AN-01 | Kiểm chứng và sửa caller-specific auth/header/refresh cho Anthropic API-key và Claude OAuth | Anthropic network/OAuth | FIX-SEC-03 | API-key egress và OAuth refresh đúng caller contract; không leak header/secret | Chỉ các assertion `NEW` của `ANT-04` và `SEC-03C..03D` là blocking; `ANT-04` KNOWN-BASELINE remains informational; không rebaseline nếu chưa chốt contract |
| FIX-ANT-01 | Sửa bridge semantics và translator dispatch theo target thực tế | Claude translator/bridge | Không có | Direct route ưu tiên; bridge không làm mất block/URL hoặc inject prompt vào target không yêu cầu | `ANT-01..03` và `ANT-05` đạt outcome đã chốt: NEW/EXTEND phải pass; KNOWN-BASELINE/KNOWN-XFAIL chỉ được ghi nhận, không gọi là pass; rollback translator/dispatch riêng |

#### P2 — Coverage contract cho provider chưa có defect đủ mạnh
Security acceptance của Devin ở `FIX-SEC-06` là P0 release blocker; các dòng P2 dưới đây chỉ bổ sung coverage provider, không trì hoãn security verification.

| ID | Việc phải làm | Owner | Phụ thuộc | Tiêu chí hoàn tất | Regression gate / rollback |
|---|---|---|---|---|---|
| FIX-GLM-01 | Bổ sung coverage dual transport và reasoning/error cho `glm` | `glm` registry + generic transports | Không có | OpenAI coding và Claude transport giữ auth/endpoint/body contract độc lập | GLM-01..04 pass; không gộp `glm-cn` |
| FIX-DEV-01 | Bổ sung coverage Devin URL/DNS contract sau P0 security gate | Devin executor/protobuf | FIX-SEC-06 (security assertions only) | HTTPS-only; public HTTPS custom URL usable; native ConnectRPC URL contract đúng | DEV-01 contract assertions pass; security assertions gate tại SEC-06 |
| FIX-DEV-02 | Bổ sung coverage Devin protobuf framing, model assignment và stream error sau P0 security gate | Devin protobuf/executor | FIX-SEC-06 (security assertions only) | Split/coalesced frame, assignment và stream lifecycle đúng; error bounded, không replay vô hạn | DEV-02..04 contract assertions pass; framing security gate tại SEC-06; không nới frame cap |

### 7.2 Ma trận test case edge case bắt buộc

Tất cả case dưới đây là deterministic unit/integration tests với mock fetch, proxy, DNS và controlled stream, trừ case ghi rõ **LIVE-SMOKE**. Assertion tập trung vào request/response/stream quan sát được, không pin implementation detail.

**Vocabulary trạng thái và gate:** `NEW`/`EXTEND` là case bắt buộc phải pass deterministic; `KNOWN-BASELINE` là thông tin lịch sử, không phải pass criterion; `KNOWN-XFAIL` là defect đã ghi nhận, được chấp nhận tạm thời nhưng không được tính là pass; `LIVE-SMOKE-INFO` chỉ ghi nhận khi đủ prerequisite, không block deterministic gate. `REPLACE-XFAIL` là trạng thái blocking chỉ sau khi contract observable được chốt và reproduction xác nhận lỗi; trước đó giữ `KNOWN-XFAIL` accepted nonblocking.

| ID | Execution path / test location đề xuất | Fixture / edge case | Observable assertion | Tier / trạng thái |
|---|---|---|---|---|
| SEC-01 | OAuth callback consumer; mở rộng `tests/unit/security-audit.test.js` | Message chứa `<script>`, quote trong attribute, CR/LF, Unicode, empty message; provider callback auth/state | Response không tạo executable markup; text hợp lệ hiển thị/encode đúng; callback validation không bị bỏ qua | Deterministic / NEW |
| SEC-02 | Usage summary API/repo projection qua auth middleware | Raw keys ngắn/dài, duplicate/masked-collision, null key; periods `7d/30d/60d/all`; login bật/tắt | JSON serialized không chứa raw key; grouping/count/tổng usage ổn định; auth contract giữ nguyên | Deterministic / NEW |
| SEC-03A | Codex credential-manager refresh caller | Proxy-required, fallback, direct mode, token rotation/stale refresh | Refresh egress đúng policy; token/error bounded; log không chứa secret | Deterministic / NEW |
| SEC-03B | Antigravity chat/image refresh callers | Có/không proxy, refresh success/fail, direct fallback, NO_PROXY | Chat và image adapter quan sát cùng proxy policy; không direct bypass ngoài policy | Deterministic / NEW |
| SEC-03C | Anthropic API-key request/transport egress caller | Proxy-required, NO_PROXY match/non-match, timeout/error; không giả định token rotation nếu không có caller evidence | API-key request/transport egress đúng caller policy; không gửi credential sai hop | Deterministic / NEW |
| SEC-03D | Claude OAuth refresh caller | Proxy-required, NO_PROXY match/non-match, timeout/error, token rotation/stale refresh | Claude OAuth refresh egress đúng caller policy; không gửi token sai hop | Deterministic / NEW |
| SEC-04 | Proxy utility + proxy-pools route | `http/https/socks5`, `file:`, `javascript:`, unsupported scheme, malformed host/port, CR/LF, ambiguous `NO_PROXY` | Valid schemes dùng được; invalid/control input reject/normalize theo policy; không ghi env nguy hiểm | Deterministic / NEW |
| SEC-05 | MITM manager lifecycle | Spawn throws trước PID, child exits early, stale lock owner khác, concurrent starts | Cleanup đúng owner; lock/process owner khác không bị xóa/kill; không stale-lock/lockout giả | Deterministic / NEW |
| SEC-06 | Devin URL/DNS + protobuf frame security boundary | Private/loopback/mapped/decimal DNS, public→private redirect, exactly-at-cap/over-cap/truncated frame | Reject private destination trước credential send; redirect không nhận credential; frame cap trước decode/allocation | Deterministic / NEW |
| CODEX-01 | Codex chat image prefetch | Valid remote, timeout, 4xx, private address, redirect, invalid URL | Theo policy đã chốt: success inline; failure bounded; không submit URL gốc khi policy cấm; redirect không gửi credential tới đích cấm | Deterministic / NEW |
| CODEX-02 | Codex image-generation adapter | `image`, `images`, data URI, raw base64, malformed input | Path độc lập với chat prefetch; output/error đúng policy; không leak URL/secret | Deterministic / NEW |
| CODEX-03 | Codex Responses + outer capacity/account handler | Overload/capacity trước và sau chunk, account rotation, duplicate prefix, fragmented JSON, terminal `[DONE]` | Retry/rotation bounded; không duplicate content; stream ordering và usage ổn định; outer state không lẫn executor state | Deterministic / EXTEND |
| CODEX-04 | Responses translator | function call thiếu/rỗng name, missing args, valid call, interleaved tool IDs | Không tạo empty/invalid `tool_calls`; valid call giữ id/name/args; assistant message không bị rỗng giả | Deterministic / KNOWN-XFAIL → conditional REPLACE-XFAIL |
| CODEX-05 | Codex account headers | Chỉ `accountId`; từng cặp và cả ba `workspaceId/chatgptAccountId/accountId`; fallback/rotation | Precedence đúng; header/capacity không leak giữa accounts/retries | Deterministic / NEW |
| CODEX-06 | Codex refresh caller | Proxy-required, fallback, direct mode, token rotation/stale refresh | Refresh egress policy đúng qua credential manager; không bypass proxy hoặc leak token | Deterministic / EXTEND |
| AG-01 | Antigravity image adapter → `useExecutor` | Data URI, raw base64, remote URL, malformed base64, tools present | Input policy deterministic; remote không fetch ngầm; image path không forward tools | Deterministic / NEW |
| AG-02 | Antigravity adapter → executor refresh/egress | Có/không proxy, refresh success/fail, direct fallback, NO_PROXY | Proxy policy truyền xuyên suốt đúng execution path; không direct bypass ngoài policy | Deterministic / NEW |
| AG-03 | Antigravity retry/failover | 403/404/429 + Retry-After/body; transient 5xx; permanent error; fragmented stream JSON | URL/header/body rebuild đúng; retry bounded; finish/usage ordering đúng; terminal body/log redacted | Deterministic / EXTEND |
| AG-04 | Antigravity translator | Co-located functionResponse/functionCall, reordered/interleaved tool IDs, nested schema, missing optional fields | Tool id/index/schema stable; user content không bị mutate ngoài policy | Deterministic / EXTEND |
| MIMO-01 | MiMo preview executor/account cache | 401 rồi success; 401 liên tiếp; expiry; failed handshake cleanup | Invalidate và retry tối đa một lần; expiry/cleanup đúng; terminal bounded | Deterministic / EXTEND |
| MIMO-02 | MiMo concurrent account path | Hai account đồng thời; một account 401/invalidate khi account kia đang chạy | Invalidation không xóa nhầm session/credential account khác; Cookie độc lập | Deterministic / NEW |
| MIMO-03 | MiMo auth/transport boundary | Preview Cookie/service token; cloud OpenAI Bearer; cloud Claude auth descriptor; empty/duplicate credentials | Auth đúng transport; không trộn Cookie/Bearer/Claude auth; missing credential fail-fast | Deterministic / EXTEND |
| MIMO-04 | MiMo URL/input validation | CR/LF, control chars, arbitrary region/base URL/provider data | Reject/normalize an toàn; canonical endpoint giữ nguyên | Deterministic / NEW |
| MIMO-05 | MiMo OAuth callback consumer | Attacker-controlled message qua callback thực tế | Serialized/browser-visible result inert; valid message unaffected | Deterministic / EXTEND |
| MIMO-06 | MiMo free flow policy | Valid/missing/malformed UA và anti-abuse response | Policy deterministic; network-only behavior tách khỏi smoke | Deterministic / NEW; LIVE-SMOKE-INFO |
| GLM-01 | `glm` OpenAI transport → `DefaultExecutor` | OpenAI source, coding endpoint, Bearer, reasoning variants | `api.z.ai/api/coding/...` có Bearer, không Claude wrapper/x-api-key | Deterministic / NEW |
| GLM-02 | `glm` Claude transport → `DefaultExecutor` | Claude source, Anthropic endpoint, beta query, tools/thinking | `x-api-key` và beta đúng, không Bearer leak, body Claude-compatible | Deterministic / NEW |
| GLM-03 | GLM tool history/stream | Foreign `server_tool_use`, orphan `tool_result`, web-search, fragmented JSON/interleaved IDs | Sanitized history không tạo upstream 400; valid blocks, finish/usage/error redaction giữ nguyên | Deterministic / EXTEND |
| GLM-04 | GLM reasoning/error | low/medium/high/max, invalid value, malformed upstream error | Valid map đúng; invalid reject/normalize; error không lộ credential | Deterministic / NEW |
| DEV-01 | Devin URL sanitizer + DNS + redirect | Userinfo, policy-disallowed port, loopback/mapped/decimal/private DNS, public→private redirect | Reject trước credential send; public HTTPS usable; redirect/private destination không nhận credential | Deterministic / EXTEND |
| DEV-02 | Devin protobuf framing | Exactly-at-cap/over-cap, split/coalesced frames, truncated header/payload, corrupt gzip, compressed/decompressed cap | Valid boundary decodes; oversized/truncated/corrupt reject trước unsafe allocation | Deterministic / EXTEND |
| DEV-03 | Devin executor sequence | GetUserJwt, optional AssignModel, missing assignment JWT/UID, assignment failure, GetChatMessage | Order/auth/model selection observable; failure bounded; không prompt replay loop | Deterministic / EXTEND |
| DEV-04 | Devin stream errors | Text/tool/usage/trailer, partial output rồi trailer error, mid-stream Connect error, cancel | `[DONE]` chỉ ở completion hợp lệ; error bounded/redacted; cancel không replay | Deterministic / EXTEND |
| ANT-01 | Claude → OpenAI bridge → target executor | Image URL/base64, tool_result image/is_error, interleaved tool IDs | URL/inline theo policy; image/tool error semantics preserved; target executor rõ | Deterministic / KNOWN-XFAIL |
| ANT-02 | OpenAI → Claude bridge → Anthropic/GLM executor | Thinking/redacted thinking/signature, text/tool_use, empty Read, fragmented blocks | Block order/signature/tool IDs/finish ordering hợp lệ; empty Read normalized | Deterministic / KNOWN-BASELINE + KNOWN-XFAIL |
| ANT-03 | Claude Code context bridge | Compatible non-Claude target vs official Claude target | Prompt chỉ inject nơi target contract yêu cầu; tool_choice/input_audio không bị đổi ngoài policy | Deterministic / KNOWN-XFAIL |
| ANT-04 | Anthropic headers/proxy | Official host, auth/beta, forwarded attacker headers, proxy strict/fallback/NO_PROXY | Header cần thiết giữ; hop-by-hop/attacker header strip; assert egress policy, không pin call count | Deterministic / KNOWN-BASELINE + NEW assertions (baseline informational) |
| ANT-05 | Translator dispatch | Registered direct route vs OpenAI pivot cho Anthropic/GLM/MiMo; Devin request | Direct route ưu tiên; bridge chỉ khi mismatch; Devin bypasses generic translator | Deterministic / NEW |
### 7.3 Thứ tự thực thi và cổng phát hành
1. Chốt policy observable cho remote images, proxy schemes/NO_PROXY và OAuth callback output trước khi sửa source; ghi quyết định vào test name/fixture.
2. Viết SEC-01..06 và DEV-01..04 bằng mock deterministic; giữ mỗi test fail nếu regression quay lại.
3. Sửa P0 theo thứ tự `FIX-SEC-04` → `FIX-SEC-03` → `FIX-SEC-01/02` → `FIX-SEC-05/06`, sau đó chạy lại toàn bộ SEC và DEV security cases.
4. Sửa P1 theo provider; mỗi provider phải pass test path riêng trước khi chạy bridge/cross-provider cases.
5. Chạy P2 contract cases; `glm-cn` và Devin native không được gộp vào assertion của `glm` hoặc generic translator.
6. Gate deterministic: focused tests pass, không có failure mới ngoài `known-fails.txt`, không giảm coverage observable, không lộ secret trong response/log/error.
7. Gate baseline: dùng relative test path; không biến `it.fails`, live/network, snapshot mismatch hoặc setup/path failure thành pass criteria.
8. Gate integration: chạy suite đầy đủ qua test-runner; phân loại từng failure theo path/provider/status, rồi review consolidated code diff trước release.
9. Rollback: revert từng FIX ID theo owner/module; giữ tests để ngăn regression và không rollback chung toàn bộ provider registry hoặc retry constants.

## 8. Ưu tiên và ownership đề xuất
| Ưu tiên | Nhóm | Owner module | Kết quả cần có |
|---|---|---|---|
| P0 | Security boundary verification: callback/API projection/proxy/lock/DNS-frame | OAuth, DB usage, network, MITM, Devin | Behavioral security tests và fix chỉ khi contract/reproduction xác nhận |
| P1 | Codex image/Responses | Codex executor + Responses translator | Multimodal và tool payload đúng |
| P1 | Antigravity retry/translator | Antigravity executor + translator | Retry/failover/tool stream đúng |
| P1 | Anthropic thinking/Read/proxy | Claude translator + proxy | Thinking/tool stream và proxy behavior đúng |
| P1 | MiMo anti-abuse/401 | MiMo executor + gateway | Policy deterministic, retry bounded |
| P2 | Zai-Coding-Plan (`glm`) | `glm` registry + generic transports | OpenAI/Claude dual-transport coverage; không gộp `glm-cn` |
| P2 | Devin provider coverage sau security gate | Devin executor/protobuf | Native RPC contract coverage; không trì hoãn P0 security acceptance |

## 9. Kết luận

### Kết luận theo source working tree

#### Đã xác nhận từ mã nguồn

- Codex chat prefetch thất bại vẫn có thể submit URL gốc (`fetched?.url || url`); image-generation là path độc lập không qua prefetch.
- Antigravity image edit chỉ nhận data URI/raw base64; image-generation refresh caller không truyền `proxyOptions` dù executor có proxy-aware refresh.
- MiMo và GLM (`glm`) có registry/executor dispatch đầy đủ; MiMo preview dùng session cookie, cloud dùng registry transport; GLM đi qua `DefaultExecutor` với OpenAI/Claude transport.
- Devin đang dùng native ConnectRPC/protobuf với HTTPS custom URL và giới hạn frame; DNS rebinding/private resolution vẫn là gap.
- Generic/default refresh có proxy-aware path, nhưng Codex credential-manager caller không truyền `proxyOptions`.

#### Đã reclassify so với test/report cũ

- MiMo OAuth XSS mức HIGH không còn được source hiện tại xác nhận ở renderer đã khảo sát; giữ behavioral regression test cho callback consumer, không gọi là fixed toàn flow nếu chưa audit hết consumer.
- Raw API-key leakage trong usage summary không còn được source hiện tại xác nhận ở JSON projection: summary mask key; raw key chỉ còn trong metadata aggregation nội bộ. Cần API-level test trước khi kết luận exposure.
- Antigravity retry/failover có bounded handling cho 403/404/429 và transient 5xx; test cũ về attempt count không đủ lý do đổi constant.

#### Còn cần kiểm chứng deterministic

- Codex remote-image policy, Responses empty function calls, account-header isolation và refresh proxy.
- Antigravity image remote-URL policy, image refresh proxy propagation và MITM startup lock ownership.
- MiMo credential/control-character isolation, provider-specific URL override và anti-abuse policy.
- GLM dual transport/auth, foreign tool history và Claude bridge semantics.
- Devin DNS resolution behavior, frame rejection, model assignment và mid-stream Connect errors.
- Anthropic proxy/header baseline, Claude bridge image/system-prompt behavior và token-refresh caller.

Không cập nhật snapshot hoặc đổi retry constant chỉ để làm test xanh. Mọi kết luận production phải dựa trên behavior deterministic mô phỏng đúng execution path; live provider tests chỉ là smoke tests có prerequisite rõ ràng.

