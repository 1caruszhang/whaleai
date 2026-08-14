import { useMemo, useState } from 'react';
import { CheckCircle2, KeyRound, Loader2, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';

import { invoke } from '@tauri-apps/api/core';
import { useToast } from '@/components/Toast';
import { useConfig } from '@/hooks/useConfig';
import { NATIVE_SECRET_CONFIGURED } from '@/config/services/providerService';

type VerifyResult = { success: boolean; error?: string };

/** Focused settings surface: connection, native credential and health only. */
export default function XiaojingConnectionSettings() {
  const {
    apiKeys,
    providerVerifyStatus,
    saveApiKey,
    deleteApiKey,
    saveProviderVerifyStatus,
  } = useConfig();
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);

  const configured = apiKeys.deepseek === NATIVE_SECRET_CONFIGURED;
  const health = providerVerifyStatus.deepseek?.status;
  const healthLabel = useMemo(() => {
    if (!configured) return '尚未配置凭据';
    if (health === 'valid') return '连接健康';
    if (health === 'invalid') return '连接异常';
    return '凭据已安全保存，等待健康检查';
  }, [configured, health]);

  const save = async () => {
    if (!draft.trim() || saving) return;
    setSaving(true);
    try {
      await saveApiKey('deepseek', draft.trim());
      setDraft('');
      toast.success('凭据已保存到 Windows 凭据管理器');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存凭据失败');
    } finally {
      setSaving(false);
    }
  };

  const verify = async () => {
    if (!configured || checking) return;
    setChecking(true);
    try {
      const result = await invoke<VerifyResult>('cmd_deepseek_credential_verify');
      await saveProviderVerifyStatus('deepseek', result.success ? 'valid' : 'invalid');
      if (result.success) {
        toast.success('DeepSeek 连接正常');
      } else {
        toast.error(result.error || 'DeepSeek 连接检查失败');
      }
    } catch (error) {
      await saveProviderVerifyStatus('deepseek', 'invalid');
      toast.error(error instanceof Error ? error.message : 'DeepSeek 连接检查失败');
    } finally {
      setChecking(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await deleteApiKey('deepseek');
      toast.success('凭据已从 Windows 凭据管理器移除');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '移除凭据失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="h-full overflow-y-auto bg-[var(--paper)] px-8 py-10 text-[var(--ink)]">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold">连接设置</h1>
        <p className="mt-2 text-sm text-[var(--ink-muted)]">
          小鲸同学固定使用 DeepSeek V4 Pro（高推理）。这里不提供任意模型或 Runtime 切换。
        </p>

        <section className="mt-8 rounded-2xl border border-[var(--line)] bg-[var(--paper-raised)] p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-medium">DeepSeek 主连接</h2>
              <p className="mt-1 text-sm text-[var(--ink-muted)]">api.deepseek.com · deepseek-v4-pro</p>
            </div>
            <div className="flex items-center gap-2 text-sm">
              {health === 'valid' ? <CheckCircle2 className="h-4 w-4 text-[var(--success)]" /> : <ShieldCheck className="h-4 w-4" />}
              {healthLabel}
            </div>
          </div>

          <div className="mt-6">
            <label htmlFor="deepseek-key" className="text-sm font-medium">API Key</label>
            <div className="mt-2 flex gap-2">
              <div className="relative flex-1">
                <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ink-muted)]" />
                <input
                  id="deepseek-key"
                  type="password"
                  autoComplete="off"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={configured ? '已安全保存；输入新 Key 可替换' : '输入 DeepSeek API Key'}
                  className="w-full rounded-xl border border-[var(--line)] bg-[var(--paper)] py-2.5 pl-10 pr-3 text-sm outline-none focus:border-[var(--focus-border)]"
                />
              </div>
              <button type="button" disabled={!draft.trim() || saving} onClick={() => void save()} className="rounded-xl bg-[var(--button-primary-bg)] px-4 text-sm font-medium text-[var(--button-primary-text)] disabled:opacity-50">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : '安全保存'}
              </button>
            </div>
            <p className="mt-2 text-xs text-[var(--ink-muted)]">
              安装版凭据仅存于 Windows 凭据管理器；界面、品牌数据库和会话记录都无法读取明文。
            </p>
          </div>

          <div className="mt-6 flex gap-2 border-t border-[var(--line)] pt-5">
            <button type="button" disabled={!configured || checking} onClick={() => void verify()} className="flex items-center gap-2 rounded-xl border border-[var(--line)] px-3 py-2 text-sm disabled:opacity-50">
              {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              检查连接
            </button>
            <button type="button" disabled={!configured || saving} onClick={() => void remove()} className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-[var(--error)] disabled:opacity-50">
              <Trash2 className="h-4 w-4" />移除凭据
            </button>
          </div>
        </section>

        <p className="mt-5 text-xs text-[var(--ink-muted)]">
          开发环境如未配置，请仅在本机 .env/启动环境中提供 DEEPSEEK_API_KEY；不要把真实值写入代码、测试、日志或安装资源。
        </p>
      </div>
    </main>
  );
}
