import { Command, Component, MessageLog, Query, UiSchema } from "@effect/ui"
import { Locator, Scene, Story, TestHost } from "@effect/ui/testing"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import type { Duration } from "effect"
import { AsyncResult } from "effect/reactivity"
import { TestClock } from "effect/testing"

const User = Schema.Struct({ id: Schema.String, name: Schema.String })

/**
 * A card per user over a query whose fetch takes `db.delay` ms per id, and a
 * rename that takes 10 ms, issued with `Command.afterRefetch(budget)`.
 */
const makeApp = (options?: {
  readonly mode?: Command.Mode | undefined
  readonly budget?: Duration.Input | undefined
  /** `self`: the card's own entry. `all`: every entry of the query. `unwatched`: an entry nobody watches. */
  readonly invalidates?: "self" | "all" | "unwatched" | undefined
  /** `false`: issue the rename without `Command.afterRefetch`. */
  readonly wait?: false | undefined
  /** The first `Renamed` issues a rename to this name. */
  readonly chain?: string | undefined
  /** How long the run's Scope takes to close after the body: a finalizer. */
  readonly cleanup?: Duration.Input | undefined
  /** A rename to one of these names ends with no message, through a value made apart from `Component.noop`. */
  readonly silent?: ReadonlyArray<string> | undefined
}) => {
  const db = {
    names: new Map<string, string>([["1", "Ann"], ["2", "Bea"]]),
    delay: new Map<string, number>([["1", 10], ["2", 10]]),
    fail: new Set<string>()
  }
  const order: Array<string> = []

  class GetUser extends Query.Service<GetUser>()(
    "users/GetUser",
    {
      args: { id: Schema.String },
      success: User,
      error: Schema.String,
      staleTime: "30 seconds"
    }
  ) {
    static readonly layer = this.toLayer(Effect.fnUntraced(function*({ id }) {
      yield* Effect.sleep(db.delay.get(id) ?? 10)
      if (db.fail.has(id)) return yield* Effect.fail("down")
      return { id, name: db.names.get(id) ?? "?" }
    }))
  }

  const invalidates = options?.invalidates ?? "self"
  class RenameUser extends Command.Service<RenameUser>()(
    "users/RenameUser",
    {
      args: { id: Schema.String, name: Schema.String },
      success: Schema.String,
      error: Schema.String,
      mode: options?.mode,
      invalidates: ({ id }) =>
        invalidates === "all"
          ? [GetUser]
          : invalidates === "unwatched"
          ? [GetUser.entry({ id: "9" })]
          : [GetUser.entry({ id })],
      optimistic: ({ id, name }) =>
        invalidates === "unwatched"
          ? []
          : [GetUser.patch({ id }, (user) => ({ ...user, name }))]
    }
  ) {
    static readonly layer = this.toLayer(
      Effect.fnUntraced(function*({ id, name }) {
        order.push(`body ${name}`)
        const cleanup = options?.cleanup
        if (cleanup !== undefined) {
          yield* Effect.addFinalizer(() => Effect.sleep(cleanup))
        }
        yield* Effect.sleep("10 millis")
        if (name === "") return yield* Effect.fail("empty")
        db.names.set(id, name)
        return name
      })
    )
  }

  const CardMessage = UiSchema.TaggedEnum({
    UserChanged: {},
    Rename: { name: Schema.String },
    Renamed: { name: Schema.String },
    Failed: { name: Schema.String },
    Stop: {}
  })
  const budget = options?.budget ?? "Infinity"
  const rename = (id: string, name: string) => {
    const matched = RenameUser.make({ id, name }).pipe(
      Command.match({
        onSuccess: (name) =>
          options?.silent?.includes(name)
            // Made here, not `Component.noop`: the runtime recognises it by its type id, not by identity.
            ? { [Component.NoopTypeId]: Component.NoopTypeId }
            : CardMessage.Renamed({ name }),
        onFailure: () => CardMessage.Failed({ name })
      })
    )
    return options?.wait === false
      ? matched
      : Command.afterRefetch(matched, budget)
  }
  const Card = Component.define({
    name: "Card",
    props: Schema.Struct({ id: Schema.String, tag: Schema.String }),
    model: Schema.Struct({ done: Schema.Array(Schema.String) }),
    message: CardMessage,
    queries: {
      user: {
        query: GetUser,
        args: ({ props }) => ({ id: props.id }),
        onChange: () => CardMessage.UserChanged()
      }
    }
  }).make({
    init: () => ({ done: [] }),
    update: ($, message) => {
      order.push(
        `update ${$.props.tag} ${message._tag}${
          "name" in message ? " " + message.name : ""
        }`
      )
      return CardMessage.match(message, {
        UserChanged: () => $.model,
        Rename: ({ name }) => $.run(rename($.props.id, name)),
        Renamed: ({ name }) => {
          const next = { ...$.model, done: [...$.model.done, name] }
          const chain = options?.chain
          return chain !== undefined && $.model.done.length === 0
            ? $.set(next).run(rename($.props.id, chain))
            : next
        },
        Failed: ({ name }) => ({
          ...$.model,
          done: [...$.model.done, "failed " + name]
        }),
        Stop: () => $.run(Command.interrupt(RenameUser))
      })
    },
    view: (h, model) => {
      const text = AsyncResult.match(h.queries.user, {
        onInitial: () => "loading",
        onSuccess: (success) =>
          success.value.name + (h.patched.user ? "~" : "") +
          (success.waiting ? "…" : ""),
        onFailure: () => "failed"
      })
      const shown = `${h.props.tag}=${text}${
        h.isRunning(RenameUser) ? " saving" : ""
      }${model.done.length === 0 ? "" : " [" + model.done.join(",") + "]"};`
      order.push(`view ${shown}`)
      return h.el("p").on("click", CardMessage.Rename({ name: "Bob" }))
        .children(shown)
    }
  })

  /** A parent whose Model says which cards are mounted: "tag:id" each. */
  const ListMessage = UiSchema.TaggedEnum({
    Set: { cards: Schema.Array(Schema.String) }
  })
  const List = Component.define({
    name: "List",
    props: Schema.Struct({ cards: Schema.Array(Schema.String) }),
    model: Schema.Array(Schema.String),
    message: ListMessage
  }).make({
    init: ($) => $.props.cards,
    update: (_, message) => message.cards,
    view: (h, cards) =>
      h.el(
        "div",
        cards.map((card) => {
          const [tag, id] = card.split(":")
          return Card(h, { key: tag, props: { id, tag } })
        })
      )
  })

  return {
    db,
    order,
    GetUser,
    RenameUser,
    CardMessage,
    Card,
    List,
    ListMessage,
    rename,
    layer: RenameUser.layer.pipe(Layer.provideMerge(GetUser.layer))
  }
}

