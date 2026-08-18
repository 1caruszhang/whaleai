import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import {
  accountChangePassword,
  accountLogin,
  accountLogout,
  accountRefresh,
  fetchAccountState,
  type AccountState,
} from '@/api/accountClient';
import InsufficientBalanceDialog from '@/components/account/InsufficientBalanceDialog';
import {
  AccountApiContext,
  AccountReadyContext,
  AccountStateContext,
  InsufficientBalanceContext,
  type AccountApiContextValue,
  type InsufficientBalancePrompt,
} from './AccountContext';

const LOGGED_OUT_FALLBACK: AccountState = {
  loggedIn: false,
  phone: null,
  points: null,
  status: null,
  mustChangePassword: false,
  agreementAccepted: false,
  offlineGrace: { within: false, lastServerContactAt: null, deadlineAt: null },
};

function rejectionMessage(error: unknown): string {
  if (typeof error === 'string' && error.trim()) return error;
  if (error instanceof Error && error.message) return error.message;
  return '操作失败，请稍后重试';
}

/**
 * 账号态 owner 的 renderer 投影（票 06）。Rust 是权威；本 Provider 只持有
 * Rust 命令返回的投影与 UI 流程状态，不缓存 token，也不反写磁盘事实。
 */
export default function AccountProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AccountState | null>(null);
  const [insufficient, setInsufficient] = useState<InsufficientBalancePrompt | null>(null);
  const stateRef = useRef<AccountState | null>(null);
  // requireBalance 只在事件回调读取；effect 内同步，避免渲染期写 ref。
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  // 加载期给消费者一个未登录兜底投影：AccountReady=false 时登录门只渲染
  // 启动屏，工作台消费者不会在此期间读取点数字段。
  const stateValue = state ?? LOGGED_OUT_FALLBACK;

  useEffect(() => {
    // Pattern B：StrictMode 下 setup→cleanup→setup 会跑两次，alive 守护
    // 迟到的异步结果；读取失败回落到未登录，而不是永远卡在启动屏。
    let alive = true;
    void (async () => {
      try {
        const next = await fetchAccountState();
        if (alive) setState(next);
      } catch (error) {
        console.error('[account] 初始登录态读取失败：', error);
        if (alive) setState(LOGGED_OUT_FALLBACK);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const refreshOnceRef = useRef(false);
  useEffect(() => {
    // 进入已登录态后做一次静默余额刷新（宽限期内余额可能已被运营入账）。
    // 只依赖布尔原语；失败或空结果静默保留旧投影。
    if (!state?.loggedIn || !state?.offlineGrace.within || refreshOnceRef.current) return;
    refreshOnceRef.current = true;
    void (async () => {
      try {
        const next = await accountRefresh();
        if (next) setState(next);
      } catch {
        // 离线或服务器不可达：保留 Rust 投影，登录门不因刷新失败变化。
      }
    })();
  }, [state?.loggedIn, state?.offlineGrace.within]);

  const login = useCallback(async (phone: string, password: string, acceptedAgreement: boolean) => {
    try {
      setState(await accountLogin(phone, password, acceptedAgreement));
      return null;
    } catch (error) {
      return rejectionMessage(error);
    }
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    try {
      setState(await accountChangePassword(currentPassword, newPassword));
      return null;
    } catch (error) {
      return rejectionMessage(error);
    }
  }, []);

  const logout = useCallback(async () => {
    setInsufficient(null);
    try {
      setState(await accountLogout());
    } catch (error) {
      console.error('[account] 退出登录失败：', error);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      setState(await accountRefresh());
      return null;
    } catch (error) {
      // 会话可能已被服务器判死（refresh 复用/过期）并清除：重读权威投影，
      // 登录门据实切换；网络故障则保留旧投影。
      try {
        setState(await fetchAccountState());
      } catch {
        // 保持旧投影。
      }
      return rejectionMessage(error);
    }
  }, []);

  const requireBalance = useCallback((requiredPoints: number) => {
    const current = stateRef.current;
    if (!current?.loggedIn || current.points === null || current.points >= requiredPoints) {
      return true;
    }
    setInsufficient({ requiredPoints, currentPoints: current.points });
    return false;
  }, []);

  const dismissInsufficientBalance = useCallback(() => {
    setInsufficient(null);
  }, []);

  const apiValue = useMemo<AccountApiContextValue>(
    () => ({
      login,
      changePassword,
      logout,
      refresh,
      requireBalance,
      dismissInsufficientBalance,
    }),
    [changePassword, dismissInsufficientBalance, login, logout, refresh, requireBalance],
  );

  return (
    <AccountApiContext.Provider value={apiValue}>
      <AccountReadyContext.Provider value={state !== null}>
        <AccountStateContext.Provider value={stateValue}>
          <InsufficientBalanceContext.Provider value={insufficient}>
            {children}
            {insufficient && (
              <InsufficientBalanceDialog
                requiredPoints={insufficient.requiredPoints}
                currentPoints={insufficient.currentPoints}
                onClose={dismissInsufficientBalance}
              />
            )}
          </InsufficientBalanceContext.Provider>
        </AccountStateContext.Provider>
      </AccountReadyContext.Provider>
    </AccountApiContext.Provider>
  );
}
