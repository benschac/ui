import { Command, Component, MessageLog, UiSchema } from "@effect/ui"
import { Story, TestHost } from "@effect/ui/testing"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"

const Message = UiSchema.TaggedEnum({
  Fire: { command: Schema.String },
  Queue: { n: Schema.Number, silent: Schema.Boolean },
  Got: { n: Schema.Number }
})
type Message = typeof Message.Type
const got = (n: number) => Message.Got({ n })

const Quiet = Command.make(
  "Quiet",
  { args: {} },
  () => Effect.succeed(Component.noop)
)
const Mixed = Command.make(
  "Mixed",
  { args: {}, stream: true },
  () =>
    Stream.make<Array<Message | Component.Noop>>(
      Component.noop,
      got(1),
      Component.noop,
      got(2)
    )
)
const AllQuiet = Command.make(
  "AllQuiet",
  { args: {}, stream: true },
  () => Stream.make(Component.noop, Component.noop)
)
const Empty = Command.make(
  "Empty",
  { args: {}, stream: true },
  () => Stream.empty
)
const Loud = Command.make("Loud", { args: {} }, () => Effect.succeed(got(0)))
const Queued = Command.make(
  "Queued",
  { args: { n: Schema.Number, silent: Schema.Boolean }, mode: "queue" },
  ({ n, silent }) =>
    Effect.sleep(`${10 * (3 - n)} millis`).pipe(
      Effect.as(silent ? Component.noop : got(n))
    )
)

const commands: Record<
  string,
  () => Command.Command<Message | Component.Noop>
> = {
  Quiet: () => Quiet.make(),
  Mixed: () => Mixed.make(),
  AllQuiet: () => AllQuiet.make(),
  Empty: () => Empty.make(),
  Loud: () => Loud.make(),
  LoudAsNoop: () => Loud.make().pipe(Command.asNoop)
}

/** Records every message it gets, and runs the Command a `Fire` names. */
const Recorder = Component.define({
  name: "Recorder",
  model: Schema.Array(Schema.String),
  message: Message
}).make({
  init: () => [],
  update: ($, message) => {
    const next = [
      ...$.model,
      message._tag === "Got" ? `Got ${message.n}` : message._tag
    ]
    switch (message._tag) {
      case "Fire":
        return $.set(next).run(commands[message.command]())
      case "Queue":
        return $.set(next).run(
          Queued.make({ n: message.n, silent: message.silent })
        )
      case "Got":
        return next
    }
  },
  view: (h, model) => h.el("p", model.join(","))
})

const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
  effect.pipe(Effect.scoped, Effect.provide(TestHost.layer())) as Effect.Effect<
    A,
    E
  >

const ended = (root: { readonly log: () => ReadonlyArray<MessageLog.Entry> }) =>
  root.log().flatMap((entry) => entry._tag === "CommandEnded" ? [entry] : [])

