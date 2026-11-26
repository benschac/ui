/**
 * Commands are the side effects a component asks the runtime to run.
 *
 * `update` and `init` return Commands as data. The runtime runs each one and
 * feeds its result back to the instance as a message, so `update` stays pure
 * and a story test can read what was issued without running anything. A
 * Command with nothing to tell the component ends with `Component.noop`, or
 * is piped through `Command.asNoop`, and sends nothing. A `Command.Service`
 * body may return `Component.noop` whatever its `success` is.
 *
 * Both constructors take a name and options with a required `args` Schema:
 *
 * - `Command.make(name, { args }, body)` for Commands that need nothing beyond
 *   the framework services. Issue one with `RollDie.make({ sides: 6 })`. Its
 *   body can't fail.
 * - `Command.Service<Self>()(key, { args, success, error, invalidates })` for
 *   Commands that reach other services. Attach the implementation with
 *   `toLayer` (a function, or an Effect that builds one and captures its
 *   dependencies), so a component only requires the Command service. Issue
 *   with `DeleteTodo.make({ id })`; fake with `DeleteTodo.toLayer(fn)`.
 *
 * A `Command.Service` declares what it does to the query cache:
 * `invalidates`, `optimistic` and `writes` are optional. Omitting
 * `invalidates` means the run invalidates nothing.
 *
 * When one component consumes a Command's result, the usual case for an
 * app's own Commands, `success` is that component's Message Schema: the body
 * returns its message and handles a typed failure with `Effect.match`. A
 * body that leaves a typed error gives an `Unmatched` Command, which `$.run`
 * rejects.
 *
 * `Command.match`, `Command.map` and `Command.asNoop` are for a Command that
 * can't know its caller's messages: one from a library, such as
 * `Router.replace`, or one that several components issue.
 *
 * In a `Story` or `Scene`, `resolve` takes what the body returns: the
 * message in the first case, and the Command's own value in the second, where
 * `fail` takes its typed error and the mapping runs in the test.
 *
 * **Example** (A Command service with a captured dependency)
 *
 * ```ts import.meta.vitest
 * import { Command, UiSchema } from "@effect/ui"
 * import { Effect, Schema } from "effect"
 * import { KeyValueStore } from "effect/persistence"
 *
 * const Message = UiSchema.TaggedEnum({ ClickedDelete: {}, SucceededDeleteTodo: {}, FailedDeleteTodo: {} })
 *
 * class DeleteTodo extends Command.Service<DeleteTodo>()("todos/DeleteTodo", {
 *   args: { id: Schema.String },
 *   success: Message,
 *   error: Schema.Never
 * }) {
 *   static readonly layer = this.toLayer(Effect.gen(function*() {
 *     const kv = yield* KeyValueStore.KeyValueStore
 *     return ({ id }) =>
 *       kv.remove(`todo/${id}`).pipe(
 *         Effect.match({
 *           onSuccess: () => Message.SucceededDeleteTodo(),
 *           onFailure: () => Message.FailedDeleteTodo()
 *         })
 *       )
 *   }))
 * }
 *
 * // `update` issues `DeleteTodo.make({ id })`, and the component requires `DeleteTodo`.
 * // The live wiring provides `DeleteTodo.layer`, which requires `KeyValueStore`.
 * ```
 *
 * @stability experimental
 * @since 0.1.0
 */
import type * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import { TaggedClass } from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Pipeable from "effect/Pipeable"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type * as Types from "effect/Types"
import type * as Component from "./Component.ts"
import * as commandRun from "./internal/commandRun.ts"
import type * as Kernel from "./internal/kernel.ts"
import * as internalNoop from "./internal/noop.ts"
import { canonical } from "./internal/queryCore.ts"
import type * as Query from "./Query.ts"
import type * as Renderer from "./Renderer.ts"

/**
 * Identifies a Command value.
 *
 * @stability experimental
 * @category type ids
 * @since 0.1.0
 */
export const TypeId = "~@effect/ui/Command" as const

/**
 * Identifies a Command value.
 *
 * @stability experimental
 * @category type ids
 * @since 0.1.0
 */
export type TypeId = typeof TypeId

/**
 * Identifies a Command definition: a factory from `make` or a `Service` class.
 *
 * @stability experimental
 * @category type ids
 * @since 0.1.0
 */
export const DefinitionTypeId = "~@effect/ui/Command/Definition" as const

/**
 * Identifies a Command definition: a factory from `make` or a `Service` class.
 *
 * @stability experimental
 * @category type ids
 * @since 0.1.0
 */
export type DefinitionTypeId = typeof DefinitionTypeId

/**
 * Identifies a Command issued by a `Service` whose body can fail, before
 * `match` has mapped its two channels to messages.
 *
 * @stability experimental
 * @category type ids
 * @since 0.1.0
 */
export const UnmatchedTypeId = "~@effect/ui/Command/Unmatched" as const

/**
 * Identifies an unmatched Command.
 *
 * @stability experimental
 * @category type ids
 * @since 0.1.0
 */
export type UnmatchedTypeId = typeof UnmatchedTypeId

/**
 * How runs of one Command relate to each other when a new one is issued while
 * an earlier one is still running.
 *
 * **Details**
 *
 * Runs are grouped by instance, Command name and the `group` key. Within a
 * group, `concurrent` runs everything at once, `switch` interrupts the earlier
 * runs and starts the new one once their fibers have exited, cleanup
 * included, and `queue` starts it once the earlier runs have ended. A cut run
 * delivers nothing.
 *
 * A run is over when its fiber exits. One that was interrupted, by `switch`,
 * `Command.interrupt` or its instance going, still holds its group and counts
 * for `h.isRunning` until then, so a run queued behind it never overlaps its
 * cleanup.
 *
 * There is no mode that ignores a new run while one is going: `update` would
 * still apply the Model change it issued the run with. Keep what `update`
 * needs to know in the Model, such as a `Submitting` state, and issue nothing
 * while it holds.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type Mode = "concurrent" | "switch" | "queue"

/**
 * What `args` accepts: a fields record or a `Schema.Struct`.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type ArgsInput =
  | Schema.Struct.Fields
  | Schema.Struct<Schema.Struct.Fields>

/**
 * The fields of an `args` input.
 *
 * @stability experimental
 * @category utility types
 * @since 0.1.0
 */
export type ArgsFields<In> = In extends Schema.Struct<infer Fields> ? Fields
  : In extends Schema.Struct.Fields ? In
  : never

/**
 * The decoded args struct of an `args` input: what the body, `invalidates`,
 * `optimistic` and `writes` get.
 *
 * @stability experimental
 * @category utility types
 * @since 0.1.0
 */
export type ArgsOf<In> = Schema.Struct<ArgsFields<In>>["Type"]

type Json =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json }

/**
 * The args fields a `group` may name: those whose encoded form is JSON.
 *
 * @stability experimental
 * @category utility types
 * @since 0.1.0
 */
export type GroupField<In> =
  & {
    [K in keyof ArgsFields<In>]: ArgsFields<In>[K] extends
      { readonly Encoded: infer E } ? [E] extends [Json] ? K : never
      : never
  }[keyof ArgsFields<In>]
  & string

