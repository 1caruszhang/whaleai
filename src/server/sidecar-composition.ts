export type SidecarCapability = 'common' | 'session';

export type SidecarComposition = Readonly<{
  capabilities: ReadonlySet<SidecarCapability>;
}>;

export function resolveSidecarComposition(): SidecarComposition {
  return { capabilities: new Set<SidecarCapability>(['common', 'session']) };
}

export function hasSidecarCapability(
  composition: SidecarComposition,
  capability: SidecarCapability,
): boolean {
  return composition.capabilities.has(capability);
}

export function classifySidecarRequest(request: Request): SidecarCapability | null {
  const { pathname } = new URL(request.url);
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') return 'common';
  if (
    method === 'GET'
    && ['/health', '/health/live', '/health/ready', '/health/functional'].includes(pathname)
  ) return 'common';
  if (
    pathname.startsWith('/chat/')
    || pathname.startsWith('/api/attachment/')
    || pathname.startsWith('/api/xiaojing/')
    || pathname === '/api/session-state'
    || pathname === '/api/session-latest-result'
    || pathname === '/api/ask-user-question/respond'
    || /^\/sessions\/[A-Za-z0-9-]{1,99}$/.test(pathname)
    || /^\/sessions\/[A-Za-z0-9-]{1,99}\/stats$/.test(pathname)
  ) return 'session';
  if (
    method === 'GET'
    && !pathname.startsWith('/api/')
    && !pathname.startsWith('/chat/')
    && !pathname.startsWith('/health')
    && !pathname.startsWith('/sessions')
  ) return 'common';
  return null;
}

export type SidecarRequestHandler = (request: Request) => Promise<Response>;

export function composeSidecarRequestHandler(
  composition: SidecarComposition,
  handler: SidecarRequestHandler,
): SidecarRequestHandler {
  return async (request) => {
    const capability = classifySidecarRequest(request);
    if (!capability || !hasSidecarCapability(composition, capability)) {
      return new Response('Not Found', { status: 404 });
    }
    return handler(request);
  };
}
