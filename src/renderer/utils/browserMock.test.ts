import { describe, expect, it } from 'vitest';

import { isTauriEnvironment, mockGetServerUrl } from './browserMock';

describe('browser environment helpers', () => {
  it('uses the focused development Sidecar URL outside Tauri', () => {
    expect(isTauriEnvironment()).toBe(false);
    expect(mockGetServerUrl()).toBe('http://127.0.0.1:3000');
  });
});
