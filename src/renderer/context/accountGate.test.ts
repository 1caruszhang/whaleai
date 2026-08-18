import { describe, expect, it } from 'vitest';

import type { AccountState } from '@/api/accountClient';
import { accountGateFor } from './AccountContext';

function account(overrides: Partial<AccountState> = {}): AccountState {
  return {
    loggedIn: true,
    phone: '13800001234',
    points: 500,
    status: 'active',
    mustChangePassword: false,
    agreementAccepted: true,
    offlineGrace: { within: true, lastServerContactAt: 1, deadlineAt: 2 },
    ...overrides,
  };
}

describe('accountGateFor（票 06 登录门判定）', () => {
  it('未登录与宽限超期都退回登录页', () => {
    expect(accountGateFor(account({ loggedIn: false }))).toBe('login');
    expect(
      accountGateFor(account({ offlineGrace: { within: false, lastServerContactAt: 1, deadlineAt: 2 } })),
    ).toBe('login');
  });

  it('首登未完成改密前不得进入工作台', () => {
    expect(accountGateFor(account({ mustChangePassword: true }))).toBe('change-password');
  });

  it('已登录且在宽限期内才挂载工作台', () => {
    expect(accountGateFor(account())).toBe('workbench');
  });
});
