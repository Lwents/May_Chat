<script lang="ts">
 import { Users } from 'lucide-svelte';
 let { name, size = 44, online = false, group = false }: { name: string; size?: number; online?: boolean; group?: boolean } = $props();
 const colors = ['#e9dcca', '#dce6ee', '#e7ddec', '#e5e9d3', '#f0dfd6'];
 let color = $derived(colors[Array.from(name).reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length]);
 let initials = $derived(name.split(' ').filter(Boolean).slice(-2).map(s => s[0]).join('').toUpperCase());
</script>
<span class="avatar" class:group style:width="{size}px" style:height="{size}px" style:font-size="{size * 0.30}px" style:background={group ? '#dfebe1' : color}>
 {#if group}<Users size={size * 0.46} strokeWidth={1.7} />{:else}{initials}{/if}
 {#if online}<span class="online" aria-label="Đang online"></span>{/if}
</span>
<style>.avatar{display:inline-flex;align-items:center;justify-content:center;position:relative;flex-shrink:0;border-radius:38%;font-weight:650;color:#536450;letter-spacing:-.4px}.group{color:#3f6952}.online{position:absolute;right:-1px;bottom:0;width:11px;height:11px;background:#62a17b;border:2px solid var(--panel,#fff);border-radius:50%}</style>