/**
 * The optional group argument of `Command.interrupt` and `h.isRunning`: the
 * `group` fields of the Command's args, or none for a Command without a
 * `group`.
 *
 * @stability experimental
 * @category utility types
 * @since 0.1.0
 */
export type GroupArg<Args, G extends string> = [G] extends [never] ? []
  : [group?: Pick<Args, G & keyof Args>]

/**
 * The arguments of `make`: optional when every field of the args is.
 *
 * @stability experimental
 * @category utility types
 * @since 0.1.0
 */
export type MakeArgs<Args> = {} extends Args ? [args?: Args] : [args: Args]

/**
 * The options shared by `make` and `Service`.
 *
 * **Details**
 *
 * - `args` is required: a fields record or a `Schema.Struct`. The body gets
 *   one decoded struct. A Command with no args writes `args: {}`. The log
 *   encodes a run's args through it, redacting `Schema.Redacted` fields.
 * - `stream: true` declares a Stream Command, so a story test knows the kind
 *   without building a Layer.
 * - `mode` defaults to `"concurrent"`.
 * - `group` lists args fields whose values split runs into groups, so runs of
 *   different groups don't interfere. The group key is the canonical JSON of
 *   those fields, encoded. Without it, all runs of a Command in one instance
 *   are one group.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Options<In extends ArgsInput, G extends string> {
  readonly args: In
  readonly stream?: boolean | undefined
  readonly mode?: Mode | undefined
  readonly group?: ReadonlyArray<G> | undefined
}

/**
 * The services every mounted app is guaranteed to have, which a Command may use
 * without them appearing in its component's requirements.
 *
 * **Details**
 *
 * Host packages widen this interface by module augmentation. The runtime
 * provides these services when a Command runs, so they're removed from `R`.
 * The core lists `Scope`, `Renderer.Refs` and the query cache, and host
 * packages add their host marker.
 *
 * **Example** (Registering a host's framework service)
 *
 * ```ts
 * declare module "@effect/ui/Command" {
 *   interface FrameworkServices {
 *     readonly MyHost: MyHost
 *   }
 * }
 *
 * declare class MyHost {
 *   readonly _: unique symbol
 * }
 * ```
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface FrameworkServices {
  readonly Scope: Scope.Scope
  readonly Refs: Renderer.Refs
  readonly Cache: Query.Cache
}

/**
 * The union of the registered framework services.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type FrameworkService = FrameworkServices[keyof FrameworkServices]

/**
 * What a Command declares about the query cache, computed from its args when
 * it's issued. A story test reads these off the issued Command without a
 * cache. `make` Commands declare nothing.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Declared {
  /** What the run invalidates when its fiber exits, however it exits. */
  readonly invalidates: ReadonlyArray<Query.Target>
  /** The optimistic patches, registered when the Command is issued. */
  readonly optimistic: ReadonlyArray<Query.Patch>
  /**
   * The writes a success stores, or `undefined` without `writes`. Takes the
   * body's own success.
   */
  readonly writes: ((success: any) => ReadonlyArray<Query.Write>) | undefined
  /**
   * The budget given to `Command.afterRefetch`, or `undefined` when a success
   * is delivered without waiting for refetches.
   */
  readonly afterRefetch: Duration.Duration | undefined
}

/**
 * The data every issued Command carries, matched or not.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Data extends Declared {
  /** The Command's name: the factory's name or the service's key. */
  readonly name: string
  /** The decoded args struct the Command was issued with. Data a test asserts on without running the Effect. */
  readonly args: unknown
  readonly mode: Mode
  /** The group key: canonical JSON of the encoded `group` fields, or `undefined` without `group`. */
  readonly groupKey: string | undefined
  /**
   * The args Schema, for the log.
   *
   * @internal
   */
  readonly argsSchema: Schema.Top
  /**
   * The `Service` class the Command was issued by, `undefined` for a `make`
   * Command.
   *
   * @internal
   */
  readonly service: Context.Key<any, any> | undefined
}

/**
 * The shared fields of an issued Command.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Proto<out Msg, in Source = Msg, in SourceE = never>
  extends Pipeable.Pipeable, Data
{
  readonly [TypeId]: Variance<Msg, Source, SourceE>
  /**
   * Maps the success of the underlying definition to the message this Command
   * produces, composing every `map` and `match` applied since it was issued.
   * `Story` uses it to resolve a Command with the definition's own success.
   *
   * @internal
   */
  readonly resolve: (result: Source) => Msg
  /**
   * Maps a typed failure of the underlying definition to the message this
   * Command produces. `undefined` when the definition can't fail.
   *
   * @internal
   */
  readonly reject: ((error: SourceE) => Msg) | undefined
}

/**
 * Phantom variance for a Command's message type and the success and failure
 * of its definition.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Variance<out Msg, in Source, in SourceE = never> {
  readonly _Msg: Types.Covariant<Msg>
  readonly _Source: Types.Contravariant<Source>
  readonly _SourceE: Types.Contravariant<SourceE>
}

/**
 * The kind of an issued Command: `"Effect"` for one message, `"Stream"` for a
 * Stream of them.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type Kind = "Effect" | "Stream"

/**
 * An issued Command: what a definition's `make` returns, or what `match` makes
 * of an `Unmatched` one.
 *
 * **Details**
 *
 * `Msg` is the message it produces and `R` what it requires. `Source` is
 * the success of the Command's definition before any `map`, and `SourceE`
 * its typed failure before `match`; they're what a story's `resolve` and
 * `fail` steps take. `K` is the kind, which decides whether `effect` or
 * `stream` holds the work; the other field is `undefined`: `"Effect"` for a
 * Command whose result is one message, `"Stream"` for one declared with
 * `stream: true`. Narrow a `Command` on `_tag` before reading the work.
 *
 * One interface for both kinds, rather than two, is what lets
 * `command.pipe(Command.map((result) => ...))` infer `result`.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Issued<
  out Msg,
  out R,
  in Source,
  out K extends Kind,
  in SourceE = never
> extends Proto<Msg, Source, SourceE> {
  readonly _tag: K
  /** The work of an `"Effect"` Command, with `map` and `match` applied. `undefined` on a `"Stream"` one. */
  readonly effect: K extends "Effect" ? Effect.Effect<Msg, never, R> : undefined
  /** The work of a `"Stream"` Command, with `map` and `match` applied. `undefined` on an `"Effect"` one. */
  readonly stream: K extends "Stream" ? Stream.Stream<Msg, never, R> : undefined
  /**
   * The definition's own work, before `map` and `match`. The runtime runs
   * this one, so the exit of a run tells a success from a typed failure.
   *
   * @internal
   */
  readonly work: K extends "Effect" ? Effect.Effect<unknown, unknown, R>
    : Stream.Stream<unknown, unknown, R>
}

