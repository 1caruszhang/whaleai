export type GeoAutonomyProfile = "manual" | "auto";

/**
 * The workspace-wide autonomy dial. `manual` is the default and keeps every
 * confirmation gate user-owned. `auto` lets the Sidecar confirm — without the
 * user — only the gates listed in AUTO_CONFIRMABLE_CONFIRMATION_KINDS.
 */
export const GEO_AUTONOMY_PROFILES: readonly GeoAutonomyProfile[] = [
  "manual",
  "auto",
];

/**
 * Zero-cost, reversible selection gates whose hard gates (baseline probe,
 * article approval, paid publish, monitoring activation) still stop
 * downstream. Every other confirmation kind stays user-owned in every
 * profile; this set is the only widening `auto` can ever do.
 */
export const AUTO_CONFIRMABLE_CONFIRMATION_KINDS: readonly string[] = [
  "question-selection",
];

export function normalizeGeoAutonomyProfile(
  value: string | undefined,
): GeoAutonomyProfile {
  return value === "auto" ? "auto" : "manual";
}

export function gateAutoConfirms(
  profile: GeoAutonomyProfile,
  confirmationKind: string,
): boolean {
  return (
    profile === "auto" &&
    AUTO_CONFIRMABLE_CONFIRMATION_KINDS.includes(confirmationKind)
  );
}
