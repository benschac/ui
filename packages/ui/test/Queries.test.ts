// @vitest-environment happy-dom
import {
  Command,
  Head,
  MessageLog,
  Query,
  Route,
  Router,
  UiSchema
} from "@effect/ui"
import { Html } from "@effect/ui/html"
import { ssr } from "@effect/ui/html/testing"
import { Locator, Story, TestHost } from "@effect/ui/testing"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { TestClock } from "effect/testing"

/**
 * A component with one query and no `onChange`: the runtime writes the
 * query's result, the view shows it, and `update` reads it through
 * `$.queries`. Fresh per test: the fetch count is closed over.
 */
const makeApp = () => {
  const server = { calls: 0 }

  class GetNote extends Query.Service<GetNote>()(
    "notes/GetNote",
    {
      args: { id: Schema.String },
      success: Schema.String,
      error: Schema.Never,
      staleTime: "30 seconds"
    }
  ) {
    static readonly layer = this.toLayer(({ id }) =>
      Effect.sleep("10 millis").pipe(Effect.map(() => {
        server.calls++
        return `Note ${id}`
      }))
    )
  }

  // Invalidates the note, so the query refetches it while it keeps the old value.
  class Touch extends Command.Service<Touch>()(
    "notes/Touch",
    {
      args: { id: Schema.String },
      success: Schema.Void,
      error: Schema.Never,
      invalidates: ({ id }) => [GetNote.entry({ id })]
    }
  ) {
    static readonly layer = this.toLayer(() => Effect.void)
  }

  const NoteMessage = UiSchema.TaggedEnum({ Click: {}, Touch: {}, Touched: {} })
  const touched = NoteMessage.Touched()
  const Note = Html.component({
    name: "Note",
    props: Schema.Struct({ id: Schema.String }),
    model: Schema.Struct({ clicks: Schema.Number, last: Schema.String }),
    message: NoteMessage,
    queries: {
      // An empty id disables the query.
      note: {
        query: GetNote,
        args: ({ props }) => props.id === "" ? undefined : { id: props.id }
      }
    }
  }).make({
    init: () => ({ clicks: 0, last: "none" }),
    // What the query holds when the click is handled, so a replay only reproduces it with the results.
    update: ($, message) =>
      NoteMessage.match(message, {
        Click: () => ({
          clicks: $.model.clicks + 1,
          last: AsyncResult.isSuccess($.queries.note)
            ? $.queries.note.value +
              ($.queries.note.waiting ? " (waiting)" : "")
            : "none"
        }),
        Touch: () =>
          $.run(
            Touch.make({ id: $.props.id }).pipe(Command.as(touched))
          ),
        Touched: () => $.model
      }),
    head: (
      { queries }
    ) => [
      Head.title(
        AsyncResult.isSuccess(queries.note) ? queries.note.value : "Note"
      )
    ],
    view: (h, model) =>
      h.div(
        h.p(AsyncResult.match(h.queries.note, {
          onInitial: () => "loading",
          onSuccess: ({ value }) => value,
          onFailure: () => "failed"
        })),
        h.button.on("click", NoteMessage.Click()).children(
          `clicks ${model.clicks}`
        )
      )
  })

  const AppRoute = Route.union({
    Home: Route.make("/"),
    Note: Route.make("/notes/:id", { params: { id: Schema.String } })
  })
  const AppMessage = UiSchema.TaggedEnum({ RouteChanged: { route: AppRoute } })
  const App = Html.component({
    name: "App",
    props: Schema.Struct({ route: AppRoute }),
    model: AppRoute,
    message: AppMessage
  }).make({
    init: ($) => $.props.route,
    update: (_, message) => message.route,
    subscriptions: ({ model: route }) => [
      Router.subscription(
        AppRoute,
        route,
        (next) => AppMessage.RouteChanged({ route: next })
      )
    ],
    view: (h, route) =>
      h.main(AppRoute.match(route, {
        Home: () => h.h1("Home"),
        Note: (note) =>
          Note(h, { key: AppRoute.print(note), props: { id: note.params.id } })
      }))
  })

  // Passes its id to one Note under a fixed key, so a new id is new props, not a re-key.
  const ShellMessage = UiSchema.TaggedEnum({ SetId: { id: Schema.String } })
  const Shell = Html.component({
    name: "Shell",
    model: Schema.String,
    message: ShellMessage
  }).make({
    init: () => "1",
    update: (_, message) => message.id,
    view: (h, id) => h.div(Note(h, { key: "note", props: { id } }))
  })
  const setId = (id: string) => ShellMessage.SetId({ id })

  return {
    server,
    GetNote,
    Touch,
    Shell,
    setId,
    layer: Layer.mergeAll(GetNote.layer, Touch.layer),
    Note,
    NoteMessage,
    AppRoute,
    App
  }
}

