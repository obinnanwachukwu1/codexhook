import type { Turn } from "./protocol.js";
import {
  type DesktopCommand,
  type DesktopTaskProtocol,
} from "./desktop-task-protocol.js";
import {
  DesktopThreadState,
  type DesktopTaskSnapshot,
} from "./desktop-state.js";
import {
  captureDesktopProof,
  findProvenStartTurn,
  type DesktopInjectionOutcome,
  provesDesktopInjection,
} from "./desktop-injection.js";
import {
  desktopErrorMessage,
  DesktopTimeoutError,
  withDesktopTimeout,
} from "./desktop-errors.js";
import { DesktopProtocolError } from "./desktop-ipc/index.js";
import type { NotSubmittedReason } from "../contracts/submission.js";

interface DesktopAttachmentOptions {
  readonly followTimeoutMs?: number;
  readonly proofTimeoutMs?: number;
}

/** Semantic task state and proof layered over one raw Desktop session. */
export class DesktopAttachment {
  private closed = false;
  private generation = 1;
  private readonly followed = new Set<string>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly resyncing = new Set<string>();
  private readonly states = new Map<string, DesktopThreadState>();
  private readonly followTimeoutMs: number;
  private readonly proofTimeoutMs: number;
  private readonly unbind: () => void;

  constructor(
    private readonly protocol: DesktopTaskProtocol,
    options: DesktopAttachmentOptions = {},
  ) {
    this.followTimeoutMs = options.followTimeoutMs ?? 5_000;
    this.proofTimeoutMs = options.proofTimeoutMs ?? 5_000;
    this.unbind = this.bind();
  }

  get connected(): boolean {
    return !this.closed && this.protocol.connected;
  }

  state(threadId: string): DesktopTaskSnapshot {
    return this.getState(threadId).evidence();
  }

  async resume(threadId: string): Promise<ReadonlyArray<Turn>> {
    return this.serialize(threadId, async () => {
      const state = this.getState(threadId);
      await this.synchronize(state);
      return state.turnsSnapshot();
    });
  }

  async inject(command: DesktopCommand): Promise<DesktopInjectionOutcome> {
    return this.serialize(command.threadId, async () => {
      const state = this.getState(command.threadId);
      state.setInjection("idle");
      try {
        await this.synchronize(state);
      } catch (cause) {
        return this.notSubmitted(state, desktopErrorMessage(cause));
      }
      const invalid = this.validationFailure(command, state);
      if (invalid != null) {
        const taskBusy = state.hasMultipleActiveTurns() ||
          (command.kind === "start" && state.activeTurn() != null);
        return this.notSubmitted(
          state,
          invalid,
          taskBusy ? "task-busy" : "pre-submit-failure",
        );
      }
      const baseline = captureDesktopProof(command, state);
      state.setInjection("injecting");

      let turnId: string | null = command.kind === "start"
        ? null
        : command.expectedTurnId;
      let postWriteFailure: unknown = null;
      try {
        const reply = await this.protocol.inject(command);
        if (reply._tag === "Rejected") {
          return reply.notWritten
            ? this.notSubmitted(
                state,
                reply.reason,
                reply.confirmedNoSubmission
                  ? "confirmed-not-submitted"
                  : "pre-submit-failure",
              )
            : this.rejected(state, reply.reason);
        }
        if (command.kind === "start") turnId = reply.turnId;
      } catch (cause) {
        if (
          cause instanceof DesktopProtocolError &&
          cause.writeState === "not-written"
        ) return this.notSubmitted(state, cause.failure);
        postWriteFailure = cause;
      }

      try {
        await state.waitFor(
          () => this.provenTurnId(command, state, turnId, baseline) != null ||
            state.connection === "disconnected",
          Math.min(command.timeoutMs ?? this.proofTimeoutMs, this.proofTimeoutMs),
        );
      } catch (cause) {
        return this.ambiguous(
          state,
          desktopErrorMessage(postWriteFailure ?? cause),
        );
      }
      const provenTurnId = this.provenTurnId(command, state, turnId, baseline);
      if (provenTurnId == null) {
        return this.ambiguous(
          state,
          desktopErrorMessage(
            postWriteFailure ??
              new Error("Desktop state did not confirm the command"),
          ),
        );
      }
      const turn = state.turn(provenTurnId);
      if (turn == null) {
        return this.ambiguous(state, "Desktop confirmation lost its turn");
      }
      state.setInjection("confirmed");
      return {
        _tag: "Confirmed",
        turnId: provenTurnId,
        turn,
        state: state.evidence(),
      };
    });
  }

  async awaitTurn(
    threadId: string,
    turnId: string,
    timeoutMs: number,
  ): Promise<Turn> {
    const state = this.states.get(threadId) ?? null;
    if (state == null) throw new Error("Desktop task was not followed");
    await state.waitFor(() => {
      const turn = state.turn(turnId);
      return (turn != null && turn.status !== "inProgress") ||
        state.connection === "disconnected";
    }, timeoutMs);
    const turn = state.turn(turnId);
    if (turn == null || turn.status === "inProgress") {
      throw new Error("Desktop disconnected while observing the turn");
    }
    return turn;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unbind();
    this.protocol.close();
    this.followed.clear();
    this.resyncing.clear();
    for (const state of this.states.values()) state.disconnected();
  }

