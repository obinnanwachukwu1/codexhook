import type { TransportId } from "../types.js";

export type TransportSpec =
  | {
      readonly _tag: "ChildProcess";
      readonly id: Exclude<TransportId, "desktop" | "daemon">;
      readonly executable: string;
      readonly args: ReadonlyArray<string>;
      readonly windowsVerbatimArguments?: boolean;
      readonly approvals: "decline";
    }
  | {
      readonly _tag: "UnixSocket";
      readonly id: "daemon";
      readonly socketPath: string;
      readonly approvals: "decline";
    }
  | {
      readonly _tag: "Desktop";
      readonly id: "desktop";
      readonly socketPath: string;
      readonly approvals: "decline";
    };
