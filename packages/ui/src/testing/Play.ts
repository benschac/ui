/**
 * Play tests mount a component on `TestHost` and drive it as a user does,
 * with the Scene's steps, while the runtime runs: children are real,
 * Commands and Subscriptions run against the Layers the test provides, and
 * the test resolves nothing by hand.
 *
 * A Play is any test where effects run and aren't resolved by the test,
 * one component included. Write one for how components work together: a
 * child's real view, a Command's real implementation, a Subscription on the
 * clock, the Router, a Layer. Its file is `X.play.test.ts`. One instance on
 * its own is a `Story` or a `Scene`, which fail closer to the cause.
 *
 * Every step is an Effect, one `yield*` per step. A step settles before it
 * acts, so it picks up a `TestClock.adjust`, a navigation or a
 * `TestHost.setOnline` the test made since the last one, and settles again
 * after, so the work it caused has run before the test moves on. `expect`
 * settles, then checks. A failed check is a defect, with the stack of the
 * step's call site, and a crashed root or an unhandled query problem fails
 * the step with `settle`'s typed error.
 *
 * Of the Scene's acknowledgement rule only one part carries over: an
 * interaction no handler turned into a message must be followed by
 * `expectIgnored()`. Commands, events and sends need no acknowledgement,
 * since Layers and real components answered them.
 *
 * **Example** (Saving through a real Command)
 *
 * ```ts import.meta.vitest
 * import { Command, Component, UiSchema } from "@effect/ui"
 * import { Locator, Play, TestHost } from "@effect/ui/testing"
 * import { Effect, Schema } from "effect"
 *
 * const Message = UiSchema.TaggedEnum({ ClickedSave: {}, CompletedSave: {} })
 *
 * class Save extends Command.Service<Save>()(
 *   "todos/Save",
 *   { args: {}, success: Message, error: Schema.Never }
 * ) {
 *   static readonly layer = this.toLayer(() => Effect.succeed(Message.CompletedSave()))
 * }
 *
 * const Todo = Component.define({
 *   name: "Todo",
 *   model: Schema.Boolean,
 *   message: Message
 * }).make({
 *   init: () => false,
 *   update: ($, message) =>
 *     Message.match(message, {
 *       ClickedSave: () => $.run(Save.make({})),
 *       CompletedSave: () => true
 *     }),
 *   view: (h, saved) => h.el("button").on("click", Message.ClickedSave()).children(saved ? "saved" : "save")
 * }).pipe(Component.provide(Save.layer))
 *
 * Effect.gen(function*() {
 *   const play = yield* Play.make(Todo, {})
 *   yield* play.click("save")
 *   yield* play.expect(Locator.tag("button")).toHaveText("saved")
 * }).pipe(Effect.scoped, Effect.provide(TestHost.layer()), Effect.runPromise)
 * ```
 *
 * @stability experimental
 * @since 0.1.0
 */
import type * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type * as Component from "../Component.ts"
import * as internal from "../internal/play.ts"
import type * as View from "../View.ts"
import type * as Locator from "./Locator.ts"
import type * as Scene from "./Scene.ts"
import type * as TestHost from "./TestHost.ts"
import type * as TestQuery from "./TestQuery.ts"

/**
 * How a step fails: `TestHost.settle`'s errors, from the settle before or
 * after it.
 *
 * @stability experimental
 * @category errors
 * @since 0.1.0
 */
export type StepError =
  | TestHost.SettleError
  | TestHost.RootCrashed
  | TestQuery.ProblemsError

/**
 * The assertions `expect(locator)` offers: the Scene's, each an Effect that
 * settles, then checks the elements `locator` matches on the tree. A
 * failure lists the tree's elements.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type Expect = Scene.Expect<Effect.Effect<void, StepError>>

/**
 * A cursor over a tree mounted on `TestHost`.
 *
 * **Details**
 *
 * An interaction settles, sends its events to the live tree as the host
 * would, then settles again. It throws when its locator matches nothing or
 * several elements, or when nothing handles its event, and fails when the
 * interaction before it produced no message and nothing acknowledged that.
 *
 * `root` is the `TestRoot` under the cursor, for `model()`, `log()`,
 * `head()`, `emitted` and the rest. `TestHost.settle`, `setOnline` and
 * `expectProblem` work beside a Play, since it's the same host.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Play<Model, Msg, Events> {
  readonly root: TestHost.TestRoot<Model, Msg, Events>
  /**
   * Clicks the one element `target` matches: the innermost element with a
   * `click` handler, that element or an ancestor, gets it. A string means
   * `Locator.text(target)`. The payload is a mouse's primary button at the
   * origin with no modifier keys.
   */
  click(target: string | Locator.Locator): Effect.Effect<void, StepError>
  /**
   * Sends `event` with `payload`, `{}` by default, to the one element
   * `locator` matches: the innermost element with a handler for it, that
   * element or an ancestor, gets it.
   */
  fire(
    locator: Locator.Locator,
    event: string,
    payload?: unknown
  ): Effect.Effect<void, StepError>
  /** Asserts on the elements `locator` matches, once the tree has settled. */
  expect(locator: Locator.Locator): Expect
  /**
   * Acknowledges that the last interaction produced no message. Fails when
   * it produced one, or when no interaction has run.
   */
  expectIgnored(): Effect.Effect<void>
}

/**
 * Mounts `component` on `TestHost` with `props`, settles, and returns a
 * cursor over it, for the life of the current Scope.
 *
 * **Details**
 *
 * `props` may be an Effect, such as `Router.props(AppRoute)` under
 * `Router.memory`, as with `TestHost.mount`. The Layers come from the
 * test's environment, `TestHost.layer()` included.
 *
 * When the scope closes with a success, the end check settles once more, so
 * a crash or a query problem after the last step still fails the test, and
 * fails on an ignored interaction nothing acknowledged. Work still asleep on
 * the clock or waiting outside the app doesn't fail it: read
 * `play.root.pending()` to assert on that. When the scope closes with a
 * failure the end check doesn't run.
 *
 * @stability experimental
 * @category constructors
 * @since 0.1.0
 */
export const make = <
  Name extends string,
  Props,
  Model,
  Msg,
  Events,
  R,
  V extends View.Elements,
  RP = never
>(
  component: Component.Members<Name, Props, Model, Msg, Events, R, V, any>,
  props: Props | Effect.Effect<Props, never, RP>
): Effect.Effect<
  Play<Model, Msg, Events>,
  StepError,
  R | RP | TestHost.TestHost | Scope.Scope
> => internal.begin(internal.PlayCursor, "Play", make, component, props) as any
