import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AccountApiContext, type AccountApiContextValue } from '@/context/AccountContext';
import { renderWithTheme } from '@/test/renderWithTheme';
import { ChangePasswordScreen, LoginScreen } from './LoginGate';

function renderWithAccountApi(
  ui: ReactElement,
  api: Partial<AccountApiContextValue> = {},
): AccountApiContextValue {
  const value: AccountApiContextValue = {
    login: vi.fn(async () => null),
    changePassword: vi.fn(async () => null),
    logout: vi.fn(async () => undefined),
    refresh: vi.fn(async () => null),
    requireBalance: vi.fn(() => true),
    dismissInsufficientBalance: vi.fn(),
    ...api,
  };
  renderWithTheme(
    <AccountApiContext.Provider value={value}>{ui}</AccountApiContext.Provider>,
  );
  return value;
}

function submitLogin() {
  fireEvent.change(screen.getByLabelText('手机号'), { target: { value: '13800001234' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'initial-pass-1' } });
  fireEvent.click(screen.getByLabelText(/我已阅读并同意/));
  fireEvent.click(screen.getByRole('button', { name: '登 录' }));
}

describe('LoginScreen（票 06 登录门）', () => {
  it('未勾选协议时不能提交登录', () => {
    const api = renderWithAccountApi(<LoginScreen graceExpired={false} agreementAccepted={false} />);
    const submit = screen.getByRole('button', { name: '登 录' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('手机号'), { target: { value: '13800001234' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'x'.repeat(8) } });
    expect(submit).toBeDisabled();
    expect(api.login).not.toHaveBeenCalled();
  });

  it('错误密码得到明确反馈，且透传 Rust 映射的错误文本', async () => {
    const api = renderWithAccountApi(<LoginScreen graceExpired={false} agreementAccepted={false} />, {
      login: vi.fn(async () => '手机号或密码不正确'),
    });
    submitLogin();
    expect(await screen.findByRole('alert')).toHaveTextContent('手机号或密码不正确');
    expect(api.login).toHaveBeenCalledWith('13800001234', 'initial-pass-1', true);
  });

  it('手机号格式不符时在本地拦截并提示', async () => {
    const api = renderWithAccountApi(<LoginScreen graceExpired={false} agreementAccepted={false} />);
    fireEvent.change(screen.getByLabelText('手机号'), { target: { value: '12800001234' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'whatever' } });
    fireEvent.click(screen.getByLabelText(/我已阅读并同意/));
    fireEvent.click(screen.getByRole('button', { name: '登 录' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('请输入正确的 11 位手机号');
    expect(api.login).not.toHaveBeenCalled();
  });

  it('宽限超期时提示需要重新联网登录', () => {
    renderWithAccountApi(<LoginScreen graceExpired agreementAccepted={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('已超过 7 天未连接服务器');
  });

  it('设备已同意过协议时按「首次登录」语义预勾选', () => {
    renderWithAccountApi(<LoginScreen graceExpired={false} agreementAccepted />);
    expect(screen.getByRole('button', { name: '登 录' })).toBeEnabled();
  });
});

describe('ChangePasswordScreen（首登强制改密）', () => {
  function submitChange() {
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'initial-pass-1' } });
    fireEvent.change(screen.getByLabelText('新密码（8–128 位）'), { target: { value: 'brand-new-pass-9' } });
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'brand-new-pass-9' } });
    fireEvent.click(screen.getByRole('button', { name: '修改密码并进入' }));
  }

  it('两次新密码不一致时不发起改密请求', async () => {
    const api = renderWithAccountApi(<ChangePasswordScreen />);
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'initial-pass-1' } });
    fireEvent.change(screen.getByLabelText('新密码（8–128 位）'), { target: { value: 'brand-new-pass-9' } });
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'different-pass-9' } });
    fireEvent.click(screen.getByRole('button', { name: '修改密码并进入' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('两次输入的新密码不一致');
    expect(api.changePassword).not.toHaveBeenCalled();
  });

  it('改密失败反馈当前密码错误', async () => {
    renderWithAccountApi(<ChangePasswordScreen />, {
      changePassword: vi.fn(async () => '当前密码不正确'),
    });
    submitChange();
    expect(await screen.findByRole('alert')).toHaveTextContent('当前密码不正确');
  });

  it('改密成功后调用 Rust 改密命令且不显示错误', async () => {
    const api = renderWithAccountApi(<ChangePasswordScreen />);
    submitChange();
    await waitFor(() => expect(api.changePassword).toHaveBeenCalledWith('initial-pass-1', 'brand-new-pass-9'));
    // 改密成功后由 App 层门控切换到工作台，本屏不再显示错误。
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
