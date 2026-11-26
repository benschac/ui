/**
 * Scene tests drive one component through its rendered view and assert on
 * what it renders: pure, with no runtime, no Layers and no host.
 *
 * A scene can only do what the view allows: a click reaches `update` only
 * through the handler the view put on the element. That makes a scene the
 * evidence for what the app does, where a `Story` is evidence about
 * `update`. A scene has no `send` and doesn't show the Model; it asserts
 * with `expect(locator)` on the view.
 *
 * Commands stay pending as data until a step resolves them, as in a story,
 * and every step follows the acknowledgement rule described in `Steps`. An
 * interaction that no handler turned into a message must be followed by
 * `expectIgnored()`. A child is a leaf: `childEmit` stands in for what it
 * emits, and anything that crosses into one is a `Play`. A child step
 * names the child by its component, then by its key when it has one:
 * `childEmit(Listbox, event)`, `childEmit(TodoItem, "t1", event)`.
 *
 * A child whose component `run` names is run instead:
 * `Scene.make(Page, props, { run: [TodoItem] })` shows its view, a click on
 * it goes to its `update`, its mounts are the scene's to name, and its
 * events reach the parent through `onEmit`. Its Subscriptions don't run,
 * and a step that starts one of its Commands or queries fails.
 *
 * **Example** (Save, resolve its Command, see the result)
 *
 * ```ts import.meta.vitest
 * import { Command, Component, UiSchema } from "@effect/ui"
 * import { Locator, Scene } from "@effect/ui/testing"
 * import { Effect, Schema } from "effect"
 *
 * const Message = UiSchema.TaggedEnum({ ClickedSave: {}, CompletedSaveTodo: {} })
 *
 * class SaveTodo extends Command.Service<SaveTodo>()(
 *   "todos/SaveTodo",
 *   { args: { id: Schema.String }, success: Message }
 * ) {}
 *
 * const TodoItem = Component.define({
 *   name: "TodoItem",
 *   props: Schema.Struct({ id: Schema.String }),
 *   model: Schema.Struct({ saved: Schema.Boolean }),
 *   message: Message
 * }).make({
 *   init: () => ({ saved: false }),
 *   update: ($, message) =>
 *     Message.match(message, {
 *       ClickedSave: () => $.run(SaveTodo.make({ id: $.props.id })),
 *       CompletedSaveTodo: () => ({ saved: true })
 *     }),
 *   // In a scene, `h.isRunning` is derived from the pending Commands.
 *   view: (h, model) =>
 *     h.el("button").on("click", Message.ClickedSave()).children(
 *       model.saved ? "saved" : h.isRunning(SaveTodo) ? "saving" : "save"
 *     )
 * })
 *
 * Effect.gen(function*() {
 *   const s = yield* Scene.make(TodoItem, { id: "t1" })
 *   s.click("save")
 *     .expect(Locator.text("saving")).toExist()
 *     .expectExact(SaveTodo.make({ id: "t1" }))
 *     .resolve(SaveTodo, Message.CompletedSaveTodo())
 *     .expect(Locator.tag("button")).toHaveText("saved")
 * }).pipe(Effect.scoped, Effect.runSync)
 * ```
 *
 * @stability experimental
 * @since 0.1.0
 */
import type * as Cause from "effect/Cause"
import type * as Effect from "effect/Effect"
import type * as AsyncResult from "effect/reactivity/AsyncResult"
import type * as Scope from "effect/Scope"
import type * as Component from "../Component.ts"
import type * as Feature from "../Feature.ts"
import { checkChildPaths, checkFallbackPaths } from "../internal/paths.ts"
import * as internal from "../internal/scene.ts"
import * as cursor from "../internal/steps.ts"
import * as engine from "../internal/story.ts"
import type * as Mount from "../Mount.ts"
import * as View from "../View.ts"
import type * as Locator from "./Locator.ts"
import type * as Shared from "./Steps.ts"

/**
 * A mount's definition, or an issued mount to also match the args.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type MountTarget = Mount.Definition.Any | Mount.Any

/**
 * The result argument of the `mounted` step: the definition's own result,
 * and none for a mount that ends with `Component.noop`.
 *
 * @stability experimental
 * @category utility types
 * @since 0.1.0
 */
export type MountedResult<D> = [Mount.Result<D>] extends [Component.Noop] ? []
  : [result: Mount.Result<D>]

