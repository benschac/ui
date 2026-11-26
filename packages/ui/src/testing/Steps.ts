/**
 * The steps every kind of test shares, and the data they work on.
 *
 * A test kind's cursor, `Story.Steps` or `Scene.Steps`, extends
 * `Steps.Steps`: it starts from a Model, changes the props, settles Commands
 * and queries, and acknowledges what was emitted and sent. What each kind
 * adds on top is how a test drives the instance and what it can see. A helper
 * typed over `Steps.Steps.Any` works with any kind's cursor and keeps the
 * caller's type.
 *
 * **The acknowledgement rule**
 *
 * A test is the full account of what the component did, so a step throws
 * when earlier work is still in flight or an earlier output hasn't been
 * acknowledged:
 *
 * - A message step (`subscription`, `layerFailed`, Story's `send`, a
 *   Scene's interactions and child steps) throws while a Command
 *   or a load more is pending, or while an enabled query has no result at
 *   its args. A Command whose mode is `switch` or `queue` doesn't block,
 *   nor does a stream Command, nor anything `keepPending` named.
 * - Every acting step (a message step, a settle step, `props`, `given`)
 *   throws while an event or a send isn't acknowledged with `emitted` or
 *   `sent`, or, in a Scene, while an ignored interaction isn't acknowledged
 *   with `expectIgnored`.
 * - `make`'s end check, which runs when its scope closes, fails on anything
 *   pending, kept or exempt included, on a query with no result unless it
 *   was kept, and on any output not acknowledged. A `start` cursor gets the
 *   checks before each step only.
 * - `given` after an acting step throws rather than discard pending work,
 *   a query with no result it would disable, or unacknowledged outputs.
 *   Before any acting step it replaces what `init` produced.
 *
 * @stability experimental
 * @since 0.1.0
 */
import type { Pipeable } from "effect/Pipeable"
import type * as AsyncResult from "effect/reactivity/AsyncResult"
import type * as Command from "../Command.ts"
import type * as Component from "../Component.ts"
import type * as Query from "../Query.ts"

/**
 * A Command issued by the instance whose message hasn't been delivered.
 *
 * **Details**
 *
 * `running` is what the runtime would be executing; `queued` is waiting behind
 * a running run of the same group under `mode: "queue"`. `awaiting` has
 * resolved or failed, and holds `message`: a `Command.afterRefetch` run
 * waits for the queries in `awaiting`, and under `mode: "queue"` a
 * message also waits for the earlier ones of its group.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Pending<Msg> {
  readonly command:
    | Command.Issued<Msg | Component.Noop, any, never, "Effect">
    | Command.Issued<Msg | Component.Noop, any, never, "Stream">
  readonly status: "running" | "queued" | "awaiting"
  /** On an awaiting run: the message it delivers when its wait ends, or `Component.noop` for none. */
  readonly message?: Msg | Component.Noop | undefined
  /** On an awaiting run: the queries its wait is still on, each at the args it awaits. */
  readonly awaiting?: ReadonlyArray<AwaitedQuery> | undefined
}

/**
 * A query a `Command.afterRefetch` run waits for, by its name in
 * `queries`, at the args it returned when the run resolved. A `queryMany`
 * query has one per awaited key.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface AwaitedQuery {
  readonly name: string
  readonly args: unknown
}

/**
 * The state of one instance between steps that every kind of test records.
 * Immutable: every step replaces the cursor's record with a new one. Each
 * kind's record extends it with what that kind can see.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Record<Props, Model, Msg, Events> {
  readonly component: Component.Component<
    any,
    Props,
    Model,
    Msg,
    Events,
    any,
    any,
    any
  >
  readonly props: Props
  /** Commands issued but not yet resolved, oldest first. */
  readonly pending: ReadonlyArray<Pending<Msg>>
  /** The events emitted to the parent that no `emitted` step acknowledged yet, oldest first. */
  readonly emitted: ReadonlyArray<Events>
  /**
   * The `$.send`s no `sent` step acknowledged yet, oldest first. A test
   * runs no owner, so nothing receives them.
   */
  readonly sent: ReadonlyArray<Component.Send>
  /**
   * Commands interrupted by `switch` or by an interrupt Command. Nothing
   * requires a test to read it.
   * An awaiting run that is cut delivers its message instead, and isn't here.
   */
  readonly interrupted: ReadonlyArray<
    | Command.Issued<Msg | Component.Noop, any, never, "Effect">
    | Command.Issued<Msg | Component.Noop, any, never, "Stream">
  >
  /** The infinite queries with a load more `update` issued and no step has settled yet. */
  readonly loadingMore: ReadonlyArray<string>
  /**
   * The Subscription keys the current Model and props ask for, without the
   * query watches. Nothing runs. Throws when two share a key, which fails
   * the instance in the runtime.
   */
  readonly subscriptions: () => ReadonlyArray<string>
  /** Each of the component's queries, with its `Query`'s name and the args it returns for the current Model and props. */
  readonly queryInfo: () => ReadonlyArray<QueryInfo>
  /**
   * What the component reports to each owner its `reads` lists with a
   * `report`, by the name it lists the owner under, from the current Model
   * and props. An optional owner with no value given is absent, and has no
   * report.
   */
  readonly reports: { readonly [name: string]: unknown }
}

