import assert from "node:assert/strict";
import test from "node:test";
import { DesktopAttachment } from "../src/transport/desktop-attachment.js";
import {
  FakeDesktopProtocol,
  startCommand,
} from "./support/desktop-protocol-fixture.js";

test("only proven Desktop non-submission is fallback-safe", async () => {
  const known = new FakeDesktopProtocol();
  known.setSnapshot("thread-1", 1);
  known.injectBehavior = async () => ({
    _tag: "Rejected",
    reason: "request-version-mismatch",
    notWritten: true,
    confirmedNoSubmission: true,
  });
  const knownResult = await new DesktopAttachment(known).inject(startCommand());
  assert.equal(knownResult._tag, "NotSubmitted");
  if (knownResult._tag === "NotSubmitted") {
    assert.equal(knownResult.submissionReason, "confirmed-not-submitted");
  }

  const unknown = new FakeDesktopProtocol();
  unknown.setSnapshot("thread-1", 1);
  unknown.injectBehavior = async () => ({
    _tag: "Rejected",
    reason: "unknown",
    notWritten: false,
    confirmedNoSubmission: false,
  });
  assert.equal(
    (await new DesktopAttachment(unknown).inject(startCommand()))._tag,
    "Rejected",
  );
});
