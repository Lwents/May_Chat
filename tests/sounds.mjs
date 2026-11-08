import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const base = process.env.TEST_BASE_URL || 'http://localhost:8089';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true,
  ignoreDefaultArgs: ['--mute-audio'],
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=document-user-activation-required']
});
const contexts = [], errors = [];
const id = Date.now().toString(36);
const origin = new URL(base).origin;
await mkdir('test-results', { recursive: true });
async function wait(fn, message, timeout = 12000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error(message); }
async function post(ctx, path, data) { const r = await ctx.request.post(`${base}/api${path}`, { headers: { Origin: origin }, data }); assert.equal(r.status(), 200, `${path}: ${await r.text()}`); return r.json(); }
async function probe(page) { return page.evaluate(() => ({ started: window.__audioProbe.started, active: window.__audioProbe.active, maxRMS: window.__audioProbe.maxRMS, contexts: window.__audioProbe.contexts })); }
async function resetProbe(page) { await wait(async () => (await probe(page)).active === 0, 'Previous sound did not end'); await page.evaluate(() => { window.__audioProbe.started = 0; window.__audioProbe.maxRMS = 0; }); }
async function settings(page) { await page.getByRole('button', { name: 'Cài đặt', exact: true }).click(); return page.getByRole('dialog'); }
async function closeSettings(page) { await page.getByRole('dialog').getByRole('button', { name: 'Đóng', exact: true }).click(); }
try {
  for (let n = 0; n < 2; n++) {
    const ctx = await browser.newContext({ viewport: { width: 1365, height: 900 }, permissions: ['camera', 'microphone'] }); contexts.push(ctx);
    // Tap the real audio graph at the destination and sample its signal. No fake AudioContext.
    await ctx.addInitScript(() => {
      const Native = window.AudioContext;
      window.__audioProbe = { started: 0, active: 0, maxRMS: 0, contexts: 0 };
      window.AudioContext = class extends Native {
        constructor(...args) {
          super(...args); window.__audioProbe.contexts++;
          this.probeAnalyser = this.createAnalyser(); this.probeAnalyser.fftSize = 512;
          const samples = new Float32Array(512);
          setInterval(() => { this.probeAnalyser.getFloatTimeDomainData(samples); const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length); window.__audioProbe.maxRMS = Math.max(window.__audioProbe.maxRMS, rms); }, 10);
        }
        createGain() {
          const gain = super.createGain(), connect = gain.connect.bind(gain);
          gain.connect = (target, ...args) => { if (target === this.destination) connect(this.probeAnalyser); return connect(target, ...args); };
          return gain;
        }
        createOscillator() {
          const oscillator = super.createOscillator(), start = oscillator.start.bind(oscillator);
          oscillator.start = (...args) => { window.__audioProbe.started++; window.__audioProbe.active++; oscillator.addEventListener('ended', () => window.__audioProbe.active--, { once: true }); return start(...args); };
          return oscillator;
        }
      };
    });
  }
  const [a, b] = contexts;
  const alice = await post(a, '/auth/register', { username: `sound_${id}_a`, password: 'Sound-test-pass-123', name: 'Audio Alice' });
  const bob = await post(b, '/auth/register', { username: `sound_${id}_b`, password: 'Sound-test-pass-123', name: 'Audio Bob' });
  const conversation = await post(a, '/conversations', { members: [bob.id], kind: 'direct' });
  const pa = await a.newPage(), pb = await b.newPage();
  for (const p of [pa, pb]) { p.on('pageerror', e => errors.push(e.message)); await p.goto(base); await p.waitForSelector('.app-shell'); }
  await wait(async () => (await pb.locator('.connection').textContent()).includes('Đã kết nối'), 'Receiver WebSocket not connected');
  // No audio context is created, and no history is sounded, before the first real gesture.
  assert.equal((await probe(pb)).contexts, 0);
  await post(a, `/conversations/${conversation.id}/messages`, { body: 'Tin trước khi bật âm', client_message_id: crypto.randomUUID() });
  await pb.locator('.conversation').getByText('Tin trước khi bật âm', { exact: true }).waitFor();
  assert.equal((await probe(pb)).started, 0);
  await pb.getByRole('button', { name: 'Bật âm thanh thông báo', exact: true }).click();
  await wait(async () => (await probe(pb)).maxRMS > 0.01, 'Explicit unlock did not produce a real audio signal');
  await resetProbe(pb);
  await pa.locator('.conversation').filter({ hasText: 'Audio Bob' }).click();
  await pa.getByRole('textbox', { name: 'Nhập tin nhắn' }).fill('Tin có âm báo');
  await pa.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click();
  await wait(async () => (await probe(pb)).maxRMS > 0.01, 'Incoming message was silent');
  await wait(async () => (await probe(pa)).maxRMS > 0.005, 'Confirmed outgoing message was silent');
  await resetProbe(pb);
  const repeated = { body: 'Tin không phát lặp khi retry', client_message_id: crypto.randomUUID() };
  await post(a, `/conversations/${conversation.id}/messages`, repeated);
  await wait(async () => (await probe(pb)).started > 0, 'Fresh message did not sound');
  await resetProbe(pb);
  await post(a, `/conversations/${conversation.id}/messages`, repeated);
  await pb.waitForTimeout(450); assert.equal((await probe(pb)).started, 0, 'Idempotent retry played a duplicate alert');
  let dialog = await settings(pb);
  await dialog.getByRole('checkbox', { name: 'Âm báo tin nhắn' }).uncheck();
  const slider = dialog.getByRole('slider', { name: 'Âm lượng thông báo' }); await slider.focus(); await slider.press('Home'); for (let n = 0; n < 7; n++) await slider.press('ArrowRight');
  await closeSettings(pb); await resetProbe(pb);
  await post(a, `/conversations/${conversation.id}/messages`, { body: 'Tin khi âm báo đã tắt', client_message_id: crypto.randomUUID() });
  await pb.locator('.conversation').getByText('Tin khi âm báo đã tắt', { exact: true }).waitFor();
  await pb.waitForTimeout(450); assert.equal((await probe(pb)).started, 0, 'Message mute ignored');
  await pb.reload(); await pb.waitForSelector('.app-shell');
  await wait(async () => (await pb.locator('.connection').textContent()).includes('Đã kết nối'), 'Reloaded receiver did not reconnect');
  const lockedCall = await post(a, '/calls', { conversation_id: conversation.id, mode: 'audio' });
  await pb.getByRole('button', { name: 'Bật chuông', exact: true }).waitFor();
  assert.equal((await probe(pb)).contexts, 0, 'Incoming call bypassed the gesture requirement');
  await pb.getByRole('button', { name: 'Bật chuông', exact: true }).click();
  await wait(async () => (await probe(pb)).maxRMS > 0.005, 'Gesture did not unlock an already-ringing incoming call');
  await post(a, `/calls/${lockedCall.id}/leave`, {});
  await wait(async () => !await pb.locator('.incoming-call').count(), 'Cancelled locked call remained visible');
  await resetProbe(pb);
  dialog = await settings(pb); assert.equal(await dialog.getByRole('checkbox', { name: 'Âm báo tin nhắn' }).isChecked(), false); assert.equal(await dialog.getByRole('slider').inputValue(), '35');
  await dialog.getByRole('checkbox', { name: 'Âm báo tin nhắn' }).check();
  await dialog.getByRole('button', { name: 'Nghe thử chuông' }).click();
  await wait(async () => (await probe(pb)).maxRMS > 0.005, 'Ringtone preview was silent');
  await closeSettings(pb); await resetProbe(pb); await resetProbe(pa);
  await pa.getByRole('button', { name: 'Gọi thoại', exact: true }).click();
  await pb.getByRole('button', { name: 'Nhận cuộc gọi', exact: true }).waitFor();
  await wait(async () => (await probe(pb)).maxRMS > 0.005, 'Incoming call ringtone was silent');
  await wait(async () => (await probe(pa)).maxRMS > 0.005, 'Outgoing ringback was silent');
  const firstRing = (await probe(pb)).started;
  await wait(async () => (await probe(pb)).started > firstRing, 'Incoming ringtone did not repeat', 7000);
  await pb.getByRole('button', { name: 'Từ chối cuộc gọi', exact: true }).click();
  await wait(async () => !await pa.locator('.call-overlay').count(), 'Caller did not end after rejection');
  await resetProbe(pa); await resetProbe(pb); await pb.waitForTimeout(3000);
  assert.equal((await probe(pb)).started, 0, 'Ringtone kept playing after rejection'); assert.equal((await probe(pa)).started, 0, 'Ringback kept playing after rejection');
  // Muting call audio persists, without affecting the incoming-call controls.
  dialog = await settings(pb); await dialog.getByRole('checkbox', { name: 'Chuông cuộc gọi' }).uncheck(); await closeSettings(pb); await resetProbe(pb);
  await pa.getByRole('button', { name: 'Gọi thoại', exact: true }).click(); await pb.getByRole('button', { name: 'Nhận cuộc gọi', exact: true }).waitFor(); await pb.waitForTimeout(500);
  assert.equal((await probe(pb)).started, 0, 'Muted call still rang');
  await post(a, `/conversations/${conversation.id}/messages`, { body: 'Tin vẫn có âm khi tắt chuông gọi', client_message_id: crypto.randomUUID() });
  await wait(async () => (await probe(pb)).maxRMS > 0.005, 'Call mute incorrectly muted message notifications');
  await resetProbe(pb);
  await pa.getByRole('button', { name: 'Kết thúc cuộc gọi', exact: true }).click(); await wait(async () => !await pb.locator('.incoming-call').count(), 'Cancelled call remained visible');
  dialog = await settings(pb); await dialog.getByRole('checkbox', { name: 'Chuông cuộc gọi' }).check(); await closeSettings(pb); await resetProbe(pb);
  await pa.getByRole('button', { name: 'Gọi thoại', exact: true }).click(); await pb.getByRole('button', { name: 'Nhận cuộc gọi', exact: true }).click();
  await wait(async () => (await pa.locator('.call-title').textContent()).includes('Đã kết nối'), 'Accepted audio call did not connect', 25000);
  await resetProbe(pa); await resetProbe(pb); await pb.waitForTimeout(3000);
  assert.equal((await probe(pb)).started, 0, 'Ringtone continued after answering'); assert.equal((await probe(pa)).started, 0, 'Ringback continued after answering');
  await pa.getByRole('button', { name: 'Kết thúc cuộc gọi', exact: true }).click(); await wait(async () => !await pb.locator('.call-overlay').count(), 'Call did not end');
  await pb.setViewportSize({ width: 320, height: 568 }); dialog = await settings(pb); await dialog.getByRole('button', { name: 'Nghe thử tin nhắn' }).click(); await pb.waitForTimeout(450);
  assert.ok(await pb.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile sound settings overflow');
  await pb.screenshot({ path: 'test-results/mobile-sound-settings.png' });
  await closeSettings(pb);
  assert.deepEqual(errors, [], 'Browser errors');
  console.log('PASS: real Web Audio signal, gesture unlock with autoplay policy enabled, sent/received alerts, no duplicate retry alert, persisted toggles/volume, preview, incoming ringtone loop, outgoing ringback, stop on reject/cancel/answer/end, 320px settings.');
} catch (error) {
  for (const [i, ctx] of contexts.entries()) for (const page of ctx.pages()) {
    console.log('Failure page', i, 'probe:', await probe(page).catch(() => null), 'dialog:', await page.getByRole('dialog').allTextContents().catch(() => []));
    await page.screenshot({ path: `test-results/sound-failure-${i}.png` }).catch(() => {});
  }
  throw error;
} finally { await Promise.all(contexts.map(c => c.close())); await browser.close(); }