/**
 * What a `Service` whose body can fail issues: a Command whose success `A`
 * and typed failure `E` haven't been mapped to messages yet.
 *
 * **Details**
 *
 * It isn't a `Command`, so `$.run` and `Command.map` reject it until
 * `match` maps both channels. It already carries the Command's data: its
 * name, args and what it declares about the cache.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Unmatched<out A, out E, out R, out K extends Kind>
  extends Pipeable.Pipeable, Data
{
  readonly [UnmatchedTypeId]: {
    readonly _A: Types.Covariant<A>
    readonly _E: Types.Covariant<E>
    readonly _R: Types.Covariant<R>
  }
  readonly _tag: K
  /** The body's work of an `"Effect"` Command, with its typed failure. `undefined` on a `"Stream"` one. */
  readonly effect: K extends "Effect" ? Effect.Effect<A, E, R> : undefined
  /** The body's work of a `"Stream"` Command, with its typed failure. `undefined` on an `"Effect"` one. */
  readonly stream: K extends "Stream" ? Stream.Stream<A, E, R> : undefined
}

/**
 * A Command that interrupts the running and queued runs of another Command.
 *
 * **Details**
 *
 * It produces no message. With a group key, only the runs of that group are
 * interrupted.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Interrupt extends Pipeable.Pipeable {
  readonly [TypeId]: Variance<never, unknown>
  readonly _tag: "Interrupt"
  /** The name of the Command to interrupt. */
  readonly name: string
  /** The group key to interrupt, or `undefined` for every run of the Command. */
  readonly groupKey: string | undefined
}

/**
 * What `update` returns inside a step and a story test sees as pending.
 *
 * **Details**
 *
 * `Msg` is the message the Command produces, which `$.run` checks against the
 * component's message type. `R` is what the Command requires: the `Service`
 * for a service Command, `never` for one made with `make`. A Command whose
 * result is `never` (`Effect.never`, `Effect.die`, `Stream.never`) produces
 * no message, so any component can run it.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type Command<Msg, R = never> =
  | Issued<Msg, R, never, "Effect">
  | Issued<Msg, R, never, "Stream">
  | Interrupt

/**
 * The requirements of a Command, or of a union of them.
 *
 * @stability experimental
 * @category utility types
 * @since 0.1.0
 */
export type Requirements<C> = C extends
  Issued<infer _Msg, infer R, infer _S, infer _K, infer _SE> ? R : never

/**
 * The message type of a Command, or of a union of them.
 *
 * @stability experimental
 * @category utility types
 * @since 0.1.0
 */
export type Message<C> = C extends
  Proto<infer Msg, infer _Source, infer _SourceE> ? Msg
  : C extends Definition<infer _Args, infer Msg, infer _S, infer _E, infer _G> ?
    Msg
  : never

/**
 * What resolves a Command in a story: the definition's own success, for a
 * definition or an issued Command, before any `map` or `match`.
 *
 * @stability experimental
 * @category utility types
 * @since 0.1.0
 */
export type Result<C> = C extends
  Proto<infer _Msg, infer Source, infer _SourceE> ? Source
  : C extends Unmatched<infer A, infer _E, infer _R, infer _K> ? A
  : C extends Definition<infer _Args, infer A, infer _S, infer _E, infer _G> ? A
  : never

/**
 * What fails a Command in a story: the definition's own typed failure, for a
 * definition or an issued Command, before `match`.
 *
 * @stability experimental
 * @category utility types
 * @since 0.1.0
 */
export type Failure<C> = C extends
  Proto<infer _Msg, infer _Source, infer SourceE> ? SourceE
  : C extends Unmatched<infer _A, infer E, infer _R, infer _K> ? E
  : C extends Definition<infer _Args, infer _A, infer _S, infer E, infer _G> ? E
  : never

/**
 * `C` with its message mapped to `B`. An `Interrupt` stays an `Interrupt`, and
 * a Command whose kind is `"Effect" | "Stream"` becomes a union of the two kinds,
 * so it still fits `Command<B>`.
 *
 * @stability experimental
 * @category utility types
 * @since 0.1.0
 */
export type Mapped<C, B> = C extends
  Issued<infer _Msg, infer R, infer Source, infer K, infer SourceE> ?
  (K extends Kind ? Issued<B, R, Source, K, SourceE> : never)
  : C extends Interrupt ? Interrupt
  : never

/**
 * What `make` and `Service` have in common: the data about a Command that's
 * known before it's issued.
 *
 * **Details**
 *
 * `Args` is the decoded args struct a Command is issued with, `A` the
 * body's success, `IsStream` whether it was declared with `stream: true`,
 * `E` the body's typed failure and `G` its `group` fields. Story steps
 * such as `resolve` take a definition and are typed by it.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Definition<
  in Args,
  out A,
  out IsStream extends boolean,
  out E = never,
  out G extends string = never
> {
  readonly [DefinitionTypeId]: Definition.Variance<Args, A, IsStream, E, G>
  /** Whether the Command was declared with `stream: true`. */
  readonly stream: IsStream
  readonly mode: Mode
  /** The `group` fields. Empty without `group`. */
  readonly group: ReadonlyArray<G>
  /**
   * The group key of an args struct, or of a pick of its `group` fields.
   *
   * @internal
   */
  readonly "~group": (args: unknown) => GroupSource | undefined
}

/**
 * Helper types for `Definition`.
 *
 * @stability experimental
 * @since 0.1.0
 */
export declare namespace Definition {
  /**
   * Phantom variance for a definition's args, success, kind, failure and group.
   *
   * @category models
   * @since 0.1.0
   */
  export interface Variance<
    in Args,
    out A,
    out IsStream extends boolean,
    out E,
    out G extends string
  > {
    readonly _Args: Types.Contravariant<Args>
    readonly _A: Types.Covariant<A>
    readonly _IsStream: Types.Covariant<IsStream>
    readonly _E: Types.Covariant<E>
    readonly _G: Types.Covariant<G>
  }

  /**
   * Any Command definition.
   *
   * @category models
   * @since 0.1.0
   */
  export type Any = Definition<any, any, boolean, any, any>

  /**
   * The args struct a definition is issued with.
   *
   * @category utility types
   * @since 0.1.0
   */
  export type Args<D> = D extends
    Definition<infer A, infer _A, infer _S, infer _E, infer _G> ? A : never

  /**
   * Whether a definition was declared with `stream: true`.
   *
   * @category utility types
   * @since 0.1.0
   */
  export type IsStream<D> = D extends
    Definition<infer _Args, infer _A, infer S, infer _E, infer _G> ? S : never
}

/**
 * What `Command.make` returns: a definition whose `make` issues the Command
 * from its args struct.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Factory<
  in out Args,
  in out Msg,
  out IsStream extends boolean = false,
  out G extends string = never
> extends Definition<Args, Msg, IsStream, never, G> {
  /** Issues the Command. */
  make(
    ...args: MakeArgs<Args>
  ): IsStream extends true ? Issued<Msg, never, Msg, "Stream">
    : Issued<Msg, never, Msg, "Effect">
  readonly name: string
  /** The args Schema. */
  readonly args: Schema.Top
}

