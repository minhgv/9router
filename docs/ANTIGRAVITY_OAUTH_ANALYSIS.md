# Báo Cáo Phân Tích & So Sánh Cơ Chế OAuth Antigravity: 9Router vs Antigravity-Opencode

Tài liệu này phân tích chi tiết module OAuth Login của **Google Antigravity**, cơ chế ngụy trang chống ban (Anti-ban / Cloaking) trên **9Router (`9router-app`)**, và so sánh đối chiếu trực diện với repo **Antigravity-Opencode**.

---

## 1. Kiến Trúc OAuth & Onboarding của 9Router

9Router triển khai flow xác thực và quản lý tài khoản Antigravity thông qua 2 tầng: tầng xác thực (`src/lib/oauth/`) và tầng vận hành (`open-sse/executors/antigravity.js`, `open-sse/services/tokenRefresh.js`).

### 1.1. Luồng OAuth 2.0 & Trao đổi Token
- **Flow Type**: `authorization_code` với Google OAuth Authorization Endpoint.
- **Client ID & Secret**: Tái sử dụng OAuth Client ID chính thức của Antigravity Desktop / CLI:
  - `clientId`: `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`
  - Scopes: truy cập Cloud Code Assist, user info, openid, email.
- **Auto Token Refresh**: Tích hợp tại `open-sse/services/tokenRefresh.js`, tự động refresh trước khi token hết hạn `300.000ms` (5 phút).

### 1.2. Khám phá Project & Kích hoạt Tài nguyên (Onboarding)
- **Truy vấn Cloud AI Companion Project**: Sau khi có `access_token`, 9Router gọi endpoint nội bộ:
  ```http
  POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist
  ```
  Trích xuất `cloudaicompanionProject.id` và `tierId` mặc định.
- **Tự động Onboarding**: Nếu tài khoản mới chưa được kích hoạt, hệ thống chạy background worker gọi:
  ```http
  POST https://cloudcode-pa.googleapis.com/v1internal:onboardUser
  ```
  Thực hiện thử lại (retry) tối đa 10 lần (chu kỳ 5s) cho đến khi tài nguyên backend của Google sẵn sàng (`done: true`).

---

## 2. Cơ Chế Chống Ban (Anti-Ban / Cloaking) Của 9Router

Google backend liên tục kiểm tra traffic để ngăn chặn việc sử dụng tài nguyên Antigravity thông qua các client bên ngoài. 9Router thiết lập hệ thống phòng vệ 5 lớp:

### 2.1. Giả lập Dấu vân tay Vân cứng (Fingerprint & User-Agent)
- **User-Agent đồng nhất**: Bất kể chạy trên máy chủ Linux, Docker hay Windows, 9Router luôn gửi header giả lập bản build desktop chính thức:
  ```text
  User-Agent: antigravity/ide/2.11.0 darwin/arm64
  ```
- **Header Sanitize**: Khi gọi `loadCodeAssist` và `onboardUser`, 9Router chủ động loại bỏ các header mặc định của SDK như `X-Goog-Api-Client` và `Client-Metadata` để không để lộ dấu vết môi trường không phải Antigravity Desktop.

### 2.2. Cloaking Công Cụ & Decoy Tools
- **Tool Renaming (`_ide` Suffix)**: Mọi công cụ do client gửi lên (như `Bash`, `Edit`, `ReadFile`...) đều được tự động đổi tên thêm hậu tố `_ide` (ví dụ `Bash_ide`) trước khi gửi đến Google. Khi model trả về phản hồi gọi hàm, 9Router uncloak trở lại tên gốc cho client.
- **Tool Decoy Injection**: Tự động chèn các công cụ mặc định của Antigravity IDE (`AG_DECOY_TOOLS`) vào schema khai báo nhằm làm payload giống 100% phiên làm việc của lập trình viên trong IDE chính thức.

### 2.3. Lọc Bỏ System Prompt & Branding Đối Thủ
Google sẽ từ chối hoặc trả về `429 Quota Exhausted` nếu phát hiện system prompt chứa định danh của các công cụ AI khác. 9Router sử dụng bộ chuyển đổi `ANTIGRAVITY_PROMPT_REWRITES`:
- Xóa chuỗi nhận diện: `"You are a Claude agent, built on Anthropic's Claude Agent SDK."`
- Thay thế regex: `/opencode/gi` $\rightarrow$ `"Antigravity"` / `"antigravity"`.
- Bỏ các cấu hình không tương thích (`output_config`, `thinking`, `reasoning_effort`...).

