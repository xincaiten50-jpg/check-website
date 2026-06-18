# VIBE_CODING_WORKFLOW — check-website

## Stack
- **Runtime**: Node.js (CommonJS)
- **Package Manager**: npm
- **Key Dependencies**: playwright, ssh2, dotenv
- **Main Entry**: `index.js`

## Test / Build / Lint Commands

| Command | Mô tả |
|---------|-------|
| `npm run check:syntax` | Syntax check — `node --check index.js` |
| `npm run test:threshold` | Test dead threshold alert |
| `npm run test:log` | Test log rotation |
| `npm run test:schedule` | Test scheduling |
| `npm run test:normal` | Test daily normal report |
| `npm run test:all` | Chạy tất cả tests trên |
| `node index.js` | Chạy check thật (gửi Telegram) |
| `node index.js --dry-run` | Chạy mô phỏng, không gửi Telegram |

## When To Use What

### Browser Verification
- Khi sửa logic click handling (k-type links)
- Khi thay đổi selectors hoặc wait conditions
- Dùng: chạy thật + kiểm tra kết quả trên Telegram

### Debugger / Runtime Evidence
- Dùng `node inspect index.js` khi cần breakpoint trong code
- Dùng `console.log` cho nhanh khi trace logic nhỏ
- Dùng `process.stdout.write` debug state khi playwright behavior lạ

### Spike / Prototype
- Khi không chắc hướng sửa: tạo file test riêng trong repo root
- Ví dụ: `test-new-selector.js` để thử selector mới trước khi sửa index.js
- Xóa file spike sau khi xác nhận hướng đúng

### Browser Automation
- Skill `browser-automation` hỗ trợ multi-step flows, tab management
- Dùng khi cần verify UI thật sau khi sửa

## Quy Tắc Không Sửa Lan Man
1. Mỗi lần sửa chỉ edit 1-2 blocks nhỏ, có comment đánh dấu
2. Trước khi sửa: luôn đọc kỹ code hiện tại
3. Sau khi sửa: chạy `npm run check:syntax` trước
4. Không sửa nhiều file cùng lúc nếu không cần
5. Dùng `git diff` hoặc đọc lại file để verify thay đổi đúng chỗ

## Quy Tắc Final Report
Mỗi lần hoàn thành sửa, báo cáo gồm:
- Đã sửa gì,ở file nào
- Verification command đã chạy và kết quả
- Còn rủi ro gì / cần theo dõi gì

## Verification Gates
- **Bắt buộc**: `npm run check:syntax` pass trước khi claim done
- **Khuyến khích**: `node index.js --dry-run` để xem kết quả thật

## Workflow Áp Dụng
```
understand repo → plan → spike (nếu cần) → edit nhỏ → test/build → debug → browser verify → summarize
```

## How To Use This Going Forward

### Bug UI / Content
1. Chạy `node index.js --dry-run` xem output
2. Kiểm tra results.json và Telegram message
3. Nếu cần browser thật: dùng skill browser-automation

### Bug Runtime / Logic
1. Chạy `npm run check:syntax` trước
2. Thêm console.log tạm vào vị trí nghi ngờ
3. Chạy `node index.js --dry-run` xem log
4. Dùng spike file nếu cần test riêng logic đó

### Chưa Chắc Hướng Sửa
1. Tạo spike file (test-xxx.js) trong repo root
2. Test riêng logic mới
3. Khi đúng, apply vào index.js
4. Xóa spike file

### Cần Research
1. Dùng web_search/web_fetch để tra cứu
2. Kiểm tra docs của playwright, ssh2
3. Không cài package mới khi chưa cần

## Skills Available (Platform)
- `browser-automation`: multi-step flows, tab management
- `node-inspect-debugger`: breakpoint, CDP debugging
- `spike`: prototype validation
- `taskflow`: orchestration cho multi-step jobs

## Risks / Blockers
- SSH tunnel phụ thuộc vào server 36.134.139.96 — có thể fail nếu server down
- SOCKS proxy port 1080 — cần kill process cũ trước khi chạy mới
- Telegram notification phụ thuộc vào .env config (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) — không có trong repo