/**
 * A Command service class, as returned by `Service`.
 *
 * **Details**
 *
 * A `Context.Service` holding the Command's implementation. Attach one with
 * `toLayer` (or fake with `X.toLayer(fn)`), and issue Commands with `make`.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Service<
  in out Self,
  in out Key extends string,
  in out Args,
  in out Success extends Schema.Top,
  out IsStream extends boolean,
  in out Error extends Schema.Top = Schema.Never,
  out G extends string = never
> extends
  Context.ServiceClass<
    Self,
    Key,
    Service.Implementation<Args, Success["Type"], IsStream, Error["Type"]>
  >,
  Definition<Args, Success["Type"], IsStream, Error["Type"], G>
{
  /** Builds a Layer providing this Command's implementation. */
  toLayer<LE = never, LR = never>(
    build:
      | Service.Implementation<Args, Success["Type"], IsStream, Error["Type"]>
      | Effect.Effect<
        Service.Implementation<Args, Success["Type"], IsStream, Error["Type"]>,
        LE,
        LR
      >
  ): Layer.Layer<Self, LE, Exclude<LR, Scope.Scope>>
  readonly args: Schema.Top
  readonly success: Success
  readonly error: Error
  /**
   * Issues the Command. The component requires `Self`. When the body can
   * fail (`Error["Type"]` isn't `never`) the result is `Unmatched`, which
   * `$.run` rejects: handle the failure in the body, or map both channels with
   * `Command.match`.
   */
  make(
    ...args: MakeArgs<Args>
  ): [Error["Type"]] extends [never] ?
    (IsStream extends true ?
      Issued<Success["Type"], Self, Success["Type"], "Stream">
      : Issued<Success["Type"], Self, Success["Type"], "Effect">)
    : Unmatched<
      Success["Type"],
      Error["Type"],
      Self,
      IsStream extends true ? "Stream" : "Effect"
    >
}

/**
 * Helper types for `Service`.
 *
 * @stability experimental
 * @since 0.1.0
 */
export declare namespace Service {
  /**
   * The value behind a Command service: a function of the args struct that
   * returns the body's result, or `Component.noop` for none. It may use
   * framework services on each call.
   *
   * @category models
   * @since 0.1.0
   */
  export type Implementation<Args, A, IsStream extends boolean, Err = never> =
    IsStream extends true ?
      (args: Args) => Stream.Stream<A | Component.Noop, Err, FrameworkService>
      : (args: Args) => Effect.Effect<A | Component.Noop, Err, FrameworkService>

  /**
   * The options accepted by `Service`.
   *
   * **Details**
   *
   * On top of `Options`:
   *
   * - `success`: Schema for the body's result, usually the consuming
   *   component's Message Schema. The body may also return `Component.noop`,
   *   which `success` needn't include.
   * - `error`: Schema for the body's typed failure, `Schema.Never` if none.
   * - `invalidates` is optional: what a run invalidates, from the args
   *   only, so it's known at issue. It's applied on every exit of a started
   *   run. Omitting it invalidates nothing.
   * - `optimistic` lists patches, from the args only, registered at issue.
   * - `writes` lists the entries a success writes, none for
   *   `Component.noop`. A Stream Command has none.
   *
   * @category models
   * @since 0.1.0
   */
  export interface Options<
    In extends ArgsInput,
    Success extends Schema.Top,
    Error extends Schema.Top,
    G extends string
  > extends CommandOptions<In, G> {
    readonly success: Success
    readonly error: Error
    readonly invalidates?:
      | ((args: ArgsOf<In>) => ReadonlyArray<Query.Target>)
      | undefined
    readonly optimistic?:
      | ((args: ArgsOf<In>) => ReadonlyArray<Query.Patch>)
      | undefined
    readonly writes?:
      | ((
        success: NoInfer<Success["Type"]>,
        args: ArgsOf<In>
      ) => ReadonlyArray<Query.Write>)
      | undefined
  }
}

type CommandOptions<In extends ArgsInput, G extends string> = Options<In, G>

const identity = (result: any) => result

/** `f`, skipped for `Component.noop`, which a mapper's type needn't include. */
const skipNoop = (f: (a: any) => any) => (a: any) =>
  internalNoop.isNoop(a) ? a : f(a)

const variance = {
  _Msg: (_: never) => _,
  _Source: (_: never) => _,
  _SourceE: (_: never) => _
}

function pipe(this: unknown) {
  return Pipeable.pipeArguments(this, arguments)
}

function run(
  this: Command<any, any>,
  inst: Kernel.Instance,
  seq: number | undefined | void,
  index: number
) {
  commandRun.issue(inst, this, {
    seq: typeof seq === "number" ? seq : -1,
    index
  }, cleanupFailed)
}

// Written out rather than spread from `Proto`: a bundler keeps a spread, and with it the runner.
const Proto = { [TypeId]: variance, pipe, "~run": run }

const UnmatchedProto = {
  [TypeId]: variance,
  pipe,
  "~run": run,
  [UnmatchedTypeId]: {
    _A: (_: never) => _,
    _E: (_: never) => _,
    _R: (_: never) => _
  }
}

interface Fields extends Data {
  readonly _tag: Kind
  readonly "~group": GroupSource | undefined
  readonly work: Effect.Effect<any, any, any> | Stream.Stream<any, any, any>
  readonly resolve: (result: any) => any
  readonly reject: ((error: any) => any) | undefined
}

/** `effect` and `stream` are the work with `resolve` and `reject` applied. An unmatched Command keeps its failure. */
const makeIssued = (fields: Fields, unmatched = false): any => {
  const { reject, resolve, work } = fields
  let effect: Effect.Effect<any, any, any> | undefined
  let stream: Stream.Stream<any, any, any> | undefined
  if (fields._tag === "Effect") {
    const mapped = resolve === identity
      ? work as Effect.Effect<any, any, any>
      : Effect.map(work as Effect.Effect<any, any, any>, resolve)
    effect = reject === undefined
      ? mapped
      : Effect.catch(mapped, (error) => Effect.sync(() => reject(error)))
  } else {
    const mapped = resolve === identity
      ? work as Stream.Stream<any, any, any>
      : Stream.map(work as Stream.Stream<any, any, any>, resolve)
    stream = reject === undefined
      ? mapped
      : Stream.catch(mapped, (error) => Stream.sync(() => reject(error)))
  }
  return Object.assign(
    Object.create(unmatched ? UnmatchedProto : Proto),
    fields,
    { effect, stream }
  )
}

const noTargets: ReadonlyArray<never> = []

const argsSchemaOf = (args: ArgsInput): Schema.Struct<Schema.Struct.Fields> =>
  Schema.isSchema(args)
    ? args as Schema.Struct<Schema.Struct.Fields>
    : Schema.Struct(args as Schema.Struct.Fields)

/**
 * A Command's group: its key, and the `group` fields it was made from, so the
 * message log can encode them with redaction instead of logging the key.
 *
 * @internal
 */
export interface GroupSource {
  /** Canonical JSON of the encoded `group` fields. */
  readonly key: string
  /** A struct of the `group` fields. */
  readonly schema: Schema.Top
  /** The `group` fields picked from the args. */
  readonly picked: Record<string, unknown>
}

