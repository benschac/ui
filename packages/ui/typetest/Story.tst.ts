import { Command, Component, type Query, UiSchema, type View } from "@effect/ui"
import type { Steps } from "@effect/ui/testing"
import { Scene, Story } from "@effect/ui/testing"
import { Effect, Schema, type Scope, Stream } from "effect"
import { describe, expect, it } from "tstyche"
import type { SearchBox } from "../test/fixtures/components.ts"
import {
  Counter,
  CounterMessage,
  SaveTodo,
  Search,
  SearchMessage,
  TodoItem,
  TodoItemMessage,
  Upload
} from "../test/fixtures/components.ts"

declare const counter: Story.Steps<typeof Counter>
declare const todoItem: Story.Steps<typeof TodoItem>
declare const searchBox: Story.Steps<typeof SearchBox>
declare const sceneExpect: Scene.Expect<Scene.Steps<typeof Counter>>
const increment = CounterMessage.Increment()

describe("Story", () => {
  it("has no view surface: a story drives update with messages, not clicks", () => {
    expect(counter).type.not.toHaveProperty("click")
    expect(counter).type.not.toHaveProperty("mounted")
  })

  it("a scene drives the view: it has no send and no Model", () => {
    const scene = Scene.start(Counter, { initial: 0 })
    expect(scene).type.not.toHaveProperty("send")
    expect(scene.current).type.not.toHaveProperty("model")
  })

  it("expect.toHaveAttribute accepts presence, string, RegExp or false, not true", () => {
    expect(sceneExpect.toHaveAttribute).type.toBeCallableWith("href")
    expect(sceneExpect.toHaveAttribute).type.toBeCallableWith("href", "/docs")
    expect(sceneExpect.toHaveAttribute).type.toBeCallableWith("href", /^\/docs/)
    expect(sceneExpect.toHaveAttribute).type.toBeCallableWith("disabled", false)
    expect(sceneExpect.toHaveAttribute).type.not.toBeCallableWith(
      "disabled",
      true
    )
  })

  it("a scene's child steps take the component, then a key only when the child has one", () => {
    const scene = Scene.start(Counter, { initial: 0 })
    const toggled = { _tag: "Toggled", done: true } as const
    expect(scene.childEmit).type.toBeCallableWith(TodoItem, toggled)
    expect(scene.childEmit).type.toBeCallableWith(TodoItem, "t1", toggled)
    expect(scene.childEmit).type.not.toBeCallableWith(TodoItem, {
      _tag: "Missing"
    })
    expect(scene.childEmit).type.not.toBeCallableWith("t1", toggled)
  })

  it("checks subscription messages and infers model callbacks", () => {
    const Message = UiSchema.TaggedEnum({
      Set: { value: Schema.Number },
      Reset: {}
    })
    const Setter = Component.define({
      name: "Setter",
      model: Schema.Number,
      message: Message
    }).make({
      init: () => 0,
      update: (_, message) => message._tag === "Set" ? message.value : 0,
      view: (h, model) => h.text(String(model))
    })
    const steps: Steps.Steps<typeof Setter> = Story.start(Setter, {})
    expect(steps.subscription).type.toBeCallableWith("tick", { _tag: "Reset" })
    expect(steps.subscription).type.not.toBeCallableWith("tick", {
      _tag: "Missing"
    })
    counter.send((model) => {
      expect(model).type.toBe<{ readonly count: number }>()
      return { _tag: "Increment" }
    })
    expect(counter.send).type.not.toBeCallableWith((
      _model: { readonly count: number }
    ) => "bad")
  })

  it("types steps by the component", () => {
    expect(Story.make(Counter, { initial: 0 })).type.toBe<
      Effect.Effect<Story.Steps<typeof Counter>, never, Scope.Scope>
    >()
    const story = Story.start(Counter, { initial: 0 })
    expect(story.model).type.toBe<{ readonly count: number }>()
    story
      .props((props) => {
        expect(props).type.toBe<{ readonly initial: number }>()
        return props
      })
      .send(CounterMessage.Increment())
    expect(story.current.model).type.toBe<{ readonly count: number }>()
    expect(Story.make).type.not.toBeCallableWith(Counter, { initial: "0" })
    expect(counter.send).type.not.toBeCallableWith("not a message")
    expect(counter.send).type.not.toBeCallableWith(TodoItemMessage.Save())
    expect(counter.given).type.not.toBeCallableWith({ saving: true })
  })

  it("make takes no callback", () => {
    // make takes no callback: the test yields the cursor and runs its steps
    // as chained or plain statements.
    expect(Story.make).type.toBeCallableWith(Counter, { initial: 0 })
    expect(Story.make).type.not.toBeCallableWith(
      Counter,
      { initial: 0 },
      (story: Story.Steps<typeof Counter>) =>
        story.send(increment).send(increment)
    )
    expect(Effect.gen(function*() {
      const story = yield* Story.make(Counter, { initial: 0 })
      story.send(increment).send(increment)
      story.send(increment)
    })).type.toBe<Effect.Effect<void, never, Scope.Scope>>()
  })

  it("a shared step needs no explicit generics", () => {
    const twice = (story: Story.Steps<typeof Counter>) =>
      story.send(increment).send(increment)
    expect(counter.pipe(twice)).type.toBe<Story.Steps<typeof Counter>>()
    expect(todoItem.pipe).type.not.toBeCallableWith(twice)
  })

  it("a step over any component keeps the caller's type", () => {
    const sendIncrement = <S extends Story.Steps.Any>(story: S): S =>
      story.send(increment)
    expect(sendIncrement(counter)).type.toBe<Story.Steps<typeof Counter>>()
    expect(counter.pipe(sendIncrement).current.model).type.toBe<
      { readonly count: number }
    >()
  })

  it("a step over the shared steps keeps the caller's type", () => {
    const quiet = <S extends Steps.Steps.Any>(s: S): S => s.expectNone()
    expect(quiet(counter)).type.toBe<Story.Steps<typeof Counter>>()
    expect(quiet(counter).send).type.toBeCallableWith(
      CounterMessage.Increment()
    )
    expect(counter.pipe(quiet).current.model).type.toBe<
      { readonly count: number }
    >()
    counter.check((story) => {
      expect(story.model).type.toBe<{ readonly count: number }>()
    })
  })

  it("a component with no messages is a story, with its types kept", () => {
    const Static = Component.define({
      name: "Static",
      model: Schema.Number,
      message: Schema.Never
    }).make({
      init: () => 0,
      update: ($) => $.model,
      view: (h, model) => h.el("p", String(model))
    })
    const steps = Story.start(Static, {})
    expect(steps).type.toBe<Story.Steps<typeof Static>>()
    expect(steps.current.model).type.toBe<number>()
    expect(Story.make(Static, {})).type.toBe<
      Effect.Effect<Story.Steps<typeof Static>, never, Scope.Scope>
    >()
    expect(Story.start(Static, {}).given(1).model).type.toBe<number>()
    expect(steps.send).type.not.toBeCallableWith(CounterMessage.Increment())
    const shared = <S extends Story.Steps.Any>(story: S): S => story
    expect(shared(steps)).type.toBe<Story.Steps<typeof Static>>()
  })

  it("resolves a Command with the definition's own message, or with Component.noop", () => {
    expect(todoItem.resolve).type.toBeCallableWith(
      SaveTodo,
      TodoItemMessage.Saved()
    )
    expect(todoItem.resolve).type.toBeCallableWith(SaveTodo, Component.noop)
    expect(todoItem.resolve).type.not.toBeCallableWith(
      SaveTodo,
      SearchMessage.Tick()
    )
    expect(searchBox.resolve).type.toBeCallableWith(
      Search.make({ text: "x" }),
      SearchMessage.Results({ items: [] })
    )
    expect(searchBox.resolve).type.not.toBeCallableWith(
      Search.make({ text: "x" }),
      TodoItemMessage.Saved()
    )
  })

  it("an issued Command whose result never arrives is a target, and takes no result", () => {
    const Hold = Command.make(
      "Hold",
      { args: { key: Schema.String } },
      () => Effect.never
    )
    const Watch = Command.make("Watch", {
      args: { key: Schema.String },
      stream: true
    }, () => Stream.never)
    expect(counter.expectExact).type.toBeCallableWith(
      Hold.make({ key: "one" }),
      Watch.make({ key: "one" })
    )
    expect(counter.expectHas).type.toBeCallableWith(Hold.make({ key: "one" }))
    expect(counter.end).type.toBeCallableWith(Watch.make({ key: "one" }))
    expect(counter.end).type.not.toBeCallableWith(Hold.make({ key: "one" }))
    expect(counter.resolve).type.not.toBeCallableWith(
      Hold.make({ key: "one" }),
      "anything"
    )
    expect(counter.next).type.not.toBeCallableWith(
      Watch.make({ key: "one" }),
      "anything"
    )
  })

  it("a mapped Command as the target takes the definition's own result", () => {
    const Uploaded = UiSchema.TaggedEnum({ Uploaded: { url: Schema.String } })
    const UploadFile = Command.make(
      "UploadFile",
      { args: { name: Schema.String } },
      ({ name }) => Effect.succeed(`https://cdn/${name}`)
    )
    const mapped = UploadFile.make({ name: "me.png" }).pipe(
      Command.map((url) => Uploaded.Uploaded({ url }))
    )
    expect(mapped).type.toBe<
      Command.Issued<typeof Uploaded.Type, never, string, "Effect">
    >()
    expect(counter.resolve).type.toBeCallableWith(mapped, "https://cdn/me.png")
    expect(counter.resolve).type.not.toBeCallableWith(
      mapped,
      Uploaded.Uploaded({ url: "" })
    )
    const Progress = Command.make(
      "Progress",
      { args: { name: Schema.String }, stream: true },
      () => Stream.fromIterable([1, 2])
    )
    const mappedStream = Progress.make({ name: "x" }).pipe(
      Command.map((percent) => Uploaded.Uploaded({ url: String(percent) }))
    )
    expect(counter.next).type.toBeCallableWith(mappedStream, 50)
    expect(counter.next).type.not.toBeCallableWith(
      mappedStream,
      Uploaded.Uploaded({ url: "" })
    )
    expect(counter.end).type.toBeCallableWith(mappedStream)
  })

  it("next and end only take stream Commands", () => {
    expect(searchBox.next).type.toBeCallableWith(
      Upload,
      SearchMessage.Progress({ percent: 1 })
    )
    expect(searchBox.end).type.toBeCallableWith(Upload)
    expect(searchBox.next).type.not.toBeCallableWith(
      Search,
      SearchMessage.Results({ items: [] })
    )
    expect(searchBox.end).type.not.toBeCallableWith(SaveTodo)
  })

  it("fail takes the typed failure of a Command whose body can fail", () => {
    class SaveFailed extends Schema.TaggedError<SaveFailed>()("SaveFailed", {
      reason: Schema.String
    }) {}
    class Save extends Command.Service<Save>()(
      "Save",
      {
        args: {},
        success: Schema.Never,
        error: SaveFailed,
        invalidates: () => []
      }
    ) {}
    const matched = Save.make().pipe(
      Command.match({ onSuccess: () => 1, onFailure: () => 2 })
    )
    expect(counter.fail).type.toBeCallableWith(
      Save,
      new SaveFailed({ reason: "disk full" })
    )
    expect(counter.fail).type.toBeCallableWith(
      matched,
      new SaveFailed({ reason: "disk full" })
    )
    expect(counter.fail).type.not.toBeCallableWith(Save, new Error("other"))
    expect(todoItem.fail).type.not.toBeCallableWith(
      SaveTodo,
      new Error("never fails")
    )
  })
})

