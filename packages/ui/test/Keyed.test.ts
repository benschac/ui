import {
  Command,
  Component,
  MessageLog,
  Query,
  Route,
  Router,
  UiSchema
} from "@effect/ui"
import { Locator, Scene, type Steps, Story, TestHost } from "@effect/ui/testing"
import { assert, describe, it } from "@effect/vitest"
import {
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Request,
  RequestResolver,
  Schema
} from "effect"
import { AsyncResult } from "effect/reactivity"
import { TestClock } from "effect/testing"

const User = Schema.Struct({ id: Schema.String, name: Schema.String })

interface FetchUser extends Request.Request<typeof User.Type, string> {
  readonly _tag: "FetchUser"
  readonly id: string
}
const FetchUser = Request.tagged<FetchUser>("FetchUser")

/**
 * A fresh read, mutation and components per test: the db is closed over. The
 * read fetches through a batching resolver whose `runAll` takes 10 ms.
 */
const makeApp = (options?: {
  readonly interval?: boolean
  /** The resolver's batch window, longer than its default of one yield. */
  readonly delay?: "50 millis"
  /** A prune's `update` keeps only the first id, so a prune can cause one more. */
  readonly pruneTrims?: boolean
  /** A prune's `update` drops the last id, so each prune causes one more until one id is left. */
  readonly pruneDrops?: boolean
}) => {
  const db = {
    calls: 0,
    batches: [] as Array<number>,
    names: new Map([["1", "Ann"], ["2", "Bea"], ["3", "Cy"]])
  }
  const order: Array<string> = []
  let queryRuns = 0

  const batching = RequestResolver.make<FetchUser>((entries) =>
    Effect.sleep("10 millis").pipe(Effect.andThen(Effect.sync(() => {
      db.batches.push(entries.length)
      for (const entry of entries) {
        db.calls++
        const name = db.names.get(entry.request.id)
        entry.completeUnsafe(
          entry.request.id === "boom"
            ? Exit.die("kaboom")
            : name === undefined
            ? Exit.fail("missing")
            : Exit.succeed({ id: entry.request.id, name })
        )
      }
    })))
  )
  const resolver = options?.delay === undefined
    ? batching
    : RequestResolver.setDelay(batching, options.delay)

  class GetUser extends Query.Service<GetUser>()(
    "users/GetUser",
    {
      args: { id: Schema.String },
      success: User,
      error: Schema.String,
      staleTime: "30 seconds",
      refetchInterval: options?.interval === true ? "5 seconds" : undefined
    }
  ) {
    static readonly layer = this.toLayer(({ id }) =>
      Effect.request(FetchUser({ id }), resolver)
    )
  }

  class RenameUser extends Command.Service<RenameUser>()(
    "users/RenameUser",
    {
      args: { id: Schema.String, name: Schema.String },
      success: Schema.Void,
      error: Schema.Never,
      invalidates: ({ id }) => [GetUser.entry({ id })],
      optimistic: (
        { id, name }
      ) => [GetUser.patch({ id }, (user) => ({ ...user, name }))]
    }
  ) {
    static readonly layer = this.toLayer(
      Effect.fnUntraced(function*({ id, name }) {
        yield* Effect.sleep("10 millis")
        db.names.set(id, name)
      })
    )
  }

  const BoardMessage = UiSchema.TaggedEnum({
    Show: { ids: Schema.Array(Schema.String) },
    UsersChanged: { changed: Schema.Array(Schema.String) },
    Rename: { id: Schema.String, name: Schema.String },
    Renamed: {}
  })
  const show = (result: AsyncResult.AsyncResult<typeof User.Type, string>) =>
    AsyncResult.match(result, {
      onInitial: () => "…",
      onSuccess: (success) => success.value.name + (success.waiting ? "…" : ""),
      onFailure: () => "failed"
    })
  const Board = Component.define({
    name: "Board",
    props: Schema.Struct({
      tag: Schema.String,
      ids: Schema.Array(Schema.String)
    }),
    model: Schema.Struct({ ids: Schema.Array(Schema.String) }),
    message: BoardMessage,
    queries: {
      users: {
        queryMany: GetUser,
        args: ({ model }) => {
          queryRuns++
          return model.ids.map((id) => ({ id }))
        },
        onChange: (results, changes) => {
          // The opened array is the collection at the query's keys.
          assert.strictEqual(
            results.length,
            new Set(results.map((entry) => entry.args.id)).size
          )
          return BoardMessage.UsersChanged({
            changed: changes.map((change) =>
              `${change.args.id}:${show(change.result)}`
            )
          })
        }
      }
    }
  }).make({
    init: ($) => ({ ids: $.props.ids }),
    update: ($, message) =>
      BoardMessage.match(message, {
        Show: ({ ids }) => ({ ...$.model, ids }),
        UsersChanged: ({ changed }) => {
          order.push(`update ${$.props.tag} [${changed.join(",")}]`)
          if (changed.length > 0) return $.model
          if (options?.pruneTrims === true) {
            return { ids: $.model.ids.slice(0, 1) }
          }
          if (options?.pruneDrops === true && $.model.ids.length > 1) {
            return { ids: $.model.ids.slice(0, -1) }
          }
          return $.model
        },
        Rename: ({ id, name }) => {
          order.push(`update ${$.props.tag} Rename`)
          return $.run(
            RenameUser.make({ id, name }).pipe(
              Command.map(() => BoardMessage.Renamed())
            )
          )
        },
        Renamed: () => $.model
      }),
    view: (h) => {
      const text = h.queries.users.map(({ args, result, patched }) =>
        `${args.id}=${show(result)}${patched ? "~" : ""}`
      )
        .join(" ")
      order.push(`view ${h.props.tag} ${text}`)
      return h.el("p").on(
        "click",
        BoardMessage.Rename({ id: "1", name: `Bob${h.props.tag}` })
      ).children(`${h.props.tag}: ${text}`)
    }
  })

  /** Boards side by side: "tag:id,id" each. */
  const ListMessage = UiSchema.TaggedEnum({
    Set: { boards: Schema.Array(Schema.String) }
  })
  const List = Component.define({
    name: "List",
    props: Schema.Struct({ boards: Schema.Array(Schema.String) }),
    model: Schema.Array(Schema.String),
    message: ListMessage
  }).make({
    init: ($) => $.props.boards,
    update: (_, message) => message.boards,
    view: (h, boards) =>
      h.el(
        "div",
        boards.map((board) => {
          const [tag, ids] = board.split(":")
          return Board(h, { key: tag, props: { tag, ids: ids.split(",") } })
        })
      )
  })

  return {
    db,
    order,
    queryRuns: () => queryRuns,
    GetUser,
    BoardMessage,
    Board,
    ListMessage,
    List,
    layer: RenameUser.layer.pipe(Layer.provideMerge(GetUser.layer))
  }
}

