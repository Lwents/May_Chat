# Mây — Chat & Video Call bằng Rust

Ứng dụng MVP có backend Rust/Axum/Tokio và frontend SvelteKit/TypeScript xuất tĩnh. Ưu tiên nhóm nhỏ trên VPS 4 GB; toàn bộ nghiệp vụ nằm trong một Rust binary. Giao diện tiếng Việt, sáng/tối, có bố cục riêng cho điện thoại và hỗ trợ safe area, viewport khi mở bàn phím.

## Chức năng đã triển khai

- Đăng ký, đăng nhập, đăng xuất; mật khẩu từ 8 đến 128 ký tự Unicode; Argon2id; phiên 7 ngày bằng cookie HttpOnly, SameSite=Strict, Secure khi chạy HTTPS. Cơ sở dữ liệu lưu hash token, không lưu token gốc.
- Tìm người theo tên/tên đăng nhập, chat cá nhân và nhóm tối đa 50 thành viên. Tạo lại cùng cặp chat cá nhân trả về phòng cũ.
- WebSocket native: tin mới, đang nhập, online/offline, đồng bộ số chưa đọc. Xác thực và kiểm tra thành viên ở API và signaling.
- Tin nhắn được commit trước ACK. Idempotency theo `(sender_id, client_message_id)`; cùng mã với nội dung khác trả 409. Phân trang trước/sau bằng sequence; khôi phục lịch sử khi nối lại.
- Hàng đợi gửi phía trình duyệt có mã gửi ổn định, lưu trên thiết bị, tự thử lại khi lỗi mạng và có nút thử lại. Tối đa 50 tin chờ; cache lịch sử hiển thị tối đa 500 tin/phòng.
- Tệp phải **nhỏ hơn 100 MB** (100.000.000 byte, không bao gồm ngưỡng); tổng tải lên tối đa 1 GB/tài khoản/24 giờ. Upload/download truyền từng phần, không nạp toàn bộ tệp vào RAM; có tiến độ và nút hủy khi tải lên. Tệp nằm ngoài DB, chỉ thành viên phòng tải được. Tên lưu trên đĩa là UUID; tệp tải xuống dạng attachment.
- Gọi thoại/video 1-1 bằng WebRTC P2P; gọi nhóm mesh tối đa 5 thành viên. Bật/tắt camera/micro, chia sẻ màn hình trên trình duyệt hỗ trợ. ICE candidate được đệm đến khi có remote description. Video mục tiêu 640×360, 20 fps, tối đa 500 kbps/luồng video gửi khi trình duyệt áp dụng được tham số.
- Mời/nhận/từ chối/kết thúc cuộc gọi, lịch sử cuộc gọi. Cuộc gọi dừng khi mất WebSocket; đóng tab cuối cùng sẽ giải phóng trạng thái cuộc gọi trên máy chủ sau khi phát hiện mất kết nối. Cuộc gọi chưa trả lời hết hạn sau khoảng 90–120 giây; cuộc gọi hoạt động giới hạn 4 giờ.
- Coturn với thông tin đăng nhập HMAC ngắn hạn 1 giờ, Caddy HTTPS, Docker Compose có giới hạn tài nguyên và log xoay vòng. Script sao lưu SQLite bằng online backup API qua sqlite3.

## Chuông và thông báo

Chuông cuộc gọi, âm báo gửi/nhận tin luôn bật, âm lượng ứng dụng mặc định 100%. Không có nút bật chuông, nghe thử, thanh âm lượng hoặc lựa chọn Enter trong cài đặt. Các thiết lập tắt tiếng/âm lượng cũ được bỏ qua. Trên máy tính Enter gửi tin, Shift+Enter xuống dòng; điện thoại dùng nút gửi.