const run = <A, E>(layer: Layer.Layer<any>, effect: Effect.Effect<A, E, any>) =>
  effect.pipe(
    Effect.provide(layer),
    Effect.scoped,
    Effect.provide(TestHost.layer())
  ) as Effect.Effect<A, E>

/** Starts what is due and lets 10 ms pass: a fetch or a rename body. */
const tick = TestHost.settle.pipe(
  Effect.andThen(TestClock.adjust("10 millis")),
  Effect.andThen(TestHost.settle)
)

type Root = Pick<TestHost.TestRoot<any, any, any>, "log" | "pending">

/** The log's Command entries, without their bookkeeping. */
const commandLog = (root: Root) =>
  root.log().flatMap(
    (
      entry
    ): ReadonlyArray<
      { readonly _tag: string; readonly [key: string]: unknown }
    > => {
      switch (entry._tag) {
        case "CommandAwaiting":
          return [{ _tag: entry._tag, entries: entry.entries }]
        case "CommandEnded":
          return [{
            _tag: entry._tag,
            ...(entry.waitEnded === undefined
              ? undefined
              : { waitEnded: entry.waitEnded, outstanding: entry.outstanding }),
            ...(entry.silent ? { silent: true } : undefined)
          }]
        case "CommandInterrupted":
          return [{ _tag: entry._tag }]
        case "CommandDropped":
          return [{ _tag: entry._tag, reason: entry.reason }]
        default:
          return []
      }
    }
  )

const statuses = (root: Root) =>
  root.pending().flatMap((pending) =>
    pending._tag === "Command" ? [pending.status] : []
  )

const user1: MessageLog.AwaitedEntry = {
  query: "users/GetUser",
  logKey: "{\"id\":\"1\"}"
}
const user2: MessageLog.AwaitedEntry = {
  query: "users/GetUser",
  logKey: "{\"id\":\"2\"}"
}

const renameOn = (
  root: { readonly send: (message: any) => void },
  app: ReturnType<typeof makeApp>,
  name: string
) => root.send(app.CardMessage.Rename({ name }))