const run = <A, E>(layer: Layer.Layer<any>, effect: Effect.Effect<A, E, any>) =>
  effect.pipe(
    Effect.provide(layer),
    Effect.scoped,
    Effect.provide(TestHost.layer())
  ) as Effect.Effect<A, E>

/** Starts what is due and lets the fetches finish: each batch takes 10 ms. */
const load = TestHost.settle.pipe(
  Effect.andThen(TestClock.adjust("10 millis")),
  Effect.andThen(TestHost.settle)
)

/**
 * A query's result JSON codec, as the runtime writes page state, history state and the log's Wire with
 * it. The component's queries carry the Schemas.
 */
const resultCodec = (component: Component.Any, name: string) =>
  Schema.toCodecJson(
    (component["~queries"] as {
      readonly schema: Schema.Struct<
        Record<string, Schema.Codec<unknown, unknown>>
      >
    })
      .schema.fields[name]
  )

/** A keyed result's tuples as its JSON codec writes them: the old snapshot's JSON. */
const tuples = (
  component: Component.Any,
  name: string,
  result: unknown
): ReadonlyArray<ReadonlyArray<unknown>> =>
  Schema.encodeSync(resultCodec(component, name))(result) as ReadonlyArray<
    ReadonlyArray<unknown>
  >

/** The last result the runtime wrote for a query at a path, from the log. */
const resultOf = (
  log: ReadonlyArray<MessageLog.Entry>,
  path: string,
  name: string
): unknown =>
  [...log].reverse().find((entry): entry is MessageLog.QueryChanged =>
    entry._tag === "QueryChanged" && entry.path === path && entry.name === name
  )?.result

const updates = (order: ReadonlyArray<string>) =>
  order.filter((line) => line.startsWith("update"))

/** The args ids a keyed result holds. */
const heldIds = (
  component: Component.Any,
  result: unknown
): ReadonlyArray<unknown> =>
  tuples(component, "users", result).map((tuple) =>
    JSON.parse(tuple[0] as string).id
  )

/** The ids the root Board's result holds. */
const boardIds = (
  app: ReturnType<typeof makeApp>,
  root: { readonly log: () => ReadonlyArray<MessageLog.Entry> }
) => heldIds(app.Board, resultOf(root.log(), "/Board", "users"))