Ứng dụng tự khởi tạo âm thanh khi vào trang và tự khôi phục trên lần tương tác thông thường đầu tiên hoặc khi trở lại tab, không cần bấm nút bật âm thanh riêng. Chính sách autoplay của trình duyệt vẫn có thể chặn âm thanh trước lần tương tác đầu tiên; website không thể vượt qua hạn chế này. Xem [chính sách autoplay của Chrome](https://developer.chrome.com/blog/autoplay/). Tab/loa bị tắt tiếng và điện thoại khóa màn hình cũng có thể ngăn âm thanh.

Ứng dụng yêu cầu quyền thông báo trình duyệt khi vào trang nếu quyền chưa được quyết định, và thử lại trên lần tương tác đầu nếu trình duyệt yêu cầu thao tác người dùng. Mục **Thông báo trình duyệt** luôn giữ trong Cài đặt để yêu cầu lại; nếu đã chặn, cần đổi quyền trong trình duyệt. Quyền thông báo hệ thống tách biệt với chuông trong ứng dụng.

Chuông tự ngắt khi nhận, từ chối, hủy, hết hạn hoặc mất kết nối. Tín hiệu `call.accepted` được gửi ngay khi nhận máy, trước khi chờ micro/camera; tiếng chờ dừng đồng thời ở bên gọi và các tab cùng tài khoản. Tải lại tab không gọi chuông lại cho cuộc gọi đã nhận. Một Web Audio context dùng chung, tiếng báo ngắn và bộ đệm sự kiện giới hạn giữ tài nguyên thấp. Bài `npm run test:sounds` kiểm tra tín hiệu Web Audio thật với chính sách autoplay bật, mặc định 100% bỏ qua thiết lập mute cũ, không còn các điều khiển đã bỏ, thông báo trình duyệt còn hiển thị và chuông ngắt đúng lúc.

## Ảnh và video trong chat

JPEG, PNG, WebP, GIF và video MP4/WebM hỗ trợ xem trực tiếp trong tin nhắn. Ảnh có thể mở lớn ở tab mới; video có điều khiển phát/tua, không tự phát và chỉ nạp metadata ban đầu. Vẫn có nút tải bản gốc. Các tệp cũ cũng được nhận dạng lại từ nội dung khi xem. Định dạng/codec trình duyệt không phát được sẽ có lựa chọn tải tệp; backend không chuyển mã video.

Endpoint `?inline=1` kiểm tra thành viên giống tải xuống, chỉ cho phép các loại media nhận dạng được, có hỗ trợ HTTP Range cho tua video và trả 416 cho khoảng không hợp lệ. HTML/SVG và các tệp khác vẫn chỉ được tải về. `npm run test:media` kiểm tra giải mã ảnh, phát video, phân quyền, byte ranges và bố cục di động bằng các fixture màu đơn do dự án tạo.

## Phân biệt bản xem giao diện và hệ thống thật

Bản Sites chỉ chứa frontend tĩnh; không chạy được Rust binary hoặc Coturn. Khi không thấy `/api/health` của Rust, giao diện mở **Bản trải nghiệm**: 5 nhân vật mẫu, tin nhắn lưu trong localStorage của trình duyệt, không tự trả lời giả. Nút gọi chỉ xem thử camera/micro của chính bạn. Không có tài khoản thật hay giao tiếp giữa các thiết bị trong chế độ này.

Khi frontend được Caddy phục vụ cùng backend Rust, ứng dụng tự mở màn hình đăng nhập và dùng dữ liệu thật. Backend mặc định không tạo tài khoản mẫu. Mỗi người trong nhóm cần tự đăng ký rồi tìm nhau bằng tên đăng nhập.

## Mã nguồn

Repository: [Lwents/May_Chat](https://github.com/Lwents/May_Chat). Mã nguồn, migrations, cấu hình Compose và các bài kiểm thử được quản lý trong repo này. Database, uploads, backup, thông tin xác thực và trạng thái Sites cục bộ không đưa lên Git.

## Chạy local bằng Docker (khuyên dùng để test)

```bash
./scripts/local.sh start
```

Mở **http://localhost:8088**. Đây là backend thật và database trống, không phải demo. Tạo tài khoản của bạn; mở thêm cửa sổ ẩn danh, đăng ký tài khoản thứ hai rồi tìm nhau bằng tên đăng nhập để chat/gọi. Frontend tĩnh được Caddy phục vụ, không cần Node hay Rust compiler chạy trên host. Dữ liệu nằm ở Docker volume riêng của project `may-chat-local`, không dùng database của các bài test phát triển.

```bash
./scripts/local.sh status
./scripts/local.sh logs
./scripts/local.sh stop
# Khởi động lại và giữ nguyên tài khoản/tin nhắn:
./scripts/local.sh start
# Backup dữ liệu local:
MAY_COMPOSE_FILE=infrastructure/compose.local.yaml ./scripts/backup.sh
```

Bản local chỉ bind `127.0.0.1:8088`, Origin cố định `http://localhost:8088`. Dùng đúng hostname **localhost** để gửi tin được; không thay bằng `127.0.0.1`. Camera/micro được phép trên localhost nếu người dùng cấp quyền. Local chưa bật TURN: cuộc gọi dùng host candidates/STUN, phù hợp thử nhiều cửa sổ trên cùng máy. Để điện thoại khác truy cập và gọi qua mạng thật, cần cấu hình HTTPS và TURN theo phần VPS, hoặc thiết lập HTTPS LAN với chứng chỉ được điện thoại tin cậy. Không tự mở cổng Internet trong chế độ local.

## Chạy phát triển

Cần Rust toolchain mới hỗ trợ edition 2024, Node.js 24 và npm. Chạy từ thư mục gốc dự án:

```bash
npm install
npm --prefix apps/web ci
cargo run --manifest-path server/Cargo.toml
```

Mở terminal thứ hai:

```bash
npm run dev
```

Mở `http://localhost:5173`. Vite proxy `/api` và WebSocket tới `127.0.0.1:8080`. Backend mặc định chỉ cho Origin `http://localhost:5173`; nếu dùng host/port khác, đặt `APP_ORIGIN` chính xác. Trên điện thoại thật cần HTTPS để trình duyệt cho dùng camera/micro; dùng quy trình VPS dưới đây. Localhost là ngoại lệ của trình duyệt.

Dữ liệu mặc định ở `data/may.db` khi chạy từ thư mục gốc. Không chạy hai Rust server trên cùng file SQLite. Migrations tự chạy lúc khởi động.

## Triển khai VPS Ubuntu/Debian 4 GB

1. Cài Docker Engine + Docker Compose v2. Trỏ bản ghi DNS A của tên miền về **IPv4 công khai của VPS**. Nếu có bản ghi AAAA, bảo đảm IPv6 cũng trỏ đúng máy. Với proxy DNS/CDN, dùng DNS-only trong lần thiết lập đầu và không proxy cổng TURN.
2. Đưa mã nguồn lên VPS; từ thư mục gốc chạy lệnh cấu hình bên dưới. Script tạo TURN secret ngẫu nhiên và file `.env` quyền 0600, không ghi đè file đã có.
3. Firewall của VPS và nhà cung cấp phải mở TCP 80, TCP/UDP 443, TCP/UDP 3478, UDP 49160–49399; giữ cổng SSH theo cấu hình máy. Không mở 8080 ra Internet. Coturn dùng host networking, phù hợp VPS Linux có public IP hoặc NAT 1:1. NAT phức tạp cần điều chỉnh `external-ip`/`relay-ip` trong cấu hình Coturn.

```bash
node scripts/configure.mjs chat.example.com IP_VPS_CUA_BAN you@example.com
docker compose --env-file .env -f infrastructure/compose.yaml up -d --build
docker compose --env-file .env -f infrastructure/compose.yaml ps
```

Thay tên miền, IPv4 và email thật trước khi chạy. Caddy lấy chứng chỉ tự động; DNS/cổng 80/443 phải truy cập được. Sau đó mở `https://chat.example.com`, đăng ký hai tài khoản ở hai thiết bị và thử chat/gọi.

```bash
# Kiểm tra sức khỏe, log và tài nguyên
curl -fsS https://chat.example.com/api/health
docker compose --env-file .env -f infrastructure/compose.yaml logs --tail=80 server web coturn
docker stats --no-stream

# Cập nhật sau khi thay mã nguồn
docker compose --env-file .env -f infrastructure/compose.yaml up -d --build
```

Frontend được build trong image; production không giữ tiến trình Node. Các volume `app_data`, `caddy_data`, `caddy_config` giữ dữ liệu khi thay container. Không dùng `down -v` nếu muốn giữ dữ liệu.

| Service | Giới hạn RAM trong Compose | CPU tối đa |
| --- | --- | --- |
| Rust + SQLite | 512 MiB | 1.5 vCPU |
| Caddy + frontend | 192 MiB | 0.5 vCPU |
| Coturn | 256 MiB | 1 vCPU |

Đây là **giới hạn**, không phải số RAM đo được hay cam kết phục vụ. Hệ điều hành, Docker, page cache và build cần thêm RAM. Image Rust build với 2 job; nên build ở máy phát triển/CI rồi đẩy image nếu VPS thiếu tài nguyên. TURN giới hạn 160 allocation, 32/user, 128.000 byte/s mỗi phiên, tổng 20.480.000 byte/s (Coturn dự trữ theo từng allocation, kể cả ICE candidate chưa được chọn); cần tăng dải relay và quota theo benchmark thực tế.

Backend giới hạn 256 WebSocket tổng cộng, 3 kết nối/tài khoản, queue 64 sự kiện/kết nối, mỗi frame/tin WebSocket tối đa 64 KiB. Gửi socket quá 10 giây hoặc queue đầy sẽ ngắt client; đồng bộ lại từ database. SQLx pool 4 kết nối, cache SQLite 4 MiB/kết nối, synchronous FULL; tối đa 2 tác vụ băm mật khẩu và 4 tác vụ tệp đồng thời. HTTP có rate limit theo IP, chat/signaling có rate limit theo tài khoản. `TRUST_PROXY=true` chỉ dùng khi backend được cô lập sau Caddy, vì Caddy ghi đè X-Real-IP.

## Sao lưu và khôi phục

```bash
./scripts/backup.sh
```

Script chụp snapshot SQLite nhất quán khi ứng dụng đang chạy rồi sao chép uploads. Tệp được lưu ở `backups/may-TIMESTAMP.tar.gz`; cần sao chép backup sang máy/object storage khác và đặt lịch cron tùy nhu cầu. Khi upload mới phát sinh sau snapshot, backup có thể chứa thêm tệp chưa được tham chiếu; không mất tệp đã được database trong snapshot tham chiếu. Lưu `.env` và cấu hình triển khai ở nơi riêng.

Khôi phục trên cùng project/volume:

```bash
# Dừng backend để không còn writer.
docker compose --env-file .env -f infrastructure/compose.yaml stop server
mkdir -p /tmp/may-restore
# Chỉ giải nén bản backup do chính bạn tạo, trong thư mục trống.
tar -xzf backups/may-TIMESTAMP.tar.gz -C /tmp/may-restore
# Container tạm thừa hưởng volume của service, chạy root để đặt lại ownership.
docker compose --env-file .env -f infrastructure/compose.yaml run --rm --no-deps --user root \
  -v /tmp/may-restore:/restore:ro server sh -ec \
  'rm -f /app/data/may.db-wal /app/data/may.db-shm; cp /restore/may.db /app/data/may.db; cp -a /restore/uploads/. /app/data/uploads/; chown -R may:may /app/data'
docker compose --env-file .env -f infrastructure/compose.yaml up -d server
```

Lệnh khôi phục thay thế database đang có. Trước đó hãy sao lưu bản hiện tại, thử trên volume riêng và kiểm tra đăng nhập/lịch sử/tệp sau khôi phục. Dữ liệu tài khoản của bản snapshot sẽ có hiệu lực trở lại.

## Kiểm tra

Để chạy cả bốn bài kiểm thử trên database riêng, cần Node.js, npm, Chrome và Docker Compose từ 2.24.4 trở lên. Sandbox dùng cổng 8089 và project riêng, không dùng dữ liệu local ở 8088:

```bash
npm ci
docker compose -p may-chat-test -f infrastructure/compose.local.yaml -f infrastructure/compose.test.yaml up -d --build
TEST_BASE_URL=http://localhost:8089 TEST_SERVER_CONTAINER=may-chat-test-server-1 npm run test:limits
TEST_BASE_URL=http://localhost:8089 npm run test:e2e
TEST_BASE_URL=http://localhost:8089 npm run test:sounds
TEST_BASE_URL=http://localhost:8089 npm run test:media
# Chỉ xóa container và volume thử nghiệm của project may-chat-test:
docker compose -p may-chat-test -f infrastructure/compose.local.yaml -f infrastructure/compose.test.yaml down -v
```

Các lệnh kiểm tra mã nguồn khi đã cài dependency frontend và Rust toolchain:

```bash
npm run check
npm run build
cargo fmt --manifest-path server/Cargo.toml --check
cargo check --locked --manifest-path server/Cargo.toml
# Cần backend + Vite đang chạy, Chrome cài sẵn.
CHROME_BIN=/usr/bin/google-chrome npm run test:e2e
```

Bài kiểm thử trình duyệt tạo ba tài khoản độc lập, kiểm tra auth/CSRF/quyền phòng, gửi trùng không tạo bản sao, quyền tải tệp, WebSocket realtime, video mesh ba peer bằng camera/micro giả, outbox khi mất mạng, lịch sử sau tải lại, kích thước 320/360/390/430/768/1365 px, bảng thông tin, cài đặt và đăng xuất. Tài khoản test có tiền tố `test_`; dùng database riêng khi kiểm thử lặp lại, tránh làm bẩn dữ liệu thật. Ảnh kiểm thử ở `test-results/` không được đưa vào Git.

Kiểm thử tự động trong Chromium không thay thế kiểm thử iPhone/Safari, Android, 4G/5G, NAT đối xứng hoặc TURN trên public VPS. Kiểm tra một cặp điện thoại Wi-Fi/4G, quyền media, đổi mạng, khóa màn hình, camera trước và băng thông trước khi mở cho nhiều người. Trình duyệt di động có thể treo tab hoặc ngắt media khi khóa màn hình; hiện chưa có push/service worker gọi đến khi đóng ứng dụng.

## Giới hạn hiện tại và mở rộng

- **Chưa có LiveKit/SFU, PostgreSQL, Redis hoặc nhiều gateway.** Nhóm 3–5 người hiện dùng mesh; mỗi thiết bị gửi N−1 bản media, nên cần thử mạng/CPU và chuyển SFU nếu chất lượng không đạt. Không có transcoding/ghi hình ở backend Rust.
- Chưa benchmark 100.000 tài khoản hay 100.000 kết nối đồng thời. Đây là nền tảng nhóm nhỏ, có đường chuyển kiến trúc; không phải cam kết capacity.
- Danh sách phòng lấy 200 phòng gần nhất; lịch sử cuộc gọi lấy 100 bản gần nhất. Lịch sử tin nhắn phân trang 50 bản/lần, cache tối đa 500 bản/phòng. Khi cache đầy, giao diện không tải thêm tin cũ để tránh đẩy mất trang vừa tải; cần chuyển phòng hoặc tải lại để bắt đầu từ mới nhất.
- Không có mã hóa đầu cuối cho chat, khôi phục mật khẩu qua email, xác minh email, quản trị kiểm duyệt, push notification khi đóng tab hay quét virus tệp. Đăng ký đang mở; chỉ chia sẻ domain cho nhóm thử nghiệm cho đến khi bổ sung chính sách tài khoản.
- Thông báo trình duyệt chỉ được gửi khi tab còn chạy và người dùng cấp quyền. Safari/iOS có thể yêu cầu ứng dụng cài trên Home Screen và service worker, chưa được tích hợp ở bản này.
- Tin chờ gửi được giữ trong localStorage theo ID tài khoản; logout không xóa hàng đợi để tránh mất tin chưa gửi. Khi dùng máy chung, cần xóa dữ liệu website sau khi đăng xuất. Không lưu token đăng nhập trong localStorage.
- Bước mở rộng: thêm repository SQLx/PostgreSQL và chuyển dữ liệu có kiểm tra; tách object storage; dùng transactional outbox + bus để phát sự kiện giữa gateway; thêm LiveKit SFU cho group; đo p95/p99 độ trễ, RAM/socket, tỷ lệ relay và egress. Redis Pub/Sub đơn thuần không đủ để bảo đảm giao nhận bền vững; lịch sử DB và cursor vẫn là nguồn khôi phục.

## Kiểm thử giới hạn và emoji

```bash
TEST_BASE_URL=http://localhost:8089 npm run test:limits
```

Chạy trên một bộ container thử nghiệm riêng như các bài kiểm thử còn lại. Bài này xác nhận đăng ký/đăng nhập với 8 ký tự, từ chối 7 ký tự cả Unicode và ASCII; kiểm tra từng glyph emoji nằm trong khung ở màn hình 320–1440 px, giao diện sáng/tối; thử tiến độ/hủy upload, gửi tệp trên 5 MB từ giao diện, tải xuống qua trình duyệt và kiểm tra SHA-256 khi truyền tệp 99.999.999 byte. Tệp đúng 100.000.000 byte bị từ chối ở client và server. Quota 1 GB/ngày được kiểm tra lại trong giao dịch trước khi ghi metadata.

## Tài liệu nền tảng

[Axum WebSocket](https://docs.rs/axum/0.8.9/axum/extract/ws/index.html), [SvelteKit static adapter](https://svelte.dev/docs/kit/adapter-static), [WebRTC peer connections](https://webrtc.org/getting-started/peer-connections), [SQLite WAL](https://sqlite.org/wal.html), [Coturn](https://github.com/coturn/coturn). Font Be Vietnam Pro được lưu cục bộ và kèm giấy phép OFL.
