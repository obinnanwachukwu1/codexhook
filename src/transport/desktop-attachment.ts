import type { Turn } from "./protocol.js";
import {
  type DesktopCommand,
  type DesktopTaskProtocol,
  type DesktopProtocolConnector,
} from "./desktop-protocol.js";
import {
  DesktopThreadState,
  type DesktopTaskSnapshot,
} from "./desktop-state.js";

export type DesktopInjectionOutcome =
  | {
      readonly _tag: "Confirmed";
      readonly turnId: string;
      readonly turn: Turn;
      readonly state: DesktopTaskSnapshot;
    }
  | {
      readonly _tag: "NotSubmitted";
      readonly reason: string;
      readonly state: DesktopTaskSnapshot;
    }
  | {
      readonly _tag: "Ambiguous";
      readonly reason: string;
      readonly state: DesktopTaskSnapshot;
    }
  | {
      readonly _tag: "Rejected";
      readonly reason: string;
      readonly state: DesktopTaskSnapshot;
    };

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
      try {
        await this.synchronize(state);
      } catch (cause) {
        return this.notSubmitted(state, errorMessage(cause));
      }
      const invalid = this.validationFailure(command, state);
      if (invalid != null) return this.notSubmitted(state, invalid);
      const baseline = state.revision;
      const protocol = this.protocol;
      if (protocol == null) {
        return this.notSubmitted(state, "Desktop is not connected");
      }
      state.beginInjection();
      let reply;
      try {
        reply = await protocol.inject(command);
      } catch (cause) {
        return this.ambiguous(state, errorMessage(cause));
      }
      if (reply._tag === "Rejected") {
        state.finishInjection("rejected");
        return reply.notWritten
          ? this.notSubmitted(state, reply.reason)
          : { _tag: "Rejected", reason: reply.reason, state: state.evidence() };
      }
      const turnId = command.kind === "start"
        ? nestedTurnId(reply.result)
        : command.expectedTurnId;
      if (turnId == null || turnId.length === 0) {
        return this.ambiguous(
          state,
          "Desktop accepted the command without a turn identity",
        );
      }
      try {
        await state.waitFor(
          () => this.proves(command, state, turnId, baseline) ||
            state.connection === "disconnected",
          this.proofTimeoutMs,
        );
      } catch (cause) {
        return this.ambiguous(state, errorMessage(cause));
      }
      if (!this.proves(command, state, turnId, baseline)) {
        return this.ambiguous(
          state,
          "Desktop disconnected before state confirmed the command",
        );
      }
      const turn = state.turn(turnId);
      if (turn == null) {
        return this.ambiguous(state, "Desktop confirmation lost its turn");
      }
      state.finishInjection("confirmed");
      return {
        _tag: "Confirmed",
        turnId,
        turn,
        state: state.evidence(),
      };
    });
  }

  async awaitTurn(turnId: string, timeoutMs: number): Promise<Turn> {
    const state = this.resolveState(turnId);
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
    this.protocol?.close();
    this.protocol = null;
    this.connectPromise = null;
    for (const state of this.states.values()) state.disconnected();
  }

  private getState(threadId: string): DesktopThreadState {
    let state = this.states.get(threadId);
    if (state == null) {
      state = new DesktopThreadState(threadId);
      this.states.set(threadId, state);
    }
    return state;
  }

  private resolveState(turnId: string): DesktopThreadState | null {
    const followed = [...this.states.values()];
    return followed.find((state) => state.turn(turnId) != null) ??
      (followed.length === 1 ? followed[0] ?? null : null);
  }

  private async synchronize(state: DesktopThreadState): Promise<void> {
    const deadline = Date.now() + this.followTimeoutMs;
    while (!state.ready) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Desktop follow timed out");
      const protocol = await withTimeout(
        this.ensureConnected(state),
        remaining,
        "Desktop follow timed out",
      );
      if (state.attachment === "detached") {
        state.beginFollowing(this.generation);
        try {
          await withTimeout(
            protocol.follow(state.threadId),
            Math.max(1, deadline - Date.now()),
            "Desktop follow timed out",
          );
        } catch (cause) {
          this.dropProtocol(protocol);
          throw cause;
        }
      }
      const wait = deadline - Date.now();
      if (wait <= 0) throw new Error("Desktop follow timed out");
      await state.waitFor(
        () => state.ready || state.connection === "disconnected",
        wait,
      );
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
        if (previous !== protocol) previous?.close();
        this.protocol = protocol;
        this.bind(protocol);
        try {
          await Promise.all([...this.states.values()].map(async (candidate) => {
            candidate.beginFollowing(this.generation);
            await protocol.follow(candidate.threadId);
          }));
        } catch (cause) {
          this.dropProtocol(protocol);
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
    const generation = ++this.generation;
    protocol.onChange((threadId, change) => {
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
    protocol.onDisconnect(() => {
      if (this.protocol !== protocol) return;
      this.protocol = null;
      this.resyncing.clear();
      for (const state of this.states.values()) state.disconnected();
    });
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

  private dropProtocol(protocol: DesktopTaskProtocol): void {
    if (this.protocol !== protocol) return;
    this.protocol = null;
    protocol.close();
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
  ): boolean {
    if (!state.ready || baseline == null || state.revision == null ||
        state.revision <= baseline) return false;
    const turn = state.turn(turnId);
    if (turn == null) return false;
    if (command.kind === "steer") {
      return state.hasDelivery(command.clientUserMessageId ?? "");
    }
    return command.kind !== "interrupt" || turn.status !== "inProgress";
  }

  private notSubmitted(
    state: DesktopThreadState,
    reason: string,
  ): DesktopInjectionOutcome {
    return { _tag: "NotSubmitted", reason, state: state.evidence() };
  }

  private ambiguous(
    state: DesktopThreadState,
    reason: string,
  ): DesktopInjectionOutcome {
    state.finishInjection("uncertain");
    return { _tag: "Ambiguous", reason, state: state.evidence() };
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

function nestedTurnId(value: unknown, depth = 0): string | null {
  if (depth > 32 || value == null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.turnId === "string") return record.turnId;
  const turn = record.turn;
  if (turn != null && typeof turn === "object") {
    const id = (turn as { readonly id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  for (const child of Object.values(record)) {
    const found = nestedTurnId(child, depth + 1);
    if (found != null) return found;
  }
  return null;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (cause) => {
        clearTimeout(timeout);
        reject(cause);
      },
    );
  });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