/** The group of an args struct, or of a pick of its `group` fields. The codec is built on first use. */
const makeGroup = (
  name: string,
  schema: Schema.Struct<Schema.Struct.Fields>,
  group: ReadonlyArray<string>
): (args: unknown) => GroupSource | undefined => {
  if (group.length === 0) return () => undefined
  const fields: Record<string, Schema.Top> = {}
  for (const field of group) {
    if (!Object.hasOwn(schema.fields, field)) {
      throw new Error(
        `${name}: the group field "${field}" isn't one of its args`
      )
    }
    fields[field] = schema.fields[field] as Schema.Top
  }
  const pickSchema = Schema.Struct(fields)
  let encode: ((u: unknown) => unknown) | undefined
  return (args) => {
    if (encode === undefined) {
      encode = Schema.encodeUnknownSync(
        Schema.toCodecJson(pickSchema) as unknown as Schema.Codec<
          unknown,
          unknown
        >
      )
    }
    const picked: Record<string, unknown> = {}
    const source = (args ?? {}) as Record<string, unknown>
    for (const field of group) {
      if (Object.hasOwn(source, field)) picked[field] = source[field]
    }
    return { key: canonical(encode(picked)), schema: pickSchema, picked }
  }
}

const define = (
  name: string,
  options: Options<ArgsInput, string>,
  unmatched: boolean,
  issue: (
    args: any
  ) => Pick<
    Fields,
    "service" | "invalidates" | "optimistic" | "writes" | "work"
  >
) => {
  const stream = options.stream === true
  const mode = options.mode ?? "concurrent"
  const group = options.group ?? []
  const argsSchema = argsSchemaOf(options.args)
  const groupOf = makeGroup(name, argsSchema, group)
  return {
    [DefinitionTypeId]: DefinitionTypeId,
    stream,
    mode,
    group,
    args: argsSchema,
    "~group": groupOf,
    make(args: unknown = {}) {
      const source = groupOf(args)
      return makeIssued({
        _tag: stream ? "Stream" : "Effect",
        name,
        args,
        mode,
        groupKey: source?.key,
        "~group": source,
        argsSchema,
        afterRefetch: undefined,
        resolve: identity,
        reject: undefined,
        ...issue(args)
      }, unmatched)
    }
  }
}

/**
 * Returns `true` if `u` is a Command.
 *
 * @stability experimental
 * @category guards
 * @since 0.1.0
 */
export const isCommand = (u: unknown): u is Command<unknown, unknown> =>
  Predicate.hasProperty(u, TypeId)

/**
 * Returns `true` if `u` is a Command issued by a `Service` whose body can
 * fail, before `match`.
 *
 * @stability experimental
 * @category guards
 * @since 0.1.0
 */
export const isUnmatched = (
  u: unknown
): u is Unmatched<unknown, unknown, unknown, Kind> =>
  Predicate.hasProperty(u, UnmatchedTypeId)

/**
 * Returns `true` if `u` is a Command definition: a factory from `make` or a
 * `Service` class.
 *
 * @stability experimental
 * @category guards
 * @since 0.1.0
 */
export const isDefinition = (u: unknown): u is Definition.Any =>
  Predicate.hasProperty(u, DefinitionTypeId)

/**
 * The name of a Command definition: the factory's name, or the service's key.
 *
 * @stability experimental
 * @category accessors
 * @since 0.1.0
 */
export const nameOf = (definition: Definition.Any): string =>
  Context.isKey(definition)
    ? definition.key
    : (definition as Factory<any, any, any>).name

/**
 * The group key a definition's `group` pick addresses, or `undefined` for
 * every run of it.
 *
 * @internal
 */
export const groupKeyOf = (
  definition: Definition.Any,
  group: unknown
): string | undefined =>
  group === undefined ? undefined : definition["~group"](group)?.key

/**
 * Defines a Command that needs nothing beyond the framework services.
 *
 * **When to use**
 *
 * Use to wrap an Effect that only needs the runtime's own services (`Scope`, a
 * host's refs) or none at all, such as a random roll or focusing an element.
 * Anything that reaches another service is a `Service`.
 *
 * **Details**
 *
 * Requires an `args` Schema and returns a definition whose `make` method takes
 * the args struct and issues a Command. Story tests can inspect its `args`
 * without running the Effect. The body can't fail. Its requirements may only
 * be framework services, which are removed from `R`. A body that requires
 * anything else doesn't compile, and the error names `FrameworkService` rather
 * than the missing service. With `stream: true` the body returns a `Stream`
 * instead. A `make` Command declares nothing about the query cache.
 *
 * **Gotchas**
 *
 * `Effect.tryPromise(() => fetch(...))` compiles with `R = never`, but a
 * Command written that way can't be faked. Put I/O behind a `Service`.
 *
 * **Example** (A Command that only needs the runtime)
 *
 * ```ts import.meta.vitest
 * import { Command, UiSchema } from "@effect/ui"
 * import { Effect, Random, Schema } from "effect"
 *
 * const DieMessage = UiSchema.TaggedEnum({ ClickedRoll: {}, CompletedRollDie: { n: Schema.Number } })
 *
 * const RollDie = Command.make("RollDie", { args: { sides: Schema.Number } }, ({ sides }) =>
 *   Random.nextIntBetween(1, sides).pipe(Effect.map((n) => DieMessage.CompletedRollDie({ n }))))
 *
 * // In a component: `$.run(RollDie.make({ sides: 6 }))`, pending in a story as { name: "RollDie", args: { sides: 6 } }
 * ```
 *
 * @stability experimental
 * @category constructors
 * @since 0.1.0
 */
export const make: {
  <
    const Name extends string,
    const In extends ArgsInput,
    Msg,
    R extends FrameworkService = never,
    const G extends GroupField<In> = never
  >(
    name: Name,
    options: Options<In, G> & { readonly stream?: false | undefined },
    run: (args: ArgsOf<In>) => Effect.Effect<Msg, never, R>
  ): Factory<ArgsOf<In>, Msg, false, G>
  <
    const Name extends string,
    const In extends ArgsInput,
    Msg,
    R extends FrameworkService = never,
    const G extends GroupField<In> = never
  >(
    name: Name,
    options: Options<In, G> & { readonly stream: true },
    run: (args: ArgsOf<In>) => Stream.Stream<Msg, never, R>
  ): Factory<ArgsOf<In>, Msg, true, G>
} = (
  name: string,
  options: Options<ArgsInput, string>,
  run: (args: any) => any
): any => ({
  name,
  ...define(name, options, false, (args) => ({
    service: undefined,
    invalidates: noTargets,
    optimistic: noTargets,
    writes: undefined,
    work: run(args)
  }))
})

