export const APP_SERVER_COMPATIBILITY = {
  protocolFamily: "codex-app-server/v2",
  schemaStrategy: "effect-schema-validated-subset",
  generatedAgainst: {
    cliVersion: "0.147.0",
    generator:
      "codex app-server generate-json-schema --experimental",
  },
  requiredMethods: [
    "thread/list",
    "thread/read",
    "thread/turns/list",
    "turn/start",
    "turn/steer",
    "turn/interrupt",
  ],
  compatibilityPolicy:
    "initialize metadata plus per-response schema validation",
} as const;

export type AppServerCompatibility = typeof APP_SERVER_COMPATIBILITY;