describe("Keyed query fields", () => {
  it.effect("N cold keys start N fetches in one batch, and its results are one message with N changes", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Board, {
          tag: "a",
          ids: ["1", "2", "3"]
        })
        assert.strictEqual(root.text(), "a: 1=… 2=… 3=…")
        yield* load
        assert.strictEqual(root.text(), "a: 1=Ann 2=Bea 3=Cy")
        assert.deepStrictEqual(updates(app.order), [
          "update a [1:Ann,2:Bea,3:Cy]"
        ])
        assert.deepStrictEqual(
          root.fetches().map((fetch) => [fetch.logKey, fetch.trigger]),
          [
            ["{\"id\":\"1\"}", "watch"],
            ["{\"id\":\"2\"}", "watch"],
            ["{\"id\":\"3\"}", "watch"]
          ]
        )
        assert.deepStrictEqual(app.db.batches, [3])
        assert.strictEqual(root.entry(app.GetUser, { id: "2" })?.watchers, 1)
        // The result's write is logged, then the Update of its onChange message, which points at it.
        const written = root.log().filter((entry) =>
          entry._tag === "QueryChanged" ||
          (entry._tag === "Update" && entry.source._tag === "Query")
        )
        assert.deepStrictEqual(written.map((entry) => entry._tag), [
          "QueryChanged",
          "Update"
        ])
        assert.deepStrictEqual((written[1] as MessageLog.Update).source, {
          _tag: "Query",
          name: "users",
          seq: written[0].seq
        })
      })
    )
  })

  it.effect("a typed failure for one key in a batch is one entry of the one message", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Board, {
          tag: "a",
          ids: ["1", "9", "3"]
        })
        yield* load
        assert.strictEqual(root.text(), "a: 1=Ann 9=failed 3=Cy")
        assert.deepStrictEqual(updates(app.order), [
          "update a [1:Ann,9:failed,3:Cy]"
        ])
      })
    )
  })

  it.effect("a mount over N warm keys folds one message with N changes before the first render", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.List, { boards: ["a:1,2"] })
        yield* load
        app.order.length = 0
        const before = root.frames().length
        yield* Effect.sync(() =>
          root.send(app.ListMessage.Set({ boards: ["a:1,2", "b:2,1,2"] }))
        )
        yield* TestHost.settle
        assert.deepStrictEqual(updates(app.order), ["update b [2:Bea,1:Ann]"])
        assert.deepStrictEqual(root.frames().slice(before), [
          "a: 1=Ann 2=Beab: 2=Bea 1=Ann"
        ])
        assert.strictEqual(app.db.calls, 2)
      })
    )
  })

  it.effect("a mount over warm keys calls the view once, with the values", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.List, { boards: ["a:1,2"] })
        yield* load
        app.order.length = 0
        root.send(app.ListMessage.Set({ boards: ["a:1,2", "b:2,1"] }))
        yield* TestHost.settle
        assert.deepStrictEqual(
          app.order.filter((line) => line.includes(" b")),
          [
            "update b [2:Bea,1:Ann]",
            "view b 2=Bea 1=Ann"
          ]
        )
      })
    )
  })

  it.effect("a kept child's new props over a warm key send its message before the child's one view", () => {
    const app = makeApp()
    const order: Array<string> = []
    const Message = UiSchema.TaggedEnum({
      UsersChanged: { changed: Schema.Array(Schema.String) }
    })
    const Row = Component.define({
      name: "Row",
      props: Schema.Struct({ ids: Schema.Array(Schema.String) }),
      model: Schema.Struct({}),
      message: Message,
      queries: {
        users: {
          queryMany: app.GetUser,
          args: ({ props }) => props.ids.map((id) => ({ id })),
          onChange: (_loaded, changes) =>
            Message.UsersChanged({
              changed: changes.map((change) => change.args.id)
            })
        }
      }
    }).make({
      init: () => ({}),
      update: ($, { changed }) => {
        order.push(`update [${changed.join(",")}]`)
        return $.model
      },
      view: (h) => {
        const text = h.queries.users.map(({ result }) =>
          AsyncResult.isSuccess(result) ? result.value.name : "…"
        )
          .join(" ")
        order.push(`view ${text}`)
        return h.el("p", text)
      }
    })
    const PageMessage = UiSchema.TaggedEnum({
      Show: { ids: Schema.Array(Schema.String) }
    })
    const Page = Component.define({
      name: "Page",
      model: Schema.Array(Schema.String),
      message: PageMessage
    }).make({
      init: () => ["1"],
      update: (_, { ids }) => ids,
      view: (h, ids) =>
        h.el(
          "div",
          Row(h, { key: "row", props: { ids } }),
          app.Board(h, { key: "b", props: { tag: "b", ids: ["3"] } })
        )
    })
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(Page, {})
        yield* load
        order.length = 0
        root.send(PageMessage.Show({ ids: ["1", "3"] }))
        yield* TestHost.settle
        assert.deepStrictEqual(order, ["update [3]", "view Ann Cy"])
      })
    )
  })

  it.effect("a mount over stale keys sends the stale values, then the waiting ones, in one committed frame", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.List, { boards: ["a:1,2"] })
        yield* load
        yield* TestClock.adjust("31 seconds")
        app.order.length = 0
        const before = root.frames().length
        // a leaves as b arrives, so the end of the pass fetches both keys.
        root.send(app.ListMessage.Set({ boards: ["b:1,2"] }))
        yield* TestHost.settle
        assert.deepStrictEqual(app.order, [
          "update b [1:Ann,2:Bea]",
          "view b 1=Ann 2=Bea",
          "update b [1:Ann…,2:Bea…]",
          "view b 1=Ann… 2=Bea…"
        ])
        assert.deepStrictEqual(root.frames().slice(before), [
          "b: 1=Ann… 2=Bea…"
        ])
      })
    )
  })

  it.effect("two prunes before one flush are one message", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Board, {
          tag: "a",
          ids: ["1", "2", "3"]
        })
        yield* load
        app.order.length = 0
        root.send(app.BoardMessage.Show({ ids: ["1", "2"] }))
        root.send(app.BoardMessage.Show({ ids: ["1"] }))
        yield* TestHost.settle
        assert.deepStrictEqual(updates(app.order), ["update a []"])
        assert.deepStrictEqual(boardIds(app, root), ["1"])
      })
    )
  })

  it.effect("a prune then a patch before one flush are one message, with the patch as its change", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Board, {
          tag: "a",
          ids: ["1", "2", "3"]
        })
        yield* load
        app.order.length = 0
        root.send(app.BoardMessage.Show({ ids: ["1", "2"] }))
        root.send(app.BoardMessage.Rename({ id: "1", name: "Al" }))
        yield* TestHost.settle
        assert.deepStrictEqual(updates(app.order), [
          "update a Rename",
          "update a [1:Al]"
        ])
        assert.deepStrictEqual(boardIds(app, root), ["1", "2"])
        assert.strictEqual(root.text(), "a: 1=Al~ 2=Bea")
      })
    )
  })

  it.effect("patches separated by a prune before one flush are one message with both changes", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Board, {
          tag: "a",
          ids: ["1", "2", "3"]
        })
        yield* load
        app.order.length = 0
        root.send(app.BoardMessage.Rename({ id: "1", name: "Al" }))
        root.send(app.BoardMessage.Show({ ids: ["1", "2"] }))
        root.send(app.BoardMessage.Rename({ id: "2", name: "Bo" }))
        yield* TestHost.settle
        assert.deepStrictEqual(updates(app.order), [
          "update a Rename",
          "update a Rename",
          "update a [1:Al,2:Bo]"
        ])
        assert.deepStrictEqual(boardIds(app, root), ["1", "2"])
        assert.strictEqual(root.text(), "a: 1=Al~ 2=Bo~")
      })
    )
  })

  it.effect("a prune whose update prunes again is sent in a second round, before the view", () => {
    const app = makeApp({ pruneTrims: true })
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Board, {
          tag: "a",
          ids: ["1", "2", "3"]
        })
        yield* load
        app.order.length = 0
        root.send(app.BoardMessage.Show({ ids: ["1", "2"] }))
        yield* TestHost.settle
        assert.deepStrictEqual(app.order, [
          "update a []",
          "update a []",
          "view a 1=Ann"
        ])
        assert.deepStrictEqual(boardIds(app, root), ["1"])
      })
    )
  })

  it.effect("each keyed query runs once per Model change", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Board, {
          tag: "a",
          ids: ["1", "2"]
        })
        // The first Model: its watch and its view share one run.
        assert.strictEqual(app.queryRuns(), 1)
        yield* load
        // The message's Model: one more.
        assert.strictEqual(app.queryRuns(), 2)
        root.send(app.BoardMessage.Show({ ids: ["2"] }))
        yield* TestHost.settle
        // `Show`'s Model, then the prune message's.
        assert.strictEqual(app.queryRuns(), 4)
      })
    )
  })

  it.effect("a prune: a removed key leaves the result, and onChange gets no changes", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Board, {
          tag: "a",
          ids: ["1", "2", "3"]
        })
        yield* load
        app.order.length = 0
        root.send(app.BoardMessage.Show({ ids: ["1", "3"] }))
        yield* TestHost.settle
        assert.deepStrictEqual(updates(app.order), ["update a []"])
        assert.deepStrictEqual(boardIds(app, root), ["1", "3"])
        assert.strictEqual(root.entry(app.GetUser, { id: "2" })?.watchers, 0)
        assert.strictEqual(root.text(), "a: 1=Ann 3=Cy")
      })
    )
  })

  it.effect("a prune is written once, and not again until the result holds a key the query no longer returns", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Board, {
          tag: "a",
          ids: ["1", "2", "3"]
        })
        yield* load
        app.order.length = 0
        root.send(app.BoardMessage.Show({ ids: ["1", "3"] }))
        yield* TestHost.settle
        assert.deepStrictEqual(updates(app.order), ["update a []"])
        // The result no longer holds key 2, so a reorder of the rest prunes nothing.
        assert.deepStrictEqual(boardIds(app, root), ["1", "3"])
        assert.strictEqual(root.text(), "a: 1=Ann 3=Cy")
        root.send(app.BoardMessage.Show({ ids: ["3", "1"] }))
        yield* TestHost.settle
        assert.deepStrictEqual(updates(app.order), ["update a []"])
        root.send(app.BoardMessage.Show({ ids: ["1"] }))
        yield* TestHost.settle
        assert.deepStrictEqual(updates(app.order), [
          "update a []",
          "update a []"
        ])
        assert.deepStrictEqual(boardIds(app, root), ["1"])
      })
    )
  })

  it.effect("a reorder or an added duplicate sends nothing, and the view follows the query's order", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Board, {
          tag: "a",
          ids: ["1", "2", "3"]
        })
        yield* load
        app.order.length = 0
        root.send(app.BoardMessage.Show({ ids: ["3", "1", "2", "1"] }))
        yield* TestHost.settle
        assert.deepStrictEqual(updates(app.order), [])
        assert.strictEqual(root.text(), "a: 3=Cy 1=Ann 2=Bea")
        assert.strictEqual(root.entry(app.GetUser, { id: "1" })?.watchers, 1)
      })
    )
  })

  it.effect("an added warm key is the only change, and an added cold key sends nothing until it loads", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Board, {
          tag: "a",
          ids: ["1", "2", "3"]
        })
        yield* load
        root.send(app.BoardMessage.Show({ ids: ["1", "2"] }))
        yield* TestHost.settle
        app.order.length = 0
        // 3 is still cached: warm.
        root.send(app.BoardMessage.Show({ ids: ["1", "2", "3"] }))
        yield* TestHost.settle
        assert.deepStrictEqual(updates(app.order), ["update a [3:Cy]"])
        app.order.length = 0
        app.db.names.set("4", "Di")
        root.send(app.BoardMessage.Show({ ids: ["1", "2", "3", "4"] }))
        yield* TestHost.settle
        assert.deepStrictEqual(updates(app.order), [])
        assert.strictEqual(root.text(), "a: 1=Ann 2=Bea 3=Cy 4=…")
        yield* load
        assert.deepStrictEqual(updates(app.order), ["update a [4:Di]"])
      })
    )
  })

  it.effect("refetchInterval: each of N keys refetches on its own timer, and sends its own message", () => {
    const app = makeApp({ interval: true })
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Board, {
          tag: "a",
          ids: ["1", "2", "3"]
        })
        yield* load
        app.order.length = 0
        app.db.names.set("1", "Ann2")
        app.db.names.set("3", "Cy2")
        yield* TestClock.adjust("5 seconds")
        yield* load
        assert.deepStrictEqual(root.fetches().map((fetch) => fetch.trigger), [
          "watch",
          "watch",
          "watch",
          "interval",
          "interval",
          "interval"
        ])
        assert.strictEqual(root.text(), "a: 1=Ann2 2=Bea 3=Cy2")
        // Each key's timer is its own clock wake: its refetch is its own batch, and its waiting value
        // and its result are their own flushes and messages. Only results that land in one flush share one.
        assert.deepStrictEqual(app.db.batches, [3, 1, 1, 1])
        assert.deepStrictEqual(updates(app.order), [
          "update a [1:Ann…]",
          "update a [2:Bea…]",
          "update a [3:Cy…]",
          "update a [1:Ann2]",
          "update a [2:Bea]",
          "update a [3:Cy2]"
        ])
      })
    )
  })

  it.effect("a resolver with a longer delay batches the N cold keys of one pass into one runAll and one message", () => {
    const app = makeApp({ delay: "50 millis" })
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Board, {
          tag: "a",
          ids: ["1", "2", "9"]
        })
        yield* TestHost.settle
        yield* TestClock.adjust("10 millis")
        assert.strictEqual(root.text(), "a: 1=… 2=… 9=…")
        assert.deepStrictEqual(app.db.batches, [])
        yield* TestClock.adjust("40 millis")
        // The window has closed: one runAll of three is running.
        assert.deepStrictEqual(app.db.batches, [])
        yield* load
        assert.deepStrictEqual(app.db.batches, [3])
        // Three FetchStarted for one request.
        assert.strictEqual(root.fetches().length, 3)
        assert.strictEqual(root.text(), "a: 1=Ann 2=Bea 9=failed")
        assert.deepStrictEqual(updates(app.order), [
          "update a [1:Ann,2:Bea,9:failed]"
        ])
      })
    )
  })

  it.effect("an optimistic patch on one key reaches a second keyed field before the flush that renders the issuing update", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.List, {
          boards: ["a:1,2", "b:2,1"]
        })
        yield* load
        app.order.length = 0
        const before = root.frames().length
        Locator.fire(
          root.get(Locator.text("a: 1=Ann 2=Bea", { exact: true })),
          "click"
        )
        yield* TestHost.settle
        assert.deepStrictEqual(app.order, [
          "update a Rename",
          "update a [1:Boba]",
          "update b [1:Boba]",
          "view a 1=Boba~ 2=Bea",
          "view b 2=Bea 1=Boba~"
        ])
        // One frame, with both fields patched.
        assert.deepStrictEqual(root.frames().slice(before), [
          "a: 1=Boba~ 2=Beab: 2=Bea 1=Boba~"
        ])
      })
    )
  })

  it.effect("two patches issued before one flush are one message per field, in that flush's frame", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.List, {
          boards: ["a:1,2", "b:2,1"]
        })
        yield* load
        app.order.length = 0
        const before = root.frames().length
        Locator.fire(
          root.get(Locator.text("a: 1=Ann 2=Bea", { exact: true })),
          "click"
        )
        Locator.fire(
          root.get(Locator.text("b: 2=Bea 1=Ann", { exact: true })),
          "click"
        )
        yield* TestHost.settle
        assert.deepStrictEqual(app.order, [
          "update a Rename",
          "update b Rename",
          "update a [1:Bobb]",
          "update b [1:Bobb]",
          "view a 1=Bobb~ 2=Bea",
          "view b 2=Bea 1=Bobb~"
        ])
        assert.deepStrictEqual(root.frames().slice(before), [
          "a: 1=Bobb~ 2=Beab: 2=Bea 1=Bobb~"
        ])
      })
    )
  })

  it.effect("a single field over a key of the batch doesn't split the keyed field's message", () => {
    const app = makeApp()
    const Message = UiSchema.TaggedEnum({
      UsersChanged: { changed: Schema.Array(Schema.String) }
    })
    const changed: Array<ReadonlyArray<string>> = []
    const Mixed = Component.define({
      name: "Mixed",
      model: Schema.Struct({}),
      message: Message,
      queries: {
        users: {
          queryMany: app.GetUser,
          args: () => [{ id: "1" }, { id: "2" }, { id: "3" }],
          onChange: (_loaded, changes) =>
            Message.UsersChanged({
              changed: changes.map((change) => change.args.id)
            })
        },
        user: { query: app.GetUser, args: () => ({ id: "1" }) }
      }
    }).make({
      init: () => ({}),
      update: ($, { changed: keys }) => {
        changed.push(keys)
        return $.model
      },
      view: (h) =>
        h.el(
          "p",
          h.queries.users.map(({ result }) =>
            AsyncResult.isSuccess(result) ? "y" : "n"
          ).join("") +
            (AsyncResult.isSuccess(h.queries.user) ? "+" : "-")
        )
    })
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(Mixed, {})
        yield* load
        assert.deepStrictEqual(app.db.batches, [3])
        assert.deepStrictEqual(changed, [["1", "2", "3"]])
        assert.strictEqual(root.text(), "yyy+")
      })
    )
  })

  it.effect("a defect on one key fails the instance holding the field, and not one sharing its batch", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.List, {
          boards: ["a:1,boom", "b:1,2"]
        })
        yield* load
        assert.deepStrictEqual(app.db.batches, [3])
        assert.strictEqual(root.text(), "b: 1=Ann 2=Bea")
        const failed = root.log().find((entry): entry is MessageLog.Failed =>
          entry._tag === "Failed"
        )
        assert.deepStrictEqual([failed?.path, failed?.in, failed?.name], [
          "/List/Board[a]",
          "subscription",
          `~query/users:${JSON.stringify(JSON.stringify({ id: "boom" }))}`
        ])
      })
    )
  })

  it.effect("an empty array is disabled: no fetch, no message, and an empty view", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Board, { tag: "a", ids: [] })
        yield* load
        assert.strictEqual(root.text(), "a: ")
        assert.deepStrictEqual(root.fetches(), [])
        assert.deepStrictEqual(updates(app.order), [])
      })
    )
  })

  it.effect("get finds one entry by its args", () => {
    const app = makeApp()
    const Probe = Component.define({
      name: "Probe",
      model: Schema.Struct({}),
      message: Schema.Never,
      queries: {
        users: {
          queryMany: app.GetUser,
          args: () => [{ id: "2" }, { id: "1" }]
        }
      }
    }).make({
      init: () => ({}),
      update: ($) => $.model,
      view: (h) => {
        const one = h.queries.users.get({ id: "1" })
        const name = Option.match(one, {
          onNone: () => "none",
          onSome: ({ result }) =>
            AsyncResult.isSuccess(result) ? result.value.name : "…"
        })
        return h.el(
          "p",
          `${name} ${Option.isNone(h.queries.users.get({ id: "3" }))}`
        )
      }
    })
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(Probe, {})
        assert.strictEqual(root.text(), "… true")
        yield* load
        assert.strictEqual(root.text(), "Ann true")
      })
    )
  })
})

