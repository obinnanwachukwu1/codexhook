import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { decideDesktopEvidence } from "../src/delivery/coordinator-policy.js";
import type {
  DeliveryEvidence,
  DeliveryReceipt,
  DesktopRouteState,
} from "../src/delivery/routing-contracts.js";
import { TurnId } from "../src/types.js";
import {
  coordinatorFixture,
  request,
} from "./support/coordinator-fixture.js";

const turnId = TurnId("turn-1");
const acknowledged = {
  _tag: "Acknowledged",
  turnId,
} as const satisfies DeliveryReceipt;
const uncertain = {
  _tag: "Uncertain",
  diagnostic: { code: "write-ambiguous" },
} as const satisfies DeliveryReceipt;
const timedOut = {
  _tag: "Uncertain",
  diagnostic: { code: "timeout" },
} as const satisfies DeliveryReceipt;
const internalFailure = {
  _tag: "Uncertain",
  diagnostic: { code: "internal" },
} as const satisfies DeliveryReceipt;
const found = { _tag: "Found", turnId } as const satisfies DeliveryEvidence;
const absent = { _tag: "Absent" } as const satisfies DeliveryEvidence;
const unresolved = {
  _tag: "Unresolved",
  diagnostic: { code: "timeout" },
} as const satisfies DeliveryEvidence;

test("desktop evidence decision table is exhaustive and pure", () => {
  const receipts = [
    acknowledged,
    uncertain,
    timedOut,
    internalFailure,
  ] as const;
  const desktopEvidence = [found, absent, unresolved] as const;
  const canonicalEvidence = [found, absent, unresolved] as const;
  for (const receipt of receipts) {
    for (const desktopProof of desktopEvidence) {
      for (const canonicalProof of canonicalEvidence) {
        const result = decideDesktopEvidence(
          receipt,
          desktopProof,
          canonicalProof,
        );
        const expected = canonicalProof._tag === "Found"
          ? "Confirm"
          : canonicalProof._tag === "Absent"
            ? receipt === timedOut || receipt === internalFailure
              ? "Ambiguous"
              : "Fallback"
            : "Ambiguous";
        assert.equal(
          result._tag,
          expected,
          `${receipt._tag}/${desktopProof._tag}/${canonicalProof._tag}`,
        );
      }
    }
  }
});

test("unattached and unhealthy tasks route directly through app-server", async (t) => {
  const states: DesktopRouteState[] = [
    { _tag: "Unattached" },
    { _tag: "Unhealthy" },
  ];
  for (const routeState of states) {
    await t.test(routeState._tag, async () => {
      const fixture = coordinatorFixture({
        routeState: () => Effect.succeed(routeState),
      });
      try {
        const result = await fixture.deliver(request());
        assert.equal(result._tag, "ConfirmedAppServer");
        assert.deepEqual(fixture.recorder.desktopInjections, []);
        assert.deepEqual(fixture.recorder.localDeliveries, ["delivery-1"]);
      } finally {
        await fixture.runtime.dispose();
      }
    });
  }
});

test("canonical evidence drives the outcome and circuit transition", async (t) => {
  const cases = [
    { canonical: found, outcome: "ConfirmedDesktop", circuit: "Closed" },
    { canonical: absent, outcome: "ConfirmedAppServer", circuit: "Open" },
    { canonical: unresolved, outcome: "Ambiguous", circuit: "Open" },
  ] as const;
  for (const entry of cases) {
    await t.test(entry.canonical._tag, async () => {
      const fixture = coordinatorFixture({
        canonicalEvidence: () => Effect.succeed(entry.canonical),
      });
      try {
        const result = await fixture.deliver(request());
        assert.equal(result._tag, entry.outcome);
        assert.equal(
          (await fixture.circuitState(request().threadId))._tag,
          entry.circuit,
        );
      } finally {
        await fixture.runtime.dispose();
      }
    });
  }
});