/**
 * The state of one instance between steps, as a scene records it: what the
 * view shows, and no Model. Immutable: every step replaces the cursor's
 * record with a new one.
 *
 * **Details**
 *
 * `get`, `query` and `all` run locators over the current view, as
 * `TestHost`'s roots do.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Scene<Props, Model, Msg, Events>
  extends Shared.Record<Props, Model, Msg, Events>
{
  /**
   * Whether the interaction that made this record cancelled its event's
   * default, as the browser host would: its handler was set with
   * `preventDefault: true` and produced a message, or with
   * `preventDefault: "always"`, or the event is `submit`, which is always
   * cancelled. Every other step that makes a record resets it to `false`.
   */
  readonly defaultPrevented: boolean
  /**
   * The view of the current Model and props, rendered once the step that
   * changed them has sent its keyed prunes, so a defect in `view` fails that
   * step.
   */
  readonly view: () => View.Node<Msg, any>
  /** The view as a `Locator.Node` tree. */
  readonly root: Locator.Node
  /** The one element matching `locator`. Throws when there's none or several. */
  readonly get: (locator: Locator.Locator) => Locator.Node
  /** The one element matching `locator`, or `undefined`. Throws when there are several. */
  readonly query: (locator: Locator.Locator) => Locator.Node | undefined
  /** Every element matching `locator`, in document order. */
  readonly all: (locator: Locator.Locator) => ReadonlyArray<Locator.Node>
}

/**
 * The assertions `expect(locator)` offers. Each one checks the elements
 * `locator` matches in the current view and returns the cursor. A failure
 * lists the view's elements.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Expect<S> {
  /** Asserts that at least one element matches. */
  toExist(): S
  /** Asserts that nothing matches. */
  toBeAbsent(): S
  /**
   * Asserts that exactly one element matches and that its text, with
   * whitespace collapsed and trimmed, is `text`, or matches it.
   */
  toHaveText(text: string | RegExp): S
  /**
   * Asserts that exactly one element matches. Omit `value` to check attribute
   * presence, pass a string or `RegExp` to check its value, or `false` for absence.
   */
  toHaveAttribute(name: string, value?: string | RegExp | false): S
  /** Asserts that exactly `count` elements match. */
  toHaveCount(count: number): S
}

/** The events a child emits: a component's, a headless component's, a lazy component's or a feature's. */
type EventsOf<Child> = Child extends Feature.Service<any, any, infer E> ? E
  : Child extends Component.Lazy.Members<any, infer E, any, never> ? E
  : Child extends
    Component.Headless<any, infer E, any, any, infer _Rcv, never> ? E
  : Component.Events<Child>

// The same union as `Steps.ts`'s, so `Scene.Steps.Any` extends `Steps.Steps.Any`.
type AnyComponent =
  | Component.Members<any, any, any, any, any, any, any, any>
  | Component.Members<any, any, any, never, any, any, any, any>