describe("Keyed results", () => {
  it.effect("encode to the single form's tuples, and a duplicate args key fails to decode", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Board, {
          tag: "a",
          ids: ["1", "9"]
        })
        yield* load
        const result = resultOf(root.log(), "/Board", "users")
        const encoded = tuples(app.Board, "users", result)
        assert.deepStrictEqual(encoded, [
          ["{\"id\":\"1\"}", 0, { id: "1", name: "Ann" }, 10, false],
          ["{\"id\":\"9\"}", 1, ["missing"], null]
        ])
        // The log's Wire writes the same tuples, each ending with [waiting, more] for a replayed update.
        const changed = [...root.log()].reverse().find((entry) =>
          entry._tag === "QueryChanged"
        )!
        assert.deepStrictEqual(
          (MessageLog.makeEncoder().encode(changed) as {
            readonly result?: unknown
          }).result,
          encoded.map((tuple) => [...tuple, [false, null]])
        )
        const decode = Schema.decodeUnknownExit(resultCodec(app.Board, "users"))
        assert.isTrue(Exit.isSuccess(decode(encoded)))
        assert.isTrue(Exit.isFailure(decode([encoded[0], encoded[0]])))
        assert.isTrue(Exit.isFailure(decode([[]])))
      })
    )
  })

  it("throws at make for a keyed entry that isn't { queryMany, args }", () => {
    const app = makeApp()
    const make = (users: unknown) =>
      Component.define({
        name: "Bad",
        model: Schema.Struct({}),
        message: Schema.Never,
        queries: { users }
      } as any).make({
        init: () => ({}),
        update: ($: { readonly model: unknown }) => $.model,
        view: () => null as never
      } as any)
    assert.throws(
      () =>
        make({ query: app.GetUser, queryMany: app.GetUser, args: () => [] }),
      /Bad: queries.users must have exactly one of query and queryMany/
    )
    assert.throws(
      () => make({ queryMany: {}, args: () => [] }),
      /Bad: queries.users has a queryMany that isn't a Query/
    )
    assert.throws(
      () => make({ queryMany: app.GetUser }),
      /Bad: queries.users must have an args function/
    )
    assert.throws(
      () => make({ queryMany: app.GetUser, args: () => [], onChange: 1 }),
      /Bad: queries.users has an onChange that isn't a function/
    )
  })

  it.effect("fails the instance when its queryMany query's args don't return an array", () => {
    const app = makeApp()
    const Bad = Component.define({
      name: "Bad",
      model: Schema.Struct({}),
      message: Schema.Never,
      queries: {
        users: {
          queryMany: app.GetUser,
          args: () => (({
            id: "1"
          }) as any)
        }
      }
    }).make({
      init: () => ({}),
      update: ($) => $.model,
      view: (h) => h.el("p", "x")
    })
    const Host = Component.define({
      name: "Host",
      model: Schema.Struct({}),
      message: Schema.Never
    }).make({
      init: () => ({}),
      update: ($) => $.model,
      view: (h) =>
        h.el("div", Bad(h, { key: "bad", props: {} }), h.el("p", "host"))
    })
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(Host, {})
        yield* TestHost.settle
        assert.strictEqual(root.text(), "host")
        const failed = root.log().find((entry): entry is MessageLog.Failed =>
          entry._tag === "Failed"
        )
        assert.deepStrictEqual([failed?.path, failed?.in], [
          "/Host/Bad[bad]",
          "subscription"
        ])
        assert.include(
          TestHost.formatLog(root.log()),
          "is a queryMany query, and its args must return an array"
        )
      })
    )
  })
})

