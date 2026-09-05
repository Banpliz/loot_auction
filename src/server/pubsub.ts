// A single process, in-memory "something changed" signal — not a message bus. Payload-free
// on purpose: /stream (server.ts) just tells connected clients to re-fetch /events/current,
// which is already fully authenticated and authoritative, so the ping itself needs no auth
// and no data of its own. Good enough for one Fastify process; would need a real pub/sub
// (Redis, etc.) if this ever ran as more than one instance.
type Listener = () => void;

const listeners = new Set<Listener>();

export function subscribeToChanges(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function publishChange(): void {
  for (const fn of listeners) fn();
}
