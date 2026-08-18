import type { Turn } from "./protocol.js";
import type { DesktopTaskSnapshot } from "./desktop-state.js";

interface DesktopInjectionFailure<Tag extends string> {
  readonly _tag: Tag;
  readonly reason: string;
  readonly state: DesktopTaskSnapshot;
}

export type DesktopInjectionOutcome =
  | {
      readonly _tag: "Confirmed";
      readonly turnId: string;
      readonly turn: Turn;
      readonly state: DesktopTaskSnapshot;
    }
  | DesktopInjectionFailure<"NotSubmitted">
  | DesktopInjectionFailure<"Ambiguous">
  | DesktopInjectionFailure<"Rejected">;

export function desktopOutcomeDetail(
  result: Exclude<DesktopInjectionOutcome, { readonly _tag: "Confirmed" }>,
): string {
  const state = result.state;
  return `${result.reason} (connection=${state.connection}, ` +
    `attachment=${state.attachment}, injection=${state.injection}, ` +
    `revision=${state.revision ?? "unknown"}, generation=${state.generation})`;
}