test("only confirmed non-submission may fall back immediately", async (t) => {
  const cases: ReadonlyArray<{
    receipt: DeliveryReceipt;
    expected: string;
    localWrites: number;
  }> = [
    {
      receipt: {
        _tag: "NotSubmitted",
        diagnostic: { code: "desktop-incompatible" },
      },
      expected: "ConfirmedAppServer",
      localWrites: 1,
    },
    {
      receipt: {
        _tag: "Rejected",
        diagnostic: { code: "request-rejected" },
      },
      expected: "Rejected",
      localWrites: 0,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.receipt._tag, async () => {
      const fixture = coordinatorFixture({
        desktopReceipt: () => Effect.succeed(entry.receipt),
      });
      try {
        const result = await fixture.deliver(request());
        assert.equal(result._tag, entry.expected);
        if (entry.receipt._tag === "Rejected") {
          assert.equal(result.proof.desktopReceipt?._tag, "Rejected");
        }
        assert.equal(fixture.recorder.localDeliveries.length, entry.localWrites);
        assert.deepEqual(fixture.recorder.desktopEvidence, []);
        assert.deepEqual(fixture.recorder.reconciliations, []);
        assert.equal(
          (await fixture.circuitState(request().threadId))._tag,
          "Closed",
        );
      } finally {
        await fixture.runtime.dispose();
      }
    });
  }
});

test("app-server receipts report all four submission truths", async (t) => {
  const cases: ReadonlyArray<{
    receipt: DeliveryReceipt;
    canonical: DeliveryEvidence;
    expected: string;
  }> = [
    { receipt: acknowledged, canonical: found, expected: "ConfirmedAppServer" },
    {
      receipt: {
        _tag: "NotSubmitted",
        diagnostic: { code: "app-server-unavailable" },
      },
      canonical: unresolved,
      expected: "Unavailable",
    },
    {
      receipt: {
        _tag: "Rejected",
        diagnostic: { code: "request-rejected" },
      },
      canonical: unresolved,
      expected: "Rejected",
    },
    { receipt: uncertain, canonical: found, expected: "ConfirmedAppServer" },
    { receipt: uncertain, canonical: absent, expected: "Unavailable" },
    { receipt: uncertain, canonical: unresolved, expected: "Ambiguous" },
    { receipt: timedOut, canonical: absent, expected: "Ambiguous" },
    { receipt: internalFailure, canonical: absent, expected: "Ambiguous" },
  ];
  for (const [index, entry] of cases.entries()) {
    await t.test(`${index}-${entry.expected}`, async () => {
      const fixture = coordinatorFixture({
        routeState: () => Effect.succeed({ _tag: "Unattached" }),
        localReceipt: () => Effect.succeed(entry.receipt),
        canonicalEvidence: () => Effect.succeed(entry.canonical),
      });
      try {
        const result = await fixture.deliver(request());
        assert.equal(result._tag, entry.expected);
        assert.equal(result.proof.appServerReceipt?._tag, entry.receipt._tag);
        assert.equal(
          fixture.recorder.reconciliations.length,
          entry.receipt._tag === "Uncertain" ? 1 : 0,
        );
        if (result._tag === "Ambiguous") {
          assert.equal(
            (await fixture.circuitState(request().threadId))._tag,
            "Closed",
          );
        }
      } finally {
        await fixture.runtime.dispose();
      }
    });
  }
});

test("fallback proof preserves both canonical observations", async () => {
  let reconciliation = 0;
  const fixture = coordinatorFixture({
    canonicalEvidence: () => Effect.succeed(
      ++reconciliation === 1 ? absent : found,
    ),
    localReceipt: () => Effect.succeed(uncertain),
  });
  try {
    const result = await fixture.deliver(request());
    assert.equal(result._tag, "ConfirmedAppServer");
    assert.equal(result.proof.canonicalAfterDesktop?._tag, "Absent");
    assert.equal(result.proof.canonicalAfterAppServer?._tag, "Found");
  } finally {
    await fixture.runtime.dispose();
  }
});

