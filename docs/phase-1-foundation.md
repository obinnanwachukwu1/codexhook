# Phase 1 local delivery foundation

Phase 1 has one per-user `codexhook serve` process. It represents every task
in this machine's local Codex store, whether a task originated in Desktop or
the CLI. It does not create a second daemon, remote store, copied conversation
database, or alternate task namespace.

The contracts in `src/contracts/` describe the boundary between discovery,
Desktop IPC, routing, and diagnostics. They are intentionally independent of
the current `CodexTransport` implementation so subsystem work can land behind
stable seams before the runtime cutover.

## Authority and routing invariants

1. App-server is canonical for local availability, task listing, history, and
   events. A Desktop window is not evidence that it owns the complete task
   inventory. CLI-originated tasks must appear through the same app-server
   plane.
2. Every accepted delivery targets a branded `LocalTaskRef` returned by
   `LocalCodexService.resolveTask` or `listTasks`. The canonical app-server is
   the only authority that may mint one, so remote, Desktop-only, and unknown
   task references fail before any write is attempted.
3. Desktop IPC is the preferred live injection route when it is available,
   compatible, and following the target task. Desktop is a scoped session, not
   a second source of task truth.
4. App-server is the fallback write route only after Desktop is unavailable,
   incompatible, or positively confirms that no submission occurred.
5. Confirmed tags name the route that performed the write, not the plane that
   later observed it. A Desktop write yields `ConfirmedDesktop`; an app-server
   write yields `ConfirmedAppServer`.
6. A write whose disposition is unknown yields `Ambiguous`. The coordinator
   may inspect the snapshot-first app-server event stream for the same delivery
   ID in a turn's `deliveryIds`, but it must not issue another write.
   Reconciliation promotes the outcome only on a positive canonical match;
   otherwise ambiguity remains visible. Reconciliation is bounded by the
   delivery timeouts; expiry remains `Ambiguous`. A reconciled Desktop write
   remains `ConfirmedDesktop`.
7. An explicit protocol refusal yields `Rejected`. Exhausting routes through
   pre-write failures yields `Unavailable`. Neither is reported as confirmed.
8. Delivery is best effort, has no retry queue, and remains FIFO per task in
   queue mode. A limited-use webhook is still spent when its HTTP request is
   accepted. The public webhook continues to return `202` before background
   delivery completes.
9. Webhook messages, URL tokens, socket paths, raw protocol errors, and local
   filesystem paths never enter `SanitizedDiagnostic`. Diagnostics are built
   from an allowlist of codes, stages, routes, and bounded numbers.
10. All transports decline approval requests. These contracts do not broaden
    the authority of a webhook-delivered message.
11. The coordinator owns one scoped Desktop session per delivery. Sessions are
    not shared across concurrent task lanes. It does not externally cancel a
    possible-write region: each adapter uses its explicit reply timeout and
    classifies every reply failure, defect, or internal interruption. An
    uncertain write becomes `Ambiguous`.
12. `idleTimeout` bounds each individual wait (Desktop follow, submission
    acknowledgement, or reconciliation match). `turnTimeout` bounds the whole
    delivery, including reconciliation. The coordinator derives each route's
    `replyTimeout` from the remaining delivery budget so an uninterruptible
    possible-write wait remains internally bounded.

## Contract ownership

| Area | Contract | Implementation responsibility |
| --- | --- | --- |
| Canonical local plane | `LocalCodexService` | App-server owner implements list, history, event, availability, and app-server submission adapters. |
| Desktop IPC | `DesktopProtocol`, `DesktopSession` | Desktop owner implements discovery, compatibility negotiation, following, injection, and observation. It must not add task-list authority. |
| Routing | `DeliveryCoordinator`, `DeliveryPolicy`, `DeliveryOutcome` | Coordinator owner sequences the two planes and preserves the submission-truth rules above. |
| Wire evolution | `ProtocolRequirement`, `ProtocolOffer`, `ProtocolCompatibility` | Each protocol adapter declares offers; the coordinator supplies requirements. Missing features remain pre-write incompatibility. |
| Provenance | `LocalTaskRef`, `LocalCodexService` | App-server resolves and mints branded references with their local origin before coordination. |
| Observability | `SanitizedDiagnostic`, `DeliveryAttempt` | Each adapter returns safe codes; logging and health output consume only sanitized values. |

## Integration sequence

1. Implement the app-server adapter behind `LocalCodexService` without
   changing public HTTP behavior. Centralize the sole `LocalTaskRef` branding
   assertion in one private constructor used by `resolveTask` and `listTasks`.
2. Adapt the existing Desktop IPC client behind `DesktopProtocol`; keep the
   socket client and stream-state parser private to that implementation.
3. Implement `DeliveryCoordinator` with app-server observation-only
   reconciliation and the frozen Phase 1 policy.
4. Adapt the current per-task delivery lanes to call the coordinator. Preserve
   the `DeliveryService.submit` acceptance contract until a separately planned
   public API change.
5. Retire legacy `CodexTransport`, `TurnOutcome`, transport fallback, and
   Desktop visibility code only after parity tests cover all five outcome
   classes and the existing cross-platform suites remain green.

## Expected cherry-pick seams

The foundation owns `src/contracts/**`, this document, its focused contract
tests, and the single barrel export in `src/index.ts`. Subsystem branches should
prefer new implementation files and import these contracts rather than editing
them independently.

Likely shared conflict points during integration are:

- `src/index.ts`, when new adapters are exported;
- `src/transport/desktop.ts` and `src/transport/desktop-ipc-client.ts`, when the
  Desktop adapter is introduced;
- `src/transport/transport.ts`, `src/transport/attempts.ts`, and
  `src/delivery/delivery.ts`, when the coordinator replaces legacy routing;
- `src/server.ts` and health/doctor code, when truthful outcome and availability
  reporting is surfaced;
- transport test fixtures, which currently model the legacy transport outcome.

Do not resolve those conflicts by weakening local provenance, adding retries,
or falling back after an ambiguous write. Keep legacy adapters until the new
contracts have equivalent behavioral coverage.