describe("Keyed redaction", () => {
  it.effect("Schema.Redacted in a keyed query's args and success: the log is redacted, the state is not", () => {
    const Account = Schema.Struct({ secret: Schema.Redacted(Schema.String) })
    class GetAccount extends Query.Service<GetAccount>()(
      "accounts/GetAccount",
      {
        args: { token: Schema.Redacted(Schema.String) },
        success: Account,
        error: Schema.Never,
        staleTime: "30 seconds"
      }
    ) {
      static readonly layer = this.toLayer(({ token }) =>
        Effect.succeed({
          secret: Redacted.make(`secret-of-${Redacted.value(token)}`)
        })
      )
    }
    const Page = Component.define({
      name: "Page",
      props: Schema.Struct({
        tokens: Schema.Array(Schema.Redacted(Schema.String))
      }),
      model: Schema.Struct({}),
      message: Schema.Never,
      queries: {
        accounts: {
          queryMany: GetAccount,
          args: ({ props }) => props.tokens.map((token) => ({ token }))
        }
      }
    }).make({
      init: () => ({}),
      update: ($) => $.model,
      view: (h) =>
        h.el(
          "p",
          h.queries.accounts.map(({ result }) =>
            AsyncResult.isSuccess(result)
              ? Redacted.value(result.value.secret)
              : "…"
          )
            .join(" ")
        )
    })
    return run(
      GetAccount.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(Page, {
          tokens: [Redacted.make("tok-1"), Redacted.make("tok-2")]
        })
        yield* TestHost.settle
        assert.strictEqual(root.text(), "secret-of-tok-1 secret-of-tok-2")
        // The result as page state and history state hold it.
        const state = JSON.stringify(
          tuples(Page, "accounts", resultOf(root.log(), "/Page", "accounts"))
        )
        assert.include(state, "tok-2")
        assert.include(state, "secret-of-tok-2")
        const wire = JSON.stringify(
          root.log().map((entry) => MessageLog.makeEncoder().encode(entry))
        )
        assert.notInclude(wire, "tok-")
        assert.notInclude(wire, "secret-of")
        assert.include(wire, "FetchStarted")
        assert.include(wire, "QueryChanged")
        assert.notInclude(TestHost.formatLog(root.log()), "tok-")
      })
    )
  })
})