/**
 * A cursor over one scene. It has the steps every kind of test shares, from
 * `Steps.Steps`, and drives the instance through its view.
 *
 * **Details**
 *
 * `Parts` is a headless component's parts, in a scene that stands in a
 * view for one. A step shared by any component is written
 * `<S extends Scene.Steps.Any>(s: S): S`, which keeps the caller's type.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Steps<C extends AnyComponent, Parts = never, Report = never>
  extends Shared.Steps<C>
{
  /** The scene after the last step. */
  readonly current: Scene<
    Component.Props<C>,
    Component.Model<C>,
    Component.Message<C>,
    Component.Events<C>
  >
  /** Whether the last interaction cancelled its event's default, as `current.defaultPrevented` reports it. */
  readonly defaultPrevented: boolean
  /** The view after the last step. */
  readonly view: View.Node<Component.Message<C>, any>
  /** The view after the last step, as a `Locator.Node` tree. */
  readonly root: Locator.Node
  /** The one element matching `locator` in the current view. Throws when there's none or several. */
  get(locator: Locator.Locator): Locator.Node
  /** The one element matching `locator` in the current view, or `undefined`. Throws when there are several. */
  query(locator: Locator.Locator): Locator.Node | undefined
  /** Every element matching `locator` in the current view, in document order. */
  all(locator: Locator.Locator): ReadonlyArray<Locator.Node>

  /**
   * Gives an owner of shared state the reports of its readers, as the
   * runtime collects them once a render pass settles, in no promised order.
   * Runs the `onChange` of `shares`'s `collects` and sends its message when
   * it differs from the one it last returned, starting from its message for
   * no reports. A message step when it sends. Throws for a component whose
   * `shares` has no `collects`. A scene of a headless component only.
   */
  collected(reports: ReadonlyArray<Report>): this
  /**
   * Clicks the one element `target` matches: the innermost element with a
   * `click` handler, that element or an ancestor, sends its message. A
   * string means `Locator.text(target)`. Throws when nothing or several
   * elements match, or when nothing handles the click. An interaction. The
   * payload is a mouse's primary button at the origin with no modifier keys:
   * `fire` sends a click with another, such as a tap's `pointerType`.
   */
  click(target: string | Locator.Locator): this
  /**
   * Sends `event` with `payload`, `{}` by default, to the one element
   * `locator` matches: the innermost element with a handler for it, that
   * element or an ancestor, sends its message. Throws when nothing handles
   * it, `submit` included. An interaction: one whose handlers produced no
   * message must be followed by `expectIgnored()`.
   */
  fire(locator: Locator.Locator, event: string, payload?: unknown): this
  /**
   * Sends the message the parent's `onEmit` maps `event` from the child of
   * `child` without a key to, if any. `child` types `event`. A message step.
   *
   * **Details**
   *
   * `child` is the component, a provided copy of it, the lazy component or
   * the feature service the child was rendered from. Throws when the view has no such
   * child, or several, as two unkeyed children in different headless
   * closures would be.
   */
  childEmit<
    Child extends
      | Component.Any
      | Component.Headless.Any
      | Component.Lazy.Any
      | Feature.Any
  >(
    child: Child,
    event: EventsOf<Child>
  ): this
  /**
   * Sends the message the parent's `onEmit` maps `event` from the child of
   * `child` at `key` to, if any. A message step.
   */
  childEmit<
    Child extends
      | Component.Any
      | Component.Headless.Any
      | Component.Lazy.Any
      | Feature.Any
  >(
    child: Child,
    key: string,
    event: EventsOf<Child>
  ): this
  /**
   * Fails the child of `child` without a key: its slot shows the failure
   * branch of its `fallback`, or nothing without one, as the runtime's does,
   * and the step sends the message the parent's `onFailure` maps the failure
   * to, if any. The failure is passed as an `AsyncResult.Failure`. A message
   * step.
   */
  childFailure(
    child:
      | Component.Any
      | Component.Headless.Any
      | Component.Lazy.Any
      | Feature.Any,
    cause: Cause.Cause<unknown>
  ): this
  /**
   * Fails the child of `child` at `key`, as `childFailure` without a key
   * does. A message step.
   */
  childFailure(
    child:
      | Component.Any
      | Component.Headless.Any
      | Component.Lazy.Any
      | Feature.Any,
    key: string,
    cause: Cause.Cause<unknown>
  ): this
  /**
   * Shows the slot of the child of `child` without a key as pending, as a
   * feature slot is while the Layer it resolves from builds: it renders the
   * pending branch of its `fallback`, passed `AsyncResult.initial(true)`.
   *
   * **Details**
   *
   * The status is for the slot at the child's path, for the rest of the
   * scene, until a `childFailure` step fails it. Throws when the child has no
   * `fallback`, as the runtime does for a feature slot.
   */
  childPending(
    child:
      | Component.Any
      | Component.Headless.Any
      | Component.Lazy.Any
      | Feature.Any
  ): this
  /**
   * Shows the slot of the child of `child` at `key` as pending.
   */
  childPending(
    child:
      | Component.Any
      | Component.Headless.Any
      | Component.Lazy.Any
      | Feature.Any,
    key: string
  ): this
  /**
   * Sets the Model the headless child of `child` without a key is expanded
   * from, in place of its `init` Model. The scene never runs the child's
   * `update`.
   *
   * **Details**
   *
   * The Model is for the instance the step found, at its path: a child at
   * another path keeps its own, even one with the same component and key in
   * another closure, or one a later step renders.
   */
  givenChild(child: Component.Headless.Any, model: unknown): this
  /**
   * Sets the Model the headless child of `child` at `key` is expanded from.
   */
  givenChild(child: Component.Headless.Any, key: string, model: unknown): this
  /**
   * Ends the one mount matching `target` with the result its body would have
   * produced, and sends the message the view's `Mount.map` makes of it.
   *
   * **Details**
   *
   * A definition matches by name; an issued mount also matches the args, by
   * the args Schema's equivalence. A mount that ends with `Component.noop`
   * takes no result. A mount ends once, except one from `Mount.makeStream`,
   * which takes one value of its Stream per step.
   *
   * Only the scene's component's mounts count: its elements', those in
   * content it passes to a child's slots, and those of the parts it owns.
   * Throws when no mount matches, or several do, listing the mounts.
   *
   * Under the acknowledgement rule a new mount is work in flight: it blocks
   * the next message step and `make`'s end check until `mounted` or
   * `expectMount` names it, and a step that removes it before then throws.
   */
  mounted<D extends MountTarget>(target: D, ...result: MountedResult<D>): this
  /**
   * Asserts that exactly one mount is `mount`: the same definition, with the
   * args the view last rendered equal to its args. It acknowledges the mount
   * as running.
   */
  expectMount(mount: Mount.Any): this

  /** Asserts on the elements `locator` matches in the current view. */
  expect(locator: Locator.Locator): Expect<this>
  /** Asserts that the last step was an interaction that produced a message. Optional. */
  expectHandled(): this
  /**
   * Acknowledges that the last step was an interaction no handler turned
   * into a message. Throws after any other step.
   */
  expectIgnored(): this
  /** Asserts that the last interaction cancelled its event's default, or didn't with `false`. */
  expectDefaultPrevented(expected?: boolean): this
  /**
   * Checks a headless component's parts, the plain values a consumer's
   * closure reads, for the current Model and props. `f` throws to fail the
   * test.
   */
  parts(f: (parts: Parts) => void): this
}

