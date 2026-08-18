import { resolveXiaojingDeepseekOpenAiBaseUrl, resolveXiaojingDeepseekSecret } from "../xiaojing-native-secret";
import {
  createGatewayBillingPermitChannel,
  type GeoBillingPermitChannel,
} from "./billing-permit";
import {
  captureGeoProviderRuntimeSecrets,
  createGeoProviderCapabilities,
  type GeoProviderCapabilities,
} from "./provider-capabilities";
import {
  configureGeoProviderAdmission,
  wrapGeoProviderCapabilities,
} from "./provider-admission";

// Capture once at module birth. `xiaojing-geo-tool` imports this module while
// the Session Sidecar is composing, before any generic subprocess can inherit
// the Rust transport variables.
const runtimeSecrets = captureGeoProviderRuntimeSecrets();
runtimeSecrets.deepseekApiKey = resolveXiaojingDeepseekSecret();
runtimeSecrets.deepseekOpenAiBaseUrl = resolveXiaojingDeepseekOpenAiBaseUrl();

let capabilities: GeoProviderCapabilities | undefined;

export function getXiaojingGeoProviderCapabilities(): GeoProviderCapabilities {
  capabilities ??= wrapGeoProviderCapabilities(
    createGeoProviderCapabilities(runtimeSecrets),
  );
  return capabilities;
}

export function configureXiaojingGeoProviderAdmission(input: {
  workspacePath?: string;
  sessionId: string;
}): void {
  configureGeoProviderAdmission(input);
}

// ---------------------------------------------------------------------------
// 网关计费 permit 通道（票 07）
// ---------------------------------------------------------------------------

let billingPermitChannel: GeoBillingPermitChannel | null | undefined;

/**
 * 账号 admission 注入的网关运行时（基地址 + 账号 token）齐备时返回 permit
 * 通道，供各计费域服务在操作边界申请/回报；开发直连模式返回 undefined，
 * 服务侧跳过全部计费路径（浏览/预览/读取历史永不触碰）。
 */
export function getXiaojingGeoBillingPermitChannel(): GeoBillingPermitChannel | undefined {
  if (billingPermitChannel === undefined) {
    billingPermitChannel =
      runtimeSecrets.gatewayBaseUrl && runtimeSecrets.accountAccessToken
        ? createGatewayBillingPermitChannel({
            baseUrl: runtimeSecrets.gatewayBaseUrl,
            accessToken: runtimeSecrets.accountAccessToken,
          })
        : null;
  }
  return billingPermitChannel ?? undefined;
}
