import { Effect } from "effect";
import { CanonicalQueryFailure } from "./errors.js";

const MAX_PAGES = 1_000;
const MAX_ITEMS = 50_000;

interface Page<A> {
  readonly data: ReadonlyArray<A>;
  readonly nextCursor: string | null;
}

export function paginate<A>(
  fetch: (
    cursor: string | null,
  ) => Effect.Effect<Page<A>, CanonicalQueryFailure>,
): Effect.Effect<ReadonlyArray<A>, CanonicalQueryFailure> {
  return Effect.gen(function* () {
    const data: A[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Page<A> = yield* fetch(cursor);
      pages += 1;
      if (data.length + page.data.length > MAX_ITEMS) {
        return yield* paginationFailure();
      }
      data.push(...page.data);
      if (page.nextCursor != null && seen.has(page.nextCursor)) {
        return yield* paginationFailure();
      }
      if (page.nextCursor != null) seen.add(page.nextCursor);
      cursor = page.nextCursor;
      if (pages >= MAX_PAGES && cursor != null) {
        return yield* paginationFailure();
      }
    } while (cursor != null);
    return data;
  });
}

function paginationFailure(): CanonicalQueryFailure {
  return new CanonicalQueryFailure({ code: "pagination" });
}