/**
 * Helper types for `Steps`.
 *
 * @stability experimental
 * @since 0.1.0
 */
export declare namespace Steps {
  /**
   * A cursor over any component, for steps shared across components.
   *
   * @stability experimental
   * @category models
   * @since 0.1.0
   */
  export type Any = Steps<AnyComponent, any>
}

/** The vocabulary a component's view builds from. */
type VocabularyOf<C> = C extends { readonly "~V"?: infer V } ? V : never

/**
 * Starts a scene: `init` with `props`, as a cursor in a scope. The test
 * calls steps on the cursor and reads the view from it.
 *
 * **Details**
 *
 * When the scope closes with a success, the end check runs: it fails on
 * anything pending, kept or exempt included, on a query with no result
 * unless `keepPending` named it, on a mount not acknowledged, and on any
 * event, send or ignored interaction not acknowledged. When the scope closes
 * with a failure the end check doesn't run, so a failed test reports only
 * its own failure. `it.effect` from `@effect/vitest` provides the scope,
 * which closes at the end of the test.
 *
 * @stability experimental
 * @category constructors
 * @since 0.1.0
 */
export const make: {
  <C extends AnyComponent>(
    component: C,
    props: Component.Props<C>,
    options?: {
      /**
       * The children this scene runs instead of leaving them as leaves, by their
       * component. Each shows its view against its own Model, a handler or a
       * mount in it sends to its `update`, and its events reach the component
       * that wrote it through `onEmit`. Its Subscriptions don't run, and a
       * Command, a query or slots in one fail the step: test those in the
       * child's own Story or Scene, or in a Play.
       */
      readonly run?: ReadonlyArray<Component.Any> | undefined
    }
  ): Effect.Effect<Steps<C>, never, Scope.Scope>
  /**
   * A scene of a component with slots: `slots` stands in for what a parent
   * passes. Its `h` has no messages of its own, as a parent's content in a
   * scene has nothing to send them to. `h` builds elements from
   * `elements`, or else the component's own vocabulary, and is typed the
   * same way.
   * The content shows where the view places each slot, at the path the
   * runtime gives it, such as `/Panel/[body]/Editor[e]`.
   */
  <C extends AnyComponent, V extends View.Elements = never>(
    component: C,
    props: Component.Props<C>,
    options: {
      readonly elements?: View.Vocabulary<V> | undefined
      readonly slots: (
        h: View.WithTags<
          never,
          unknown,
          [V] extends [never] ? VocabularyOf<C> : V
        >
      ) => { readonly [K in Component.Slots<C>]?: View.Input<never, any> }
      readonly run?: ReadonlyArray<Component.Any> | undefined
    }
  ): Effect.Effect<Steps<C>, never, Scope.Scope>
  /**
   * A scene of a headless component: `view` stands in for a consumer's
   * closure. Its `h` has no messages of its own, so every handler in the
   * scene is one of the component's parts'. `h` builds elements from
   * `elements`, or else the component's own vocabulary. An event runs
   * every part layer on its element, in the runtime's
   * order, and each layer's `preventDefault` applies to its own message.
   */
  <Props, Events, Parts, R, Rcv, V extends View.Elements = never, Rp = never>(
    component: Component.Headless<
      Props,
      Events,
      Parts,
      R,
      Rcv,
      never,
      never,
      Rp
    >,
    props: Props,
    options: {
      readonly elements?: View.Vocabulary<V> | undefined
      readonly view: (
        parts: Parts,
        h: View.WithTags<never, Props, V>
      ) => View.Content<never, any>
    }
  ): Effect.Effect<
    Steps<
      Component.Component<string, Props, any, any, Events, R, V>,
      Parts,
      Rp
    >,
    never,
    Scope.Scope
  >
} = (component: any, props: any, options?: any): any =>
  cursor.scoped(
    make,
    () =>
      internal.begin(internal.SceneCursor, "Scene", component, props, options)
  )

