import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { serveStatic } from './static-assets';

describe('serveStatic cache headers', () => {
  let distRoot: string;

  beforeEach(() => {
    distRoot = mkdtempSync(join(tmpdir(), 'xiaojing-static-assets-'));
    mkdirSync(join(distRoot, 'assets'), { recursive: true });
    writeFileSync(join(distRoot, 'index.html'), '<!doctype html><title>t</title>');
    writeFileSync(join(distRoot, 'assets', 'index-abc123.js'), 'console.log(1);');
  });

  afterEach(() => {
    rmSync(distRoot, { recursive: true, force: true });
  });

  it('serves index.html with no-cache so rebuilds cannot strand stale chunk references', async () => {
    const response = await serveStatic('/', distRoot);
    expect(response?.status).toBe(200);
    expect(response?.headers.get('Cache-Control')).toBe('no-cache');
    expect(response?.headers.get('Content-Type')).toContain('text/html');
  });

  it('serves the SPA fallback with no-cache as well', async () => {
    const response = await serveStatic('/some/client/route', distRoot);
    expect(response?.status).toBe(200);
    expect(response?.headers.get('Cache-Control')).toBe('no-cache');
  });

  it('serves fingerprinted assets as immutable', async () => {
    const response = await serveStatic('/assets/index-abc123.js', distRoot);
    expect(response?.status).toBe(200);
    expect(response?.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(response?.headers.get('Content-Type')).toContain('javascript');
  });

  it('rejects path traversal outside the dist root', async () => {
    expect(await serveStatic('/../package.json', distRoot)).toBeNull();
  });
});
