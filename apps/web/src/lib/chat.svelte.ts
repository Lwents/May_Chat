import { sounds } from './sounds.svelte';
import { MAX_FILE_BYTES, FILE_SIZE_ERROR } from './limits';
export type Person = { id: string; username: string; name: string; online?: boolean };
export type Message = {
  id: string; seq: number; conversation_id: string; sender_id: string; client_message_id: string;
  body: string; created_at: number; attachment_id?: string | null; attachment_name?: string | null;
  attachment_mime?: string | null; attachment_size?: number | null; status?: 'pending' | 'failed'; demo_url?: string;
};
export type Conversation = { id: string; name: string; kind: string; members: Person[]; last_message?: Message; unread: number; read_seq: number };
export type Call = { id: string; conversation_id: string; started_by: string; mode: 'audio' | 'video'; status: string; created_at: number };
export type Signal = { type: string; call_id: string; from: string; data: { kind: 'offer' | 'answer' | 'ice'; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } };

export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'), credentials: 'same-origin',
    headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const value = await response.json().catch(() => ({ error: 'Máy chủ chưa sẵn sàng. Vui lòng thử lại.' }));
  if (!response.ok) throw new Error(value.error || `Không thể thực hiện yêu cầu (${response.status}).`);
  return value as T;
}
const demoPeople: Person[] = [
  { id: 'me', username: 'ban', name: 'Minh Anh', online: true },
  { id: 'linh', username: 'linh.nguyen', name: 'Linh Nguyễn', online: true },
  { id: 'nam', username: 'nam.tran', name: 'Nam Trần', online: true },
  { id: 'ha', username: 'ha.le', name: 'Hà Lê', online: false },
  { id: 'tuan', username: 'tuan.pham', name: 'Tuấn Phạm', online: false }
];
function seed() {
  const time = new Date(); time.setHours(9, 15, 0, 0); const t = time.getTime() / 1000;
  let seq = 0;
  const msg = (cid: string, sender: string, body: string, minute: number): Message => ({ id: `demo-${++seq}`, seq, conversation_id: cid, sender_id: sender, client_message_id: `demo-${seq}`, body, created_at: t + minute * 60 });
  const messages: Record<string, Message[]> = {
    'nha-may': [msg('nha-may', 'linh', 'Chào buổi sáng cả nhà ☀️\nCuối tuần này mình đi đâu đó cùng nhau nhé?', 0), msg('nha-may', 'nam', 'Hay là một buổi cà phê thật chậm? Mình biết một chỗ có khu vườn rất xinh 🌿', 2), msg('nha-may', 'me', 'Nghe thích quá! Lâu rồi cả nhóm chưa có dịp ngồi cùng nhau.', 4), msg('nha-may', 'ha', 'Cho mình một vé nha. Chiều thứ bảy mọi người có rảnh không?', 6), msg('nha-may', 'me', 'Mình rảnh nhé. 3 giờ chiều được không? ☕', 7), msg('nha-may', 'linh', 'Chốt luôn! Để mình gửi địa chỉ cho cả nhà nhé 💚', 8)],
    linh: [msg('linh', 'linh', 'Một ngày nhẹ nhàng nhé! 🌷', 12)],
    nam: [msg('nam', 'me', 'Hẹn cuối tuần gặp nhau nha!', 5)],
    'du-an': [msg('du-an', 'tuan', 'Mọi thứ đã sẵn sàng cho tuần mới ✨', -30)],
    ha: [msg('ha', 'ha', 'Cảm ơn bạn nhiều nha 💛', -50)]
  };
  const conv = (id: string, name: string, members: Person[], unread = 0): Conversation => ({ id, name, kind: members.length > 2 ? 'group' : 'direct', members, last_message: messages[id].at(-1), unread, read_seq: 0 });
  return { messages, conversations: [conv('nha-may', 'Nhà Mây', demoPeople, 2), conv('linh', '', demoPeople.slice(0, 2), 1), conv('nam', '', [demoPeople[0], demoPeople[2]]), conv('du-an', 'Góc sáng tạo', [demoPeople[0], demoPeople[1], demoPeople[4]]), conv('ha', '', [demoPeople[0], demoPeople[3]])] };
}
class Chat {
  me = $state<Person | null>(null);
  demo = $state(false);
  ready = $state(false);
  authRequired = $state(false);
  backend = $state(false);
  conversations = $state<Conversation[]>([]);
  messages = $state<Record<string, Message[]>>({});
  selected = $state('');
  connection = $state('Đang kết nối');
  toast = $state('');
  incoming = $state<Call | null>(null);
  typing = $state<Record<string, number>>({});
  drafts = $state<Record<string, string>>({});
  uploadProgress = $state<number | null>(null);
  activeUpload?: XMLHttpRequest;
  onCallEvent?: (event: Signal & { user_id?: string }) => void;
  socket?: WebSocket;
  stopped = false;
  retryTimer?: ReturnType<typeof setTimeout>;
  outboxTimer?: ReturnType<typeof setTimeout>;
  toastTimer?: ReturnType<typeof setTimeout>;
  retries = 0;
  sending = new Set<string>();
  outbox: Message[] = [];
  async init() {
    this.stopped = false;
    try { const health = await api<{ service?: string }>('/health'); this.backend = health.service === 'may-rust'; } catch { this.backend = false; }
    if (this.backend) { try { this.me = await api<Person>('/me'); await this.activate(); } catch { this.authRequired = true; } }
    else this.startDemo();
    this.ready = true;
  }
  startDemo() {
    this.demo = true; this.me = demoPeople[0]; this.authRequired = false;
    const data = seed(); this.conversations = data.conversations; this.messages = data.messages;
    try { const stored = JSON.parse(localStorage.getItem('may-demo-v1') || 'null'); if (stored?.conversations && stored?.messages) { this.conversations = stored.conversations; this.messages = stored.messages; } } catch { /* Local storage may be disabled. */ }
    this.selected = this.conversations[0]?.id || ''; this.connection = 'Bản trải nghiệm';
  }
  saveDemo() {
    try { localStorage.setItem('may-demo-v1', JSON.stringify({ conversations: this.conversations, messages: Object.fromEntries(Object.entries(this.messages).map(([id, ms]) => [id, ms.filter(m => !m.demo_url).slice(-100)])) })); } catch { /* Chat still works in memory. */ }
  }
  notify(message: string) { this.toast = message; clearTimeout(this.toastTimer); this.toastTimer = setTimeout(() => this.toast = '', 5500); }
  title(c: Conversation) { return c.kind === 'group' ? c.name : c.members.find(x => x.id !== this.me?.id)?.name || 'Cuộc trò chuyện'; }
  async authenticate(register: boolean, username: string, password: string, name: string) {
    this.me = await api<Person>(`/auth/${register ? 'register' : 'login'}`, { username, password, name });
    this.demo = false; this.authRequired = false; this.conversations = []; this.messages = {}; this.selected = '';
    await this.activate();
  }
  async activate() {
    this.stopped = false;
    try { this.outbox = JSON.parse(localStorage.getItem(`may-outbox-${this.me?.id}`) || '[]').slice(0, 50); } catch { this.outbox = []; }
    await this.refresh();
    this.connect();
  }
  async refresh() {
    const data = await api<Conversation[]>('/conversations');
    this.conversations = data;
    if (this.selected && !data.some(c => c.id === this.selected)) this.selected = '';
  }
  connect() {
    if (this.stopped || this.demo) return;
    this.socket?.close();
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/ws`);
    this.socket = socket; this.connection = 'Đang kết nối';
    socket.onopen = async () => {
      if (this.socket !== socket) return;
      this.connection = 'Đã kết nối'; this.retries = 0;
      try {
        await this.refresh();
        if (this.selected) await this.sync(this.selected);
        const calls = await api<Call[]>('/calls'); this.incoming = calls.find(c => c.started_by !== this.me?.id) || null;
        for (const m of this.outbox) { this.merge(m); void this.deliver(m); }
      } catch (e) { this.notify((e as Error).message); }
    };
    socket.onmessage = event => {
      let e; try { e = JSON.parse(event.data); } catch { return; }
      if (e.type === 'ping') this.signal({ type: 'pong' });
      if (e.type === 'message.new' || e.type === 'message.ack') {
        const m = e.message as Message; const c = this.conversations.find(c => c.id === m.conversation_id);
        const existed = this.messages[m.conversation_id]?.some(x => x.id === m.id);
        this.merge(m); this.outbox = this.outbox.filter(x => x.client_message_id !== m.client_message_id); this.saveOutbox();
        if (!existed && m.sender_id !== this.me?.id && e.type === 'message.new') {
          sounds.received(m.id);
          this.desktopNotice(c ? this.title(c) : 'Mây', 'Bạn có tin nhắn mới.');
        }
        if (m.sender_id === this.me?.id && this.sending.has(m.client_message_id)) sounds.sent(m.id);
        if (c) { c.last_message = m; if (!existed && this.selected !== c.id && m.sender_id !== this.me?.id) c.unread++; this.conversations = [c, ...this.conversations.filter(x => x.id !== c.id)]; }
        else void this.refresh().catch(() => {});
        if (this.selected === m.conversation_id && document.visibilityState === 'visible') void this.markRead(m.conversation_id);
      }
      if (e.type === 'conversation.new') void this.refresh().catch(() => {});
      if (e.type === 'presence') for (const c of this.conversations) for (const p of c.members) if (p.id === e.user_id) p.online = e.online;
      if (e.type === 'typing') this.typing[e.conversation_id] = Date.now() + 3500;
      if (e.type === 'message.read') { const c = this.conversations.find(c => c.id === e.conversation_id); if (c && e.user_id === this.me?.id) c.unread = 0; }
      if (e.type === 'call.invite' && e.call.started_by !== this.me?.id) { this.incoming = e.call; this.desktopNotice('Có cuộc gọi đến', 'Mở Mây để nhận cuộc gọi.'); }
      if (e.type === 'call.ended' && this.incoming?.id === e.call_id) this.incoming = null;
      if (e.type === 'call.peer_left' && e.user_id === this.me?.id && this.incoming?.id === e.call_id) this.incoming = null;
      if (e.type.startsWith('call.')) this.onCallEvent?.(e);
      if (e.type === 'error') this.notify(e.error);
    };
    socket.onclose = () => {
      if (this.stopped || this.socket !== socket) return;
      this.connection = 'Đang kết nối lại';
      this.onCallEvent?.({ type: 'call.disconnected', call_id: '', from: '', data: { kind: 'ice' } });
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(async () => {
        try { await api('/me'); this.connect(); } catch (e) {
          if ((e as Error).message.includes('đăng nhập')) { this.authRequired = true; this.stopped = true; return; }
          this.connect();
        }
      }, Math.min(30000, 1000 * 2 ** this.retries++) + Math.random() * 400);
    };
    socket.onerror = () => socket.close();
  }
  desktopNotice(title: string, body: string) { if (document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted') { try { const n = new Notification(title, { body, icon: '/favicon.svg', tag: 'may-chat' }); n.onclick = () => { window.focus(); n.close(); }; } catch { /* Some mobile browsers require service-worker notifications. */ } } }
  signal(data: unknown) { if (this.socket?.readyState === WebSocket.OPEN) { this.socket.send(JSON.stringify(data)); return true; } return false; }
  merge(m: Message) {
    const current = this.messages[m.conversation_id] || [];
    this.messages[m.conversation_id] = [...current.filter(x => x.id !== m.id && x.client_message_id !== m.client_message_id), m].sort((a, b) => (a.status ? Number.MAX_SAFE_INTEGER : a.seq) - (b.status ? Number.MAX_SAFE_INTEGER : b.seq)).slice(-500);
  }
  async select(id: string) {
    this.selected = id;
    if (!this.demo) { try { await this.sync(id); } catch (e) { this.notify((e as Error).message); } }
    await this.markRead(id);
  }
  async sync(id: string) {
    const existing = this.messages[id]?.filter(m => !m.status) || [];
    let after = existing.at(-1)?.seq;
    do {
      const page = await api<Message[]>(`/conversations/${id}/messages${after === undefined ? '' : `?after=${after}`}`);
      for (const m of page) this.merge(m);
      if (page.length < 50 || after === undefined) break;
      after = page.at(-1)!.seq;
    } while (!this.stopped);
  }
  async older(id: string): Promise<boolean> {
    if (this.demo) return false;
    if ((this.messages[id]?.length || 0) >= 500) return false;
    const before = this.messages[id]?.find(m => !m.status)?.seq;
    const page = await api<Message[]>(`/conversations/${id}/messages?before=${before || 9223372036854775807n}`);
    for (const m of page) this.merge(m); return page.length === 50;
  }
  async markRead(id: string) {
    const c = this.conversations.find(c => c.id === id); if (c) c.unread = 0;
    if (this.demo) { this.saveDemo(); return; }
    const seq = this.messages[id]?.filter(m => !m.status).at(-1)?.seq;
    if (seq) await api(`/conversations/${id}/read`, { seq }).catch(() => {});
  }
  async send(body: string, file?: File) {
    const id = this.selected; if ((!body.trim() && !file) || !id || !this.me) return;
    if (new TextEncoder().encode(body).length > 4000) throw new Error('Tin nhắn tối đa 4.000 byte. Hãy chia nhỏ nội dung.');
    if (file && file.size >= MAX_FILE_BYTES) throw new Error(FILE_SIZE_ERROR);
    if (file && file.size === 0) throw new Error('Không thể gửi tệp rỗng.');
    if (this.outbox.length >= 50) throw new Error('Hàng đợi đã đầy. Hãy kết nối lại và gửi các tin đang chờ.');
    let attachment: Partial<Message> = {};
    if (file) {
      if (this.demo) attachment = { attachment_id: crypto.randomUUID(), attachment_name: file.name, attachment_mime: file.type, attachment_size: file.size, demo_url: URL.createObjectURL(file) };
      else { const a = await this.upload(id, file); attachment = { attachment_id: a.id, attachment_name: a.name, attachment_mime: a.mime, attachment_size: a.size }; }
    }
    const m: Message = { id: crypto.randomUUID(), seq: Date.now(), client_message_id: crypto.randomUUID(), conversation_id: id, sender_id: this.me.id, body, created_at: Math.floor(Date.now() / 1000), ...attachment, status: this.demo ? undefined : 'pending' };
    this.merge(m); this.drafts[id] = '';
    const c = this.conversations.find(c => c.id === id); if (c) c.last_message = m;
    if (this.demo) { this.saveDemo(); sounds.sent(m.id); return; }
    this.outbox.push(m); this.saveOutbox(); await this.deliver(m);
  }
  async upload(conversationId: string, file: File): Promise<{ id: string; name: string; mime: string; size: number }> {
    this.uploadProgress = 0;
    const request = new XMLHttpRequest(); this.activeUpload = request;
    try {
      return await new Promise((resolve, reject) => {
        request.open('POST', `/api/conversations/${conversationId}/attachments`);
        request.withCredentials = true; request.timeout = 600000;
        request.upload.onprogress = event => { if (event.lengthComputable) this.uploadProgress = Math.min(99, Math.round(event.loaded / event.total * 100)); };
        request.onload = () => {
          let value; try { value = JSON.parse(request.responseText); } catch { reject(new Error('Máy chủ không trả về kết quả tải lên hợp lệ.')); return; }
          if (request.status >= 200 && request.status < 300) { this.uploadProgress = 100; resolve(value); }
          else reject(new Error(value.error || 'Không thể tải tệp lên. Hãy thử lại.'));
        };
        request.onerror = () => reject(new Error('Không thể tải tệp. Kiểm tra kết nối mạng và thử lại.'));
        request.ontimeout = () => reject(new Error('Tải tệp quá 10 phút. Hãy kiểm tra tốc độ mạng rồi thử lại.'));
        request.onabort = () => reject(new Error('Đã hủy tải tệp.'));
        const form = new FormData(); form.append('file', file); request.send(form);
      });
    } finally { if (this.activeUpload === request) { this.activeUpload = undefined; this.uploadProgress = null; } }
  }
  cancelUpload() { this.activeUpload?.abort(); }
  saveOutbox() { try { localStorage.setItem(`may-outbox-${this.me?.id}`, JSON.stringify(this.outbox)); } catch { /* Storage can be unavailable. */ } }
  async deliver(m: Message) {
    if (this.sending.has(m.client_message_id)) return;
    this.sending.add(m.client_message_id);
    try {
      const saved = await api<Message>(`/conversations/${m.conversation_id}/messages`, { body: m.body, client_message_id: m.client_message_id, attachment_id: m.attachment_id });
      sounds.sent(saved.id);
      this.merge(saved); this.outbox = this.outbox.filter(x => x.client_message_id !== m.client_message_id); this.saveOutbox();
    } catch (e) {
      const current = this.messages[m.conversation_id]?.find(x => x.client_message_id === m.client_message_id);
      if (current?.status) current.status = 'failed';
      this.notify((e as Error).message);
      if (!navigator.onLine || /fetch|network|timed out|timeout/i.test((e as Error).message)) {
        clearTimeout(this.outboxTimer);
        this.outboxTimer = setTimeout(() => { if (!this.stopped) for (const pending of this.outbox) void this.deliver(pending); }, 5000);
      }
    }
    finally { this.sending.delete(m.client_message_id); }
  }
  async people(q: string) { return this.demo ? demoPeople.filter(p => p.id !== 'me' && `${p.name} ${p.username}`.toLocaleLowerCase('vi').includes(q.toLocaleLowerCase('vi'))) : api<Person[]>(`/users?q=${encodeURIComponent(q)}`); }
  async create(people: Person[], name: string, group: boolean) {
    if (!people.length) throw new Error('Hãy chọn người để trò chuyện.');
    if (this.demo) {
      const existing = group ? undefined : this.conversations.find(c => c.kind === 'direct' && c.members.some(p => p.id === people[0].id));
      const id = existing?.id || crypto.randomUUID();
      if (!existing) { this.conversations.unshift({ id, name, kind: group ? 'group' : 'direct', members: [this.me!, ...people], unread: 0, read_seq: 0 }); this.messages[id] = []; this.saveDemo(); }
      await this.select(id); return;
    }
    const result = await api<{ id: string }>('/conversations', { members: people.map(p => p.id), name, kind: group ? 'group' : 'direct' }); await this.refresh(); await this.select(result.id);
  }
  async logout() {
    if (!this.demo) await api('/auth/logout', {});
    this.destroy(); this.me = null; this.messages = {}; this.conversations = []; this.selected = ''; this.incoming = null; this.authRequired = true; this.demo = false;
  }
  destroy() { this.stopped = true; clearTimeout(this.retryTimer); clearTimeout(this.outboxTimer); this.socket?.close(); this.cancelUpload(); sounds.stopRinging(); }
}
export const chat = new Chat();
