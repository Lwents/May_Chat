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
          gain.connect = (target, ...args) => { if (target === this.destination) { window.__audioProbe.volume = gain.gain.value; connect(this.probeAnalyser); } return connect(target, ...args); };
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
  // Old mute preferences must no longer override the always-on defaults.
  for (const ctx of contexts) await ctx.addInitScript(() => { localStorage.setItem('may-sounds-v1', JSON.stringify({ messages: false, calls: false, volume: 0 })); localStorage.setItem('may-enter-send', 'false'); });
  const alice = await post(a, '/auth/register', { username: `sound_${id}_a`, password: 'Sound-test-pass-123', name: 'Audio Alice' });
  const bob = await post(b, '/auth/register', { username: `sound_${id}_b`, password: 'Sound-test-pass-123', name: 'Audio Bob' });
  const conversation = await post(a, '/conversations', { members: [bob.id], kind: 'direct' });
  const pa = await a.newPage(), pb = await b.newPage();
  for (const p of [pa, pb]) { p.on('pageerror', e => errors.push(e.message)); await p.goto(base); await p.waitForSelector('.app-shell'); }
  await wait(async () => (await pb.locator('.connection').textContent()).includes('Đã kết nối'), 'Receiver WebSocket not connected');
  // Strict autoplay is still enabled: a regular UI gesture unlocks audio, no special switch.
  await settings(pb);
  assert.equal(await pb.evaluate(() => window.__audioProbe.volume), 1);
  assert.equal(await pb.getByRole('slider').count(), 0);
  assert.equal(await pb.getByRole('checkbox').count(), 0);
  assert.equal(await pb.getByRole('button', { name: /Nghe thử|Bật chuông|Bật âm thanh/ }).count(), 0);
  await pb.getByRole('button', { name: /Thông báo trình duyệt/ }).waitFor();
  await closeSettings(pb);
  await pa.locator('.conversation').filter({ hasText: 'Audio Bob' }).click();
  await pa.getByRole('textbox', { name: 'Nhập tin nhắn' }).fill('Tin có âm báo tự động');
  await pa.getByRole('textbox', { name: 'Nhập tin nhắn' }).press('Enter');
  await wait(async () => (await probe(pb)).maxRMS > 0.01, 'Automatic incoming message alert was silent');
  await wait(async () => (await probe(pa)).maxRMS > 0.005, 'Confirmed outgoing message was silent');
  await resetProbe(pb);
  const repeated = { body: 'Không phát lặp khi retry', client_message_id: crypto.randomUUID() };
  await post(a, `/conversations/${conversation.id}/messages`, repeated);
  await wait(async () => (await probe(pb)).started > 0, 'Fresh message did not sound'); await resetProbe(pb);
  await post(a, `/conversations/${conversation.id}/messages`, repeated); await pb.waitForTimeout(450); assert.equal((await probe(pb)).started, 0);
  await pa.getByRole('button', { name: 'Gọi thoại', exact: true }).click();
  await pb.getByRole('button', { name: 'Nhận cuộc gọi', exact: true }).waitFor();
  await wait(async () => (await probe(pb)).maxRMS > 0.005, 'Automatic incoming ringtone was silent');
  await wait(async () => (await probe(pa)).maxRMS > 0.005, 'Outgoing ringback was silent');
  const firstRing = (await probe(pb)).started;
  await wait(async () => (await probe(pb)).started > firstRing, 'Ringtone did not repeat', 7000);
  await pb.getByRole('button', { name: 'Từ chối cuộc gọi', exact: true }).click();
  await wait(async () => !await pa.locator('.call-overlay').count(), 'Caller did not end after rejection');
  await resetProbe(pa); await resetProbe(pb); await pb.waitForTimeout(3000);
  assert.equal((await probe(pb)).started, 0); assert.equal((await probe(pa)).started, 0);
  const otherTab = await b.newPage(); otherTab.on('pageerror', e => errors.push(e.message));
  await otherTab.goto(base); await otherTab.waitForSelector('.app-shell'); await settings(otherTab); await closeSettings(otherTab);
  await wait(async () => (await otherTab.locator('.connection').textContent()).includes('Đã kết nối'), 'Other receiver tab not connected');
  await pb.evaluate(() => { const native = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = async (...args) => { const stream = await native(...args); await new Promise(r => setTimeout(r, 2500)); return stream; }; });
  await pa.getByRole('button', { name: 'Gọi thoại', exact: true }).click();
  await otherTab.getByRole('button', { name: 'Nhận cuộc gọi', exact: true }).waitFor();
  await wait(async () => (await probe(otherTab)).active > 0, 'Other receiver tab did not ring');
  await pb.getByRole('button', { name: 'Nhận cuộc gọi', exact: true }).click();
  await wait(async () => (await pa.locator('.call-title').textContent()).includes('Đang kết nối'), 'Caller kept ringing while receiver awaited microphone', 1000);
  await wait(async () => (await probe(pa)).active === 0 && (await probe(pb)).active === 0 && (await probe(otherTab)).active === 0, 'Answer did not immediately silence all tabs', 800);
  assert.equal(await otherTab.locator('.incoming-call').count(), 0, 'Other receiver tab still shows incoming call');
  await wait(async () => (await pa.locator('.call-title').textContent()).includes('Đã kết nối'), 'Accepted audio call did not connect', 25000);
  await resetProbe(pa); await resetProbe(pb); await pb.waitForTimeout(3000);
  assert.equal((await probe(pb)).started, 0); assert.equal((await probe(pa)).started, 0);
  await otherTab.reload(); await wait(async () => (await otherTab.locator('.connection').textContent()).includes('Đã kết nối'), 'Reloaded receiver tab did not connect');
  await otherTab.waitForTimeout(500); assert.equal(await otherTab.locator('.incoming-call').count(), 0, 'Answered call rang again after refreshing another tab');
  await pa.getByRole('button', { name: 'Kết thúc cuộc gọi', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log('PASS: automatic sent/received audio and ringtone under real autoplay policy, obsolete mute settings ignored, no audio/Enter controls, browser notification setting retained, duplicate suppression, ring stops on reject/answer/end, immediate silence before delayed microphone, multi-tab acceptance and no ringing after tab reload.');
} catch (error) {
  for (const [i, ctx] of contexts.entries()) for (const page of ctx.pages()) {
    console.log('Failure page', i, 'probe:', await probe(page).catch(() => null), 'dialog:', await page.getByRole('dialog').allTextContents().catch(() => []));
    await page.screenshot({ path: `test-results/sound-failure-${i}.png` }).catch(() => {});
  }
  throw error;
} finally { await Promise.all(contexts.map(c => c.close())); await browser.close(); }