const click = (root: TestHost.TestRoot<any, any, any>, text: string) =>
  Locator.fire(root.get(Locator.text(text, { exact: true })), "click")

/** Runs a block on a fresh TestHost, so each run has its own query cache. */
const run = <A, E>(layer: Layer.Layer<any>, effect: Effect.Effect<A, E, any>) =>
  effect.pipe(
    Effect.provide(layer),
    Effect.scoped,
    Effect.provide(TestHost.layer())
  ) as Effect.Effect<A, E>

/** Starts what is due and lets the fetches finish: the fetcher sleeps 10 ms. */
const load = TestHost.settle.pipe(
  Effect.andThen(TestClock.adjust("10 millis")),
  Effect.andThen(TestHost.settle)
)

const queryChanges = (log: ReadonlyArray<MessageLog.Entry>, path: string) =>
  log.filter((entry): entry is MessageLog.QueryChanged =>
    entry._tag === "QueryChanged" && entry.path === path
  )

/** The note a replay ends with, as `h.queries.note` would show it. */
const noteOf = (replay: Story.Replay<any, any, any>) => {
  const note = replay.queries().note as AsyncResult.AsyncResult<string, never>
  return AsyncResult.isSuccess(note) ? note.value : note._tag
}

/** The Note's Mounted entry, for its path under a parent. */
const noteMount = (log: ReadonlyArray<MessageLog.Entry>) =>
  log.find((entry): entry is MessageLog.Mounted =>
    entry._tag === "Mounted" && entry.component.definition.name === "Note"
  )!

const updates = (log: ReadonlyArray<MessageLog.Entry>, path: string) =>
  log.filter((entry): entry is MessageLog.Update =>
    entry._tag === "Update" && entry.path === path
  )

