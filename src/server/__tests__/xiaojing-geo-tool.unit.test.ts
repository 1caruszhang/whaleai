import { describe, expect, it } from 'vitest';

import {
  configureXiaojingGeo,
  xiaojingGeoContextSnapshot,
} from '../tools/xiaojing-geo-tool';

describe('Xiaojing GEO builtin boundary', () => {
  it('projects a real brand/session identity and distinguishes unavailable future slices', () => {
    configureXiaojingGeo({}, {
      sessionId: 'session-04',
      workspace: '/data/Xiaojing/brands/brand-04',
    });

    expect(xiaojingGeoContextSnapshot()).toEqual({
      brandWorkspaceId: 'brand-04',
      sessionId: 'session-04',
      capabilities: [
        { id: 'inspect-brand-context', status: 'available' },
        { id: 'brand-knowledge', status: 'available' },
        { id: 'brand-material-import', status: 'available' },
        { id: 'question-opportunities', status: 'available' },
        { id: 'content-production', status: 'planned' },
        { id: 'geo-observation', status: 'planned' },
      ],
    });
  });
});