/**
 * Defines a Command whose implementation is a service.
 *
 * **When to use**
 *
 * Use when a Command needs a non-framework service, such as a store or HTTP
 * client, including mutations of data a query reads.
 *
 * **Details**
 *
 * Takes a key (the Command's name in logs and stories) and options (`args`,
 * `success`, and `error`, which is `Schema.Never` when the body can't fail).
 * Attach the body with `toLayer`, passing a function or an Effect that runs once per Layer
 * build to capture its dependencies; components then require only this class,
 * and tests can fake it with `X.toLayer(fn)`.
 *
 * The body may use framework services on each call without them appearing in
 * the Layer's requirements. When one component consumes the result, set
 * `success` to that component's Message Schema: the body returns its message
 * and handles a typed failure with `Effect.match`. A library or shared
 * Command returns its own result instead, and the issue site maps it:
 * `Command.match` when `error` isn't `Schema.Never`, since `make` then
 * issues an `Unmatched` Command, and `Command.map` or `Command.asNoop` when
 * it can't fail.
 *
 * Whatever `success` is, the body may return `Component.noop` when it has
 * nothing to report. The run then sends nothing: `writes`, `Command.map`
 * and `Command.match` never see it.
 *
 * The options declare what a run does to the query cache, from the args:
 * `invalidates` (optional), `optimistic` patches, live from issue, and
 * `writes` of the success. The runtime applies them when the run's fiber
 * exits, before its message is sent.
 *
 * Every run is owned by the instance that issued it and ends with it,
 * whatever its kind or mode. A save that must outlive a page is issued by a
 * component that outlives it, such as the layout, so its result and its
 * failure reach an `update`.
 *
 * **Example** (Defining, issuing and faking a Command service)
 *
 * ```ts import.meta.vitest
 * import { Command, UiSchema } from "@effect/ui"
 * import { Effect, Schema } from "effect"
 * import { KeyValueStore } from "effect/persistence"
 *
 * const Message = UiSchema.TaggedEnum({
 *   ClickedSave: {},
 *   SucceededSaveTodo: {},
 *   FailedSaveTodo: { reason: Schema.String }
 * })
 *
 * class SaveTodo extends Command.Service<SaveTodo>()("todos/SaveTodo", {
 *   args: { id: Schema.String, title: Schema.String },
 *   success: Message,
 *   error: Schema.Never,
 *   mode: "queue",
 *   group: ["id"]
 * }) {
 *   static readonly layer = this.toLayer(Effect.gen(function*() {
 *     const kv = yield* KeyValueStore.KeyValueStore
 *     return ({ id, title }) =>
 *       kv.set(`todo/${id}`, title).pipe(
 *         Effect.match({
 *           onSuccess: () => Message.SucceededSaveTodo(),
 *           onFailure: (e) => Message.FailedSaveTodo({ reason: e.message })
 *         })
 *       )
 *   }))
 * }
 *
 * // Issue: `$.run` takes the Command as is
 * const command = SaveTodo.make({ id: "1", title: "Buy milk" })
 * // Live: provide `SaveTodo.layer`, which requires `KeyValueStore`
 * // Test: a fake that needs nothing
 * const Fake = SaveTodo.toLayer(() => Effect.succeed(Message.SucceededSaveTodo()))
 * ```
 *
 * @stability experimental
 * @category constructors
 * @since 0.1.0
 */
export const Service: <Self>() => {
  <
    const Key extends string,
    const In extends ArgsInput,
    Success extends Schema.Top,
    Error extends Schema.Top,
    const G extends GroupField<In> = never
  >(
    key: Key,
    options: Service.Options<In, Success, Error, G> & {
      readonly stream?: false | undefined
    }
  ): Service<
    Self,
    Key,
    ArgsOf<In>,
    Success,
    false,
    Error,
    G
  >
  <
    const Key extends string,
    const In extends ArgsInput,
    Success extends Schema.Top,
    Error extends Schema.Top,
    const G extends GroupField<In> = never
  >(
    key: Key,
    options: Service.Options<In, Success, Error, G> & {
      readonly stream: true
      readonly writes?: undefined
    }
  ): Service<
    Self,
    Key,
    ArgsOf<In>,
    Success,
    true,
    Error,
    G
  >
} = () =>
(
  key: string,
  options: Service.Options<ArgsInput, Schema.Top, Schema.Top, string>
): any => {
  const Base = Context.Service<any, any>()(key)
  const { error, invalidates, optimistic, stream, success, writes } = options
  const service = Base as Effect.Effect<(args: unknown) => any, never, any>
  class CommandService extends Base {
    static readonly success = success
    static readonly error = error
    static toLayer(
      build: ((args: any) => any) | Effect.Effect<(args: any) => any, any, any>
    ): Layer.Layer<any, any, any> {
      return Effect.isEffect(build)
        ? Layer.effect(Base, build)
        : Layer.succeed(Base, build)
    }
  }
  return Object.assign(
    CommandService,
    define(key, options, true, (args) => ({
      service: Base,
      invalidates: invalidates?.(args) ?? noTargets,
      optimistic: optimistic?.(args) ?? noTargets,
      writes: writes === undefined
        ? undefined
        : (value) =>
          internalNoop.isNoop(value) ? noTargets : writes(value, args),
      work: stream
        ? Stream.unwrap(Effect.map(service, (run) => run(args)))
        : Effect.flatMap(service, (run) => run(args))
    }))
  )
}

/**
 * Maps the message a Command produces.
 *
 * **When to use**
 *
 * Use when issuing a Command that can't know its caller's messages, such as
 * `Router.replace` or a shared `UploadFile` Command that returns a URL. A
 * Command whose body can fail takes `match` instead.
 *
 * **Details**
 *
 * The name, args and options are kept, so the log and story tests still see
 * the original Command, and a story's `resolve` step still takes the
 * definition's own success (the `Source` type parameter). The data-first form
 * returns an `Interrupt` unchanged; the pipeable form only takes issued
 * Commands.
 *
 * **Gotchas**
 *
 * A result of `Component.noop` isn't mapped: `f` never receives it and the
 * run stays silent, so `as` can't give a silent Command a message.
 *
 * The pipeable form infers one `Source` and one `R` for its input, so it maps
 * one Command, or a union whose branches share them, and keeps them exact.
 * For a union of Commands with different sources or requirements, use the
 * data-first form, `Command.map(input, f)`, which keeps each branch's own.
 *
 * **Example** (Mapping a shared Command into a component's message)
 *
 * ```ts import.meta.vitest
 * import { Command, UiSchema } from "@effect/ui"
 * import { Effect, Schema } from "effect"
 *
 * const Message = UiSchema.TaggedEnum({ CompletedUploadFile: { url: Schema.String } })
 *
 * const UploadFile = Command.make("UploadFile", { args: { name: Schema.String } }, ({ name }) =>
 *   Effect.succeed(`https://cdn/${name}`))
 *
 * const upload = UploadFile.make({ name: "photo.png" }).pipe(
 *   Command.map((url) => Message.CompletedUploadFile({ url }))
 * )
 * ```
 *
 * @stability experimental
 * @category mapping
 * @since 0.1.0
 */