/**
 * The cursor after `init`. Its steps follow the acknowledgement rule, but
 * nothing checks what's pending or unacknowledged at the end.
 *
 * @stability experimental
 * @category constructors
 * @since 0.1.0
 */
export const start: {
  <C extends AnyComponent>(
    component: C,
    props: Component.Props<C>,
    options?: { readonly run?: ReadonlyArray<Component.Any> | undefined }
  ): Steps<C>
  <Props, Events, Parts, R, Rcv, V extends View.Elements = never>(
    component: Component.Headless<Props, Events, Parts, R, Rcv>,
    props: Props,
    options: {
      readonly elements?: View.Vocabulary<V> | undefined
      readonly view: (
        parts: Parts,
        h: View.WithTags<never, Props, V>
      ) => View.Content<never, any>
    }
  ): Steps<Component.Component<string, Props, any, any, Events, R, V>, Parts>
} = (component: any, props: any, options?: any): any =>
  internal.begin(internal.SceneCursor, "Scene", component, props, options)

/**
 * The children declared in a view, optionally filtered by component or
 * feature service.
 *
 * @stability experimental
 * @category queries
 * @since 0.1.0
 */
export const children = <Msg>(
  view: View.Node<Msg, any>,
  component?: Component.Any | { readonly key: string }
): ReadonlyArray<View.Child<Msg, any>> => engine.children(view, component)

/**
 * What a child of `child` shows for `result`: its `fallback` evaluated with an
 * `AsyncResult.Initial` or `AsyncResult.Failure`, or `undefined` without one.
 * The child is the one without a key, or the one at `key`.
 * Throws, as the runtime fails the parent, if the fallback renders two
 * children at one path, or a child at the path of another child of
 * the view, closure or slot content that declared the child. It sees one fallback, so it can't check two shown at once, as the
 * runtime does.
 *
 * @stability experimental
 * @category queries
 * @since 0.1.0
 */
export const fallback: {
  <Msg>(
    view: View.Node<Msg, any>,
    child:
      | Component.Any
      | Component.Headless.Any
      | Component.Lazy.Any
      | Feature.Any,
    result:
      | AsyncResult.Initial<never, unknown>
      | AsyncResult.Failure<never, unknown>
  ): View.Node<Msg, any> | undefined
  <Msg>(
    view: View.Node<Msg, any>,
    child:
      | Component.Any
      | Component.Headless.Any
      | Component.Lazy.Any
      | Feature.Any,
    key: string,
    result:
      | AsyncResult.Initial<never, unknown>
      | AsyncResult.Failure<never, unknown>
  ): View.Node<Msg, any> | undefined
} = <Msg>(
  view: View.Node<Msg, any>,
  component:
    | Component.Any
    | Component.Headless.Any
    | Component.Lazy.Any
    | Feature.Any,
  ...args: ReadonlyArray<any>
): View.Node<Msg, any> | undefined => {
  const [key, result] = args.length === 1 ? [undefined, args[0]] : args
  const { child, scope } = engine.findChild(
    view,
    component,
    key,
    "Scene.fallback"
  )
  if (child.fallback === undefined) return undefined
  const node = View.toNode(child.fallback(result))
  // As the runtime does: the fallback's children share the paths of the view, closure or slot content
  // that declared the child. A view no scene expanded is one such view.
  checkFallbackPaths(
    scope?.("Scene.fallback") ?? checkChildPaths("Scene.fallback", view),
    child,
    node
  )
  return node
}
