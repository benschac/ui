// @vitest-environment happy-dom
import { assert, it } from "@effect/vitest"
import { Effect, Schema, SchemaGetter } from "effect"
import { AsyncResult } from "effect/reactivity"
import { describe, vi } from "vitest"

/** Lets the render flush and the fetch settle. */
const tick = Effect.promise(() =>
  new Promise<void>((resolve) => setTimeout(resolve, 30))
)

const container = Effect.acquireRelease(
  Effect.sync(() => document.body.appendChild(document.createElement("div"))),
  (element) => Effect.sync(() => element.remove())
)

/**
 * An app whose Save Command loads Query in its work and then waits for `release` before it succeeds with
 * `"old"`. Its Replace Command succeeds with `"new"` at once. Both write their result to the note the
 * child reads, which Show mounts, and whose fetch never settles.
 */
const lateSave = Effect.gen(function*() {
  vi.resetModules()
  const [Command, Component, UiSchema, BrowserHost, Html, queryCore] =
    yield* Effect.promise(() =>
      Promise.all([
        import("@effect/ui/Command"),
        import("@effect/ui/Component"),
        import("@effect/ui/UiSchema"),
        import("@effect/ui/html/BrowserHost"),
        import("@effect/ui/html/Html"),
        import("@effect/ui/internal/queryCore")
      ])
    )
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  // Both are set by Save's work, which is what loads Query.
  let child: ((h: any) => any) | undefined
  let write: ((saved: string) => any) | undefined
  class Save extends Command.Service<Save>()(
    "lazy/LateSave",
    {
      args: {},
      success: Schema.String,
      error: Schema.Never,
      writes: (saved) => [write!(saved)]
    }
  ) {
    static readonly layer = this.toLayer(() =>
      Effect.promise(async () => {
        const Query = await import("@effect/ui/Query")
        class GetNote extends Query.Service<GetNote>()(
          "lazy/LateNote",
          {
            args: { id: Schema.String },
            success: Schema.String,
            error: Schema.Never,
            staleTime: "30 seconds"
          }
        ) {
          static readonly layer = this.toLayer(() => Effect.never)
        }
        const Note = Html.component({
          name: "Note",
          model: Schema.Null,
          message: Schema.Never,
          queries: { note: { query: GetNote, args: () => ({ id: "1" }) } }
        }).make({
          init: () => null,
          update: ($) => $.model,
          view: (h) =>
            h.p.children(AsyncResult.match(h.queries.note, {
              onInitial: () => "loading",
              onFailure: () => "failed",
              onSuccess: (success) => success.value
            }))
        }).pipe(Component.provide(GetNote.layer))
        child = (h) => Note(h, {})
        write = (saved) => GetNote.set({ id: "1" }, saved)
        await released
        return "old"
      })
    )
  }
  class Replace extends Command.Service<Replace>()(
    "lazy/Replace",
    {
      args: {},
      success: Schema.String,
      error: Schema.Never,
      writes: (saved) => [write!(saved)]
    }
  ) {
    static readonly layer = this.toLayer(() => Effect.succeed("new"))
  }
  const Message = UiSchema.TaggedEnum({
    Save: {},
    Replace: {},
    Show: {},
    Saved: {}
  })
  const App = Html.component({
    name: "App",
    model: Schema.Boolean,
    message: Message
  })
    .make({
      init: () => false,
      update: ($, message) =>
        Message.match(message, {
          Save: () => $.run(Save.make({}).pipe(Command.as(Message.Saved()))),
          Replace: () =>
            $.run(Replace.make({}).pipe(Command.as(Message.Show()))),
          Show: () => true,
          Saved: () => $.model
        }),
      view: (h, shown) =>
        h.div.children(
          h.button.on("click", Message.Save()).children("Save"),
          h.button.on("click", Message.Replace()).children("Replace"),
          h.button.on("click", Message.Show()).children("Show"),
          shown && child !== undefined ? child(h) : h.p.children("hidden")
        )
    }).pipe(Component.provide(Save.layer), Component.provide(Replace.layer))
  const app = yield* container
  const problems: Array<string> = []
  yield* BrowserHost.mountEffect(App, {}, app).pipe(
    Effect.provideService(queryCore.Problems, (problem) => {
      problems.push(problem._tag)
    })
  )
  const click = (label: string) =>
    Effect.sync(() =>
      Array.from(app.querySelectorAll("button")).find((button) =>
        button.textContent === label
      )!.click()
    )
  return {
    click,
    release,
    problems,
    note: () => app.querySelector("p")?.textContent
  }
})

