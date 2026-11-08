<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { Cloud, MessageCircle, Phone, Users, Settings, Search, Plus, ChevronDown, ChevronRight, ArrowLeft, X, Video, Info, Send, Smile, Paperclip, Check, CheckCheck, MoreHorizontal, ArrowUpRight, Leaf, Link, Copy, LogOut, Sun, Moon, Monitor, Mic, MicOff, VideoOff, PhoneOff, ScreenShare, Download, FileText, Wifi, WifiOff, RefreshCw, Bell, Hash, LockKeyhole, Heart, ArrowRight } from 'lucide-svelte';
  import { chat, api, type Person, type Conversation, type Message, type Call } from '$lib/chat.svelte';
  import { calling } from '$lib/call.svelte';
  import { sounds } from '$lib/sounds.svelte';
  import { MAX_FILE_BYTES, FILE_SIZE_ERROR } from '$lib/limits';
  import { Volume2, VolumeX } from 'lucide-svelte';
  import Avatar from '$lib/Avatar.svelte';
  import Media from '$lib/Media.svelte';

  let nav = $state('chats');
  let query = $state('');
  let filter = $state('all');
  let details = $state(false);
  let modal = $state('');
  let dialog = $state<HTMLDialogElement>(null!);
  let draft = $state('');
  let attachment = $state<File | undefined>();
  let fileInput = $state<HTMLInputElement>(null!);
  let composer = $state<HTMLTextAreaElement>(null!);
  let scrollArea = $state<HTMLDivElement>(null!);
  let sending = $state(false);
  let loadingHistory = $state(false);
  let noOlder = $state<Record<string, boolean>>({});
  let showEmoji = $state(false);
  let inSearch = $state(false);
  let messageQuery = $state('');
  let newQuery = $state('');
  let people = $state<Person[]>([]);
  let chosen = $state<Person[]>([]);
  let group = $state(false);
  let groupName = $state('');
  let creating = $state(false);
  let modalError = $state('');
  let theme = $state('light');
  let enterSend = $state(true);
  let register = $state(false);
  let username = $state('');
  let password = $state('');
  let displayName = $state('');
  let authBusy = $state(false);
  let authError = $state('');
  let now = $state(Date.now());
  let history = $state<(Call & { ended_at?: number })[]>([]);
  let contacts = $state<Person[]>([]);
  let searchVersion = 0;
  let lastTyping = 0;
  let stickToBottom = true;
  let lastConversation = '';
  let lastCount = 0;
  const emojis = ['💚', '😊', '✨', '👍', '☕', '🌿', '❤️', '🎉', '🥰', '🙌', '😂', '👋'];
  const normalized = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
  const time = (n: number) => new Date(n * 1000).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const date = (n: number) => { const d = new Date(n * 1000); return d.toDateString() === new Date().toDateString() ? 'Hôm nay' : d.toLocaleDateString('vi-VN', { day: 'numeric', month: 'long', year: 'numeric' }); };
  let selected = $derived(chat.conversations.find(c => c.id === chat.selected));
  let messages = $derived((chat.messages[chat.selected] || []).filter(m => !messageQuery || normalized(m.body).includes(normalized(messageQuery))));
  let filtered = $derived(chat.conversations.filter(c => (!query || normalized(chat.title(c)).includes(normalized(query))) && (filter !== 'unread' || c.unread > 0) && (filter !== 'group' || c.kind === 'group')));
  let totalUnread = $derived(chat.conversations.reduce((n, c) => n + c.unread, 0));
  let onlineCount = $derived(selected?.members.filter(p => p.online).length || 0);
  let files = $derived((chat.messages[chat.selected] || []).filter(m => m.attachment_id));
  let callConversation = $derived(chat.conversations.find(c => c.id === calling.call?.conversation_id));
  let callDuration = $derived(calling.started ? `${Math.floor((now - calling.started) / 60000).toString().padStart(2, '0')}:${Math.floor((now - calling.started) / 1000 % 60).toString().padStart(2, '0')}` : '');

  onMount(() => {
    sounds.init();
    try { theme = localStorage.getItem('may-theme') || 'light'; enterSend = localStorage.getItem('may-enter-send') !== 'false'; } catch { /* Preferences are optional. */ }
    void chat.init().then(async () => { await tick(); await document.fonts.ready; if (scrollArea && stickToBottom) scrollArea.scrollTop = scrollArea.scrollHeight; }); calling.prepareEvents();
    const clock = setInterval(() => now = Date.now(), 1000);
    const visible = () => { if (document.visibilityState === 'visible' && chat.selected) { if (!chat.demo) void chat.sync(chat.selected).then(() => chat.markRead(chat.selected)).catch(() => {}); else void chat.markRead(chat.selected); } };
    const resize = () => { document.documentElement.style.setProperty('--app-height', `${window.visualViewport?.height || window.innerHeight}px`); if (stickToBottom) void tick().then(() => { if (scrollArea) scrollArea.scrollTop = scrollArea.scrollHeight; }); };
    const shortcut = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); document.querySelector<HTMLInputElement>('.sidebar .search-input input')?.focus(); } };
    window.addEventListener('keydown', shortcut); resize(); window.visualViewport?.addEventListener('resize', resize); document.addEventListener('visibilitychange', visible);
    return () => { clearInterval(clock); window.removeEventListener('keydown', shortcut); window.visualViewport?.removeEventListener('resize', resize); document.removeEventListener('visibilitychange', visible); chat.destroy(); calling.reset(); sounds.destroy(); };
  });
  $effect(() => {
    const incoming = chat.incoming;
    const current = calling.call;
    const authenticated = !chat.authRequired && !chat.demo && chat.connection === 'Đã kết nối';
    const busy = calling.busy;
    const outgoing = current && !calling.started && calling.status === 'Đang đổ chuông…';
    untrack(() => {
      if (authenticated && incoming && !current && !busy) sounds.startRinging(incoming.id, 'incoming', incoming.created_at * 1000 + 90000);
      else if (authenticated && outgoing) sounds.startRinging(current!.id, 'outgoing', current!.created_at * 1000 + 90000);
      else sounds.stopRinging();
    });
  });
  $effect(() => { if (typeof document !== 'undefined') { document.documentElement.dataset.theme = theme; try { localStorage.setItem('may-theme', theme); } catch {} } });
  $effect(() => { if (!dialog) return; if (modal && !dialog.open) dialog.showModal(); else if (!modal && dialog.open) dialog.close(); });
  $effect(() => {
    const id = chat.selected; const count = chat.messages[id]?.length || 0;
    if (id !== lastConversation) { draft = chat.drafts[id] || ''; attachment = undefined; messageQuery = ''; inSearch = false; lastConversation = id; stickToBottom = true; showEmoji = false; }
    if (id && (count !== lastCount || stickToBottom)) { lastCount = count; if (stickToBottom) void tick().then(() => { if (scrollArea) scrollArea.scrollTop = scrollArea.scrollHeight; }); }
  });
  $effect(() => {
    const q = newQuery; const version = ++searchVersion;
    if (modal !== 'new') return;
    const timer = setTimeout(async () => { try { const result = await chat.people(q); if (version === searchVersion) people = result; } catch (e) { modalError = (e as Error).message; } }, 250);
    return () => clearTimeout(timer);
  });
  async function select(c: Conversation) { nav = 'chats'; details = false; stickToBottom = true; await chat.select(c.id); }
  async function send() {
    if (sending || (!draft.trim() && !attachment)) return;
    const conversationId = chat.selected;
    sending = true; stickToBottom = true; showEmoji = false;
    try { await chat.send(draft.trim(), attachment); if (chat.selected === conversationId) { draft = ''; attachment = undefined; showEmoji = false; if (composer) composer.style.height = 'auto'; } }
    catch (e) { chat.notify((e as Error).message); }
    finally { sending = false; if (matchMedia('(pointer:fine)').matches) composer?.focus(); }
  }
  function typing() {
    chat.drafts[chat.selected] = draft;
    if (composer) { composer.style.height = 'auto'; composer.style.height = `${Math.min(composer.scrollHeight, 120)}px`; }
    if (!chat.demo && Date.now() - lastTyping > 3000) { lastTyping = Date.now(); chat.signal({ type: 'typing', conversation_id: chat.selected }); }
  }
  function openNew(asGroup = false) { group = asGroup; chosen = []; newQuery = ''; groupName = ''; people = []; modalError = ''; modal = 'new'; }
  async function create() {
    creating = true; modalError = '';
    try { await chat.create(chosen, groupName.trim(), group); modal = ''; nav = 'chats'; }
    catch (e) { modalError = (e as Error).message; } finally { creating = false; }
  }
  async function authenticate() {
    authBusy = true; authError = '';
    try { await chat.authenticate(register, username, password, displayName); password = ''; }
    catch (e) { authError = (e as Error).message; } finally { authBusy = false; }
  }
  async function changeNav(to: string) {
    nav = to; query = ''; chat.selected = ''; details = false;
    if (to === 'calls' && !chat.demo) { try { history = await api('/calls/history'); } catch (e) { chat.notify((e as Error).message); } }
    if (to === 'contacts') contacts = chat.demo ? await chat.people('') : [];
  }
  async function searchContacts() { try { contacts = await chat.people(query); } catch (e) { chat.notify((e as Error).message); } }
  async function startContact(p: Person) { try { await chat.create([p], '', false); nav = 'chats'; } catch (e) { chat.notify((e as Error).message); } }
  async function older() {
    if (!selected || loadingHistory) return; const id = selected.id; loadingHistory = true; stickToBottom = false; const height = scrollArea.scrollHeight;
    try { noOlder[id] = !await chat.older(id); await tick(); scrollArea.scrollTop = scrollArea.scrollHeight - height; } catch (e) { chat.notify((e as Error).message); } finally { loadingHistory = false; }
  }
  async function copyInvite() { try { await navigator.clipboard.writeText(location.origin); chat.notify('Đã sao chép liên kết. Gửi cho bạn bè để cùng tham gia nhé!'); } catch { chat.notify(`Liên kết của bạn: ${location.origin}`); } }
  async function notifications() { if (!('Notification' in window)) { chat.notify('Trình duyệt này chưa hỗ trợ thông báo web.'); return; } const result = await Notification.requestPermission(); chat.notify(result === 'granted' ? 'Đã cấp quyền thông báo khi ứng dụng đang mở.' : 'Chưa được cấp quyền. Bạn có thể đổi trong cài đặt trình duyệt.'); }
  async function enableAudio() {
    if (await sounds.unlock()) {
      if (!chat.incoming && !calling.call) await sounds.previewMessage();
      chat.notify('Âm thanh đã sẵn sàng. Bạn có thể chỉnh âm lượng trong Cài đặt.');
    } else chat.notify('Chưa bật được âm thanh. Hãy chạm lại nút và kiểm tra âm thanh của tab/trình duyệt.');
  }
  function person(id: string) { return selected?.members.find(p => p.id === id)?.name || 'Thành viên'; }
  function attachmentUrl(m: Message) { return m.demo_url || `/api/attachments/${m.attachment_id}`; }
  async function download(m: Message) {
    try {
      if (!m.demo_url) {
        const response = await fetch(attachmentUrl(m), { method: 'HEAD', signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('Không thể tải tệp. Vui lòng đăng nhập lại hoặc thử sau.');
      }
      const a = document.createElement('a'); a.href = attachmentUrl(m); a.download = m.attachment_name || 'tep-dinh-kem';
      document.body.append(a); a.click(); a.remove();
    } catch (e) { chat.notify((e as Error).message); }
  }
  async function logout() { try { await calling.end(); await chat.logout(); modal = ''; } catch (e) { chat.notify((e as Error).message); } }
</script>

<svelte:head>
  <title>Mây — Một chút gần nhau</title>
  <meta name="description" content="Một không gian nhẹ nhàng để nhắn tin, gọi video và ở gần những người bạn thương. Mây Chat — Rust & WebRTC." />
</svelte:head>

{#if !chat.ready}
  <div class="boot"><div class="brand-mark"><Cloud size={34} /></div><h1>Mây</h1><p>Một chút gần nhau.</p><span class="loading-dots">•••</span></div>
{:else if chat.authRequired}
  <div class="auth-page">
    <div class="auth-story"><a class="wordmark" href="/"><Cloud size={32} /> mây<span>CHAT</span></a><div class="auth-illustration"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><Cloud size={100} strokeWidth={1} /><span class="floating-heart"><Heart size={24} /></span><span class="floating-leaf"><Leaf size={28} /></span></div><h1>Xa một chút.<br />Gần nhau hơn.</h1><p>Một lời chào, một cuộc gọi.<br />Những kết nối nhỏ làm nên một ngày đẹp.</p><div class="auth-note"><Leaf size={16} /> Nhẹ nhàng. Riêng tư. Luôn bên bạn.</div></div>
    <form class="auth-form" onsubmit={e => { e.preventDefault(); void authenticate(); }}>
      <div class="mobile-brand"><Cloud size={30} /> mây</div><span class="eyebrow">CHÀO BẠN ĐẾN VỚI MÂY</span><h2>{register ? 'Bắt đầu kết nối' : 'Thật vui khi gặp lại bạn'}</h2><p>{register ? 'Tạo tài khoản để cùng nhau chia sẻ mỗi ngày.' : 'Đăng nhập và tiếp tục câu chuyện của bạn.'}</p>
      {#if register}<label>Tên hiển thị<input bind:value={displayName} autocomplete="name" placeholder="Bạn muốn được gọi là gì?" maxlength="60" required /></label>{/if}
      <label>Tên đăng nhập<input bind:value={username} autocomplete="username" placeholder="vd: minh_anh" minlength="3" maxlength="32" pattern="[A-Za-z0-9_]+" required /></label>
      <label>Mật khẩu<input bind:value={password} type="password" autocomplete={register ? 'new-password' : 'current-password'} placeholder="Ít nhất 8 ký tự" minlength="8" maxlength="128" required /></label>
      {#if authError}<p class="error" role="alert">{authError}</p>{/if}
      {#if !chat.backend}<p class="hint">Đây là bản xem giao diện. Đăng nhập thật khả dụng khi triển khai cùng backend Rust.</p>{/if}
      <button class="primary auth-submit" disabled={authBusy || !chat.backend}>{authBusy ? 'Đang xử lý…' : register ? 'Tạo tài khoản' : 'Đăng nhập'}<ArrowRight size={18} /></button>
      <p class="auth-switch">{register ? 'Bạn đã có tài khoản?' : 'Bạn mới đến Mây?'} <button type="button" class="text-button" onclick={() => { register = !register; authError = ''; }}>{register ? 'Đăng nhập' : 'Tạo tài khoản'}</button></p>
      <button type="button" class="secondary" onclick={() => chat.startDemo()}>Khám phá bản trải nghiệm <ArrowUpRight size={16} /></button>
      <small><LockKeyhole size={13} /> Mật khẩu được băm bằng Argon2id trên máy chủ.</small>
    </form>
  </div>
{:else}
  <div class:has-chat={!!chat.selected} class="app-shell">
    <nav class="rail" aria-label="Điều hướng chính">
      <button class="brand-mark" aria-label="Mây — Trò chuyện" onclick={() => changeNav('chats')}><Cloud size={31} strokeWidth={1.7} /></button>
      <div class="rail-links">
        <button class:active={nav === 'chats'} aria-label="Trò chuyện" title="Trò chuyện" onclick={() => changeNav('chats')}><MessageCircle size={23} strokeWidth={1.7} />{#if totalUnread}<i class="notification-dot"></i>{/if}<span>Trò chuyện</span></button>
        <button class:active={nav === 'calls'} aria-label="Cuộc gọi" title="Cuộc gọi" onclick={() => changeNav('calls')}><Phone size={22} strokeWidth={1.7} /><span>Cuộc gọi</span></button>
        <button class:active={nav === 'contacts'} aria-label="Danh bạ" title="Danh bạ" onclick={() => changeNav('contacts')}><Users size={23} strokeWidth={1.7} /><span>Danh bạ</span></button>
      </div>
      <div class="rail-bottom"><button aria-label="Cài đặt" title="Cài đặt" onclick={() => modal = 'settings'}><Settings size={22} strokeWidth={1.7} /><span>Cài đặt</span></button><button class="profile-button" aria-label="Tài khoản của bạn" onclick={() => modal = 'settings'}><Avatar name={chat.me?.name || 'Bạn'} size={37} online /></button></div>
    </nav>

    <aside class="sidebar">
      <div class="sidebar-heading"><div class="wordmark"><Cloud size={25} strokeWidth={1.6} /> mây<span>CHAT</span></div><button class="icon-button" aria-label="Tạo cuộc trò chuyện" title="Tạo cuộc trò chuyện" onclick={() => openNew()}><Plus size={21} /></button></div>
      <div class="sidebar-title"><h1>{nav === 'calls' ? 'Cuộc gọi' : nav === 'contacts' ? 'Danh bạ' : 'Tin nhắn'}</h1>{#if nav === 'chats'}<span class="count-pill">{chat.conversations.length}</span>{#if chat.demo}<button class="preview-tag mobile-demo" onclick={() => modal = 'about'}>BẢN TRẢI NGHIỆM</button>{/if}{:else}<span class="little-label">Cùng nhau kết nối</span>{/if}</div>
      <div class="search-input"><Search size={17} /><input aria-label={nav === 'contacts' ? 'Tìm người dùng' : 'Tìm cuộc trò chuyện'} bind:value={query} oninput={() => { if (nav === 'contacts') void searchContacts(); }} placeholder={nav === 'contacts' ? 'Nhập tên hoặc tên đăng nhập…' : 'Tìm kiếm cuộc trò chuyện…'} />{#if query}<button aria-label="Xóa tìm kiếm" onclick={() => { query = ''; if (nav === 'contacts') void searchContacts(); }}><X size={15} /></button>{:else}<kbd>⌘ K</kbd>{/if}</div>
      {#if sounds.supported}<button class="sound-enable-hint" aria-label={!sounds.ready && sounds.volume > 0 && (sounds.messagesEnabled || sounds.callsEnabled) ? 'Bật âm thanh thông báo' : 'Cài đặt âm báo'} data-enable-audio onclick={() => { if (!sounds.ready && sounds.volume > 0 && (sounds.messagesEnabled || sounds.callsEnabled)) void enableAudio(); else modal = 'settings'; }}>{#if sounds.volume === 0 || (!sounds.messagesEnabled && !sounds.callsEnabled)}<VolumeX size={16} /><span>Âm thông báo đang tắt</span>{:else}<Volume2 size={16} /><span>{sounds.ready ? 'Âm thanh đã sẵn sàng' : 'Chạm để bật chuông và âm báo'}</span>{/if}<ChevronRight size={14} /></button>{/if}
      {#if nav === 'chats'}
        <div class="filters" aria-label="Lọc tin nhắn"><button class:chosen={filter === 'all'} onclick={() => filter = 'all'}>Tất cả</button><button class:chosen={filter === 'unread'} onclick={() => filter = 'unread'}>Chưa đọc {#if totalUnread}<span>{totalUnread}</span>{/if}</button><button class:chosen={filter === 'group'} onclick={() => filter = 'group'}>Nhóm</button></div>
        <div class="section-label">CUỘC TRÒ CHUYỆN <button title="Tạo nhóm mới" aria-label="Tạo nhóm mới" onclick={() => openNew(true)}><Users size={15} /><Plus size={11} /></button></div>
        <div class="conversation-list">
          {#each filtered as c (c.id)}
            {@const title = chat.title(c)}
            <button class="conversation" class:current={c.id === chat.selected} onclick={() => select(c)}>
              <Avatar name={title} size={46} group={c.kind === 'group'} online={c.kind === 'direct' && c.members.some(p => p.id !== chat.me?.id && p.online)} />
              <div class="conversation-copy"><div class="conversation-line"><strong>{title}</strong><time>{c.last_message ? time(c.last_message.created_at) : ''}</time></div><div class="conversation-line"><p>{c.last_message?.sender_id === chat.me?.id ? 'Bạn: ' : ''}{c.last_message?.body || c.last_message?.attachment_name || 'Bắt đầu một câu chuyện mới'}</p>{#if c.unread}<span class="unread-badge">{c.unread}</span>{:else if c.last_message?.sender_id === chat.me?.id}<CheckCheck size={16} class="read-check" />{/if}</div></div>
            </button>
          {:else}<div class="list-empty"><MessageCircle size={28} /><p>{query ? 'Chưa tìm thấy cuộc trò chuyện.' : filter === 'unread' ? 'Bạn đã đọc hết tin nhắn rồi.' : 'Một lời chào mở đầu mọi kết nối.'}</p><button class="text-button" onclick={() => openNew()}>Trò chuyện mới <Plus size={14} /></button></div>{/each}
        </div>
      {:else if nav === 'contacts'}
        <div class="section-label">{chat.demo ? 'BẠN BÈ TRONG BẢN TRẢI NGHIỆM' : 'TÌM BẠN BẰNG TÊN ĐĂNG NHẬP'}</div>
        <div class="conversation-list">{#each contacts as p}<button class="conversation" onclick={() => startContact(p)}><Avatar name={p.name} online={p.online} /><div class="conversation-copy"><strong>{p.name}</strong><p>@{p.username}</p></div><MessageCircle size={18} /></button>{:else}<div class="list-empty"><Users size={28} /><p>Nhập ít nhất 2 ký tự để tìm người bạn muốn kết nối.</p></div>{/each}</div>
      {:else}
        <div class="section-label">LỊCH SỬ CUỘC GỌI</div><div class="conversation-list">{#each history as c}{@const conv = chat.conversations.find(x => x.id === c.conversation_id)}<button class="conversation" onclick={() => { if (conv) void select(conv); }}><Avatar name={conv ? chat.title(conv) : 'Cuộc gọi'} group={conv?.kind === 'group'} /><div class="conversation-copy"><strong>{conv ? chat.title(conv) : 'Cuộc gọi'}</strong><p>{c.mode === 'video' ? 'Gọi video' : 'Gọi thoại'} · {c.status === 'ended' ? 'Đã kết thúc' : 'Đang diễn ra'}<br />{date(c.created_at)}, {time(c.created_at)}</p></div><Phone size={17} /></button>{:else}<div class="list-empty"><Phone size={29} /><p>Những cuộc gọi đưa ta lại gần.<br />Chọn một cuộc trò chuyện để bắt đầu.</p>{#if chat.demo}<small>Bản trải nghiệm chỉ xem thử camera của bạn.</small>{/if}</div>{/each}</div>
      {/if}
      <div class="sidebar-footer"><div class="invite-card"><span class="invite-icon"><Leaf size={23} strokeWidth={1.5} /></span><strong>Thêm bạn, thêm niềm vui.</strong><p>Mời những người bạn thương<br />vào không gian nhỏ này.</p><button onclick={() => modal = 'invite'}>Mời bạn bè <ArrowUpRight size={16} /></button></div><div class="sidebar-bottom"><span class="tiny-cloud"><Cloud size={14} /> Mây nhẹ, lòng gần.</span><button aria-label="Về Mây" onclick={() => modal = 'about'}><Info size={15} /></button></div></div>
    </aside>

    <main class="workspace">
      <div class="topbar"><div><span class="breadcrumb">Không gian của bạn</span><ChevronRight size={14} /><strong>{nav === 'calls' ? 'Cuộc gọi' : nav === 'contacts' ? 'Danh bạ' : 'Trò chuyện'}</strong></div><div><span class="connection" class:reconnecting={!chat.demo && chat.connection !== 'Đã kết nối'}><span></span>{chat.connection}</span>{#if chat.demo}<button class="preview-tag" onclick={() => modal = 'about'}>DEMO <ArrowUpRight size={12} /></button>{/if}<span class="top-divider"></span><button class="icon-button" aria-label="Cài đặt âm thanh" title={sounds.ready && sounds.volume > 0 && (sounds.messagesEnabled || sounds.callsEnabled) ? 'Âm thanh đã bật' : 'Cài đặt chuông và âm báo'} onclick={() => modal = 'settings'}>{#if sounds.ready && sounds.volume > 0 && (sounds.messagesEnabled || sounds.callsEnabled)}<Volume2 size={19} />{:else}<VolumeX size={19} />{/if}</button><button class="icon-button" aria-label="Giao diện sáng tối" title="Giao diện sáng tối" onclick={() => theme = theme === 'light' ? 'dark' : 'light'}>{#if theme === 'light'}<Sun size={19} />{:else}<Moon size={19} />{/if}</button></div></div>
      <div class="chat-layout">
        <section class="chat-pane" aria-label="Nội dung trò chuyện">
          {#if selected}
            <header class="chat-header"><button class="icon-button back-button" aria-label="Quay lại danh sách" onclick={() => { chat.selected = ''; details = false; }}><ArrowLeft size={22} /></button><Avatar name={chat.title(selected)} size={43} group={selected.kind === 'group'} online={selected.kind === 'direct' && onlineCount > 1} /><div class="chat-header-copy"><h2>{chat.title(selected)}{#if selected.kind === 'group'}<span class="group-label">Nhóm</span>{/if}</h2><p>{#if selected.kind === 'group'}{selected.members.length} thành viên <span>·</span> {onlineCount} đang online{:else if selected.members.some(p => p.id !== chat.me?.id && p.online)}<i></i>Đang hoạt động{:else}Ngoại tuyến{/if}</p></div><div class="chat-actions"><button class="icon-button" aria-label="Gọi thoại" title="Gọi thoại" disabled={calling.busy || !!calling.call} onclick={() => calling.start('audio')}><Phone size={20} strokeWidth={1.7} /></button><button class="icon-button video-button" aria-label="Gọi video" title="Gọi video" disabled={calling.busy || !!calling.call} onclick={() => calling.start('video')}><Video size={21} strokeWidth={1.7} /></button><span class="action-divider"></span><button class="icon-button desktop-search" class:highlight={inSearch} aria-label="Tìm trong tin nhắn đã tải" title="Tìm trong tin nhắn đã tải" onclick={() => { inSearch = !inSearch; messageQuery = ''; }}><Search size={20} strokeWidth={1.7} /></button><button class="icon-button" class:highlight={details} aria-label="Thông tin cuộc trò chuyện" title="Thông tin cuộc trò chuyện" onclick={() => details = !details}><Info size={21} strokeWidth={1.7} /></button></div></header>
            {#if inSearch}<div class="message-search"><Search size={17} /><input bind:value={messageQuery} placeholder="Tìm trong tin nhắn đã tải…" aria-label="Tìm nội dung tin nhắn" /><span>{messages.length} tin nhắn</span><button class="icon-button" aria-label="Đóng tìm kiếm" onclick={() => { inSearch = false; messageQuery = ''; }}><X size={18} /></button></div>{/if}
            {#if !chat.demo && chat.connection !== 'Đã kết nối'}<div class="network-banner"><WifiOff size={15} /> Đang nối lại. Tin chưa gửi sẽ được thử lại khi có mạng.</div>{/if}
            <div class="message-area" bind:this={scrollArea} onscroll={() => { stickToBottom = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight < 90; }}>
              {#if !chat.demo && messages.length >= 50 && !noOlder[selected.id]}<button class="history-button" disabled={loadingHistory} onclick={older}><RefreshCw size={13} /> {loadingHistory ? 'Đang tải…' : 'Xem tin nhắn trước đó'}</button>{/if}
              {#if messages.length < 10 && !messageQuery}<div class="conversation-intro"><div class="intro-avatar"><Avatar name={chat.title(selected)} size={60} group={selected.kind === 'group'} /><span>✦</span></div><h3>{chat.title(selected)}</h3><p>{selected.kind === 'group' ? `${selected.members.length} người, cùng một nhịp kết nối.` : 'Mỗi câu chuyện hay bắt đầu bằng một lời chào.'}</p></div>{/if}
              {#each messages as m, i (m.id)}
                {#if i === 0 || date(messages[i - 1].created_at) !== date(m.created_at)}<div class="date-divider"><span></span><time>{date(m.created_at)}</time><span></span></div>{/if}
                {@const mine = m.sender_id === chat.me?.id}
                {@const joined = i > 0 && messages[i - 1].sender_id === m.sender_id && m.created_at - messages[i - 1].created_at < 180}
                <div class="message-row" class:mine class:joined>
                  {#if !mine}<div class="message-avatar">{#if !joined}<Avatar name={person(m.sender_id)} size={32} />{/if}</div>{/if}
                  <div class="message-content">{#if !mine && !joined}<span class="sender-name">{person(m.sender_id)}</span>{/if}<div class="bubble" class:has-file={!!m.attachment_id}>{#if m.attachment_id}<button class="file-attachment" onclick={() => download(m)}><span><FileText size={24} /></span><div><strong>{m.attachment_name}</strong><small>{((m.attachment_size || 0) / 1024).toFixed(0)} KB · Nhấn để tải</small></div><Download size={17} /></button>{/if}{#if m.body}<p>{m.body}</p>{/if}</div><div class="message-meta"><time>{time(m.created_at)}</time>{#if mine}{#if m.status === 'failed'}<button class="retry-button" onclick={() => chat.deliver(m)}>Chưa gửi · Thử lại <RefreshCw size={11} /></button>{:else if m.status === 'pending'}<span>Đang gửi…</span>{:else}<Check size={13} /><span>Đã gửi</span>{/if}{/if}</div></div>
                </div>
              {:else}{#if messageQuery}<div class="list-empty"><Search size={28} /><p>Không tìm thấy nội dung này trong tin nhắn đã tải.</p></div>{:else}<div class="first-message"><Leaf size={23} /><p>Gửi lời chào đầu tiên nhé.</p></div>{/if}{/each}
              {#if (chat.typing[chat.selected] || 0) > now}<div class="typing-status"><span>•••</span> Có người đang nhập…</div>{/if}
            </div>
            <div class="composer-section">
              {#if showEmoji}<div class="emoji-picker" aria-label="Chọn biểu tượng cảm xúc">{#each emojis as emoji}<button aria-label={`Thêm ${emoji}`} onclick={() => { draft += emoji; typing(); composer?.focus(); }}>{emoji}</button>{/each}</div>{/if}
              {#if attachment}<div class="attachment-preview"><Paperclip size={15} /><span>{attachment.name}</span><small>{(attachment.size / 1024).toFixed(0)} KB</small><button class="icon-button" aria-label="Bỏ tệp đính kèm" onclick={() => attachment = undefined}><X size={16} /></button></div>{/if}
              {#if chat.uploadProgress !== null}<div class="upload-status" role="status"><span>Đang tải tệp lên… {chat.uploadProgress}% <button type="button" class="text-button" onclick={() => chat.cancelUpload()}>Hủy tải</button></span><progress aria-label="Tiến độ tải tệp" max="100" value={chat.uploadProgress}></progress></div>{/if}
              <form class="composer" onsubmit={e => { e.preventDefault(); void send(); }}>
                <button type="button" disabled={sending} class="icon-button emoji-button" class:highlight={showEmoji} aria-label="Biểu tượng cảm xúc" title="Biểu tượng cảm xúc" onclick={() => showEmoji = !showEmoji}><Smile size={22} strokeWidth={1.6} /></button>
                <textarea disabled={sending} bind:this={composer} bind:value={draft} rows="1" maxlength="4000" aria-label="Nhập tin nhắn" placeholder="Viết một điều gì đó…" oninput={typing} onkeydown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && enterSend && matchMedia('(pointer:fine)').matches) { e.preventDefault(); void send(); } }}></textarea>
                <input type="file" class="visually-hidden" bind:this={fileInput} onchange={e => { const file = e.currentTarget.files?.[0]; if (file && file.size >= MAX_FILE_BYTES) chat.notify(FILE_SIZE_ERROR); else attachment = file; e.currentTarget.value = ''; }} />
                <button type="button" disabled={sending} class="icon-button" aria-label="Đính kèm tệp" title="Đính kèm tệp (dưới 100 MB)" onclick={() => fileInput.click()}><Paperclip size={21} strokeWidth={1.6} /></button><button class="send-button" aria-label="Gửi tin nhắn" title="Gửi tin nhắn" disabled={sending || (!draft.trim() && !attachment)}>{#if sending}<RefreshCw size={19} />{:else}<Send size={19} />{/if}</button>
              </form><div class="composer-footnote"><span><Leaf size={12} /> {chat.demo ? 'Bản trải nghiệm · Tin nhắn chỉ lưu trên trình duyệt' : 'Một lời nhắn nhỏ, một niềm vui lớn.'}</span><span class="desktop-only">{enterSend ? 'Enter để gửi · Shift + Enter để xuống dòng' : 'Nhấn nút mũi tên để gửi'}</span></div>
            </div>
          {:else}
            <div class="welcome"><div class="welcome-art"><div class="welcome-circle"></div><Cloud size={86} strokeWidth={1.1} /><span class="welcome-leaf"><Leaf size={28} /></span><span class="welcome-message"><MessageCircle size={25} /></span><i>✦</i></div><span class="eyebrow">MỘT CHÚT GẦN NHAU</span><h2>Những câu chuyện<br />đẹp bắt đầu từ đây.</h2><p>Gửi một lời chào. Chia sẻ một khoảnh khắc.<br />Dành chút thời gian cho những người bạn thương.</p><button class="primary" onclick={() => openNew()}>Bắt đầu trò chuyện <ArrowRight size={17} /></button><div class="welcome-note"><LockKeyhole size={14} /> {chat.demo ? 'Bản trải nghiệm · Nội dung mẫu được lưu trên trình duyệt này' : 'Kết nối qua HTTPS · Tin nhắn được lưu trên máy chủ của bạn'}</div></div>
          {/if}
        </section>
        {#if details && selected}
          <aside class="details-pane"><div class="details-heading"><strong>Thông tin trò chuyện</strong><button class="icon-button" aria-label="Đóng thông tin" onclick={() => details = false}><X size={18} /></button></div><div class="details-profile"><Avatar name={chat.title(selected)} size={72} group={selected.kind === 'group'} /><h3>{chat.title(selected)}</h3><p>{selected.kind === 'group' ? 'Những điều nhỏ, cùng sẻ chia.' : 'Luôn có một người để sẻ chia.'}</p><div><button onclick={() => calling.start('audio')} disabled={!!calling.call}><Phone size={17} /><span>Gọi thoại</span></button><button onclick={() => calling.start('video')} disabled={!!calling.call}><Video size={18} /><span>Gọi video</span></button><button onclick={notifications}><Bell size={18} /><span>Thông báo</span></button></div></div><div class="details-section"><h4>Thành viên <span>{selected.members.length}</span></h4>{#each selected.members as p}<div class="member"><Avatar name={p.name} size={35} online={p.online} /><div><strong>{p.name}{p.id === chat.me?.id ? ' (bạn)' : ''}</strong><span>{p.online ? 'Đang hoạt động' : 'Ngoại tuyến'}</span></div></div>{/each}</div><div class="details-section"><h4>Tệp đã chia sẻ <span>{files.length}</span></h4>{#each files as m}<button class="shared-file" onclick={() => download(m)}><FileText size={19} /><span>{m.attachment_name}</span><Download size={14} /></button>{:else}<div class="no-files"><Paperclip size={23} /><p>Những điều bạn chia sẻ<br />sẽ xuất hiện ở đây.</p></div>{/each}</div><div class="details-bottom"><Leaf size={20} /><p>Không cần ở cạnh.<br />Vẫn luôn ở gần.</p></div></aside>
        {/if}
      </div>
    </main>
  </div>
{/if}

<dialog bind:this={dialog} onclose={() => modal = ''} onclick={e => { if (e.target === dialog) modal = ''; }} onkeydown={e => { if (e.key === 'Escape') modal = ''; }}>
  <div class="modal-body"><button class="modal-close icon-button" aria-label="Đóng" onclick={() => modal = ''}><X size={21} /></button>
    {#if modal === 'new'}
      <span class="modal-symbol"><MessageCircle size={25} /></span><h2>Mở đầu một câu chuyện</h2><p>Kết nối với một người, hoặc cả nhóm bạn.</p><div class="segmented"><button class:active={!group} onclick={() => { group = false; chosen = chosen.slice(0, 1); }}>Cá nhân</button><button class:active={group} onclick={() => group = true}>Tạo nhóm</button></div>
      {#if group}<label class="field-label">Tên nhóm<input bind:value={groupName} maxlength="80" placeholder="Một cái tên thật thân quen…" /></label>{/if}
      <div class="search-input"><Search size={17} /><input bind:value={newQuery} placeholder="Tìm tên hoặc tên đăng nhập…" aria-label="Tìm người để chat" /></div>
      {#if chosen.length}<div class="chosen-people">{#each chosen as p}<button onclick={() => chosen = chosen.filter(x => x.id !== p.id)}>{p.name}<X size={13} /></button>{/each}</div>{/if}
      <div class="people-results">{#each people as p}<button class="person-result" onclick={() => { chosen = chosen.some(x => x.id === p.id) ? chosen.filter(x => x.id !== p.id) : group ? [...chosen, p] : [p]; }}><Avatar name={p.name} size={40} online={p.online} /><div><strong>{p.name}</strong><span>@{p.username}</span></div><span class="checkbox" class:checked={chosen.some(x => x.id === p.id)}>{#if chosen.some(x => x.id === p.id)}<Check size={14} />{/if}</span></button>{:else}<p class="hint">{newQuery.length < 2 && !chat.demo ? 'Nhập ít nhất 2 ký tự để tìm bạn. Họ cần đăng ký tài khoản trước.' : 'Không tìm thấy người dùng phù hợp.'}</p>{/each}</div>
      {#if modalError}<p class="error" role="alert">{modalError}</p>{/if}<button class="primary full" disabled={creating || !chosen.length || (group && (chosen.length < 2 || !groupName.trim()))} onclick={create}>{creating ? 'Đang tạo…' : group ? 'Tạo nhóm trò chuyện' : 'Bắt đầu trò chuyện'}<ArrowRight size={17} /></button>
    {:else if modal === 'settings'}
      <span class="modal-symbol"><Settings size={25} /></span><h2>Không gian của bạn</h2><p>Một vài điều chỉnh nhỏ để Mây hợp với bạn hơn.</p><div class="settings-profile"><Avatar name={chat.me?.name || 'Bạn'} size={49} /><div><strong>{chat.me?.name}</strong><span>@{chat.me?.username}</span></div><span class="preview-tag">{chat.demo ? 'DEMO' : 'THÀNH VIÊN'}</span></div><h4 class="settings-label">Giao diện</h4><div class="theme-options"><button class:active={theme === 'light'} onclick={() => theme = 'light'}><Sun size={22} />Sáng</button><button class:active={theme === 'dark'} onclick={() => theme = 'dark'}><Moon size={22} />Tối</button></div><h4 class="settings-label">Âm thanh</h4>
      <label class="setting-row"><span><strong>Âm báo tin nhắn</strong><small>Tiếng báo khi gửi và nhận tin nhắn mới.</small></span><input type="checkbox" checked={sounds.messagesEnabled} onchange={e => sounds.setMessagesEnabled(e.currentTarget.checked)} /></label>
      <label class="setting-row"><span><strong>Chuông cuộc gọi</strong><small>Chuông đến và tiếng chờ khi đang gọi.</small></span><input type="checkbox" checked={sounds.callsEnabled} onchange={e => sounds.setCallsEnabled(e.currentTarget.checked)} /></label>
      <label class="sound-volume"><span>Âm lượng thông báo <strong>{Math.round(sounds.volume * 100)}%</strong></span><input type="range" min="0" max="100" step="5" value={Math.round(sounds.volume * 100)} oninput={e => sounds.setVolume(Number(e.currentTarget.value) / 100)} aria-label="Âm lượng thông báo" /></label>
      <div class="sound-previews"><button disabled={!sounds.supported || !sounds.messagesEnabled || sounds.volume === 0} onclick={() => sounds.previewMessage()}><Volume2 size={15} />Nghe thử tin nhắn</button><button disabled={!sounds.supported || !sounds.callsEnabled || sounds.volume === 0} onclick={() => sounds.previewRing()}><Phone size={15} />Nghe thử chuông</button></div>
      {#if !sounds.supported}<p class="hint sound-status">Trình duyệt này chưa hỗ trợ âm báo.</p>{:else if !sounds.ready && sounds.volume > 0 && (sounds.messagesEnabled || sounds.callsEnabled)}<button class="sound-enable-hint" data-enable-audio onclick={enableAudio}><Volume2 size={16} /><span>Bật âm thanh</span><ChevronRight size={14} /></button>{:else}<p class="hint sound-status">{sounds.volume === 0 || (!sounds.messagesEnabled && !sounds.callsEnabled) ? 'Âm thông báo đang tắt.' : 'Âm thanh đã sẵn sàng.'} Âm báo hoạt động khi ứng dụng đang mở.</p>{/if}
      <label class="setting-row"><span><strong>Enter để gửi tin nhắn</strong><small>Trên máy tính. Điện thoại luôn dùng nút gửi.</small></span><input type="checkbox" bind:checked={enterSend} onchange={() => { try { localStorage.setItem('may-enter-send', String(enterSend)); } catch {} }} /></label><button class="setting-row" onclick={notifications}><span><strong>Thông báo trình duyệt</strong><small>Nhận thông báo khi Mây đang mở.</small></span><Bell size={20} /></button><div class="settings-connection"><Wifi size={17} /><span>{chat.demo ? 'Bản trải nghiệm trên trình duyệt' : 'Máy chủ Rust · ' + chat.connection}</span></div><button class="logout-button" onclick={logout}><LogOut size={17} />{chat.demo ? 'Thoát bản trải nghiệm' : 'Đăng xuất'}</button>
    {:else if modal === 'invite'}
      <span class="modal-symbol"><Users size={28} /></span><h2>Thêm một người, thêm gần gũi.</h2><p>Sao chép liên kết và gửi cho bạn bè. Sau khi đăng ký, các bạn có thể tìm nhau bằng tên đăng nhập.</p><div class="invite-link"><Link size={18} /><span>{typeof location !== 'undefined' ? location.origin : ''}</span></div>{#if chat.demo}<p class="hint">Liên kết bản xem thử chỉ có dữ liệu mẫu. Để trò chuyện thật, hãy dùng địa chỉ VPS đã triển khai backend Rust.</p>{/if}<button class="primary full" onclick={copyInvite}><Copy size={17} />Sao chép liên kết</button>
    {:else if modal === 'about'}
      <div class="about-brand"><Cloud size={43} strokeWidth={1.5} /><span>mây</span></div><h2>Một chút gần nhau.</h2><p>Không gian nhỏ cho những kết nối lớn. Nhắn tin, chia sẻ tệp và gọi video với những người bạn thương.</p><div class="about-facts"><span><Leaf size={18} /> Backend Rust + Axum, frontend Svelte tĩnh.</span><span><Video size={18} /> WebRTC 1-1 và mesh nhóm tối đa 5 người.</span><span><LockKeyhole size={18} /> Phiên đăng nhập bằng cookie HttpOnly.</span></div>{#if chat.demo}<div class="demo-explanation"><strong>Bạn đang ở bản trải nghiệm</strong><p>Tin nhắn mẫu chỉ lưu trên trình duyệt này. Nút gọi mở camera để xem thử, chưa gọi cho người khác. Triển khai bộ mã nguồn lên VPS để dùng tài khoản và chat/gọi thật.</p></div>{:else}<p class="hint">Media WebRTC được mã hóa khi truyền. Tin nhắn được lưu trên máy chủ; hiện chưa có mã hóa đầu cuối cho chat.</p>{/if}<button class="secondary full" onclick={() => modal = ''}>Tiếp tục câu chuyện <ArrowRight size={16} /></button>
    {/if}
  </div>
</dialog>

{#if chat.incoming && !calling.call}
  {@const conv = chat.conversations.find(c => c.id === chat.incoming?.conversation_id)}
  <div class="incoming-call" role="alert"><span class="ring-icon"><Phone size={24} /></span><div><strong>{conv ? chat.title(conv) : 'Cuộc gọi đến'}</strong><p>{chat.incoming.mode === 'video' ? 'Cuộc gọi video đến' : 'Cuộc gọi thoại đến'}</p></div><button class="reject-call" aria-label="Từ chối cuộc gọi" disabled={calling.busy} onclick={() => calling.reject()}><PhoneOff size={20} /></button><button class="accept-call" aria-label="Nhận cuộc gọi" disabled={calling.busy} onclick={() => calling.accept()}><Phone size={20} /></button>{#if sounds.supported && sounds.callsEnabled && sounds.volume > 0 && !sounds.ready}<div class="incoming-sound-hint"><span>Trình duyệt đang chờ bạn bật âm thanh.</span><button data-enable-audio onclick={enableAudio}><Volume2 size={15} />Bật chuông</button></div>{:else if !sounds.callsEnabled || sounds.volume === 0}<div class="incoming-sound-hint"><VolumeX size={14} /><span>Chuông cuộc gọi đang tắt trong Cài đặt.</span></div>{/if}</div>
{/if}

{#if calling.call}
  <div class="call-overlay" role="dialog" aria-modal="true" aria-label="Cuộc gọi đang diễn ra" tabindex="-1"><header><div class="call-brand"><Cloud size={26} /> mây<span>{chat.demo ? 'XEM THỬ CAMERA' : 'CUỘC GỌI RIÊNG'}</span></div><span class="call-encryption"><LockKeyhole size={14} /> WebRTC</span></header><div class="call-title"><h2>{callConversation ? chat.title(callConversation) : 'Cuộc gọi'}</h2><p><span class:connected={!!calling.started}></span>{calling.status}{callDuration ? ' · ' + callDuration : ''}</p></div><div class="video-grid" class:single={calling.remotes.length === 0}>
      {#each calling.remotes as remote (remote.id)}<div class="video-tile"><Media stream={remote.stream} /><span class="video-label">{callConversation?.members.find(p => p.id === remote.id)?.name || 'Thành viên'}{#if !remote.connected} · Đang kết nối…{/if}</span></div>{/each}
      <div class="video-tile local-video" class:small={calling.remotes.length > 0}>{#if calling.local && !calling.cameraOff}<Media stream={calling.local} muted mirror />{:else}<div class="camera-placeholder"><Avatar name={chat.me?.name || 'Bạn'} size={90} /><span>{calling.call.mode === 'audio' ? 'Cuộc gọi thoại' : 'Camera đang tắt'}</span></div>{/if}<span class="video-label">Bạn {#if calling.muted}<MicOff size={14} />{/if}</span></div>
    </div>{#if chat.demo}<p class="call-demo-note">Đây là camera của bạn. Bản trải nghiệm chưa kết nối với người khác.</p>{/if}<footer class="call-controls"><button class:off={calling.muted} aria-label={calling.muted ? 'Bật micro' : 'Tắt micro'} title={calling.muted ? 'Bật micro' : 'Tắt micro'} onclick={() => calling.toggleMic()}>{#if calling.muted}<MicOff size={23} />{:else}<Mic size={23} />{/if}<span>Micro</span></button><button class:off={calling.cameraOff} disabled={!calling.camera} aria-label={calling.cameraOff ? 'Bật camera' : 'Tắt camera'} title="Bật/tắt camera" onclick={() => calling.toggleCamera()}>{#if calling.cameraOff}<VideoOff size={23} />{:else}<Video size={23} />{/if}<span>Camera</span></button><button class:off={calling.sharing} class="screen-share" aria-label="Chia sẻ màn hình" title="Chia sẻ màn hình" onclick={() => calling.share()}><ScreenShare size={23} /><span>Chia sẻ</span></button><button class="end-call" aria-label="Kết thúc cuộc gọi" title="Kết thúc cuộc gọi" onclick={() => calling.end()}><PhoneOff size={24} /><span>Kết thúc</span></button></footer></div>
{/if}

{#if chat.toast}<div class="toast" role="status"><Info size={19} /><span>{chat.toast}</span><button aria-label="Đóng thông báo" onclick={() => chat.toast = ''}><X size={17} /></button></div>{/if}
