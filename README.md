# captcha-solver

Thư viện Node.js nhỏ để xử lý CAPTCHA trong **môi trường development/staging**.

Tool **không** vượt được CAPTCHA thật trên production và không được thiết kế cho mục đích đó.
Tool chỉ xử lý được:

- câu hỏi text theo đúng hai mẫu cố định (biểu thức số học, đảo từ);
- test key chính thức mà hCaptcha và Cloudflare Turnstile công bố cho kiểm thử tự động.

Khi không xử lý được, tool trả về `failure` hoặc `unsupported`. Tool **không bao giờ** trả kết quả ngẫu nhiên hay kết quả bịa.

## Cài đặt & chạy test

Yêu cầu Node.js >= 18. Không có dependency.

```bash
npm test
```

## API

```js
const { solve, Status, TEST_KEYS, TEST_ENVIRONMENTS } = require('./captcha_solver');

const result = await solve('text', { challenge: 'What is 5 + 3?' });
// { status: 'success', type: 'text', value: '8' }
```

`solve(type, input)` luôn resolve, không throw, và trả về một trong ba dạng:

| `status` | Ý nghĩa | Trường kèm theo |
|---|---|---|
| `success` | Xử lý được | `value` |
| `failure` | Input sai định dạng, hoặc loại được hỗ trợ nhưng không giải được input này | `error` |
| `unsupported` | Loại CAPTCHA, site key hoặc môi trường không được hỗ trợ | `error` |

Người gọi phải kiểm tra `status` trước khi dùng `value`.

## Khả năng theo từng loại

| `type` | `input` | Trạng thái | Chi tiết |
|---|---|---|---|
| `text` | `{ challenge }` | Đã triển khai (hẹp) | Xem bên dưới |
| `image` | bất kỳ | **Chưa triển khai** | Luôn trả `unsupported` |
| `hcaptcha` | `{ siteKey }` | Chỉ hỗ trợ test key | Trả response token test chính thức |
| `turnstile` | `{ siteKey }` | Chỉ hỗ trợ test key | Trả dummy token `XXXX.DUMMY.TOKEN.XXXX` |
| `recaptcha` | `{ siteKey }` | **Không giải được** | Google không công bố response token test, nên luôn trả `unsupported` |
| loại khác | — | Không hỗ trợ | `unsupported` |

### `text`

Chỉ nhận đúng hai mẫu dưới đây (không phân biệt hoa thường ở phần chỉ dẫn, bỏ qua khoảng trắng đầu/cuối, tối đa 256 ký tự):

- `What is <biểu thức>?`, ví dụ `What is (2 + 3) * -1.5?` → `-7.5`.
  - Hỗ trợ `+ - * /`, ngoặc lồng nhau, dấu trừ một ngôi và số thập phân dạng `1.5` (không nhận `.5`, `5.`, `+3`, `**`, `%`, `^`).
  - Ưu tiên toán tử chuẩn (`*` `/` trước `+` `-`), kết hợp trái: `10 - 4 - 3` → `3`.
  - Tính toán chính xác bằng phân số `BigInt`, không dùng `eval`/`Function`, nên không có sai số dấu phẩy động: `0.1 + 0.2` → `0.3`.
  - Kết quả là chuỗi thập phân chính xác, không làm tròn. Kết quả là số thập phân vô hạn (`1 / 3`) trả `failure` với `INEXACT_RESULT`.
  - Toán hạng hoặc kết quả có trị tuyệt đối vượt `Number.MAX_SAFE_INTEGER` trả `OUT_OF_RANGE`. Giá trị trung gian lớn hơn vẫn được tính chính xác.
- `Reverse the word '<từ>'` hoặc `Reverse the word ‘<từ>’` (nháy thẳng hoặc nháy cong đơn, phải đúng cặp), ví dụ `Reverse the word 'hello'` → `olleh`.
  - Đảo theo grapheme bằng `Intl.Segmenter`, nên dấu tổ hợp (NFD), emoji ZWJ, màu da và cờ quốc gia giữ nguyên. Không normalize: input NFC trả NFC, input NFD trả NFD.

Khi `failure`, kết quả có thêm trường `code`:

