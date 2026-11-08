import { writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
const [domain, ip, email] = process.argv.slice(2);
if (!domain || !/^(?=.{4,253}$)[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(domain) || isIP(ip) !== 4 || !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email || '')) {
  console.error('Usage: node scripts/configure.mjs chat.example.com PUBLIC_IPV4 you@example.com'); process.exit(1);
}
if (existsSync('.env')) { console.error('.env already exists. Edit it manually to preserve TURN credentials.'); process.exit(1); }
writeFileSync('.env', `DOMAIN=${domain}\nPUBLIC_IP=${ip}\nACME_EMAIL=${email}\nTURN_SECRET=${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
console.log('Created .env with a random TURN secret. Keep this file private.');
