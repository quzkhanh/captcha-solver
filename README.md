# captcha-solver

Thư viện Node.js nhỏ để xử lý CAPTCHA trong **môi trường development/staging**.

Tool **không** vượt được CAPTCHA thật trên production và không được thiết kế cho mục đích đó.
Tool chỉ xử lý được:

- câu hỏi text theo đúng hai mẫu cố định (biểu thức số học, đảo từ);
- ảnh chứa chữ in rõ ràng, qua module OCR tổng quát `image_ocr/` (Tesseract), chỉ trong môi trường test;
- test key chính thức mà hCaptcha và Cloudflare Turnstile công bố cho kiểm thử tự động.

Khi không xử lý được, tool trả về `failure` hoặc `unsupported`. Tool **không bao giờ** trả kết quả ngẫu nhiên hay kết quả bịa.

`solve('image')` dùng module **OCR tổng quát** cho ảnh văn bản thông thường, xem [Module Image OCR](#module-image-ocr-image_ocr).

Repo còn có module **Object Detection** độc lập (`object_detection/`) cho ảnh chụp thông thường. Module này không được `solve()` hay `image_ocr` sử dụng, xem [Module Object Detection](#module-object-detection-object_detection).

## Cài đặt & chạy test

Yêu cầu Node.js >= 20.9 (do `sharp`). Chỉ `solve('image')` cần `sharp` và Tesseract (xem [cài đặt](#cài-đặt)); `image_ocr` được require lazily, nên các loại khác vẫn chạy khi thiếu hai thứ này.

```bash
npm install
npm test
```

## Cấu trúc thư mục

```
src/
  captcha_solver.js            solve(): text, image (qua image_ocr), test key hCaptcha/Turnstile
  image_ocr/                   OCR tổng quát (Tesseract)
  object_detection/            nhận diện vật thể (YOLOX ONNX), độc lập với hai phần trên
scripts/
  ocr/                         ocr.js · generate_dataset.js · benchmark.js
  object_detection/            detect.js · download_model.js · prepare_dataset.js · benchmark.js
models/  dataset/  benchmark-results/    sinh ra lúc chạy, không commit (.gitignore)
```

Test nằm cạnh code (`*.test.js`), `npm test` tự tìm và chạy tất cả.

## API

```js
const { solve, Status, TEST_KEYS, TEST_ENVIRONMENTS } = require('./src/captcha_solver');

const result = await solve('text', { challenge: 'What is 5 + 3?' });
// { status: 'success', type: 'text', value: '8' }
```

`solve(type, input)` luôn resolve, không throw, và trả về một trong ba dạng:

| `status` | Ý nghĩa | Trường kèm theo |
|---|---|---|
| `success` | Xử lý được | `value` |
| `failure` | Input sai định dạng, hoặc loại được hỗ trợ nhưng không giải được input này | `error`, và `code` với `text`/`image` |
| `unsupported` | Loại CAPTCHA, site key hoặc môi trường không được hỗ trợ | `error` |

Người gọi phải kiểm tra `status` trước khi dùng `value`.

## Khả năng theo từng loại

| `type` | `input` | Trạng thái | Chi tiết |
|---|---|---|---|
| `text` | `{ challenge }` | Đã triển khai (hẹp) | Xem bên dưới |
| `image` | `{ image }` | Đã triển khai (OCR tổng quát) | Chỉ khi `NODE_ENV` là môi trường test. Xem bên dưới |
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

### `image`

```js
process.env.NODE_ENV = 'test';
await solve('image', { image: 'fixtures/challenge.png' });   // đường dẫn file, Buffer hoặc Uint8Array
// { status: 'success', type: 'image', value: 'K7PX9Q' }
```

- Chỉ chạy khi `NODE_ENV` là `development`, `test` hoặc `staging`, giống các loại widget. Ngoài ra trả `unsupported` và không chạy OCR.
- `input.image` được chuyển nguyên vẹn vào `recognizeImage()` của `image_ocr/` với cấu hình mặc định (tiền xử lý mặc định, Tesseract `eng`, `--psm 3`). Không có OCR thứ hai hay xử lý riêng cho chữ bị làm méo có chủ đích: ảnh nào module OCR không đọc được thì `solve('image')` cũng không đọc được.
- `value` là text đã chuẩn hoá của OCR; ảnh nhiều dòng giữ `\n` giữa các dòng. Kết quả theo đúng contract `{ status, type, value }`, không kèm confidence. Cần confidence hoặc tuỳ chọn engine thì gọi thẳng `recognizeImage()`.
- OCR chạy thành công nhưng không thấy chữ trả `failure` với `NO_TEXT_DETECTED`, không bao giờ trả `success` với chuỗi rỗng.
- Lỗi của OCR trả `failure`, `code` và `error` lấy nguyên từ module OCR (`INVALID_INPUT`, `FILE_NOT_FOUND`, `EMPTY_INPUT`, `FILE_TOO_LARGE`, `UNSUPPORTED_FORMAT`, `CORRUPTED_IMAGE`, `IMAGE_TOO_LARGE`, `PREPROCESSING_FAILED`, `ENGINE_UNAVAILABLE`, `ENGINE_TIMEOUT`, `ENGINE_ERROR`), xem [bảng mã lỗi](#kết-quả-trả-về).
- Không load được module OCR (ví dụ thiếu `sharp`) hoặc module ném lỗi bất ngờ trả `failure` với `INTERNAL_ERROR`.

Chạy thử trên ảnh của bạn:

```bash
NODE_ENV=test node -e 'require("./src/captcha_solver").solve("image", { image: process.argv[1] }).then((r) => console.log(r))' path/to/image.png
```

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

- `solve('image')` chỉ là OCR tổng quát cho chữ in rõ ràng. Độ chính xác đã đo chỉ áp dụng cho ảnh văn bản tổng hợp (xem [kết quả](#kết-quả-thực-tế)); chữ bị làm méo, gạch chồng hay dính nhau sẽ đọc sai hoặc thất bại.
- `solve('image')` không trả confidence, nên người gọi không phân biệt được kết quả chắc chắn với kết quả đoán sai. Mỗi lần gọi spawn một process Tesseract.
- Không gọi `siteverify` qua mạng. Việc verify là trách nhiệm của server dưới test.
- Không hỗ trợ reCAPTCHA v3/Enterprise, hCaptcha Enterprise ngoài các test key nêu trên, hay site key thật của bất kỳ provider nào.
- Chỉ đọc `NODE_ENV` để nhận biết môi trường. Nếu staging chạy với `NODE_ENV=production` thì tool sẽ từ chối.
- Test key và token được sao chép thủ công từ tài liệu. Nếu provider thay đổi, cần cập nhật `TEST_KEYS`.
- Chưa có quy tắc làm tròn, nên mọi kết quả thập phân vô hạn đều bị từ chối.
- `code` hiện chỉ có ở kết quả của loại `text` và `image`; các loại widget sẽ được chuẩn hoá ở Phase 2.

---

## Module Image OCR (`image_ocr/`)

OCR tổng quát cho ảnh văn bản thông thường: ảnh chụp màn hình, ảnh scan, ảnh văn bản tổng hợp, dataset nghiên cứu được phép dùng.

Module là engine phía sau `solve('image')` (xem [`image`](#image)), và cũng dùng trực tiếp được qua `recognizeImage()`. Module không gọi mạng, không tương tác với website, và không có bước xử lý nào nhắm vào chữ bị làm méo có chủ đích.

### Kiến trúc

```
recognizeImage(source, options)                       src/image_ocr/index.js
  │  kiểm tra options (limits, preprocessing, engine)  → INVALID_OPTIONS
  ├─ ImageInputValidator   src/image_ocr/validator.js       → stage "input"
  │    đọc file/Buffer, giới hạn byte, magic bytes, header (kích thước, số pixel), decode đầy đủ
  ├─ ImagePreprocessor     src/image_ocr/preprocessor.js    → stage "preprocessing"
  │    grayscale → invert → denoise → contrast → deskew → upscale → threshold, mỗi bước bật/tắt được
  ├─ OcrEngineAdapter      src/image_ocr/tesseract_adapter.js → stage "engine"
  │    Tesseract CLI, ảnh PNG qua stdin, kết quả TSV qua stdout (không có file tạm)
  └─ OcrResultNormalizer   src/image_ocr/normalizer.js
       chuẩn hoá text, giữ nguyên confidence từng từ
OcrEvaluator               src/image_ocr/evaluator.js       CER, WER, exact match, p95 (chỉ dùng cho benchmark)
scripts/ocr/ocr.js · scripts/ocr/generate_dataset.js · scripts/ocr/benchmark.js
```

### Yêu cầu môi trường

| Thành phần | Phiên bản đã kiểm tra | Ghi chú |
|---|---|---|
| Node.js | 24.19 | Tối thiểu 20.9 (yêu cầu của `sharp` 0.35) |
| `sharp` | 0.35.5 | Decode, tiền xử lý và sinh dataset. Có prebuilt binary, không cần build native |
| Tesseract OCR | 5.5.0, traineddata `eng` | Engine OCR, gọi qua CLI |
| Font (chỉ để sinh dataset) | DejaVu, Liberation, Noto | Thiếu font thì fontconfig thay font khác, script sẽ cảnh báo |

Dependency mới duy nhất là **`sharp`**: Node không có sẵn API decode hay xử lý ảnh, và `sharp` (libvips) là thư viện phổ biến, nhanh, có prebuilt binary.
Không dùng `tesseract.js` vì nó tải traineddata từ CDN lúc chạy (gọi mạng ngoài phạm vi) và chậm hơn bản native đã có sẵn trên máy.

### Cài đặt

```bash
# Debian/Ubuntu
sudo apt install tesseract-ocr tesseract-ocr-eng
# macOS
brew install tesseract

npm install
tesseract --version   # kiểm tra
```

Cần thêm ngôn ngữ khác thì cài gói `tesseract-ocr-<lang>` (ví dụ `tesseract-ocr-vie`) rồi truyền `language: 'eng+vie'`.

### Chạy OCR trên một ảnh

```bash
node scripts/ocr/ocr.js path/to/image.png             # in text
node scripts/ocr/ocr.js path/to/image.png --json      # in toàn bộ kết quả
node scripts/ocr/ocr.js path/to/image.png --no-preprocess --lang eng --psm 6
```

```js
const { recognizeImage, createTesseractAdapter } = require('./image_ocr');

const result = await recognizeImage('scan.png');                // đường dẫn, Buffer hoặc Uint8Array
const custom = await recognizeImage(buffer, {
  engine: createTesseractAdapter({ language: 'eng', psm: 6, timeoutMs: 10_000 }),
  preprocessing: { threshold: 'otsu', deskew: false },           // hoặc false để tắt toàn bộ
  limits: { maxBytes: 5 * 1024 * 1024 },
});
if (result.status === 'success') console.log(result.value);
```

### Kết quả trả về

`recognizeImage()` luôn resolve, không throw. Dạng kết quả theo quy ước `status` của repo (không dùng `success: true/false`):

```js
{
  status: 'success', type: 'image_ocr', value: 'Invoice 2026 total: 42.50 USD',
  metadata: {
    engine: 'tesseract',
    textDetected: true,
    confidence: 95.39,                                // trung bình cộng confidence các từ, hoặc null
    words: [{ text: 'Invoice', confidence: 96.1 }],   // confidence gốc của engine, không chỉnh sửa
    image: { format: 'png', width: 640, height: 80 },
    preprocessing: { applied: ['grayscale', 'upscale'], skewAngle: 0, scale: 1.6, noiseSigma: 3.1 },
    processingTimeMs: 104.2,
  },
}
{ status: 'failure', type: 'image_ocr', code: 'UNSUPPORTED_FORMAT', stage: 'input',
  error: 'The image format is not supported. Supported: png, jpeg, gif, tiff, webp',
  metadata: { processingTimeMs: 0.1 } }
```

- **Không có chữ ≠ lỗi**: ảnh hợp lệ mà không nhận ra chữ trả `success`, `value: ''`, `textDetected: false`, `confidence: null`.
- **Confidence**: là confidence 0–100 ở cấp từ của Tesseract (LSTM), **không phải** xác suất đã hiệu chỉnh. `metadata.confidence` là trung bình cộng các giá trị đó. Engine không trả confidence thì giá trị là `null`, không bao giờ tự bịa.
- `error` là thông báo cho người gọi: không chứa stack trace, stderr của engine, đường dẫn nội bộ hay nội dung ảnh. Module không ghi log.

| `code` | `stage` | Khi nào |
|---|---|---|
| `INVALID_INPUT` | input | Input không phải Buffer, Uint8Array hay đường dẫn |
| `INVALID_OPTIONS` | input | Option không hợp lệ hoặc không tồn tại |
| `FILE_NOT_FOUND` | input | File không tồn tại, không đọc được, hoặc là thư mục |
| `EMPTY_INPUT` | input | 0 byte |
| `FILE_TOO_LARGE` | input | Vượt `maxBytes`. Với đường dẫn, kiểm tra bằng `stat` trước khi đọc |
| `UNSUPPORTED_FORMAT` | input | Magic bytes không thuộc png, jpeg, gif, tiff, webp. Phần mở rộng file bị bỏ qua. SVG, PDF, BMP, AVIF đều bị từ chối |
| `CORRUPTED_IMAGE` | input | Header hỏng, hoặc file bị cắt cụt (phát hiện khi decode đầy đủ) |
| `IMAGE_TOO_LARGE` | input | Vượt `maxDimension` hoặc `maxPixels`, kiểm tra từ header trước khi decode |
| `PREPROCESSING_FAILED` | preprocessing | Lỗi trong bước tiền xử lý |
| `ENGINE_UNAVAILABLE` | engine | Không có Tesseract, không chạy được, hoặc thiếu traineddata của ngôn ngữ |
| `ENGINE_TIMEOUT` | engine | Vượt `timeoutMs` (mặc định 30 s), process bị kill |
| `ENGINE_ERROR` | engine | Engine thoát với mã lỗi hoặc adapter ném lỗi khác |
| `INTERNAL_ERROR` | internal | Lỗi không lường trước |

Giới hạn mặc định (`DEFAULT_LIMITS`): `maxBytes` 20 MiB, `maxDimension` 10 000 px mỗi cạnh, `maxPixels` 25 000 000.

### Tiền xử lý

| Option | Mặc định | Giá trị | Tác dụng |
|---|---|---|---|
| `grayscale` | `true` | bool | Chuyển ảnh xám |
| `invert` | `'auto'` | bool, `'auto'` | `'auto'` đảo màu khi trung vị độ sáng < 128 (chữ sáng trên nền tối) |
| `denoise` | `'auto'` | bool, `'auto'` | Median 3×3. `'auto'` chỉ áp dụng khi nhiễu ước lượng (phương pháp Immerkær) ≥ 16 |
| `contrast` | `false` | bool | Kéo giãn histogram từ phân vị 1–99 |
| `deskew` | `true` | bool | Ước lượng góc nghiêng ±10° bằng projection profile, xoay lại khi \|góc\| ≥ 0.5°. Bỏ qua khi dòng chữ quá ngắn để xác định hướng |
| `upscale` | `true` | bool | Phóng to (Lanczos3, tối đa 4×) để mỗi dòng chữ cao khoảng 40 px. Không bao giờ thu nhỏ |
| `threshold` | `false` | `false`, `'otsu'`, 0–255 | Nhị phân hoá |

`preprocessing: false` tắt toàn bộ: ảnh chỉ được decode (áp dụng EXIF orientation, nền trong suốt chuyển thành trắng) rồi encode PNG gửi cho engine. `metadata.preprocessing.applied` liệt kê các bước đã thực sự chạy.

Default được chọn **chỉ dựa trên split `dev`**. Trên dev, `contrast` và `threshold: 'otsu'` không cải thiện độ chính xác nên để tắt. `denoise: true` áp dụng cho mọi ảnh làm hỏng chữ nhỏ (CER của nhóm small_text tăng lên 75%), nên dùng `'auto'`.

### Chạy test

```bash
npm test                                       # toàn bộ: captcha_solver + image_ocr
node --test src/captcha_solver.image.test.js     # solve('image') với OCR thật, không mock
node --test src/image_ocr/integration.test.js    # recognizeImage() với Tesseract thật
```

Unit test mock engine qua interface adapter, và dùng script shell giả lập để kiểm tra các trường hợp thiếu binary, crash, timeout và thiếu ngôn ngữ. `integration.test.js` chạy Tesseract thật, và tự skip kèm lý do khi máy không có Tesseract. Ảnh test được render trong bộ nhớ. Thư mục tạm chỉ được tạo trong test và bị xoá ở `after()`.

### Tạo dataset

```bash
npm run dataset                                       # tạo cả dev và test
node scripts/ocr/generate_dataset.js --split test --per-group 50 --out /tmp/ocr-dataset
```

- `dataset/ocr/<split>/images/` chỉ chứa ảnh. Ground-truth nằm riêng ở `dataset/ocr/<split>/labels.json`.
- Split `dev` (seed 1001, 8 ảnh/nhóm) dùng để chọn cấu hình. Split `test` (seed 2002, 20 ảnh/nhóm) chỉ dùng để báo cáo. Không có mô hình nào được huấn luyện.
- Chạy cùng máy thì sinh lại ra file giống hệt từng byte (đã kiểm tra bằng sha256). Sang máy khác, pixel có thể khác nếu font khác.
- Nhóm ảnh: `clean` (9 font thuộc 3 họ DejaVu/Liberation/Noto gồm sans, serif, mono; cỡ 18–40 px; xoay vòng 5 định dạng ảnh), `small_text` (8–13 px), `multiline`, `dark_background`, `low_contrast` (chênh lệch độ sáng 12–50), `noise_moderate` (σ 10–20), `noise_heavy` (σ 30–65), `blur` (Gaussian σ 0.8–2.8), `rotated` (±1.5–9°), `blank` (trắng, tối, nhiễu, gradient), `invalid` (file rỗng, PNG/JPEG cắt cụt, signature PNG kèm dữ liệu rác, BMP, SVG, PDF, file text đặt đuôi .png, AVIF, ảnh 12000×200, ảnh 6000×5000).
- Văn bản là câu ghép ngẫu nhiên từ từ vựng tiếng Anh thông dụng, kèm số và dấu câu.
- Trường hợp vượt `maxBytes` không nằm trong dataset, vì phải tạo file > 20 MiB. Unit test kiểm tra trường hợp này với `maxBytes` nhỏ.

### Chạy benchmark

```bash
npm run benchmark                                            # split test, so sánh raw và default
node scripts/ocr/benchmark.js --split dev --configs all          # ablation từng bước trên dev
node scripts/ocr/benchmark.js --configs raw,default,with-otsu --psm 6
```

Kết quả được in ra dạng Markdown và lưu vào `benchmark-results/ocr/<split>-psm<n>.{md,json}` (file JSON chứa cả prediction của từng ảnh). Benchmark chỉ truyền đường dẫn ảnh vào `recognizeImage()`. `labels.json` chỉ được đọc để chấm điểm. Các ảnh được chạy tuần tự để số đo thời gian không bị nhiễu.

**Chuẩn hoá trước khi tính metric**: chuẩn hoá Unicode NFC, gộp mọi chuỗi khoảng trắng (kể cả xuống dòng) thành một dấu cách, trim hai đầu. **Không** bỏ qua khác biệt hoa/thường, dấu câu, chữ số hay dấu thanh.
CER = tổng edit distance ký tự / tổng số ký tự tham chiếu. WER tính tương tự theo từ. Ảnh xử lý lỗi được tính là output rỗng.
`Processing errors` = tỷ lệ ảnh hợp lệ (có chữ hoặc blank) trả `failure`. `Correct rejections` = tỷ lệ ảnh invalid trả đúng mã lỗi mong đợi.

### Kết quả thực tế

Split `test`: 201 file (180 ảnh có chữ, 10 blank, 11 invalid). Tesseract 5.5.0 `eng`, `--psm 3`, Node 24.19, Intel i5-10400, chạy ngày 2026-10-13.

| Cấu hình | CER | WER | Exact match | Processing errors | Text sai trên blank | Correct rejections | Mean ms | p95 ms |
|---|---|---|---|---|---|---|---|---|
| raw (`preprocessing: false`) | 7.9% | 10.1% | 80.6% | 0% | 0% | 11/11 | 92 | 115 |
| **default** | **0.6%** | **1.8%** | **91.1%** | 0% | 0% | 11/11 | 107 | 149 |
| default, bỏ deskew | 1.6% | 3.6% | 86.1% | 0% | 0% | 11/11 | 106 | 148 |
| default, bỏ denoise | 5.7% | 6.7% | 86.1% | 0% | 0% | 11/11 | 107 | 148 |
| default, bỏ upscale | 0.6% | 2.3% | 90.6% | 0% | 0% | 11/11 | 96 | 119 |
| default + contrast | 0.7% | 2.0% | 91.1% | 0% | 0% | 11/11 | 113 | 153 |
| default + Otsu | 0.8% | 2.9% | 87.2% | 0% | 0% | 11/11 | 106 | 145 |

Theo nhóm (n = 20 mỗi nhóm), raw → default:

| Nhóm | CER raw | CER default | Exact raw | Exact default |
|---|---|---|---|---|
| clean | 0.4% | 0.2% | 90% | 95% |
| small_text | 2.4% | 0.7% | 60% | 80% |
| multiline | 0.1% | 0.1% | 95% | 95% |
| dark_background | 0.0% | 0.0% | 100% | 100% |
| low_contrast | 0.2% | 0.6% | **95%** | **85%** |
| noise_moderate | 0.0% | 0.0% | 100% | 100% |
| noise_heavy | 61.1% | 0.9% | 35% | 80% |
| blur | 2.9% | 3.3% | **95%** | **90%** |
| rotated | 12.7% | 0.2% | 55% | 95% |

Đọc kết quả:

- Phần cải thiện chủ yếu đến từ denoise tự động (nhóm noise_heavy), deskew (nhóm rotated) và upscale (nhóm small_text).
- Default **kém hơn raw** ở nhóm `low_contrast` và `blur`, tổng cộng 3 ảnh. Lỗi đều là 1 ký tự: `so`→`So`, `little`→`Little`, `5771`→`$771`, xuất hiện khi chữ cỡ 22–31 px bị upscale nhẹ 1.2–1.4×. Quan sát này đến từ split test nên default **chưa** được chỉnh theo nó, để tránh tinh chỉnh trên dữ liệu đánh giá.
- Trên split dev (72 ảnh có chữ, dùng để chọn default): raw đạt CER 5.3%, exact 83.3%; default đạt CER 1.2%, exact 93.1%.
- Dataset là ảnh tổng hợp, sạch hơn ảnh thật và chỉ có 20 ảnh/nhóm, nên mỗi ảnh tương ứng 5 điểm phần trăm exact match. Các con số này **không** đại diện cho ảnh chụp thực tế.

### Giới hạn đã biết

- Mới chỉ đánh giá trên ảnh tổng hợp: chữ in, nền phẳng, một khối văn bản. Chưa đo trên ảnh chụp điện thoại, tài liệu nhiều cột, bảng biểu, chữ viết tay hay ảnh bị phối cảnh.
- Mẫu nhỏ (20 ảnh/nhóm ở test, 8 ở dev), nên khác biệt 1–2 ảnh giữa các cấu hình chưa có ý nghĩa thống kê.
- Upscale nhẹ (< 1.5×) có thể đổi chữ hoa/thường ở một số font (xem phần kết quả).
- Deskew chỉ xử lý được nghiêng ±10° và cần dòng chữ dài ít nhất khoảng 4 lần độ cao dòng. Không xử lý ảnh xoay 90°/180° hay biến dạng phối cảnh. Với từ đơn ngắn, góc ước lượng có thể lệch khoảng 0.5°.
- Ngưỡng của `invert: 'auto'` dựa trên trung vị độ sáng, nên ảnh nửa sáng nửa tối có thể bị đảo sai.
- Chỉ trang/khung đầu tiên của TIFF nhiều trang hoặc GIF động được xử lý.
- Mỗi lần gọi spawn một process Tesseract mới. Trên máy thử, một ảnh một dòng mất khoảng 90–150 ms. Module không giới hạn số lần gọi đồng thời; nếu cần, người gọi tự giới hạn concurrency.
- Đã kiểm tra trên Linux. macOS/Windows chưa được kiểm tra.
- Sinh dataset phụ thuộc font hệ thống, nên dataset sinh trên máy khác có thể khác pixel.

### Thêm OCR engine khác

Engine là object bất kỳ có dạng sau:

```js
const myEngine = {
  name: 'my-engine',
  // png: Buffer PNG đã tiền xử lý. Trả về text, và words nếu engine có confidence.
  async recognize(png) {
    const output = await callMyEngine(png);
    return { text: output.text, words: output.words?.map((w) => ({ text: w.text, confidence: w.score ?? null })) };
  },
};
await recognizeImage(image, { engine: myEngine });
```

- Ném `new OcrError(OcrErrorCode.ENGINE_UNAVAILABLE | ENGINE_TIMEOUT | ENGINE_ERROR, message)` để báo lỗi có phân loại. Mọi lỗi khác bị đổi thành `ENGINE_ERROR` và message gốc bị ẩn.
- Không có confidence thì bỏ `words` hoặc để `confidence: null`. Module không tự tạo ra score.
- Nếu engine cần định dạng khác PNG hoặc đã có tiền xử lý riêng, truyền `preprocessing: false`.
- Có thể đưa engine vào benchmark bằng cách thay `createTesseractAdapter(...)` trong `scripts/ocr/benchmark.js`.

---

## Module Object Detection (`object_detection/`)

Nhận diện vật thể tổng quát trong ảnh chụp thông thường (80 lớp COCO: người, xe, động vật, đồ vật trong nhà...). Trả về danh sách `className`, `boundingBox`, `confidence`.

Module **độc lập** với `image_ocr/` và `captcha_solver.js`: không import chéo, không được `solve()` gọi tới, và không có handler CAPTCHA nào dùng nó. Module không gọi mạng lúc chạy (model nằm sẵn trên đĩa), không tương tác với website, và **không** được thiết kế hay tinh chỉnh cho ảnh thử thách CAPTCHA. Chỉ đánh giá trên dataset được phép dùng (xem [Dataset](#dataset)).

### Chọn model

| | YOLOX-Tiny (mặc định) | YOLOX-Nano |
|---|---|---|
| Nguồn | [Megvii YOLOX](https://github.com/Megvii-BaseDetection/YOLOX), bản ONNX chính thức `0.1.1rc0` | như bên trái |
| Giấy phép | Apache-2.0 | Apache-2.0 |
| Kích thước file | 20 MB | 3.6 MB |
| Đầu vào | 416×416, BGR, 0–255, letterbox pad 114 | như bên trái |
| COCO val2017 mAP@.5:.95 (tác giả công bố) | 32.8 | 25.8 |

Lý do chọn:

- **Giấy phép**: Apache-2.0. Không dùng YOLOv5/v8/11 vì Ultralytics phát hành theo AGPL-3.0.
- **Môi trường**: chạy CPU qua `onnxruntime-node`, không cần GPU, Python hay build native. Máy thử là Intel i5-10400, không có GPU.
- **Độ trễ**: khoảng 20–40 ms/ảnh trên CPU, đủ nhanh để test và benchmark trong vài giây.
- **Post-processing đơn giản**: grid decode và NMS viết bằng JS thuần, nên test được từng bước.

### Kiến trúc

```
detectObjects(source, options)                          src/object_detection/index.js
  │  kiểm tra options (thresholds, maxDetections, limits, detector)  → INVALID_OPTIONS
  ├─ validator             src/object_detection/validator.js    → stage "input"
  │    đọc file/Buffer, giới hạn byte, magic bytes, kích thước min/max, decode đầy đủ → sRGB 3 kênh
  ├─ Detector adapter      src/object_detection/yolox_adapter.js → stage "model" / "inference"
  │    letterbox → tensor BGR planar → onnxruntime-node → decode + NMS → toạ độ ảnh gốc
  │    yolox_postprocess.js (anchor grid, decode, NMS: hàm thuần) · models.js (registry + SHA-256)
  └─ chuẩn hoá kết quả: kiểm tra output của adapter, đổi sang {x, y, width, height}, lọc ngưỡng, sắp xếp, cắt maxDetections
evaluator.js              mAP@.5, mAP@.5:.95, precision/recall/F1 (chỉ dùng cho benchmark và test)
scripts/object_detection/detect.js · download_model.js · prepare_dataset.js · benchmark.js
```

### Yêu cầu môi trường

| Thành phần | Phiên bản đã kiểm tra | Ghi chú |
|---|---|---|
| Node.js | 24.19 | Tối thiểu 20.9 |
| `onnxruntime-node` | 1.30.0 | Dependency mới. Có prebuilt binary cho Linux/macOS/Windows x64 và arm64. Được `require` lazily: thiếu package này thì chỉ `detectObjects` báo `DEPENDENCY_MISSING`, các module khác vẫn chạy |
| `sharp` | 0.35.5 | Dùng chung dependency với `image_ocr` (không dùng chung code) |
| `unzip` | bất kỳ | Chỉ cần khi chuẩn bị dataset |

`npm install` có thể cảnh báo `allow-scripts` cho `onnxruntime-node`. Script `postinstall` đó chỉ tải thêm binary CUDA/TensorRT; bản CPU đã nằm sẵn trong package, nên không cần chạy.

### Cài đặt

```bash
npm install
npm run od:model                     # tải YOLOX-Tiny vào models/ (git-ignored), kiểm tra SHA-256
npm run od:model -- --model all      # tải cả YOLOX-Nano
```

Hash không khớp thì file không được lưu. Chạy lại khi file đã đúng hash sẽ không tải lại.

### Chạy thử

```bash
npm run detect -- path/to/photo.jpg
# person         0.906  x=498.3 y=103.8 w=141.2 h=319.4
# handbag        0.686  x=494 y=193.9 w=105.8 h=209.6
npm run detect -- photo.jpg --model yolox-nano --score 0.5 --json
```

```js
const { detectObjects, createYoloxAdapter } = require('./object_detection');

const detector = createYoloxAdapter();          // { model: 'yolox-nano' } | { modelPath, classNames } | { threads }
const result = await detectObjects('photo.jpg', { detector, scoreThreshold: 0.3 });
if (result.status === 'success') {
  for (const { className, boundingBox, confidence } of result.detections) { /* ... */ }
}
await detector.release();                       // giải phóng session ONNX khi không dùng nữa
```

Không truyền `detector` thì module dùng một YOLOX-Tiny dùng chung, nạp ở lần gọi đầu tiên. Một adapter có thể được gọi đồng thời nhiều lần.

### Kết quả trả về

`detectObjects()` luôn resolve, không throw.

```js
{
  status: 'success',
  type: 'object_detection',
  detections: [
    { className: 'person', boundingBox: { x: 379.3, y: 67.9, width: 121.4, height: 280 }, confidence: 0.8928 },
  ],
  metadata: {
    model: 'yolox-tiny',
    image: { format: 'jpeg', width: 640, height: 427 },
    scoreThreshold: 0.3, iouThreshold: 0.45,
    inferenceMs: 21.4, processingTimeMs: 27.9,
  },
}
```

- `boundingBox` tính bằng pixel của ảnh đầu vào **sau khi xoay theo EXIF**, gốc ở góc trên trái, làm tròn 0.1 px, luôn nằm trong ảnh.
- `confidence` = objectness × class score của model, trong khoảng 0–1, làm tròn 4 chữ số. Đây là điểm của model, **không** phải xác suất đã hiệu chỉnh.
- Danh sách được sắp theo `confidence` giảm dần. Không tìm thấy gì thì `detections: []` và vẫn là `success`.

| Option | Mặc định | Ý nghĩa |
|---|---|---|
| `scoreThreshold` | 0.3 | Bỏ detection có confidence thấp hơn. Chọn theo F1 trên split **dev** |
| `iouThreshold` | 0.45 | Ngưỡng NMS theo từng lớp (giá trị mặc định của YOLOX demo) |
| `maxDetections` | 100 | Số detection tối đa |
| `limits` | `{ maxBytes: 20 MiB, maxDimension: 10000, maxPixels: 25M, minDimension: 16 }` | Giới hạn đầu vào |
| `detector` | YOLOX-Tiny dùng chung | Adapter bất kỳ (xem [Thay model](#thay-model)) |

Khi `failure`:

| `code` | `stage` | Khi nào |
|---|---|---|
| `INVALID_OPTIONS` | input | Option sai kiểu, ngoài khoảng, limit không tồn tại, detector không đúng interface |
| `INVALID_INPUT` | input | Input không phải Buffer/Uint8Array/đường dẫn |
| `FILE_NOT_FOUND` | input | Đường dẫn không tồn tại hoặc không phải file |
| `EMPTY_INPUT` / `FILE_TOO_LARGE` | input | 0 byte / vượt `maxBytes` |
| `UNSUPPORTED_FORMAT` | input | Magic bytes không thuộc PNG, JPEG, WebP, GIF, TIFF (SVG bị từ chối có chủ đích) |
| `CORRUPTED_IMAGE` | input | Header hỏng, file bị cắt cụt, decode thất bại |
| `IMAGE_TOO_LARGE` / `IMAGE_TOO_SMALL` | input | Vượt `maxDimension`/`maxPixels` / một cạnh < `minDimension` |
| `DEPENDENCY_MISSING` | model | Chưa cài `onnxruntime-node` |
| `MODEL_NOT_FOUND` | model | Chưa tải file model (`npm run od:model`) |
| `MODEL_INVALID` | model | File không phải ONNX, hoặc input/output không đúng layout YOLOX, hoặc số lớp không khớp `classNames` |
| `INFERENCE_FAILED` | inference | Runtime lỗi khi chạy, hoặc adapter trả output sai định dạng |
| `INTERNAL_ERROR` | internal | Lỗi không lường trước |

Message lỗi không chứa stack trace hay lỗi gốc của native runtime. Lỗi model không bị cache: tải model xong thì lần gọi sau chạy được ngay.

### Thay model

Adapter là object bất kỳ có `name` và `detect(image, { scoreThreshold, iouThreshold, maxDetections })`:

- `image` là `{ data, width, height, channels: 3 }`: pixel sRGB 8-bit đã được validator decode.
- Trả về `Array<{ className, confidence, box: [x1, y1, x2, y2] }>` theo pixel ảnh gốc.
- Ném `DetectionError` với code thuộc stage `model`/`inference` để báo lỗi có phân loại. Mọi lỗi khác bị đổi thành `INFERENCE_FAILED`.

`detectObjects()` kiểm tra output (box nằm trong ảnh, confidence trong 0–1, `className` khác rỗng), nên một adapter lỗi không thể làm hỏng schema kết quả.

- **Model YOLOX khác** (S/M/L, kích thước đầu vào khác, hoặc model tự train): `createYoloxAdapter({ modelPath, classNames })`. Kích thước đầu vào được đọc từ metadata của model; số lớp phải khớp `classNames`. Để model có trong `npm run od:model`, thêm một mục vào `src/object_detection/models.js` kèm URL và SHA-256.
- **Kiến trúc khác** (SSD, RT-DETR, D-FINE...): viết adapter mới cùng interface. API `detectObjects()` và benchmark không phải sửa (benchmark hiện tạo adapter bằng `createYoloxAdapter`, nên chỉ cần đổi dòng đó).

### Dataset

```bash
npm run od:dataset          # dev: 60 ảnh, test: 200 ảnh; mỗi split thêm 20 composite, 5 negative, 5 invalid
```

Script tải annotation COCO 2017 (~253 MB, chỉ một lần, file zip bị xoá sau khi giải nén) và ảnh vào `dataset/object_detection/` (git-ignored). Không có ảnh nào được commit vào repo.

| Nhóm | Nguồn | Ground truth |
|---|---|---|
| `coco` | Ảnh COCO val2017 (Flickr) **chỉ** với license CC BY 2.0, CC BY-SA 2.0 hoặc "No known copyright restrictions" (1279/5000 ảnh đủ điều kiện). Ảnh NonCommercial và NoDerivs không bao giờ được tải. COCO val2017 không nằm trong tập train của YOLOX | Annotation COCO (CC BY 4.0), có cờ `iscrowd` |
| `composite` | **Ảnh tự tạo**: cắt một vật thể từ ảnh nhóm `coco`, scale 0.5–1.5×, dán lên nền phẳng với kích thước lệch tỷ lệ (640×480, 480×640, 800×400, 416², 1024×768), xen kẽ JPEG/PNG/WebP | Đúng hình chữ nhật đã dán, biết chính xác từng pixel |
| `negative` | Ảnh tự tạo: trắng, xám, gradient, nhiễu, sọc | Không có vật thể; mọi detection đều là false positive |
| `invalid` | File rỗng, file text, JPEG cắt cụt, PNG 8×8, SVG | Mã lỗi mong đợi |

- `dev` và `test` dùng hai tập ảnh khác nhau (chọn bằng seed cố định). Ngưỡng mặc định được chọn trên dev; kết quả báo cáo dưới đây là của test.
- Mỗi split có `ATTRIBUTION.md` ghi license và nguồn Flickr của từng ảnh, theo yêu cầu ghi công của CC BY/BY-SA. Ảnh `composite` là tác phẩm phái sinh: `labels.json` ghi ảnh gốc và cách chỉnh sửa. Nếu phân phối lại ảnh BY-SA thì phải giữ cùng license.
- Đã kiểm tra: không ảnh nào có EXIF orientation khác 1, nên annotation COCO khớp với ảnh sau khi auto-orient.

### Chạy test

```bash
npm test                                     # toàn bộ repo
node --test 'src/object_detection/*.test.js' # chỉ module này
```

- **Unit test** (không cần model): validator (mọi định dạng, ảnh xám, alpha, EXIF, mọi mã lỗi đầu vào), decode/NMS/IoU với tensor viết tay, letterbox và chuyển BGR, evaluator (AP, crowd, P/R), schema và mapping lỗi của `detectObjects()`. Riêng `DEPENDENCY_MISSING` được kiểm tra trong một process con có `onnxruntime-node` bị ẩn khỏi `require`.
- Unit test của `index.js` dùng một **stub detector** trả box cố định. Stub này chỉ dùng để kiểm tra phần xử lý kết quả và mapping lỗi, không được dùng để kết luận model nhận diện đúng.
- **Integration test** (`integration.test.js`) chạy **model thật**, không có stub nào:
  - ảnh trắng, xám, nhiễu cho ra 0 detection;
  - người lớn nhất trong ảnh dev được định vị với IoU ≥ 0.7 so với box COCO;
  - box dịch đúng khi ảnh được pad thêm viền lệch và khi ảnh bị lật ngang (IoU ≥ 0.7);
  - PNG, JPEG và WebP lossless của cùng một ảnh cho cùng kết quả;
  - gọi đồng thời cho kết quả giống hệt gọi tuần tự;
  - mAP@.5 trên dev ≥ 45% (ngưỡng chống regression; con số đo được là 58%);
  - `classNames` sai số lớp trả `MODEL_INVALID`;
  - `release()` rồi gọi lại thì model được nạp lại.

  Test tự skip và in lý do khi thiếu model hoặc dataset.
- Đã kiểm tra rằng test bắt được lỗi thật: cố ý bỏ bước chia `scale` khi đổi toạ độ thì 3 integration test fail.

Kết quả lần chạy cuối: `npm test` → **388/388 pass**, 0 skip (316 test cũ + 72 test mới).

### Chạy benchmark

```bash
npm run od:benchmark                                          # split test, cả hai model
node scripts/object_detection/benchmark.js --split dev --models yolox-tiny --threads 4
```

Kết quả in dạng Markdown và lưu vào `benchmark-results/object_detection/<split>.{md,json}`. Mỗi model chạy trong một process con riêng để số đo bộ nhớ không bị lẫn giữa các model.

- **Accuracy**: chạy với `scoreThreshold: 0.01` để tính mAP@.5 và mAP@.5:.95 (AP nội suy 101 điểm kiểu COCO, trung bình trên các lớp có ground truth). P/R/F1 ở ngưỡng mặc định được tính từ chính các detection đó sau khi lọc. Cách này cho kết quả chính xác vì NMS tham lam không bao giờ để box điểm thấp loại box điểm cao. Kèm theo: bảng quét ngưỡng, AP theo lớp, recall và IoU trên nhóm composite, số false positive trên nhóm negative, số input lỗi bị từ chối đúng mã.
- **Latency**: lần chạy thứ hai với option mặc định, sau 3 lần warm-up, tính end-to-end trong `detectObjects` (đọc file, decode, letterbox, inference, NMS). Cũng đo thời gian nạp model.
- **Memory**: RSS trước khi nạp, sau khi nạp và đỉnh trong suốt quá trình chạy (`process.resourceUsage().maxRSS`).

### Kết quả thực tế

Split `test`: 200 ảnh COCO (1531 box), 20 composite, 5 negative, 5 invalid. Node 24.19, onnxruntime-node 1.30.0, Intel i5-10400 (12 luồng), số thread mặc định của onnxruntime, chạy ngày 2026-10-14.

| Model | mAP@.5:.95 | mAP@.5 | Precision@0.3 | Recall@0.3 | F1@0.3 | Composite: đúng lớp + IoU≥.5 | Composite: định vị được (mọi lớp) | FP trên negative | Invalid bị từ chối đúng |
|---|---|---|---|---|---|---|---|---|---|
| **yolox-tiny** | **38.8%** | **56.3%** | 72.1% | 45.0% | 55.4% | 10/20 | 13/20 | 0 / 5 ảnh | 5/5 |
| yolox-nano | 30.3% | 49.2% | 69.9% | 37.6% | 48.9% | 8/20 | 12/20 | 0 / 5 ảnh | 5/5 |

| Model | Nạp model | Mean | p50 | p95 | Riêng inference | RSS sau khi nạp | RSS đỉnh |
|---|---|---|---|---|---|---|---|
| yolox-tiny | 85 ms | 38.2 ms | 37.5 ms | 52.0 ms | 29.2 ms | 144 MB | 277 MB |
| yolox-nano | 65 ms | 20.5 ms | 19.9 ms | 28.8 ms | 12.1 ms | 111 MB | 254 MB |

RSS của process Node trước khi nạp model là 68 MB.

Đọc kết quả:

- **Đối chiếu với pycocotools**: các detection YOLOX-Tiny trên đúng 200 ảnh test được chấm bằng `pycocotools` chính thức, cho mAP@.5:.95 = 38.9% và mAP@.5 = 56.6%. Evaluator của repo cho 38.75% và 56.33%, lệch ≤ 0.3 điểm. Theo pycocotools, AP theo kích thước vật thể là small 17.0%, medium 37.7%, large 63.2%.
- mAP đo được **cao hơn** con số tác giả công bố (32.8%). Nguyên nhân là tập con 200 ảnh có phân bố lớp và kích thước vật thể khác với toàn bộ 5000 ảnh val2017; nhiều lớp chỉ có 1–5 box nên AP từng lớp dao động mạnh. Không nên coi đây là con số thay thế cho kết quả công bố.
- Trên dev, F1 gần như phẳng trong khoảng ngưỡng 0.2–0.35 (58.6% → 57.7%). Ngưỡng 0.3 được chọn vì cho F1 cao nhất trên dev; ngưỡng 0.5 cho precision 84% nhưng recall chỉ còn 38%.
- Nhóm composite: khi model tìm được vật thể thì IoU đạt 0.84–0.98, cho thấy phép ánh xạ toạ độ qua các tỷ lệ ảnh lệch là đúng. Các ca trượt là vật thể phụ thuộc ngữ cảnh khi bị cắt khỏi cảnh (couch, chair, tv, vase, broccoli), hoặc nhầm lớp (backpack thành person đang đeo nó, tennis racket thành kite, dog thành teddy bear).
- Lớp yếu nhất ở test: book 9.9%, backpack 16.0%, handbag 21.4%, bird 24.7%, bottle 25.0%, chair 25.5% (AP@.5). Đây đều là vật thể nhỏ hoặc hay bị che khuất.
- Latency dao động theo tải máy: cùng model, trên dev đo được mean 28 ms, trên test 38 ms (máy đang chạy các tác vụ khác). Lần gọi đầu tiên không warm-up mất khoảng 130 ms.

### Giới hạn của model

- **Chỉ có 80 lớp COCO.** Vật thể ngoài danh sách sẽ bị bỏ qua hoặc gán sang lớp gần nhất.
- **Vật thể nhỏ**: đầu vào bị thu về 416×416. Với ảnh 4000×3000, một vật thể 100 px chỉ còn khoảng 10 px, nên AP vật thể nhỏ chỉ khoảng 17%. Module không chia ảnh thành ô (tiling).
- **Ảnh lệch phân phối** (ảnh vẽ, icon, ảnh chụp màn hình, ảnh y tế/vệ tinh, ảnh bị làm nhiễu có chủ đích): chưa được đánh giá, độ chính xác không được đảm bảo.
- `confidence` chưa được hiệu chỉnh. Muốn dùng như xác suất thì phải hiệu chỉnh trên dữ liệu của mình.
- Chỉ xử lý khung đầu tiên của GIF động / TIFF nhiều trang. Không có tracking giữa các khung hình.
- Chỉ chạy CPU. Muốn dùng GPU thì phải bật execution provider CUDA (và chạy `postinstall` của `onnxruntime-node`); chưa được kiểm tra.
- Dataset đánh giá nhỏ (200 ảnh test), nên khác biệt 1–2 điểm giữa các cấu hình chưa có ý nghĩa thống kê. mAP của evaluator trong repo khớp với pycocotools trên split này nhưng không chia theo kích thước vật thể.
- Bộ nhớ: mỗi adapter giữ một session ONNX (~75 MB với Tiny). Gọi `release()` khi không dùng nữa. Module không giới hạn số lần gọi đồng thời; nếu cần, người gọi tự giới hạn.
- Đã kiểm tra trên Linux x64. macOS/Windows chưa được kiểm tra.
