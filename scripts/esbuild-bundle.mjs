import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const outfile = 'src-tauri/resources/server-dist.js';
await mkdir(dirname(outfile), { recursive: true });

await build({
  entryPoints: ['src/server/index.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  banner: {
    js: 'import { createRequire as __xiaojingCreateRequire } from "module"; const require = __xiaojingCreateRequire(import.meta.url);',
  },
});

const code = await readFile(outfile, 'utf8');
const hardcodedDirectory = code.match(/var __dirname = "((?:\/Users|\/home|[A-Za-z]:[\\/])[^"]+)"/);
if (hardcodedDirectory) {
  throw new Error(
    `${outfile}: hardcoded development path ${hardcodedDirectory[1]}; use import.meta.url`,
  );
}

console.log(`✓ server → ${outfile}`);
