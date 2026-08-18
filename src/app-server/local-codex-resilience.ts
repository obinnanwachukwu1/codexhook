import {
  type Duration,
  Effect,
  ExecutionStrategy,
  Exit,
  Ref,
  type Scope,
  Scope as ScopeApi,
  Stream,
} from "effect";
import type { LocalCodexService } from "../contracts/local-codex.js";

interface LocalCodexBinding {
  readonly service: LocalCodexService;
  readonly scope: Scope.CloseableScope;
}

function acquireBinding(
  parent: Scope.Scope,
  acquire: Effect.Effect<LocalCodexService, never, Scope.Scope>,
): Effect.Effect<LocalCodexBinding> {
  return Effect.gen(function* () {
    const scope = yield* ScopeApi.fork(
      parent,
      ExecutionStrategy.sequential,
    );
    const result = yield* acquire.pipe(
      ScopeApi.extend(scope),
      Effect.exit,
    );
    if (Exit.isSuccess(result)) return { service: result.value, scope };
    yield* ScopeApi.close(scope, result);
    return yield* Effect.failCause(result.cause);
  });
}

function serviceFrom(
  current: Ref.Ref<LocalCodexBinding>,
): LocalCodexService {
  const use = <A, E>(
    operation: (service: LocalCodexService) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E> => Ref.get(current).pipe(
    Effect.flatMap(({ service }) => operation(service)),
  );
  return {
    availability: use((service) => service.availability),
    listTasks: use((service) => service.listTasks),
    readHistory: (task) => use((service) => service.readHistory(task)),
    resolveTask: (threadId) => use((service) => service.resolveTask(threadId)),
    events: (task) => Stream.unwrap(
      Ref.get(current).pipe(
        Effect.map(({ service }) => service.events(task)),
      ),
    ),
    submit: (request) => use((service) => service.submit(request)),
  };
}

export function resilientLocalCodexService(
  acquire: Effect.Effect<LocalCodexService, never, Scope.Scope>,
  retryInterval: Duration.DurationInput = "5 seconds",
  waitForRetry: () => Effect.Effect<void> = () => Effect.sleep(retryInterval),
): Effect.Effect<LocalCodexService, never, Scope.Scope> {
  return Effect.gen(function* () {
    const parent = yield* ScopeApi.Scope;
    const initial = yield* acquireBinding(parent, acquire);
    const current = yield* Ref.make(initial);
    yield* Effect.forkScoped(Effect.forever(
      waitForRetry().pipe(
        Effect.zipRight(Ref.get(current)),
        Effect.flatMap(({ service }) => service.availability),
        Effect.flatMap((availability) => availability.status === "available"
          ? Effect.void
          : Effect.gen(function* () {
            const replacement = yield* acquireBinding(parent, acquire);
            const previous = yield* Ref.getAndSet(current, replacement);
            yield* ScopeApi.close(previous.scope, Exit.void);
          })),
        Effect.catchAllCause(() => Effect.void),
      ),
    ));
    return serviceFrom(current);
  });
}
