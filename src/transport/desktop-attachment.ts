import type { Turn } from "./protocol.js";
import {
  type DesktopCommand,
  type DesktopTaskProtocol,
  type DesktopProtocolConnector,
} from "./desktop-task-protocol.js";
import {
  DesktopThreadState,
  type DesktopTaskSnapshot,
} from "./desktop-state.js";
import type { DesktopInjectionOutcome } from "./desktop-injection.js";
import {
  desktopErrorMessage,
  DesktopTimeoutError,
  withDesktopTimeout,
} from "./desktop-errors.js";

interface DesktopAttachmentOptions {
  readonly followTimeoutMs?: number;
  readonly proofTimeoutMs?: number;
}

export class DesktopAttachment {
  private closed = false;
  private connectPromise: Promise<DesktopTaskProtocol> | null = null;
  private generation = 0;
  private protocol: DesktopTaskProtocol | null;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly resyncing = new Set<string>();
  private readonly states = new Map<string, DesktopThreadState>();
  private readonly followTimeoutMs: number;
  private readonly proofTimeoutMs: number;
  private unbindProtocol: () => void = () => undefined;
  constructor(
    private readonly connector: DesktopProtocolConnector,
    initialProtocol?: DesktopTaskProtocol,
    options: DesktopAttachmentOptions = {},
  ) {
    this.followTimeoutMs = options.followTimeoutMs ?? 5_000;
    this.proofTimeoutMs = options.proofTimeoutMs ?? 5_000;
    this.protocol = initialProtocol ?? null;
    if (initialProtocol != null) this.bind(initialProtocol);
  }

  get connected(): boolean {
    return this.protocol?.connected === true;
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
      if (invalid != null) return this.notSubmitted(state, invalid);
      const baseline = state.revision;
      const generation = state.generation;
      const protocol = this.protocol;
      if (protocol == null) {
        return this.notSubmitted(state, "Desktop is not connected");
      }
      state.setInjection("injecting");
      let reply;
      try {
        reply = await protocol.inject(command);
      } catch (cause) {
        return this.ambiguous(state, desktopErrorMessage(cause));
      }
      if (reply._tag === "Rejected") {
        if (reply.notWritten) {
          return this.notSubmitted(state, reply.reason);
        }
        return this.rejected(state, reply.reason);
      }
      const turnId = command.kind === "start"
        ? reply.turnId
        : command.expectedTurnId;
      if (turnId == null || turnId.length === 0) {
        return this.ambiguous(
          state,
          "Desktop accepted the command without a turn identity",
        );
      }
      try {
        await state.waitFor(
          () => this.proves(command, state, turnId, baseline, generation) ||
            state.connection === "disconnected",
          this.proofTimeoutMs,
        );
      } catch (cause) {
        return this.ambiguous(state, desktopErrorMessage(cause));
      }
      if (!this.proves(command, state, turnId, baseline, generation)) {
        return this.ambiguous(
          state,
          "Desktop disconnected before state confirmed the command",
        );
      }
      const turn = state.turn(turnId);
      if (turn == null) {
        return this.ambiguous(state, "Desktop confirmation lost its turn");
      }
      state.setInjection("confirmed");
      return {
        _tag: "Confirmed",
        turnId,
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
    await state.waitFor(
      () => {
        const turn = state.turn(turnId);
        return (state.ready && turn != null && turn.status !== "inProgress") ||
          state.connection === "disconnected";
      },
      timeoutMs,
    );
    const turn = state.ready ? state.turn(turnId) : undefined;
    if (turn == null || turn.status === "inProgress") {
      throw new Error("Desktop disconnected while observing the turn");
    }
    return turn;
  }

  close(): void {
    this.closed = true;
    const protocol = this.protocol;
    if (protocol != null) {
      this.detachProtocol(protocol, true);
    } else {
      for (const state of this.states.values()) state.disconnected();
    }
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
    const deadline = Date.now() + this.followTimeoutMs;
    while (!state.ready) await this.followOnce(state, deadline);
  }

  private async followOnce(
    state: DesktopThreadState,
    deadline: number,
  ): Promise<void> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new DesktopTimeoutError("Desktop follow timed out");
    const protocol = await withDesktopTimeout(
      this.ensureConnected(state),
      remaining,
      "Desktop follow timed out",
    );
    if (this.closed) {
      this.detachProtocol(protocol, true);
      state.disconnected();
      throw new Error("Desktop attachment is closed");
    }
    if (state.attachment === "detached") {
      state.beginFollowing(this.generation);
      try {
        await withDesktopTimeout(
          protocol.follow(state.threadId),
          Math.max(1, deadline - Date.now()),
          "Desktop follow timed out",
        );
        if (this.closed) {
          this.detachProtocol(protocol, true);
          state.disconnected();
          throw new Error("Desktop attachment is closed");
        }
      } catch (cause) {
        this.detachProtocol(protocol, true);
        throw cause;
      }
    }
    try {
      await state.waitFor(
        () => state.ready || state.connection === "disconnected",
        Math.max(1, deadline - Date.now()),
      );
    } catch (cause) {
      this.resyncing.delete(state.threadId);
      state.retryFollowing();
      throw cause;
    }
  }

