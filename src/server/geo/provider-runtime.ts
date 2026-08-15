import { resolveXiaojingDeepseekSecret } from "../xiaojing-native-secret";
import {
  captureGeoProviderRuntimeSecrets,
  createGeoProviderCapabilities,
  type GeoProviderCapabilities,
} from "./provider-capabilities";

// Capture once at module birth. `xiaojing-geo-tool` imports this module while
// the Session Sidecar is composing, before any generic subprocess can inherit
// the Rust transport variables.
const runtimeSecrets = captureGeoProviderRuntimeSecrets();
runtimeSecrets.deepseekApiKey = resolveXiaojingDeepseekSecret();

let capabilities: GeoProviderCapabilities | undefined;

export function getXiaojingGeoProviderCapabilities(): GeoProviderCapabilities {
  capabilities ??= createGeoProviderCapabilities(runtimeSecrets);
  return capabilities;
}
