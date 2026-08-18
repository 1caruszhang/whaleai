import { createContext, useContext } from 'react';

import type { AccountState } from '@/api/accountClient';

/** 登录门的判定结果；纯函数 `accountGateFor` 便于单测。 */
export type AccountGate = 'login' | 'change-password' | 'workbench';

export interface InsufficientBalancePrompt {
  requiredPoints: number;
  currentPoints: number;
}

export interface AccountApiContextValue {
  login: (phone: string, password: string, acceptedAgreement: boolean) => Promise<string | null>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<string | null>;
  logout: () => Promise<void>;
  /** 在线刷新余额/宽限锚点；返回错误文本（离线时保持旧投影）。 */
  refresh: () => Promise<string | null>;
  /**
   * 计费操作前置余额守卫（票 06 交付的 UI 面）：余额不足时弹出
   * 「需 X 点 / 当前 Y 点」充值引导并返回 false。真正的 permit 预扣在
   * 票 07 接线到各计费操作时复用同一入口。
   */
  requireBalance: (requiredPoints: number) => boolean;
  dismissInsufficientBalance: () => void;
}

export const AccountStateContext = createContext<AccountState | null>(null);
export const AccountReadyContext = createContext(false);
export const AccountApiContext = createContext<AccountApiContextValue | null>(null);
export const InsufficientBalanceContext = createContext<InsufficientBalancePrompt | null>(null);

export function useAccountState(): AccountState {
  const context = useContext(AccountStateContext);
  if (!context) throw new Error('useAccountState must be used within an AccountProvider');
  return context;
}

export function useAccountStateOptional(): AccountState | null {
  return useContext(AccountStateContext);
}

export function useAccountReady(): boolean {
  return useContext(AccountReadyContext);
}

export function useAccountApi(): AccountApiContextValue {
  const context = useContext(AccountApiContext);
  if (!context) throw new Error('useAccountApi must be used within an AccountProvider');
  return context;
}

export function useInsufficientBalance(): InsufficientBalancePrompt | null {
  return useContext(InsufficientBalanceContext);
}

/** 未登录、宽限超期或首登未改密时，工作台不得挂载。 */
export function accountGateFor(state: AccountState): AccountGate {
  if (!state.loggedIn || !state.offlineGrace.within) return 'login';
  if (state.mustChangePassword) return 'change-password';
  return 'workbench';
}
