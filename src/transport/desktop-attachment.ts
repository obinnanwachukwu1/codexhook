import type { Turn } from "./protocol.js";
import {
  type DesktopCommand,
  type DesktopProtocol,
  type DesktopProtocolConnector,
} from "./desktop-protocol.js";
import {
  DesktopThreadState,
  type DesktopTaskSnapshot,
} from "./desktop-state.js";

export class DesktopNotWrittenError extends Error {
  override readonly name = "DesktopNotWrittenError";
}

export class DesktopRejectedError extends Error {
  override readonly name = "DesktopRejectedError";
}

export class DesktopUncertainError extends Error {
  override readonly name = "DesktopUncertainError";
}

export interface DesktopInjectionResult {
  readonly turnId: string;
  readonly turn?: Turn;
  readonly evidence: "confirmed";
  readonly state: DesktopTaskSnapshot;
}

interface DesktopAttachmentOptions {
  readonly followTimeoutMs?: number;
  readonly proofTimeoutMs?: number;
}

export class DesktopAttachment {
  private closed = false;
  private connectPromise: Promise<DesktopProtocol> | null = null;
  private generation = 0;
  private protocol: DesktopProtocol | null;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly resyncing = new Set<string>();
  private readonly states = new Map<string, DesktopThreadState>();
  private readonly followTimeoutMs: number;
  private readonly proofTimeoutMs: number;

  constructor(
    private readonly connector: DesktopProtocolConnector,
    initialProtocol?: DesktopProtocol,
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
      return state.snapshot();
    });
  }

  async inject(command: DesktopCommand): Promise<DesktopInjectionResult> {
    return this.serialize(command.threadId, async () => {
      const state = this.getState(command.threadId);
      try {
        await this.synchronize(state);
      } catch (cause) {
        throw new DesktopNotWrittenError(errorMessage(cause));
      }
      this.validate(command, state);
      const baseline = state.revision;
      const protocol = this.protocol;
      if (protocol == null) {
        throw new DesktopNotWrittenError("Desktop is not connected");
      }
      state.beginInjection();
      let reply;
      try {
        reply = await protocol.inject(command);
      } catch (cause) {
        state.finishInjection("uncertain");
        throw new DesktopUncertainError(errorMessage(cause));
      }
      if (reply._tag === "Rejected") {
        state.finishInjection("rejected");
        const Rejection = reply.retrySafe
          ? DesktopNotWrittenError
          : DesktopRejectedError;
        throw new Rejection(reply.reason);
      }
      const turnId = command.kind === "start"
        ? nestedTurnId(reply.result)
        : command.expectedTurnId ?? nestedTurnId(reply.result);
      if (turnId == null || turnId.length === 0) {
        state.finishInjection("uncertain");
        throw new DesktopUncertainError(
          "Desktop accepted the command without a turn identity",
        );
      }
      try {
        await state.waitFor(
          () => this.proves(command.kind, state, turnId, baseline) ||
            state.evidence().connection === "disconnected",
          this.proofTimeoutMs,
        );
      } catch (cause) {
        state.finishInjection("uncertain");
        throw new DesktopUncertainError(errorMessage(cause));
      }
      if (!this.proves(command.kind, state, turnId, baseline)) {
        state.finishInjection("uncertain");
        throw new DesktopUncertainError(
          "Desktop disconnected before state confirmed the command",
        );
      }
      state.finishInjection("confirmed");
      const turn = state.turn(turnId);
      return {
        turnId,
        ...(turn == null ? {} : { turn }),
        evidence: "confirmed",
        state: state.evidence(),
      };
    });
  }

  async awaitTurn(threadId: string, turnId: string, timeoutMs: number) {
    const state = this.getState(threadId);
    await state.waitFor(
      () => {
        const turn = state.turn(turnId);
        return (turn != null && turn.status !== "inProgress") ||
          state.evidence().connection === "disconnected";
      },
      timeoutMs,
    );
    const turn = state.turn(turnId);
    if (turn == null || turn.status === "inProgress") {
      throw new Error("Desktop disconnected while observing the turn");
    }
    return turn;
  }

  close(): void {
    this.closed = true;
    this.protocol?.close();
    this.protocol = null;
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

  private async synchronize(state: DesktopThreadState): Promise<void> {
    const deadline = Date.now() + this.followTimeoutMs;
    while (!state.ready) {
      const protocol = await this.ensureConnected(state);
      if (state.evidence().attachment === "detached") {
        state.beginFollowing(this.generation);
        await protocol.follow(state.threadId);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Desktop follow timed out");
      await state.waitFor(
        () => state.ready ||
          state.evidence().connection === "disconnected",
        remaining,
      );
    }
  }

  private async ensureConnected(
    state: DesktopThreadState,
  ): Promise<DesktopProtocol> {
    if (this.closed) throw new Error("Desktop attachment is closed");
    if (this.protocol?.connected === true) return this.protocol;
    state.beginConnecting();
    if (this.connectPromise == null) {
      this.connectPromise = this.connector().then(async (protocol) => {
        this.protocol = protocol;
        this.bind(protocol);
        await Promise.all([...this.states.values()].map(async (candidate) => {
          candidate.beginFollowing(this.generation);
          await protocol.follow(candidate.threadId);
        }));
        return protocol;
      }).finally(() => {
        this.connectPromise = null;
      });
    }
    return this.connectPromise;
  }

  private bind(protocol: DesktopProtocol): void {
    const generation = ++this.generation;
    protocol.onChange((threadId, change) => {
      if (this.protocol !== protocol) return;
      const state = this.states.get(threadId);
      if (state == null) return;
      const result = state.apply(change, generation);
      if (result === "applied" && state.ready) {
        this.resyncing.delete(threadId);
      } else if (result === "resync") {
        this.requestResync(protocol, state, generation);
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
    protocol: DesktopProtocol,
    state: DesktopThreadState,
    generation: number,
  ): void {
    if (this.resyncing.has(state.threadId)) return;
    this.resyncing.add(state.threadId);
    void protocol.loadHistory(state.threadId).catch(() => {
      if (this.protocol !== protocol ||
          state.evidence().generation !== generation) return;
      this.resyncing.delete(state.threadId);
    });
  }

  private validate(command: DesktopCommand, state: DesktopThreadState): void {
    const active = state.activeTurn();
    if (command.kind === "start" && active != null) {
      throw new DesktopNotWrittenError(
        `Desktop task already has active turn ${active.id}`,
      );
    }
    if (command.kind !== "start" &&
        (active == null || active.id !== command.expectedTurnId)) {
      throw new DesktopNotWrittenError(
        "Desktop active turn no longer matches the requested turn",
      );
    }
  }

  private proves(
    kind: DesktopCommand["kind"],
    state: DesktopThreadState,
    turnId: string,
    baseline: number | null,
  ): boolean {
    if (!state.ready || baseline == null || state.revision == null ||
        state.revision <= baseline) return false;
    const turn = state.turn(turnId);
    if (turn == null) return false;
    return kind !== "interrupt" || turn.status !== "inProgress";
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

function nestedTurnId(value: unknown): string | null {
  if (value == null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.turnId === "string") return record.turnId;
  const turn = record.turn;
  if (turn != null && typeof turn === "object") {
    const id = (turn as { readonly id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  for (const child of Object.values(record)) {
    const found = nestedTurnId(child);
    if (found != null) return found;
  }
  return null;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
