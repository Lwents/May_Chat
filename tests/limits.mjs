import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const base = process.env.TEST_BASE_URL || 'http://localhost:8089';
const origin = new URL(base).origin, id = Date.now().toString(36), MAX = 100_000_000;
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const contexts = [], errors = [];
const folder = await mkdtemp(join(tmpdir(), 'may-upload-'));
await mkdir('test-results', { recursive: true });
async function wait(fn, reason, timeout = 15000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error(reason); }
async function post(ctx, path, data, status = 200) { const response = await ctx.request.post(`${base}/api${path}`, { headers: { Origin: origin }, data }); assert.equal(response.status(), status, `${path}: ${await response.text()}`); return response.json().catch(() => null); }
async function upload(ctx, cid, size, name) {
  const boundary = `may-test-${crypto.randomUUID()}`;
  const preamble = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const ending = Buffer.from(`\r\n--${boundary}--\r\n`);
  const cookies = (await ctx.cookies(base)).map(c => `${c.name}=${c.value}`).join('; ');
  const chunk = Buffer.alloc(1024 * 1024, 0x61), hash = createHash('sha256');
  async function* body() { yield preamble; for (let n = 0; n < size; n += chunk.length) { const part = chunk.subarray(0, Math.min(chunk.length, size - n)); hash.update(part); yield part; } yield ending; }
  const response = await fetch(`${base}/api/conversations/${cid}/attachments`, { method: 'POST', headers: { Origin: origin, Cookie: cookies, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(preamble.length + size + ending.length) }, body: Readable.from(body()), duplex: 'half' });
  const value = await response.json();
  return { status: response.status, value, hash: response.ok ? hash.digest('hex') : null };
}
try {
  const a = await browser.newContext({ viewport: { width: 1440, height: 900 } }), b = await browser.newContext(); contexts.push(a, b);
  await post(a, '/auth/register', { username: `short_${id}`, name: 'Short', password: '1234567' }, 400);
  await post(a, '/auth/register', { username: `unicode_${id}`, name: 'Unicode', password: '汉字密码汉字密' }, 400);
  const page = await a.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(base); await page.waitForSelector('.auth-page');
  await page.getByRole('button', { name: 'Tạo tài khoản', exact: true }).click();
  const password = page.getByLabel('Mật khẩu', { exact: true }); assert.equal(await password.getAttribute('minlength'), '8');
  await page.getByLabel('Tên hiển thị', { exact: true }).fill('Giới hạn Alice');
  await page.getByLabel('Tên đăng nhập', { exact: true }).fill(`limit_${id}_a`); await password.fill('12345678');
  await page.getByRole('button', { name: 'Tạo tài khoản', exact: true }).click(); await page.waitForSelector('.app-shell');
  const bob = await post(b, '/auth/register', { username: `limit_${id}_b`, name: 'Giới hạn Bob', password: '87654321' });
  await post(b, '/auth/logout', {}); await post(b, '/auth/login', { username: bob.username, password: '87654321' });
  const { id: cid } = await post(a, '/conversations', { members: [bob.id], kind: 'direct' });
  await page.locator('.conversation').filter({ hasText: bob.name }).click();
  // Test all glyph boxes, not just document overflow, in both themes and phone sizes.
  for (const theme of ['dark', 'light']) for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 }); await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await page.getByRole('button', { name: 'Biểu tượng cảm xúc', exact: true }).click();
    const bounds = await page.locator('.emoji-picker').evaluate(panel => {
      const parent = panel.getBoundingClientRect();
      return { viewport: innerWidth, scroll: document.documentElement.scrollWidth, left: parent.left, right: parent.right, children: [...panel.querySelectorAll('button')].map(button => { const box = button.getBoundingClientRect(); const range = document.createRange(); range.selectNodeContents(button); const glyph = range.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, glyphLeft: glyph.left, glyphRight: glyph.right }; }), top: parent.top, bottom: parent.bottom };
    });
    assert.equal(bounds.children.length, 12); assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewport && bounds.scroll <= bounds.viewport, `Emoji overflow at ${width}/${theme}`);
    for (const child of bounds.children) { assert.ok(child.left >= bounds.left && child.right <= bounds.right && child.top >= bounds.top && child.bottom <= bounds.bottom, 'Emoji button outside picker'); assert.ok(child.glyphLeft >= child.left - 1 && child.glyphRight <= child.right + 1, 'Emoji glyph overflows its track'); }
    if (width === 1440 && theme === 'dark') await page.screenshot({ path: 'test-results/emoji-dark-desktop.png' });
    if (width === 320 && theme === 'dark') await page.screenshot({ path: 'test-results/emoji-dark-mobile.png' });
    await page.getByRole('button', { name: 'Thêm 🌿', exact: true }).click(); assert.ok((await page.getByRole('textbox', { name: 'Nhập tin nhắn', exact: true }).inputValue()).includes('🌿'));
    await page.getByRole('button', { name: 'Biểu tượng cảm xúc', exact: true }).click();
    await page.getByRole('textbox', { name: 'Nhập tin nhắn', exact: true }).fill('');
  }
  await page.setViewportSize({ width: 1365, height: 900 });
  const smallPath = join(folder, 'tep-tren-5MB.bin'); const small = await open(smallPath, 'w'); await small.truncate(6 * 1024 * 1024); await small.close();
  // Cancel a throttled upload and then send the same >5 MB file successfully.
  const cdp = await a.newCDPSession(page); await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: -1, uploadThroughput: 128 * 1024 });
  await page.locator('input[type=file]').setInputFiles(smallPath); await page.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click();
  await page.getByRole('progressbar', { name: 'Tiến độ tải tệp' }).waitFor(); await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Hủy tải', exact: true }).click(); await wait(async () => !await page.getByRole('progressbar').count(), 'Cancelled upload remained active');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click();
  await page.locator('.message-area .file-attachment').filter({ hasText: 'tep-tren-5MB.bin' }).waitFor();
  const downloading = page.waitForEvent('download'); await page.locator('.message-area .file-attachment').filter({ hasText: 'tep-tren-5MB.bin' }).click();
  const downloaded = await downloading; assert.equal(downloaded.suggestedFilename(), 'tep-tren-5MB.bin'); assert.equal(await downloaded.failure(), null);
  // Strict 100 MB limit in the picker without allocating a 100 MB JS buffer.
  const exactPath = join(folder, 'exact-100MB.bin'); const exact = await open(exactPath, 'w'); await exact.truncate(MAX); await exact.close();
  await page.locator('input[type=file]').setInputFiles(exactPath); await page.getByRole('status').getByText('Tệp đính kèm phải nhỏ hơn 100 MB.', { exact: true }).waitFor(); assert.equal(await page.locator('.attachment-preview').count(), 0);
  const largest = await upload(a, cid, MAX - 1, 'tệp-lớn.bin'); assert.equal(largest.status, 200, JSON.stringify(largest.value)); assert.equal(largest.value.size, MAX - 1);
  const cookie = (await b.cookies(base)).map(c => `${c.name}=${c.value}`).join('; ');
  const url = `${base}/api/attachments/${largest.value.id}`;
  for (let n = 0; n < 6; n++) { const head = await fetch(url, { method: 'HEAD', headers: { Cookie: cookie } }); assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), MAX - 1); }
  const response = await fetch(url, { headers: { Cookie: cookie } }); assert.equal(response.status, 200); assert.ok(response.headers.get('content-disposition').includes('filename*=UTF-8'));
  const digest = createHash('sha256'); let bytes = 0; for await (const chunk of response.body) { bytes += chunk.length; digest.update(chunk); }
  assert.equal(bytes, MAX - 1); assert.equal(digest.digest('hex'), largest.hash);
  const exactUpload = await upload(a, cid, MAX, 'exact-100MB.bin'); assert.equal(exactUpload.status, 413); assert.match(exactUpload.value.error, /100 MB/);
  if (process.env.TEST_SERVER_CONTAINER) await wait(() => {
    const paths = execFileSync('docker', ['exec', process.env.TEST_SERVER_CONTAINER, 'find', '/app/data/uploads', '-maxdepth', '1', '-name', '*.part'], { encoding: 'utf8' }); return paths.trim() === '';
  }, 'Partial upload files were not removed');
  assert.deepEqual(errors, [], 'Browser errors');
  console.log('PASS: 8-character registration/login, rejects 7 Unicode/ASCII chars, emoji glyphs contained at 320–1440px in light/dark, upload progress/cancel, >5 MB UI upload/native download, 99,999,999-byte streaming upload/download with SHA-256, rejects exactly 100 MB on client/server, HEAD releases permits, partial files cleaned.');
} catch (error) {
  for (const [n, ctx] of contexts.entries()) for (const page of ctx.pages()) { console.log('Failure page:', n, await page.getByRole('status').allTextContents()); await page.screenshot({ path: `test-results/limits-failure-${n}.png` }).catch(() => {}); }
  throw error;
} finally { await Promise.all(contexts.map(c => c.close())); await browser.close(); await rm(folder, { recursive: true, force: true }); }
