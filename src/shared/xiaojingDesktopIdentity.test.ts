import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('Xiaojing desktop identity', () => {
  it('pins package, Tauri, window and protocol identity to Xiaojing', () => {
    const packageJson = JSON.parse(read('package.json')) as { name: string; description: string };
    const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json')) as {
      productName: string;
      identifier: string;
      app: { security: { csp: string; assetProtocol: { scope: string[] } } };
    };
    const rustShell = read('src-tauri/src/lib.rs');
    const html = read('src/renderer/index.html');

    expect(packageJson).toMatchObject({
      name: 'xiaojing',
      description: '鲸杉geo GEO 营销工作台',
    });
    expect(tauriConfig).toMatchObject({
      productName: '鲸杉geo',
      identifier: 'com.xiaojing.geo',
    });
    expect(tauriConfig.app.security.assetProtocol.scope).toEqual(['$LOCALDATA/Xiaojing/**']);
    expect(tauriConfig.app.security.csp).toContain('xiaojing:');
    expect(tauriConfig.app.security.csp).toContain('http://xiaojing.localhost');
    expect(rustShell).toContain('.register_asynchronous_uri_scheme_protocol("xiaojing"');
    expect(rustShell).toContain('.title("鲸杉geo")');
    expect(html).toContain('<title>鲸杉geo</title>');
  });

  it('keeps the native config owner on the new local-data root', () => {
    const appDirs = read('src-tauri/src/app_dirs.rs');
    const configIo = read('src-tauri/src/config_io.rs');

    expect(appDirs).toContain('dirs::data_local_dir().map(|root| root.join("Xiaojing"))');
    expect(configIo).toContain('with_file_lock_blocking');
    expect(configIo).toContain('config.json.tmp.rust');
  });
});