  private bind(): () => void {
    const removeChange = this.protocol.onChange((threadId, change) => {
      if (this.closed) return;
      const state = this.states.get(threadId);
      if (state == null) return;
      const result = state.apply(change, this.generation);
      if (result === "applied" && state.ready) {
        this.resyncing.delete(threadId);
      } else if (result === "resync") {
        this.requestResync(state);
      }
    });
    const removeConnection = this.protocol.onConnection((event) => {
      if (this.closed) return;
      if (event === "Reconnecting") {
        this.generation += 1;
        for (const state of this.states.values()) {
          state.beginFollowing(this.generation);
        }
      } else if (event === "Reconnected") {
        for (const state of this.states.values()) {
          if (state.connection === "connecting") {
            state.beginFollowing(this.generation);
          }
        }
      } else if (event === "Disconnected") {
        this.resyncing.clear();
        for (const state of this.states.values()) state.disconnected();
      }
    });
    return () => {
      removeChange();
      removeConnection();
    };
  }

  private getState(threadId: string): DesktopThreadState {
    let state = this.states.get(threadId);
    if (state == null) {
      state = new DesktopThreadState(threadId);
      this.states.set(threadId, state);
    }
    return state;
  }

  private async synchronize(state: DesktopThreadState): Promise<void> {
    if (this.closed) throw new Error("Desktop attachment is closed");
    if (state.ready) return;
    const deadline = Date.now() + this.followTimeoutMs;
    const followedBefore = this.followed.has(state.threadId);
    if (!this.protocol.connected) {
      if (
        state.attachment !== "following" ||
        state.generation !== this.generation
      ) state.beginConnecting();
    } else if (
      state.attachment !== "following" ||
      state.generation !== this.generation
    ) state.beginFollowing(this.generation);
    const remaining = Math.max(1, deadline - Date.now());
    if (followedBefore) {
      const accepted = await withDesktopTimeout(
        this.protocol.loadHistory(state.threadId),
        remaining,
        "Desktop follow timed out",
      );
      if (!accepted) throw new Error("Desktop history request was rejected");
    } else {
      await withDesktopTimeout(
        this.protocol.follow(state.threadId),
        remaining,
        "Desktop follow timed out",
      );
      this.followed.add(state.threadId);
    }
    if (this.closed) throw new Error("Desktop attachment is closed");
    await state.waitFor(
      () => state.ready || state.connection === "disconnected",
      Math.max(1, deadline - Date.now()),
    );
    if (!state.ready) {
      throw new DesktopTimeoutError("Desktop disconnected while following");
    }
  }

  private requestResync(state: DesktopThreadState): void {
    if (this.resyncing.has(state.threadId) || this.closed) return;
    this.resyncing.add(state.threadId);
    void this.protocol.loadHistory(state.threadId).then((reply) => {
      if (reply === false) this.resyncing.delete(state.threadId);
    }, () => {
      this.resyncing.delete(state.threadId);
    });
  }

  private validationFailure(
    command: DesktopCommand,
    state: DesktopThreadState,
  ): string | null {
    if (state.hasMultipleActiveTurns()) {
      return "Desktop task has multiple active turns";
    }
    const active = state.activeTurn();
    if (command.kind === "start" && active != null) {
      return "Desktop task already has an active turn";
    }
    if (
      command.kind === "steer" &&
      (active == null || active.id !== command.expectedTurnId)
    ) return "Desktop active turn no longer matches the requested turn";
    if (command.kind === "steer" && !command.clientUserMessageId) {
      return "Desktop steer requires a delivery identity";
    }
    return null;
  }

  private provenTurnId(
    command: DesktopCommand,
    state: DesktopThreadState,
    turnId: string | null,
    baseline: ReturnType<typeof captureDesktopProof>,
  ): string | null {
    if (turnId != null && provesDesktopInjection(
      command,
      state,
      turnId,
      baseline,
    )) return turnId;
    return command.kind === "start"
      ? findProvenStartTurn(command, state, baseline)
      : null;
  }

  private notSubmitted(
    state: DesktopThreadState,
    reason: string,
    submissionReason: NotSubmittedReason = "pre-submit-failure",
  ) {
    state.setInjection("idle");
    return {
      _tag: "NotSubmitted" as const,
      reason,
      submissionReason,
      state: state.evidence(),
    };
  }

  private ambiguous(state: DesktopThreadState, reason: string) {
    state.setInjection("uncertain");
    return { _tag: "Ambiguous" as const, reason, state: state.evidence() };
  }

  private rejected(state: DesktopThreadState, reason: string) {
    state.setInjection("rejected");
    return { _tag: "Rejected" as const, reason, state: state.evidence() };
  }

  private serialize<T>(threadId: string, command: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(threadId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.queues.set(threadId, current);
    return previous.catch(() => undefined).then(command).finally(() => {
      release();
      if (this.queues.get(threadId) === current) this.queues.delete(threadId);
    });
  }
}
