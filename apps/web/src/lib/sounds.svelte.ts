type Ring = { id: string; kind: 'incoming' | 'outgoing'; deadline: number };
type Voice = { oscillator: OscillatorNode; gain: GainNode; family: 'message' | 'ring' };

/** One lazy Web Audio context, with short-lived oscillators and no downloaded media. */
class Sounds {
  messagesEnabled = $state(true);
  callsEnabled = $state(true);
  volume = $state(1);
  ready = $state(false);
  supported = $state(true);
  private context?: AudioContext;
  private master?: GainNode;
  private wanted?: Ring;
  private interval?: ReturnType<typeof setInterval>;
  private expiry?: ReturnType<typeof setTimeout>;
  private voices = new Set<Voice>();
  private recent = new Set<string>();
  private lastReceived = 0;
  private lastSent = 0;
  private initialized = false;

  private constructorForBrowser() {
    return window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  }

  init() {
    if (this.initialized) return;
    this.initialized = true;
    this.supported = !!this.constructorForBrowser();
    void this.unlock();
    document.addEventListener('pointerdown', this.gesture, true);
    document.addEventListener('touchend', this.gesture, true);
    document.addEventListener('keydown', this.gesture, true);
    document.addEventListener('visibilitychange', this.visible);
  }

  private gesture = (event: Event) => {
    if (event.target instanceof Element && event.target.closest('[data-enable-audio]')) return;
    if (event.isTrusted && (this.messagesEnabled || this.callsEnabled) && !this.ready) void this.unlock();
  };
  private visible = () => { if (document.visibilityState === 'visible' && !this.ready) void this.unlock(); };

  /** Called synchronously from a real click/tap/key event to satisfy autoplay policy. */
  async unlock(): Promise<boolean> {
    try {
      const Constructor = this.constructorForBrowser();
      if (!Constructor) { this.supported = false; return false; }
      if (!this.context || this.context.state === 'closed') {
        const context = new Constructor();
        this.context = context;
        this.master = context.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(context.destination);
        context.onstatechange = () => {
          if (this.context !== context) return;
          this.ready = context.state === 'running';
          if (!this.ready) this.stopVoices('message');
          this.syncRing();
        };
      }
      const context = this.context;
      // Start resume inside the gesture, before yielding to any promise.
      const resumed = context.state === 'running' ? Promise.resolve() : context.resume();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([resumed, new Promise<void>(resolve => { timeout = setTimeout(resolve, 1500); })]);
      } finally { clearTimeout(timeout); }
      if (this.context !== context) return false;
      this.ready = context.state === 'running';
      this.syncRing();
      return this.ready;
    } catch { this.ready = false; return false; }
  }

  private firstEvent(key: string) {
    if (this.recent.has(key)) return false;
    this.recent.add(key);
    if (this.recent.size > 256) this.recent.delete(this.recent.values().next().value!);
    return true;
  }
  received(id: string) {
    if (!this.firstEvent(`received:${id}`) || !this.messagesEnabled || (this.wanted && this.callsEnabled)) return;
    // Coalesce bursts; history synchronization never calls this method.
    const now = Date.now();
    if (now - this.lastReceived < 350) return;
    this.lastReceived = now;
    this.messageTone(false);
  }
  sent(id: string) {
    if (!this.firstEvent(`sent:${id}`) || !this.messagesEnabled || (this.wanted && this.callsEnabled)) return;
    const now = Date.now();
    if (now - this.lastSent < 150) return;
    this.lastSent = now; this.messageTone(true);
  }

  private messageTone(sent: boolean) {
    if (sent) {
      this.tone(620, 0, 0.08, 0.08, 'message');
      this.tone(830, 0.055, 0.09, 0.06, 'message');
    } else {
      this.tone(880, 0, 0.13, 0.17, 'message');
      this.tone(1174.66, 0.11, 0.23, 0.13, 'message');
    }
  }
  startRinging(id: string, kind: Ring['kind'], deadline: number) {
    if (this.wanted?.id === id && this.wanted.kind === kind) return;
    this.stopRinging();
    const remaining = Math.min(90000, deadline - Date.now());
    if (remaining <= 0) return;
    this.wanted = { id, kind, deadline };
    this.expiry = setTimeout(() => this.stopRinging(), remaining);
    this.syncRing();
  }
  private syncRing() {
    const wanted = this.wanted;
    if (!this.callsEnabled || !this.ready || this.volume === 0) {
      clearInterval(this.interval); this.interval = undefined;
      this.stopVoices('ring');
      return;
    }
    if (!wanted) return;
    if (wanted.deadline <= Date.now()) { this.stopRinging(); return; }
    if (this.interval) return;
    this.ringTone(wanted.kind);
    this.interval = setInterval(() => {
      if (this.wanted?.deadline && this.wanted.deadline <= Date.now()) { this.stopRinging(); return; }
      if (this.wanted) this.ringTone(this.wanted.kind);
    }, 2800);
  }
  private ringTone(kind: Ring['kind']) {
    if (kind === 'incoming') {
      for (const delay of [0, 0.55]) for (const hz of [440, 480]) this.tone(hz, delay, 0.35, 0.13, 'ring');
    } else {
      for (const hz of [440, 480]) this.tone(hz, 0, 1, 0.055, 'ring');
    }
  }
  stopRinging() {
    this.wanted = undefined;
    clearInterval(this.interval); this.interval = undefined;
    clearTimeout(this.expiry); this.expiry = undefined;
    this.stopVoices('ring');
  }
  private tone(hz: number, delay: number, duration: number, level: number, family: Voice['family']) {
    const context = this.context;
    if (!context || context.state !== 'running' || !this.master || this.volume === 0) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime + 0.01 + delay;
    oscillator.type = 'sine';
    oscillator.frequency.value = hz;
    gain.gain.setValueAtTime(0, context.currentTime);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(level, start + 0.012);
    gain.gain.setValueAtTime(level, start + Math.max(0.013, duration - 0.045));
    gain.gain.linearRampToValueAtTime(0, start + duration);
    oscillator.connect(gain); gain.connect(this.master);
    const voice: Voice = { oscillator, gain, family };
    this.voices.add(voice);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); this.voices.delete(voice); };
    oscillator.start(start); oscillator.stop(start + duration + 0.01);
  }
  private stopVoices(family: Voice['family']) {
    for (const voice of this.voices) if (voice.family === family) {
      // Disconnect immediately, including notes scheduled later in the ring cycle.
      voice.gain.disconnect();
      try { voice.oscillator.stop(); } catch { /* Already ended. */ }
      this.voices.delete(voice);
    }
  }
  destroy() {
    document.removeEventListener('pointerdown', this.gesture, true);
    document.removeEventListener('touchend', this.gesture, true);
    document.removeEventListener('keydown', this.gesture, true);
    document.removeEventListener('visibilitychange', this.visible);
    this.stopRinging(); this.stopVoices('message');
    const context = this.context;
    this.context = undefined; this.master = undefined; this.ready = false; this.initialized = false;
    if (context && context.state !== 'closed') void context.close().catch(() => {});
  }
}
export const sounds = new Sounds();