describe("Story.make and Scene.make", () => {
  it("return an Effect, not the cursor: its steps need yield*", () => {
    expect(Story.make(Counter, { initial: 0 })).type.not.toHaveProperty("send")
    expect(Story.make(Counter, { initial: 0 })).type.not.toHaveProperty("model")
    expect(Scene.make(Counter, { initial: 0 })).type.not.toHaveProperty("click")
    expect(Scene.make(Counter, { initial: 0 })).type.not.toHaveProperty("view")
    expect(Scene.make(Counter, { initial: 0 })).type.toBe<
      Effect.Effect<Scene.Steps<typeof Counter>, never, Scope.Scope>
    >()
  })

  it("the cursor has the record's fields, and the methods they replace are gone", () => {
    expect(counter.model).type.toBe<{ readonly count: number }>()
    expect(counter.model).type.not.toBeAssignableTo<Function>()
    expect(counter.subscriptions).type.toBe<ReadonlyArray<string>>()
    expect(counter.subscriptions).type.not.toBeAssignableTo<Function>()
    expect(counter.queryInfo).type.toBe<ReadonlyArray<Steps.QueryInfo>>()
    expect(counter.queryInfo).type.not.toBeAssignableTo<Function>()
    expect(counter.results).type.toBe<Component.Results | undefined>()
    const scene = Scene.start(Counter, { initial: 0 })
    expect(scene.view).type.toBe<View.Node<CounterMessage, any>>()
    expect(scene.view).type.not.toBeAssignableTo<Function>()
    expect(scene.subscriptions).type.toBe<ReadonlyArray<string>>()
    expect(scene.defaultPrevented).type.toBe<boolean>()
    // The record still has them as functions.
    expect(counter.current.subscriptions).type.toBe<
      () => ReadonlyArray<string>
    >()
    expect(scene.current.view).type.toBeCallableWith()
  })
})

describe("Story's re-exports of the Steps types", () => {
  it("resolve to the Steps types", () => {
    type Read = Query.Query<{ readonly id: string }, string, never>
    expect<Story.Pending<CounterMessage>>().type.toBe<
      Steps.Pending<CounterMessage>
    >()
    expect<Story.AwaitedQuery>().type.toBe<Steps.AwaitedQuery>()
    expect<Story.QueryInfo>().type.toBe<Steps.QueryInfo>()
    expect<Story.KeyedLoad<Read>>().type.toBe<Steps.KeyedLoad<Read>>()
    expect<Story.Target>().type.toBe<Steps.Target>()
    expect<Story.StreamTarget>().type.toBe<Steps.StreamTarget>()
  })
})
