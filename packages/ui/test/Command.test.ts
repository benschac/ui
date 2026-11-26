import { Command, Component, Query, UiSchema } from "@effect/ui"
import * as schedule from "@effect/ui/internal/schedule"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Schema, Stream } from "effect"
import { KeyValueStore } from "effect/persistence"
import {
  SaveTodo,
  Search,
  TodoItemMessage,
  Upload
} from "./fixtures/components.ts"

const todo = { id: "t1", title: "buy milk", done: false }

class Ticks extends Command.Service<Ticks>()(
  "Ticks",
  {
    args: { n: Schema.Number },
    success: Schema.Number,
    error: Schema.Never,
    stream: true,
    invalidates: () => []
  }
) {
  static readonly layer = this.toLayer(({ n }) =>
    Stream.fromIterable(Array.from({ length: n }, (_, i) => i))
  )
}

class SaveFailed extends Schema.TaggedError<SaveFailed>()("SaveFailed", {
  reason: Schema.String
}) {}

class Save extends Command.Service<Save>()(
  "Save",
  {
    args: { title: Schema.String },
    success: Schema.String,
    error: SaveFailed,
    invalidates: () => []
  }
) {
  static readonly layer = this.toLayer(({ title }) =>
    title === ""
      ? Effect.fail(new SaveFailed({ reason: "empty" }))
      : Effect.succeed(title)
  )
}

const failingKv = Layer.succeed(
  KeyValueStore.KeyValueStore,
  KeyValueStore.makeStringOnly({
    get: () =>
      Effect.fail(
        new KeyValueStore.KeyValueStoreError({
          message: "disk full",
          method: "get",
          key: ""
        })
      ),
    set: () =>
      Effect.fail(
        new KeyValueStore.KeyValueStoreError({
          message: "disk full",
          method: "set",
          key: ""
        })
      ),
    remove: () =>
      Effect.fail(
        new KeyValueStore.KeyValueStoreError({
          message: "disk full",
          method: "remove",
          key: ""
        })
      ),
    clear: Effect.void,
    size: Effect.succeed(0),
    keys: Effect.succeed([])
  })
)

