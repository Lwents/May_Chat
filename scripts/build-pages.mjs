import { spawnSync } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';
const result = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', env: { ...process.env, VITE_REQUIRE_BACKEND: 'true' } });
if (result.status !== 0) process.exit(result.status || 1);
copyFileSync('infrastructure/cloudflare/_worker.js', 'build/_worker.js');
writeFileSync('build/_routes.json', JSON.stringify({ version: 1, include: ['/api/*'], exclude: [] }, null, 2));
writeFileSync('build/_headers', `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
  X-Frame-Options: DENY
  Permissions-Policy: camera=(self), microphone=(self), display-capture=(self)
/_app/immutable/*
  Cache-Control: public, max-age=31536000, immutable
/index.html
  Cache-Control: no-cache
`);
console.log('Cloudflare Pages output prepared in build/');
