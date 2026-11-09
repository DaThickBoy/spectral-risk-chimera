/**
 * Outbound ports of the application layer (task 6.2; design: Portfolio, D-16).
 *
 * Implemented later by an adapter over the in-process event bus (D-7); tests use
 * a recording fake. Concrete wiring belongs to the deferred composition root.
 */
import type { PositionsChanged } from '../portfolio/index.js';

export interface PositionEventPublisher {
  /** Publishes one event. Called only after a successful commit. May throw. */
  publish(event: PositionsChanged): void;
}