/**
 * One of a component's queries in a story: its name, its `Query`'s name, and the args it returns
 * for the current Model and props, `undefined` when it is disabled. A
 * `queryMany` query's args are its unique args, in order.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface QueryInfo {
  readonly name: string
  readonly query: string
  readonly args: unknown
}

/** What `$.send` takes for an owner that receives `Rcv`: nothing when it takes any message. */
type SendMessage<Rcv> = unknown extends Rcv ? never : Rcv

/**
 * The query results `given` starts from, by query name: a Success value, a
 * infinite query's page array, or a keyed query's entries.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type Given<C> = {
  readonly [K in keyof Component.Queries<C>]?: Component.Queries<C>[K] extends
    Component.QueryMany<infer R> ? ReadonlyArray<KeyedLoad<R>>
    : Query.Query.Success<QueryOf<Component.Queries<C>[K]>>
}

// The `Query` a `queries` entry shows, for the steps that name a query.
type QueryOf<D> = D extends Component.QueryOne<infer R> ? R
  : D extends Component.QueryMany<infer R> ? R
  : never

/**
 * One key of a `queryMany` query for `loadedMany`: its args and a Success
 * value or a typed failure.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type KeyedLoad<R extends Query.Query.Any> =
  | {
    readonly args: Query.Query.Args<R>
    readonly value: Query.Query.Success<R>
    readonly waiting?: boolean | undefined
    readonly patched?: boolean | undefined
  }
  | {
    readonly args: Query.Query.Args<R>
    readonly error: Query.Query.Error<R>
    readonly waiting?: boolean | undefined
  }

/**
 * A pending Command's definition, or an issued Command to also match the
 * arguments.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type Target =
  | Command.Definition.Any
  | Command.Issued<any, any, never, "Effect">
  | Command.Issued<any, any, never, "Stream">

/**
 * A stream Command's definition, or an issued stream Command: what `next` and
 * `end` take.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type StreamTarget =
  | Command.Definition<any, any, true, any, any>
  | Command.Issued<any, any, never, "Stream">

// A component with no messages has `Msg = never`, and its `update` can't take `any`, so it needs its own member.
type AnyComponent =
  | Component.Members<any, any, any, any, any, any, any, any>
  | Component.Members<any, any, any, never, any, any, any, any>

/**
 * The steps every kind of test shares. Each step runs as soon as it's
 * called, replaces `current` and returns the cursor, so steps chain. A step
 * that fails throws.
 *
 * **Details**
 *
 * The types come from the component: a cursor over `Counter` only takes
 * `Counter`'s Model, Commands and queries. A step shared by any component,
 * and by any kind of test, is written `<S extends Steps.Steps.Any>(s: S): S`,
 * which keeps the caller's type, so the kind's own steps still chain after it.
 *
 * **Example** (A check shared by every kind of test)
 *
 * ```ts import.meta.vitest
 * import { Effect, Schema } from "effect"
 * import { Component, UiSchema } from "@effect/ui"
 * import { Steps, Story } from "@effect/ui/testing"
 *
 * const Message = UiSchema.TaggedEnum({ ClickedIncrement: {} })
 * const Counter = Component.define({
 *   name: "Counter",
 *   model: Schema.Struct({ count: Schema.Number }),
 *   message: Message
 * }).make({
 *   init: () => ({ count: 0 }),
 *   update: ($) => ({ count: $.model.count + 1 }),
 *   view: (h, model) => h.el("button").on("click", Message.ClickedIncrement()).children(`+ ${model.count}`)
 * })
 *
 * const quiet = <S extends Steps.Steps.Any>(s: S): S =>
 *   s.expectNone().check((current) => {
 *     if (current.emitted.length > 0) throw new Error("emitted")
 *   })
 *
 * Effect.gen(function*() {
 *   const s = yield* Story.make(Counter, {})
 *   s.pipe(quiet).send(Message.ClickedIncrement())
 *   console.log(s.model.count) // 1
 * }).pipe(Effect.scoped, Effect.runSync)
 * ```
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Steps<C extends AnyComponent> extends Pipeable {
  /**
   * Delivers a message from an active Subscription, using the key reported by
   * subscriptions. Throws for inactive keys and query watch keys, listing
   * the active keys. The message is not checked against the source Stream.
   * A message step.
   */
  subscription(key: string, message: Component.Message<C>): this

  /**
   * Delivers the message `Component.provide`'s `onFailure` maps `failure`
   * to, or does nothing without one. A message step.
   */
  layerFailed(failure: AsyncResult.Failure<never, any>): this

  /** The record after the last step. */
  readonly current: Record<
    Component.Props<C>,
    Component.Model<C>,
    Component.Message<C>,
    Component.Events<C>
  >
  /** Commands issued but not yet resolved, oldest first, after the last step. */
  readonly pending: this["current"]["pending"]
  /** Commands interrupted by `switch` or by an interrupt Command, after the last step. */
  readonly interrupted: this["current"]["interrupted"]
  /** The infinite queries with a load more pending, after the last step. */
  readonly loadingMore: ReadonlyArray<string>
  /**
   * The Subscription keys the current Model and props ask for, without the
   * query watches. Nothing runs. Throws when two share a key, which fails
   * the instance in the runtime.
   */
  readonly subscriptions: ReadonlyArray<string>
  /** Each of the component's queries, with its `Query`'s name and the args it returns for the current Model and props. */
  readonly queryInfo: ReadonlyArray<QueryInfo>

  /**
   * Starts from any Model. An updater is called with the current Model:
   * `given(f)` is exactly `given(f(model))`.
   *
   * **Details**
   *
   * Before any other acting step, `given` replaces what `init` produced:
   * its Commands, events and sends are dropped. After one, it throws while
   * a Command or a load more is pending, a mount or an output isn't
   * acknowledged, or when it would drop a query entry that has no result,
   * as when the given Model disables the query.
   *
   * `given` never runs `update`. Queries keep their results, except that a
   * keyed query drops the stored keys it no longer returns, with no
   * `onChange` message. Later steps send `onChange` as usual.
   *
   * `queries` starts the queries it names from loaded results: a Success
   * value, an infinite query's page array, or a keyed query's entries as
   * `loadedMany` takes them. Each result is written at the args the query
   * returns for the new Model and the given results, so a query whose args
   * read another's result follows the new one, whatever the order of the keys
   * and whatever the results held before. The view renders once. It throws if a
   * named query is disabled, or a keyed entry's args aren't ones the query
   * returns.
   *
   * `shared` sets the values owners share, as `shared` steps would, but
   * sends no `onChange` message: `[[TooltipProvider, value], [ThemeProvider,
   * value]]`. Values given before and not listed are kept.
   */
  given<const O extends ReadonlyArray<Component.Headless.Any> = []>(
    model:
      | Component.Model<C>
      | ((model: Component.Model<C>) => Component.Model<C>),
    queries?: Given<C>,
    shared?: {
      readonly [K in keyof O]: readonly [
        owner: O[K],
        value: Component.Shared.Value<O[K]>
      ]
    }
  ): this
  /**
   * Sets the value `owner` shares with the component, in place of the one it
   * would see otherwise.
   *
   * **Details**
   *
   * `owner` is a headless component with `shares`, and the value is keyed
   * by it, not by a reader's local name: in a scene, one step reaches the
   * scene's component and every headless child the scene expands. The value
   * is kept until the next `shared` step or `given` that sets one for
   * `owner`.
   *
   * Without it, a reader sees the value of the nearest `owner` in the
   * scene's own view, or else, for an `optional` read, `undefined`, and
   * for a required one `shares({ model: init(props).model, props, reads })` with no props
   * when every prop of `owner` is optional. Otherwise rendering a scene
   * throws, naming this step, but not in a `shared` step: `shared` steps
   * in a row can give several owners' values.
   *
   * When the component had a value for `owner`, given before or the
   * default of a required read, and this one differs, each `onChange` its
   * `reads` lists for `owner` sends its message, and the step is a
   * message step. A first value of an optional owner sends nothing: in an
   * app the owner is found once, when the reader mounts. The test never
   * runs `owner`'s `update`: what the component sends it must be
   * acknowledged with `sent`, and a send to an optional owner with no value
   * given is dropped.
   */
  shared<O extends Component.Headless.Any>(
    owner: O,
    value: Component.Shared.Value<O>
  ): this
  /**
   * Changes the props. A props change never reaches `update`: it changes the
   * view, the queries' args and the Subscription keys.
   */
  props(
    next:
      | Component.Props<C>
      | ((props: Component.Props<C>) => Component.Props<C>)
  ): this

  /**
   * Resolves the oldest running Command matching `target` with the result it
   * would have produced, and sends the message.
   *
   * **Details**
   *
   * A definition matches by identity; an issued Command also matches the
   * arguments. `result` is the definition's own result, before any
   * `Command.map`, which is replayed to produce the component's message. A
   * queued run of the same group starts when the running one resolves.
   *
   * A Command issued with `Command.afterRefetch` becomes `awaiting` on the
   * component's own queries its declared targets match, less those its
   * `writes` store, and sends at once when there are none. A `loaded` or
   * `loadFailed` step on the last of them writes the query's result, then
   * sends this one. `waitExpired` ends the wait by budget. Under `mode: "queue"`
   * a message also waits for the earlier ones of its group.
   */
  resolve<D extends Target>(target: D, result: Command.Result<D>): this
  /**
   * Fails the oldest running Command matching `target` with a typed failure
   * of its body, and sends the message its `Command.match` maps it to. A
   * stream Command ends. Throws for a Command whose body can't fail. A
   * failure doesn't wait for refetches.
   */
  fail<D extends Target>(target: D, error: Command.Failure<D>): this
  /** Sends one element of the oldest running stream Command matching `target`, which stays pending. */
  next<D extends StreamTarget>(target: D, result: Command.Result<D>): this
  /** Ends the oldest running stream Command matching `target`, sending nothing. */
  end<D extends StreamTarget>(target: D): this
  /**
   * Ends the `Command.afterRefetch` wait of the oldest awaiting Command
   * matching `target` by its budget, and sends its message. Throws when no
   * matching Command is waiting.
   */
  waitExpired(target: Target): this

  /**
   * Loads a query with a Success: writes its result at the query's current
   * args, then sends the message of its `onChange`, if any. Throws when the
   * query is disabled. For an infinite query `value` is the page array, and
   * unless `waiting` it settles a pending load more.
   *
   * **Details**
   *
   * Unless `waiting` or `patched`, it is a settle: it ends a
   * `Command.afterRefetch` wait on the query. It throws while a running or
   * queued Command's patch is live on the query, since no fetch settles
   * under a live patch: only a `patched` value is written then. As in the
   * cache, a patch is live only when the result held a Success at issue.
   */
  loaded<N extends Component.SingleNames<Component.Queries<C>>>(
    name: N,
    value: Query.Query.Success<QueryOf<Component.Queries<C>[N]>>,
    options?: {
      readonly waiting?: boolean | undefined
      readonly patched?: boolean | undefined
    }
  ): this
  /**
   * Loads one key of a `queryMany` query with a Success, as `loadedMany`
   * does with one entry.
   */
  loaded<N extends Component.KeyedNames<Component.Queries<C>>>(
    name: N,
    args: Query.Query.Args<QueryOf<Component.Queries<C>[N]>>,
    value: Query.Query.Success<QueryOf<Component.Queries<C>[N]>>,
    options?: {
      readonly waiting?: boolean | undefined
      readonly patched?: boolean | undefined
    }
  ): this
  /**
   * Loads a query with a typed failure, as `loaded` does. The failure keeps
   * the result's last Success as `previousSuccess` when it holds one at the
   * query's current args. Unless `waiting`, it settles an infinite query's
   * pending load more.
   */
  loadFailed<N extends Component.SingleNames<Component.Queries<C>>>(
    name: N,
    error: Query.Query.Error<QueryOf<Component.Queries<C>[N]>>,
    options?: { readonly waiting?: boolean | undefined }
  ): this
  /** Loads one key of a `queryMany` query with a typed failure, as `loadedMany` does with one entry. */
  loadFailed<N extends Component.KeyedNames<Component.Queries<C>>>(
    name: N,
    args: Query.Query.Args<QueryOf<Component.Queries<C>[N]>>,
    error: Query.Query.Error<QueryOf<Component.Queries<C>[N]>>,
    options?: { readonly waiting?: boolean | undefined }
  ): this
  /**
   * Settles an infinite query's pending load more with its next page: writes the
   * query's pages with `page` appended. Throws when no load more is
   * pending.
   */
  loadedMore<N extends Component.InfiniteNames<Component.Queries<C>>>(
    name: N,
    page: Query.InfiniteQuery.Page<QueryOf<Component.Queries<C>[N]>>
  ): this
  /**
   * Settles an infinite query's pending load more with a failure: the pages stay,
   * and `more` is `Failed` with `error`. Throws when no load more is
   * pending.
   */
  loadMoreFailed<N extends Component.InfiniteNames<Component.Queries<C>>>(
    name: N,
    error: Query.Query.Error<QueryOf<Component.Queries<C>[N]>>
  ): this
  /**
   * Loads several keys of a `queryMany` query in one write, as the runtime
   * writes a first emission or a batch: the result holds the query's stored
   * keys and these, and `onChange`'s `changes` holds these. Throws on args
   * the query doesn't currently return.
   */
  loadedMany<N extends Component.KeyedNames<Component.Queries<C>>>(
    name: N,
    entries: ReadonlyArray<KeyedLoad<QueryOf<Component.Queries<C>[N]>>>
  ): this

  /**
   * Acknowledges the oldest events no step acknowledged yet, after asserting
   * they are `events`, in order. Events compare with the component's
   * `events` Schema.
   */
  emitted(
    ...events: readonly [Component.Events<C>, ...Array<Component.Events<C>>]
  ): this
  /**
   * Acknowledges the oldest `$.send` no step acknowledged yet, after
   * asserting it went to the nearest `owner` above with `message`,
   * compared with the owner's `receives` Schema.
   */
  sent<O extends Component.Headless.Any>(
    owner: O,
    message: NoInfer<SendMessage<Component.Shared.Receives<O>>>
  ): this
  /**
   * Marks pending work as intended to stay pending, so it stops blocking
   * message steps until it settles: every pending Command `target` matches,
   * or, given a query's name, its entries with no result or its pending load
   * more.
   *
   * **Details**
   *
   * A query's mark ends when its args change, since that starts a new fetch.
   * A kept query with no result passes `make`'s end check; a kept Command or
   * load more doesn't. Throws when nothing pending matches.
   */
  keepPending(target: Target | (keyof Component.Queries<C> & string)): this
  /** Checks the whole record, as the kind of test records it. `f` throws to fail the test. */
  check(f: (current: this["current"]) => void): this

  /** Asserts that exactly these Commands are pending, in order. */
  expectExact(...targets: ReadonlyArray<Target>): this
  /** Asserts that a Command matching `target` is pending. */
  expectHas(target: Target): this
  /** Asserts that nothing is pending. */
  expectNone(): this
}

/**
 * Helper types for `Steps`.
 *
 * @stability experimental
 * @since 0.1.0
 */
export declare namespace Steps {
  /**
   * A cursor over any component, of any kind of test, for steps shared
   * across components and kinds.
   *
   * @stability experimental
   * @category models
   * @since 0.1.0
   */
  export type Any = Steps<AnyComponent>
}