describe("Command", () => {
  describe("Service", () => {
    it("is a Context.Service whose key is the Command's name", () => {
      assert.strictEqual(SaveTodo.key, "todos/SaveTodo")
      assert.strictEqual(Command.nameOf(SaveTodo), "todos/SaveTodo")
      assert.isTrue(Command.isDefinition(SaveTodo))
      assert.isFalse(SaveTodo.stream)
      assert.strictEqual(SaveTodo.mode, "concurrent")
    })

    it("make issues a Command carrying the name and arguments", () => {
      const command = SaveTodo.make(todo)
      assert.isTrue(Command.isCommand(command))
      assert.strictEqual(command._tag, "Effect")
      assert.strictEqual(command.name, "todos/SaveTodo")
      assert.deepStrictEqual(command.args, todo)
      assert.strictEqual(command.groupKey, undefined)
    })

    it("defaults omitted invalidates to no targets and exposes success and error Schemas", () => {
      class NoInvalidation extends Command.Service<NoInvalidation>()(
        "NoInvalidation",
        { args: {}, success: Schema.Void, error: Schema.Never }
      ) {}
      assert.deepStrictEqual(NoInvalidation.make().invalidates, [])
      assert.strictEqual(NoInvalidation.success, Schema.Void)
      assert.strictEqual(NoInvalidation.error, Schema.Never)
      assert.strictEqual(Save.success, Schema.String)
      assert.strictEqual(Save.error, SaveFailed)
    })

    it("computes invalidates and optimistic from the args at issue, and writes from the success", () => {
      class Rename extends Command.Service<Rename>()(
        "Rename",
        {
          args: { id: Schema.String, name: Schema.String },
          success: Schema.String,
          error: Schema.Never,
          invalidates: ({ id }) => [Query.Tag(`user:${id}`)],
          optimistic: ({ id, name }) => [{ id, name }] as any,
          writes: (success, { id }) => [{ id, success }] as any
        }
      ) {}
      const command = Rename.make({ id: "u1", name: "ada" })
      assert.deepStrictEqual(command.invalidates, [Query.Tag("user:u1")])
      assert.deepStrictEqual(command.optimistic as unknown, [{
        id: "u1",
        name: "ada"
      }])
      assert.deepStrictEqual(command.writes?.("ADA") as unknown, [{
        id: "u1",
        success: "ADA"
      }])
    })

    it.effect("the implementation is tested against a fake of what it uses", () =>
      Effect.gen(function*() {
        const kv = yield* KeyValueStore.KeyValueStore
        const message = yield* SaveTodo.make(todo).effect
        assert.deepStrictEqual(message, TodoItemMessage.Saved())
        assert.strictEqual(yield* kv.get("todo/t1"), JSON.stringify(todo))
      }).pipe(
        Effect.provide(
          SaveTodo.layer.pipe(Layer.provideMerge(KeyValueStore.layerMemory))
        )
      ))

    it.effect("the implementation owns the error policy", () =>
      Effect.gen(function*() {
        const message = yield* SaveTodo.make(todo).effect
        assert.deepStrictEqual(
          message,
          TodoItemMessage.SaveFailed({ reason: "disk full" })
        )
      }).pipe(Effect.provide(SaveTodo.layer.pipe(Layer.provide(failingKv)))))

    it.effect("a fake is toLayer or Layer.succeed", () =>
      Effect.gen(function*() {
        assert.deepStrictEqual(
          yield* SaveTodo.make(todo).effect.pipe(
            Effect.provide(
              SaveTodo.toLayer(() =>
                Effect.succeed(TodoItemMessage.SaveFailed({ reason: "mocked" }))
              )
            )
          ),
          TodoItemMessage.SaveFailed({ reason: "mocked" })
        )
        assert.deepStrictEqual(
          yield* SaveTodo.make(todo).effect.pipe(
            Effect.provide(
              Layer.succeed(
                SaveTodo,
                () => Effect.succeed(TodoItemMessage.Saved())
              )
            )
          ),
          TodoItemMessage.Saved()
        )
      }))

    it.effect("a stream service runs its Stream", () =>
      Effect.gen(function*() {
        const items = yield* Stream.runCollect(Ticks.make({ n: 3 }).stream)
        assert.deepStrictEqual(items, [0, 1, 2])
        assert.isTrue(Ticks.stream)
        assert.strictEqual(Ticks.make({ n: 3 })._tag, "Stream")
      }).pipe(Effect.provide(Ticks.layer)))
  })

  describe("match", () => {
    it("a body with a typed error issues an Unmatched Command", () => {
      assert.isTrue(Command.isUnmatched(Save.make({ title: "milk" })))
      assert.isFalse(Command.isUnmatched(Search.make({ text: "x" })))
    })

    it.effect("maps both channels to messages", () =>
      Effect.gen(function*() {
        const matched = (title: string) =>
          Save.make({ title }).pipe(Command.match({
            onSuccess: (saved) => `saved ${saved}`,
            onFailure: (error) => `failed ${error.reason}`
          }))
        assert.isFalse(Command.isUnmatched(matched("milk")))
        assert.strictEqual(yield* matched("milk").effect, "saved milk")
        assert.strictEqual(yield* matched("").effect, "failed empty")
        assert.strictEqual(
          matched("").reject?.(new SaveFailed({ reason: "x" })),
          "failed x"
        )
      }).pipe(Effect.provide(Save.layer)))

    it.effect("a defect isn't mapped", () =>
      Effect.gen(function*() {
        const exit = yield* Effect.exit(
          Save.make({ title: "milk" }).pipe(
            Command.match({ onSuccess: () => "ok", onFailure: () => "failed" })
          ).effect
        )
        assert.isTrue(Exit.hasDies(exit))
      }).pipe(Effect.provide(Layer.succeed(Save, () => Effect.die("boom")))))

    it.effect("map after match maps both channels", () =>
      Effect.gen(function*() {
        const command = Save.make({ title: "" }).pipe(
          Command.match({
            onSuccess: () => "ok",
            onFailure: (error) => error.reason
          }),
          Command.map((message) => message.length)
        )
        assert.strictEqual(yield* command.effect, 5)
      }).pipe(Effect.provide(Save.layer)))
  })

  describe("make", () => {
    it("returns a factory whose Commands carry the options", () => {
      assert.strictEqual(Search.name, "Search")
      assert.strictEqual(Search.mode, "switch")
      const command = Search.make({ text: "x" })
      assert.strictEqual(command._tag, "Effect")
      assert.deepStrictEqual([
        command.name,
        command.args,
        command.mode,
        command.groupKey
      ], [
        "Search",
        { text: "x" },
        "switch",
        undefined
      ])
      assert.deepStrictEqual(Effect.runSync(command.effect), {
        _tag: "Results",
        items: ["x"]
      })
    })

    it("make issues when detached from the definition", () => {
      const { make } = Search
      assert.deepStrictEqual(make({ text: "y" }).args, { text: "y" })
    })

    it("a Command with no args takes none", () => {
      const Ping = Command.make(
        "Ping",
        { args: {} },
        () => Effect.succeed("pong")
      )
      assert.deepStrictEqual(Ping.make().args, {})
      assert.strictEqual(Effect.runSync(Ping.make().effect), "pong")
    })

    it("derives the group key from the group fields", () => {
      const command = Upload.make({ name: "photo.png" })
      assert.strictEqual(command._tag, "Stream")
      assert.strictEqual(command.groupKey, `{"name":"photo.png"}`)
      assert.isTrue(Upload.stream)
    })

    it("the group key is the canonical JSON of the encoded group fields", () => {
      const Page = Command.make(
        "Page",
        {
          args: {
            tab: Schema.String,
            page: Schema.NumberFromString,
            note: Schema.String
          },
          group: ["tab", "page"]
        },
        () => Effect.void
      )
      const a = Page.make({ page: 2, tab: "all", note: "a" })
      const b = Page.make({ note: "b", tab: "all", page: 2 })
      assert.strictEqual(a.groupKey, `{"page":"2","tab":"all"}`)
      assert.strictEqual(a.groupKey, b.groupKey)
      assert.notStrictEqual(
        Page.make({ page: 3, tab: "all", note: "a" }).groupKey,
        a.groupKey
      )
    })

    it("a File outside the group doesn't take part in the group key", () => {
      const UploadFile = Command.make(
        "UploadFile",
        {
          args: { folder: Schema.String, file: Schema.instanceOf(File) },
          group: ["folder"]
        },
        ({ file }) => Effect.succeed(file.name)
      )
      const command = UploadFile.make({
        folder: "photos",
        file: new File(["x"], "me.png")
      })
      assert.strictEqual(command.groupKey, `{"folder":"photos"}`)
      assert.strictEqual(Effect.runSync(command.effect), "me.png")
    })

    it("a group field must be one of the args", () => {
      assert.throws(
        () =>
          Command.make("Bad", {
            args: { a: Schema.String },
            group: ["b" as any]
          }, () => Effect.void),
        /group field "b"/
      )
    })

    it("the work field of the other kind is undefined", () => {
      assert.strictEqual(Upload.make({ name: "photo.png" }).effect, undefined)
      assert.strictEqual(Search.make({ text: "x" }).stream, undefined)
      assert.strictEqual(
        Command.map(Upload.make({ name: "photo.png" }), () => 1).effect,
        undefined
      )
    })
  })

  describe("map", () => {
    it("keeps the name, arguments and options, and maps the result", () => {
      const mapped = Search.make({ text: "x" }).pipe(
        Command.map((message) => (message as { readonly _tag: string })._tag)
      )
      assert.strictEqual(mapped._tag, "Effect")
      if (mapped._tag !== "Effect") return
      assert.deepStrictEqual([mapped.name, mapped.args, mapped.mode], [
        "Search",
        { text: "x" },
        "switch"
      ])
      assert.strictEqual(Effect.runSync(mapped.effect), "Results")
      assert.strictEqual(
        mapped.resolve({ _tag: "Results", items: [] }),
        "Results"
      )
    })

    it("leaves an Interrupt unchanged", () => {
      const interrupt = Command.interrupt(Upload, { name: "photo.png" })
      assert.deepStrictEqual([
        interrupt._tag,
        interrupt.name,
        interrupt.groupKey
      ], [
        "Interrupt",
        "Upload",
        `{"name":"photo.png"}`
      ])
      assert.strictEqual(Command.interrupt(Upload).groupKey, undefined)
      assert.strictEqual(Command.map(interrupt, () => 1), interrupt)
    })
  })

  describe("as", () => {
    it.effect("replaces effect and stream messages while keeping the issued Command", () =>
      Effect.gen(function*() {
        const message = { _tag: "Done" }
        const original = Search.make({ text: "x" })
        const mapped = original.pipe(Command.as(message))
        assert.strictEqual(yield* mapped.effect, message)
        assert.strictEqual(
          mapped.resolve({ _tag: "Results", items: [] }),
          message
        )
        assert.deepStrictEqual([mapped.name, mapped.args, mapped.mode], [
          "Search",
          { text: "x" },
          "switch"
        ])
        const stream = Command.as(Ticks.make({ n: 2 }), message)
        assert.deepStrictEqual(yield* Stream.runCollect(stream.stream), [
          message,
          message
        ])
        const matched = Save.make({ title: "" }).pipe(
          Command.match({ onSuccess: () => "ok", onFailure: () => "failed" }),
          Command.as(message)
        )
        assert.strictEqual(yield* matched.effect, message)
        assert.strictEqual(
          matched.reject?.(new SaveFailed({ reason: "empty" })),
          message
        )
        const interrupt = Command.interrupt(Ticks)
        assert.strictEqual(Command.as(interrupt, message), interrupt)
      }).pipe(Effect.provide(Ticks.layer), Effect.provide(Save.layer)))
  })

  describe("asNoop", () => {
    it.effect("replaces every result with Component.noop, keeping the issued Command", () =>
      Effect.gen(function*() {
        const silent = Search.make({ text: "x" }).pipe(Command.asNoop)
        assert.deepStrictEqual([silent.name, silent.args, silent.mode], [
          "Search",
          { text: "x" },
          "switch"
        ])
        assert.strictEqual(yield* silent.effect, Component.noop)
        assert.strictEqual(
          silent.resolve({ _tag: "Results", items: [] }),
          Component.noop
        )
        const stream = Command.asNoop(Ticks.make({ n: 2 }))
        assert.deepStrictEqual(yield* Stream.runCollect(stream.stream), [
          Component.noop,
          Component.noop
        ])
        const matched = Save.make({ title: "" }).pipe(
          Command.match({ onSuccess: () => "ok", onFailure: () => "failed" }),
          Command.asNoop
        )
        assert.strictEqual(
          matched.reject?.(new SaveFailed({ reason: "empty" })),
          Component.noop
        )
        const interrupt = Command.interrupt(Ticks)
        assert.strictEqual(Command.asNoop(interrupt), interrupt)
      }).pipe(Effect.provide(Ticks.layer), Effect.provide(Save.layer)))

    it("Component.noop is a frozen object holding only its type id, and isNoop checks the type id", () => {
      assert.deepStrictEqual(Object.entries(Component.noop), [[
        "~@effect/ui/Component/Noop",
        "~@effect/ui/Component/Noop"
      ]])
      assert.isTrue(Object.isFrozen(Component.noop))
      assert.isTrue(Component.isNoop(Component.noop))
      // A copy from another copy of effect is a different object with the same type id.
      assert.isTrue(
        Component.isNoop({
          "~@effect/ui/Component/Noop": "~@effect/ui/Component/Noop"
        })
      )
      assert.isFalse(Component.isNoop({ "~@effect/ui/Component/Noop": true }))
      assert.isFalse(Component.isNoop(Symbol.for("~@effect/ui/Component/Noop")))
      assert.isFalse(Component.isNoop(undefined))
      assert.isFalse(Component.isNoop({ _tag: "Done" }))
    })
  })

  describe("schedule", () => {
    const Message = UiSchema.TaggedEnum({ Done: {} })
    const done = () => Effect.succeed(Message.Done())
    const concurrent = Command.make("C", { args: {} }, done)
    const switching = Command.make("S", { args: {}, mode: "switch" }, done)
    const queueing = Command.make("Q", {
      args: { key: Schema.String },
      mode: "queue",
      group: ["key"]
    }, done)
    const q = (key: string) => queueing.make({ key })
    const entry = (
      command: Command.Issued<any, any, any, "Effect">,
      status: schedule.Status = "running"
    ): schedule.Entry<string> => ({
      name: command.name,
      key: command.groupKey,
      mode: command.mode,
      status,
      value: `${command.name}:${command.groupKey ?? ""}:${status}`
    })

    it("concurrent starts alongside the group", () => {
      assert.deepStrictEqual(
        schedule.schedule([entry(concurrent.make())], concurrent.make()),
        {
          action: "start",
          interrupt: []
        }
      )
    })

    it("switch interrupts the group, not other Commands, and waits for the fibers it cut", () => {
      const other = entry(concurrent.make())
      const decision = schedule.schedule(
        [entry(switching.make()), other, entry(switching.make(), "queued")],
        switching.make()
      )
      assert.strictEqual(decision.action, "queue")
      assert.deepStrictEqual(decision.interrupt.map((e) => e.value), [
        "S::running",
        "S::queued"
      ])
      assert.deepStrictEqual(schedule.schedule([other], switching.make()), {
        action: "start",
        interrupt: []
      })
    })

    it("a stopping run holds its group until its fiber exits, and isn't interrupted again", () => {
      const stopping = entry(q("a"), "stopping")
      assert.strictEqual(schedule.schedule([stopping], q("a")).action, "queue")
      assert.deepStrictEqual(
        schedule.schedule(
          [entry(switching.make(), "stopping")],
          switching.make()
        ),
        {
          action: "queue",
          interrupt: []
        }
      )
      assert.deepStrictEqual(
        schedule.schedule([stopping], Command.interrupt(queueing)).interrupt,
        []
      )
      const queued = entry(q("a"), "queued")
      assert.strictEqual(schedule.next([stopping, queued], queued), undefined)
      assert.strictEqual(schedule.next([queued], queued), queued)
    })

    it("queue waits per group, and the oldest queued run starts when the running one ends", () => {
      const a = entry(q("a"))
      assert.strictEqual(schedule.schedule([a], q("a")).action, "queue")
      assert.strictEqual(schedule.schedule([a], q("b")).action, "start")
      const queued1 = entry(q("a"), "queued")
      const queued2 = { ...entry(q("a"), "queued"), value: "second" }
      assert.strictEqual(schedule.next([queued1, queued2], a), queued1)
      assert.strictEqual(
        schedule.next([a, queued1], { ...a, value: "another" }),
        undefined
      )
    })

    it("an interrupt stops nothing new and interrupts by name, or by name and group", () => {
      const a = entry(q("a"))
      const b = entry(q("b"))
      assert.deepStrictEqual(
        schedule.schedule([a, b], Command.interrupt(queueing)).interrupt,
        [a, b]
      )
      assert.deepStrictEqual(
        schedule.schedule([a, b], Command.interrupt(queueing, { key: "b" })),
        {
          action: "none",
          interrupt: [b]
        }
      )
    })
  })
})
