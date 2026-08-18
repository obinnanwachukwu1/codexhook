import type { Turn } from "./protocol.js";
import type {
  DesktopTaskSnapshot,
  DesktopThreadState,
} from "./desktop-state.js";
import type { DesktopCommand } from "./desktop-task-protocol.js";
import type { NotSubmittedReason } from "../contracts/submission.js";

interface DesktopInjectionFailure<Tag extends string> {
  readonly _tag: Tag;
  readonly reason: string;
  readonly state: DesktopTaskSnapshot;
  readonly submissionReason?: NotSubmittedReason;
}

export interface DesktopProofBaseline {
  readonly deliveryObserved: boolean;
  readonly generation: number;
  readonly revision: number | null;
  readonly turnIds: ReadonlySet<string>;
}

export function captureDesktopProof(
  command: DesktopCommand,
  state: DesktopThreadState,
): DesktopProofBaseline {
  return {
    deliveryObserved: state.hasDelivery(
      command.clientUserMessageId,
      command.kind === "steer" ? command.expectedTurnId : undefined,
    ),
    generation: state.generation,
    revision: state.revision,
    turnIds: new Set(state.turnsSnapshot().map((turn) => turn.id)),
  };
}

export function findProvenStartTurn(
  command: Extract<DesktopCommand, { readonly kind: "start" }>,
  state: DesktopThreadState,
  baseline: DesktopProofBaseline,
): string | null {
  if (
    !state.ready ||
    state.generation !== baseline.generation ||
    baseline.revision == null ||
    state.revision == null ||
    state.revision <= baseline.revision ||
    baseline.deliveryObserved ||
    !state.hasDelivery(command.clientUserMessageId)
  ) return null;
  const novel = state.turnsSnapshot().filter(
    (turn) => !baseline.turnIds.has(turn.id),
  );
  return novel.length === 1 ? novel[0]?.id ?? null : null;
}

export function provesDesktopInjection(
  command: DesktopCommand,
  state: DesktopThreadState,
  turnId: string,
  baseline: DesktopProofBaseline,
): boolean {
  if (!state.ready || state.generation !== baseline.generation ||
      baseline.revision == null || state.revision == null ||
      state.revision <= baseline.revision) return false;
  const turn = state.turn(turnId);
  if (turn == null) return false;
  if (command.kind === "steer") {
    return !baseline.deliveryObserved &&
      state.hasDelivery(command.clientUserMessageId, turnId);
  }
  return !baseline.turnIds.has(turnId);
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
