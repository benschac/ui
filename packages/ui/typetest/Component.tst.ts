import {
  Command,
  Component,
  Feature,
  type Query,
  Subscription,
  UiSchema,
  type View
} from "@effect/ui"
import { Context, Effect, Layer, Schema, Scope, Stream } from "effect"
import type { KeyValueStore } from "effect/persistence"
import type { AsyncResult } from "effect/reactivity"
import { describe, expect, it } from "tstyche"
import {
  Counter,
  SaveTodo,
  Todo,
  TodoItem,
  TodoItemEvents,
  TodoItemMessage
} from "../test/fixtures/components.ts"

const Message = UiSchema.TaggedEnum({ X: {}, Y: {}, Done: {} })

class A
  extends Context.Service<A, { readonly a: Effect.Effect<void> }>()("A")
{}
class B
  extends Context.Service<B, { readonly b: Effect.Effect<void> }>()("B")
{}

class CA extends Command.Service<CA>()(
  "CA",
  { args: {}, success: Message, error: Schema.Never, invalidates: () => [] }
) {}
class CB extends Command.Service<CB>()(
  "CB",
  { args: {}, success: Message, error: Schema.Never, invalidates: () => [] }
) {}

declare const NeedsRuntime: Component.Component<
  "NeedsRuntime",
  {},
  {},
  never,
  never,
  A | Query.Cache | Scope.Scope,
  any
>
declare const runtimeLayer: Layer.Layer<
  A | Query.Cache | Scope.Scope | typeof Query.Visibility
>

declare const NeedsBoth: Component.Component<
  "NeedsBoth",
  { readonly admin: boolean },
  {},
  never,
  never,
  A | B,
  any
>
// Two Layers a factory chooses between: only `A` is in both, and each needs a service of its own.
declare const adminLayer: Layer.Layer<A | B, never, CA>
declare const guestLayer: Layer.Layer<A, never, CB>
declare const NeedsFailed: Component.Component<
  "NeedsFailed",
  { readonly admin: boolean },
  {},
  "failed",
  never,
  A | B,
  any
>

