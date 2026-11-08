<script lang="ts">
  import { Download, FileText } from 'lucide-svelte';
  import type { Message } from './chat.svelte';
  let { message, onDownload, onLoaded }: { message: Message; onDownload: () => void; onLoaded: () => void } = $props();
  let failed = $state(false);
  const imageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  let kind = $derived(imageTypes.includes(message.attachment_mime || '') || /\.(jpe?g|png|webp|gif)$/i.test(message.attachment_name || '') ? 'image' : (message.attachment_mime || '').startsWith('video/') || /\.(mp4|m4v|mov|webm)$/i.test(message.attachment_name || '') ? 'video' : 'file');
  let url = $derived(message.demo_url || `/api/attachments/${message.attachment_id}?inline=1`);
</script>
{#if kind !== 'file' && !failed}
  <div class="inline-attachment">
    {#if kind === 'image'}
      <a href={url} target="_blank" rel="noopener" aria-label={`Xem ảnh ${message.attachment_name}`}><img src={url} alt={message.attachment_name || 'Ảnh đính kèm'} loading="lazy" onload={onLoaded} onerror={() => failed = true} /></a>
    {:else}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video src={url} controls playsinline preload="metadata" onloadedmetadata={onLoaded} onerror={() => failed = true}></video>
    {/if}
    <div class="media-caption"><span>{message.attachment_name}</span><button onclick={onDownload} aria-label={`Tải ${message.attachment_name}`} title="Tải tệp"><Download size={17} /></button></div>
  </div>
{:else}
  <button class="file-attachment" onclick={onDownload}><span><FileText size={24} /></span><div><strong>{message.attachment_name}</strong><small>{((message.attachment_size || 0) / 1000000 >= 1 ? `${((message.attachment_size || 0) / 1000000).toFixed(1)} MB` : `${((message.attachment_size || 0) / 1024).toFixed(0)} KB`)} · {failed ? 'Không xem được định dạng này · Tải tệp' : 'Nhấn để tải'}</small></div><Download size={17} /></button>
{/if}
<style>
 .inline-attachment{width:340px;max-width:100%;overflow:hidden;border-radius:9px}.inline-attachment a{display:block}.inline-attachment img{display:block;width:100%;max-height:360px;object-fit:contain;border-radius:8px;background:#11111108}.inline-attachment video{display:block;width:100%;max-height:360px;aspect-ratio:16/9;background:#15221b;border-radius:8px;object-fit:contain}.media-caption{display:flex;align-items:center;gap:9px;padding:5px 0 0;font-size:10px;color:var(--muted)}.media-caption>span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.media-caption>button{display:flex;align-items:center;justify-content:center;min-width:36px;min-height:36px;border-radius:8px;color:var(--green)}
 @media(max-width:760px){.inline-attachment{width:260px}.media-caption{font-size:11px}.media-caption>button{min-width:44px;min-height:44px}}
</style>
