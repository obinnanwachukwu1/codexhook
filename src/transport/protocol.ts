import { Schema } from "effect";
import { VERSION } from "../version.js";

export const TurnStatus = Schema.Literal(
  "completed",
  "interrupted",
  "failed",
  "inProgress",
);

export const Turn = Schema.Struct({
  id: Schema.String,
  status: TurnStatus,
  error: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        message: Schema.optional(Schema.String),
      }),
    ),
  ),
});

export type Turn = typeof Turn.Type;

export const ThreadResumeResult = Schema.Struct({
  thread: Schema.Struct({
    id: Schema.String,
    status: Schema.optional(
      Schema.Struct({
        type: Schema.String,
      }),
    ),
    turns: Schema.Array(Turn),
  }),
});

export type ThreadResumeResult = typeof ThreadResumeResult.Type;

export const TurnStartResult = Schema.Struct({
  turn: Turn,
});

export type TurnStartResult = typeof TurnStartResult.Type;

export const TurnSteerResult = Schema.Struct({
  turnId: Schema.String,
});

export const InitializeResult = Schema.Unknown;

export const INITIALIZE_PARAMS = {
  capabilities: {
    experimentalApi: true,
  },
  clientInfo: {
    name: "codexhook",
    title: "Codexhook",
    version: VERSION,
  },
} as const;