describe("Command.afterRefetch", () => {
  it.effect("holds onSuccess until the refetch settles, after the query's onChange message and in the same render", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Card, { id: "1", tag: "a" })
        yield* tick
        renameOn(root, app, "Bob")
        yield* tick
        // The body succeeded. The refetch is in flight and the message waits: still saving.
        assert.strictEqual(root.text(), "a=Bob~… saving;")
        assert.deepStrictEqual(statuses(root), ["awaiting"])
        assert.deepStrictEqual(commandLog(root), [{
          _tag: "CommandAwaiting",
          entries: [user1]
        }])
        // The awaited set's refetch comes before CommandAwaiting.
        const tags = root.log().map((entry) => entry._tag)
        assert.isBelow(
          tags.lastIndexOf("FetchStarted"),
          tags.indexOf("CommandAwaiting")
        )
        app.order.length = 0
        yield* tick
        assert.deepStrictEqual(app.order, [
          "update a UserChanged",
          "update a Renamed Bob",
          "view a=Bob [Bob];"
        ])
        assert.deepStrictEqual(statuses(root), [])
        assert.deepStrictEqual(commandLog(root), [
          { _tag: "CommandAwaiting", entries: [user1] },
          { _tag: "CommandEnded", waitEnded: "settled", outstanding: [] }
        ])
      })
    )
  })

  it.effect("waits for the slowest watched entry, from any instance, and a refetch that fails ends it too", () => {
    const app = makeApp({ invalidates: "all" })
    app.db.delay.set("2", 30)
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.List, { cards: ["a:1", "b:2"] })
        yield* tick
        yield* TestClock.adjust("20 millis")
        assert.strictEqual(root.text(), "a=Ann;b=Bea;")
        app.db.fail.add("2")
        Locator.fire(root.get(Locator.text("a=Ann;", { exact: true })), "click")
        yield* tick
        assert.deepStrictEqual(commandLog(root), [{
          _tag: "CommandAwaiting",
          entries: [user1, user2]
        }])
        yield* tick
        // The card's own entry settled. The message still waits on b's.
        assert.strictEqual(root.text(), "a=Bob saving;b=Bea…;")
        yield* tick
        assert.strictEqual(root.text(), "a=Bob saving;b=Bea…;")
        yield* tick
        assert.strictEqual(root.text(), "a=Bob [Bob];b=failed;")
        assert.deepStrictEqual(commandLog(root).at(-1), {
          _tag: "CommandEnded",
          waitEnded: "settled",
          outstanding: []
        })
      })
    )
  })

  it.effect("an empty awaited set sends at fiber exit and logs no CommandAwaiting", () => {
    const app = makeApp({ invalidates: "unwatched" })
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Card, { id: "1", tag: "a" })
        yield* tick
        renameOn(root, app, "Bob")
        yield* tick
        assert.strictEqual(root.text(), "a=Ann [Bob];")
        assert.deepStrictEqual(commandLog(root), [{
          _tag: "CommandEnded",
          waitEnded: "nothing",
          outstanding: []
        }])
      })
    )
  })

  it.effect("a typed failure is sent at once, with no wait", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Card, { id: "1", tag: "a" })
        yield* tick
        renameOn(root, app, "")
        yield* tick
        // The refetch a failure asks for is in flight, and the message didn't wait for it.
        assert.strictEqual(root.text(), "a=Ann… [failed ];")
        assert.deepStrictEqual(commandLog(root), [{ _tag: "CommandEnded" }])
      })
    )
  })

  it.effect("the budget runs on the clock from fiber exit, and the refetch runs on", () => {
    const app = makeApp({ budget: "50 millis" })
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Card, { id: "1", tag: "a" })
        yield* tick
        app.db.delay.set("1", 1000)
        renameOn(root, app, "Bob")
        yield* tick
        yield* TestClock.adjust("49 millis")
        assert.deepStrictEqual(statuses(root), ["awaiting"])
        yield* TestClock.adjust("1 millis")
        assert.strictEqual(root.text(), "a=Bob~… [Bob];")
        assert.deepStrictEqual(commandLog(root).at(-1), {
          _tag: "CommandEnded",
          waitEnded: "budget",
          outstanding: [user1]
        })
        yield* TestClock.adjust("1 second")
        assert.strictEqual(root.text(), "a=Bob [Bob];")
      })
    )
  })

  it.effect("the budget runs from the invalidation, not from when the run's Scope has closed", () => {
    const app = makeApp({ budget: "50 millis", cleanup: "30 millis" })
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Card, { id: "1", tag: "a" })
        yield* tick
        app.db.delay.set("1", 1000)
        renameOn(root, app, "Bob")
        // The body ends and the invalidation applies at 10 ms. The fiber exits 30 ms later.
        yield* tick
        yield* TestClock.adjust("30 millis")
        yield* TestHost.settle
        assert.deepStrictEqual(statuses(root), ["awaiting"])
        yield* TestClock.adjust("19 millis")
        assert.deepStrictEqual(statuses(root), ["awaiting"])
        yield* TestClock.adjust("1 millis")
        assert.deepStrictEqual(statuses(root), [])
        assert.deepStrictEqual(commandLog(root).at(-1), {
          _tag: "CommandEnded",
          waitEnded: "budget",
          outstanding: [user1]
        })
        yield* TestClock.adjust("1 second")
      })
    )
  })

  it.effect("a budget spent while the run's Scope closes ends the wait at fiber exit", () => {
    const app = makeApp({ budget: "50 millis", cleanup: "100 millis" })
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Card, { id: "1", tag: "a" })
        yield* tick
        app.db.delay.set("1", 1000)
        renameOn(root, app, "Bob")
        yield* tick
        yield* TestClock.adjust("99 millis")
        assert.deepStrictEqual(statuses(root), ["running"])
        yield* TestClock.adjust("1 millis")
        yield* TestHost.settle
        assert.strictEqual(root.text(), "a=Bob~… [Bob];")
        assert.deepStrictEqual(commandLog(root).at(-1), {
          _tag: "CommandEnded",
          waitEnded: "budget",
          outstanding: [user1]
        })
        yield* TestClock.adjust("1 second")
      })
    )
  })

  it.effect("a queryMany query: the last key's onChange message, then onSuccess, then one view", () => {
    const app = makeApp({ invalidates: "all" })
    const BoardMessage = UiSchema.TaggedEnum({
      Changed: {},
      Rename: {},
      Renamed: {}
    })
    const order: Array<string> = []
    const Board = Component.define({
      name: "Board",
      model: Schema.Struct({ renamed: Schema.Boolean }),
      message: BoardMessage,
      queries: {
        users: {
          queryMany: app.GetUser,
          args: () => [{ id: "1" }, { id: "2" }],
          onChange: (_loaded, changes) => {
            order.push(
              `changes ${changes.map((change) => change.args.id).join(",")}`
            )
            return BoardMessage.Changed()
          }
        }
      }
    }).make({
      init: () => ({ renamed: false }),
      update: ($, message) => {
        order.push(`update ${message._tag}`)
        return BoardMessage.match(message, {
          Changed: () => $.model,
          Rename: () =>
            $.run(
              app.RenameUser.make({ id: "1", name: "Bob" }).pipe(
                Command.match({
                  onSuccess: () => BoardMessage.Renamed(),
                  onFailure: () => BoardMessage.Renamed()
                }),
                Command.afterRefetch("Infinity")
              )
            ),
          Renamed: () => ({ ...$.model, renamed: true })
        })
      },
      view: (h, model) => {
        const text = h.queries.users.map(({ result }) =>
          AsyncResult.match(result, {
            onInitial: () =>
              "…",
            onSuccess: (success) =>
              success.value.name + (success.waiting ? "…" : ""),
            onFailure: () => "failed"
          })
        ).join(",") + (model.renamed ? " renamed" : "")
        order.push(`view ${text}`)
        return h.el("p", text)
      }
    })
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(Board, {})
        yield* tick
        app.db.delay.set("2", 20)
        root.send(BoardMessage.Rename())
        yield* tick
        assert.deepStrictEqual(commandLog(root), [{
          _tag: "CommandAwaiting",
          entries: [user1, user2]
        }])
        order.length = 0
        yield* tick
        // The first key settles on its own: the message still waits on the second.
        assert.deepStrictEqual(order, [
          "changes 1",
          "update Changed",
          "view Bob,Bea…"
        ])
        order.length = 0
        yield* tick
        // The keyed message goes through the flush's deferred drain, and the delivery goes behind it.
        assert.deepStrictEqual(order, [
          "changes 2",
          "update Changed",
          "update Renamed",
          "view Bob,Bea renamed"
        ])
      })
    )
  })

  it.effect("a zero budget doesn't wait", () => {
    const app = makeApp({ budget: 0 })
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Card, { id: "1", tag: "a" })
        yield* tick
        renameOn(root, app, "Bob")
        yield* tick
        assert.strictEqual(root.text(), "a=Bob~… [Bob];")
        assert.deepStrictEqual(commandLog(root).at(-1), {
          _tag: "CommandEnded",
          waitEnded: "budget",
          outstanding: [user1]
        })
      })
    )
  })

  it.effect("switch delivers a waiting run's onSuccess inside the update that cut it", () => {
    const app = makeApp({ mode: "switch" })
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Card, { id: "1", tag: "a" })
        yield* tick
        app.db.delay.set("1", 1000)
        renameOn(root, app, "Bob")
        yield* tick
        app.order.length = 0
        renameOn(root, app, "Cy")
        // Bob's onSuccess comes inside the update that cut it, after Cy's patch has reached the result.
        assert.deepStrictEqual(app.order.slice(0, 3), [
          "update a Rename Cy",
          "update a UserChanged",
          "update a Renamed Bob"
        ])
        assert.deepStrictEqual(commandLog(root), [
          { _tag: "CommandAwaiting", entries: [user1] },
          { _tag: "CommandEnded", waitEnded: "switch", outstanding: [user1] }
        ])
        // Both entries survive the wire.
        const encoder = MessageLog.makeEncoder()
        for (
          const entry of root.log().filter((entry) =>
            entry._tag.startsWith("Command")
          )
        ) {
          const wire = encoder.encode(entry)
          assert.deepStrictEqual(
            Schema.decodeUnknownSync(MessageLog.Wire)(
              JSON.parse(JSON.stringify(wire))
            ),
            wire
          )
        }
        const wire: Array<any> = root.log().map((entry) =>
          encoder.encode(entry)
        )
        assert.deepStrictEqual(
          wire.find((entry) => entry._tag === "CommandAwaiting")?.entries,
          [user1]
        )
        assert.strictEqual(
          wire.find((entry) => entry._tag === "CommandEnded")?.waitEnded,
          "switch"
        )
        yield* tick
        assert.deepStrictEqual(statuses(root), ["awaiting"])
        yield* TestClock.adjust("1 second")
        assert.strictEqual(root.text(), "a=Cy [Bob,Cy];")
      })
    )
  })

  it.effect("Command.interrupt delivers a waiting run's onSuccess", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Card, { id: "1", tag: "a" })
        yield* tick
        app.db.delay.set("1", 1000)
        renameOn(root, app, "Bob")
        yield* tick
        root.send(app.CardMessage.Stop())
        yield* TestHost.settle
        assert.strictEqual(root.text(), "a=Bob~… [Bob];")
        assert.deepStrictEqual(commandLog(root).at(-1), {
          _tag: "CommandEnded",
          waitEnded: "interrupt",
          outstanding: [user1]
        })
        yield* TestClock.adjust("1 second")
      })
    )
  })

  it.effect("a closed instance drops the message: CommandEnded with no Update before it", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.List, { cards: ["a:1"] })
        yield* tick
        app.db.delay.set("1", 1000)
        Locator.fire(root.get(Locator.text("a=Ann;", { exact: true })), "click")
        yield* tick
        app.order.length = 0
        root.send(app.ListMessage.Set({ cards: [] }))
        yield* TestHost.settle
        assert.deepStrictEqual(app.order, [])
        assert.deepStrictEqual(commandLog(root).at(-1), {
          _tag: "CommandEnded",
          waitEnded: "closed",
          outstanding: [user1]
        })
        assert.deepStrictEqual(statuses(root), [])
        yield* TestClock.adjust("1 second")
      })
    )
  })

  it.effect("queue: the next run starts at fiber exit, and messages keep issue order", () => {
    const app = makeApp({ mode: "queue" })
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Card, { id: "1", tag: "a" })
        yield* tick
        renameOn(root, app, "Bob")
        renameOn(root, app, "Cy")
        yield* TestHost.settle
        assert.deepStrictEqual(statuses(root), ["running", "queued"])
        yield* tick
        // Bob's fiber exited: Cy runs, and its live patch holds the refetch Bob waits for.
        assert.deepStrictEqual(statuses(root), ["awaiting", "running"])
        assert.isTrue(
          root.pending().some((pending) =>
            pending._tag === "Fetch" && pending.status === "held"
          )
        )
        yield* tick
        assert.deepStrictEqual(statuses(root), ["awaiting", "awaiting"])
        app.order.length = 0
        yield* tick
        assert.deepStrictEqual(
          app.order.filter((line) => line.startsWith("update")),
          [
            "update a UserChanged",
            "update a Renamed Bob",
            "update a Renamed Cy"
          ]
        )
        assert.strictEqual(root.text(), "a=Cy [Bob,Cy];")
        assert.deepStrictEqual(
          commandLog(root).filter((entry) => entry._tag === "CommandEnded"),
          [
            { _tag: "CommandEnded", waitEnded: "settled", outstanding: [] },
            { _tag: "CommandEnded", waitEnded: "settled", outstanding: [] }
          ]
        )
      })
    )
  })

  it.effect("a silent run stays running until the refetch settles, then ends with no message", () => {
    const app = makeApp({ silent: ["Bob"] })
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Card, { id: "1", tag: "a" })
        yield* tick
        renameOn(root, app, "Bob")
        yield* tick
        assert.strictEqual(root.text(), "a=Bob~… saving;")
        assert.deepStrictEqual(statuses(root), ["awaiting"])
        app.order.length = 0
        yield* tick
        assert.deepStrictEqual(app.order, [
          "update a UserChanged",
          "view a=Bob;"
        ])
        assert.deepStrictEqual(statuses(root), [])
        assert.deepStrictEqual(commandLog(root), [
          { _tag: "CommandAwaiting", entries: [user1] },
          {
            _tag: "CommandEnded",
            waitEnded: "settled",
            outstanding: [],
            silent: true
          }
        ])
      })
    )
  })

  it.effect("queue: a silent run held behind its group keeps issue order and sends nothing", () => {
    const app = makeApp({ mode: "queue", silent: ["Bob"] })
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Card, { id: "1", tag: "a" })
        yield* tick
        renameOn(root, app, "Bob")
        renameOn(root, app, "Cy")
        renameOn(root, app, "Dan")
        yield* tick
        yield* tick
        yield* tick
        assert.deepStrictEqual(statuses(root), [
          "awaiting",
          "awaiting",
          "awaiting"
        ])
        app.order.length = 0
        yield* tick
        assert.deepStrictEqual(
          app.order.filter((line) => line.startsWith("update")),
          [
            "update a UserChanged",
            "update a Renamed Cy",
            "update a Renamed Dan"
          ]
        )
        assert.strictEqual(root.text(), "a=Dan [Cy,Dan];")
        assert.deepStrictEqual(
          commandLog(root).filter((entry) => entry._tag === "CommandEnded"),
          [
            {
              _tag: "CommandEnded",
              waitEnded: "settled",
              outstanding: [],
              silent: true
            },
            { _tag: "CommandEnded", waitEnded: "settled", outstanding: [] },
            { _tag: "CommandEnded", waitEnded: "settled", outstanding: [] }
          ]
        )
      })
    )
  })

  it.effect("switch cutting a waiting silent run delivers nothing inside the update that cut it", () => {
    const app = makeApp({ mode: "switch", silent: ["Bob"] })
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Card, { id: "1", tag: "a" })
        yield* tick
        app.db.delay.set("1", 1000)
        renameOn(root, app, "Bob")
        yield* tick
        app.order.length = 0
        renameOn(root, app, "Cy")
        assert.deepStrictEqual(
          app.order.filter((line) => line.startsWith("update")),
          [
            "update a Rename Cy",
            "update a UserChanged"
          ]
        )
        assert.deepStrictEqual(commandLog(root), [
          { _tag: "CommandAwaiting", entries: [user1] },
          {
            _tag: "CommandEnded",
            waitEnded: "switch",
            outstanding: [user1],
            silent: true
          }
        ])
        yield* tick
        yield* TestClock.adjust("1 second")
        assert.strictEqual(root.text(), "a=Cy [Cy];")
      })
    )
  })

  it.effect("queue: a later run's failure waits behind an earlier run's wait", () => {
    const app = makeApp({ mode: "queue" })
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Card, { id: "1", tag: "a" })
        yield* tick
        renameOn(root, app, "Bob")
        renameOn(root, app, "")
        yield* tick
        yield* tick
        // The failure is held: Bob's refetch hasn't landed.
        assert.deepStrictEqual(statuses(root), ["awaiting", "awaiting"])
        app.order.length = 0
        yield* tick
        assert.deepStrictEqual(
          app.order.filter((line) =>
            line.startsWith("update a R") || line.startsWith("update a F")
          ),
          [
            "update a Renamed Bob",
            "update a Failed "
          ]
        )
      })
    )
  })

  it.effect("queue: a run issued by a delivered success queues behind the run already queued", () => {
    // No wait: the run is awaiting only while its message is delivered.
    const app = makeApp({ mode: "queue", wait: false, chain: "Dan" })
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Card, { id: "1", tag: "a" })
        yield* tick
        renameOn(root, app, "Bob")
        renameOn(root, app, "Cy")
        yield* tick
        // Bob's update issued Dan, and Cy was promoted first.
        assert.deepStrictEqual(statuses(root), ["running", "queued"])
        yield* tick
        yield* tick
        assert.deepStrictEqual(
          app.order.filter((line) => line.startsWith("body")),
          ["body Bob", "body Cy", "body Dan"]
        )
        assert.deepStrictEqual(
          app.order.filter((line) => line.startsWith("update a Renamed")),
          [
            "update a Renamed Bob",
            "update a Renamed Cy",
            "update a Renamed Dan"
          ]
        )
      })
    )
  })

  it.effect("an infinite query: the wait ends when the walk swaps, not on its first page", () => {
    const Item = Schema.Struct({ id: Schema.String })
    const Page = Schema.Struct({
      items: Schema.Array(Item),
      next: Schema.NullOr(Schema.Number)
    })
    const db = { version: 0 }
    class ListItems extends Query.InfiniteService<ListItems>()(
      "items/ListItems",
      {
        args: {},
        page: Page,
        items: (page) => page.items,
        key: (item) => item.id,
        error: Schema.Never,
        cursor: Schema.Number,
        next: (lastPage) => Option.fromNullishOr(lastPage.next),
        staleTime: "30 seconds"
      }
    ) {
      static readonly layer = this.toLayer(
        Effect.fnUntraced(function*(_args, cursor) {
          const index = Option.getOrElse(cursor, () => 0)
          yield* Effect.sleep("10 millis")
          return {
            items: [{ id: `${db.version}-${index}` }],
            next: index < 1 ? index + 1 : null
          }
        })
      )
    }
    class Touch extends Command.Service<Touch>()(
      "items/Touch",
      {
        args: {},
        success: Schema.Void,
        error: Schema.Never,
        invalidates: () => [ListItems]
      }
    ) {
      static readonly layer = this.toLayer(() =>
        Effect.sleep("10 millis").pipe(Effect.andThen(Effect.sync(() => {
          db.version++
        })))
      )
    }
    const ItemsMessage = UiSchema.TaggedEnum({
      More: {},
      Touch: {},
      Touched: {}
    })
    const ItemsView = Component.define({
      name: "ItemsView",
      model: Schema.Struct({ touched: Schema.Boolean }),
      message: ItemsMessage,
      queries: { items: { query: ListItems, args: () => ({}) } }
    }).make({
      init: () => ({ touched: false }),
      update: ($, message) =>
        ItemsMessage.match(message, {
          More: () => $.loadMore("items"),
          Touch: () =>
            $.set({ ...$.model, touched: false }).run(
              Touch.make().pipe(
                Command.map(() => ItemsMessage.Touched()),
                Command.afterRefetch("Infinity")
              )
            ),
          Touched: () => ({ ...$.model, touched: true })
        }),
      view: (h, model) =>
        h.el(
          "p",
          AsyncResult.match(h.queries.items, {
            onInitial: () => "loading",
            onFailure: () => "failed",
            onSuccess: ({ value: { items } }) =>
              items.map((item) => item.id).join(",")
          }) + (model.touched ? " touched" : "")
        )
    })
    return run(
      Layer.mergeAll(Touch.layer, ListItems.layer),
      Effect.gen(function*() {
        const root = yield* TestHost.mount(ItemsView, {})
        yield* tick
        root.send(ItemsMessage.More())
        yield* tick
        assert.strictEqual(root.text(), "0-0,0-1")
        root.send(ItemsMessage.Touch())
        yield* tick
        assert.deepStrictEqual(commandLog(root), [{
          _tag: "CommandAwaiting",
          entries: [{ query: "items/ListItems", logKey: "{}" }]
        }])
        // The walk's first page is in, and the held pages show until it swaps.
        yield* tick
        assert.strictEqual(root.text(), "0-0,0-1")
        yield* tick
        assert.strictEqual(root.text(), "1-0,1-1 touched")
        assert.deepStrictEqual(commandLog(root).at(-1), {
          _tag: "CommandEnded",
          waitEnded: "settled",
          outstanding: []
        })
      })
    )
  })

  describe("Story", () => {
    const app = makeApp()
    const ann = { id: "1", name: "Ann" }

    it.effect("resolve awaits the component's own queries, and loaded sends the query's onChange message, then onSuccess", () =>
      Effect.gen(function*() {
        const story = yield* Story.make(app.Card, { id: "1", tag: "a" })
        story
          .loaded("user", ann)
          .send(app.CardMessage.Rename({ name: "Bob" }))
          .resolve(app.RenameUser, "Bob")
        assert.deepStrictEqual(
          story.pending.map((entry) => [entry.status, entry.awaiting]),
          [
            ["awaiting", [{ name: "user", args: { id: "1" } }]]
          ]
        )
        assert.deepStrictEqual(story.model.done, [])
        app.order.length = 0
        story.loaded("user", { id: "1", name: "Bob" })
        assert.deepStrictEqual(
          app.order.filter((line) => line.startsWith("update")),
          [
            "update a UserChanged",
            "update a Renamed Bob"
          ]
        )
        assert.deepStrictEqual(story.model.done, ["Bob"])
        story.expectNone()
        // h.isRunning stays true through the wait.
        const scene = yield* Scene.make(app.Card, { id: "1", tag: "a" })
        scene
          .loaded("user", ann)
          .click(Locator.tag("p"))
          .resolve(app.RenameUser, "Bob")
          .expect(Locator.text("saving")).toExist()
          .loaded("user", { id: "1", name: "Bob" })
          .expect(Locator.tag("p")).toHaveText("a=Bob [Bob];")
      }))

    it.effect("an empty set sends at once, fail sends at once, and waitExpired ends a wait by budget", () =>
      Effect.gen(function*() {
        const story = yield* Story.make(app.Card, { id: "2", tag: "b" })
        story
          .loaded("user", { id: "2", name: "Bea" })
          .send(app.CardMessage.Rename({ name: "" }))
          .fail(app.RenameUser, "empty")
        assert.deepStrictEqual(story.model.done, ["failed "])
        story
          .send(app.CardMessage.Rename({ name: "Cy" }))
          .resolve(app.RenameUser, "Cy")
          .waitExpired(app.RenameUser)
        assert.deepStrictEqual(story.model.done, ["failed ", "Cy"])
        const unwatched = makeApp({ invalidates: "unwatched" })
        const u = yield* Story.make(unwatched.Card, { id: "1", tag: "a" })
        u
          .loaded("user", ann)
          .send(unwatched.CardMessage.Rename({ name: "Bob" }))
          .resolve(unwatched.RenameUser, "Bob")
        assert.deepStrictEqual(u.model.done, ["Bob"])
        const started = Story.start(app.Card, { id: "1", tag: "a" })
        assert.throws(
          () => started.waitExpired(app.RenameUser),
          /no users\/RenameUser is waiting/
        )
      }))

    it.effect("a run cut by switch or Command.interrupt while awaiting delivers onSuccess and isn't interrupted", () =>
      Effect.gen(function*() {
        const switching = makeApp({ mode: "switch" })
        const story = yield* Story.make(switching.Card, { id: "1", tag: "a" })
        story
          .loaded("user", ann)
          .send(switching.CardMessage.Rename({ name: "Bob" }))
          .resolve(switching.RenameUser, "Bob")
          .send(switching.CardMessage.Rename({ name: "Cy" }))
        assert.deepStrictEqual(story.model.done, ["Bob"])
        story
          .resolve(switching.RenameUser, "Cy")
          .send(switching.CardMessage.Stop())
        assert.deepStrictEqual(story.model.done, ["Bob", "Cy"])
        assert.deepStrictEqual(story.interrupted, [])
      }))

    it.effect("queue treats an awaiting run as the runtime does", () =>
      Effect.gen(function*() {
        const queued = makeApp({ mode: "queue" })
        const story = yield* Story.make(queued.Card, { id: "1", tag: "a" })
        story
          .loaded("user", ann)
          .send(queued.CardMessage.Rename({ name: "Bob" }))
          .send(queued.CardMessage.Rename({ name: "" }))
          .resolve(queued.RenameUser, "Bob")
        assert.deepStrictEqual(story.pending.map((entry) => entry.status), [
          "awaiting",
          "running"
        ])
        story.fail(queued.RenameUser, "empty")
        // The failure waits behind Bob's message.
        assert.deepStrictEqual(story.model.done, [])
        story.loaded("user", { id: "1", name: "Bob" })
        assert.deepStrictEqual(story.model.done, ["Bob", "failed "])
      }))

    it.effect("loaded on a query that was cold when a Command was issued doesn't throw: its patch never registered", () =>
      Effect.gen(function*() {
        const story = yield* Story.make(app.Card, { id: "1", tag: "a" })
        story
          .keepPending("user")
          .send(app.CardMessage.Rename({ name: "Bob" }))
          .loaded("user", ann)
          .resolve(app.RenameUser, "Bob")
        assert.deepStrictEqual(story.pending.map((entry) => entry.status), [
          "awaiting"
        ])
        story.loaded("user", { id: "1", name: "Bob" })
        assert.deepStrictEqual(story.model.done, ["Bob"])
        // Nor does a query that held only a Failure.
        const failed = yield* Story.make(app.Card, { id: "1", tag: "a" })
        failed
          .loadFailed("user", "down")
          .send(app.CardMessage.Rename({ name: "Bob" }))
          .loaded("user", ann)
          .resolve(app.RenameUser, "Bob")
          .loaded("user", { id: "1", name: "Bob" })
      }))

    it.effect("loaded throws on a query a running Command patches, unless the value is patched", () =>
      Effect.gen(function*() {
        const started = Story.start(app.Card, { id: "1", tag: "a" })
        assert.throws(
          () =>
            started
              .loaded("user", ann)
              .send(app.CardMessage.Rename({ name: "Bob" }))
              .loaded("user", { id: "1", name: "Bob" }),
          /"user" is under the optimistic patch of users\/RenameUser/
        )
        const story = yield* Story.make(app.Card, { id: "1", tag: "a" })
        story
          .loaded("user", ann)
          .send(app.CardMessage.Rename({ name: "Bob" }))
          .loaded("user", { id: "1", name: "Bob" }, { patched: true })
          .resolve(app.RenameUser, "Bob")
          .loaded("user", { id: "1", name: "Bob" })
      }))
  })
})
