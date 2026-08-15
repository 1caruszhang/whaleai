import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

import { useToast } from "@/components/Toast";
import {
  GEO_PROVIDER_CAPABILITY_CATALOG,
  type GeoProviderCapabilitySlot,
  type GeoProviderCapabilityState,
  type GeoProviderCapabilityStatus,
  type GeoProviderServiceId,
} from "../../../shared/geo/providerCapabilities";

type Drafts = Record<GeoProviderServiceId, Record<string, string>>;
type VerifyResult = { success: boolean; error?: string };

const EMPTY_DRAFTS: Drafts = {
  deepseek: { apiKey: "" },
  ark: { apiKey: "" },
  embedding: { apiKey: "", endpointId: "" },
  "object-storage": {
    accessKeyId: "",
    accessKeySecret: "",
    bucket: "",
    region: "",
    publicBaseUrl: "",
  },
  distribution: { appId: "", secret: "", baseUrl: "" },
};

const SERVICE_LABELS: Record<GeoProviderServiceId, string> = {
  deepseek: "DeepSeek",
  ark: "豆包 / ARK",
  embedding: "ARK Embedding",
  "object-storage": "阿里云 OSS",
  distribution: "超级媒介",
};

const SERVICE_FIELDS: Record<
  GeoProviderServiceId,
  Array<{
    key: string;
    label: string;
    secret?: boolean;
    placeholder?: string;
  }>
> = {
  deepseek: [{ key: "apiKey", label: "API Key", secret: true }],
  ark: [{ key: "apiKey", label: "Paygo API Key", secret: true }],
  embedding: [
    { key: "endpointId", label: "Embedding 接入点 ID", placeholder: "ep-…" },
    {
      key: "apiKey",
      label: "独立 API Key（可选）",
      secret: true,
      placeholder: "留空则复用 ARK Paygo Key",
    },
  ],
  "object-storage": [
    { key: "accessKeyId", label: "AccessKey ID", secret: true },
    { key: "accessKeySecret", label: "AccessKey Secret", secret: true },
    { key: "bucket", label: "Bucket" },
    { key: "region", label: "Region（可选）", placeholder: "oss-cn-beijing" },
    {
      key: "publicBaseUrl",
      label: "公开访问地址（可选）",
      placeholder: "https://…",
    },
  ],
  distribution: [
    { key: "appId", label: "AppID", secret: true },
    { key: "secret", label: "通信密钥", secret: true },
    {
      key: "baseUrl",
      label: "API 地址（可选）",
      placeholder: "https://vip.chaojimeijie.com/api",
    },
  ],
};

const STATE_LABELS: Record<GeoProviderCapabilityState, string> = {
  unconfigured: "未配置",
  verifying: "验证中",
  available: "可用",
  rate_limited: "限流",
  failed: "失败",
};

function stateIcon(state: GeoProviderCapabilityState) {
  if (state === "verifying")
    return <Loader2 className="h-4 w-4 animate-spin" />;
  if (state === "available")
    return <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />;
  if (state === "failed" || state === "rate_limited")
    return <CircleAlert className="h-4 w-4 text-[var(--error)]" />;
  return <ShieldCheck className="h-4 w-4 text-[var(--ink-muted)]" />;
}

