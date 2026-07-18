import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { build, createServer, preview } from 'vite';

const root = process.cwd();
const command = process.argv[2];
if (command === 'dev') {
  const server = await createServer({ root, publicDir: false });
  await server.listen();
  server.printUrls();
} else if (command === 'preview') {
  const server = await preview({
    root,
    base: process.env.BASE_PATH ?? '/',
    publicDir: false,
    preview: { host: '127.0.0.1' },
  });
  server.printUrls();
} else if (command === 'build' || command === 'bundle') {
  const output = path.join(root, 'dist');
  await build({
    root,
    base: process.env.BASE_PATH ?? '/',
    publicDir: false,
    build: { outDir: output, emptyOutDir: true },
  });
  if (command === 'build') {
    const destination = path.join(output, 'web');
    await mkdir(destination, { recursive: true });
    await cp(path.join(root, 'variants', 'web'), destination, { recursive: true });
  }
} else {
  throw new Error('usage: viewer.mjs dev|preview|bundle|build');
}
