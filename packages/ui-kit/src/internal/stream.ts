import type * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"

/**
 * `Stream.merge`, but `now` starts in the caller's fiber instead of on the
 * scheduler. A positioner's first placement then lands before the browser
 * paints, so it doesn't show unplaced for a frame. `later` runs as it would
 * in `Stream.merge`: its focus moves need the commit to have finished.
 */
export const mergeNow = <A, B, R1, R2>(
  now: Stream.Stream<A, never, R1>,
  later: Stream.Stream<B, never, R2>
): Stream.Stream<A | B, never, R1 | R2> =>
  Stream.unwrap(Effect.gen(function*() {
    const queue = yield* Queue.unbounded<A, Cause.Done>()
    yield* Effect.forkScoped(Stream.runIntoQueue(now, queue), {
      startImmediately: true
    })
    return Stream.merge(Stream.fromQueue(queue), later)
  }))
