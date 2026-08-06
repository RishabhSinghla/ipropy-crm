import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// SQL migrations are read at runtime, so they must ship alongside the compiled JS.
await mkdir(resolve(root, 'dist/db/migrations'), { recursive: true });
await cp(resolve(root, 'src/db/migrations'), resolve(root, 'dist/db/migrations'), { recursive: true });
console.log('[build] copied migrations to dist');
