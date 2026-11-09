/**
 * `AuthGuard` (task 4.2; design: U-6, Gateway rule 3; R29.1). Type-only.
 *
 * A pre-handler hook that authenticates and authorizes a request. There is no
 * implementation and no authentication in version 1: OD-7 is open. Supplying a
 * guard does not permit a non-loopback listening host (Gateway rule 2).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface AuthGuard {
  /** Identifies the guard in the start-up log. */
  readonly name: string;
  /** Runs before every handler; it ends the request with a reply to deny it. */
  preHandler(request: FastifyRequest, reply: FastifyReply): Promise<void>;
}
