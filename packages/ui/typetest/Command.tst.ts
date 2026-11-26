import { Command, Component, Renderer, UiSchema } from "@effect/ui"
import { Context, Effect, type Layer, Schema, type Scope, Stream } from "effect"
import { describe, expect, it } from "tstyche"

const Message = UiSchema.TaggedEnum({ Got: { n: Schema.Number } })

const Fx = Command.make("Fx", { args: {} }, () => Effect.succeed("text"))
const St = Command.make(
  "St",
  { args: {}, stream: true },
  () => Stream.fromIterable(["text"])
)
class SA extends Command.Service<SA>()(
  "SA",
  {
    args: {},
    success: Schema.String,
    error: Schema.Never,
    invalidates: () => []
  }
) {}
class SB extends Command.Service<SB>()(
  "SB",
  {
    args: {},
    success: Schema.Number,
    error: Schema.Never,
    stream: true,
    invalidates: () => []
  }
) {}
class SaveFailed extends Schema.TaggedError<SaveFailed>()("SaveFailed", {
  reason: Schema.String
}) {}
class Save extends Command.Service<Save>()(
  "Save",
  {
    args: { id: Schema.String, title: Schema.String },
    success: Schema.String,
    error: SaveFailed,
    group: ["id"],
    mode: "queue",
    invalidates: () => []
  }
) {}
declare const condition: boolean
declare const $: Component.Update<{}, typeof Message.Type, never, {}>
declare const $init: Component.Init<{}, typeof Message.Type, never, {}>
declare const $never: Component.Update<{}, never, never, {}>

