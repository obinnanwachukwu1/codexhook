import type { SanitizedDiagnostic } from "./diagnostics.js";

export const PROTOCOL_FEATURES = [
  "task-list",
  "task-history",
  "task-events",
  "task-follow",
  "turn-start",
  "turn-steer",
  "delivery-id",
] as const;

export type ProtocolFeature = (typeof PROTOCOL_FEATURES)[number];
export type ProtocolPlane = "app-server" | "desktop-ipc";

export interface ProtocolRequirement {
  readonly plane: ProtocolPlane;
  readonly major: number;
  readonly minimumRevision: number;
  readonly requiredFeatures: ReadonlyArray<ProtocolFeature>;
}

export interface ProtocolOffer {
  readonly plane: ProtocolPlane;
  readonly major: number;
  readonly revision: number;
  readonly features: ReadonlyArray<ProtocolFeature>;
}

export type ProtocolCompatibility =
  | {
      readonly status: "compatible";
      readonly plane: ProtocolPlane;
      readonly major: number;
      readonly revision: number;
      readonly features: ReadonlyArray<ProtocolFeature>;
    }
  | {
      readonly status: "incompatible";
      readonly plane: ProtocolPlane;
      readonly reason:
        | "wrong-plane"
        | "major-mismatch"
        | "revision-too-old"
        | "missing-feature";
      readonly missingFeatures: ReadonlyArray<ProtocolFeature>;
    };

export type CompatibleProtocol = Extract<
  ProtocolCompatibility,
  { readonly status: "compatible" }
>;

export type ProtocolAvailability =
  | {
      readonly status: "available";
      readonly offer: ProtocolOffer;
      readonly compatibility: CompatibleProtocol;
    }
  | {
      readonly status: "unavailable" | "incompatible";
      readonly diagnostic: SanitizedDiagnostic;
    };

export function checkProtocolCompatibility(
  requirement: ProtocolRequirement,
  offer: ProtocolOffer,
): ProtocolCompatibility {
  if (offer.plane !== requirement.plane) {
    return {
      status: "incompatible",
      plane: requirement.plane,
      reason: "wrong-plane",
      missingFeatures: [],
    };
  }
  if (offer.major !== requirement.major) {
    return {
      status: "incompatible",
      plane: requirement.plane,
      reason: "major-mismatch",
      missingFeatures: [],
    };
  }
  if (offer.revision < requirement.minimumRevision) {
    return {
      status: "incompatible",
      plane: requirement.plane,
      reason: "revision-too-old",
      missingFeatures: [],
    };
  }
  const offered = new Set(offer.features);
  const missingFeatures = requirement.requiredFeatures.filter(
    (feature) => !offered.has(feature),
  );
  if (missingFeatures.length > 0) {
    return {
      status: "incompatible",
      plane: requirement.plane,
      reason: "missing-feature",
      missingFeatures,
    };
  }
  return {
    status: "compatible",
    plane: requirement.plane,
    major: offer.major,
    revision: offer.revision,
    features: [...offer.features],
  };
}
