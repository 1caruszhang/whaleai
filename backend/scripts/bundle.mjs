import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * 后端单文件 bundle（票 12 部署形态）：esbuild 把 src/index.ts 连同全部
 * npm 依赖打进 dist/index.js，运行镜像因此不需要 node_modules——镜像层里
 * 只有 node 基础镜像 + bundle + 空 data 目录。与仓库既有 sidecar 打包路径
 * （scripts/esbuild-bundle.mjs）同款参数与护栏。
 */
const outfile = 'dist/index.js';
await mkdir(dirname(outfile), { recursive: true });

await build({
  entryPoints: ['src/index.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  // CJS 依赖（@hono/node-server 等）经 createRequire 兜底 require。
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

console.log(`✓ backend → ${outfile}`);