/**
 * Mounts an app whose child runs a Save Command with these `writes` at a click, and shows `saved` when
 * it succeeds. Nothing imports Query. Returns the app's text after the run.
 */
const savedWith = Effect.fnUntraced(
  function*(writes: (saved: string) => ReadonlyArray<never>) {
    vi.resetModules()
    const [Command, Component, UiSchema, BrowserHost, Html] = yield* Effect
      .promise(() =>
        Promise.all([
          import("@effect/ui/Command"),
          import("@effect/ui/Component"),
          import("@effect/ui/UiSchema"),
          import("@effect/ui/html/BrowserHost"),
          import("@effect/ui/html/Html")
        ])
      )
    class Save extends Command.Service<Save>()(
      "lazy/PlainSave",
      { args: {}, success: Schema.String, error: Schema.Never, writes }
    ) {
      static readonly layer = this.toLayer(() => Effect.succeed("saved"))
    }
    const Message = UiSchema.TaggedEnum({ Clicked: {}, Saved: {} })
    const Saver = Html.component({
      name: "Saver",
      model: Schema.String,
      message: Message
    }).make({
      init: () => "idle",
      update: ($, message) =>
        Message.match(message, {
          Clicked: () => $.run(Save.make({}).pipe(Command.as(Message.Saved()))),
          Saved: () => "saved"
        }),
      view: (h, model) =>
        h.button.on("click", Message.Clicked()).children(model)
    }).pipe(Component.provide(Save.layer))
    const App = Html.component({
      name: "App",
      model: Schema.Null,
      message: Schema.Never
    }).make({
      init: () => null,
      update: ($) => $.model,
      view: (h) => h.div.children(Saver(h, {}), h.p.children(" in app"))
    })
    const app = yield* container
    yield* BrowserHost.mountEffect(App, {}, app)
    app.querySelector("button")!.click()
    yield* tick
    return app.textContent
  }
)

