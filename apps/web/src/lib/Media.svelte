<script lang="ts">
  let { stream, muted = false, mirror = false }: { stream: MediaStream; muted?: boolean; mirror?: boolean } = $props();
  let element: HTMLVideoElement;
  $effect(() => { if (element && stream) { element.srcObject = stream; void element.play().catch(() => {}); } });
</script>
<!-- svelte-ignore a11y_media_has_caption -->
<video bind:this={element} autoplay playsinline {muted} class:mirror></video>
<style>video{width:100%;height:100%;object-fit:cover;display:block;border-radius:inherit}.mirror{transform:scaleX(-1)}</style>
