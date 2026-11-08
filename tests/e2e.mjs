import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const base = process.env.TEST_BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const contexts = [];
const id = Date.now().toString(36);
const headers = { Origin: new URL(base).origin };
await mkdir('test-results', { recursive: true });
async function request(ctx, method, path, data, status = 200) {
  const r = await ctx.request[method](`${base}/api${path}`, { headers, data });
  assert.equal(r.status(), status, `${method} ${path}: ${await r.text()}`);
  return r.status() === 204 ? null : r.json().catch(() => null);
}
async function wait(fn, message, timeout = 15000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await new Promise(r => setTimeout(r, 200)); } throw new Error(message); }
try {
  for (let i = 0; i < 3; i++) contexts.push(await browser.newContext({ viewport: { width: 1365, height: 900 }, permissions: ['camera', 'microphone'] }));
  const [a, b, outsider] = contexts;
  await request(a, 'get', '/me', undefined, 401);
  await request(a, 'post', '/auth/register', { username: `invalid_${id}`, password: '汉字密码汉', name: 'Invalid' }, 400);
  const users = [];
  for (const [i, ctx] of contexts.entries()) users.push(await request(ctx, 'post', '/auth/register', { username: `test_${id}_${i}`, password: 'Testing-strong-pass-123', name: `Người thử ${i + 1}` }));
  await request(a, 'post', '/auth/login', { username: users[0].username, password: 'incorrect-password' }, 401);
  const csrf = await a.request.post(`${base}/api/conversations`, { headers: { Origin: 'https://evil.invalid' }, data: { members: [users[1].id], kind: 'direct' } }); assert.equal(csrf.status(), 403);
  const direct = await request(a, 'post', '/conversations', { members: [users[1].id], kind: 'direct' });
  const same = await request(b, 'post', '/conversations', { members: [users[0].id], kind: 'direct' }); assert.equal(same.id, direct.id);
  await request(outsider, 'get', `/conversations/${direct.id}/messages`, undefined, 403);
  await request(outsider, 'post', `/conversations/${direct.id}/messages`, { body: 'unauthorized', client_message_id: crypto.randomUUID() }, 403);
  const message = { body: 'Tin nhắn kiểm thử idempotence', client_message_id: crypto.randomUUID() };
  const first = await request(a, 'post', `/conversations/${direct.id}/messages`, message);
  const retry = await request(a, 'post', `/conversations/${direct.id}/messages`, message); assert.equal(first.seq, retry.seq);
  await request(a, 'post', `/conversations/${direct.id}/messages`, { ...message, body: 'different' }, 409);
  const attachment = await a.request.post(`${base}/api/conversations/${direct.id}/attachments`, { headers, multipart: { file: { name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('Xin chào từ Mây!') } } }); assert.equal(attachment.status(), 200); const file = await attachment.json();
  const privateFile = await outsider.request.get(`${base}/api/attachments/${file.id}`); assert.equal(privateFile.status(), 403);
  const allowedFile = await b.request.get(`${base}/api/attachments/${file.id}`); assert.equal(await allowedFile.text(), 'Xin chào từ Mây!');
  await request(a, 'post', `/conversations/${direct.id}/messages`, { body: 'Một tệp nhỏ', client_message_id: crypto.randomUUID(), attachment_id: file.id });
  // Verify both directions of cursor pagination across a full page.
  for (let n = 0; n < 51; n++) await request(a, 'post', `/conversations/${direct.id}/messages`, { body: `Trang lịch sử ${n}`, client_message_id: crypto.randomUUID() });
  const latest = await request(a, 'get', `/conversations/${direct.id}/messages`); assert.equal(latest.length, 50);
  const earlier = await request(a, 'get', `/conversations/${direct.id}/messages?before=${latest[0].seq}`); assert.equal(earlier.length, 3);
  const after = await request(a, 'get', `/conversations/${direct.id}/messages?after=${earlier.at(-1).seq}`); assert.deepEqual(after.map(m => m.seq), latest.map(m => m.seq));
  const group = await request(a, 'post', '/conversations', { members: [users[1].id, users[2].id], kind: 'group', name: `Nhóm kiểm thử ${id}` });
  const pages = await Promise.all(contexts.map(c => c.newPage()));
  for (const page of pages) { page.on('pageerror', e => errors.push(e.message)); await page.goto(base); await page.waitForSelector('.app-shell'); }
  await pages[2].getByRole('button', { name: 'Tạo cuộc trò chuyện', exact: true }).click();
  const dialog = pages[2].getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Tìm người để chat' }).fill(users[0].username);
  await dialog.locator('.person-result').filter({ hasText: users[0].name }).click();
  await dialog.getByRole('button', { name: 'Bắt đầu trò chuyện', exact: true }).click();
  for (const page of pages) await page.getByRole('button', { name: new RegExp(`Nhóm kiểm thử ${id}`) }).click();
  await pages[0].getByRole('textbox', { name: 'Nhập tin nhắn' }).fill('Tin nhắn realtime giữa ba tài khoản 💚');
  await pages[0].getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click();
  await pages[1].locator('.message-area').getByText('Tin nhắn realtime giữa ba tài khoản 💚', { exact: true }).waitFor();
  await pages[2].locator('.message-area').getByText('Tin nhắn realtime giữa ba tài khoản 💚', { exact: true }).waitFor();
  await wait(async () => (await pages[0].locator('.connection').textContent()).includes('Đã kết nối'), 'WebSocket did not connect');
  await pages[0].getByRole('button', { name: 'Gọi video', exact: true }).click();
  await pages[1].getByRole('button', { name: 'Nhận cuộc gọi' }).click();
  await wait(async () => (await pages[0].locator('.call-title').textContent())?.includes('Đã kết nối'), 'Two-peer WebRTC did not connect', 25000);
  await pages[2].getByRole('button', { name: 'Nhận cuộc gọi' }).click();
  await wait(async () => (await Promise.all(pages.map(p => p.locator('.video-tile').count()))).every(n => n === 3), 'Three-peer mesh streams did not arrive', 25000);
  await wait(async () => (await pages[2].locator('.call-title').textContent())?.includes('Đã kết nối'), 'Third peer did not connect');
  await pages[0].getByRole('button', { name: 'Tắt micro', exact: true }).click();
  await pages[0].getByRole('button', { name: 'Bật micro', exact: true }).waitFor();
  await pages[0].screenshot({ path: 'test-results/group-call.png' });
  for (const page of pages) await page.getByRole('button', { name: 'Kết thúc cuộc gọi', exact: true }).click();
  await a.setOffline(true);
  await pages[0].getByRole('textbox', { name: 'Nhập tin nhắn' }).fill('Tin nhắn chờ kết nối lại');
  await pages[0].getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click();
  await pages[0].getByRole('button', { name: /Chưa gửi · Thử lại/ }).waitFor();
  await a.setOffline(false);
  await wait(async () => await pages[1].locator('.message-area').getByText('Tin nhắn chờ kết nối lại', { exact: true }).count() === 1, 'Outbox did not resend after reconnect', 30000);
  const saved = await request(a, 'get', `/conversations/${group.id}/messages`); assert.equal(saved.filter(m => m.body === 'Tin nhắn chờ kết nối lại').length, 1);
  await pages[0].reload(); await pages[0].getByRole('button', { name: new RegExp(`Nhóm kiểm thử ${id}`) }).click(); await pages[0].locator('.message-area').getByText('Tin nhắn chờ kết nối lại', { exact: true }).waitFor();
  // Mobile: no horizontal overflow at common phone widths; the composer remains in view.
  for (const width of [320, 360, 390, 430, 768, 1365]) {
    await pages[0].setViewportSize({ width, height: 844 }); await pages[0].waitForTimeout(150);
    const bounds = await pages[0].evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth, sendBottom: document.querySelector('.send-button')?.getBoundingClientRect().bottom, height: innerHeight }));
    assert.ok(bounds.content <= bounds.viewport, `Horizontal overflow at ${width}`); assert.ok(bounds.sendBottom <= bounds.height, `Composer hidden at ${width}`);
    if (width === 390) await pages[0].screenshot({ path: 'test-results/mobile-chat.png' });
  }
  await pages[0].setViewportSize({ width: 390, height: 480 });
  await pages[0].waitForTimeout(150);
  assert.ok(await pages[0].getByRole('button', { name: 'Gửi tin nhắn', exact: true }).evaluate(el => el.getBoundingClientRect().bottom <= innerHeight), 'Composer obscured with reduced keyboard viewport');
  assert.ok(await pages[0].getByRole('textbox', { name: 'Nhập tin nhắn' }).evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 16), 'iOS input font size must avoid focus zoom');
  await pages[0].setViewportSize({ width: 390, height: 844 });
  await pages[0].getByRole('button', { name: 'Thông tin cuộc trò chuyện', exact: true }).click(); await pages[0].getByRole('button', { name: 'Đóng thông tin' }).click();
  await pages[0].getByRole('button', { name: 'Quay lại danh sách' }).click();
  await pages[0].getByRole('button', { name: 'Cài đặt', exact: true }).click(); await pages[0].getByRole('button', { name: 'Tối', exact: true }).click();
  assert.equal(await pages[0].evaluate(() => document.documentElement.dataset.theme), 'dark'); await pages[0].getByRole('button', { name: 'Sáng', exact: true }).click(); await pages[0].getByRole('button', { name: 'Đóng', exact: true }).click();
  await request(a, 'post', '/auth/logout', {}); await request(a, 'get', '/me', undefined, 401);
  assert.deepEqual(errors, [], 'Browser JavaScript errors');
  console.log('PASS: auth, CSRF, membership, idempotency, private attachments, realtime, 3-peer WebRTC, reconnect/outbox, persisted/cursor history, responsive 320–1365 px, settings, logout.');
} finally { await Promise.all(contexts.map(c => c.close())); await browser.close(); }