  private async ensureConnected(
    state: DesktopThreadState,
  ): Promise<DesktopTaskProtocol> {
    if (this.closed) throw new Error("Desktop attachment is closed");
    if (this.protocol?.connected === true) return this.protocol;
    state.beginConnecting();
    if (this.connectPromise == null) {
      const previous = this.protocol;
      this.connectPromise = this.connector().then(async (protocol) => {
        if (this.closed) {
          protocol.close();
          throw new Error("Desktop attachment is closed");
        }
        if (previous !== protocol && previous != null) {
          this.detachProtocol(previous, true);
        }
        this.protocol = protocol;
        this.bind(protocol);
        try {
          await Promise.all([...this.states.values()].map(async (candidate) => {
            candidate.beginFollowing(this.generation);
            await protocol.follow(candidate.threadId);
          }));
          if (this.closed || this.protocol !== protocol) {
            this.detachProtocol(protocol, true);
            for (const candidate of this.states.values()) {
              candidate.disconnected();
            }
            throw new Error(this.closed
              ? "Desktop attachment is closed"
              : "Desktop disconnected while restoring subscriptions");
          }
        } catch (cause) {
          this.detachProtocol(protocol, true);
          throw cause;
        }
        return protocol;
      }).then(
        (protocol) => {
          this.connectPromise = null;
          return protocol;
        },
        (cause) => {
          this.connectPromise = null;
          throw cause;
        },
      );
    }
    return this.connectPromise;
  }

  private bind(protocol: DesktopTaskProtocol): void {
    this.unbindProtocol();
    const generation = ++this.generation;
    const removeChange = protocol.onChange((threadId, change) => {
      if (this.protocol !== protocol) return;
      const state = this.states.get(threadId);
      if (state == null) return;
      const result = state.apply(change, generation);
      if (result === "applied" && state.ready) {
        this.resyncing.delete(threadId);
      } else if (result === "resync") {
        this.requestResync(protocol, state);
      }
    });
    const removeDisconnect = protocol.onDisconnect(() => {
      this.detachProtocol(protocol, false);
    });
    this.unbindProtocol = () => {
      removeChange();
      removeDisconnect();
    };
  }

  private requestResync(
    protocol: DesktopTaskProtocol,
    state: DesktopThreadState,
  ): void {
    if (this.resyncing.has(state.threadId)) return;
    this.resyncing.add(state.threadId);
    void protocol.loadHistory(state.threadId).catch(() => {
      if (this.protocol === protocol) this.resyncing.delete(state.threadId);
    });
  }

  private detachProtocol(
    protocol: DesktopTaskProtocol,
    close: boolean,
  ): void {
    if (this.protocol !== protocol) return;
    this.unbindProtocol();
    this.unbindProtocol = () => undefined;
    this.protocol = null;
    if (close) protocol.close();
    this.resyncing.clear();
    for (const state of this.states.values()) state.disconnected();
  }

  private validationFailure(
    command: DesktopCommand,
    state: DesktopThreadState,
  ): string | null {
    const active = state.activeTurn();
    if (command.kind === "start" && active != null) {
      return `Desktop task already has active turn ${active.id}`;
    }
    if (command.kind !== "start" &&
        (active == null || active.id !== command.expectedTurnId)) {
      return "Desktop active turn no longer matches the requested turn";
    }
    if (command.kind === "steer" && !command.clientUserMessageId) {
      return "Desktop steer requires a delivery identity";
    }
    return null;
  }

  private proves(
    command: DesktopCommand,
    state: DesktopThreadState,
    turnId: string,
    baseline: number | null,
    generation: number,
  ): boolean {
    if (!state.ready || state.generation !== generation || baseline == null ||
        state.revision == null ||
        state.revision <= baseline) return false;
    const turn = state.turn(turnId);
    if (turn == null) return false;
    if (command.kind === "steer") {
      return state.hasDelivery(command.clientUserMessageId);
    }
    return command.kind !== "interrupt" || turn.status === "interrupted";
  }

  private notSubmitted(
    state: DesktopThreadState,
    reason: string,
  ): DesktopInjectionOutcome {
    state.setInjection("idle");
    return { _tag: "NotSubmitted", reason, state: state.evidence() };
  }

  private ambiguous(
    state: DesktopThreadState,
    reason: string,
  ): DesktopInjectionOutcome {
    state.setInjection("uncertain");
    return { _tag: "Ambiguous", reason, state: state.evidence() };
  }

  private rejected(
    state: DesktopThreadState,
    reason: string,
  ): DesktopInjectionOutcome {
    state.setInjection("rejected");
    return { _tag: "Rejected", reason, state: state.evidence() };
  }

  private serialize<T>(threadId: string, command: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(threadId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(threadId, current);
    return previous.catch(() => undefined).then(command).finally(() => {
      release();
      if (this.queues.get(threadId) === current) this.queues.delete(threadId);
    });
  }
}
