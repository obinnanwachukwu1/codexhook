import assert from "node:assert/strict";
import test from "node:test";
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
  detail: "desktop disconnected after sending",
} as const satisfies DeliveryReceipt;
const found = {
  _tag: "Found",
  turnId,
} as const satisfies DeliveryEvidence;
const absent = {
  _tag: "Absent",
  detail: "delivery id absent after canonical event barrier",
} as const satisfies DeliveryEvidence;
const unresolved = {
  _tag: "Unresolved",
  detail: "canonical event barrier timed out",
} as const satisfies DeliveryEvidence;

test("unattached and unhealthy tasks route directly through app-server", async (t) => {
  const states: DesktopRouteState[] = [
    { _tag: "Unattached", detail: "no desktop owner" },
    { _tag: "Unhealthy", detail: "desktop heartbeat expired" },
  ];
  for (const routeState of states) {
    await t.test(routeState._tag, async () => {
      const fixture = coordinatorFixture({ routeState, localReceipt: acknowledged });
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

test("desktop reconciliation decision table is exhaustive", async (t) => {
  const receipts = [acknowledged, uncertain] as const;
  const desktopEvidence = [found, absent, unresolved] as const;
  const canonicalEvidence = [found, absent, unresolved] as const;
  for (const receipt of receipts) {
    for (const desktopProof of desktopEvidence) {
      for (const canonicalProof of canonicalEvidence) {
        const name = `${receipt._tag}/${desktopProof._tag}/${canonicalProof._tag}`;
        await t.test(name, async () => {
          const fixture = coordinatorFixture({
            desktopReceipt: receipt,
            desktopEvidence: desktopProof,
            canonicalEvidence: canonicalProof,
            localReceipt: acknowledged,
          });
          try {
            const result = await fixture.deliver(request());
            const expected = canonicalProof._tag === "Found"
              ? "ConfirmedDesktop"
              : canonicalProof._tag === "Absent"
                ? "ConfirmedAppServer"
                : "Ambiguous";
            assert.equal(result._tag, expected);
            assert.equal(result.proof.desktopReceipt?._tag, receipt._tag);
            assert.equal(result.proof.desktopEvidence?._tag, desktopProof._tag);
            assert.equal(result.proof.canonicalEvidence?._tag, canonicalProof._tag);
            assert.equal(
              fixture.recorder.localDeliveries.length,
              canonicalProof._tag === "Absent" ? 1 : 0,
            );
          } finally {
            await fixture.runtime.dispose();
          }
        });
      }
    }
  }
});

test("only a proven pre-write desktop failure may fall back immediately", async (t) => {
  const cases = [
    {
      receipt: { _tag: "RejectedBeforeWrite", detail: "version mismatch" },
      expected: "ConfirmedAppServer",
      localWrites: 1,
    },
    {
      receipt: { _tag: "UnavailableBeforeWrite", detail: "socket closed" },
      expected: "ConfirmedAppServer",
      localWrites: 1,
    },
    {
      receipt: { _tag: "Rejected", detail: "handler rejected request" },
      expected: "Rejected",
      localWrites: 0,
    },
  ] as const;
  for (const entry of cases) {
    await t.test(entry.receipt._tag, async () => {
      const fixture = coordinatorFixture({
        desktopReceipt: entry.receipt,
        localReceipt: acknowledged,
      });
      try {
        const result = await fixture.deliver(request());
        assert.equal(result._tag, entry.expected);
        assert.equal(fixture.recorder.localDeliveries.length, entry.localWrites);
        assert.deepEqual(fixture.recorder.desktopEvidence, []);
      } finally {
        await fixture.runtime.dispose();
      }
    });
  }
});

test("app-server receipts report confirmed, rejected, unavailable, and ambiguous truthfully", async (t) => {
  const cases: ReadonlyArray<{
    receipt: DeliveryReceipt;
    canonical: DeliveryEvidence;
    expected: string;
  }> = [
    { receipt: acknowledged, canonical: found, expected: "ConfirmedAppServer" },
    {
      receipt: { _tag: "RejectedBeforeWrite", detail: "invalid request" },
      canonical: unresolved,
      expected: "Rejected",
    },
    {
      receipt: { _tag: "Rejected", detail: "app-server rejected request" },
      canonical: unresolved,
      expected: "Rejected",
    },
    {
      receipt: { _tag: "UnavailableBeforeWrite", detail: "not running" },
      canonical: unresolved,
      expected: "Unavailable",
    },
    { receipt: uncertain, canonical: found, expected: "ConfirmedAppServer" },
    { receipt: uncertain, canonical: absent, expected: "Unavailable" },
    { receipt: uncertain, canonical: unresolved, expected: "Ambiguous" },
  ];
  for (const [index, entry] of cases.entries()) {
    await t.test(`${index}-${entry.expected}`, async () => {
      const fixture = coordinatorFixture({
        routeState: { _tag: "Unattached", detail: "CLI-originated task" },
        localReceipt: entry.receipt,
        canonicalEvidence: entry.canonical,
      });
      try {
        const result = await fixture.deliver(request());
        assert.equal(result._tag, entry.expected);
        assert.equal(result.proof.appServerReceipt?._tag, entry.receipt._tag);
      } finally {
        await fixture.runtime.dispose();
      }
    });
  }
});

test("conflicting desktop and canonical turn identity is ambiguous", async () => {
  const fixture = coordinatorFixture({
    desktopReceipt: acknowledged,
    desktopEvidence: found,
    canonicalEvidence: { _tag: "Found", turnId: TurnId("turn-other") },
  });
  try {
    const result = await fixture.deliver(request());
    assert.equal(result._tag, "Ambiguous");
    assert.match(
      result._tag === "Ambiguous" ? result.detail : "",
      /different turns/,
    );
    assert.equal((await fixture.circuitState(request().threadId))._tag, "Open");
  } finally {
    await fixture.runtime.dispose();
  }
});
