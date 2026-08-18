export function desktopStateChange(
  change: unknown,
  conversationId = "thread-1",
) {
  return {
    type: "broadcast",
    method: "thread-stream-state-changed",
    params: { conversationId, hostId: "local", change },
  } as const;
}
