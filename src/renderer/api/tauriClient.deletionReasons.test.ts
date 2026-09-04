import { describe, expect, it, vi } from 'vitest';

// 会话删除原因词表的 TS 侧 pin（ADR-0012 双侧裁判）：tauriClient 的常量
// 联合（类型由此派生，联合与常量表不可能漂移）必须与共享裁判
// geoOperationContract.json 的 sessionDeletionFailureReasons /
// sessionPersistentOwnerReasons 逐项相等（含顺序）。Rust 侧的镜像 pin 在
// src-tauri/src/sidecar/session_lifecycle.rs——改词表四处改齐的摩擦由此
// 保证：裁判 JSON、本常量组、Rust 常量组、i18n 文案。

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import geoOperationContract from '../../shared/geo/geoOperationContract.json';
import {
  SESSION_DELETE_FAILURE_REASONS,
  SESSION_PERSISTENT_OWNER_REASONS,
} from './tauriClient';

describe('session deletion reason vocabulary pin（ADR-0012）', () => {
  it('tauriClient 常量联合与 geoOperationContract.json 两键逐项相等（含顺序）', () => {
    expect(geoOperationContract.sessionDeletionFailureReasons).toEqual([
      ...SESSION_DELETE_FAILURE_REASONS,
    ]);
    expect(geoOperationContract.sessionPersistentOwnerReasons).toEqual([
      ...SESSION_PERSISTENT_OWNER_REASONS,
    ]);
  });

  it('持久 owner 子集是删除失败全表的子集', () => {
    // 两表各自等值 pin 测不出跨表漂移：子集里出现全集外的值时，渲染层
    // `persistentOwners.reason ?? 'in-use'` 的归并口径会静默失效。
    for (const reason of SESSION_PERSISTENT_OWNER_REASONS) {
      expect(SESSION_DELETE_FAILURE_REASONS).toContain(reason);
    }
  });
});
