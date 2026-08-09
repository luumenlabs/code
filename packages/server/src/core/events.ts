/** Minimal typed event bus for local subscribers (the harness, the CLI). */
import type { ServerEvent } from "@luumen/code-protocol";

export type Subscriber = (event: ServerEvent) => void;

export class EventBus {
  private readonly subscribers = new Set<Subscriber>();

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  emit(event: ServerEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        // A broken subscriber must not take down the emitter; the SSE layer
        // removes itself on write failure.
      }
    }
  }

  get size(): number {
    return this.subscribers.size;
  }
}
