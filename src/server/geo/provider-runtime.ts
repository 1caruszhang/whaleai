import { resolveXiaojingDeepseekOpenAiBaseUrl, resolveXiaojingDeepseekSecret } from "../xiaojing-native-secret";
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