/** Fixed capability settings surface; no model/runtime marketplace is reachable here. */
export default function XiaojingConnectionSettings() {
  const toast = useToast();
  const [statuses, setStatuses] = useState<GeoProviderCapabilityStatus[]>([]);
  const [drafts, setDrafts] = useState<Drafts>(EMPTY_DRAFTS);
  const [busyService, setBusyService] = useState<GeoProviderServiceId | null>(
    null,
  );

  const statusBySlot = useMemo(
    () => new Map(statuses.map((status) => [status.slot, status])),
    [statuses],
  );

  const refresh = async () => {
    const next = await invoke<GeoProviderCapabilityStatus[]>(
      "cmd_geo_provider_capability_status",
    );
    setStatuses(next);
  };

  useEffect(() => {
    void refresh().catch(() => setStatuses([]));
  }, []);

  const updateDraft = (
    service: GeoProviderServiceId,
    key: string,
    value: string,
  ) => {
    setDrafts((current) => ({
      ...current,
      [service]: { ...current[service], [key]: value },
    }));
  };

  const save = async (service: GeoProviderServiceId) => {
    if (busyService) return;
    setBusyService(service);
    try {
      const fields = Object.fromEntries(
        Object.entries(drafts[service])
          .filter(([, value]) => value.trim())
          .map(([key, value]) => [key, value.trim()]),
      );
      if (service === "deepseek") {
        await invoke("cmd_deepseek_credential_save", { apiKey: fields.apiKey });
      } else {
        const next = await invoke<GeoProviderCapabilityStatus[]>(
          "cmd_geo_provider_credentials_save",
          {
            serviceId: service,
            fields,
          },
        );
        setStatuses(next);
      }
      setDrafts((current) => ({
        ...current,
        [service]: { ...EMPTY_DRAFTS[service] },
      }));
      await refresh();
      toast.success(`${SERVICE_LABELS[service]} 配置已安全保存`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存服务配置失败");
    } finally {
      setBusyService(null);
    }
  };

  const remove = async (service: GeoProviderServiceId) => {
    if (busyService) return;
    setBusyService(service);
    try {
      if (service === "deepseek") {
        await invoke("cmd_deepseek_credential_delete");
      } else {
        const next = await invoke<GeoProviderCapabilityStatus[]>(
          "cmd_geo_provider_credentials_delete",
          {
            serviceId: service,
          },
        );
        setStatuses(next);
      }
      await refresh();
      toast.success(`${SERVICE_LABELS[service]} 配置已移除`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "移除服务配置失败");
    } finally {
      setBusyService(null);
    }
  };

  const verify = async (slot: GeoProviderCapabilitySlot) => {
    const current = statusBySlot.get(slot);
    if (!current || current.state === "unconfigured") return;
    setStatuses((items) =>
      items.map((item) =>
        item.slot === slot
          ? { ...item, state: "verifying", detail: "正在验证连接" }
          : item,
      ),
    );
    try {
      if (["main-agent", "extraction", "reflection"].includes(slot)) {
        const result = await invoke<VerifyResult>(
          "cmd_deepseek_credential_verify",
        );
        const state: GeoProviderCapabilityState = result.success
          ? "available"
          : result.error?.includes("频繁")
            ? "rate_limited"
            : "failed";
        setStatuses((items) =>
          items.map((item) =>
            ["main-agent", "extraction", "reflection"].includes(item.slot)
              ? { ...item, state, detail: result.error ?? "连接验证成功" }
              : item,
          ),
        );
        if (!result.success)
          toast.error(result.error || "DeepSeek 连接检查失败");
      } else {
        const result = await invoke<GeoProviderCapabilityStatus>(
          "cmd_geo_provider_capability_verify",
          { slot },
        );
        setStatuses((items) =>
          items.map((item) => (item.slot === slot ? result : item)),
        );
        if (result.state === "failed" || result.state === "rate_limited") {
          toast.error(result.detail || "连接检查失败");
        }
      }
    } catch (error) {
      setStatuses((items) =>
        items.map((item) =>
          item.slot === slot
            ? { ...item, state: "failed", detail: "连接检查失败" }
            : item,
        ),
      );
      toast.error(error instanceof Error ? error.message : "连接检查失败");
    }
  };

  const serviceConfigured = (service: GeoProviderServiceId) =>
    statuses.some(
      (status) =>
        GEO_PROVIDER_CAPABILITY_CATALOG.find(({ slot }) => slot === status.slot)
          ?.serviceId === service && status.state !== "unconfigured",
    );

  return (
    <main className="h-full overflow-y-auto bg-[var(--paper)] px-8 py-10 text-[var(--ink)]">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-2xl font-semibold">服务能力</h1>
        <p className="mt-2 text-sm text-[var(--ink-muted)]">
          小鲸只开放 GEO
          所需的固定能力槽位。模型与端点由产品策略固定，不提供通用模型市场或
          Runtime 切换。
        </p>

        <section className="mt-8 rounded-2xl border border-[var(--line)] bg-[var(--paper-raised)] p-6">
          <h2 className="font-medium">能力状态</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {GEO_PROVIDER_CAPABILITY_CATALOG.map((spec) => {
              const status = statusBySlot.get(spec.slot) ?? {
                slot: spec.slot,
                state: "unconfigured" as const,
                source: "missing" as const,
              };
              return (
                <div
                  key={spec.slot}
                  className="rounded-xl border border-[var(--line)] bg-[var(--paper)] p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">{spec.label}</div>
                      <div className="mt-1 text-xs text-[var(--ink-muted)]">
                        {spec.provider}
                        {spec.model ? ` · ${spec.model}` : ""}
                      </div>
                    </div>
                    <span
                      className="flex items-center gap-1.5 text-xs"
                      data-testid={`capability-${spec.slot}-status`}
                    >
                      {stateIcon(status.state)}
                      {STATE_LABELS[status.state]}
                    </span>
                  </div>
                  {status.detail && (
                    <p className="mt-2 text-xs text-[var(--ink-muted)]">
                      {status.detail}
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={
                      status.state === "unconfigured" ||
                      status.state === "verifying"
                    }
                    onClick={() => void verify(spec.slot)}
                    className="mt-3 flex items-center gap-1.5 text-xs text-[var(--accent)] disabled:opacity-40"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    验证连接
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        <section className="mt-6 space-y-4">
          {(Object.keys(SERVICE_FIELDS) as GeoProviderServiceId[]).map(
            (service) => (
              <div
                key={service}
                className="rounded-2xl border border-[var(--line)] bg-[var(--paper-raised)] p-6"
              >
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="font-medium">{SERVICE_LABELS[service]}</h2>
                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                      {serviceConfigured(service)
                        ? "应用级配置已就绪，所有品牌共用服务能力。"
                        : "尚未配置。配置只属于应用，不写入任何品牌数据。"}
                    </p>
                  </div>
                  <KeyRound className="h-5 w-5 text-[var(--ink-muted)]" />
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {SERVICE_FIELDS[service].map((field) => (
                    <label key={field.key} className="text-xs font-medium">
                      {field.label}
                      <input
                        aria-label={`${SERVICE_LABELS[service]} ${field.label}`}
                        type={field.secret ? "password" : "text"}
                        autoComplete="off"
                        value={drafts[service][field.key] ?? ""}
                        onChange={(event) =>
                          updateDraft(service, field.key, event.target.value)
                        }
                        placeholder={
                          serviceConfigured(service)
                            ? "已安全保存；输入新值可替换"
                            : field.placeholder
                        }
                        className="mt-1.5 w-full rounded-xl border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 text-sm outline-none focus:border-[var(--focus-border)]"
                      />
                    </label>
                  ))}
                </div>
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    disabled={
                      busyService !== null ||
                      !Object.values(drafts[service]).some((value) =>
                        value.trim(),
                      )
                    }
                    onClick={() => void save(service)}
                    className="rounded-xl bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] disabled:opacity-50"
                  >
                    {busyService === service ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      "安全保存"
                    )}
                  </button>
                  <button
                    type="button"
                    disabled={
                      busyService !== null || !serviceConfigured(service)
                    }
                    onClick={() => void remove(service)}
                    className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm text-[var(--error)] disabled:opacity-40"
                  >
                    <Trash2 className="h-4 w-4" />
                    移除
                  </button>
                </div>
              </div>
            ),
          )}
        </section>

        <p className="mt-5 text-xs text-[var(--ink-muted)]">
          Windows 安装版凭据仅存于系统凭据管理器；开发环境可使用项目 .env
          中的空占位变量。连接错误只显示脱敏状态，不显示密钥片段或上游请求正文。
        </p>
      </div>
    </main>
  );
}