describe("Command", () => {
  describe("Issued", () => {
    it("only exposes the work field of its kind", () => {
      expect(Fx.make().effect).type.toBe<Effect.Effect<string, never, never>>()
      expect(Fx.make().stream).type.toBe<undefined>()
      expect(St.make().stream).type.toBe<Stream.Stream<string, never, never>>()
      expect(St.make().effect).type.toBe<undefined>()
      expect(Effect.runSync).type.not.toBeCallableWith(St.make().effect)
      expect(Stream.runCollect).type.not.toBeCallableWith(Fx.make().stream)
    })

    it("narrows on _tag", () => {
      const command: Command.Command<string> = condition ? Fx.make() : St.make()
      if (command._tag === "Effect") {
        expect(command.effect).type.toBe<Effect.Effect<string, never, never>>()
      }
      if (command._tag === "Stream") {
        expect(command.stream).type.toBe<Stream.Stream<string, never, never>>()
      }
    })
  })

  describe("map", () => {
    it("keeps the kind and the source result", () => {
      const toMessage = (text: string) => Message.Got({ n: text.length })
      expect(Fx.make().pipe(Command.map(toMessage))).type.toBe<
        Command.Issued<typeof Message.Type, never, string, "Effect">
      >()
      expect(St.make().pipe(Command.map(toMessage))).type.toBe<
        Command.Issued<typeof Message.Type, never, string, "Stream">
      >()
      expect(Command.map(Command.interrupt(Fx), toMessage)).type.toBe<
        Command.Interrupt
      >()
    })

    it("maps a mixed-kind Command to a union the component can run", () => {
      const input = condition ? Fx.make() : St.make()
      const mapped = input.pipe(
        Command.map((text) => Message.Got({ n: text.length }))
      )
      expect(mapped).type.toBe<
        | Command.Issued<typeof Message.Type, never, string, "Effect">
        | Command.Issued<typeof Message.Type, never, string, "Stream">
      >()
      expect($.run).type.toBeCallableWith(mapped)
      expect($.run).type.toBeCallableWith(
        Command.map(input, (text) => Message.Got({ n: text.length }))
      )
      expect($.run).type.not.toBeCallableWith(input)
    })

    it("chained pipeable maps keep one Command's source and requirements", () => {
      const chained = SA.make().pipe(
        Command.map((a) => a.length),
        Command.map((n) => Message.Got({ n }))
      )
      expect(chained).type.toBe<
        Command.Issued<typeof Message.Type, SA, string, "Effect">
      >()
      const stream = SB.make().pipe(
        Command.map((n) => n + 1),
        Command.map((n) => Message.Got({ n }))
      )
      expect(stream).type.toBe<
        Command.Issued<typeof Message.Type, SB, number, "Stream">
      >()
    })

    it("data-first maps keep each branch's source and requirements across a mixed union", () => {
      const input = condition
        ? Command.map(SA.make(), (a) => a.length)
        : SB.make()
      expect(input).type.toBe<
        | Command.Issued<number, SA, string, "Effect">
        | Command.Issued<number, SB, number, "Stream">
      >()
      const once = Command.map(input, (n) => n + 1)
      expect(once).type.toBe<
        | Command.Issued<number, SA, string, "Effect">
        | Command.Issued<number, SB, number, "Stream">
      >()
      const twice = Command.map(once, (n) => Message.Got({ n }))
      expect(twice).type.toBe<
        | Command.Issued<typeof Message.Type, SA, string, "Effect">
        | Command.Issued<typeof Message.Type, SB, number, "Stream">
      >()
      expect($.run).type.toBeCallableWith(twice)
      // The pipeable form infers one source for its input, so a mixed-source union
      // doesn't fit it: use the data-first form above.
      expect(input.pipe).type.not.toBeCallableWith(
        Command.map((n: number) => n + 1)
      )
    })
  })

  describe("as", () => {
    it("preserves kind, source and requirements in both forms", () => {
      const message = Message.Got({ n: 1 })
      expect(SA.make().pipe(Command.as(message))).type.toBe<
        Command.Issued<typeof Message.Type, SA, string, "Effect">
      >()
      expect(Command.as(SB.make(), message)).type.toBe<
        Command.Issued<typeof Message.Type, SB, number, "Stream">
      >()
      expect(Command.as(Command.interrupt(Fx), message)).type.toBe<
        Command.Interrupt
      >()
      const input = condition ? SA.make() : SB.make()
      expect(Command.as(input, message)).type.toBe<
        | Command.Issued<typeof Message.Type, SA, string, "Effect">
        | Command.Issued<typeof Message.Type, SB, number, "Stream">
      >()
      const matched = Save.make({ id: "t1", title: "" }).pipe(
        Command.match({ onSuccess: () => 1, onFailure: () => 0 }),
        Command.as(message)
      )
      expect(matched).type.toBe<
        Command.Issued<typeof Message.Type, Save, string, "Effect", SaveFailed>
      >()
      expect(Command.as).type.not.toBeCallableWith(
        Save.make({ id: "t1", title: "" }),
        message
      )
      expect(Command.interrupt(Fx).pipe).type.not.toBeCallableWith(
        Command.as(message)
      )
    })
  })

  describe("Service", () => {
    it("has no server option: no Command runs on the server", () => {
      const service = Command.Service<"Load">()
      expect(service).type.not.toBeCallableWith("Load", {
        args: {},
        success: Schema.Number,
        error: Schema.Never,
        invalidates: () => [],
        server: true
      })
      expect(service).type.not.toBeCallableWith("Load", {
        args: {},
        success: Schema.Number,
        error: Schema.Never,
        invalidates: () => [],
        stream: true,
        server: true
      })
      expect(Command.make).type.not.toBeCallableWith("Load", {
        args: {},
        server: true
      }, () => Effect.succeed(1))
    })

    it("requires args, success and error, allows omitted invalidates", () => {
      const service = Command.Service<"Load">()
      expect(service).type.toBeCallableWith("Load", {
        args: {},
        success: Schema.Number,
        error: Schema.Never
      })
      expect(service).type.not.toBeCallableWith("Load", {
        args: {},
        error: Schema.Never
      })
      expect(service).type.not.toBeCallableWith("Load", {
        args: {},
        success: Schema.Number
      })
      expect(service).type.not.toBeCallableWith("Load", {
        success: Schema.Number,
        error: Schema.Never,
        invalidates: () => []
      })
      expect(Command.make).type.not.toBeCallableWith(
        "Fx",
        {},
        () => Effect.succeed(1)
      )
    })

    it("types the body's args and writes from the Schemas, and make takes them", () => {
      expect(Save.make).type.toBeCallableWith({ id: "t1", title: "milk" })
      expect(Save.make).type.not.toBeCallableWith({ id: "t1" })
      expect(SA.make).type.toBeCallableWith()
      Command.Service<"WithWrites">()("WithWrites", {
        args: { id: Schema.String },
        success: Schema.Number,
        error: Schema.Never,
        writes: (count, args) => {
          expect(count).type.toBe<number>()
          expect(args).type.toBe<{ readonly id: string }>()
          return []
        }
      })
    })

    it("toLayer infers live Layers, fakes, failures and rejects mismatched bodies", () => {
      class Db
        extends Context.Service<Db, { readonly save: Effect.Effect<string> }>()(
          "Db"
        )
      {}
      const failingBuild = null as unknown as Effect.Effect<
        () => Effect.Effect<string>,
        "boom",
        Db | Scope.Scope
      >
      expect(
        SA.toLayer(Effect.gen(function*() {
          const db = yield* Db
          return () => db.save
        }))
      ).type.toBe<Layer.Layer<SA, never, Db>>()
      expect(SA.toLayer(() => Effect.succeed("ok"))).type.toBe<
        Layer.Layer<SA>
      >()
      expect(
        SA.toLayer(() => Renderer.Refs.use(() => Effect.succeed("ok")))
      ).type.toBe<Layer.Layer<SA>>()
      expect(SA.toLayer(failingBuild)).type.toBe<Layer.Layer<SA, "boom", Db>>()
      expect(SB.toLayer(() => Stream.fromIterable([1]))).type.toBe<
        Layer.Layer<SB>
      >()
      expect(SA.toLayer).type.not.toBeCallableWith(() => Effect.succeed(1))
      expect(SA.toLayer).type.not.toBeCallableWith(() => Effect.fail("boom"))
      expect(SA.toLayer).type.not.toBeCallableWith(() =>
        Stream.fromIterable(["a"])
      )
      expect(SA.toLayer).type.not.toBeCallableWith(() =>
        Db.use((db) => db.save)
      )
    })

    it("toLayer takes any result for a Component.Noop success, and only the success otherwise", () => {
      class Toggle extends Command.Service<Toggle>()("Toggle", {
        args: {},
        success: Component.Noop,
        error: Schema.Never
      }) {}
      class Watch extends Command.Service<Watch>()("Watch", {
        args: {},
        success: Component.Noop,
        error: Schema.Never,
        stream: true
      }) {}
      class Either extends Command.Service<Either>()("Either", {
        args: {},
        success: Schema.Union([Message, Component.Noop]),
        error: Schema.Never
      }) {}
      expect(Toggle.toLayer(() => Effect.succeed(true))).type.toBe<
        Layer.Layer<Toggle>
      >()
      expect(Toggle.toLayer).type.toBeCallableWith(() => Effect.void)
      expect(Toggle.toLayer).type.toBeCallableWith(() =>
        Effect.succeed(Component.noop)
      )
      expect(Toggle.toLayer).type.not.toBeCallableWith(() =>
        Effect.fail("boom")
      )
      expect(Watch.toLayer).type.toBeCallableWith(() => Stream.make(1, 2))
      expect(Toggle.make()).type.toBe<
        Command.Issued<Component.Noop, Toggle, Component.Noop, "Effect">
      >()
      expect(SA.toLayer).type.not.toBeCallableWith(() => Effect.void)
      expect(Either.toLayer).type.not.toBeCallableWith(() =>
        Effect.succeed(true)
      )
    })

    it("preserves success and error Schema types on the class", () => {
      expect(SB.success).type.toBe<typeof Schema.Number>()
      expect(SB.error).type.toBe<typeof Schema.Never>()
      expect(Save.error).type.toBe<typeof SaveFailed>()

      class Copy extends Command.Service<Copy>()("Copy", {
        args: {},
        success: SA.success,
        error: SA.error
      }) {}
      expect(Copy.toLayer(() => Effect.succeed("ok"))).type.toBe<
        Layer.Layer<Copy>
      >()
      expect(Copy.toLayer).type.not.toBeCallableWith(() => Effect.succeed(123))
      expect(Copy.toLayer).type.not.toBeCallableWith(() => Effect.fail("boom"))
    })
  })

  describe("make", () => {
    it("may only require framework services", () => {
      class Db
        extends Context.Service<Db, { readonly save: Effect.Effect<void> }>()(
          "Db"
        )
      {}
      expect(Command.make).type.toBeCallableWith(
        "Look",
        { args: {} },
        () => Renderer.Refs.use(() => Effect.succeed(1))
      )
      expect(Command.make).type.not.toBeCallableWith(
        "Bad",
        { args: {} },
        () => Db.use((db) => db.save)
      )
    })

    it("is not directly callable", () => {
      expect(Fx).type.not.toBeAssignableTo<(...args: Array<any>) => any>()
    })
  })

  describe("group", () => {
    it("names args fields whose encoded form is JSON", () => {
      expect(Command.make).type.toBeCallableWith(
        "Page",
        {
          args: { tab: Schema.String, page: Schema.NumberFromString },
          group: ["tab", "page"]
        },
        () => Effect.void
      )
      expect(Command.make).type.not.toBeCallableWith(
        "Page",
        { args: { tab: Schema.String }, group: ["other"] },
        () => Effect.void
      )
      expect(Command.make).type.not.toBeCallableWith(
        "Upload",
        { args: { file: Schema.instanceOf(File) }, group: ["file"] },
        () => Effect.void
      )
    })

    it("interrupt takes a pick of the group fields, or nothing", () => {
      expect(Command.interrupt).type.toBeCallableWith(Save, { id: "t1" })
      expect(Command.interrupt).type.toBeCallableWith(Save)
      expect(Command.interrupt).type.not.toBeCallableWith(Save, {
        title: "milk"
      })
      expect(Command.interrupt).type.not.toBeCallableWith(Fx, {})
    })
  })

  describe("match", () => {
    const matched = Save.make({ id: "t1", title: "milk" }).pipe(Command.match({
      onSuccess: (title) => Message.Got({ n: title.length }),
      onFailure: (error) => Message.Got({ n: error.reason.length })
    }))

    it("a body with a typed error issues an Unmatched Command, which $.run doesn't take", () => {
      const unmatched = Save.make({ id: "t1", title: "milk" })
      expect(unmatched).type.toBe<
        Command.Unmatched<string, SaveFailed, Save, "Effect">
      >()
      expect($.run).type.not.toBeCallableWith(unmatched)
      expect(Command.map).type.not.toBeCallableWith(
        unmatched,
        (title: string) => title
      )
    })

    it("maps both channels, keeping the source result and failure", () => {
      expect(matched).type.toBe<
        Command.Issued<typeof Message.Type, Save, string, "Effect", SaveFailed>
      >()
      expect($.run).type.toBeCallableWith(matched)
      expect<Command.Failure<typeof matched>>().type.toBe<SaveFailed>()
    })

    it("doesn't take a Command whose body can't fail", () => {
      expect(Command.match).type.not.toBeCallableWith(SA.make(), {
        onSuccess: (a: string) => a,
        onFailure: (e: never) => e
      })
    })
  })

  describe("afterRefetch", () => {
    it("takes an Effect Service Command on either side of match and map, and keeps its type", () => {
      const unmatched = Save.make({ id: "t1", title: "milk" })
      expect(unmatched.pipe(Command.afterRefetch("5 seconds"))).type.toBe<
        Command.Unmatched<string, SaveFailed, Save, "Effect">
      >()
      const matched = unmatched.pipe(
        Command.afterRefetch("Infinity"),
        Command.match({
          onSuccess: (title) => title.length,
          onFailure: (error) => error.reason.length
        })
      )
      expect(matched).type.toBe<
        Command.Issued<number, Save, string, "Effect", SaveFailed>
      >()
      expect(matched.pipe(Command.afterRefetch(5))).type.toBe<
        Command.Issued<number, Save, string, "Effect", SaveFailed>
      >()
      expect(
        SA.make().pipe(
          Command.map((a) => a.length),
          Command.afterRefetch("1 second")
        )
      ).type.toBe<
        Command.Issued<number, SA, string, "Effect">
      >()
      expect(Command.afterRefetch(SA.make(), "1 second")).type.toBe<
        Command.Issued<string, SA, string, "Effect">
      >()
    })

    it("rejects a Stream Command and a Command.make Command", () => {
      expect(Command.afterRefetch).type.not.toBeCallableWith(
        SB.make(),
        "1 second"
      )
      expect(Command.afterRefetch).type.not.toBeCallableWith(
        Fx.make(),
        "1 second"
      )
      expect(Command.afterRefetch).type.not.toBeCallableWith(
        St.make(),
        "1 second"
      )
      expect(Command.afterRefetch("1 second")).type.not.toBeCallableWith(
        Fx.make()
      )
      expect(Command.afterRefetch("1 second")).type.not.toBeCallableWith(
        SB.make()
      )
    })
  })

  describe("a Command that never produces a result", () => {
    it("is accepted by any component's $.run", () => {
      const Hold = Command.make("Hold", { args: {} }, () => Effect.never)
      const Die = Command.make("Die", { args: {} }, () => Effect.die("boom"))
      const Watch = Command.make(
        "Watch",
        { args: {}, stream: true },
        () => Stream.never
      )
      expect($.run).type.toBeCallableWith(Hold.make())
      expect($.run).type.toBeCallableWith(Die.make())
      expect($.run).type.toBeCallableWith(Watch.make())
      expect($.run).type.toBeCallableWith(
        Hold.make().pipe(
          Command.map((): typeof Message.Type => Message.Got({ n: 1 }))
        )
      )
    })
  })
  describe("Component.noop", () => {
    type Msg = typeof Message.Type
    const got = Message.Got({ n: 1 })
    const Quiet = Command.make(
      "Quiet",
      { args: {} },
      () => Effect.succeed(Component.noop)
    )
    const QuietAs = Command.make(
      "QuietAs",
      { args: {} },
      () => Effect.succeed(1).pipe(Effect.as(Component.noop))
    )
    const QuietMap = Command.make(
      "QuietMap",
      { args: {} },
      () => Effect.map(Effect.succeed(1), () => Component.noop)
    )
    const Either = Command.make(
      "Either",
      { args: {} },
      () =>
        Effect.gen(function*() {
          const n = yield* Effect.succeed(1)
          if (n > 0) return Component.noop
          return got
        })
    )
    const QuietStream = Command.make(
      "QuietStream",
      { args: {}, stream: true },
      () => Stream.make(Component.noop, got)
    )

    it("a body, a generator and a mapper may end with it, and keep its type", () => {
      expect(Quiet.make()).type.toBe<
        Command.Issued<Component.Noop, never, Component.Noop, "Effect">
      >()
      expect(QuietAs.make()).type.toBe<
        Command.Issued<Component.Noop, never, Component.Noop, "Effect">
      >()
      expect(QuietMap.make()).type.toBe<
        Command.Issued<Component.Noop, never, Component.Noop, "Effect">
      >()
      expect<
        Command.Issued<
          Msg | Component.Noop,
          never,
          Msg | Component.Noop,
          "Effect"
        >
      >().type.toBeAssignableFrom(
        Either.make()
      )
      expect(Fx.make().pipe(Command.map(() => Component.noop))).type.toBe<
        Command.Issued<Component.Noop, never, string, "Effect">
      >()
    })

    it("$.run takes a Command ending in a message, Component.noop or either, in update and init", () => {
      for (
        const command of [
          Quiet.make(),
          QuietAs.make(),
          QuietMap.make(),
          Either.make(),
          QuietStream.make()
        ]
      ) {
        expect($.run).type.toBeCallableWith(command)
        expect($init.set({}).run).type.toBeCallableWith(command)
      }
      expect($.run).type.toBeCallableWith(
        Quiet.make(),
        Fx.make().pipe(Command.as(got))
      )
    })

    it("a component whose Message is Schema.Never runs a silent Command, and nothing else", () => {
      expect($never.run).type.toBeCallableWith(Quiet.make())
      expect($never.run).type.toBeCallableWith(Fx.make().pipe(Command.asNoop))
      expect($never.run).type.not.toBeCallableWith(Either.make())
    })

    it("$.run rejects the value itself, alone or in a union with a Command, and other results", () => {
      expect($.run).type.not.toBeCallableWith(Component.noop)
      expect($init.set({}).run).type.not.toBeCallableWith(Component.noop)
      const maybe = condition ? Quiet.make() : Component.noop
      expect($.run).type.not.toBeCallableWith(maybe)
      expect($init.set({}).run).type.not.toBeCallableWith(maybe)
      expect($.run).type.not.toBeCallableWith(
        Command.make("V", { args: {} }, () => Effect.void).make()
      )
      expect($.run).type.not.toBeCallableWith(
        Command.make("U", { args: {} }, () => Effect.succeed(undefined)).make()
      )
      expect($.run).type.not.toBeCallableWith(
        Command.make("S", { args: {} }, () => Effect.succeed(Symbol.for("x")))
          .make()
      )
      expect($.run).type.not.toBeCallableWith(
        Command.make("O", { args: {} }, () => Effect.succeed({})).make()
      )
      expect($.run).type.not.toBeCallableWith(Fx.make())
    })

    it("asNoop keeps the kind, source and requirements, in both forms, and takes no Unmatched Command", () => {
      expect(Fx.make().pipe(Command.asNoop)).type.toBe<
        Command.Issued<Component.Noop, never, string, "Effect">
      >()
      expect(Command.asNoop(St.make())).type.toBe<
        Command.Issued<Component.Noop, never, string, "Stream">
      >()
      expect(SA.make().pipe(Command.asNoop)).type.toBe<
        Command.Issued<Component.Noop, SA, string, "Effect">
      >()
      expect(Command.asNoop).type.not.toBeCallableWith(
        Save.make({ id: "t1", title: "milk" })
      )
      expect(Command.asNoop).type.not.toBeCallableWith(Component.noop)
    })

    it("a match branch may end with it", () => {
      const quietOnSuccess = Save.make({ id: "t1", title: "milk" }).pipe(
        Command.match({
          onSuccess: () => Component.noop,
          onFailure: (error) => Message.Got({ n: error.reason.length })
        })
      )
      expect($.run).type.toBeCallableWith(quietOnSuccess)
      expect($never.run).type.not.toBeCallableWith(quietOnSuccess)
    })

    it("isNoop narrows both branches, and === only the true one", () => {
      const result = {} as string | Component.Noop
      if (Component.isNoop(result)) expect(result).type.toBe<Component.Noop>()
      else expect(result).type.toBe<string>()
      if (result !== Component.noop) {
        expect(result).type.toBe<string | Component.Noop>()
      }
    })
  })
})
