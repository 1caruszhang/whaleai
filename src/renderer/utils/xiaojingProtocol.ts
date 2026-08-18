/** Resolve app-owned binary subresource URLs for the current WebView. */
const XIAOJING_WINDOWS_ORIGIN = 'http://xiaojing.localhost';
const XIAOJING_SCHEME_PREFIX = 'xiaojing://';

export function isWindowsPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Win/i.test(navigator.platform || '') || /Windows/i.test(navigator.userAgent || '');
}

export function resolveXiaojingProtocolUrl(pathname: string): string {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return isWindowsPlatform()
    ? `${XIAOJING_WINDOWS_ORIGIN}${path}`
    : `${XIAOJING_SCHEME_PREFIX}${path.slice(1)}`;
}