describe("Component", () => {
  describe("definition helpers", () => {
    const Def = Component.define({
      name: "Extracted",
      props: Schema.Struct({ initial: Schema.Number }),
      model: Schema.Struct({ count: Schema.Number }),
      message: Message
    })

    it("infers init's props and preserves requirements from every branch", () => {
      const init = Def.init(($) => {
        expect($.props).type.toBe<{ readonly initial: number }>()
        return $.props.initial > 0
          ? $.set({ count: $.props.initial }).run(CA.make())
          : $.set({ count: 0 }).run(CB.make())
      })
      const C = Def.make({
        init,
        update: ($) => $.model,
        view: (h) => h.el("div")
      })
      expect<Component.Requirements<typeof C>>().type.toBe<CA | CB>()
      expect(Def.init).type.not.toBeCallableWith(() => ({ count: "wrong" }))
    })

    it("infers subscriptions' inputs and preserves stream requirements and falsy entries", () => {
      const subscriptions = Def.subscriptions(({ model, props, queries }) => {
        expect(model).type.toBe<{ readonly count: number }>()
        expect(props).type.toBe<{ readonly initial: number }>()
        expect(queries).type.toBe<{}>()
        return [
          model.count > props.initial &&
          Subscription.make("a", Stream.fromEffect(Effect.as(A, Message.X()))),
          Subscription.make("b", Stream.fromEffect(Effect.as(B, Message.Y()))),
          false,
          null,
          undefined
        ]
      })
      const C = Def.make({
        init: () => ({ count: 0 }),
        update: ($) => $.model,
        subscriptions,
        view: (h) => h.el("div")
      })
      expect<Component.Requirements<typeof C>>().type.toBe<A | B>()
      expect(Def.subscriptions).type.not.toBeCallableWith(
        () => [Subscription.make("wrong", Stream.make("not a message"))]
      )
    })
  })

  describe("Requirements", () => {
    it("names the Command service, not what its implementation uses", () => {
      expect<Component.Requirements<typeof TodoItem>>().type.toBe<SaveTodo>()
      expect(SaveTodo.layer).type.toBe<
        Layer.Layer<SaveTodo, never, KeyValueStore.KeyValueStore>
      >()
    })

    it("covers every update branch", () => {
      const C = Component.define({
        name: "C",
        model: Schema.Struct({}),
        message: Message
      }).make({
        init: () => ({}),
        update: ($, message) =>
          Message.match(message, {
            X: () => $.run(CA.make()),
            Y: () => $.run(CB.make()),
            Done: () => $.model
          }),
        view: (h) => h.el("div")
      })
      expect<Component.Requirements<typeof C>>().type.toBe<CA | CB>()
    })

    it("covers every init branch", () => {
      const C = Component.define({
        name: "C",
        props: Schema.Struct({ a: Schema.Boolean }),
        model: Schema.Struct({}),
        message: Message
      }).make({
        init: ($) =>
          $.props.a ? $.set({}).run(CA.make()) : $.set({}).run(CB.make()),
        update: ($) => $.model,
        view: (h) => h.el("div")
      })
      expect<Component.Requirements<typeof C>>().type.toBe<CA | CB>()
    })

    it("covers every view branch", () => {
      const ChildA = Component.define({
        name: "ChildA",
        model: Schema.Struct({}),
        message: Message
      }).make({
        init: () => ({}),
        update: ($) => $.run(CA.make()),
        view: (h) => h.el("div")
      })
      const ChildB = Component.define({
        name: "ChildB",
        model: Schema.Struct({}),
        message: Message
      }).make({
        init: () => ({}),
        update: ($) => $.run(CB.make()),
        view: (h) => h.el("div")
      })
      const Parent = Component.define({
        name: "Parent",
        model: Schema.Struct({ a: Schema.Boolean }),
        message: Schema.Never
      }).make({
        init: () => ({ a: true }),
        update: ($) => $.model,
        view: (h, model) =>
          model.a ? ChildA(h, { key: "a" }) : ChildB(h, { key: "b" })
      })
      expect<Component.Requirements<typeof Parent>>().type.toBe<CA | CB>()
    })

    it("keeps framework services out", () => {
      const UsesScope = Command.make(
        "UsesScope",
        { args: {} },
        () => Effect.map(Scope.Scope, () => Message.Done())
      )
      // A case constructor returns just its case, so the Command issues that case.
      type Done = typeof Message.cases.Done.Type
      expect(UsesScope.make()).type.toBe<
        Command.Issued<Done, never, Done, "Effect">
      >()
      const C = Component.define({
        name: "C",
        model: Schema.Struct({}),
        message: Message
      }).make({
        init: ($) => $.set({}).run(UsesScope.make()),
        update: ($) => $.model,
        view: (h) => h.el("div")
      })
      expect<Component.Requirements<typeof C>>().type.toBe<never>()
    })
  })

  describe("Command.make", () => {
    it("rejects any service that isn't a framework service", () => {
      expect(Command.make).type.not.toBeCallableWith(
        "Save",
        { args: {} },
        () => Effect.map(A, () => Message.Done())
      )
      expect(Command.make).type.toBeCallableWith(
        "Roll",
        { args: {} },
        () => Effect.succeed(Message.Done())
      )
    })
  })

  describe("Command.Service", () => {
    it("types the implementation by its success Schema", () => {
      expect(SaveTodo.make({ id: "t1", title: "milk", done: false })).type.toBe<
        Command.Issued<TodoItemMessage, SaveTodo, TodoItemMessage, "Effect">
      >()
      expect(Layer.succeed(SaveTodo)).type.toBeCallableWith(() =>
        Effect.succeed(TodoItemMessage.Saved())
      )
      expect(Layer.succeed(SaveTodo)).type.not.toBeCallableWith(() =>
        Effect.succeed(Message.Done())
      )
    })

    it("rejects a function that reaches for a service instead of capturing it", () => {
      expect(CA.toLayer).type.not.toBeCallableWith(
        Effect.succeed(() => Effect.map(A, () => Message.Done()))
      )
      expect(CA.toLayer).type.toBeCallableWith(
        Effect.map(A, () => () => Effect.succeed(Message.Done()))
      )
    })
  })

  describe("$.run", () => {
    it("rejects a Command whose result isn't the component's message", () => {
      const $ = null as unknown as Component.Update<
        {},
        typeof Message.Type,
        never,
        {}
      >
      expect($.run).type.toBeCallableWith(CA.make())
      expect($.run).type.not.toBeCallableWith(
        SaveTodo.make({ id: "", title: "", done: false })
      )
      expect($.run).type.toBeCallableWith(Command.interrupt(CA))
    })
  })

  describe("provide", () => {
    it("removes what it provides and adds what the Layer needs", () => {
      const RowLive = Component.provide(TodoItem, [SaveTodo.layer])
      expect<Component.Requirements<typeof RowLive>>().type.toBe<
        KeyValueStore.KeyValueStore
      >()
      expect<Component.Message<typeof RowLive>>().type.toBe<TodoItemMessage>()
      const Curried = TodoItem.pipe(Component.provide(SaveTodo.layer))
      expect<Component.Requirements<typeof Curried>>().type.toBe<
        KeyValueStore.KeyValueStore
      >()
      const FromProps = Component.provide(TodoItem, (props) => {
        expect(props).type.toBe<{ readonly todo: Todo }>()
        return Layer.succeed(
          SaveTodo,
          () => Effect.succeed(TodoItemMessage.Saved())
        )
      })
      expect<Component.Requirements<typeof FromProps>>().type.toBe<never>()
      expect<Component.Props<typeof FromProps>>().type.toBe<
        { readonly todo: Todo }
      >()
    })

    it("infers a keyed provide's key from props and the Model, gives it to layer, and rejects local", () => {
      const Keyed = Component.provide(TodoItem, {
        key: (props, model) => {
          expect(props).type.toBe<{ readonly todo: Todo }>()
          expect(model).type.toBe<{ readonly saving: boolean }>()
          return props.todo.id
        },
        layer: (id) => {
          expect(id).type.toBe<string>()
          return SaveTodo.layer
        }
      })
      expect<Component.Requirements<typeof Keyed>>().type.toBe<
        KeyValueStore.KeyValueStore
      >()
      const keyed = {
        key: (props: { readonly todo: Todo }) => props.todo.id,
        layer: (_: string) => SaveTodo.layer
      }
      expect(Component.provide).type.toBeCallableWith(TodoItem, keyed, {
        server: false
      })
      expect(Component.provide).type.not.toBeCallableWith(TodoItem, keyed, {
        local: true
      })
    })

    it("removes only what every branch of a factory provides, and requires what any branch needs", () => {
      const FromProps = Component.provide(
        NeedsBoth,
        (props) => props.admin ? adminLayer : guestLayer
      )
      expect<Component.Requirements<typeof FromProps>>().type.toBe<
        B | CA | CB
      >()
      const Keyed = Component.provide(NeedsBoth, {
        key: (props) => props.admin,
        layer: (admin) => admin ? adminLayer : guestLayer
      })
      expect<Component.Requirements<typeof Keyed>>().type.toBe<B | CA | CB>()
    })

    it("requires onFailure when the Layer can fail", () => {
      const failing = Layer.effect(SaveTodo, Effect.fail("offline" as const))
      expect(Component.provide).type.not.toBeCallableWith(TodoItem, failing)
      expect(Component.provide).type.not.toBeCallableWith(TodoItem, [failing])
      expect(Component.provide).type.toBeCallableWith(TodoItem, failing, {
        onFailure: () => TodoItemMessage.SaveFailed({ reason: "offline" })
      })
      expect(Component.provide).type.not.toBeCallableWith(failing)
    })

    it("infers a fallible keyed provide's key and layer with a contextually typed onFailure", () => {
      const failingAdmin = Layer.effect(A, Effect.fail("admin" as const)).pipe(
        Layer.provideMerge(adminLayer)
      )
      const failingGuest = Layer.effect(A, Effect.fail("guest" as const)).pipe(
        Layer.provideMerge(guestLayer)
      )
      Component.provide(NeedsFailed, {
        key: (props) => props.admin,
        layer: (admin) => admin ? failingAdmin : failingGuest
      }, {
        onFailure: (failure) => {
          expect(failure).type.toBe<
            AsyncResult.Failure<never, "admin" | "guest">
          >()
          return "failed" as const
        }
      })
      expect(Component.provide).type.not.toBeCallableWith(NeedsFailed, {
        key: (props: { readonly admin: boolean }) => props.admin,
        layer: (admin: boolean) => admin ? failingAdmin : failingGuest
      })
    })

    it("never removes a service the runtime owns", () => {
      const Provided = Component.provide(NeedsRuntime, runtimeLayer)
      expect<Component.Requirements<typeof Provided>>().type.toBe<
        Query.Cache | Scope.Scope
      >()
    })
  })

  describe("Feature.Service", () => {
    class Todos extends Feature.Service<Todos>()("Todos", {
      props: Schema.Struct({ todo: Todo }),
      events: TodoItemEvents
    }) {}

    it("accepts an implementation matching the contract and rejects another", () => {
      expect(Todos.toLayer(TodoItem)).type.toBe<
        Layer.Layer<Todos, never, SaveTodo>
      >()
      expect(Todos.toLayer).type.not.toBeCallableWith(Counter)
    })

    it("names the missing fallback for a feature child", () => {
      const h = null as unknown as View.Helper<never, {}>
      // @ts-expect-error Property 'fallback' is missing
      Todos.render(h, {
        key: "main",
        props: { todo: { id: "", title: "", done: false } }
      })
    })

    it("surfaces only the feature service in the parent", () => {
      const Parent = Component.define({
        name: "Parent",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) =>
          h.el(
            "div",
            Todos.render(h, {
              key: "main",
              props: { todo: { id: "", title: "", done: false } },
              fallback: () => h.el("p", "loading")
            }),
            Counter(h, { key: "count", props: { initial: 0 } })
          )
      })
      expect<Component.Requirements<typeof Parent>>().type.toBe<Todos>()
    })
  })

  describe("lazy", () => {
    const ParentMessage = UiSchema.TaggedEnum({
      Toggled: { done: Schema.Boolean }
    })
    type ParentMessage = typeof ParentMessage.Type
    const ParentDef = Component.define({
      name: "Parent",
      model: Schema.Null,
      message: ParentMessage
    })
    const todo = { id: "", title: "", done: false }
    const LazyTodo = Component.lazy("LazyTodo", () => Promise.resolve(TodoItem))

    it("reads props, events, requirements and fallback result from the loaded component", () => {
      expect(LazyTodo).type.toBe<
        Component.Lazy<
          { readonly todo: typeof Todo.Type },
          typeof TodoItemEvents.Type,
          SaveTodo
        >
      >()
      ParentDef.view((h) => {
        expect(
          LazyTodo(h, {
            props: { todo },
            onEmit: (events) => ParentMessage.make(events),
            fallback: (result) => {
              expect(result).type.toBe<
                | AsyncResult.Initial<never, unknown>
                | AsyncResult.Failure<never, unknown>
              >()
              return h.el("p")
            }
          })
        ).type.toBe<View.Child<ParentMessage, SaveTodo>>()
        expect(LazyTodo).type.not.toBeCallableWith(h, {
          props: { todo },
          onEmit: () => Message.X()
        })
        expect(LazyTodo).type.not.toBeCallableWith(h, {})
        return h.el("p")
      })
    })

    it("takes h, or the s of h.keepAlive with the key it checks", () => {
      const Plain = Component.define({
        name: "Plain",
        model: Schema.Null,
        message: Schema.Never
      })
        .make({
          init: () => null,
          update: ($) => $.model,
          view: (h) => h.el("p")
        })
      const LazyPlain = Component.lazy(
        "LazyPlain",
        () => Promise.resolve(Plain)
      )
      expect(LazyPlain).type.toBe<Component.Lazy<{}, never>>()
      ParentDef.view((h) =>
        h.el(
          "div",
          LazyPlain(h, { key: String(1) }),
          h.keepAlive((s) => {
            expect(LazyPlain(s, { key: "s", fallback: () => h.el("p") })).type
              .toBe<View.Child<ParentMessage, never>>()
            // @ts-expect-error A keep-alive child whose key isn't a literal needs a predicate
            LazyPlain(s, { key: String(1) })
            return LazyPlain(s, { key: "s" })
          })
        )
      )
    })

    it("takes no headless component", () => {
      const Headless = Component.define({
        name: "Headless",
        model: Schema.Null,
        message: Schema.Never
      })
        .make({ init: () => null, update: ($) => $.model, parts: () => ({}) })
      expect(Component.lazy).type.not.toBeCallableWith(
        "Headless",
        () => Promise.resolve(Headless)
      )
    })
  })

  describe("calling a component", () => {
    const ParentMessage = UiSchema.TaggedEnum({
      Toggled: { done: Schema.Boolean }
    })
    type ParentMessage = typeof ParentMessage.Type
    const ParentDef = Component.define({
      name: "Parent",
      model: Schema.Null,
      message: ParentMessage
    })
    const todo = { id: "", title: "", done: false }

    it("builds a child typed by h's messages, requiring what the component does", () => {
      ParentDef.view((h) => {
        expect(TodoItem(h, { key: "t", props: { todo } })).type.toBe<
          View.Child<ParentMessage, SaveTodo>
        >()
        expect(
          TodoItem(h, {
            key: "t",
            props: { todo },
            onEmit: (events) => ParentMessage.make(events)
          })
        ).type
          .toBe<View.Child<ParentMessage, SaveTodo>>()
        expect(TodoItem).type.not.toBeCallableWith(h, {
          key: "t",
          props: { todo },
          onEmit: () => Message.X()
        })
        expect(TodoItem).type.not.toBeCallableWith(h, { key: "t" })
        expect(TodoItem).type.not.toBeCallableWith(h, {
          key: "t",
          props: { initial: 0 }
        })
        return h.el("p")
      })
    })

    it("adds a fallback's requirements to the parent's", () => {
      const Parent = ParentDef.make({
        init: () => null,
        update: ($) => $.model,
        view: (h) =>
          Counter(h, {
            key: "c",
            props: { initial: 0 },
            fallback: () => TodoItem(h, { key: "t", props: { todo } })
          })
      })
      // As with any child, the fallback's requirements come back as `NoInfer<SaveTodo>`.
      expect<Component.Requirements<typeof Parent>>().type.toBeAssignableTo<
        SaveTodo
      >()
      expect<Component.Requirements<typeof Parent>>().type.toBeAssignableFrom<
        SaveTodo
      >()
    })

    it("keeps the component's fields next to the call signature", () => {
      expect(TodoItem.definition).type.toBe<
        Component.Definition.Of<"TodoItem">
      >()
      expect(TodoItem.definition.name).type.toBe<"TodoItem">()
      expect(Component.provide(TodoItem, [SaveTodo.layer]).definition.name).type
        .toBe<"TodoItem">()
      expect(TodoItem).type.toBeAssignableTo<Component.Any>()
      expect(TodoItem).type.toBeAssignableTo<
        Component.Mountable<
          { readonly todo: typeof Todo.Type },
          typeof TodoItemEvents.Type,
          SaveTodo
        >
      >()
    })

    it("leaves the helper without child", () => {
      expect<View.Helper<ParentMessage, {}>>().type.not.toHaveProperty("child")
    })
  })
})