export const map: {
  <A, B>(
    f: (a: A) => B
  ): <R, Source, K extends Kind, SourceE>(
    self: Issued<A, R, Source, K, SourceE>
  ) => Mapped<Issued<A, R, Source, K, SourceE>, B>
  <C extends Command<any, any>, B>(
    self: C,
    f: (a: Message<C>) => B
  ): Mapped<C, B>
} = dual(2, <A, R, B>(self: Command<A, R>, f: (a: A) => B): Command<B, R> => {
  if (self._tag === "Interrupt") return self
  const { reject, resolve } = self as unknown as Fields
  const g = skipNoop(f)
  return makeIssued({
    ...(self as unknown as Fields),
    resolve: (result) => g(resolve(result)),
    reject: reject === undefined ? undefined : (error) => g(reject(error))
  })
})

/**
 * Replaces each message a Command produces with the supplied value.
 *
 * **When to use**
 *
 * Use when the component needs a fixed message rather than the Command's
 * result: `command.pipe(Command.as(message))` is shorthand for
 * `command.pipe(Command.map(() => message))`.
 *
 * **Details**
 *
 * Keeps the original name, args, options, source type and requirements, just
 * like `map`. Stream Commands emit the same supplied value for each element.
 * Apply `match` first to a Command whose body can fail. After `match`, both
 * mapped channels are replaced. The data-first form leaves an `Interrupt`
 * unchanged; the pipeable form only accepts issued Commands.
 *
 * **Gotchas**
 *
 * For a union with different source types or requirements, use the data-first
 * form, `Command.as(input, message)`, to preserve each branch's types.
 *
 * @see map
 * @stability experimental
 * @category mapping
 * @since 0.1.0
 */
export const as: {
  <B>(message: B): <A, R, Source, K extends Kind, SourceE>(
    self: Issued<A, R, Source, K, SourceE>
  ) => Mapped<Issued<A, R, Source, K, SourceE>, B>
  <C extends Command<any, any>, B>(self: C, message: B): Mapped<C, B>
} = dual(
  2,
  <A, R, B>(self: Command<A, R>, message: B): Command<B, R> =>
    map(self, () => message)
)

/**
 * Makes a Command send nothing when it finishes.
 *
 * **When to use**
 *
 * Use when a Command's result doesn't matter to the component, such as a
 * navigation or a focus, instead of adding a no-op variant to its Message. It's shorthand for `Command.as(Component.noop)`.
 *
 * **Details**
 *
 * Every result is replaced with `Component.noop`, so the run ends with no
 * message and `CommandEnded` records it as `silent`. A Stream Command's
 * elements are all silenced. It keeps the name, args, options, source type
 * and requirements, like `as`, and leaves an `Interrupt` unchanged.
 *
 * **Gotchas**
 *
 * It takes issued Commands only, never an `Unmatched` one, so a typed failure
 * can't be dropped by accident. After `match` it silences both channels: to
 * keep the failure message, write
 * `match({ onSuccess: () => Component.noop, onFailure })`. On a navigation
 * Command it also hides a `"blocked"` outcome.
 *
 * **Example** (Tracking an event without a message)
 *
 * ```ts import.meta.vitest
 * import { Command } from "@effect/ui"
 * import { Effect, Schema } from "effect"
 *
 * const Track = Command.make("Track", { args: { event: Schema.String } }, () => Effect.succeed(200))
 *
 * const track = Track.make({ event: "opened" }).pipe(Command.asNoop)
 * ```
 *
 * @see as
 * @stability experimental
 * @category mapping
 * @since 0.1.0
 */
export const asNoop = <C extends Command<any, any>>(
  self: C
): Mapped<C, Component.Noop> => as(self, internalNoop.noop) as any

/**
 * Maps both channels of a Command whose body can fail to messages.
 *
 * **When to use**
 *
 * Use when issuing a library or shared `Command.Service` whose body has a
 * typed error: `$.run` rejects the `Unmatched` Command its `make` returns.
 * A Command that one component consumes handles the error in its body
 * instead.
 *
 * **Details**
 *
 * `onSuccess` maps the body's success, or each element of a Stream Command,
 * and `onFailure` the typed failure, which ends a Stream Command. A defect or
 * an interrupt isn't mapped, and nor is a success of `Component.noop`. A
 * Command whose body can't fail takes `map`, and `match` on it doesn't
 * compile.
 *
 * In a `Story` or `Scene` the mapping runs in the test: `resolve` takes the
 * body's success and `fail` its typed error. A Stream Command takes `next`
 * for each element and `end` when it completes.
 *
 * **Example** (Mapping a shared Command that can fail)
 *
 * ```ts import.meta.vitest
 * import { Command, UiSchema } from "@effect/ui"
 * import { Effect, Schema } from "effect"
 *
 * class SaveFailed extends Schema.TaggedError<SaveFailed>()("SaveFailed", { reason: Schema.String }) {}
 *
 * const Message = UiSchema.TaggedEnum({ SucceededSaveTodo: {}, FailedSaveTodo: { reason: Schema.String } })
 *
 * class SaveTodo extends Command.Service<SaveTodo>()("todos/SaveTodo", {
 *   args: { title: Schema.String },
 *   success: Schema.Void,
 *   error: SaveFailed
 * }) {
 *   static readonly layer = this.toLayer(({ title }) =>
 *     title === "" ? Effect.fail(new SaveFailed({ reason: "empty" })) : Effect.void
 *   )
 * }
 *
 * const saveTodo = (title: string) =>
 *   SaveTodo.make({ title }).pipe(Command.match({
 *     onSuccess: () => Message.SucceededSaveTodo(),
 *     onFailure: (error) => Message.FailedSaveTodo({ reason: error.reason })
 *   }))
 * ```
 *
 * @stability experimental
 * @category mapping
 * @since 0.1.0
 */
export const match: {
  <A, E, B, C>(options: {
    readonly onSuccess: (a: A) => B
    readonly onFailure: (e: E) => C
  }): <R, K extends Kind>(
    self: Unmatched<A, E, R, K>
  ) => Issued<B | C, R, A, K, E>
  <A, E, R, K extends Kind, B, C>(self: Unmatched<A, E, R, K>, options: {
    readonly onSuccess: (a: A) => B
    readonly onFailure: (e: E) => C
  }): Issued<B | C, R, A, K, E>
} = dual(2, (self: Unmatched<any, any, any, Kind>, options: {
  readonly onSuccess: (a: any) => any
  readonly onFailure: (e: any) => any
}): any =>
  makeIssued({
    ...(self as unknown as Fields),
    resolve: skipNoop(options.onSuccess),
    reject: options.onFailure
  }))

/**
 * Passes when `C` is an issued or unmatched Effect-kind `Service` Command,
 * and otherwise says why `Command.afterRefetch` doesn't take it.
 *
 * @stability experimental
 * @category utility types
 * @since 0.1.0
 */
export type AwaitsRefetch<C> = C extends
  Unmatched<infer _A, infer _E, infer R, infer K> ? AwaitsRefetchOf<R, K>
  : C extends Issued<infer _Msg, infer R, infer _S, infer K, infer _SE> ?
    AwaitsRefetchOf<R, K>
  : never