describe("a query without onChange", { concurrent: false }, () => {
  it.effect("renders the loaded value, and update reads it through $.queries", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Note, { id: "1" })
        assert.strictEqual(root.text(), "loadingclicks 0")
        yield* load
        assert.strictEqual(root.text(), "Note 1clicks 0")
        assert.strictEqual(app.server.calls, 1)
        // The result is written by the runtime: one QueryChanged entry holding the Success, and no update.
        assert.deepStrictEqual(
          queryChanges(root.log(), "/Note").map((entry) => [
            entry.name,
            entry.component.definition.name,
            Query.snapshotData(entry.result)?.result?._tag
          ]),
          [["note", "Note", "Success"]]
        )
        assert.deepStrictEqual(updates(root.log(), "/Note"), [])
        click(root, "clicks 0")
        yield* TestHost.settle
        assert.deepStrictEqual(root.model(), { clicks: 1, last: "Note 1" })
        assert.strictEqual(root.text(), "Note 1clicks 1")
      })
    )
  })

  it.effect("hydrates the server's { model, queries } state without refetching", () => {
    const app = makeApp()
    return Effect.gen(function*() {
      const result = yield* ssr(app.Note, { id: "1" })
      // The page state of a component with queries: its Model and its results, a result as its snapshot tuple.
      const state = result.state["/Note"] as {
        readonly model: unknown
        readonly queries: { readonly note: ReadonlyArray<unknown> }
      }
      assert.deepStrictEqual(Object.keys(state).sort(), ["model", "queries"])
      assert.deepStrictEqual(state.model, { clicks: 0, last: "none" })
      assert.deepStrictEqual(Object.keys(state.queries), ["note"])
      assert.deepStrictEqual(state.queries.note, [`{"id":"1"}`, 2])
      assert.deepStrictEqual(result.adopted, ["/Note"])
      // Only the server fetched.
      assert.deepStrictEqual(result.root.fetches(), [])
      assert.strictEqual(app.server.calls, 1)
      assert.strictEqual(result.container.textContent, "Note 1clicks 0")
      // Mounted holds the hydrated results, so a replay from it alone has the note. The watch's first value
      // equals it, so it isn't written again.
      const index = result.log.findIndex((entry) =>
        entry._tag === "Mounted" && entry.path === "/Note"
      )
      assert.isTrue((result.log[index] as MessageLog.Mounted).adopted)
      assert.strictEqual(
        noteOf(Story.fromLog(app.Note, result.log.slice(index, index + 1))),
        "Note 1"
      )
      assert.strictEqual(queryChanges(result.log, "/Note").length, 0)
      assert.deepStrictEqual(updates(result.log, "/Note"), [])
      // update sees the hydrated result.
      result.root.send(app.NoteMessage.Click())
      yield* TestHost.settle
      assert.deepStrictEqual(result.root.model(), { clicks: 1, last: "Note 1" })
      assert.strictEqual(app.server.calls, 1)
    }).pipe(
      Effect.provide(app.layer),
      Effect.scoped,
      Effect.provide(TestHost.layer())
    ) as Effect.Effect<void, unknown>
  })

  it.effect("restores the Model and result from history.state, seeding the cold cache, and refetches once", () => {
    const app = makeApp()
    const history = Router.memoryHistory("/notes/1")
    const path = "/App/Note[/notes/1]"
    const mount = TestHost.mount(app.App, Router.props(app.AppRoute))
    const routed = <E>(effect: Effect.Effect<void, E, any>) =>
      run(
        Router.make({ routes: app.AppRoute, history }),
        effect.pipe(Effect.provide(app.layer))
      )
    return Effect.gen(function*() {
      yield* routed(Effect.gen(function*() {
        const root = yield* mount
        yield* load
        click(root, "clicks 0")
        yield* TestHost.settle
        assert.strictEqual(root.text(), "Note 1clicks 1")
        // Leaving by a push writes the saved state into the entry being left.
        const router = yield* Router.Router
        yield* router.navigate("/")
        yield* TestHost.settle
        assert.strictEqual(root.text(), "Home")
      }))
      assert.strictEqual(app.server.calls, 1)

      // The entry's history.state holds the instance's { model, queries }.
      history.go(-1)
      const saved = Object.values(
        history.current().state as Record<string, { readonly snapshot: any }>
      )[0]
        .snapshot[path]
      assert.deepStrictEqual(saved.model, { clicks: 1, last: "Note 1" })
      assert.deepStrictEqual(saved.queries.note.slice(0, 3), [
        `{"id":"1"}`,
        0,
        "Note 1"
      ])
      history.go(1)

      // As after a reload: a new Router and a cold cache, then back.
      yield* routed(Effect.gen(function*() {
        const root = yield* mount
        yield* TestHost.settle
        history.go(-1)
        yield* TestHost.settle
        // The restored result shows at once, stale, while one refetch runs.
        assert.strictEqual(root.text(), "Note 1clicks 1")
        const log = root.log()
        const index = log.findIndex((entry) =>
          entry._tag === "Mounted" && entry.path === path
        )
        assert.isTrue((log[index] as MessageLog.Mounted).adopted)
        // Mounted holds the restored results.
        assert.strictEqual(
          noteOf(Story.fromLog(app.Note, log.slice(index, index + 1))),
          "Note 1"
        )
        assert.strictEqual(
          root.entry(app.GetNote, { id: "1" })?.fetch,
          "running"
        )
        yield* TestClock.adjust("10 millis")
        yield* TestHost.settle
        assert.deepStrictEqual(
          root.fetches().map((fetch) => [fetch.query, fetch.trigger]),
          [[
            "notes/GetNote",
            "watch"
          ]]
        )
        assert.strictEqual(app.server.calls, 2)
        assert.strictEqual(root.text(), "Note 1clicks 1")
        assert.deepStrictEqual(updates(log, path), [])
        click(root, "clicks 1")
        yield* TestHost.settle
        assert.strictEqual(root.text(), "Note 1clicks 2")
      }))
    })
  })

  it.effect("drops history.state saved as { model, loaded }, rerunning init and fetching afresh", () => {
    const app = makeApp()
    const history = Router.memoryHistory("/notes/1")
    const path = "/App/Note[/notes/1]"
    const mount = TestHost.mount(app.App, Router.props(app.AppRoute))
    const routed = <E>(effect: Effect.Effect<void, E, any>) =>
      run(
        Router.make({ routes: app.AppRoute, history }),
        effect.pipe(Effect.provide(app.layer))
      )
    return Effect.gen(function*() {
      yield* routed(Effect.gen(function*() {
        const root = yield* mount
        yield* load
        click(root, "clicks 0")
        yield* TestHost.settle
        const router = yield* Router.Router
        yield* router.navigate("/")
        yield* TestHost.settle
      }))
      assert.strictEqual(app.server.calls, 1)

      // Rewrite the saved entry in the format written before the rename to Query.
      history.go(-1)
      const snapshot = Object.values(
        history.current().state as Record<string, { readonly snapshot: any }>
      )[0]
        .snapshot
      const saved = snapshot[path]
      snapshot[path] = { model: saved.model, loaded: saved.queries }
      history.go(1)

      yield* routed(Effect.gen(function*() {
        const root = yield* mount
        yield* TestHost.settle
        history.go(-1)
        yield* TestHost.settle
        // The whole state fails to decode, so the saved Model is lost along with the result.
        const log = root.log()
        const index = log.findIndex((entry) =>
          entry._tag === "Mounted" && entry.path === path
        )
        assert.isFalse((log[index] as MessageLog.Mounted).adopted)
        assert.notStrictEqual(log[index + 1]?._tag, "QueryChanged")
        assert.strictEqual(root.text(), "loadingclicks 0")
        yield* TestClock.adjust("10 millis")
        yield* TestHost.settle
        assert.strictEqual(app.server.calls, 2)
        assert.strictEqual(root.text(), "Note 1clicks 0")
      }))
    })
  })

  it.effect("replays from the MessageLog with Story.fromLog, update reading the logged results as $.queries", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Note, { id: "1" })
        click(root, "clicks 0")
        yield* load
        click(root, "clicks 1")
        yield* TestHost.settle
        click(root, "clicks 2")
        yield* TestHost.settle
        assert.deepStrictEqual(root.model(), { clicks: 3, last: "Note 1" })
        const log = root.log()

        const replay = Story.fromLog(app.Note, log)
        assert.isUndefined(replay.divergence)
        assert.strictEqual(replay.replayed, 3)
        assert.deepStrictEqual(replay.model, { clicks: 3, last: "Note 1" })

        // Through the Wire: each Update's results are decoded with the queries' Schemas.
        const encoder = MessageLog.makeEncoder()
        const fromWire = Story.fromLog(app.Note, log.map(encoder.encode))
        assert.isUndefined(fromWire.divergence)
        assert.deepStrictEqual(fromWire.model, { clicks: 3, last: "Note 1" })
      })
    )
  })

  it.effect("replays a bounded log whose result writes were evicted", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Note, { id: "1" })
        yield* load
        click(root, "clicks 0")
        yield* TestHost.settle
        click(root, "clicks 1")
        yield* TestHost.settle
        const log = root.log()
        // What a ring buffer keeps once Mounted and the result's only QueryChanged have been evicted.
        const first = log.findIndex((entry) =>
          entry._tag === "Update" && entry.path === "/Note"
        )
        const bounded = log.slice(first)
        assert.deepStrictEqual(queryChanges(bounded, "/Note"), [])
        assert.strictEqual(updates(bounded, "/Note").length, 2)

        const replay = Story.fromLog(app.Note, bounded)
        assert.isUndefined(replay.divergence)
        assert.strictEqual(replay.replayed, 1)
        assert.deepStrictEqual(replay.model, { clicks: 2, last: "Note 1" })
        // The first Update's record gives the results back, so the final state has the note.
        assert.strictEqual(noteOf(replay), "Note 1")
        const fromWire = Story.fromLog(
          app.Note,
          bounded.map(MessageLog.makeEncoder().encode)
        )
        assert.isUndefined(fromWire.divergence)
        assert.deepStrictEqual(fromWire.model, { clicks: 2, last: "Note 1" })
        assert.strictEqual(noteOf(fromWire), "Note 1")
      })
    )
  })

  it.effect("replays an update that read a refetch in flight, live and through the Wire", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Note, { id: "1" })
        yield* load
        root.send(app.NoteMessage.Touch())
        yield* TestHost.settle
        // The refetch is in flight: the result keeps the value, waiting.
        click(root, "clicks 0")
        yield* TestHost.settle
        assert.deepStrictEqual(root.model(), {
          clicks: 1,
          last: "Note 1 (waiting)"
        })
        yield* load
        click(root, "clicks 1")
        yield* TestHost.settle
        assert.deepStrictEqual(root.model(), { clicks: 2, last: "Note 1" })
        assert.strictEqual(app.server.calls, 2)

        const log = root.log()
        const replay = Story.fromLog(app.Note, log)
        assert.isUndefined(replay.divergence)
        assert.deepStrictEqual(replay.model, { clicks: 2, last: "Note 1" })
        // Page state drops waiting, and the log's form keeps it.
        const fromWire = Story.fromLog(
          app.Note,
          log.map(MessageLog.makeEncoder().encode)
        )
        assert.isUndefined(fromWire.divergence)
        assert.deepStrictEqual(fromWire.model, { clicks: 2, last: "Note 1" })
        assert.strictEqual(fromWire.replayed, 4)
      })
    )
  })

  it.effect("replay ends with the results a load wrote after the last message, live and through the Wire", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Note, { id: "1" })
        // Nothing is loaded yet: the replay ends with the result empty.
        assert.strictEqual(
          noteOf(Story.fromLog(app.Note, root.log())),
          "Initial"
        )
        click(root, "clicks 0")
        yield* TestHost.settle
        const before = Story.fromLog(app.Note, root.log())
        assert.strictEqual(noteOf(before), "Initial")
        yield* load
        assert.strictEqual(root.text(), "Note 1clicks 1")
        const log = root.log()
        assert.deepStrictEqual(
          log.filter((entry) => "path" in entry && entry.path === "/Note").map((
            entry
          ) => entry._tag).slice(-2),
          [
            "Update",
            "QueryChanged"
          ]
        )
        for (
          const replay of [
            Story.fromLog(app.Note, log),
            Story.fromLog(app.Note, log.map(MessageLog.makeEncoder().encode))
          ]
        ) {
          assert.isUndefined(replay.divergence)
          assert.strictEqual(replay.replayed, 1)
          assert.deepStrictEqual(replay.model, { clicks: 1, last: "none" })
          assert.deepStrictEqual(replay.props, { id: "1" })
          assert.strictEqual(noteOf(replay), "Note 1")
        }
      })
    )
  })

  it.effect("replay ends with a load that settled without any message", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Note, { id: "1" })
        yield* load
        const replay = Story.fromLog(
          app.Note,
          root.log().map(MessageLog.makeEncoder().encode)
        )
        assert.strictEqual(replay.replayed, 0)
        assert.strictEqual(noteOf(replay), "Note 1")
      })
    )
  })

  it.effect("a Mounted entry at the same path starts the results over", () => {
    const app = makeApp()
    return Effect.gen(function*() {
      const first = yield* run(
        app.layer,
        Effect.gen(function*() {
          const root = yield* TestHost.mount(app.Note, { id: "1" })
          yield* load
          return root.log()
        })
      )
      // A second mount on a cold cache: the earlier session's result isn't carried over.
      const second = yield* run(
        app.layer,
        Effect.map(TestHost.mount(app.Note, { id: "2" }), (root) => root.log())
      )
      const replay = Story.fromLog(app.Note, [...first, ...second])
      assert.strictEqual(noteOf(Story.fromLog(app.Note, first)), "Note 1")
      assert.strictEqual(noteOf(replay), "Initial")
      assert.deepStrictEqual(replay.props, { id: "2" })
    })
  })

  it.effect("entries of two instances at one path replay apart, and the result is the later instance's", () => {
    const app = makeApp()
    /** A Note under a Shell, with what it logged, as the instance with this number. */
    const session = (
      instance: number,
      steps: (
        root: TestHost.TestRoot<any, any, any>
      ) => Effect.Effect<void, unknown, any>
    ) =>
      run(
        app.layer,
        Effect.gen(function*() {
          const root = yield* TestHost.mount(app.Shell, {})
          yield* load
          yield* steps(root)
          const path = noteMount(root.log()).path
          const log = root.log().filter((entry) =>
            "path" in entry && entry.path === path
          ).map((entry) => ({
            ...entry,
            instance
          }))
          return {
            path,
            log,
            update: log.map((entry) => entry._tag).lastIndexOf("Update")
          }
        })
      )
    return Effect.gen(function*() {
      // The older one is clicked twice with note 1, then given id 3.
      const older = yield* session(1, (root) =>
        Effect.gen(function*() {
          click(root, "clicks 0")
          yield* TestHost.settle
          click(root, "clicks 1")
          yield* TestHost.settle
          root.send(app.setId("3"))
          yield* load
        }))
      // The newer one is given id 2, then clicked.
      const newer = yield* session(2, (root) =>
        Effect.gen(function*() {
          root.send(app.setId("2"))
          yield* load
          click(root, "clicks 0")
          yield* TestHost.settle
        }))
      // The older one's second click, and then its props and load, are logged after the newer one mounted.
      // Woven by hand: today's runtime logs none of these for an instance once the next has mounted at its path.
      const late = older.log.slice(older.update + 1)
      assert.includeMembers(late.map((entry) => entry._tag), [
        "PropsChanged",
        "QueryChanged"
      ])
      const log = [
        ...older.log.slice(0, older.update),
        ...newer.log.slice(0, newer.update),
        older.log[older.update],
        newer.log[newer.update],
        ...late
      ]
      for (
        const replay of [
          Story.fromLog(app.Note, log, { path: newer.path }),
          Story.fromLog(app.Note, log.map(MessageLog.makeEncoder().encode), {
            path: newer.path
          })
        ]
      ) {
        assert.isUndefined(replay.divergence)
        assert.strictEqual(replay.replayed, 3)
        assert.deepStrictEqual(replay.model, { clicks: 1, last: "Note 2" })
        assert.deepStrictEqual(replay.props, { id: "2" })
        assert.strictEqual(noteOf(replay), "Note 2")
      }
    })
  })

  it.effect("replay follows props from the parent: a new id's load, then disabling the query, live and through the Wire", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Shell, {})
        yield* load
        assert.strictEqual(root.text(), "Note 1clicks 0")
        const path = noteMount(root.log()).path
        /** Both replays of the Note: from the live log, and from the Wire. */
        const replays = () => {
          const log = root.log()
          return [
            Story.fromLog(app.Note, log, { path }),
            Story.fromLog(app.Note, log.map(MessageLog.makeEncoder().encode), {
              path
            })
          ]
        }

        root.send(app.setId("2"))
        yield* load
        assert.strictEqual(root.text(), "Note 2clicks 0")
        // The props are logged before the result write they cause.
        assert.deepStrictEqual(
          root.log().flatMap((entry) =>
            (entry._tag === "PropsChanged" || entry._tag === "QueryChanged") &&
              entry.path === path
              ? [entry._tag]
              : []
          ),
          ["QueryChanged", "PropsChanged", "QueryChanged"]
        )
        for (const replay of replays()) {
          assert.isUndefined(replay.divergence)
          assert.strictEqual(replay.replayed, 0)
          assert.deepStrictEqual(replay.props, { id: "2" })
          assert.strictEqual(noteOf(replay), "Note 2")
        }

        // Disabling writes no result: only the props show that the query is off.
        root.send(app.setId(""))
        yield* load
        assert.strictEqual(root.text(), "loadingclicks 0")
        for (const replay of replays()) {
          assert.isUndefined(replay.divergence)
          assert.deepStrictEqual(replay.props, { id: "" })
          assert.strictEqual(noteOf(replay), "Initial")
        }
      })
    )
  })

  it.effect("a divergence returns the props and results the diverging update read", () => {
    const app = makeApp()
    return run(
      app.layer,
      Effect.gen(function*() {
        const root = yield* TestHost.mount(app.Shell, {})
        yield* load
        root.send(app.setId("2"))
        yield* load
        click(root, "clicks 0")
        yield* TestHost.settle
        const path = noteMount(root.log()).path
        // A log without the PropsChanged entry, whose last Update records a Model that update doesn't compute.
        const tampered = root.log().filter((entry) =>
          entry._tag !== "PropsChanged"
        ).map((entry) =>
          entry._tag === "Update" && entry.path === path
            ? { ...entry, model: { clicks: 9, last: "Note 2" } }
            : entry
        )
        for (
          const replay of [
            Story.fromLog(app.Note, tampered, { path }),
            Story.fromLog(
              app.Note,
              tampered.map(MessageLog.makeEncoder().encode),
              { path }
            )
          ]
        ) {
          assert.deepStrictEqual(replay.divergence?.recomputed.model, {
            clicks: 1,
            last: "Note 2"
          })
          // The Model before the message, with the props and results it was sent with.
          assert.deepStrictEqual(replay.model, { clicks: 0, last: "none" })
          assert.deepStrictEqual(replay.props, { id: "2" })
          assert.strictEqual(noteOf(replay), "Note 2")
        }
      })
    )
  })

  it("Story.head opens the queries at the props it is given, with every result empty", () => {
    const app = makeApp()
    // The query's args read the props, so head needs them to open it.
    assert.deepStrictEqual(
      Story.head(app.Note, { clicks: 0, last: "none" }, { id: "1" }),
      [Head.title("Note")]
    )
    const story =
      Story.start(app.Note, { id: "1" }).loaded("note", "Note 1").current
    assert.deepStrictEqual(Story.head(story), [Head.title("Note 1")])
  })
})
