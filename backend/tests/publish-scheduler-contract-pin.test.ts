import { describe, expect, it } from 'vitest';

import { REFUND_STATUSES } from '../src/domain/publish-orders';
import publishSchedulerContract from '../../src/shared/geo/publishSchedulerContract.json';

/**
 * 退点状态契约 pin（票 #35-41 验收修复，ADR-0012）：本网关的
 * REFUND_STATUSES 与桌面侧 TS 谓词 publishOrderRefundsPoints 是两处独立
 * 手写的资金语义值，共同裁判是 src/shared/geo/publishSchedulerContract.json
 * 的 publishOrderRefundStatuses（升序 [2, 5, 7]）。测试侧相对路径 import
 * JSON，运行时零耦合，Docker 构建不受影响（先例：
 * points-contract-pin.test.ts）。
 */
describe('退点状态契约 pin（ADR-0012）', () => {
  it('REFUND_STATUSES 与 publishSchedulerContract.json 严格相等（含顺序）', () => {
    expect([...REFUND_STATUSES]).toEqual(
      publishSchedulerContract.publishOrderRefundStatuses.values,
    );
  });
});
