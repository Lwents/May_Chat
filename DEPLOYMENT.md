# Triển khai đang hoạt động

- Frontend: https://may-chat-lwents.pages.dev — Cloudflare Pages, project `may-chat-lwents`, nhánh production `main`.
- Backend Rust và Coturn: VPS `160.250.180.133`, checkout `/opt/may-chat`.
- API origin: `https://lwent.cloud/may-chat/api/`, Nginx chuyển tiếp vào `127.0.0.1:8090`. Các route khác của Nginx được giữ nguyên.
- Pages Function chuyển tiếp `/api/*` và WebSocket cùng origin. Cookie đăng nhập giữ `Secure; HttpOnly; SameSite=Strict`; không cần cookie bên thứ ba hoặc CORS.
- `ORIGIN_TOKEN` bảo vệ origin, được lưu trong Pages secret và file VPS `.env.vps` quyền 0600. Không ghi giá trị vào Git. Health check công khai không chứa thông tin xác thực.
- Dữ liệu local đã được nhập một lần vào volume `may-chat-vps_app_data`. Hai môi trường không đồng bộ liên tục. Người dùng đăng nhập lại bằng tài khoản cũ trên URL public.

## Cập nhật frontend

```bash
npm ci
npm --prefix apps/web ci
npm run check
node tests/pages-proxy.mjs
npm run build:pages
npx --yes wrangler@4.158.0 pages deploy build --project-name may-chat-lwents --branch main
```

Đăng nhập Wrangler bằng tài khoản Cloudflare có quyền dự án nếu phiên đã hết hạn. Project hiện tồn tại trên Pages; không dùng `--force` cho các lần deploy tiếp theo. Build Pages không tự bật demo khi API mất kết nối.

## Cập nhật backend

Push nguồn đã kiểm tra lên GitHub, rồi trên VPS:

```bash
cd /opt/may-chat
git pull --ff-only
docker compose --env-file .env.vps -f infrastructure/compose.vps.yaml up -d --build
curl -fsS https://may-chat-lwents.pages.dev/api/health
```

Nginx include `/etc/nginx/snippets/may-chat-api.conf` trong HTTPS server của `lwent.cloud`. Kiểm tra `nginx -t` trước khi reload nếu chỉnh route. Chứng chỉ TLS và tác vụ gia hạn hiện có được giữ nguyên. TURN dùng TCP/UDP 3478, UDP 49160–49399, tối đa 32 allocation/tài khoản và 160 toàn server để có chỗ cho ICE khi gọi nhóm. Giới hạn 128.000 byte/s mỗi allocation, capacity 20.480.000 byte/s tương ứng 160 allocation; tránh dự trữ hết capacity trước khi chọn ICE candidate. Không đưa cổng backend 8090 ra Internet.

## Dữ liệu và backup

```bash
cd /opt/may-chat
MAY_COMPOSE_FILE=infrastructure/compose.vps.yaml ./scripts/backup.sh
docker compose --env-file .env.vps -f infrastructure/compose.vps.yaml ps
docker compose --env-file .env.vps -f infrastructure/compose.vps.yaml logs --tail=80 server coturn
```

Backup ở `backups/` trên VPS. Cần sao chép backup ra nơi khác nếu muốn chống mất VPS. Không dùng `down -v` cho project production. Thông tin SSH, OAuth, `.env.vps`, database và uploads không nằm trong repository.
