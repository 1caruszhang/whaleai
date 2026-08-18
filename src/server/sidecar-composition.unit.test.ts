import { describe, expect, it, vi } from 'vitest';
import {
  classifySidecarRequest,
  composeSidecarRequestHandler,
  resolveSidecarComposition,
} from './sidecar-composition';

function request(path: string, method = 'GET'): Request {
  return new Request(`http://127.0.0.1:31415${path}`, { method });
}

describe('Session Sidecar composition', () => {
  it('has one focused capability set', () => {
    expect([...resolveSidecarComposition().capabilities]).toEqual(['common', 'session']);
  });

  it.each([
    ['GET', '/health', 'common'],
    ['GET', '/sessions/session-1', 'session'],
    ['GET', '/sessions/session-1/stats', 'session'],
    ['POST', '/chat/send', 'session'],
    ['GET', '/chat/stream', 'session'],
    ['GET', '/api/session-state', 'session'],
    ['POST', '/api/ask-user-question/respond', 'session'],
    ['POST', '/api/xiaojing/question-pools/generate', 'session'],
    ['GET', '/api/attachment/session-1/image.png', 'session'],
  ] as const)('%s %s is owned by %s', (method, path, capability) => {
    expect(classifySidecarRequest(request(path, method))).toBe(capability);
  });

  it('rejects unknown product routes before handler side effects', async () => {
    const handler = vi.fn(async () => new Response('handled'));
    const response = await composeSidecarRequestHandler(
      resolveSidecarComposition(),
      handler,
    )(request('/api/unknown-product-surface', 'POST'));
    expect(response.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });
});
