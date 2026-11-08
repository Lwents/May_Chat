export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!env.BACKEND_ORIGIN || !env.ORIGIN_TOKEN) {
      return Response.json({ error: 'Máy chủ chưa được cấu hình. Vui lòng thử lại sau.' }, { status: 503 });
    }
    const target = new URL(env.BACKEND_ORIGIN);
    if (target.protocol !== 'https:') return new Response('Invalid backend configuration', { status: 503 });
    target.pathname = target.pathname.replace(/\/$/, '') + url.pathname;
    target.search = url.search;
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.set('X-May-Origin-Key', env.ORIGIN_TOKEN);
    headers.set('X-May-Client-IP', request.headers.get('CF-Connecting-IP') || '127.0.0.1');
    const upstream = new Request(target, {
      method: request.method, headers, redirect: 'manual',
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      duplex: 'half',
    });
    try {
      // Return the original response: preserves WebSocket upgrades, streaming,
      // Set-Cookie, Range and large uploads without buffering the body.
      return await fetch(upstream);
    } catch {
      return Response.json({ error: 'Không thể kết nối máy chủ. Vui lòng thử lại.' }, { status: 502 });
    }
  },
};