describe("Story keyed steps", () => {
  it.effect("loads keys one at a time or many in one write, and writes the prune itself", () =>
    Effect.gen(function*() {
      const app = makeApp()
      const scene = yield* Scene.make(app.Board, { tag: "a", ids: ["1", "2"] })
      scene
        .loadedMany("users", [{
          args: { id: "1" },
          value: { id: "1", name: "Ann" }
        }, {
          args: { id: "2" },
          error: "gone"
        }])
        .expect(Locator.tag("p")).toHaveText("a: 1=Ann 2=failed")
        .loaded("users", { id: "2" }, { id: "2", name: "Bea" }, {
          patched: true
        })
        .expect(Locator.tag("p")).toHaveText("a: 1=Ann 2=Bea~")
      app.order.length = 0
      const story = yield* Story.make(app.Board, { tag: "a", ids: ["1", "2"] })
      story
        .loadedMany("users", [{
          args: { id: "1" },
          value: { id: "1", name: "Ann" }
        }, {
          args: { id: "2" },
          error: "gone"
        }])
        .loaded("users", { id: "2" }, { id: "2", name: "Bea" }, {
          patched: true
        })
        .loadFailed("users", { id: "1" }, "gone", { waiting: true })
      const [ann] = tuples(app.Board, "users", story.results?.users)
      // The failure keeps the key's last Success.
      assert.deepStrictEqual(ann, ["{\"id\":\"1\"}", 1, ["gone"], [{
        id: "1",
        name: "Ann"
      }, 0]])
      story.send(app.BoardMessage.Show({ ids: ["2"] }))
      assert.deepStrictEqual(heldIds(app.Board, story.results?.users), ["2"])
      assert.deepStrictEqual(updates(app.order), [
        "update a [1:Ann,2:failed]",
        "update a [2:Bea]",
        "update a [1:failed]",
        "update a []"
      ])
      const started = Story.start(app.Board, { tag: "a", ids: ["1"] })
      assert.throws(
        () => started.loaded("users", { id: "5" }, { id: "5", name: "E" }),
        /doesn't return the args/
      )
    }))

  it.effect("writes a prune once per lost key set, as the runtime does", () =>
    Effect.gen(function*() {
      const app = makeApp()
      const story = yield* Story.make(app.Board, {
        tag: "a",
        ids: ["1", "2", "3"]
      })
      story
        .loadedMany("users", [
          { args: { id: "1" }, value: { id: "1", name: "Ann" } },
          { args: { id: "2" }, value: { id: "2", name: "Bea" } },
          { args: { id: "3" }, value: { id: "3", name: "Cy" } }
        ])
        .send(app.BoardMessage.Show({ ids: ["1", "3"] }))
        .send(app.BoardMessage.Show({ ids: ["3", "1"] }))
        .loaded("users", { id: "1" }, { id: "1", name: "Al" })
        .send(app.BoardMessage.Show({ ids: ["1"] }))
      assert.deepStrictEqual(heldIds(app.Board, story.results?.users), ["1"])
      assert.deepStrictEqual(updates(app.order), [
        "update a [1:Ann,2:Bea,3:Cy]",
        "update a []",
        "update a [1:Al]",
        "update a []"
      ])
    }))
})

