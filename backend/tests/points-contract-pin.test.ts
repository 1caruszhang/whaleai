import { describe, expect, it } from 'vitest';

import { publishOrderPoints } from '../src/domain/publish-orders';
import pointsContract from '../../src/shared/geo/pointsContract.json';

/**
 * 点数公式契约 pin（票 #39，ADR-0012）：网关 `publishOrderPoints` 与桌面侧
 * shared `points.ts`、Rust `publish_channel_price_points` 三侧实跑同一裁判
 * cases（src/shared/geo/pointsContract.json）。测试侧相对路径 import JSON，
 * 运行时零耦合，Docker 构建不受影响——网关是首次接入 pin 机制的第三侧。
 */
describe('点数公式契约（票 #39，ADR-0012）', () => {
  it('公式参数钉在 pointsContract.json 裁判上', () => {
    expect(pointsContract.formula.multiplier).toBe(4);
    expect(pointsContract.formula.divisor).toBe(25);
    expect(pointsContract.formula.rounding).toBe('ceil');
  });

  it('publishOrderPoints 实跑裁判 cases（入参即分）', () => {
    for (const { inputCents, expectedPoints } of pointsContract.cases) {
      expect(publishOrderPoints(inputCents)).toBe(expectedPoints);
    }
  });
});