describe("Component.noop", () => {
  it.effect("a silent Effect Command sends nothing, and CommandEnded says so with the run's span", () =>
    run(Effect.gen(function*() {
      const root = yield* TestHost.mount(Recorder, {})
      root.send(Message.Fire({ command: "Quiet" }))
      yield* TestHost.settle
      assert.deepStrictEqual(root.model(), ["Fire"])
      assert.deepStrictEqual(
        root.log().filter((entry) => entry._tag === "Update").length,
        1
      )
      const [entry] = ended(root)
      assert.strictEqual(entry.name, "Quiet")
      assert.strictEqual(entry.silent, true)
      assert.strictEqual(typeof entry.spanId, "string")
      assert.strictEqual(typeof entry.traceId, "string")
      assert.deepStrictEqual(root.pending(), [])
      // The wire keeps the flag and the ids.
      const wire = MessageLog.makeEncoder().encode(entry)
      assert.deepStrictEqual(
        Schema.decodeUnknownSync(MessageLog.Wire)(
          JSON.parse(JSON.stringify(wire))
        ),
        wire
      )
      assert.deepStrictEqual(
        [(wire as any).silent, (wire as any).spanId, (wire as any).traceId],
        [true, entry.spanId, entry.traceId]
      )
    })))

  it.effect("CommandEnded of a run that sent a message has its span ids, the same as the Update's source", () =>
    run(Effect.gen(function*() {
      const root = yield* TestHost.mount(Recorder, {})
      root.send(Message.Fire({ command: "Loud" }))
      yield* TestHost.settle
      assert.deepStrictEqual(root.model(), ["Fire", "Got 0"])
      const [entry] = ended(root)
      assert.isFalse(entry.silent)
      const update = root.log().find((entry) =>
        entry._tag === "Update" && entry.source._tag === "Command"
      )
      assert.isDefined(update)
      if (update?._tag !== "Update" || update.source._tag !== "Command") return
      assert.deepStrictEqual([entry.spanId, entry.traceId], [
        update.source.spanId,
        update.source.traceId
      ])
      assert.strictEqual(typeof entry.spanId, "string")
    })))

  it.effect("asNoop silences a Command that has a message", () =>
    run(Effect.gen(function*() {
      const root = yield* TestHost.mount(Recorder, {})
      root.send(Message.Fire({ command: "LoudAsNoop" }))
      yield* TestHost.settle
      assert.deepStrictEqual(root.model(), ["Fire"])
      assert.strictEqual(ended(root)[0].silent, true)
    })))

  it.effect("a Stream's silent elements send nothing and the Stream carries on", () =>
    run(Effect.gen(function*() {
      const root = yield* TestHost.mount(Recorder, {})
      root.send(Message.Fire({ command: "Mixed" }))
      yield* TestHost.settle
      assert.deepStrictEqual(root.model(), ["Fire", "Got 1", "Got 2"])
      // Some elements had a message, so the run isn't silent.
      assert.isFalse(ended(root)[0].silent)
    })))

  it.effect("a Stream whose every element is silent is silent, and an empty Stream isn't", () =>
    run(Effect.gen(function*() {
      const root = yield* TestHost.mount(Recorder, {})
      root.send(Message.Fire({ command: "AllQuiet" }))
      root.send(Message.Fire({ command: "Empty" }))
      yield* TestHost.settle
      assert.deepStrictEqual(root.model(), ["Fire", "Fire"])
      assert.deepStrictEqual(
        ended(root).map((entry) => [entry.name, entry.silent]),
        [
          ["AllQuiet", true],
          ["Empty", false]
        ]
      )
    })))

  it.effect("queue: silent and message-bearing runs of one definition keep issue order", () =>
    run(Effect.gen(function*() {
      const root = yield* TestHost.mount(Recorder, {})
      root.send(Message.Queue({ n: 0, silent: false }))
      root.send(Message.Queue({ n: 1, silent: true }))
      root.send(Message.Queue({ n: 2, silent: false }))
      yield* TestHost.settle
      yield* TestClock.adjust("60 millis")
      yield* TestHost.settle
      assert.deepStrictEqual(root.model(), [
        "Queue",
        "Queue",
        "Queue",
        "Got 0",
        "Got 2"
      ])
      assert.deepStrictEqual(ended(root).map((entry) => entry.silent), [
        false,
        true,
        false
      ])
      assert.deepStrictEqual(root.pending(), [])
    })))

  it.effect("a story resolves a run with Component.noop, or with a result its mapper turns into it, and sends nothing", () =>
    Effect.gen(function*() {
      const story = yield* Story.make(Recorder, {})
      story.send(Message.Fire({ command: "Quiet" }))
        .resolve(Quiet, Component.noop)
      assert.deepStrictEqual(story.model, ["Fire"])
      // `resolve` takes the definition's own result, which `asNoop` maps to `Component.noop`.
      story.send(Message.Fire({ command: "LoudAsNoop" }))
        .resolve(Loud, got(0))
      assert.deepStrictEqual(story.model, ["Fire", "Fire"])
      story.expectNone()
    }))

  it.effect("a component whose Message is Schema.Never runs a silent Command", () =>
    Effect.gen(function*() {
      const Silent = Component.define({
        name: "Silent",
        model: Schema.Number,
        message: Schema.Never
      })
        .make({
          init: ($) => $.set(0).run(Quiet.make()),
          update: ($) => $.model,
          view: (h, model) => h.el("p", String(model))
        })
      const story = yield* Story.make(Silent, {})
      story.resolve(Quiet, Component.noop).expectNone()
    }))

  it.effect("a Component.Noop Service ignores its body's result and is silent", () =>
    run(Effect.gen(function*() {
      class Toggle extends Command.Service<Toggle>()("test/Toggle", {
        args: {},
        success: Component.Noop,
        error: Schema.Never
      }) {}
      const Toggler = Component.provide(
        Component.define({
          name: "Toggler",
          model: Schema.Null,
          message: Schema.Never
        }).make({
          init: ($) => $.set(null).run(Toggle.make()),
          update: ($) => $.model,
          view: (h) => h.text("")
        }),
        Toggle.toLayer(() => Effect.succeed(true))
      )
      const root = yield* TestHost.mount(Toggler, {})
      yield* TestHost.settle
      assert.deepStrictEqual(
        ended(root).map((entry) => [entry.name, entry.silent]),
        [["test/Toggle", true]]
      )
    })))

  it.effect("a Service run ends with its instance, even with its Layer provided above, and maps nothing", () =>
    run(Effect.gen(function*() {
      class Slow extends Command.Service<Slow>()(
        "test/Slow",
        {
          args: {},
          success: Schema.Void,
          error: Schema.Never,
          invalidates: () => []
        }
      ) {
        static readonly layer = this.toLayer(() => Effect.sleep("1 second"))
      }
      let mapped = 0
      const Child = Component.define({
        name: "Child",
        model: Schema.Null,
        message: Schema.Never
      }).make({
        init: ($) =>
          $.set(null).run(
            Slow.make({}).pipe(Command.map(() => {
              mapped++
              return Component.noop
            }))
          ),
        update: ($) => $.model,
        view: (h) => h.text("child")
      })
      const Close = UiSchema.TaggedEnum({ Close: {} })
      const Parent = Component.provide(
        Component.define({
          name: "Parent",
          model: Schema.Boolean,
          message: Close
        }).make({
          init: () => true,
          update: () => false,
          view: (h, open) =>
            h.el("div", [open ? Child(h, { key: "child", props: {} }) : null])
        }),
        Slow.layer
      )
      const root = yield* TestHost.mount(Parent, {})
      yield* TestHost.settle
      root.send(Close.Close())
      yield* TestHost.settle
      assert.deepStrictEqual(root.pending(), [])
      yield* TestClock.adjust("1 second")
      yield* TestHost.settle
      assert.strictEqual(mapped, 0)
      assert.deepStrictEqual(ended(root), [])
      assert.deepStrictEqual(
        root.log().flatMap((entry) =>
          entry._tag === "CommandInterrupted" ? [entry.name] : []
        ),
        ["test/Slow"]
      )
    })))
})
