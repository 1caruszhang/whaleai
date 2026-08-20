import { resolve, sep } from 'node:path';

import { fileResponse, sniffMime } from './file-response';

const UNFINGERPRINTED_HEADERS = { 'Cache-Control': 'no-cache' } as const;
const HASHED_ASSET_HEADERS = { 'Cache-Control': 'public, max-age=31536000, immutable' } as const;

export async function serveStatic(
  pathname: string,
  distRoot: string = resolve(process.cwd(), 'dist'),
): Promise<Response | null> {
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const target = resolve(distRoot, relativePath);
  if (target !== distRoot && !target.startsWith(distRoot + sep)) return null;
  // relativePath comes from the URL pathname, so its separator is always '/'.
  const isHashedAsset = relativePath.startsWith('assets/');
  // Un-fingerprinted files (index.html above all) must revalidate every load:
  // their hashed chunk references change on every rebuild, and a stale copy
  // breaks dynamic imports in the WebView. Fingerprinted /assets/* files are
  // immutable and safe to cache forever.
  const headers = isHashedAsset ? HASHED_ASSET_HEADERS : UNFINGERPRINTED_HEADERS;
  const direct = await fileResponse(target, { contentType: sniffMime(target), headers });
  if (direct) return direct;
  return fileResponse(resolve(distRoot, 'index.html'), {
    contentType: 'text/html; charset=utf-8',
    headers: UNFINGERPRINTED_HEADERS,
  });
}