// `SourceE` is contravariant: `never` admits every issued Command.
type Awaitable =
  | Issued<any, any, any, Kind, never>
  | Unmatched<any, any, any, Kind>

type AwaitsRefetchOf<R, K> = [K] extends ["Effect"] ? [R] extends [never] ? {
      readonly "Command.afterRefetch takes a Command.Service Command. A Command.make Command invalidates nothing":
        never
    }
  : unknown
  : {
    readonly "Command.afterRefetch takes an Effect Command. A Stream Command has no final message to hold":
      never
  }

/**
 * Holds a Command's success message until the entries its run invalidated
 * have refetched, or until `budget` runs out.
 *
 * **When to use**
 *
 * Use when `update` needs the refetched data with the success: a "save, then
 * show the saved row" flow whose refetch would otherwise land a render after
 * the message.
 *
 * **Details**
 *
 * It applies to an issued or unmatched Effect-kind `Service` Command, on
 * either side of `match` and `map`. A Stream Command or a `make` Command
 * doesn't compile. A second application replaces the first.
 *
 * - The wait covers everything the run invalidated: declared targets plus
 *   those implied by patches, minus the entries its own `writes` stored
 *   fresh. Of those, it waits for the entries that have a watcher, from any
 *   instance, when the success applies its invalidation. A watcher that
 *   comes later doesn't join.
 * - An entry's wait ends when it has no refetch in flight and none owed,
 *   whether the refetch succeeds, fails or dies. The wait ends on the
 *   slowest entry, and the budget is the upper bound.
 * - `budget` is a `Duration.Input`: `"Infinity"` waits with no bound, zero
 *   doesn't wait, and a bare number is milliseconds. The clock is the
 *   Effect `Clock`, started when invalidation is applied. A run cut by the
 *   budget, by `switch` or by `Command.interrupt` delivers its success at
 *   once, and its refetches run on.
 * - A typed failure is delivered at once. An interrupt before the body
 *   succeeds sends nothing. If the issuing instance closes during the wait,
 *   the message is dropped.
 * - `h.isRunning` stays true through the wait. Under `queue` the next run
 *   starts when the body exits, and messages keep issue order.
 * - Each awaited entry emits when it settles, so its query's result is
 *   written before the success, in one render, for the last entry to
 *   settle. Two entries settling apart can briefly show a patched row next
 *   to the refetched one.
 *
 * **Example** (Waiting for a rename's refetch)
 *
 * ```ts import.meta.vitest
 * import { Command, UiSchema } from "@effect/ui"
 * import { Schema } from "effect"
 *
 * const Message = UiSchema.TaggedEnum({ CompletedRenameUser: {} })
 *
 * class RenameUser extends Command.Service<RenameUser>()("RenameUser", {
 *   args: { id: Schema.String, name: Schema.String },
 *   success: Schema.Void,
 *   error: Schema.Never
 * }) {}
 *
 * const rename = RenameUser.make({ id: "1", name: "Ada" }).pipe(
 *   Command.map(() => Message.CompletedRenameUser()),
 *   Command.afterRefetch("5 seconds")
 * )
 * ```
 *
 * @stability experimental
 * @category mapping
 * @since 0.1.0
 */
export const afterRefetch: {
  (
    budget: Duration.Input
  ): <C extends Awaitable>(self: C & AwaitsRefetch<C>) => C
  <C extends Awaitable>(self: C & AwaitsRefetch<C>, budget: Duration.Input): C
} = dual(2, (self: Awaitable, budget: Duration.Input): any =>
  makeIssued(
    {
      ...(self as unknown as Fields),
      afterRefetch: Duration.fromInputUnsafe(budget)
    },
    UnmatchedTypeId in self
  ))

/**
 * Issues a Command that interrupts the running and queued runs of another one.
 *
 * **When to use**
 *
 * Use to handle a user-driven cancel, such as a "Cancel upload" button, from
 * `update`.
 *
 * **Details**
 *
 * It produces no message. An interrupted run dispatches nothing and is logged
 * as `CommandInterrupted` when its fiber exits. Until then it holds its group:
 * a `queue` or `switch` run issued after the interrupt starts once the
 * interrupted run's cleanup has finished. With a pick of the Command's `group`
 * fields, only the runs of that group are interrupted. Without one, every run
 * of the Command the instance has is.
 *
 * **Example** (Cancelling an upload)
 *
 * ```ts import.meta.vitest
 * import { Command } from "@effect/ui"
 * import { Effect, Schema } from "effect"
 *
 * const UploadFile = Command.make("UploadFile", {
 *   args: { name: Schema.String },
 *   group: ["name"]
 * }, ({ name }) => Effect.succeed(`https://cdn/${name}`))
 *
 * // In `update`: `$.run(Command.interrupt(UploadFile, { name: "photo.png" }))`
 * const cancel = Command.interrupt(UploadFile, { name: "photo.png" })
 * ```
 *
 * @stability experimental
 * @category constructors
 * @since 0.1.0
 */
export const interrupt = <Args, G extends string>(
  definition: Definition<Args, any, boolean, any, G>,
  ...group: GroupArg<Args, G>
): Interrupt => {
  const source = group[0] === undefined
    ? undefined
    : definition["~group"](group[0])
  return Object.assign(Object.create(Proto), {
    _tag: "Interrupt",
    name: nameOf(definition),
    groupKey: source?.key,
    "~group": source
  })
}

/**
 * A server-side `update` issued a Command. No Command runs on the server, so
 * it was dropped, and the log has a `CommandDropped` entry with reason
 * `"server"` for the same `path`. It is reported every time.
 *
 * **Details**
 *
 * Data the server renders comes from a query: a query fetched by the
 * server's per-request cache. `init`'s Commands are dropped silently, since
 * the client runs them when it adopts the Model.
 *
 * @stability experimental
 * @category problems
 * @since 0.1.0
 */
export class ServerCommandIssued extends TaggedClass("ServerCommandIssued")<{
  readonly message: string
  /** The path of the instance whose `update` issued it. */
  readonly path: string
  /** The Command's name. */
  readonly command: string
}> {}

/**
 * A run that was stopped died before its fiber exited, such as in an
 * `Effect.onInterrupt` cleanup or an uninterruptible part of its body.
 *
 * **Details**
 *
 * A stopped run delivers nothing, so the defect can't reach `update`, and it
 * doesn't fail the instance or the run that replaced it. It's reported every
 * time, and the log has the run's `CommandInterrupted` entry.
 *
 * @stability experimental
 * @category problems
 * @since 0.1.0
 */
export class CleanupFailed extends TaggedClass("CleanupFailed")<{
  readonly message: string
  /** The path of the instance that issued the run. */
  readonly path: string
  /** The Command's name. */
  readonly command: string
  readonly cause: Cause.Cause<unknown>
}> {}

function cleanupFailed(
  path: string,
  command: string,
  cause: Cause.Cause<unknown>
): CleanupFailed {
  return new CleanupFailed({
    path,
    command,
    cause,
    message:
      `[@effect/ui] ${path}'s Command ${command} was stopped, and it died before its fiber exited.`
  })
}