test("cleanly proven desktop absence falls back without opening the circuit", async () => {
  const fixture = coordinatorFixture({
    desktopReceipt: () => Effect.succeed(uncertain),
    desktopEvidence: () => Effect.succeed(unresolved),
    canonicalEvidence: () => Effect.succeed(absent),
  });
  try {
    assert.equal((await fixture.deliver(request()))._tag, "ConfirmedAppServer");
    assert.equal(
      (await fixture.circuitState(request().threadId))._tag,
      "Closed",
    );
  } finally {
    await fixture.runtime.dispose();
  }
});

test("adapter defects become closed delivery outcomes", async (t) => {
  await t.test("desktop state defect routes through app-server", async () => {
    const fixture = coordinatorFixture({ routeState: () => Effect.die("boom") });
    try {
      assert.equal((await fixture.deliver(request()))._tag,
        "ConfirmedAppServer");
    } finally {
      await fixture.runtime.dispose();
    }
  });

  await t.test("desktop write defect is reconciled as uncertain", async () => {
    const fixture = coordinatorFixture({
      desktopReceipt: () => Effect.die("boom"),
      canonicalEvidence: () => Effect.succeed(unresolved),
    });
    try {
      assert.equal((await fixture.deliver(request()))._tag, "Ambiguous");
      assert.equal(
        (await fixture.circuitState(request().threadId))._tag,
        "Open",
      );
    } finally {
      await fixture.runtime.dispose();
    }
  });

  await t.test("app-server write defect is reconciled as uncertain", async () => {
    const fixture = coordinatorFixture({
      routeState: () => Effect.succeed({ _tag: "Unattached" }),
      localReceipt: () => Effect.die("boom"),
      canonicalEvidence: () => Effect.succeed(unresolved),
    });
    try {
      assert.equal((await fixture.deliver(request()))._tag, "Ambiguous");
      assert.equal(
        (await fixture.circuitState(request().threadId))._tag,
        "Closed",
      );
    } finally {
      await fixture.runtime.dispose();
    }
  });
});

test("evidence timeouts are bounded and open the desktop circuit", async () => {
  const fixture = coordinatorFixture({
    desktopReceipt: () => Effect.succeed(uncertain),
    desktopEvidence: () => Effect.never,
    canonicalEvidence: () => Effect.never,
  });
  try {
    const result = await fixture.deliver(request(
      "delivery-timeout",
      "thread-timeout",
      "10 millis",
    ));
    assert.equal(result._tag, "Ambiguous");
    assert.equal(
      result._tag === "Ambiguous" && result.diagnostic.code,
      "timeout",
    );
    assert.equal(
      (await fixture.circuitState(request(
        "delivery-timeout",
        "thread-timeout",
      ).threadId))._tag,
      "Open",
    );
  } finally {
    await fixture.runtime.dispose();
  }
});

test("conflicting desktop state and canonical identity is ambiguous", async () => {
  const fixture = coordinatorFixture({
    desktopReceipt: () => Effect.succeed(uncertain),
    desktopEvidence: () => Effect.succeed({
      _tag: "Found",
      turnId: TurnId("turn-desktop"),
    }),
    canonicalEvidence: () => Effect.succeed({
      _tag: "Found",
      turnId: TurnId("turn-canonical"),
    }),
  });
  try {
    const result = await fixture.deliver(request());
    assert.equal(result._tag, "Ambiguous");
    assert.equal(
      result._tag === "Ambiguous" && result.diagnostic.code,
      "write-ambiguous",
    );
  } finally {
    await fixture.runtime.dispose();
  }
});

test("message contents never enter proof, results, or circuit logs", async () => {
  const fixture = coordinatorFixture({
    desktopReceipt: () => Effect.succeed(uncertain),
    canonicalEvidence: () => Effect.succeed(unresolved),
  });
  try {
    const result = await fixture.deliver(request());
    const serialized = JSON.stringify({ result, logs: fixture.recorder.logs });
    assert.equal(serialized.includes("private webhook body"), false);
    assert.equal(serialized.includes("write-ambiguous"), true);
  } finally {
    await fixture.runtime.dispose();
  }
});
