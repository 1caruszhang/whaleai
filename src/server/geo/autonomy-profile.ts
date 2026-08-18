import {
  normalizeGeoAutonomyProfile,
  type GeoAutonomyProfile,
} from "../../shared/geo/autonomy";

/**
 * Rust reads `config.json::geoAutonomyProfile` and injects it as
 * XIAOJING_GEO_AUTONOMY_PROFILE at Sidecar spawn (brand-workspace sessions
 * only). Unknown or missing values always resolve to "manual".
 */
export function currentGeoAutonomyProfile(): GeoAutonomyProfile {
  return normalizeGeoAutonomyProfile(process.env.XIAOJING_GEO_AUTONOMY_PROFILE);
}