### 2.4. Giả lập Định dạng Request ID & Trajectory
Thay vì dùng chuỗi ngẫu nhiên, 9Router sinh `requestId` theo cấu trúc luồng quyết định của Agent chính thức:
```text
agent/{conversationId}/{timestamp}/{trajectoryId}/{step}
```
- `conversationId` và `trajectoryId` được sinh tất định từ session ID, model và request type.
- Chỉ số `step` tăng dần theo số lượt hội thoại (`contentCount * 2 - 1`).

### 2.5. Hỗ trợ Gemini 3+ Thought Signature
Hạ tầng Gemini 3+ yêu cầu `thoughtSignature` đi kèm các function calls. 9Router duy trì session-based signature store và tự động backfill `DEFAULT_THINKING_AG_SIGNATURE` vào lượt gọi hàm đầu tiên để tránh bị Google chặn vì sai cấu trúc message.

---

## 3. So Sánh Trực Diện: 9Router vs Antigravity-Opencode

| Tiêu chí | 9Router (`9router-app`) | Antigravity-Opencode | Đánh giá rủi ro & chất lượng |
| :--- | :--- | :--- | :--- |
| **Kiến trúc & Mục tiêu** | Gateway / Proxy trung gian tổng quát (Next.js/Node), chuyển đổi cho mọi client (Cursor, Claude Code, OpenCode, VS Code...). | Plugin / SDK tích hợp trực tiếp client-side cho OpenCode / Pi agent. | **9Router** bảo vệ tập trung nhiều client; **Antigravity-Opencode** gọn nhẹ cho 1 runtime cụ thể. |
| **User-Agent Fingerprint** | Cố định **vân tay IDE Desktop chính thức**: `antigravity/ide/2.11.0 darwin/arm64`. | Thay đổi theo môi trường máy người dùng (`darwin/windows/linux`, `arm64/amd64`) hoặc dùng chuỗi `cli/1.1.13`. | 🚩 **Antigravity-Opencode rủi ro cao**: Google dễ phát hiện UA dạng CLI hoặc sai lệch platform. |
| **Header Sanitize** | **Loại bỏ** `X-Goog-Api-Client` và `Client-Metadata` ở bước `loadCodeAssist`. | **Vẫn gửi kèm** `X-Goog-Api-Client: google-cloud-sdk vscode_cloudshelleditor/0.1` và `Client-Metadata: { ideType: "IDE_UNSPECIFIED" }`. | 🚩 **9Router an toàn hơn**: Không để lộ dấu vết VS Code / Cloud Shell. |
| **Tool Cloaking & Decoy** | **Có bộ đôi**: Rename tool sang đuôi `_ide` + Inject decoy tools mặc định của IDE. | **Không có**: Gửi nguyên bản tool declaration của client (chỉ validate schema). | 🚩 **Khác biệt cốt tử**: Antigravity-Opencode dễ bị quét lộ các hàm lạ (`execute_bash`, `run_command`...). |
| **Lọc System Prompt** | **Bộ lọc regex tự động**: Xóa branding Claude SDK, chuyển `opencode` thành `antigravity`. | **Không lọc**: Chỉ chèn thêm prompt định danh Antigravity. | 🚩 **9Router vượt trội**: Tránh được mã lỗi 429 Quota Exhausted do dính từ khóa kiểm duyệt của Google. |
| **Cấu trúc Request ID** | Giả lập chuẩn trajectory của IDE: `agent/{conv}/{time}/{traj}/{step}`. | Format tự sinh thô: `agent-${Date.now()}-${randomBytes(4)}`. | 🚩 **9Router tinh vi hơn**: Khớp chính xác hành vi của Agent trên IDE thật. |
| **Thought Signature** | Duy trì store lưu vết và backfill signature chuẩn (`DEFAULT_THINKING_AG_SIGNATURE`). | Dùng flag bypass: `SKIP_THOUGHT_SIGNATURE` (`"skip_thought_signature_validator"`). | ⚖️ **Antigravity-Opencode dùng mẹo ngắn gọn**, 9Router giả lập luồng thật bền vững hơn khi Google tắt flag. |
| **Xử lý Project ID** | Onboarding tự động retry 10 lần để nhận Google Cloud Project thật. | Nếu `loadCodeAssist` thất bại, **tự sinh project băm từ email** (`stableProjectId(email)`). | 🚩 **Antigravity-Opencode dễ bị ban ngầm**: Project giả lập sẽ bị đánh dấu bất thường trên hệ thống Google. |