/**
 * A selected row that must be in the collection: the view throws otherwise. A prune's `onChange`
 * sends a message whose `update` checks `$.queries` for the selection, and moves it to the first id.
 */
const makeSelection = (app: ReturnType<typeof makeApp>) => {
  const Message = UiSchema.TaggedEnum({
    Show: { ids: Schema.Array(Schema.String) },
    UsersChanged: {}
  })
  const Selection = Component.define({
    name: "Selection",
    model: Schema.Struct({
      ids: Schema.Array(Schema.String),
      selected: Schema.String
    }),
    message: Message,
    queries: {
      users: {
        queryMany: app.GetUser,
        args: ({ model }) => model.ids.map((id) => ({ id })),
        onChange: () => Message.UsersChanged()
      }
    }
  }).make({
    init: () => ({ ids: ["1", "2"], selected: "2" }),
    update: ($, message) =>
      Message.match(message, {
        Show: ({ ids }) => ({ ...$.model, ids }),
        UsersChanged: () =>
          Option.isSome($.queries.users.get({ id: $.model.selected }))
            ? $.model
            : { ...$.model, selected: $.model.ids[0] }
      }),
    view: (h, model) => {
      const row = h.queries.users.get({ id: model.selected })
      if (Option.isNone(row)) {
        throw new Error(`no row for the selection ${model.selected}`)
      }
      const result = row.value.result
      // A click shows the first id only, so a scene can make the change.
      return h.el("p").on("click", Message.Show({ ids: ["1"] })).children(
        AsyncResult.isSuccess(result) ? result.value.name : "…"
      )
    }
  })
  return { Message, Selection }
}

describe("Keyed selection repaired by the prune handler", () => {
  it.effect("the runtime never renders the selection outside the collection", () => {
    const app = makeApp()
    const { Message, Selection } = makeSelection(app)
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(Selection, {})
        yield* load
        assert.strictEqual(root.text(), "Bea")
        root.send(Message.Show({ ids: ["1"] }))
        yield* TestHost.settle
        assert.strictEqual(root.text(), "Ann")
        assert.isUndefined(root.log().find((entry) => entry._tag === "Failed"))
      })
    )
  })

  it.effect("Scene renders the step once its prunes have settled, as the runtime does", () =>
    Effect.gen(function*() {
      const app = makeApp()
      const { Message, Selection } = makeSelection(app)
      const loadBoth = <S extends Steps.Steps.Any>(s: S): S =>
        s.loadedMany("users", [
          { args: { id: "1" }, value: { id: "1", name: "Ann" } },
          { args: { id: "2" }, value: { id: "2", name: "Bea" } }
        ])
      const scene = yield* Scene.make(Selection, {})
      scene.pipe(loadBoth)
        .expect(Locator.tag("p")).toHaveText("Bea")
        .click("Bea")
        .expect(Locator.tag("p")).toHaveText("Ann")
      const story = yield* Story.make(Selection, {})
      story.pipe(loadBoth)
        .send(Message.Show({ ids: ["1"] }))
      assert.deepStrictEqual(heldIds(Selection, story.results?.users), ["1"])
    }))
})

describe("Story keyed rounds", () => {
  it.effect("sends a prune whose update prunes again in a second round, as the runtime does", () =>
    Effect.gen(function*() {
      const app = makeApp({ pruneTrims: true })
      const story = yield* Story.make(app.Board, {
        tag: "a",
        ids: ["1", "2", "3"]
      })
      story
        .loadedMany("users", [
          { args: { id: "1" }, value: { id: "1", name: "Ann" } },
          { args: { id: "2" }, value: { id: "2", name: "Bea" } },
          { args: { id: "3" }, value: { id: "3", name: "Cy" } }
        ])
        .send(app.BoardMessage.Show({ ids: ["1", "2"] }))
      assert.deepStrictEqual(heldIds(app.Board, story.results?.users), ["1"])
      assert.deepStrictEqual(updates(app.order), [
        "update a [1:Ann,2:Bea,3:Cy]",
        "update a []",
        "update a []"
      ])
    }))

  it("throws when a step's prunes don't settle in 100 rounds", () => {
    const app = makeApp({ pruneDrops: true })
    // Each prune's update drops one more id, so 103 held keys take more than 100 rounds to settle.
    const ids = Array.from({ length: 103 }, (_, i) => String(i))
    const story = Story.start(app.Board, { tag: "a", ids })
    assert.throws(
      () =>
        story
          .loadedMany(
            "users",
            ids.map((id) => ({ args: { id }, value: { id, name: id } }))
          )
          .send(app.BoardMessage.Show({ ids: ids.slice(0, -1) })),
      /Board's query "users" was still pruned after 100 rounds .* without limit/
    )
    assert.strictEqual(updates(app.order).length, 101)
  })
})