| `code` | Khi nào |
|---|---|
| `INVALID_INPUT` | `input.challenge` không phải chuỗi, rỗng, hoặc dài hơn 256 ký tự |
| `UNRECOGNIZED_CHALLENGE` | Không khớp mẫu nào được hỗ trợ (kể cả `What is five plus three?`, `What is 5 % 3?`) |
| `INVALID_EXPRESSION` | Phần sau `What is` chỉ gồm ký tự số học nhưng sai cú pháp, ví dụ `2 +`, `(2 + 3`, `1.2.3` |
| `DIVISION_BY_ZERO` | Chia cho 0 ở bất kỳ vị trí nào |
| `OUT_OF_RANGE` | Toán hạng hoặc kết quả vượt `Number.MAX_SAFE_INTEGER` |
| `INEXACT_RESULT` | Kết quả không biểu diễn được chính xác bằng số thập phân hữu hạn |

### `hcaptcha`, `turnstile`, `recaptcha`: chỉ dùng test key chính thức

Chỉ hoạt động khi thoả **cả hai** điều kiện:

1. `process.env.NODE_ENV` là một trong `development`, `test`, `staging` (phân biệt hoa thường).
2. `siteKey` là test key chính thức của đúng provider đó.

Nếu không thoả, tool trả `unsupported`. Site key thật luôn trả `unsupported`.

| Provider | Site key | Kết quả |
|---|---|---|
| hCaptcha | `10000000-ffff-ffff-ffff-000000000001` | `success`, token `10000000-aaaa-bbbb-cccc-000000000001` |
| hCaptcha | `20000000-ffff-ffff-ffff-000000000002` | `success`, token `20000000-aaaa-bbbb-cccc-000000000002` (Enterprise, người dùng hợp lệ) |
| hCaptcha | `30000000-ffff-ffff-ffff-000000000003` | `success`, token `30000000-aaaa-bbbb-cccc-000000000003` (Enterprise, bị đánh dấu bot) |
| Turnstile | `1x00000000000000000000AA` / `1x00000000000000000000BB` | `success`, dummy token |
| Turnstile | `2x00000000000000000000AB` / `2x00000000000000000000BB` | `failure` (key được cấu hình để luôn fail) |
| Turnstile | `3x00000000000000000000FF` | `unsupported` (bắt buộc tương tác) |
| reCAPTCHA v2 | `6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI` | `unsupported` (không có token test) |

Secret key test cho server nằm trong `TEST_KEYS`. Object này được deep-freeze.

- reCAPTCHA: `TEST_KEYS.recaptcha.secretKey`. Với secret này, mọi request `siteverify` đều pass, vì vậy để test reCAPTCHA chỉ cần cấu hình cặp test key ở cả client và server; tool không cần sinh token.
- hCaptcha: `TEST_KEYS.hcaptcha.secretKey`.
- Turnstile: `TEST_KEYS.turnstile.secretKeys.alwaysPasses`, `.alwaysFails` và `.tokenAlreadySpent`.

Nguồn (đã đối chiếu ngày 2026-10-13):

- reCAPTCHA: <https://developers.google.com/recaptcha/docs/faq>
- hCaptcha: <https://docs.hcaptcha.com/#integration-testing-test-keys>
- Turnstile: <https://developers.cloudflare.com/turnstile/troubleshooting/testing/>

## Cách dùng khuyến nghị cho staging/E2E

1. Ở staging, cấu hình app dùng **cặp** test site key + test secret key của provider, đọc từ biến môi trường và không hardcode vào app.
2. Trong test E2E, gọi `solve('<provider>', { siteKey })` để lấy token, rồi gửi token đó vào form.
3. Server verify bằng test secret key và nhận kết quả theo hành vi đã được tài liệu hoá.

Các provider đều cảnh báo rằng test key **không có khả năng chống bot**. Tuyệt đối không dùng test key trên production.

## Giới hạn còn lại

- Không có OCR hay giải CAPTCHA ảnh, và không có kế hoạch bổ sung.
- Không gọi `siteverify` qua mạng. Việc verify là trách nhiệm của server dưới test.
- Không hỗ trợ reCAPTCHA v3/Enterprise, hCaptcha Enterprise ngoài các test key nêu trên, hay site key thật của bất kỳ provider nào.
- Chỉ đọc `NODE_ENV` để nhận biết môi trường. Nếu staging chạy với `NODE_ENV=production` thì tool sẽ từ chối.
- Test key và token được sao chép thủ công từ tài liệu. Nếu provider thay đổi, cần cập nhật `TEST_KEYS`.
- Chưa có quy tắc làm tròn, nên mọi kết quả thập phân vô hạn đều bị từ chối.
- `code` hiện chỉ có ở kết quả của loại `text`; các loại khác sẽ được chuẩn hoá ở Phase 2.