---

## 4. Những Điểm Antigravity-Opencode Làm Tốt Hơn 9Router

Dù 9Router vượt trội về chống ban, **Antigravity-Opencode** lại sở hữu các giải pháp kỹ thuật sâu sắc, đáng để 9Router học hỏi:

### 4.1. Dự Phòng Endpoint Đa Tầng (Multi-Endpoint Cascade)
Antigravity-Opencode cấu hình danh sách endpoint dự phòng tự động khi gặp mã lỗi 403/404:
```typescript
export const ENDPOINT_FALLBACKS = [
  "https://cloudcode-pa.googleapis.com",                // Production
  "https://daily-cloudcode-pa.sandbox.googleapis.com",   // Daily Sandbox
  "https://autopush-cloudcode-pa.sandbox.googleapis.com" // Autopush Sandbox
];
```
Nếu cluster production bị siết quota hoặc lỗi mạng, hệ thống tự trượt sang cụm sandbox nội bộ mà không ngắt quãng phiên làm việc. *9Router hiện chỉ gắn cứng một endpoint production.*

### 4.2. Tra Cứu Quota Chi Tiết Đến Từng Phút (`/quota`)
Antigravity-Opencode có module khai thác endpoint nội bộ:
```http
POST /v1internal:retrieveUserQuotaSummary
```
- Trích xuất chi tiết từng bucket: tên nhóm model, tỉ lệ còn lại (`remainingFraction`), thời điểm reset chính xác (`2h 15m`).
- Hiển thị thanh tiến trình trực quan (`formatProgressBar`) qua lệnh CLI. *9Router hiện chưa khai thác API này, chỉ phụ thuộc vào mã lỗi 429 khi hết hạn ngạch.*

### 4.3. Đệ Quy Schema & Khử Con Trỏ `$ref` (`dereferenceSchema`)
Antigravity-Opencode xây dựng bộ parser đệ quy chuẩn OpenAPI (`utils/schema.ts`):
- Mở rộng triệt để các tham chiếu lồng nhau `$ref`, `$defs`, `definitions`.
- Loại bỏ các meta-declaration không được Gemini backend hỗ trợ (`$schema`, `$id`, `$anchor`).
- Ngăn chặn triệt để lỗi `HTTP 400 Invalid Argument` đối với các schema tool phức tạp từ client.

### 4.4. Module Chuyên Biệt Cho Sinh Ảnh (Image Generation Subsystem)
- Hỗ trợ pipeline chuyên trách cho các model ảnh: `gemini-3-pro-image`, `gemini-3.1-flash-image`.
- Kiểm tra tỉ lệ khung hình khắt khe của Gemini (`1:1`, `3:4`, `4:3`, `9:16`, `16:9`).
- Tự động ghi file ảnh nhị phân ra đĩa (`.opencode/generated-images/`) với tên file theo timestamp có cấu trúc.

### 4.5. Tối Ưu Độ Trễ Bằng Prewarm TLS Connection
- Hàm fetch tự động gọi `prewarmConnection()` trong background ngay khi khởi tạo plugin, hoàn tất bắt tay TLS/TCP trước khi người dùng thực hiện câu lệnh đầu tiên, giảm tối đa thời gian TTFT (Time to First Token).

### 4.6. Cơ Chế Debug Snapshot Tức Thời (`OPENCODE_AGY_DEBUG=1`)
- Tự động dump toàn bộ request envelope, generationConfig, tool count và 2000 ký tự error body ra file `/tmp/agy-debug-<timestamp>.json` khi request gặp lỗi, hỗ trợ debug nhanh chóng.

---

## 5. Kết Luận & Khuyến Nghị

- **Về khả năng bảo vệ tài khoản**: **9Router an toàn hơn đáng kể** nhờ khả năng ngụy trang tinh vi (tool cloaking, decoy injection, lọc prompt branding, trajectory request ID và loại bỏ header rò rỉ).
- **Về độ hoàn thiện kỹ thuật có thể tích hợp thêm vào 9Router**:
  1. Thêm danh sách fallback endpoint (`daily` và `autopush`).
  2. Bổ sung endpoint/UI hiển thị quota chi tiết thông qua `retrieveUserQuotaSummary`.
  3. Áp dụng hàm đệ quy `dereferenceSchema` cho tool parameters để hạn chế lỗi HTTP 400 từ Gemini.