describe("Keyed history restore", () => {
  it.effect("a membership change and a push in one update save the pruned collection in the entry left", () => {
    const app = makeApp()
    const PageRoute = Route.union({
      Home: Route.make("/"),
      Next: Route.make("/next")
    })
    const Message = UiSchema.TaggedEnum({
      ShowAndGo: { ids: Schema.Array(Schema.String) },
      Navigated: {}
    })
    const Page = Component.define({
      name: "Page",
      model: Schema.Struct({ ids: Schema.Array(Schema.String) }),
      message: Message,
      queries: {
        users: {
          queryMany: app.GetUser,
          args: ({ model }) => model.ids.map((id) => ({ id }))
        }
      }
    }).make({
      init: () => ({ ids: ["1", "2"] }),
      update: ($, message) =>
        Message.match(message, {
          ShowAndGo: ({ ids }) =>
            $.set({ ...$.model, ids }).run(
              Router.push(PageRoute, PageRoute.Next()).pipe(
                Command.map(() => Message.Navigated())
              )
            ),
          Navigated: () => $.model
        }),
      view: (h) =>
        h.el("p", h.queries.users.map(({ args }) => args.id).join(","))
    })
    const base = Router.memoryHistory("/")
    const written: Array<{ readonly url: string; readonly state: unknown }> = []
    const history: Router.History = {
      ...base,
      replace: (url, state) => {
        written.push({ url, state })
        base.replace(url, state)
      }
    }
    return Effect.gen(function*() {
      const root = yield* TestHost.mount(Page, {})
      yield* load
      root.send(Message.ShowAndGo({ ids: ["1"] }))
      yield* TestHost.settle
      assert.deepStrictEqual(base.entries(), ["/", "/next"])
      const home = written.filter((entry) => entry.url === "/")
      const left = home[home.length - 1]?.state as
        | {
          readonly "@effect/ui": {
            readonly snapshot: Record<string, {
              readonly model: unknown
              readonly queries: {
                readonly users: ReadonlyArray<ReadonlyArray<unknown>>
              }
            }>
          }
        }
        | undefined
      const saved = left?.["@effect/ui"].snapshot["/Page"]
      assert.deepStrictEqual(saved?.model, { ids: ["1"] })
      assert.deepStrictEqual(saved?.queries.users.map((tuple) => tuple[0]), [
        "{\"id\":\"1\"}"
      ])
      assert.strictEqual(root.text(), "1")
    }).pipe(
      Effect.provide(
        Layer.merge(Router.make({ routes: PageRoute, history }), app.layer)
      ),
      Effect.scoped,
      Effect.provide(TestHost.layer())
    )
  })

  it.effect("drops each tuple taken under a patch and seeds the rest, stale", () => {
    const app = makeApp()
    const ShellRoute = Route.union({
      Home: Route.make("/"),
      Board: Route.make("/board")
    })
    const ShellMessage = UiSchema.TaggedEnum({
      ChangedRoute: { route: ShellRoute },
      Go: { route: ShellRoute },
      Navigated: {}
    })
    const Shell = Component.define({
      name: "Shell",
      props: Schema.Struct({ route: ShellRoute }),
      model: ShellRoute,
      message: ShellMessage
    }).make({
      init: ($) => $.props.route,
      update: ($, message) =>
        ShellMessage.match(message, {
          ChangedRoute: ({ route }) => route,
          Go: ({ route }) =>
            $.run(
              Router.push(ShellRoute, route).pipe(
                Command.map(() => ShellMessage.Navigated())
              )
            ),
          Navigated: () => $.model
        }),
      subscriptions: ({ model }) => [
        Router.subscription(
          ShellRoute,
          model,
          (route) => ShellMessage.ChangedRoute({ route })
        )
      ],
      view: (h, model) =>
        h.el(
          "div",
          h.el("button").on(
            "click",
            ShellMessage.Go({ route: ShellRoute.Home() })
          ).children("Home"),
          model._tag === "Board"
            ? app.Board(h, {
              key: "board",
              props: { tag: "a", ids: ["1", "2"] }
            })
            : h.el("p", "home")
        )
    })
    const history = Router.memoryHistory("/board")
    const mount = Effect.flatMap(
      Router.currentRoute(ShellRoute),
      (route) => TestHost.mount(Shell, { route })
    )
    const hosted = (
      router: Layer.Layer<Router.Services>,
      effect: Effect.Effect<void, unknown, any>
    ) =>
      effect.pipe(
        Effect.provide(Layer.merge(router, app.layer)),
        Effect.scoped,
        Effect.provide(TestHost.layer())
      )
    return Effect.gen(function*() {
      yield* hosted(
        Router.make({ routes: ShellRoute, history }),
        Effect.gen(function*() {
          const root = yield* mount
          yield* load
          // The rename never finishes, so its patch on key 1 is live when the push snapshots the page.
          Locator.fire(
            root.get(Locator.text("a: 1=Ann 2=Bea", { exact: true })),
            "click"
          )
          yield* TestHost.settle
          assert.isTrue(root.text().includes("1=Boba~"))
          Locator.fire(root.get(Locator.text("Home", { exact: true })), "click")
          yield* TestHost.settle
        })
      )
      const calls = app.db.calls
      yield* hosted(
        Router.make({ routes: ShellRoute, history }),
        Effect.gen(function*() {
          const root = yield* mount
          yield* TestHost.settle
          history.go(-1)
          yield* TestHost.settle
          const log = root.log()
          const mounted = log.findIndex((entry) =>
            entry._tag === "Mounted" && entry.path === "/Shell/Board[board]"
          )
          const restored = log[mounted] as MessageLog.Mounted
          assert.isTrue(restored.adopted)
          // Mounted holds the restored results.
          assert.deepStrictEqual(heldIds(app.Board, restored.queries?.users), [
            "2"
          ])
          // Key 2 is seeded stale and shows while it refetches; key 1 starts from loading.
          assert.isTrue(root.text().includes("a: 1=… 2=Bea…"))
          yield* load
          assert.isTrue(root.text().includes("a: 1=Ann 2=Bea"))
          assert.strictEqual(app.db.calls - calls, 2)
        })
      )
    })
  })
})
