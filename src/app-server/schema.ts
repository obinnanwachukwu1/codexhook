import { Schema } from "effect";
// Omission defaults to interactive sources, so the generated v2 enum must be
// explicit to include exec, app-server, and subagent tasks from the local store.
export const ALL_LOCAL_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
] as const;

const CustomSource = Schema.Struct({ custom: Schema.String });
const SubagentSource = Schema.Struct({ subAgent: Schema.Unknown });

export const SessionSource = Schema.Union(
  Schema.Literal("cli", "vscode", "exec", "appServer", "unknown"),
  CustomSource,
  SubagentSource,
);
export type SessionSource = typeof SessionSource.Type;

// These generated protocol fields form the mutation/verification correlation
// contract. Keep them together so a future binding update cannot drift one side.
export const CLIENT_MESSAGE_ID_PARAM = "clientUserMessageId" as const;
export const USER_MESSAGE_CLIENT_ID_FIELD = "clientId" as const;

export const CanonicalTurn = Schema.Struct({
  id: Schema.String,
  items: Schema.Array(Schema.Unknown),
  itemsView: Schema.String,
  status: Schema.String,
  error: Schema.optional(Schema.NullOr(
    Schema.Struct({ message: Schema.optional(Schema.String) }),
  )),
  startedAt: Schema.optional(Schema.NullOr(Schema.Number)),
  completedAt: Schema.optional(Schema.NullOr(Schema.Number)),
  durationMs: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type CanonicalTurn = typeof CanonicalTurn.Type;

export const CanonicalThread = Schema.Struct({
  id: Schema.String,
  preview: Schema.String,
  ephemeral: Schema.Boolean,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  status: Schema.Unknown,
  cwd: Schema.String,
  cliVersion: Schema.String,
  source: Schema.optional(Schema.Unknown),
  canAcceptDirectInput: Schema.optional(Schema.NullOr(Schema.Boolean)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  turns: Schema.optionalWith(Schema.Array(CanonicalTurn), {
    default: () => [],
  }),
});
export type CanonicalThread = typeof CanonicalThread.Type;

export const ThreadListResponse = Schema.Struct({
  data: Schema.Array(CanonicalThread),
  nextCursor: Schema.NullOr(Schema.String),
  backwardsCursor: Schema.optional(Schema.NullOr(Schema.String)),
});

export const ThreadReadResponse = Schema.Struct({
  thread: CanonicalThread,
});

export const ThreadTurnsListResponse = Schema.Struct({
  data: Schema.Array(CanonicalTurn),
  nextCursor: Schema.NullOr(Schema.String),
  backwardsCursor: Schema.optional(Schema.NullOr(Schema.String)),
});

export const TurnInterruptResponse = Schema.Unknown;
