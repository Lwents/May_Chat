import { api, chat, type Call, type Signal } from './chat.svelte';
export type Remote = { id: string; stream: MediaStream; connected: boolean };
class Calling {
  call = $state<Call | null>(null);
  local = $state<MediaStream | null>(null);
  remotes = $state<Remote[]>([]);
  status = $state('');
  muted = $state(false);
  cameraOff = $state(false);
  sharing = $state(false);
  busy = $state(false);
  started = $state(0);
  peers = new Map<string, RTCPeerConnection>();
  candidates = new Map<string, RTCIceCandidateInit[]>();
  ice: RTCIceServer[] = [];
  display?: MediaStream;
  camera?: MediaStreamTrack;
  eventQueue: Promise<void> = Promise.resolve();
  timer?: ReturnType<typeof setTimeout>;
  prepareEvents() { chat.onCallEvent = e => { this.eventQueue = this.eventQueue.then(() => this.event(e)).catch(error => chat.notify((error as Error).message)); }; }
  async media(mode: string) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera và micro cần HTTPS hoặc localhost.');
    try { this.local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: mode === 'video' ? { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 20, max: 24 }, facingMode: 'user' } : false }); }
    catch { throw new Error('Chưa truy cập được camera/micro. Hãy cấp quyền trong trình duyệt rồi thử lại.'); }
    this.camera = this.local.getVideoTracks()[0]; this.cameraOff = mode !== 'video'; this.muted = false;
    if (!chat.demo) this.ice = (await api<{ iceServers: RTCIceServer[] }>('/ice')).iceServers;
  }
  async start(mode: 'audio' | 'video') {
    if (this.busy || this.call || !chat.selected) return;
    if (!chat.demo && chat.connection !== 'Đã kết nối') { chat.notify('Hãy đợi kết nối realtime được khôi phục rồi gọi lại.'); return; }
    this.busy = true;
    try {
      await this.media(mode);
      this.call = chat.demo ? { id: 'demo', conversation_id: chat.selected, started_by: chat.me!.id, mode, status: 'preview', created_at: Date.now() / 1000 } : await api<Call>('/calls', { conversation_id: chat.selected, mode });
      this.status = chat.demo ? 'Xem thử camera · Chưa kết nối người khác' : 'Đang đổ chuông…';
      if (!chat.demo) this.timer = setTimeout(() => { if (!this.remotes.some(r => r.connected)) { chat.notify('Chưa có người trả lời.'); void this.end(); } }, 90000);
    } catch (e) { this.reset(); chat.notify((e as Error).message); } finally { this.busy = false; }
  }
  async accept() {
    const incoming = chat.incoming; if (!incoming || this.busy) return;
    if (this.call) { chat.notify('Hãy kết thúc cuộc gọi hiện tại trước.'); return; }
    this.busy = true;
    try {
      await this.media(incoming.mode); this.call = incoming; chat.incoming = null; this.status = 'Đang kết nối…';
      const result = await api<{ peers: string[] }>(`/calls/${incoming.id}/join`, {});
      for (const id of result.peers) {
        const peer = this.peer(id); await peer.setLocalDescription(await peer.createOffer()); this.send(id, { kind: 'offer', sdp: peer.localDescription!.toJSON() });
      }
      this.timer = setTimeout(() => { if (!this.remotes.some(r => r.connected)) { chat.notify('Không thể kết nối media. Hãy kiểm tra TURN hoặc mạng.'); void this.end(); } }, 45000);
    } catch (e) { if (this.call) await api(`/calls/${this.call.id}/leave`, {}).catch(() => {}); this.reset(); chat.notify((e as Error).message); } finally { this.busy = false; }
  }
  async reject() { if (!chat.incoming || this.busy) return; this.busy = true; try { await api(`/calls/${chat.incoming.id}/leave`, {}); chat.incoming = null; } catch (e) { chat.notify((e as Error).message); } finally { this.busy = false; } }
  peer(id: string) {
    const existing = this.peers.get(id); if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: this.ice }); this.peers.set(id, pc);
    for (const track of this.local?.getTracks() || []) pc.addTrack(track.kind === 'video' ? this.display?.getVideoTracks()[0] || track : track, this.local!);
    pc.onicecandidate = e => { if (e.candidate) this.send(id, { kind: 'ice', candidate: e.candidate.toJSON() }); };
    pc.ontrack = e => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      const existing = this.remotes.find(r => r.id === id); if (existing) existing.stream = stream; else this.remotes.push({ id, stream, connected: false });
    };
    pc.onconnectionstatechange = () => {
      const remote = this.remotes.find(r => r.id === id);
      if (pc.connectionState === 'connected') { if (remote) remote.connected = true; this.status = 'Đã kết nối'; for (const sender of pc.getSenders()) { if (sender.track?.kind === 'video') { const parameters = sender.getParameters(); if (parameters.encodings?.length) { parameters.encodings[0].maxBitrate = 500000; parameters.encodings[0].maxFramerate = 20; void sender.setParameters(parameters).catch(() => {}); } } } if (!this.started) this.started = Date.now(); clearTimeout(this.timer); }
      if (pc.connectionState === 'failed') { chat.notify('Kết nối media thất bại. Hãy kiểm tra TURN và thử gọi lại.'); this.removePeer(id); if (!this.peers.size) void this.end(); }
      if (pc.connectionState === 'disconnected') { if (remote) remote.connected = false; this.status = 'Kết nối media bị gián đoạn'; }
    };
    return pc;
  }
  send(to: string, data: Signal['data']) { if (this.call && !chat.signal({ type: 'call.signal', call_id: this.call.id, to, data })) throw new Error('Đã mất kết nối signaling. Hãy kết thúc rồi gọi lại khi mạng ổn định.'); }
  async event(e: Signal & { user_id?: string }) {
    if (e.type === 'call.disconnected') { if (this.call) { this.reset(); chat.notify('Cuộc gọi dừng do mất kết nối. Bạn có thể gọi lại khi có mạng.'); } return; }
    if (!this.call || e.call_id !== this.call.id) return;
    if (e.type === 'call.ended') { this.reset(); chat.notify('Cuộc gọi đã kết thúc.'); return; }
    if (e.type === 'call.peer_left') { if (e.user_id) this.removePeer(e.user_id); return; }
    if (e.type === 'call.peer_joined') { this.status = 'Đang kết nối…'; return; }
    if (e.type !== 'call.signal') return;
    const pc = this.peer(e.from); const data = e.data;
    if (data.kind === 'ice') { if (!data.candidate) return; if (pc.remoteDescription) await pc.addIceCandidate(data.candidate); else this.candidates.set(e.from, [...(this.candidates.get(e.from) || []), data.candidate]); return; }
    if (!data.sdp) return;
    await pc.setRemoteDescription(data.sdp);
    for (const candidate of this.candidates.get(e.from) || []) await pc.addIceCandidate(candidate); this.candidates.delete(e.from);
    if (data.kind === 'offer') { await pc.setLocalDescription(await pc.createAnswer()); this.send(e.from, { kind: 'answer', sdp: pc.localDescription!.toJSON() }); }
  }
  removePeer(id: string) { this.peers.get(id)?.close(); this.peers.delete(id); this.candidates.delete(id); this.remotes = this.remotes.filter(r => r.id !== id); }
  toggleMic() { this.muted = !this.muted; for (const track of this.local?.getAudioTracks() || []) track.enabled = !this.muted; }
  toggleCamera() { if (!this.camera) return; this.cameraOff = !this.cameraOff; this.camera.enabled = !this.cameraOff; }
  async share() {
    if (this.sharing) { await this.stopSharing(); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { chat.notify('Trình duyệt này chưa hỗ trợ chia sẻ màn hình.'); return; }
    if (!this.camera) { chat.notify('Hãy dùng cuộc gọi video để chia sẻ màn hình.'); return; }
    try {
      this.display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }); const track = this.display.getVideoTracks()[0];
      for (const pc of this.peers.values()) await pc.getSenders().find(s => s.track?.kind === 'video')?.replaceTrack(track);
      this.sharing = true; track.onended = () => void this.stopSharing();
    } catch (e) { if ((e as Error).name !== 'NotAllowedError') chat.notify('Không thể chia sẻ màn hình trên thiết bị này.'); }
  }
  async stopSharing() { for (const pc of this.peers.values()) await pc.getSenders().find(s => s.track?.kind === 'video')?.replaceTrack(this.camera || null); this.display?.getTracks().forEach(t => t.stop()); this.display = undefined; this.sharing = false; }
  async end() { const call = this.call; this.reset(); if (call && !chat.demo) { try { await api(`/calls/${call.id}/leave`, {}); } catch { chat.notify('Đã dừng camera/micro. Máy chủ chưa nhận được thông báo kết thúc cuộc gọi.'); } } }
  reset() { clearTimeout(this.timer); for (const pc of this.peers.values()) pc.close(); this.peers.clear(); this.candidates.clear(); this.local?.getTracks().forEach(t => t.stop()); this.display?.getTracks().forEach(t => t.stop()); this.local = null; this.call = null; this.remotes = []; this.started = 0; this.display = undefined; this.camera = undefined; this.sharing = false; }
}
export const calling = new Calling();
