import { cpSync, rmSync } from 'node:fs';
rmSync('build', { recursive: true, force: true });
cpSync('apps/web/build', 'build', { recursive: true });