// Each test starts a module graph of its own, so they run one at a time.
describe("Query loaded after the mount", { concurrent: false }, () => {
  it.effect("a root mounted before the app imports Query runs the queries of a child that loads later", () =>
    Effect.gen(function*() {
      // A module graph of its own, as in an app whose entry chunk has no query: nothing has imported Query.
      vi.resetModules()
      const [Component, UiSchema, BrowserHost, Html] = yield* Effect.promise(
        () =>
          Promise.all([
            import("@effect/ui/Component"),
            import("@effect/ui/UiSchema"),
            import("@effect/ui/html/BrowserHost"),
            import("@effect/ui/html/Html")
          ])
      )
      let child: ((h: any) => any) | undefined
      const Message = UiSchema.TaggedEnum({ Opened: {} })
      const App = Html.component({
        name: "App",
        model: Schema.Boolean,
        message: Message
      }).make({
        init: () => false,
        update: () => true,
        view: (h, open) =>
          h.div.children(
            h.button.on("click", Message.Opened()).children("Open"),
            open && child !== undefined ? child(h) : h.p.children("closed")
          )
      })
      const app = yield* container
      yield* BrowserHost.mountEffect(App, {}, app)
      assert.strictEqual(app.querySelector("p")?.textContent, "closed")

      // The lazy chunk: it imports Query, and defines a query and the component that reads it.
      const Query = yield* Effect.promise(() => import("@effect/ui/Query"))
      class GetNote extends Query.Service<GetNote>()(
        "lazy/GetNote",
        {
          args: { id: Schema.String },
          success: Schema.String,
          error: Schema.Never,
          staleTime: "30 seconds"
        }
      ) {
        static readonly layer = this.toLayer(({ id }) =>
          Effect.succeed(`Note ${id}`)
        )
      }
      const Note = Html.component({
        name: "Note",
        model: Schema.Null,
        message: Schema.Never,
        queries: { note: { query: GetNote, args: () => ({ id: "1" }) } }
      }).make({
        init: () => null,
        update: ($) => $.model,
        view: (h) =>
          h.p.children(AsyncResult.match(h.queries.note, {
            onInitial: () => "loading",
            onFailure: () => "failed",
            onSuccess: (success) => success.value
          }))
      }).pipe(Component.provide(GetNote.layer))
      child = (h) => Note(h, {})

      app.querySelector("button")!.click()
      yield* tick
      assert.strictEqual(app.querySelector("p")?.textContent, "Note 1")
    }))

  it.effect("an unread async ~query decode is interrupted when Query loads after adoption", () =>
    Effect.gen(function*() {
      vi.resetModules()
      const [Component, UiSchema, Html, HtmlServer, HtmlHydrate, queryCore] =
        yield* Effect.promise(() =>
          Promise.all([
            import("@effect/ui/Component"),
            import("@effect/ui/UiSchema"),
            import("@effect/ui/html/Html"),
            import("@effect/ui/html/HtmlServer"),
            import("@effect/ui/html/HtmlHydrate"),
            import("@effect/ui/internal/queryCore")
          ])
        )
      let child: ((h: any) => any) | undefined
      const Message = UiSchema.TaggedEnum({ Opened: {} })
      const App = Html.component({
        name: "App",
        model: Schema.Boolean,
        message: Message
      }).make({
        init: () => false,
        update: () => true,
        view: (h, open) =>
          h.div.children(
            h.button.on("click", Message.Opened()).children("Open"),
            open && child !== undefined ? child(h) : h.p.children("closed")
          )
      })
      const rendered = yield* HtmlServer.renderToHtml(App, {})
      const app = yield* container
      app.innerHTML = rendered.html
      const root = yield* HtmlHydrate.hydrateEffect(App, {}, app, {
        ...rendered.state,
        "~query": {
          "lazy/AsyncNote": [
            ["{\"id\":\"1\"}", 0, "Note 1", 0],
            ["{\"id\":\"2\"}", 0, "orphan", 0]
          ]
        }
      })
      yield* root.adopted
      assert.isUndefined(queryCore.loaded)

      const Query = yield* Effect.promise(() => import("@effect/ui/Query"))
      let orphanCancelled = false
      const Body = Schema.String.pipe(Schema.decode({
        decode: SchemaGetter.transformEffect((body: string) =>
          body === "orphan"
            ? Effect.onInterrupt(Effect.never, () =>
              Effect.sync(() => {
                orphanCancelled = true
              }))
            : Effect.succeed(body)
        ),
        encode: SchemaGetter.transform((body: string) => body)
      }))
      class GetNote extends Query.Service<GetNote>()("lazy/AsyncNote", {
        args: { id: Schema.String },
        success: Body,
        error: Schema.Never,
        staleTime: "30 seconds"
      }) {
        static readonly layer = this.toLayer(() => Effect.never)
      }
      const Note = Html.component({
        name: "Note",
        model: Schema.Null,
        message: Schema.Never,
        queries: { note: { query: GetNote, args: () => ({ id: "1" }) } }
      }).make({
        init: () => null,
        update: ($) => $.model,
        view: (h) =>
          h.p.children(
            AsyncResult.isSuccess(h.queries.note)
              ? h.queries.note.value
              : "loading"
          )
      }).pipe(Component.provide(GetNote.layer))
      child = (h) => Note(h, {})

      app.querySelector("button")!.click()
      yield* tick
      assert.strictEqual(app.querySelector("p")?.textContent, "Note 1")
      assert.isTrue(orphanCancelled)
    }).pipe(Effect.scoped))

  it.effect("a Command that imports Query while it runs still writes its result to the cache", () =>
    Effect.gen(function*() {
      vi.resetModules()
      const [Command, Component, UiSchema, BrowserHost, Html] = yield* Effect
        .promise(() =>
          Promise.all([
            import("@effect/ui/Command"),
            import("@effect/ui/Component"),
            import("@effect/ui/UiSchema"),
            import("@effect/ui/html/BrowserHost"),
            import("@effect/ui/html/Html")
          ])
        )
      const calls = { writes: 0, fetches: 0 }
      // Both are set by the Command's work, which is what loads Query.
      let child: ((h: any) => any) | undefined
      let write: ((saved: string) => any) | undefined
      class Save extends Command.Service<Save>()(
        "lazy/Save",
        {
          args: {},
          success: Schema.String,
          error: Schema.Never,
          writes: (saved) => {
            calls.writes++
            return [write!(saved)]
          }
        }
      ) {
        static readonly layer = this.toLayer(() =>
          Effect.promise(async () => {
            const Query = await import("@effect/ui/Query")
            class GetNote extends Query.Service<GetNote>()(
              "lazy/SavedNote",
              {
                args: { id: Schema.String },
                success: Schema.String,
                error: Schema.Never,
                staleTime: "30 seconds"
              }
            ) {
              static readonly layer = this.toLayer(() =>
                Effect.sync(() => {
                  calls.fetches++
                  return "fetched"
                })
              )
            }
            const Note = Html.component({
              name: "Note",
              model: Schema.Null,
              message: Schema.Never,
              queries: { note: { query: GetNote, args: () => ({ id: "1" }) } }
            }).make({
              init: () => null,
              update: ($) => $.model,
              view: (h) =>
                h.p.children(AsyncResult.match(h.queries.note, {
                  onInitial: () => "loading",
                  onFailure: () => "failed",
                  onSuccess: (success) => success.value
                }))
            }).pipe(Component.provide(GetNote.layer))
            child = (h) => Note(h, {})
            write = (saved) => GetNote.set({ id: "1" }, saved)
            return "saved"
          })
        )
      }
      const Message = UiSchema.TaggedEnum({ Clicked: {}, Saved: {} })
      const App = Html.component({
        name: "App",
        model: Schema.Boolean,
        message: Message
      }).make({
        init: () => false,
        update: ($, message) =>
          Message.match(message, {
            Clicked: () =>
              $.run(Save.make({}).pipe(Command.as(Message.Saved()))),
            Saved: () => true
          }),
        view: (h, saved) =>
          h.div.children(
            h.button.on("click", Message.Clicked()).children("Save"),
            saved && child !== undefined ? child(h) : h.p.children("unsaved")
          )
      }).pipe(Component.provide(Save.layer))
      const app = yield* container
      yield* BrowserHost.mountEffect(App, {}, app)

      app.querySelector("button")!.click()
      yield* tick
      assert.strictEqual(app.querySelector("p")?.textContent, "saved")
      assert.deepStrictEqual(calls, { writes: 1, fetches: 0 })
    }))

  it.effect("a Command issued after one that is still loading Query keeps its newer write", () =>
    Effect.gen(function*() {
      const { click, note, release } = yield* lateSave
      yield* click("Save")
      yield* tick
      yield* click("Replace")
      yield* tick
      release()
      yield* tick
      assert.strictEqual(note(), "new")
    }))

  it.effect("a Command that loaded Query writes to a query first read after its work began without a problem", () =>
    Effect.gen(function*() {
      const { click, note, problems, release } = yield* lateSave
      yield* click("Save")
      yield* tick
      yield* click("Show")
      yield* tick
      release()
      yield* tick
      assert.deepStrictEqual({ note: note(), problems }, {
        note: "old",
        problems: []
      })
    }))

  it.effect("a Command's writes run when nothing has loaded Query", () =>
    Effect.gen(function*() {
      let calls = 0
      const text = yield* savedWith(() => {
        calls++
        return []
      })
      assert.deepStrictEqual({ calls, text }, {
        calls: 1,
        text: "saved in app"
      })
    }))

  it.effect("a Command whose writes throw fails its instance when nothing has loaded Query", () =>
    Effect.gen(function*() {
      const text = yield* savedWith(() => {
        throw new Error("writes broke")
      })
      assert.strictEqual(text, " in app")
    }))
})
