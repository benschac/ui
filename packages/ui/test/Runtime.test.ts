import {
  Command,
  Component,
  Feature,
  MessageLog,
  Mount,
  Query,
  Renderer,
  Subscription,
  UiSchema,
  View
} from "@effect/ui"
import { Html, HtmlCommand } from "@effect/ui/html"
import * as hydrateRun from "@effect/ui/internal/hydrateRun"
import * as runtime from "@effect/ui/internal/runtime"
import { Locator, Story, TestHost } from "@effect/ui/testing"
import { assert, describe, it } from "@effect/vitest"
import {
  Cause,
  Console,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  LayerMap,
  Logger,
  Metric,
  Option,
  Queue,
  Redacted,
  Scheduler,
  Schema,
  SchemaTransformation,
  Scope,
  Stream,
  Tracer
} from "effect"
import { AsyncResult } from "effect/reactivity"
import { TestClock } from "effect/testing"
import { Counter, CounterMessage } from "./fixtures/components.ts"
import { Tiny, type TinyField } from "./fixtures/vocabulary.ts"

const provideHost = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(TestHost.layer()))
const tags = (
  root: { readonly log: () => ReadonlyArray<MessageLog.Entry> },
  path?: string
) =>
  root.log().filter((entry) =>
    path === undefined || ("path" in entry && entry.path === path)
  ).map((entry) => entry._tag)
const click = (root: TestHost.TestRoot<any, any, any>, text: string) =>
  Locator.fire(root.get(Locator.text(text, { exact: true })), "click")

// ---------------------------------------------------------------------------
// A keyed list whose rows hold a Command open until they unmount
// ---------------------------------------------------------------------------

const RowMessage = UiSchema.TaggedEnum({ Bump: {} })

const Hold = Command.make("Hold", { args: {} }, () => Effect.never)
const Row = Component.define({
  name: "Row",
  props: Schema.Struct({ id: Schema.String }),
  model: Schema.Number,
  message: RowMessage
}).make({
  init: ($) => $.set(0).run(Hold.make()),
  update: ($) => $.model + 1,
  view: (h, count) =>
    h.el("li").on("click", RowMessage.Bump()).children(`${h.props.id}:${count}`)
})

const ListMessage = UiSchema.TaggedEnum({
  Add: { id: Schema.String },
  Remove: { id: Schema.String },
  Reverse: {}
})
const List = Component.define({
  name: "List",
  props: Schema.Struct({ ids: Schema.Array(Schema.String) }),
  model: Schema.Array(Schema.String),
  message: ListMessage
}).make({
  init: ($) => $.props.ids,
  update: ($, message) =>
    ListMessage.match(message, {
      Add: ({ id }) => [...$.model, id],
      Remove: ({ id }) => $.model.filter((x) => x !== id),
      Reverse: () => [...$.model].reverse()
    }),
  view: (h, ids) =>
    h.el("ul", ids.map((id) => Row(h, { key: id, props: { id } })))
})

describe("Runtime", () => {
  it.effect("rejects a different shared owner with the same name at mount", () =>
    provideHost(Effect.gen(function*() {
      const state = { model: Schema.Null, message: Schema.Never }
      const impl = { init: () => null, update: () => null }
      const provider = () =>
        Component.define({
          ...state,
          name: "Provider",
          shares: () => "value"
        }).make({
          ...impl,
          parts: () => ({})
        })
      const Expected = provider()
      const Other = provider()
      const Reader = Component.define({
        ...state,
        name: "Reader",
        reads: { value: Expected }
      }).make({
        ...impl,
        view: (h) => h.el("p", h.reads.value)
      })
      const App = Component.define({ ...state, name: "App" })
        .make({
          ...impl,
          view: (h) =>
            Other(h, { key: "other", view: () => Reader(h, { key: "reader" }) })
        })
      const root = yield* TestHost.mount(App, {})
      yield* TestHost.settle
      const failed = root.log().find((entry) =>
        entry._tag === "Failed"
      ) as MessageLog.Failed
      assert.include(
        Cause.pretty(failed.cause),
        "a different component with the same name is above it"
      )
    })))

  it.effect("renders, handles an event and re-renders after settle", () =>
    provideHost(Effect.gen(function*() {
      const root = yield* TestHost.mount(Counter, { initial: 1 })
      assert.strictEqual(root.text(), "-1+")
      click(root, "+")
      click(root, "+")
      yield* TestHost.settle
      assert.strictEqual(root.text(), "-3+")
      assert.deepStrictEqual(root.model(), { count: 3 })
      assert.deepStrictEqual(tags(root), [
        "SessionStarted",
        "Mounted",
        "Update",
        "Update"
      ])
      const update = root.log()[2] as MessageLog.Update
      assert.deepStrictEqual(update.source, { _tag: "DomEvent", name: "click" })
      assert.deepStrictEqual(update.message, CounterMessage.Increment())
    })))

  it.effect("only the innermost handler fires", () =>
    provideHost(Effect.gen(function*() {
      const Msg = UiSchema.TaggedEnum({ Outer: {}, Inner: {} })
      const Nested = Component.define({
        name: "Nested",
        model: Schema.Array(Schema.String),
        message: Msg
      }).make({
        init: () => [],
        update: ($, message) => [...$.model, message._tag],
        view: (h) =>
          h.el("div").on("click", Msg.Outer()).children(
            h.el("button").on("click", Msg.Inner()).children("inner"),
            h.el("span", "plain")
          )
      })
      const root = yield* TestHost.mount(Nested, {})
      click(root, "inner")
      click(root, "plain")
      yield* TestHost.settle
      assert.deepStrictEqual(root.model(), ["Inner", "Outer"])
    })))

  it.effect("an event reaches a handler below thousands of elements", () =>
    provideHost(Effect.gen(function*() {
      const Deep = Component.define({
        name: "Deep",
        model: Schema.Number,
        message: Schema.Null
      }).make({
        init: () => 0,
        update: ($) => $.model + 1,
        view: (h) => {
          let node = h.el("button").on("click", null).children("deep")
          for (let depth = 0; depth < 3000; depth++) node = h.el("div", node)
          return node
        }
      })
      const root = yield* TestHost.mount(Deep, {})
      click(root, "deep")
      yield* TestHost.settle
      assert.strictEqual(root.model(), 1)
    })))

  describe("keyed list", () => {
    it.effect("tells an element's key from a child's", () =>
      provideHost(Effect.gen(function*() {
        const Leaf = Html.component({
          name: "Leaf",
          model: Schema.Null,
          message: Schema.Never
        }).make({
          init: () => null,
          update: ($) => $.model,
          view: (h) => h.p("leaf")
        })
        const Mixed = Html.component({
          name: "Mixed",
          model: Schema.Boolean,
          message: Schema.Boolean
        }).make({
          init: () => false,
          update: (_, flipped) => flipped,
          view: (h, flipped) =>
            h.ul(
              flipped
                ? [Leaf(h, { key: "x" }), h.li.key("x").children("row")]
                : [
                  h.li("first"),
                  h.li.key("x").children("row"),
                  Leaf(h, { key: "x" })
                ]
            )
        })
        const root = yield* TestHost.mount(Mixed, {})
        const row = root.get(Locator.text("row", { exact: true }))
        const leaf = root.get(Locator.text("leaf", { exact: true }))
        root.send(true)
        yield* TestHost.settle
        assert.strictEqual(root.text(), "leafrow")
        assert.strictEqual(root.get(Locator.text("row", { exact: true })), row)
        assert.strictEqual(
          root.get(Locator.text("leaf", { exact: true })),
          leaf
        )
      })))

    it.effect("adds, removes and reorders children, closing the Scopes of the removed ones", () =>
      provideHost(Effect.gen(function*() {
        const root = yield* TestHost.mount(List, { ids: ["a", "b", "c"] })
        yield* TestHost.settle
        const testHost = yield* TestHost.TestHost
        const items = () => root.all(Locator.tag("li"))
        const [a, b, c] = items()
        assert.strictEqual(root.text(), "a:0b:0c:0")
        assert.deepStrictEqual(root.pending().map((p) => p.path), [
          "/List/Row[a]",
          "/List/Row[b]",
          "/List/Row[c]"
        ])

        // A row keeps its Model and node across moves.
        click(root, "b:0")
        yield* TestHost.settle
        testHost.host.clearOperations()
        root.send(ListMessage.Reverse())
        yield* TestHost.settle
        assert.strictEqual(root.text(), "c:0b:1a:0")
        assert.deepStrictEqual(items(), [c, b, a])
        assert.isFalse(
          testHost.host.operations().some((op) => op.startsWith("create"))
        )

        root.send(ListMessage.Remove({ id: "b" }))
        root.send(ListMessage.Add({ id: "d" }))
        yield* TestHost.settle
        assert.strictEqual(root.text(), "c:0a:0d:0")
        assert.deepStrictEqual(items().slice(0, 2), [c, a])
        assert.deepStrictEqual(tags(root, "/List/Row[b]").slice(-2), [
          "Unmounted",
          "CommandInterrupted"
        ])
        assert.sameMembers(root.pending().map((p) => p.path), [
          "/List/Row[c]",
          "/List/Row[a]",
          "/List/Row[d]"
        ])
      })))

    it.effect("a view wrapped by hand is called on its component with each row's path as a string, whatever its own call is", () =>
      provideHost(Effect.gen(function*() {
        const state = { model: Schema.Null, message: Schema.Never }
        const Badge = Component.define({
          ...state,
          name: "Badge"
        }).make({
          init: () => null,
          update: () => null,
          view: (h) => h.el("li", h.id("label"))
        })
        const given: Array<unknown> = []
        // A method, as a hand-written view can be, with the fifth parameter typed as a string, as the
        // public type has it. It carries its own `call`, as a decorated function can.
        const view = Object.assign(
          function(
            this: typeof Badge,
            ...[model, props, running, queries, path]: Parameters<
              Component.Any["view"]
            >
          ) {
            given.push([this.definition.name, path])
            return Badge.view(
              model,
              props,
              running,
              queries,
              path?.toUpperCase()
            )
          },
          { call: "metadata" }
        )
        const Wrapped = Object.assign(Object.create(Badge) as typeof Badge, {
          view
        })
        const Rows = Component.define({ ...state, name: "Rows" })
          .make({
            init: () => null,
            update: () => null,
            view: (h) =>
              h.el(
                "ul",
                ["a", "b"].map((key) => ({
                  ...Badge(h, { key }),
                  component: Wrapped
                }))
              )
          })
        const root = yield* TestHost.mount(Rows, {})
        assert.deepStrictEqual(given, [["Badge", "/Rows/Badge[a]"], [
          "Badge",
          "/Rows/Badge[b]"
        ]])
        assert.strictEqual(
          root.text(),
          View.idOf("/ROWS/BADGE[A]", "label") +
            View.idOf("/ROWS/BADGE[B]", "label")
        )
      })))

    it.effect("closing the mount's Scope unmounts every instance", () =>
      Effect.gen(function*() {
        const testHost = yield* TestHost.TestHost
        const root = yield* Effect.scoped(Effect.gen(function*() {
          const root = yield* TestHost.mount(List, { ids: ["a", "b"] })
          yield* TestHost.settle
          return root
        }))
        yield* TestHost.settle
        const unmounted = testHost.log.entries().filter((entry) =>
          entry._tag === "Unmounted"
        ).map((entry) => entry.path)
        assert.sameMembers(unmounted, ["/List", "/List/Row[a]", "/List/Row[b]"])
        // Descendants close first.
        assert.strictEqual(unmounted.at(-1), "/List")
        assert.deepStrictEqual(root.container.children, [])
      }).pipe(Effect.provide(TestHost.layer())))

    it.effect("a child made again at its path before the old one closes is still its parent's child", () =>
      provideHost(Effect.gen(function*() {
        const Wrap = Component.define({
          name: "Wrap",
          model: Schema.Boolean,
          message: Schema.Boolean
        })
          .make({
            init: () => false,
            update: (_, changed) => changed,
            // A wrapper with another tag is a new element: the row in it mounts before the old one closes.
            view: (h, changed) =>
              h.el(
                changed ? "section" : "div",
                Row(h, { key: "a", props: { id: "a" } })
              )
          })
        const root = yield* TestHost.mount(Wrap, {})
        yield* TestHost.settle
        assert.deepStrictEqual(root.pending().map((p) => p.path), [
          "/Wrap/Row[a]"
        ])
        root.send(true)
        yield* TestHost.settle
        assert.strictEqual(root.text(), "a:0")
        const rows = root.log().filter((
          entry
        ): entry is MessageLog.Mounted | MessageLog.Unmounted =>
          (entry._tag === "Mounted" || entry._tag === "Unmounted") &&
          entry.path === "/Wrap/Row[a]"
        )
        assert.deepStrictEqual(rows.map((entry) => entry._tag), [
          "Mounted",
          "Mounted",
          "Unmounted"
        ])
        // One path, two instances: the number says which of them unmounted.
        assert.notStrictEqual(rows[0].instance, rows[1].instance)
        assert.strictEqual(rows[2].instance, rows[0].instance)
        // The new row's Command, which the parent finds through its children.
        assert.deepStrictEqual(root.pending().map((p) => p.path), [
          "/Wrap/Row[a]"
        ])
      })))

    const RowsMessage = UiSchema.TaggedEnum({
      Show: { ids: Schema.Array(Schema.String) },
      Select: { id: Schema.String }
    })
    const Rows = Component.define({
      name: "Rows",
      model: Schema.Struct({
        ids: Schema.Array(Schema.String),
        selected: Schema.String
      }),
      message: RowsMessage
    }).make({
      init: () => ({ ids: ["a", "b", "c", "d"], selected: "" }),
      update: ($, message) =>
        RowsMessage.match(message, {
          Show: ({ ids }) => ({ ...$.model, ids }),
          Select: ({ id }) => ({ ...$.model, selected: id })
        }),
      view: (h, model) =>
        h.el(
          "ul",
          h.el("li", "head"),
          model.ids.map((id) =>
            h.el("li").key(id).attr(
              "class",
              model.selected === id ? "on" : undefined
            ).children(id)
          ),
          h.el("li", "foot")
        )
    })

    it.effect("keyed elements keep their nodes across moves, beside siblings matched by position", () =>
      provideHost(Effect.gen(function*() {
        const root = yield* TestHost.mount(Rows, {})
        yield* TestHost.settle
        const testHost = yield* TestHost.TestHost
        const items = () => root.all(Locator.tag("li"))
        const [head, a, b, c, d] = items()
        testHost.host.clearOperations()
        root.send(RowsMessage.Show({ ids: ["a", "d", "c", "b"] }))
        yield* TestHost.settle
        assert.strictEqual(root.text(), "headadcbfoot")
        assert.deepStrictEqual(items().slice(0, 5), [head, a, d, c, b])
        assert.isFalse(
          testHost.host.operations().some((op) =>
            op.startsWith("create") || op.startsWith("remove")
          )
        )

        root.send(RowsMessage.Show({ ids: ["c", "e"] }))
        yield* TestHost.settle
        assert.strictEqual(root.text(), "headcefoot")
        assert.strictEqual(items()[0], head)
        assert.strictEqual(items()[1], c)
        assert.notInclude(items(), a)
      })))

    it.effect("a re-render where nothing moved inserts no node", () =>
      provideHost(Effect.gen(function*() {
        const root = yield* TestHost.mount(Rows, {})
        yield* TestHost.settle
        const testHost = yield* TestHost.TestHost
        testHost.host.clearOperations()
        root.send(RowsMessage.Select({ id: "b" }))
        yield* TestHost.settle
        root.send(RowsMessage.Select({ id: "c" }))
        yield* TestHost.settle
        assert.deepStrictEqual(
          testHost.host.operations().filter((op) => !op.startsWith("head")),
          [
            "attr <li> class=\"on\"",
            "attr <li> class=(removed)",
            "attr <li> class=\"on\""
          ]
        )
      })))

    it.effect("a reorder moves only the nodes out of order", () =>
      provideHost(Effect.gen(function*() {
        const root = yield* TestHost.mount(Rows, {})
        yield* TestHost.settle
        const testHost = yield* TestHost.TestHost
        root.send(RowsMessage.Show({ ids: ["a", "b", "c", "d", "e", "f"] }))
        yield* TestHost.settle
        const moves = () =>
          testHost.host.operations().filter((op) =>
            op.startsWith("insert <li>")
          )
        testHost.host.clearOperations()
        root.send(RowsMessage.Show({ ids: ["f", "b", "c", "d", "e", "a"] }))
        yield* TestHost.settle
        assert.strictEqual(root.text(), "headfbcdeafoot")
        assert.strictEqual(moves().length, 2)

        testHost.host.clearOperations()
        root.send(RowsMessage.Show({ ids: ["x", "e", "b", "c", "f", "d"] }))
        yield* TestHost.settle
        assert.strictEqual(root.text(), "headxebcfdfoot")
        // x is new, and b, c, d, the longest run already in order, stay: only e and f move.
        assert.strictEqual(moves().length, 3)

        // The first rows stayed in order: only d, out of order after them, moves.
        testHost.host.clearOperations()
        root.send(RowsMessage.Show({ ids: ["x", "e", "b", "d", "c", "f"] }))
        yield* TestHost.settle
        assert.strictEqual(root.text(), "headxebdcffoot")
        assert.deepStrictEqual(moves(), ["insert <li> before <li>"])
      })))

    it.effect("rows added or removed at the end touch no other node", () =>
      provideHost(Effect.gen(function*() {
        const root = yield* TestHost.mount(Rows, {})
        yield* TestHost.settle
        const testHost = yield* TestHost.TestHost
        const items = () => root.all(Locator.tag("li"))
        const before = items()
        const structural = () =>
          testHost.host.operations().filter((op) =>
            op.startsWith("insert") || op.startsWith("remove") ||
            op.startsWith("create")
          )

        // `foot` has no key, so it is matched by position and made again where the count changes.
        testHost.host.clearOperations()
        root.send(RowsMessage.Show({ ids: ["a", "b", "c", "d", "e", "f"] }))
        yield* TestHost.settle
        assert.strictEqual(root.text(), "headabcdeffoot")
        assert.deepStrictEqual(items().slice(0, 5), before.slice(0, 5))
        assert.strictEqual(
          structural().filter((op) => op.startsWith("insert <li>")).length,
          3
        )

        testHost.host.clearOperations()
        root.send(RowsMessage.Show({ ids: ["a", "b"] }))
        yield* TestHost.settle
        assert.strictEqual(root.text(), "headabfoot")
        assert.deepStrictEqual(items().slice(0, 3), before.slice(0, 3))
        assert.strictEqual(
          structural().filter((op) => op.startsWith("insert <li>")).length,
          1
        )
      })))

    it.effect("a list with nothing after it grows and shrinks at its end", () =>
      provideHost(Effect.gen(function*() {
        const Msg = Schema.Array(Schema.String)
        const Tail = Component.define({
          name: "Tail",
          model: Msg,
          message: Msg
        }).make({
          init: () => ["a", "b"],
          update: (_, ids) => ids,
          view: (h, ids) =>
            h.el("ul", ids.map((id) => h.el("li").key(id).children(id)))
        })
        const root = yield* TestHost.mount(Tail, {}, {
          fallback: (_, h) => h.el("h1", "down")
        })
        yield* TestHost.settle
        const testHost = yield* TestHost.TestHost
        const items = () => root.all(Locator.tag("li"))
        const [a, b] = items()

        testHost.host.clearOperations()
        root.send(["a", "b", "c", "d"])
        yield* TestHost.settle
        assert.strictEqual(root.text(), "abcd")
        assert.deepStrictEqual(items().slice(0, 2), [a, b])
        assert.strictEqual(
          testHost.host.operations().filter((op) =>
            op.startsWith("insert <li>")
          ).length,
          2
        )

        const [, , c] = items()
        testHost.host.clearOperations()
        root.send(["a", "b", "c"])
        yield* TestHost.settle
        assert.deepStrictEqual(items(), [a, b, c])
        assert.isFalse(
          testHost.host.operations().some((op) => op.startsWith("insert"))
        )

        root.send([])
        yield* TestHost.settle
        assert.deepStrictEqual(items(), [])
        root.send(["x", "y"])
        yield* TestHost.settle
        assert.strictEqual(root.text(), "xy")

        // A key the rows that stayed already hold fails the render, though only the end changed.
        root.send(["x", "y", "x"])
        const crashed = yield* Effect.flip(TestHost.settle)
        assert.strictEqual(crashed._tag, "RootCrashed")
        const failed = root.log().find((entry) =>
          entry._tag === "Failed"
        ) as MessageLog.Failed
        assert.include(
          Cause.pretty(failed.cause),
          "/Tail: two siblings share the key li[x]"
        )
      })))

    it.effect("an empty list filled with one key twice fails the instance", () =>
      provideHost(Effect.gen(function*() {
        const Msg = Schema.Array(Schema.String)
        const Fill = Component.define({
          name: "Fill",
          model: Msg,
          message: Msg
        }).make({
          init: (): ReadonlyArray<string> => [],
          update: (_, ids) => ids,
          view: (h, ids) =>
            h.el("ul", ids.map((id) => h.el("li").key(id).children(id)))
        })
        const root = yield* TestHost.mount(Fill, {}, {
          fallback: (_, h) => h.el("h1", "down")
        })
        yield* TestHost.settle
        root.send(["a", "b", "a"])
        const crashed = yield* Effect.flip(TestHost.settle)
        assert.strictEqual(crashed._tag, "RootCrashed")
        assert.strictEqual(root.text(), "down")
        const failed = root.log().find((entry) =>
          entry._tag === "Failed"
        ) as MessageLog.Failed
        assert.strictEqual(failed.in, "view")
        assert.include(
          Cause.pretty(failed.cause),
          "/Fill: two siblings share the key li[a]"
        )
      })))

    it.effect("a first render with one key twice fails the instance", () =>
      provideHost(Effect.gen(function*() {
        const Twice = Component.define({
          name: "Twice",
          model: Schema.Null,
          message: Schema.Never
        })
          .make({
            init: () => null,
            update: ($) => $.model,
            view: (h) =>
              h.el(
                "ul",
                ["a", "b", "a"].map((id) => h.el("li").key(id).children(id))
              )
          })
        const Parent = Component.define({
          name: "Parent",
          model: Schema.Null,
          message: Schema.Never
        })
          .make({
            init: () => null,
            update: ($) => $.model,
            view: (h) =>
              h.el(
                "div",
                "before ",
                Twice(h, {
                  key: "t",
                  props: {},
                  fallback: () => h.text("down")
                })
              )
          })
        const root = yield* TestHost.mount(Parent, {})
        yield* TestHost.settle
        assert.strictEqual(root.text(), "before down")
        assert.deepStrictEqual(root.all(Locator.tag("li")), [])
        const failed = root.log().find((entry) =>
          entry._tag === "Failed"
        ) as MessageLog.Failed
        assert.strictEqual(failed.in, "view")
        assert.include(
          Cause.pretty(failed.cause),
          "/Parent/Twice[t]: two siblings share the key li[a]"
        )
      })))

    it.effect("attributes that went are removed before the ones that changed are set", () =>
      provideHost(Effect.gen(function*() {
        const Attrs = Component.define({
          name: "Attrs",
          model: Schema.Number,
          message: Schema.Number
        })
          .make({
            init: () => 0,
            update: (_, step) => step,
            view: (h, step) =>
              step === 0
                ? h.el("p").attrs({ id: "a", title: "t", constructor: "c" })
                  .children("x")
                : step === 1
                ? h.el("p").attrs({ id: "b", lang: "en" }).children("x")
                : h.el("p").children("x")
          })
        const root = yield* TestHost.mount(Attrs, {})
        yield* TestHost.settle
        const testHost = yield* TestHost.TestHost
        const attrs = () =>
          testHost.host.operations().filter((op) => op.startsWith("attr"))
        testHost.host.clearOperations()
        root.send(1)
        yield* TestHost.settle
        assert.deepStrictEqual(attrs(), [
          "attr <p> title=(removed)",
          "attr <p> constructor=(removed)",
          "attr <p> id=\"b\"",
          "attr <p> lang=\"en\""
        ])
        testHost.host.clearOperations()
        root.send(2)
        yield* TestHost.settle
        assert.deepStrictEqual(attrs(), [
          "attr <p> id=(removed)",
          "attr <p> lang=(removed)"
        ])
        testHost.host.clearOperations()
        root.send(0)
        yield* TestHost.settle
        assert.deepStrictEqual(attrs(), [
          "attr <p> id=\"a\"",
          "attr <p> title=\"t\"",
          "attr <p> constructor=\"c\""
        ])
      })))

    it.effect("a row inserted or removed in the middle leaves the rows around it alone", () =>
      provideHost(Effect.gen(function*() {
        const root = yield* TestHost.mount(Rows, {})
        yield* TestHost.settle
        const testHost = yield* TestHost.TestHost
        const items = () => root.all(Locator.tag("li"))
        const [head, a, b, c, d] = items()
        // Without `foot`, which has no key and is made again where the count changes.
        const moves = () =>
          testHost.host.operations().filter((op) =>
            op.startsWith("insert <li>")
          ).length - 1

        testHost.host.clearOperations()
        root.send(RowsMessage.Show({ ids: ["a", "b", "x", "c", "d"] }))
        yield* TestHost.settle
        assert.strictEqual(root.text(), "headabxcdfoot")
        const x = items()[3]
        assert.deepStrictEqual(items().slice(0, 6), [head, a, b, x, c, d])
        assert.strictEqual(moves(), 1)

        testHost.host.clearOperations()
        root.send(RowsMessage.Show({ ids: ["a", "x", "d"] }))
        yield* TestHost.settle
        assert.strictEqual(root.text(), "headaxdfoot")
        assert.deepStrictEqual(items().slice(0, 4), [head, a, x, d])
        assert.strictEqual(moves(), 0)

        // The key of a row before the change, used again after it.
        root.send(RowsMessage.Show({ ids: ["a", "x", "q", "a", "d"] }))
        const crashed = yield* Effect.flip(TestHost.settle)
        assert.strictEqual(crashed._tag, "RootCrashed")
        const failed = root.log().find((entry) =>
          entry._tag === "Failed"
        ) as MessageLog.Failed
        assert.include(
          Cause.pretty(failed.cause),
          "/Rows: two siblings share the key li[a]"
        )
      })))

    it.effect("any sequence of keyed lists keeps each key's node, in the order shown", () =>
      provideHost(Effect.gen(function*() {
        const root = yield* TestHost.mount(Rows, {})
        yield* TestHost.settle
        const items = () => root.all(Locator.tag("li"))
        // A fixed sequence of pseudo-random lists over a small alphabet, so keys come and go and move.
        let seed = 12345
        const random = (below: number) => {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff
          return seed % below
        }
        const alphabet = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]
        let nodes = new Map(
          ["a", "b", "c", "d"].map((id, index) => [id, items()[index + 1]])
        )
        for (let round = 0; round < 200; round++) {
          const pool = [...alphabet]
          const ids: Array<string> = []
          const length = random(alphabet.length + 1)
          for (let index = 0; index < length; index++) {
            ids.push(pool.splice(random(pool.length), 1)[0]!)
          }
          root.send(RowsMessage.Show({ ids }))
          yield* TestHost.settle
          const shown = items()
          assert.strictEqual(root.text(), `head${ids.join("")}foot`)
          assert.strictEqual(shown.length, ids.length + 2)
          const next = new Map<string, unknown>()
          ids.forEach((id, index) => {
            const node = shown[index + 1]
            if (nodes.has(id)) {
              assert.strictEqual(
                node,
                nodes.get(id),
                `round ${round}: ${id} kept its node`
              )
            }
            next.set(id, node)
          })
          nodes = next as typeof nodes
        }
      })))

    it.effect("two siblings with one key fail the instance", () =>
      provideHost(Effect.gen(function*() {
        const root = yield* TestHost.mount(Rows, {}, {
          fallback: (_, h) => h.el("h1", "down")
        })
        yield* TestHost.settle
        root.send(RowsMessage.Show({ ids: ["a", "a"] }))
        const crashed = yield* Effect.flip(TestHost.settle)
        assert.strictEqual(crashed._tag, "RootCrashed")
        const failed = root.log().find((entry) =>
          entry._tag === "Failed"
        ) as MessageLog.Failed
        assert.strictEqual(failed.in, "view")
        assert.include(
          Cause.pretty(failed.cause),
          "/Rows: two siblings share the key li[a]"
        )
      })))
  })

  describe("failures", () => {
    it.effect("a view that throws partway closes the children it had started", () =>
      provideHost(Effect.gen(function*() {
        const Leaf = Component.define({
          name: "Leaf",
          model: Schema.Null,
          message: Schema.Never
        }).make({
          init: () => null,
          update: ($) => $.model,
          view: (h) => h.text("leaf")
        })
        const Half = Html.component({
          name: "Half",
          model: Schema.Boolean,
          message: Schema.Boolean,
          slots: ["body"]
        }).make({
          init: () => false,
          update: (_, broken) => broken,
          view: (h, broken) =>
            broken ? h.div(Leaf(h, {}), h.slots.body) : h.p("whole")
        })
        const root = yield* TestHost.mount(Half, {})
        yield* TestHost.settle
        root.send(true)
        yield* Effect.exit(TestHost.settle)
        assert.deepStrictEqual(tags(root, "/Half"), [
          "Mounted",
          "Update",
          "Failed",
          "Unmounted"
        ])
        assert.deepStrictEqual(tags(root, "/Half/Leaf[]"), [
          "Mounted",
          "Unmounted"
        ])
      })))

    const BombMessage = UiSchema.TaggedEnum({ Explode: {} })
    const Bomb = Component.define({
      name: "Bomb",
      model: Schema.Number,
      message: BombMessage
    }).make({
      init: () => 0,
      update: (): number => {
        throw new Error("boom")
      },
      view: (h) =>
        h.el("button").on("click", BombMessage.Explode()).children("bomb")
    })
    const PageMessage = UiSchema.TaggedEnum({ BombFailed: {}, Retry: {} })
    const Page = Component.define({
      name: "Page",
      model: Schema.Struct({ failures: Schema.Number, attempt: Schema.Number }),
      message: PageMessage
    }).make({
      init: () => ({ failures: 0, attempt: 0 }),
      update: ($, message) =>
        PageMessage.match(message, {
          BombFailed: () => ({ ...$.model, failures: $.model.failures + 1 }),
          Retry: () => ({ ...$.model, attempt: $.model.attempt + 1 })
        }),
      view: (h, model) =>
        h.el(
          "main",
          Bomb(h, {
            key: `bomb-${model.attempt}`,
            props: {},
            onFailure: () => PageMessage.BombFailed(),
            fallback: () => h.el("p", "bomb failed")
          }),
          Counter(h, { key: "counter", props: { initial: 0 } })
        )
    })

    it.effect("a failing child shows its fallback while its siblings keep running", () =>
      provideHost(Effect.gen(function*() {
        const root = yield* TestHost.mount(Page, {})
        click(root, "bomb")
        yield* TestHost.settle
        assert.strictEqual(
          (root.get(Locator.tag("main")) as TestHost.TestElement).children
            .length,
          2
        )
        assert.strictEqual(root.text(), "bomb failed-0+")
        assert.deepStrictEqual(root.model(), { failures: 1, attempt: 0 })
        const failed = root.log().find((entry) =>
          entry._tag === "Failed"
        ) as MessageLog.Failed
        assert.strictEqual(failed.path, "/Page/Bomb[bomb-0]")
        assert.strictEqual(failed.in, "update")

        click(root, "+")
        yield* TestHost.settle
        assert.strictEqual(root.text(), "bomb failed-1+")

        // Re-keying is the retry.
        root.send(PageMessage.Retry())
        yield* TestHost.settle
        assert.strictEqual(root.text(), "bomb-1+")
        assert.include(tags(root, "/Page/Bomb[bomb-1]"), "Mounted")
      })))

    it.effect("a child failing in view shows its fallback from the first render", () =>
      provideHost(Effect.gen(function*() {
        const Broken = Component.define({
          name: "Broken",
          model: Schema.Number,
          message: Schema.Never
        }).make({
          init: () => 0,
          view: (): never => {
            throw new Error("no view")
          },
          update: ($) => $.model
        })
        const Parent = Component.define({
          name: "Parent",
          model: Schema.Number,
          message: Schema.Never
        }).make({
          init: () => 0,
          update: ($) => $.model,
          view: (h) =>
            h.el(
              "div",
              "before ",
              Broken(h, { key: "x", props: {}, fallback: () => h.text("down") })
            )
        })
        const root = yield* TestHost.mount(Parent, {})
        yield* TestHost.settle
        assert.strictEqual(root.text(), "before down")
        const failed = root.log().find((entry) =>
          entry._tag === "Failed"
        ) as MessageLog.Failed
        assert.strictEqual(failed.in, "view")
      })))

    it.effect("a crashed root shows mount's fallback", () =>
      provideHost(Effect.gen(function*() {
        const root = yield* TestHost.mount(Page, {}, {
          fallback: (_, h) => h.el("h1", "Something went wrong")
        })
        root.send("not a message" as any)
        const crashed = yield* Effect.flip(TestHost.settle)
        assert.strictEqual(crashed._tag, "RootCrashed")
        assert.strictEqual(root.text(), "Something went wrong")
        assert.isUndefined(root.model())
        // The root has no parent, so its Failed entry is all a crash needs.
        assert.deepStrictEqual(tags(root, "/Page").slice(-2), [
          "Failed",
          "Unmounted"
        ])
      })))

    it.effect("a root fallback that throws is logged as a failure of the root, in fallback", () =>
      provideHost(Effect.gen(function*() {
        const root = yield* TestHost.mount(Page, {}, {
          fallback: () => {
            throw new Error("fallback broke")
          }
        })
        root.send("not a message" as any)
        yield* Effect.flip(TestHost.settle)
        const failed = root.log().filter((entry): entry is MessageLog.Failed =>
          entry._tag === "Failed"
        )
        assert.deepStrictEqual(
          failed.map((entry) => `${entry.path} ${entry.in}`),
          ["/Page update", "/Page fallback"]
        )
      })))

    it.effect("a defect in a Command fails its instance", () =>
      provideHost(Effect.gen(function*() {
        const Explode = Command.make(
          "Explode",
          { args: {} },
          () => Effect.die("kaboom")
        )
        const Child = Component.define({
          name: "Child",
          model: Schema.Number,
          message: Schema.String
        }).make({
          init: ($) => $.set(0).run(Explode.make()),
          update: ($) => $.model,
          view: (h) => h.text("child")
        })
        const Parent = Component.define({
          name: "Parent",
          model: Schema.Number,
          message: Schema.Never
        }).make({
          init: () => 0,
          update: ($) => $.model,
          view: (h) => h.el("div", Child(h, { key: "c", props: {} }), "parent")
        })
        const root = yield* TestHost.mount(Parent, {})
        assert.strictEqual(root.text(), "childparent")
        yield* TestHost.settle
        assert.strictEqual(root.text(), "parent")
        const failed = root.log().find((entry) =>
          entry._tag === "Failed"
        ) as MessageLog.Failed
        assert.deepStrictEqual([failed.in, failed.name], ["command", "Explode"])
      })))
  })

  describe("a provided Layer factory and a fallback's child", () => {
    const Leaf = Component.define({
      name: "Leaf",
      model: Schema.Number,
      message: Schema.String
    }).make({
      init: () => 0,
      update: ($) => $.model + 1,
      view: (h, n) => h.text(`leaf${n}`)
    })
    const broken = (): Layer.Layer<never> => {
      throw new Error("factory broke")
    }

    it.effect("a throwing factory fails only that child", () =>
      provideHost(Effect.gen(function*() {
        const Child = Component.provide(Leaf, broken)
        const Parent = Component.define({
          name: "Parent",
          model: Schema.Number,
          message: Schema.Never
        }).make({
          init: () => 0,
          update: ($) => $.model,
          view: (h) =>
            h.el(
              "main",
              Child(h, { key: "c", fallback: () => h.text("down ") }),
              "alive"
            )
        })
        const root = yield* TestHost.mount(Parent, {}, {
          fallback: (_, h) => h.text("ROOT CRASH")
        })
        yield* TestHost.settle
        assert.strictEqual(root.text(), "down alive")
        const failed = root.log().find((entry) =>
          entry._tag === "Failed"
        ) as MessageLog.Failed
        assert.deepStrictEqual([failed.path, failed.in], [
          "/Parent/Leaf[c]",
          "layer"
        ])
      })))

    it.effect("with onFailure, a throwing factory becomes a message", () =>
      provideHost(Effect.gen(function*() {
        const root = yield* TestHost.mount(
          Component.provide(Leaf, broken, { onFailure: () => "failed" }),
          {}
        )
        yield* TestHost.settle
        assert.strictEqual(root.text(), "leaf1")
      })))

    it.effect("re-keying the child a fallback returns mounts it again", () =>
      provideHost(Effect.gen(function*() {
        let starts = 0
        const Counted = Component.define({
          name: "Counted",
          model: Schema.Number,
          message: Schema.Never
        }).make({
          init: () => ++starts,
          update: ($) => $.model,
          view: (h, n) => h.text(String(n))
        })
        const Broken = Component.define({
          name: "Broken",
          model: Schema.Number,
          message: Schema.Never
        }).make({
          init: () => 0,
          update: ($) => $.model,
          view: (): never => {
            throw new Error("broken")
          }
        })
        const Parent = Component.define({
          name: "Parent",
          model: Schema.Number,
          message: Schema.Number
        }).make({
          init: () => 0,
          update: (_, n) => n,
          view: (h, n) =>
            Broken(h, {
              key: "b",
              fallback: () => Counted(h, { key: String(n) })
            })
        })
        const root = yield* TestHost.mount(Parent, {})
        assert.strictEqual(root.text(), "1")
        root.send(1)
        yield* TestHost.settle
        assert.strictEqual(root.text(), "2")
      })))
  })

  describe("Commands", () => {
    const Msg = UiSchema.TaggedEnum({
      Query: { text: Schema.String },
      Results: { text: Schema.String }
    })
    const Search = Command.make(
      "Search",
      { args: { text: Schema.String }, mode: "switch" },
      ({ text }) => Effect.as(Effect.sleep("1 second"), Msg.Results({ text }))
    )
    const Box = Component.define({
      name: "Box",
      model: Schema.String,
      message: Msg
    }).make({
      init: () => "",
      update: ($, message) =>
        Msg.match(message, {
          Query: ({ text }) => $.run(Search.make({ text })),
          Results: ({ text }) => text
        }),
      view: (h, model) => h.text(model)
    })

    it.effect("switch interrupts the running run, and results come back as messages", () =>
      provideHost(Effect.gen(function*() {
        const root = yield* TestHost.mount(Box, {})
        root.send(Msg.Query({ text: "a" }))
        root.send(Msg.Query({ text: "ab" }))
        yield* TestHost.settle
        assert.deepStrictEqual(root.pending(), [{
          _tag: "Command",
          path: "/Box",
          name: "Search",
          status: "running"
        }])
        yield* TestClock.adjust("1 second")
        yield* TestHost.settle
        assert.strictEqual(root.text(), "ab")
        assert.deepStrictEqual(tags(root), [
          "SessionStarted",
          "Mounted",
          "Update",
          "Update",
          "CommandInterrupted",
          "CommandStarted",
          "Update",
          "CommandEnded"
        ])
        assert.strictEqual(
          (root.log()[4] as MessageLog.CommandInterrupted).reason,
          "switch"
        )
        const result = root.log()[6] as MessageLog.Update
        assert.strictEqual(result.source._tag, "Command")
        if (result.source._tag === "Command") {
          assert.deepStrictEqual(result.source.issued, { seq: 4, index: 0 })
        }
      })))

    it.effect("a ref resolves within the issuing instance after the render is committed", () =>
      provideHost(Effect.gen(function*() {
        const Field = Renderer.ref("Field")
        const RefMsg = UiSchema.TaggedEnum({
          Show: {},
          Found: { found: Schema.Boolean }
        })
        const Look = Command.make(
          "Look",
          { args: {} },
          () =>
            Effect.gen(function*() {
              const refs = yield* Renderer.Refs
              const node = yield* refs.lookup(Field)
              return RefMsg.Found({ found: Option.isSome(node) })
            })
        )
        const Form = Component.define({
          name: "Form",
          model: Schema.Struct({
            shown: Schema.Boolean,
            found: Schema.optional(Schema.Boolean)
          }),
          message: RefMsg
        }).make({
          init: ($) => $.set({ shown: false }).run(Look.make()),
          update: ($, message) =>
            RefMsg.match(message, {
              Show: () => $.set({ shown: true }).run(Look.make()),
              Found: ({ found }) => ({ ...$.model, found })
            }),
          view: (h, model) =>
            h.el("form", model.shown ? h.el("input").ref(Field) : null)
        })
        const root = yield* TestHost.mount(Form, {})
        yield* TestHost.settle
        assert.deepStrictEqual(root.model(), { shown: false, found: false })
        root.send(RefMsg.Show())
        yield* TestHost.settle
        assert.deepStrictEqual(root.model(), { shown: true, found: true })
      })))

    it.effect("what one bare-Model init returns can't give another instance a Command or an event", () =>
      provideHost(Effect.gen(function*() {
        let ran = 0
        // Never returns, so a run sends `Quiet` nothing to update with.
        const Count = Command.make(
          "Count",
          { args: {} },
          () => Effect.andThen(Effect.sync(() => ran++), Effect.never)
        )
        const Quiet = Component.define({
          name: "Quiet",
          model: Schema.Number,
          message: Schema.Never,
          events: Schema.String
        })
          .make({
            init: () => 0,
            update: ($) => $.model,
            view: (h) => h.text("quiet")
          })
        const next = Quiet.init({})
        for (
          const effects of [next.commands, next.events] as Array<Array<unknown>>
        ) {
          try {
            effects.push(Count.make())
          } catch {
            // Refused, as it should be.
          }
        }
        const Parent = Component.define({
          name: "Parent",
          model: Schema.Array(Schema.Unknown),
          message: Schema.Unknown
        })
          .make({
            // Steps, so only `Quiet` starts from a bare Model.
            init: ($) => $.set([]),
            update: ($, message) => $.set([...$.model, message]),
            view: (h) => Quiet(h, { onEmit: (event) => event })
          })
        const root = yield* TestHost.mount(Parent, {})
        yield* TestHost.settle
        assert.strictEqual(ran, 0)
        assert.deepStrictEqual(root.model(), [])
      })))
  })

  describe("run owners", () => {
    // The server behind the fake API, and the requests that reached the query's fetcher.
    const makeServer = () => ({ count: 0, requests: 0, interrupted: 0 })
    type Server = ReturnType<typeof makeServer>

    class GetCount extends Query.Service<GetCount>()("test/GetCount", {
      args: { id: Schema.String },
      success: Schema.Number,
      error: Schema.Never,
      staleTime: "Infinity"
    }) {}
    const fetcher = (server: Server) =>
      Layer.succeed(GetCount, () =>
        Effect.sync(() => {
          server.requests++
          return server.count
        }))

    class Api extends Context.Service<
      Api,
      { readonly save: (n: number) => Effect.Effect<number> }
    >()("test/Api") {}
    const api = (server: Server) =>
      Layer.succeed(Api, {
        save: (n) =>
          Effect.sleep("1 second").pipe(
            Effect.andThen(Effect.sync(() => (server.count = n))),
            Effect.onInterrupt(() => Effect.sync(() => server.interrupted++))
          )
      })

    class Save extends Command.Service<Save>()(
      "test/Save",
      {
        args: { n: Schema.Number },
        success: Schema.Number,
        error: Schema.Never,
        invalidates: () => [GetCount],
        mode: "queue"
      }
    ) {
      static readonly layer = this.toLayer(
        Effect.gen(function*() {
          const { save } = yield* Api
          return ({ n }) => save(n)
        })
      )
    }
    class Rename extends Command.Service<Rename>()(
      "test/Rename",
      {
        args: { n: Schema.Number },
        success: Schema.Number,
        error: Schema.Never,
        invalidates: () => [],
        optimistic: () => [GetCount.patch({ id: "a" }, (count) => count + 100)],
        writes: (count) => [GetCount.set({ id: "a" }, count)]
      }
    ) {
      static readonly layer = this.toLayer(
        Effect.gen(function*() {
          const { save } = yield* Api
          return ({ n }) => save(n)
        })
      )
    }

    // The editor's buttons can run either command, so a mount provides both.
    const commands = (server: Server) =>
      Layer.mergeAll(Save.layer, Rename.layer).pipe(Layer.provide(api(server)))

    const EditorMsg = UiSchema.TaggedEnum({
      Save: {},
      Rename: {},
      Stop: {},
      Saved: { n: Schema.Number }
    })
    const Editor = Component.define({
      name: "Editor",
      model: Schema.Number,
      message: EditorMsg
    }).make({
      init: () => 0,
      update: ($, message) =>
        EditorMsg.match(message, {
          Save: () =>
            $.set($.model + 1).run(
              Save.make({ n: $.model + 1 }).pipe(
                Command.map((n) => EditorMsg.Saved({ n }))
              )
            ),
          Rename: () =>
            $.set($.model + 1).run(
              Rename.make({ n: $.model + 1 }).pipe(
                Command.map((n) => EditorMsg.Saved({ n }))
              )
            ),
          Stop: () => $.run(Command.interrupt(Save)),
          Saved: () => $.model
        }),
      view: (h) =>
        h.el("div", [
          h.el("button").on("click", EditorMsg.Save()).children("save"),
          h.el("button").on("click", EditorMsg.Rename()).children("rename"),
          h.el("button").on("click", EditorMsg.Stop()).children("stop"),
          h.text(h.isRunning(Save) ? "saving" : "idle")
        ])
    })

    // The layout: it watches the server count through `changes`, which carries server values only.
    const PageMsg = UiSchema.TaggedEnum({
      Count: { value: Schema.Number },
      Close: {},
      Watch: { on: Schema.Boolean }
    })
    const page = <R>(
      editor: Component.Component<"Editor", {}, number, any, never, R, any>
    ) =>
      Component.define({
        name: "Page",
        model: Schema.Struct({
          count: Schema.Number,
          editing: Schema.Boolean,
          watching: Schema.Boolean
        }),
        message: PageMsg
      }).make({
        init: () => ({ count: -1, editing: true, watching: true }),
        update: ($, message) =>
          PageMsg.match(message, {
            Count: ({ value }) => ({ ...$.model, count: value }),
            Close: () => ({ ...$.model, editing: false }),
            Watch: ({ on }) => ({ ...$.model, watching: on })
          }),
        subscriptions: ({ model }) => [
          model.watching && Subscription.make(
            "count",
            GetCount.changes({ id: "a" }).pipe(
              Stream.filter(AsyncResult.isSuccess),
              Stream.map((result) => PageMsg.Count({ value: result.value }))
            )
          )
        ],
        view: (h, model) =>
          h.el("main", [
            h.el("p", `count ${model.count}`),
            model.editing ? editor(h, { key: "editor", props: {} }) : null
          ])
      })
    const EditorPage = page(Editor)

    it.effect("a save ends with its instance: the running run is interrupted, the queued one never starts", () =>
      provideHost(Effect.gen(function*() {
        const server = makeServer()
        const App = Component.provide(
          EditorPage,
          Layer.mergeAll(commands(server), fetcher(server))
        )
        const root = yield* TestHost.mount(App, {})
        yield* TestHost.settle
        click(root, "save")
        click(root, "save")
        yield* TestHost.settle
        assert.include(root.text(), "saving")
        root.send(PageMsg.Close())
        yield* TestHost.settle
        assert.deepStrictEqual(root.pending(), [])
        yield* TestClock.adjust("2 seconds")
        yield* TestHost.settle
        assert.deepStrictEqual([server.interrupted, server.count], [1, 0])
        const editor = root.log().filter((entry) =>
          "path" in entry && entry.path === "/Page/Editor[editor]"
        )
        assert.deepStrictEqual(
          editor.flatMap((entry) =>
            entry._tag === "CommandInterrupted"
              ? [`${entry._tag} ${entry.reason}`]
              : entry._tag.startsWith("Command")
              ? [entry._tag]
              : []
          ),
          [
            "CommandStarted",
            "CommandInterrupted unmount",
            "CommandInterrupted unmount"
          ]
        )
        // A started run invalidates however it exits.
        assert.strictEqual(server.requests, 2)
      })))

    it.effect("a removed branch doesn't start a queued Stream Command while a sibling's cleanup holds its close", () =>
      provideHost(Effect.gen(function*() {
        const finish = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const entered = yield* Deferred.make<void>()
        const calls: Array<number> = []
        // Its service is a Layer above the branch that stays open.
        class Watch extends Command.Service<Watch>()(
          "test/QueuedStream",
          {
            args: { n: Schema.Number },
            success: Component.Noop,
            error: Schema.Never,
            stream: true,
            mode: "queue"
          }
        ) {
          static readonly layer = this.toLayer(({ n }) =>
            Stream.fromEffect(Effect.andThen(
              Effect.sync(() => calls.push(n)),
              Effect.as(
                n === 1 ? Deferred.await(finish) : Effect.void,
                Component.noop
              )
            ))
          )
        }
        const Queue = Component.define({
          name: "Queue",
          model: Schema.Null,
          message: Schema.Never
        })
          .make({
            init: ($) =>
              $.set(null).run(Watch.make({ n: 1 })).run(Watch.make({ n: 2 })),
            update: ($) => $.model,
            view: (h) => h.text("")
          })
        // Closes before the queue, as it mounted after it, and holds the branch's close open.
        const Blocker = Component.provide(
          Component.define({
            name: "Blocker",
            model: Schema.Null,
            message: Schema.Never
          }).make({
            init: () => null,
            update: ($) => $.model,
            view: (h) => h.text("")
          }),
          () =>
            Layer.effectDiscard(
              Effect.addFinalizer(() =>
                Effect.andThen(
                  Deferred.succeed(entered, undefined),
                  Deferred.await(gate)
                )
              )
            )
        )
        const Branch = Component.define({
          name: "Branch",
          model: Schema.Null,
          message: Schema.Never
        })
          .make({
            init: () => null,
            update: ($) => $.model,
            view: (h) =>
              h.el(
                "div",
                Queue(h, { key: "queue", props: {} }),
                Blocker(h, { key: "blocker", props: {} })
              )
          })
        const Parent = Component.provide(
          Component.define({
            name: "Parent",
            model: Schema.Boolean,
            message: Schema.Boolean
          }).make({
            init: () => true,
            update: (_, shown) => shown,
            view: (h, shown) =>
              shown ? Branch(h, { key: "branch", props: {} }) : h.text("gone")
          }),
          Watch.layer
        )
        const root = yield* TestHost.mount(Parent, {})
        yield* TestHost.settle
        root.send(false)
        yield* TestHost.settle
        yield* Deferred.await(entered)
        // The running one ends while the close is held: the queued one is stopped, not started.
        yield* Deferred.succeed(finish, undefined)
        yield* TestHost.settle
        assert.deepStrictEqual(calls, [1])
        yield* Deferred.succeed(gate, undefined)
        yield* TestHost.settle
        assert.deepStrictEqual(calls, [1])
        assert.strictEqual(root.text(), "gone")
      })))

    it.effect("a Command issued just before its instance is removed doesn't begin while the instance's Layer cleans up", () =>
      provideHost(Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const entered = yield* Deferred.make<void>()
        const events: Array<string> = []
        const Write = Command.make(
          "test/ScheduledWrite",
          { args: {} },
          () =>
            Effect.sync(() => {
              events.push("work")
              return Component.noop
            })
        )
        const Child = Component.provide(
          Component.define({
            name: "Child",
            model: Schema.Null,
            message: Schema.Null
          }).make({
            init: () => null,
            update: ($) => $.run(Write.make()),
            view: (h) => h.el("button").on("click", null).children("write")
          }),
          () =>
            Layer.effectDiscard(Effect.addFinalizer(() =>
              Effect.andThen(
                Effect.sync(() => events.push("closing")),
                Effect.andThen(
                  Deferred.succeed(entered, undefined),
                  Deferred.await(gate)
                )
              )
            ))
        )
        const Parent = Component.define({
          name: "Parent",
          model: Schema.Boolean,
          message: Schema.Boolean
        }).make({
          init: () => true,
          update: (_, shown) => shown,
          view: (h, shown) =>
            shown ? Child(h, { key: "child", props: {} }) : h.text("gone")
        })
        const root = yield* TestHost.mount(Parent, {})
        yield* TestHost.settle
        // The removal renders before the Command's fiber takes its first step on the scheduler.
        root.send(false)
        Locator.fire(root.get(Locator.tag("button")), "click")
        yield* TestHost.settle
        yield* Deferred.await(entered)
        assert.deepStrictEqual(events, ["closing"])
        yield* Deferred.succeed(gate, undefined)
        yield* TestHost.settle
        assert.deepStrictEqual(events, ["closing"])
        assert.strictEqual(root.text(), "gone")
      })))

    // A body that can't be interrupted, so an owner that only asks it to stop closes before it ends.
    const makeStubborn = () => {
      const events: Array<string> = []
      const gate = Deferred.makeUnsafe<void>()
      class Stubborn extends Command.Service<Stubborn>()(
        "test/Stubborn",
        {
          args: {},
          success: Schema.Void,
          error: Schema.Never,
          invalidates: () => []
        }
      ) {
        static readonly layer = this.toLayer(
          Effect.gen(function*() {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => events.push("build released"))
            )
            return () =>
              Effect.uninterruptible(
                Effect.andThen(
                  Deferred.await(gate),
                  Effect.sync(() => {
                    events.push("body done")
                  })
                )
              )
          })
        )
      }
      const Msg = UiSchema.TaggedEnum({ Close: {}, Stop: {}, Done: {} })
      const Child = Component.define({
        name: "Child",
        model: Schema.Null,
        message: Msg
      }).make({
        init: ($) =>
          $.set(null).run(Stubborn.make().pipe(Command.map(() => Msg.Done()))),
        update: ($, message) =>
          message._tag === "Stop"
            ? $.run(Command.interrupt(Stubborn))
            : $.model,
        view: (h) => h.el("button").on("click", Msg.Stop()).children("stop")
      })
      // A child whose `Command.make` run ends with it.
      const Holder = Component.define({
        name: "Child",
        model: Schema.Null,
        message: Msg
      }).make({
        init: ($) =>
          $.set(null).run(
            Command.make(
              "test/Hold",
              { args: {} },
              () =>
                Effect.uninterruptible(
                  Effect.andThen(
                    Deferred.await(gate),
                    Effect.sync(() => events.push("body done"))
                  )
                )
            ).make().pipe(Command.map(() => Msg.Done()))
          ),
        update: ($) => $.model,
        view: (h) => h.text("holder")
      })
      const parent = <R>(
        child: Component.Component<"Child", {}, null, any, never, R, any>
      ) =>
        Component.define({
          name: "Parent",
          model: Schema.Boolean,
          message: Msg
        }).make({
          init: () => true,
          update: ($, message) => message._tag === "Close" ? false : $.model,
          view: (h, open) =>
            h.el("div", open ? child(h, { key: "child", props: {} }) : null)
        })
      return { events, gate, Stubborn, Child, Holder, parent, Msg }
    }

    // Closes the mount Scope and checks the close waits for the body, which the gate holds.
    const closeWaitsForBody = Effect.fnUntraced(
      function*(
        scope: Scope.Closeable,
        { events, gate }: {
          readonly events: Array<string>
          readonly gate: Deferred.Deferred<void>
        }
      ) {
        const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void))
        // The close fiber runs on the default scheduler, so it gets turns between the settles.
        for (let turn = 0; turn < 3; turn++) {
          yield* TestHost.settle
          yield* Effect.yieldNow
        }
        assert.isUndefined(closing.pollUnsafe())
        Deferred.doneUnsafe(gate, Exit.void)
        yield* TestHost.settle
        yield* Fiber.join(closing)
        events.push("root closed")
        assert.deepStrictEqual(events, ["body done", "root closed"])
      }
    )

    it.effect("closing the root waits for a run that was already interrupted", () => {
      const stubborn = makeStubborn()
      const { Child, Stubborn, parent } = stubborn
      return Effect.gen(function*() {
        const scope = yield* Scope.make()
        const root = yield* TestHost.mount(parent(Child), {}).pipe(
          Scope.provide(scope)
        )
        yield* TestHost.settle
        click(root, "stop")
        yield* TestHost.settle
        // Its fiber hasn't exited, so it still holds its group.
        assert.deepStrictEqual(
          root.pending().map((entry) =>
            entry._tag === "Command" && entry.status
          ),
          ["stopping"]
        )
        yield* closeWaitsForBody(scope, stubborn)
      }).pipe(Effect.provide(Stubborn.layer), Effect.provide(TestHost.layer()))
    })

    it.effect("closing the root waits for an unmounted instance's close that is still running", () =>
      provideHost(Effect.gen(function*() {
        const stubborn = makeStubborn()
        const { Holder, Msg, parent } = stubborn
        const scope = yield* Scope.make()
        const root = yield* TestHost.mount(parent(Holder), {}).pipe(
          Scope.provide(scope)
        )
        yield* TestHost.settle
        root.send(Msg.Close())
        yield* TestHost.settle
        assert.notInclude(root.text(), "holder")
        yield* closeWaitsForBody(scope, stubborn)
      })))

    it.effect("closing the root waits for the run of an unmounted instance to exit", () => {
      const stubborn = makeStubborn()
      const { Child, Msg, Stubborn, parent } = stubborn
      return Effect.gen(function*() {
        const scope = yield* Scope.make()
        const root = yield* TestHost.mount(parent(Child), {}).pipe(
          Scope.provide(scope)
        )
        yield* TestHost.settle
        root.send(Msg.Close())
        yield* TestHost.settle
        yield* closeWaitsForBody(scope, stubborn)
      }).pipe(Effect.provide(Stubborn.layer), Effect.provide(TestHost.layer()))
    })

    it.effect("closing the root waits for a run that ends with its instance", () =>
      provideHost(Effect.gen(function*() {
        const stubborn = makeStubborn()
        const scope = yield* Scope.make()
        yield* TestHost.mount(stubborn.Holder, {}).pipe(Scope.provide(scope))
        yield* TestHost.settle
        yield* closeWaitsForBody(scope, stubborn)
      })))

    it.effect("an instance's close waits for its run before its Layer is released", () =>
      provideHost(Effect.gen(function*() {
        const { Child, Msg, Stubborn, events, gate, parent } = makeStubborn()
        const root = yield* TestHost.mount(
          parent(Component.provide(Child, Stubborn.layer)),
          {}
        )
        yield* TestHost.settle
        root.send(Msg.Close())
        yield* TestHost.settle
        assert.deepStrictEqual(events, [])
        Deferred.doneUnsafe(gate, Exit.void)
        yield* TestHost.settle
        assert.deepStrictEqual(events, ["body done", "build released"])
      })))

    it.effect("an instance's close waits for its run before its Layer is released, when its parent's Layer was late", () =>
      provideHost(Effect.gen(function*() {
        const ready = yield* Deferred.make<void>()
        const events: Array<string> = []
        class Job extends Command.Service<Job>()(
          "test/LateJob",
          { args: {}, success: Schema.Never, error: Schema.Never }
        ) {
          static readonly layer = this.toLayer(
            Effect.gen(function*() {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => events.push("layer released"))
              )
              return () =>
                Effect.gen(function*() {
                  yield* Effect.addFinalizer(() =>
                    Effect.sync(() => events.push("run cleaned"))
                  )
                  return yield* Effect.never
                })
            })
          )
        }
        const Child = Component.provide(
          Component.define({
            name: "Child",
            model: Schema.Null,
            message: Schema.Never
          }).make({
            init: ($) => $.set(null).run(Job.make().pipe(Command.asNoop)),
            update: ($) => $.model,
            view: (h) => h.text("child")
          }),
          () => Job.layer
        )
        // The child's Layer builds only once the parent's is ready.
        const Parent = Component.provide(
          Component.define({
            name: "Parent",
            model: Schema.Boolean,
            message: Schema.Boolean
          }).make({
            init: () => true,
            update: (_, open) => open,
            view: (h, open) =>
              open ? Child(h, { key: "child", props: {} }) : h.text("closed")
          }),
          Layer.effectDiscard(Deferred.await(ready))
        )
        const root = yield* TestHost.mount(Parent, {})
        yield* TestHost.settle
        yield* Deferred.succeed(ready, undefined)
        yield* TestHost.settle
        root.send(false)
        yield* TestHost.settle
        assert.deepStrictEqual(events, ["run cleaned", "layer released"])
      })))

    it.effect("switch runs, Stream Commands and Command.make Commands end with their instance", () =>
      provideHost(Effect.gen(function*() {
        const stopped: Array<string> = []
        const held = (name: string) =>
          Effect.onInterrupt(
            Effect.never,
            () => Effect.sync(() => stopped.push(name))
          )
        class Latest extends Command.Service<Latest>()(
          "test/Latest",
          {
            args: {},
            success: Schema.Never,
            error: Schema.Never,
            invalidates: () => [],
            mode: "switch"
          }
        ) {}
        class Watch extends Command.Service<Watch>()(
          "test/Watch",
          {
            args: {},
            success: Schema.Never,
            error: Schema.Never,
            invalidates: () => [],
            stream: true
          }
        ) {}
        const Local = Command.make(
          "test/Local",
          { args: {} },
          () => held("make")
        )
        const Msg = UiSchema.TaggedEnum({ Close: {} })
        const Busy = Component.define({
          name: "Busy",
          model: Schema.Boolean,
          message: Msg
        }).make({
          init: ($) =>
            $.set(true).run(Latest.make()).run(Watch.make()).run(Local.make()),
          update: () => false,
          view: (h, open) =>
            h.el(
              "div",
              open ?
                Component.define({
                  name: "Inner",
                  model: Schema.Null,
                  message: Schema.Never
                }).make({
                  init: ($) =>
                    $.set(null).run(Latest.make()).run(Watch.make()).run(
                      Local.make()
                    ),
                  update: ($) => $.model,
                  view: (h) => h.text("inner")
                })(h, { key: "inner", props: {} }) :
                null
            )
        })
        const App = Component.provide(
          Busy,
          Layer.mergeAll(
            Layer.succeed(Latest, () => held("switch")),
            Layer.succeed(Watch, () => Stream.fromEffect(held("stream")))
          )
        )
        const root = yield* TestHost.mount(App, {})
        yield* TestHost.settle
        assert.strictEqual(root.pending().length, 6)
        root.send(Msg.Close())
        yield* TestHost.settle
        assert.sameMembers(stopped, ["switch", "stream", "make"])
        assert.strictEqual(root.pending().length, 3)
      })))

    it.effect("siblings close newest first, even when an older one subscribes after it mounts", () =>
      provideHost(Effect.gen(function*() {
        const stopped: Array<string> = []
        const Job = Command.make(
          "test/Job",
          { args: { name: Schema.String } },
          ({ name }) =>
            Effect.onInterrupt(
              Effect.never,
              () => Effect.sync(() => stopped.push(name))
            )
        )
        const Worker = Component.define({
          name: "Worker",
          props: Schema.Struct({ name: Schema.String, listen: Schema.Boolean }),
          model: Schema.Null,
          message: Schema.Null
        }).make({
          init: ($) => $.set(null).run(Job.make({ name: $.props.name })),
          update: ($) => $.model,
          view: (h) => h.text(h.props.name),
          subscriptions: ({ props }) =>
            props.listen ? [Subscription.make("listen", Stream.never)] : []
        })
        const Step = Schema.Literals(["mounted", "listening", "dropped"])
        const App = Component.define({
          name: "App",
          model: Step,
          message: Step
        }).make({
          init: () => "mounted" as const,
          update: (_, step) => step,
          view: (h, step) =>
            h.el(
              "div",
              step === "dropped"
                ? null
                : Worker(h, {
                  key: "a",
                  props: { name: "A", listen: step === "listening" }
                }),
              Worker(h, { key: "b", props: { name: "B", listen: false } })
            )
        })
        const run = Effect.fnUntraced(
          function*(steps: ReadonlyArray<typeof Step.Type>) {
            stopped.length = 0
            const scope = yield* Scope.make()
            const root = yield* TestHost.mount(App, {}).pipe(
              Scope.provide(scope)
            )
            yield* TestHost.settle
            for (const step of steps) {
              root.send(step)
              yield* TestHost.settle
            }
            const before = [...stopped]
            yield* Scope.close(scope, Exit.void)
            return { before, after: [...stopped] }
          }
        )
        // A subscribes after both have mounted.
        assert.deepStrictEqual(yield* run(["listening"]), {
          before: [],
          after: ["B", "A"]
        })
        // A goes after subscribing late: it closes then, and once.
        assert.deepStrictEqual(yield* run(["listening", "dropped"]), {
          before: ["A"],
          after: ["A", "B"]
        })
      })))

    it.effect("h.isRunning ends when an interrupted run's fiber exits, and the instance re-renders", () =>
      provideHost(Effect.gen(function*() {
        const server = makeServer()
        const App = Component.provide(
          EditorPage,
          Layer.mergeAll(commands(server), fetcher(server))
        )
        const root = yield* TestHost.mount(App, {})
        yield* TestHost.settle
        click(root, "save")
        yield* TestHost.settle
        assert.include(root.text(), "saving")
        click(root, "stop")
        yield* TestHost.settle
        assert.include(root.text(), "idle")
        assert.strictEqual(server.interrupted, 1)
      })))

    // A run whose cleanup waits on `cleanup` once interrupted, under `mode`.
    const makeCleanup = (mode: "queue" | "switch") => {
      const events: Array<string> = []
      const cleanup = Deferred.makeUnsafe<void>()
      const Job = Command.make(
        "test/Job",
        { args: { n: Schema.Number }, mode },
        ({ n }) =>
          Effect.sync(() => events.push(`start ${n}`)).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.andThen(
                Deferred.await(cleanup),
                Effect.sync(() => events.push(`cleaned ${n}`))
              )
            )
          )
      )
      const Msg = UiSchema.TaggedEnum({ Go: { n: Schema.Number }, Stop: {} })
      const Jobs = Component.define({
        name: "Jobs",
        model: Schema.Null,
        message: Msg
      }).make({
        init: () => null,
        update: ($, message) =>
          Msg.match(message, {
            Go: ({ n }) => $.run(Job.make({ n }).pipe(Command.asNoop)),
            Stop: () => $.run(Command.interrupt(Job))
          }),
        view: (h) => h.text(h.isRunning(Job) ? "running" : "idle")
      })
      return { events, cleanup, Jobs, Msg }
    }

    for (const mode of ["queue", "switch"] as const) {
      it.effect(`${mode}: an interrupted run holds h.isRunning and its group until its cleanup finishes`, () =>
        provideHost(Effect.gen(function*() {
          const { Jobs, Msg, cleanup, events } = makeCleanup(mode)
          const root = yield* TestHost.mount(Jobs, {})
          root.send(Msg.Go({ n: 1 }))
          yield* TestHost.settle
          // A queue run is cut by the interrupt; a switch run by the next one.
          if (mode === "queue") root.send(Msg.Stop())
          root.send(Msg.Go({ n: 2 }))
          yield* TestHost.settle
          assert.strictEqual(root.text(), "running")
          assert.deepStrictEqual(events, ["start 1"])
          assert.deepStrictEqual(
            root.pending().map((entry) =>
              entry._tag === "Command" && entry.status
            ),
            [
              "stopping",
              "queued"
            ]
          )
          Deferred.doneUnsafe(cleanup, Exit.void)
          yield* TestHost.settle
          assert.deepStrictEqual(events, ["start 1", "cleaned 1", "start 2"])
          assert.strictEqual(root.text(), "running")
        })))
    }

    it.effect("a defect in the cleanup of a run switch cut is reported as CleanupFailed, and the next run starts", () =>
      provideHost(Effect.gen(function*() {
        const started: Array<number> = []
        const Job = Command.make(
          "test/Brittle",
          { args: { n: Schema.Number }, mode: "switch" },
          ({ n }) =>
            Effect.sync(() => started.push(n)).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Effect.die("cleanup broke"))
            )
        )
        const Jobs = Component.define({
          name: "Jobs",
          model: Schema.Null,
          message: Schema.Number
        }).make(
          {
            init: () => null,
            update: ($, n) => $.run(Job.make({ n }).pipe(Command.asNoop)),
            view: (h) => h.text(h.isRunning(Job) ? "running" : "idle")
          }
        )
        const root = yield* TestHost.mount(Jobs, {})
        root.send(1)
        yield* TestHost.settle
        root.send(2)
        assert.strictEqual(
          (yield* Effect.flip(TestHost.settle))._tag,
          "ProblemsError"
        )
        const [problem] =
          (yield* TestHost.expectProblem("CleanupFailed")) as ReadonlyArray<
            Command.CleanupFailed
          >
        assert.deepStrictEqual([problem.path, problem.command], [
          "/Jobs",
          "test/Brittle"
        ])
        assert.isTrue(Cause.hasDies(problem.cause))
        assert.deepStrictEqual(started, [1, 2])
        assert.strictEqual(root.text(), "running")
        assert.isFalse(root.log().some((entry) => entry._tag === "Failed"))
      })))

    it.effect("a run's Scope closes with the run's own exit, while its instance stays mounted", () =>
      provideHost(Effect.gen(function*() {
        const exits: Array<string> = []
        const Outcome = Schema.Literals(["succeed", "fail", "hold"])
        class Tx extends Command.Service<Tx>()(
          "test/Tx",
          {
            args: { outcome: Outcome },
            success: Schema.Void,
            error: Schema.String,
            invalidates: () => []
          }
        ) {
          static readonly layer = this.toLayer(({ outcome }) =>
            Effect.acquireRelease(
              Effect.void,
              (_, exit) =>
                Effect.sync(() =>
                  exits.push(
                    Exit.isSuccess(exit)
                      ? "Success"
                      : Cause.hasFails(exit.cause)
                      ? "Fail"
                      : "Interrupt"
                  )
                )
            ).pipe(
              Effect.andThen(
                outcome === "succeed"
                  ? Effect.void
                  : outcome === "fail"
                  ? Effect.fail("rejected")
                  : Effect.never
              )
            )
          )
        }
        const Msg = UiSchema.TaggedEnum({
          Issue: { outcome: Outcome },
          Stop: {},
          Done: {}
        })
        const done = Command.match({
          onSuccess: () => Msg.Done(),
          onFailure: () => Msg.Done()
        })
        const Tx_ = Component.provide(
          Component.define({
            name: "Tx",
            model: Schema.Null,
            message: Msg
          }).make({
            init: () => null,
            update: ($, message) =>
              Msg.match(message, {
                Issue: ({ outcome }) => $.run(Tx.make({ outcome }).pipe(done)),
                Stop: () => $.run(Command.interrupt(Tx)),
                Done: () => $.model
              }),
            view: (h) => h.text("tx")
          }),
          Tx.layer
        )
        const root = yield* TestHost.mount(Tx_, {})
        yield* TestHost.settle
        for (const outcome of ["succeed", "fail", "hold"] as const) {
          root.send(Msg.Issue({ outcome }))
          yield* TestHost.settle
        }
        root.send(Msg.Stop())
        yield* TestHost.settle
        assert.deepStrictEqual(exits, ["Success", "Fail", "Interrupt"])
        assert.strictEqual(root.text(), "tx")
        assert.isFalse(root.log().some((entry) => entry._tag === "Unmounted"))
      })))

    it.effect("a write lands in its entry without a request, and changes never shows the patch", () =>
      provideHost(Effect.gen(function*() {
        const server = makeServer()
        const App = Component.provide(
          EditorPage,
          Layer.mergeAll(commands(server), fetcher(server))
        )
        const root = yield* TestHost.mount(App, {})
        yield* TestHost.settle
        assert.strictEqual(server.requests, 1)
        click(root, "rename")
        yield* TestHost.settle
        // The patch is live from issue. `changes` shows the server value, which doesn't move.
        assert.include(root.text(), "count 0")
        yield* TestClock.adjust("1 second")
        yield* TestHost.settle
        assert.include(root.text(), "count 1")
        // The write was stored fresh, so the run's own invalidation skipped it.
        assert.strictEqual(server.requests, 1)
      })))

    it.effect("the query mount option sets how long an unwatched entry stays", () =>
      provideHost(Effect.gen(function*() {
        const server = makeServer()
        const App = Component.provide(
          page(Editor),
          Layer.mergeAll(fetcher(server), commands(server))
        )
        const root = yield* TestHost.mount(App, {}, {
          query: { idleTimeToLive: "1 second" }
        })
        yield* TestHost.settle
        root.send(PageMsg.Watch({ on: false }))
        yield* TestHost.settle
        yield* TestClock.adjust("500 millis")
        root.send(PageMsg.Watch({ on: true }))
        yield* TestHost.settle
        assert.strictEqual(server.requests, 1)
        root.send(PageMsg.Watch({ on: false }))
        yield* TestHost.settle
        yield* TestClock.adjust("1 second")
        root.send(PageMsg.Watch({ on: true }))
        yield* TestHost.settle
        assert.strictEqual(server.requests, 2)
      })))
  })

  describe("Subscriptions", () => {
    it.effect("are diffed by key, closing the old key before starting the new one", () =>
      provideHost(Effect.gen(function*() {
        const Msg = UiSchema.TaggedEnum({
          Room: { id: Schema.String },
          Said: { text: Schema.String }
        })
        const Chat = Component.define({
          name: "Chat",
          model: Schema.Struct({
            room: Schema.String,
            said: Schema.Array(Schema.String)
          }),
          message: Msg
        }).make({
          init: () => ({ room: "1", said: [] }),
          update: ($, message) =>
            Msg.match(message, {
              Room: ({ id }) => ({ ...$.model, room: id }),
              Said: ({ text }) => ({
                ...$.model,
                said: [...$.model.said, text]
              })
            }),
          view: (h, model) => h.text(model.said.join(",")),
          subscriptions: ({ model }) => [
            Subscription.make(
              "room",
              [model.room],
              ([room]) => Stream.make(Msg.Said({ text: `hello from ${room}` }))
            )
          ]
        })
        const root = yield* TestHost.mount(Chat, {})
        yield* TestHost.settle
        root.send(Msg.Room({ id: "2" }))
        yield* TestHost.settle
        assert.strictEqual(root.text(), "hello from 1,hello from 2")
        const changes = root.log().filter((entry) =>
          entry._tag === "SubscriptionStarted" ||
          entry._tag === "SubscriptionStopped"
        ) as ReadonlyArray<
          MessageLog.SubscriptionStarted | MessageLog.SubscriptionStopped
        >
        assert.deepStrictEqual(changes.map((entry) => entry._tag), [
          "SubscriptionStarted",
          "SubscriptionStopped",
          "SubscriptionStarted"
        ])
        assert.notStrictEqual(changes[0].key, changes[2].key)
      })))

    it.effect("log the name and deps their key was built from, in memory and on the Wire", () =>
      provideHost(Effect.gen(function*() {
        const Msg = Schema.TaggedUnion({ Left: {}, Said: {} })
        const said = Msg.make({ _tag: "Said" })
        const Chat = Component.define({
          name: "Chat",
          model: Schema.Boolean,
          message: Msg
        }).make({
          init: () => true,
          update: ($, message) => message._tag === "Left" ? false : $.model,
          view: (h) => h.text("chat"),
          subscriptions: ({ model: inRoom }) => [
            Subscription.make("tick", Stream.never),
            // Deps JSON has no form for: the key tells them apart, and the Wire only has to be readable.
            inRoom &&
            Subscription.make("room", ["42", NaN, -0], () => Stream.make(said))
          ]
        })
        const root = yield* TestHost.mount(Chat, {})
        yield* TestHost.settle
        root.send(Msg.make({ _tag: "Left" }))
        yield* TestHost.settle

        const tick = { key: "tick", name: "tick", deps: undefined }
        const room = {
          key: "room:\"42\",NaN,-0",
          name: "room",
          deps: ["42", NaN, -0]
        }
        const subscriptionOf = (entry: MessageLog.Entry) =>
          entry._tag === "SubscriptionStarted" ||
            entry._tag === "SubscriptionStopped"
            ? [entry._tag, {
              key: entry.key,
              name: entry.name,
              deps: entry.deps
            }]
            : entry._tag === "Update" && entry.source._tag === "Subscription"
            ? ["Update", {
              key: entry.source.key,
              name: entry.source.name,
              deps: entry.source.deps
            }]
            : undefined
        assert.deepStrictEqual(
          root.log().map(subscriptionOf).filter((entry) => entry !== undefined),
          [
            ["SubscriptionStarted", tick],
            ["SubscriptionStarted", room],
            ["Update", room],
            ["SubscriptionStopped", room]
          ]
        )

        const encoder = MessageLog.makeEncoder()
        const wire = root.log().map((entry) => {
          const frame = encoder.encode(entry)
          assert.deepStrictEqual(
            Schema.decodeUnknownSync(MessageLog.Wire)(
              JSON.parse(JSON.stringify(frame))
            ),
            frame
          )
          return frame
        })
        const wireTick = { key: "tick", name: "tick", deps: null }
        const wireRoom = {
          key: room.key,
          name: "room",
          deps: ["42", { "~unserialisable": "number" }, 0]
        }
        const wireOf = (frame: MessageLog.Wire) =>
          frame._tag === "SubscriptionStarted" ||
            frame._tag === "SubscriptionStopped"
            ? [frame._tag, {
              key: frame.key,
              name: frame.name,
              deps: frame.deps
            }]
            : frame._tag === "Update" && frame.source._tag === "Subscription"
            ? ["Update", {
              key: frame.source.key,
              name: frame.source.name,
              deps: frame.source.deps
            }]
            : undefined
        assert.deepStrictEqual(
          wire.map(wireOf).filter((frame) => frame !== undefined),
          [
            ["SubscriptionStarted", wireTick],
            ["SubscriptionStarted", wireRoom],
            ["Update", wireRoom],
            ["SubscriptionStopped", wireRoom]
          ]
        )
      })))

    it.effect("two entries with one key fail the instance", () =>
      provideHost(Effect.gen(function*() {
        const Twice = Component.define({
          name: "Twice",
          model: Schema.Boolean,
          message: Schema.Boolean
        })
          .make({
            init: () => false,
            update: (_, twice) => twice,
            view: (h) => h.text("up"),
            subscriptions: ({ model: twice }) => [
              Subscription.make("room", "42", () => Stream.never),
              // A one-element tuple has the key of a single dep.
              twice && Subscription.make("room", ["42"], () => Stream.never)
            ]
          })
        const root = yield* TestHost.mount(Twice, {}, {
          fallback: (_, h) => h.el("h1", "down")
        })
        yield* TestHost.settle
        assert.strictEqual(root.text(), "up")
        root.send(true)
        const crashed = yield* Effect.flip(TestHost.settle)
        assert.strictEqual(crashed._tag, "RootCrashed")
        assert.strictEqual(root.text(), "down")
        const failed = root.log().find((entry) =>
          entry._tag === "Failed"
        ) as MessageLog.Failed
        assert.deepStrictEqual([failed.in, failed.name], [
          "subscription",
          "room:\"42\""
        ])
        assert.include(
          Cause.pretty(failed.cause),
          "/Twice: two Subscriptions share the key room:\"42\""
        )
      })))

    it.effect("a Stream's message is dropped when rendering the ancestors first removes its key", () =>
      provideHost(Effect.gen(function*() {
        const feed = yield* Queue.unbounded<string>()
        const Receiver = Component.define({
          name: "Receiver",
          model: Schema.Array(Schema.String),
          message: Schema.String,
          props: Schema.Struct({ listen: Schema.Boolean })
        }).make({
          init: () => [],
          update: ($, message) => [...$.model, message],
          view: (h, model) => h.text(model.join(",")),
          subscriptions: ({ props }) =>
            props.listen
              ? [Subscription.make("feed", Stream.fromQueue(feed))]
              : []
        })
        const Parent = Component.define({
          name: "Parent",
          model: Schema.Boolean,
          message: Schema.Boolean
        }).make({
          init: () => true,
          update: (_, listen) => listen,
          view: (h, listen) => Receiver(h, { key: "r", props: { listen } })
        })
        const root = yield* TestHost.mount(Parent, {})
        yield* TestHost.settle
        // The Stream's fiber takes from the queue on the scheduler, which `settle` doesn't wait for.
        const received = Effect.andThen(Effect.yieldNow, TestHost.settle)
        Queue.offerUnsafe(feed, "a")
        yield* received
        assert.strictEqual(root.text(), "a")
        // The message is on its way when the parent stops listening, before the parent renders.
        Queue.offerUnsafe(feed, "b")
        root.send(false)
        yield* received
        // The receiver kept its Model, so it stayed mounted, and never took "b".
        assert.strictEqual(root.text(), "a")
        assert.deepStrictEqual(
          tags(root, "/Parent/Receiver[r]").filter((tag) =>
            tag.startsWith("Subscription")
          ),
          [
            "SubscriptionStarted",
            "SubscriptionStopped"
          ]
        )
      })))
  })

  it.effect("a child's emit from init reaches its parent after the parent's first Model", () =>
    provideHost(Effect.gen(function*() {
      const Child = Component.define({
        name: "Child",
        model: Schema.Number,
        message: Schema.Never,
        events: Schema.String
      }).make({
        init: ($) => $.set(0).emit("ready"),
        update: ($) => $.model,
        view: (h) => h.text("child")
      })
      const Parent = Component.define({
        name: "Parent",
        model: Schema.Number,
        message: Schema.String
      }).make({
        init: () => 0,
        update: ($) => $.model + 1,
        view: (h, n) =>
          h.el(
            "div",
            String(n),
            Child(h, { key: "c", onEmit: (message) => message })
          )
      })
      const root = yield* TestHost.mount(Parent, {})
      yield* TestHost.settle
      assert.strictEqual(root.model(), 1)
      assert.strictEqual(root.text(), "1child")
    })))

  it.effect("a tagged onEmit record sends mapped messages to the parent and drops ignored events", () =>
    provideHost(Effect.gen(function*() {
      const Events = UiSchema.TaggedEnum({
        Renamed: { name: Schema.String },
        Discarded: {}
      })
      const Child = Component.define({
        name: "Child",
        model: Schema.Number,
        message: Schema.Never,
        events: Events
      }).make({
        init: ($) =>
          $.set(0).emit(Events.Discarded(), Events.Renamed({ name: "Ada" })),
        update: ($) => $.model,
        view: (h) => h.text("child")
      })
      const Parent = Component.define({
        name: "Parent",
        model: Schema.Array(Schema.String),
        message: Schema.String
      }).make({
        init: () => [],
        update: ($, message) => [...$.model, message],
        view: (h) =>
          Child(h, {
            onEmit: { Renamed: ({ name }) => name, Discarded: () => undefined }
          })
      })
      const root = yield* TestHost.mount(Parent, {})
      yield* TestHost.settle
      assert.deepStrictEqual(root.model(), ["Ada"])
    })))

  describe("props", () => {
    it.effect("a props change re-renders the child without reaching its update", () =>
      provideHost(Effect.gen(function*() {
        const Label = Component.define({
          name: "Label",
          props: Schema.Struct({ text: Schema.String }),
          model: Schema.Number,
          message: Schema.Never
        }).make({
          init: () => 0,
          update: ($) => $.model,
          view: (h) => h.el("span", h.props.text)
        })
        const Msg = UiSchema.TaggedEnum({ Rename: { text: Schema.String } })
        const Host = Component.define({
          name: "Host",
          model: Schema.String,
          message: Msg
        }).make({
          init: () => "one",
          update: (_, message) => message.text,
          view: (h, text) =>
            h.el("div", Label(h, { key: "l", props: { text } }))
        })
        const root = yield* TestHost.mount(Host, {})
        const span = root.get(Locator.tag("span"))
        root.send(Msg.Rename({ text: "two" }))
        yield* TestHost.settle
        assert.strictEqual(root.text(), "two")
        assert.strictEqual(root.get(Locator.tag("span")), span)
        // The new props are logged, and no Update: update never sees them.
        assert.deepStrictEqual(tags(root, "/Host/Label[l]"), [
          "Mounted",
          "PropsChanged"
        ])
        const changed = root.log().find((entry) =>
          entry._tag === "PropsChanged"
        )
        assert.deepStrictEqual(
          changed?._tag === "PropsChanged" ? changed.props : undefined,
          { text: "two" }
        )
        // Equal props log nothing.
        root.send(Msg.Rename({ text: "two" }))
        yield* TestHost.settle
        assert.deepStrictEqual(tags(root, "/Host/Label[l]"), [
          "Mounted",
          "PropsChanged"
        ])
      })))

    it.effect("props are compared a field at a time, and a field that differs by reference by Equal", () =>
      provideHost(Effect.gen(function*() {
        const Row = Schema.Struct({
          id: Schema.Number,
          label: Schema.String,
          tags: Schema.Array(Schema.String)
        })
        const Cell = Component.define({
          name: "Cell",
          props: Schema.Struct({
            row: Row,
            at: Schema.Option(Schema.Number),
            ratio: Schema.Number
          }),
          model: Schema.Null,
          message: Schema.Never
        }).make({
          init: () => null,
          update: ($) => $.model,
          view: (h) =>
            h.el("span", `${h.props.row.label}:${h.props.row.tags.join()}`)
        })
        const Props = Schema.Struct({
          row: Row,
          at: Schema.Option(Schema.Number),
          ratio: Schema.Number
        })
        const Table = Component.define({
          name: "Table",
          model: Props,
          message: Props
        }).make({
          init: () => ({
            row: { id: 1, label: "one", tags: ["x"] },
            at: Option.some(1),
            ratio: NaN
          }),
          update: (_, next) => next,
          view: (h, model) => h.el("div", Cell(h, { key: "c", props: model }))
        })
        const root = yield* TestHost.mount(Table, {})
        yield* TestHost.settle
        const changes = () =>
          tags(root, "/Table/Cell[c]").filter((tag) => tag === "PropsChanged")
            .length

        // New records that hold what the old ones held, NaN included: nothing changed.
        root.send({
          row: { id: 1, label: "one", tags: ["x"] },
          at: Option.some(1),
          ratio: NaN
        })
        yield* TestHost.settle
        assert.strictEqual(changes(), 0)

        // One field of a record differs.
        root.send({
          row: { id: 1, label: "uno", tags: ["x"] },
          at: Option.some(1),
          ratio: NaN
        })
        yield* TestHost.settle
        assert.strictEqual(changes(), 1)
        assert.strictEqual(root.text(), "uno:x")

        // The fields that hold plain values are the same, and one that holds an array isn't.
        root.send({
          row: { id: 1, label: "uno", tags: ["x", "y"] },
          at: Option.some(1),
          ratio: NaN
        })
        yield* TestHost.settle
        assert.strictEqual(changes(), 2)
        assert.strictEqual(root.text(), "uno:x,y")

        // A value with its own equality.
        root.send({
          row: { id: 1, label: "uno", tags: ["x", "y"] },
          at: Option.some(2),
          ratio: NaN
        })
        yield* TestHost.settle
        assert.strictEqual(changes(), 3)
        root.send({
          row: { id: 1, label: "uno", tags: ["x", "y"] },
          at: Option.some(2),
          ratio: 0.5
        })
        yield* TestHost.settle
        assert.strictEqual(changes(), 4)
      })))
  })

  describe("provided Layers", () => {
    class Greeter extends Context.Service<
      Greeter,
      { readonly greet: (name: string) => string }
    >()("test/Greeter") {}
    class Greet extends Command.Service<Greet>()(
      "test/Greet",
      {
        args: { name: Schema.String },
        success: Schema.String,
        error: Schema.Never,
        invalidates: () => []
      }
    ) {
      static readonly layer = this.toLayer(
        Effect.gen(function*() {
          const greeter = yield* Greeter
          return ({ name }) => Effect.succeed(greeter.greet(name))
        })
      )
    }
    const Hello = Component.define({
      name: "Hello",
      model: Schema.String,
      message: Schema.String
    }).make({
      init: ($) => $.set("...").run(Greet.make({ name: "world" })),
      update: (_, message) => message,
      view: (h, text) => h.text(text)
    })

    it.effect("Commands wait for a Layer that builds in the background", () =>
      provideHost(Effect.gen(function*() {
        const slow = Layer.effect(
          Greeter,
          Effect.as(Effect.sleep("1 second"), {
            greet: (name: string) => `hello ${name}`
          })
        )
        const App = Component.provide(
          Hello,
          Greet.layer.pipe(Layer.provideMerge(slow))
        )
        const root = yield* TestHost.mount(App, {})
        yield* TestHost.settle
        assert.strictEqual(root.text(), "...")
        yield* TestClock.adjust("1 second")
        yield* TestHost.settle
        assert.strictEqual(root.text(), "hello world")
        assert.deepStrictEqual(tags(root).slice(0, 6), [
          "SessionStarted",
          "Mounted",
          "LayerPending",
          "LayerReady",
          "CommandStarted",
          "Update"
        ])
      })))

    it.effect("a Layer value is built once per Env and closed by its last user", () =>
      provideHost(Effect.gen(function*() {
        let builds = 0
        let closes = 0
        const counted = Layer.effect(
          Greeter,
          Effect.acquireRelease(
            Effect.sync(() => {
              builds++
              return { greet: (name: string) => `hi ${name}` }
            }),
            () => Effect.sync(() => closes++)
          )
        )
        const Shared = Component.provide(
          Hello,
          Greet.layer.pipe(Layer.provideMerge(counted))
        )
        const Msg = UiSchema.TaggedEnum({ Drop: {} })
        const Two = Component.define({
          name: "Two",
          model: Schema.Number,
          message: Msg
        }).make({
          init: () => 2,
          update: ($) => $.model - 1,
          view: (h, n) =>
            h.el(
              "div",
              Array.from({ length: n }, (_, i) =>
                Shared(h, { key: String(i), props: {} }))
            )
        })
        const root = yield* TestHost.mount(Two, {})
        yield* TestHost.settle
        assert.strictEqual(root.text(), "hi worldhi world")
        assert.strictEqual(builds, 1)
        root.send(Msg.Drop())
        yield* TestHost.settle
        assert.strictEqual(closes, 0)
        root.send(Msg.Drop())
        yield* TestHost.settle
        assert.strictEqual(closes, 1)
      })))

    it.effect("onFailure turns a failed build into a message, and the component stays mounted", () =>
      provideHost(Effect.gen(function*() {
        const failing = Layer.effect(Greeter, Effect.fail("offline" as const))
        const Msg = UiSchema.TaggedEnum({ Failed: {} })
        const Status = Component.define({
          name: "Status",
          model: Schema.String,
          message: Msg
        }).make({
          init: () => "loading",
          update: () => "failed",
          view: (h, text) => h.text(text)
        })
        const App = Component.provide(Status, failing, {
          onFailure: () => Msg.Failed()
        })
        const root = yield* TestHost.mount(App, {})
        yield* TestHost.settle
        assert.strictEqual(root.text(), "failed")
        assert.includeMembers(tags(root), ["LayerFailed", "Update"])
        assert.notInclude(tags(root), "Failed")
      })))

    describe("a memoised sub-Layer", () => {
      class Store
        extends Context.Service<Store, { readonly id: number }>()("test/Store")
      {}
      class ReadStore extends Command.Service<ReadStore>()(
        "test/ReadStore",
        {
          args: {},
          success: Schema.String,
          error: Schema.Never,
          invalidates: () => []
        }
      ) {
        static readonly layer = this.toLayer(
          Store.useSync((store) => () => Effect.succeed(String(store.id)))
        )
      }
      const StoreId = Component.define({
        name: "StoreId",
        model: Schema.String,
        message: Schema.String
      }).make({
        init: ($) => $.set("").run(ReadStore.make()),
        update: (_, id) => id,
        view: (h, id) => h.text(`[${id}]`)
      })
      const DropMsg = UiSchema.TaggedEnum({ Drop: { key: Schema.String } })
      /** Shows one child per key, in order, until the key is dropped. */
      const Siblings = (
        children: Record<string, Component.Mountable<{}, never, never>>
      ) =>
        Component.define({
          name: "Siblings",
          model: Schema.Array(Schema.String),
          message: DropMsg
        }).make({
          init: () => Object.keys(children),
          update: ($, { key }) => $.model.filter((k) => k !== key),
          view: (h, keys) =>
            h.el("div", keys.map((key) => children[key](h, { key, props: {} })))
        })
      const drop = (root: TestHost.TestRoot<any, any, any>, key: string) =>
        root.send(DropMsg.Drop({ key }))

      it.effect("is shared by every provide that resolves from the same Env, and closed by its last user", () =>
        provideHost(Effect.gen(function*() {
          let builds = 0
          let closes = 0
          const store = Layer.effect(
            Store,
            Effect.acquireRelease(
              Effect.sync(() => ({ id: ++builds })),
              () => Effect.sync(() => closes++)
            )
          )
          // Two different provided Layers that each wrap the same stateful Layer.
          const A = Component.provide(
            StoreId,
            ReadStore.layer.pipe(Layer.provide(store))
          )
          const B = Component.provide(
            StoreId,
            ReadStore.layer.pipe(Layer.provide(store))
          )
          const root = yield* TestHost.mount(
            Siblings({ a1: A, a2: A, b: B }),
            {}
          )
          yield* TestHost.settle
          assert.strictEqual(root.text(), "[1][1][1]")
          assert.strictEqual(builds, 1)
          drop(root, "a1")
          drop(root, "a2")
          yield* TestHost.settle
          assert.strictEqual(closes, 0)
          drop(root, "b")
          yield* TestHost.settle
          assert.strictEqual(closes, 1)
        })))

      it.effect("is built again under an Env that provides different dependencies", () =>
        provideHost(Effect.gen(function*() {
          class Project
            extends Context.Service<Project, { readonly id: string }>()(
              "test/Project"
            )
          {}
          class ReadProject extends Command.Service<ReadProject>()(
            "test/ReadProject",
            {
              args: {},
              success: Schema.String,
              error: Schema.Never,
              invalidates: () => []
            }
          ) {
            static readonly layer = this.toLayer(
              Project.useSync((project) => () => Effect.succeed(project.id))
            )
          }
          const ProjectId = Component.define({
            name: "ProjectId",
            model: Schema.String,
            message: Schema.String
          }).make({
            init: ($) => $.set("").run(ReadProject.make()),
            update: (_, id) => id,
            view: (h, id) => h.text(`[${id}]`)
          })
          // One Layer value, captured against whichever Project its Env has.
          const Task = Component.provide(ProjectId, ReadProject.layer)
          const PageView = Component.define({
            name: "PageView",
            props: Schema.Struct({ id: Schema.String }),
            model: Schema.Null,
            message: Schema.Never
          }).make({
            init: () => null,
            update: ($) => $.model,
            view: (h) => h.el("div", Task(h, { key: "task", props: {} }))
          })
          const Page = Component.provide(
            PageView,
            (props) => Layer.succeed(Project, { id: props.id })
          )
          const Split = Component.define({
            name: "Split",
            model: Schema.Null,
            message: Schema.Never
          }).make({
            init: () => null,
            update: ($) => $.model,
            view: (h) =>
              h.el(
                "div",
                Page(h, { key: "a", props: { id: "a" } }),
                Page(h, { key: "b", props: { id: "b" } })
              )
          })
          const root = yield* TestHost.mount(Split, {})
          yield* TestHost.settle
          assert.strictEqual(root.text(), "[a][b]")
        })))

      it.effect("its first builder unmounting mid-build leaves every other user to mount normally", () =>
        provideHost(Effect.gen(function*() {
          let builds = 0
          let active = false
          const cleanupStarted = yield* Deferred.make<void>()
          const finishCleanup = yield* Deferred.make<void>()
          const slow = Layer.effect(
            Store,
            Effect.gen(function*() {
              yield* Effect.acquireRelease(
                Effect.sync(() => {
                  if (active) {
                    throw new Error("acquired before prior release completed")
                  }
                  active = true
                }),
                () =>
                  Effect.gen(function*() {
                    yield* Deferred.succeed(cleanupStarted, undefined)
                    yield* Deferred.await(finishCleanup)
                    active = false
                  })
              )
              yield* Effect.sleep("1 second")
              return { id: ++builds }
            })
          )
          const A = Component.provide(
            StoreId,
            ReadStore.layer.pipe(Layer.provide(slow))
          )
          const B = Component.provide(
            StoreId,
            ReadStore.layer.pipe(Layer.provide(slow))
          )
          const C = Component.provide(
            StoreId,
            ReadStore.layer.pipe(Layer.provide(slow))
          )
          const root = yield* TestHost.mount(Siblings({ a: A, b: B, c: C }), {})
          yield* TestHost.settle
          drop(root, "a")
          yield* TestHost.settle
          yield* Deferred.await(cleanupStarted)
          yield* Deferred.succeed(finishCleanup, undefined)
          yield* TestHost.settle
          yield* TestClock.adjust("1 second")
          yield* TestHost.settle
          assert.strictEqual(root.text(), "[1][1]")
          for (const key of ["b", "c"]) {
            const survivor = tags(root, `/Siblings/StoreId[${key}]`)
            assert.include(survivor, "LayerReady")
            assert.notInclude(survivor, "LayerFailed")
          }
        })))

      it.effect("its users build again without waiting for another root's release", () =>
        provideHost(Effect.gen(function*() {
          const otherGate = yield* Deferred.make<void>()
          const otherReleasing = yield* Deferred.make<void>()
          const Other = Component.provide(
            StoreId,
            ReadStore.layer.pipe(Layer.provide(Layer.effect(
              Store,
              Effect.never.pipe(Effect.onInterrupt(() =>
                Effect.andThen(
                  Deferred.succeed(otherReleasing, undefined),
                  Deferred.await(otherGate)
                )
              ))
            )))
          )
          const other = yield* TestHost.mount(Siblings({ a: Other }), {})
          yield* TestHost.settle
          drop(other, "a")
          yield* TestHost.settle
          yield* Deferred.await(otherReleasing)
          const cleanupStarted = yield* Deferred.make<void>()
          const finishCleanup = yield* Deferred.make<void>()
          let builds = 0
          const slow = Layer.effect(
            Store,
            Effect.gen(function*() {
              yield* Effect.acquireRelease(
                Effect.void,
                () =>
                  Effect.andThen(
                    Deferred.succeed(cleanupStarted, undefined),
                    Deferred.await(finishCleanup)
                  )
              )
              yield* Effect.sleep("1 second")
              return { id: ++builds }
            })
          )
          const A = Component.provide(
            StoreId,
            ReadStore.layer.pipe(Layer.provide(slow))
          )
          const B = Component.provide(
            StoreId,
            ReadStore.layer.pipe(Layer.provide(slow))
          )
          const root = yield* TestHost.mount(Siblings({ a: A, b: B }), {})
          yield* TestHost.settle
          drop(root, "a")
          yield* TestHost.settle
          yield* Deferred.await(cleanupStarted)
          yield* Deferred.succeed(finishCleanup, undefined)
          yield* TestHost.settle
          yield* TestClock.adjust("1 second")
          yield* TestHost.settle
          const text = root.text()
          yield* Deferred.succeed(otherGate, undefined)
          assert.strictEqual(text, "[1]")
        })))

      it.effect("a build whose users unmount while it waits to start again ends there, and isn't started", () =>
        provideHost(Effect.gen(function*() {
          let starts = 0
          let reports = 0
          let fibers = 0
          const cleanupStarted = yield* Deferred.make<void>()
          const finishCleanup = yield* Deferred.make<void>()
          const held = Layer.effect(
            Store,
            Effect.acquireRelease(
              Effect.sync(() => starts++),
              () =>
                Effect.andThen(
                  Deferred.succeed(cleanupStarted, undefined),
                  Deferred.await(finishCleanup)
                )
            ).pipe(Effect.andThen(Effect.never))
          )
          const A = Component.provide(
            StoreId,
            ReadStore.layer.pipe(Layer.provide(held))
          )
          const B = Component.provide(
            StoreId,
            ReadStore.layer.pipe(Layer.provide(held)),
            {
              onFailure: () => {
                reports++
                return "failed"
              }
            }
          )
          const root = yield* TestHost.mount(Siblings({ a: A, b: B }), {}).pipe(
            Effect.provideService(Metric.FiberRuntimeMetrics, {
              recordFiberStart: () => fibers++,
              recordFiberEnd: () => fibers--
            })
          )
          yield* TestHost.settle
          drop(root, "a")
          yield* TestHost.settle
          yield* Deferred.await(cleanupStarted)
          // B is waiting for A's cleanup to end.
          drop(root, "b")
          yield* TestHost.settle
          // Only A's cleanup is still running, and A's close, which waits for it.
          assert.strictEqual(fibers, 2)
          yield* Deferred.succeed(finishCleanup, undefined)
          yield* TestHost.settle
          assert.strictEqual(fibers, 0)
          assert.strictEqual(starts, 1)
          assert.strictEqual(reports, 0)
          assert.notInclude(tags(root, "/Siblings/StoreId[b]"), "LayerFailed")
        })))

      it.effect("a Layer that interrupts itself fails once, though another build was interrupted meanwhile", () =>
        provideHost(Effect.gen(function*() {
          let builds = 0
          const A = Component.provide(
            StoreId,
            ReadStore.layer.pipe(
              Layer.provide(Layer.effect(Store, Effect.never))
            )
          )
          const B = Component.provide(
            StoreId,
            ReadStore.layer.pipe(Layer.provide(Layer.effect(
              Store,
              Effect.sleep("1 second").pipe(
                Effect.andThen(Effect.sync(() => builds++)),
                Effect.andThen(Effect.interrupt)
              )
            ))),
            { onFailure: () => "failed" }
          )
          const root = yield* TestHost.mount(Siblings({ a: A, b: B }), {})
          yield* TestHost.settle
          drop(root, "a")
          yield* TestHost.settle
          yield* TestClock.adjust("2 seconds")
          yield* TestHost.settle
          assert.strictEqual(builds, 1)
          assert.strictEqual(root.text(), "[failed]")
        })))
    })
  })

  describe("features", () => {
    class Badge extends Feature.Service<Badge>()("test/Badge", {
      props: Schema.Struct({ label: Schema.String }),
      events: Schema.String
    }) {}
    const BadgeImpl = Component.define({
      name: "BadgeImpl",
      props: Schema.Struct({ label: Schema.String }),
      model: Schema.Number,
      message: Schema.Never,
      events: Schema.String
    }).make({
      init: () => 0,
      update: ($) => $.model,
      view: (h) => h.el("b", h.props.label)
    })
    const Msg = UiSchema.TaggedEnum({ Heard: { text: Schema.String } })
    const Shell = Component.define({
      name: "Shell",
      model: Schema.Array(Schema.String),
      message: Msg
    }).make({
      init: () => [],
      update: ($, message) => [...$.model, message.text],
      view: (h) =>
        h.el(
          "div",
          Badge.render(h, {
            key: "b",
            props: { label: "new" },
            onEmit: (text) => Msg.Heard({ text }),
            fallback: (result) =>
              h.text(result._tag === "Initial" ? "loading" : "unavailable")
          })
        )
    })

    it.effect("a feature child shows its fallback until the Layer above it is ready", () =>
      provideHost(Effect.gen(function*() {
        const slowBadge = Layer.merge(
          Badge.toLayer(BadgeImpl),
          Layer.effectDiscard(Effect.sleep("1 second"))
        )
        const App = Component.provide(Shell, slowBadge)
        const root = yield* TestHost.mount(App, {})
        assert.strictEqual(root.text(), "loading")
        yield* TestClock.adjust("1 second")
        yield* TestHost.settle
        assert.strictEqual(root.text(), "new")
        assert.include(tags(root, "/Shell/test/Badge[b]"), "Mounted")
      })))

    it.effect("stub records props and emits what the test sends", () =>
      Effect.gen(function*() {
        const stub = TestHost.stub(Badge)
        const root = yield* TestHost.mount(Shell, {}).pipe(
          Effect.provide(stub.layer)
        )
        yield* TestHost.settle
        assert.deepStrictEqual(stub.props(), [{ label: "new" }])
        assert.isDefined(root.query(Locator.attr("data-stub", "test/Badge")))
        stub.emit("ping")
        yield* TestHost.settle
        assert.deepStrictEqual(root.model(), ["ping"])
      }).pipe(provideHost))
  })

  describe("MessageLog", () => {
    it.effect("a logged session replays through Story.fromLog", () =>
      provideHost(Effect.gen(function*() {
        const root = yield* TestHost.mount(Counter, { initial: 5 })
        click(root, "+")
        click(root, "-")
        click(root, "+")
        yield* TestHost.settle
        const replay = Story.fromLog(Counter, root.log())
        assert.strictEqual(replay.replayed, 3)
        assert.isUndefined(replay.divergence)
        assert.deepStrictEqual(replay.model, { count: 6 })

        // Through the Wire, and against a component whose update changed.
        const encoder = MessageLog.makeEncoder()
        const wire = root.log().map(encoder.encode)
        assert.deepStrictEqual(Story.fromLog(Counter, wire).model, { count: 6 })
        const Changed = Component.define({
          name: "Counter",
          props: Schema.Struct({ initial: Schema.Number }),
          model: Schema.Struct({ count: Schema.Number }),
          message: CounterMessage
        }).make({
          init: ($) => ({ count: $.props.initial }),
          update: ($, message) => ({
            count: $.model.count + (message._tag === "Increment" ? 2 : -1)
          }),
          view: (h, model) => h.text(String(model.count))
        })
        const diverged = Story.fromLog(Changed, wire)
        assert.deepStrictEqual(diverged.divergence?.recorded.model, {
          count: 6
        })
        assert.deepStrictEqual(diverged.divergence?.recomputed.model, {
          count: 7
        })
        assert.strictEqual(diverged.divergence?.seq, wire[2].seq)
      })))

    it.effect("a message whose update throws is on its Failed entry, and crosses the Wire", () =>
      provideHost(Effect.gen(function*() {
        const Message = UiSchema.TaggedEnum({ Break: { why: Schema.String } })
        const Fragile = Component.define({
          name: "Fragile",
          props: Schema.Struct({ id: Schema.String }),
          model: Schema.Null,
          message: Message
        }).make({
          init: () => null,
          update: (_, message) => {
            throw new Error(message.why)
          },
          view: (h) => h.text("fragile")
        })
        const root = yield* TestHost.mount(Fragile, { id: "a" })
        const message = Message.Break({ why: "boom" })
        root.send(message)
        yield* Effect.exit(TestHost.settle)
        assert.notInclude(tags(root), "Update")
        const failed = root.log().find((entry) =>
          entry._tag === "Failed"
        ) as MessageLog.Failed
        assert.deepStrictEqual(failed.update, {
          message,
          source: { _tag: "Dispatch" }
        })
        const wire = MessageLog.makeEncoder().encode(failed) as Extract<
          MessageLog.Wire,
          { _tag: "Failed" }
        >
        assert.deepStrictEqual(wire.update, {
          message: { _tag: "Break", why: "boom" },
          source: { _tag: "Dispatch" }
        })
        assert.deepStrictEqual(wire.props, { id: "a" })
        assert.deepStrictEqual(
          Schema.decodeUnknownSync(MessageLog.Wire)(
            JSON.parse(JSON.stringify(wire))
          ),
          wire
        )
      })))

    it.effect("an instance logs Unmounted as it leaves the tree, and a Command's end once its fiber has exited", () =>
      provideHost(Effect.gen(function*() {
        const hold = Deferred.makeUnsafe<void>()
        const slow = Deferred.makeUnsafe<void>()
        const Message = UiSchema.TaggedEnum({ Close: {}, Done: {} })
        const done = Command.map(() => Message.Done())
        // Its Command can't be interrupted, so its close stays open until `hold` is done.
        const Holder = Component.define({
          name: "Holder",
          model: Schema.Null,
          message: Message
        }).make({
          init: ($) =>
            $.set(null).run(
              Command.make("test/Hold", { args: {} }, () =>
                Effect.uninterruptible(Deferred.await(hold))).make().pipe(
                  done
                )
            ),
          update: ($) => $.model,
          view: (h) => h.text("holder")
        })
        const Middle = Component.define({
          name: "Middle",
          model: Schema.Number,
          message: Message
        }).make(
          {
            init: ($) =>
              $.set(0).run(
                Command.make("test/Slow", { args: {} }, () =>
                  Deferred.await(slow)).make().pipe(done)
              ),
            update: ($, message) =>
              message._tag === "Done" ? $.model + 1 : $.model,
            view: (h, model) =>
              h.el("div", String(model), Holder(h, { key: "h", props: {} }))
          }
        )
        const Top = Component.define({
          name: "Top",
          model: Schema.Boolean,
          message: Message
        }).make({
          init: () => true,
          update: ($, message) => message._tag === "Close" ? false : $.model,
          view: (h, open) =>
            h.el("div", open ? Middle(h, { key: "m", props: {} }) : null)
        })
        const root = yield* TestHost.mount(Top, {})
        yield* TestHost.settle
        root.send(Message.Close())
        yield* TestHost.settle
        // Both are out of the tree, child first, though the child's Command is still running.
        assert.deepStrictEqual(
          root.log().filter((entry) => entry._tag === "Unmounted").map((
            entry
          ) => entry.path),
          ["/Top/Middle[m]/Holder[h]", "/Top/Middle[m]"]
        )
        assert.deepStrictEqual(tags(root, "/Top/Middle[m]/Holder[h]"), [
          "Mounted",
          "CommandStarted",
          "Unmounted"
        ])

        // The parent's Scope waits for the child's close. Its Command ends meanwhile, and its message is dropped.
        Deferred.doneUnsafe(slow, Exit.void)
        yield* TestHost.settle
        assert.deepStrictEqual(tags(root, "/Top/Middle[m]"), [
          "Mounted",
          "CommandStarted",
          "Unmounted",
          "CommandEnded"
        ])

        Deferred.doneUnsafe(hold, Exit.void)
        yield* TestHost.settle
        assert.deepStrictEqual(tags(root, "/Top/Middle[m]/Holder[h]"), [
          "Mounted",
          "CommandStarted",
          "Unmounted",
          "CommandInterrupted"
        ])
      })))

    it.effect("a run logs CommandStarted with its span, and its CommandInterrupted names what stopped it", () =>
      provideHost(Effect.gen(function*() {
        const Message = UiSchema.TaggedEnum({ Save: {}, Stop: {}, Saved: {} })
        const Save = Command.make("test/Save", { args: {} }, () => Effect.never)
        const Quit = Command.make(
          "test/Quit",
          { args: {} },
          () => Effect.interrupt
        )
        const Editor = Component.define({
          name: "Editor",
          model: Schema.Number,
          message: Message
        }).make(
          {
            init: ($) =>
              $.set(0).run(
                Quit.make().pipe(Command.map(() => Message.Saved()))
              ),
            update: ($, message) =>
              message._tag === "Save"
                ? $.set($.model + 1).run(
                  Save.make().pipe(Command.map(() => Message.Saved()))
                )
                : message._tag === "Stop"
                ? $.set($.model).run(Command.interrupt(Save))
                : $.model,
            view: (h, n) => h.text(String(n))
          }
        )
        const root = yield* TestHost.mount(Editor, {})
        root.send(Message.Save())
        yield* TestHost.settle
        root.send(Message.Stop())
        yield* TestHost.settle

        assert.strictEqual(MessageLog.wireVersion, 1)
        const encoder = MessageLog.makeEncoder()
        const wire = root.log().map((entry) =>
          Schema.decodeUnknownSync(MessageLog.Wire)(
            JSON.parse(JSON.stringify(encoder.encode(entry)))
          )
        )
        const updates = wire.filter((frame) => frame._tag === "Update")
        const frameOf = <Tag extends "CommandStarted" | "CommandInterrupted">(
          tag: Tag,
          name: string
        ) =>
          wire.find((frame): frame is Extract<MessageLog.Wire, { _tag: Tag }> =>
            frame._tag === tag && "name" in frame && frame.name === name
          )!
        const started = frameOf("CommandStarted", "test/Save")
        const interrupted = frameOf("CommandInterrupted", "test/Save")
        const quit = frameOf("CommandInterrupted", "test/Quit")
        assert.deepStrictEqual([quit.reason, quit.causedBy], [
          "self",
          undefined
        ])
        assert.deepStrictEqual(
          [
            started.issued,
            started.causedBy,
            typeof started.spanId,
            typeof started.traceId
          ],
          [
            { seq: updates[0]!.seq, index: 0 },
            updates[0]!.seq,
            "string",
            "string"
          ]
        )
        assert.deepStrictEqual(
          [
            interrupted.issued,
            interrupted.spanId,
            interrupted.causedBy,
            interrupted.reason
          ],
          [started.issued, started.spanId, updates[1]!.seq, "interrupt"]
        )
        const replay = Story.fromLog(Editor, wire)
        assert.deepStrictEqual([
          replay.model,
          replay.replayed,
          replay.divergence
        ], [1, 2, undefined])
      })))

    it.effect("makeEncoded queues on record, batches as Wire frames, recovers when onBatch dies, and drops after its Scope", () =>
      Effect.gen(function*() {
        const batches: Array<ReadonlyArray<MessageLog.WireEntry>> = []
        const scope = yield* Scope.make()
        const log = yield* MessageLog.makeEncoded((batch) =>
          batch[0]!.seq === 3
            ? Effect.die("inspector broke")
            : Effect.sync(() => batches.push(batch))
        ).pipe(Scope.provide(scope))
        log.record({
          _tag: "SessionStarted",
          seq: 1,
          at: 0,
          session: "s",
          app: "A"
        })
        log.record({
          _tag: "SessionStarted",
          seq: 2,
          at: 0,
          session: "s",
          app: "B"
        })
        assert.deepStrictEqual(batches, [])
        yield* Effect.yieldNow
        assert.deepStrictEqual(batches, [[
          { _tag: "SessionStarted", seq: 1, at: 0, session: "s", app: "A" },
          { _tag: "SessionStarted", seq: 2, at: 0, session: "s", app: "B" }
        ]])
        log.record({
          _tag: "SessionStarted",
          seq: 3,
          at: 0,
          session: "s",
          app: "C"
        })
        yield* Effect.yieldNow
        log.record({
          _tag: "SessionStarted",
          seq: 4,
          at: 0,
          session: "s",
          app: "D"
        })
        yield* Effect.yieldNow
        assert.deepStrictEqual(
          batches.map((batch) => batch.map((frame) => frame.seq)),
          [[1, 2], [4]]
        )
        yield* Scope.close(scope, Exit.void)
        log.record({
          _tag: "SessionStarted",
          seq: 5,
          at: 0,
          session: "s",
          app: "E"
        })
        yield* Effect.yieldNow
        assert.strictEqual(batches.length, 2)
      }))

    it.effect("makeEncoded masks overlapping keys, and sends any part its Schema rejects as a placeholder, checked containers included", () =>
      provideHost(Effect.gen(function*() {
        const EncodedSecret = Schema.Redacted(Schema.String).pipe(
          Schema.decodeTo(
            Schema.String,
            SchemaTransformation.transform({
              decode: Redacted.value,
              encode: Redacted.make
            })
          )
        )
        const Secret = Schema.Record(
          Schema.TemplateLiteral(["secret-", Schema.String]),
          EncodedSecret
        )
        const Loose = Schema.Record(Schema.String, Schema.Unknown)
        const Checked = Schema.Array(Schema.Number).check(Schema.isMinLength(2))
        for (const order of [[Secret, Loose], [Loose, Secret]] as const) {
          const signatures = order as unknown as readonly [
            typeof Secret,
            typeof Loose
          ]
          const Page = Schema.StructWithRest(Schema.Struct({}), signatures)
          const Entries = Schema.StructWithRest(
            Schema.Struct({ n: Schema.Number, list: Checked }),
            signatures
          )
          const State = Schema.Struct({
            entries: Entries,
            pages: Schema.Array(Page).check(Schema.isMinLength(2))
          })
          const page = (note: string) => ({ "secret-a": "must-not-log", note })
          const state = {
            entries: {
              n: "rejected-sibling",
              list: [987654321],
              "secret-a": "must-not-log"
            },
            pages: [page("unchecked-page")]
          } as unknown as typeof State.Type
          const Message = UiSchema.TaggedEnum({ Set: { state: State } })
          const Vault = Component.define({
            name: "Vault",
            props: State,
            model: State,
            message: Message
          }).make({
            init: () => state,
            update: (_, message) => message.state,
            view: (h) => h.text("vault")
          })
          const root = yield* TestHost.mount(Vault, state)
          root.send(Message.Set({
            state: {
              entries: { ...state.entries, other: 1 },
              pages: [page("checked-page"), page("checked-page")]
            } as unknown as typeof State.Type
          }))
          yield* TestHost.settle
          const frames: Array<MessageLog.WireEntry> = []
          const warnings: Array<string> = []
          const logger = Logger.make<unknown, void>((options) => {
            if (options.logLevel === "Warn") {
              warnings.push(String(options.message))
            }
          })
          yield* Effect.scoped(Effect.gen(function*() {
            const log = yield* MessageLog.makeEncoded((batch) =>
              Effect.sync(() => frames.push(...batch))
            )
            for (const entry of root.log()) log.record(entry)
            yield* Effect.yieldNow
          })).pipe(Effect.provide(Logger.layer([logger])))
          const json = JSON.stringify(frames)
          const copied = (JSON.parse(json) as Array<MessageLog.WireEntry>).map((
            frame
          ) => Schema.decodeUnknownSync(MessageLog.Wire)(frame))
          const failed = { "~unserialisable": "encode" }
          const redacted = { "~redacted": true }
          const masked = { n: failed, list: failed, "secret-a": redacted }
          const checkedPage = { "secret-a": redacted, note: "checked-page" }
          const before = { entries: masked, pages: failed }
          for (const received of [frames, copied]) {
            const mounted = received.find((frame) => frame._tag === "Mounted")!
            const update = received.find((frame) => frame._tag === "Update")!
            assert.deepStrictEqual([mounted.props, mounted.model], [
              before,
              before
            ])
            assert.deepStrictEqual([update.message, update.model], [failed, {
              entries: { ...masked, other: 1 },
              pages: [checkedPage, checkedPage]
            }])
          }
          for (
            const value of [
              "must-not-log",
              "rejected-sibling",
              "987654321",
              "unchecked-page"
            ]
          ) {
            assert.notInclude(json, value)
          }
          assert.deepStrictEqual(
            warnings.map((message) => message.split(" failed")[0]).sort(),
            [
              "MessageLog: Vault.message",
              "MessageLog: Vault.model",
              "MessageLog: Vault.props"
            ]
          )
        }
        const Keep = Command.make(
          "Keep",
          { args: { list: Checked } },
          () => Effect.void
        )
        assert.deepStrictEqual(
          MessageLog.encodeCommand(Keep.make({ list: [987654321] })).args,
          { list: [987654321] }
        )
      })))

    it.effect("a run that interrupts itself while its instance's close is held open logs self", () =>
      provideHost(Effect.gen(function*() {
        const hold = Deferred.makeUnsafe<void>()
        const quit = Deferred.makeUnsafe<void>()
        const Message = UiSchema.TaggedEnum({ Close: {}, Done: {} })
        const done = Command.map(() => Message.Done())
        const Holder = Component.define({
          name: "Holder",
          model: Schema.Null,
          message: Message
        }).make({
          init: ($) =>
            $.set(null).run(
              Command.make("test/Hold", { args: {} }, () =>
                Effect.uninterruptible(Deferred.await(hold))).make().pipe(
                  done
                )
            ),
          update: ($) => $.model,
          view: (h) => h.text("holder")
        })
        const Middle = Component.define({
          name: "Middle",
          model: Schema.Null,
          message: Message
        }).make({
          init: ($) =>
            $.set(null).run(
              Command.make("test/Quit", { args: {} }, () =>
                Effect.andThen(Deferred.await(quit), Effect.interrupt))
                .make().pipe(done)
            ),
          update: ($) => $.model,
          view: (h) => h.el("div", Holder(h, { key: "h", props: {} }))
        })
        const Top = Component.define({
          name: "Top",
          model: Schema.Boolean,
          message: Message
        }).make({
          init: () => true,
          update: ($, message) => message._tag === "Close" ? false : $.model,
          view: (h, open) =>
            h.el("div", open ? Middle(h, { key: "m", props: {} }) : null)
        })
        const root = yield* TestHost.mount(Top, {})
        yield* TestHost.settle
        root.send(Message.Close())
        yield* TestHost.settle
        Deferred.doneUnsafe(quit, Exit.void)
        yield* TestHost.settle
        const quitEnd = root.log().find((entry) =>
          entry._tag === "CommandInterrupted" && entry.name === "test/Quit"
        ) as MessageLog.CommandInterrupted
        assert.deepStrictEqual([quitEnd.reason, quitEnd.causedBy], [
          "self",
          undefined
        ])
        Deferred.doneUnsafe(hold, Exit.void)
        yield* TestHost.settle
      })))

    it.effect("a queued run's CommandStarted names the step that freed its group", () =>
      provideHost(Effect.gen(function*() {
        const gates = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()]
        const Message = UiSchema.TaggedEnum({ Save: {}, Saved: {} })
        const Save = Command.make(
          "test/Save",
          { args: { n: Schema.Number }, mode: "queue" },
          ({ n }) => Deferred.await(gates[n]!)
        )
        const Editor = Component.define({
          name: "Editor",
          model: Schema.Number,
          message: Message
        }).make(
          {
            init: () => 0,
            update: ($, message) =>
              message._tag === "Save"
                ? $.set($.model + 1).run(
                  Save.make({ n: $.model }).pipe(
                    Command.map(() => Message.Saved())
                  )
                )
                : $.model,
            view: (h, n) => h.text(String(n))
          }
        )
        const root = yield* TestHost.mount(Editor, {})
        root.send(Message.Save())
        root.send(Message.Save())
        yield* TestHost.settle
        Deferred.doneUnsafe(gates[0]!, Exit.void)
        yield* TestHost.settle
        const saved = root.log().find((entry) =>
          entry._tag === "Update" && entry.source._tag === "Command"
        )!
        const starts = root.log().filter((entry) =>
          entry._tag === "CommandStarted"
        )
        assert.deepStrictEqual(starts.map((entry) => entry.causedBy), [
          starts[0]!.issued.seq,
          saved.seq
        ])
        Deferred.doneUnsafe(gates[1]!, Exit.void)
        yield* TestHost.settle
      })))

    it.effect("a run whose result fails its instance names itself in Failed, which is its end", () =>
      provideHost(Effect.gen(function*() {
        const Message = UiSchema.TaggedEnum({ Saved: {} })
        for (
          const [name, command] of [
            [
              "test/Die",
              Command.make("test/Die", { args: {} }, () => Effect.die("boom"))
                .make().pipe(
                  Command.map(() => Message.Saved())
                )
            ],
            [
              "test/Throw",
              Command.make("test/Throw", { args: {} }, () => Effect.void).make()
                .pipe(Command.map(() => {
                  throw new Error("boom")
                }))
            ]
          ] as const
        ) {
          const Editor = Component.define({
            name: "Editor",
            model: Schema.Null,
            message: Message
          }).make(
            {
              init: ($) => $.set(null).run(command),
              update: ($) => $.model,
              view: (h) => h.text("editor")
            }
          )
          const root = yield* TestHost.mount(Editor, {})
          yield* Effect.exit(TestHost.settle)
          const started = root.log().find((entry) =>
            entry._tag === "CommandStarted"
          )!
          const failed = root.log().find((entry) => entry._tag === "Failed")!
          assert.deepStrictEqual([failed.in, failed.name, failed.issued], [
            "command",
            name,
            started.issued
          ])
          assert.notInclude(tags(root), "CommandInterrupted")
          assert.notInclude(tags(root), "CommandEnded")
          const wire = MessageLog.makeEncoder().encode(failed)
          assert.deepStrictEqual(
            Schema.decodeUnknownSync(MessageLog.Wire)(
              JSON.parse(JSON.stringify(wire))
            ),
            wire
          )
          assert.deepStrictEqual(
            (wire as MessageLog.WireEntry & { issued?: unknown }).issued,
            started.issued
          )
        }
      })))

    it("the Wire encodes args through their Schema, redacted, with a structural fallback per field", () => {
      const Send = Command.make(
        "Send",
        {
          args: {
            channel: Schema.String,
            token: Schema.Redacted(Schema.String),
            when: Schema.Date,
            nested: Schema.Struct({
              secret: Schema.Redacted(Schema.String),
              loose: Schema.Any
            }),
            f: Schema.Any
          },
          group: ["channel"]
        },
        () => Effect.succeed(1)
      )
      const command = Send.make({
        channel: "general",
        token: Redacted.make("secret"),
        when: new Date(0),
        nested: { secret: Redacted.make("hidden"), loose: new Date(0) },
        f: () => 1
      })
      const encoded = MessageLog.encodeCommand(command)
      assert.deepStrictEqual(encoded, {
        _tag: "Effect",
        name: "Send",
        group: `{"channel":"general"}`,
        args: {
          channel: "general",
          token: { "~redacted": true },
          when: "1970-01-01T00:00:00.000Z",
          nested: {
            secret: { "~redacted": true },
            loose: "1970-01-01T00:00:00.000Z"
          },
          f: { "~unserialisable": "function" }
        }
      })
      assert.notInclude(JSON.stringify(encoded), ":\"secret\"")
      assert.notInclude(JSON.stringify(encoded), "hidden")
    })

    it("the Wire's group is the group fields encoded with redaction, for a run and an Interrupt", () => {
      const Sync = Command.make(
        "Sync",
        {
          args: {
            secret: Schema.RedactedFromValue(Schema.String),
            room: Schema.String
          },
          group: ["secret", "room"]
        },
        () => Effect.succeed(1)
      )
      const command = Sync.make({
        secret: Redacted.make("secret-token"),
        room: "a"
      })
      const interrupt = Command.interrupt(Sync, {
        secret: Redacted.make("secret-token"),
        room: "a"
      })
      // The scheduling key keeps the real encoding, so two secrets are two groups.
      assert.strictEqual(command.groupKey, interrupt.groupKey)
      assert.include(command.groupKey, "secret-token")
      const placeholder = JSON.stringify({
        room: "a",
        secret: { "~redacted": true }
      })
      assert.strictEqual(MessageLog.encodeCommand(command).group, placeholder)
      assert.strictEqual(MessageLog.encodeCommand(interrupt).group, placeholder)
      assert.notInclude(
        JSON.stringify(MessageLog.encodeCommand(command)),
        "secret-token"
      )
      assert.notInclude(
        JSON.stringify(MessageLog.encodeCommand(interrupt)),
        "secret-token"
      )
    })

    it("the Wire falls back on the leaf that fails, keeping its siblings' codecs and redaction", () => {
      const EncodedSecret = Schema.Redacted(Schema.String).pipe(
        Schema.decodeTo(
          Schema.String,
          SchemaTransformation.transform({
            decode: Redacted.value,
            encode: Redacted.make
          })
        )
      )
      const Upload = Command.make(
        "Upload",
        {
          args: {
            items: Schema.Array(Schema.Struct({
              secret: EncodedSecret,
              file: Schema.instanceOf(File),
              n: Schema.NumberFromString
            })),
            pair: Schema.Tuple([
              Schema.NumberFromString,
              Schema.instanceOf(File)
            ]),
            choice: Schema.Union([
              Schema.NumberFromString,
              Schema.Struct({ file: Schema.instanceOf(File) })
            ]),
            hidden: Schema.Option(Schema.Redacted(Schema.String))
          }
        },
        () => Effect.succeed(1)
      )
      const file = new File(["x"], "a.txt")
      const command = Upload.make({
        items: [{ secret: "must-not-log", file, n: 2 }],
        pair: [3, file],
        choice: { file },
        // A malformed value under a Schema that declares a Redacted is a placeholder, not `structural`.
        hidden: "must-not-log-either" as any
      })
      const encoded = MessageLog.encodeCommand(command)
      assert.deepStrictEqual(encoded.args, {
        items: [{ secret: { "~redacted": true }, file: {}, n: "2" }],
        pair: ["3", {}],
        choice: { file: {} },
        hidden: { "~redacted": true }
      })
      assert.notInclude(JSON.stringify(encoded), "must-not-log")
    })

    it("the Wire's fallback keeps redaction in tuple tails and in every matching record signature", () => {
      const EncodedSecret = Schema.Redacted(Schema.String).pipe(
        Schema.decodeTo(
          Schema.String,
          SchemaTransformation.transform({
            decode: Redacted.value,
            encode: Redacted.make
          })
        )
      )
      const Upload = Command.make(
        "Upload",
        {
          args: {
            tail: Schema.TupleWithRest(Schema.Tuple([]), [
              Schema.instanceOf(File),
              EncodedSecret
            ]),
            middle: Schema.TupleWithRest(
              Schema.Tuple([Schema.NumberFromString]),
              [
                Schema.instanceOf(File),
                EncodedSecret,
                Schema.NumberFromString
              ]
            ),
            keyed: Schema.StructWithRest(
              Schema.Struct({ n: Schema.NumberFromString }),
              [
                Schema.Record(
                  Schema.TemplateLiteral(["file-", Schema.String]),
                  Schema.instanceOf(File)
                ),
                Schema.Record(
                  Schema.TemplateLiteral(["secret-", Schema.String]),
                  EncodedSecret
                )
              ]
            ),
            // Both signatures match `secret-a`, and one declares a Redacted, so it's a placeholder.
            overlapping: Schema.StructWithRest(Schema.Struct({}), [
              Schema.Record(Schema.String, Schema.Unknown),
              Schema.Record(
                Schema.TemplateLiteral(["secret-", Schema.String]),
                EncodedSecret
              )
            ])
          }
        },
        () => Effect.succeed(1)
      )
      const file = new File(["x"], "a.txt")
      const command = Upload.make({
        tail: [file, "must-not-log"],
        middle: [1, file, file, "must-not-log", 2],
        keyed: { n: 3, "file-a": file, "secret-a": "must-not-log" },
        overlapping: { "secret-a": "must-not-log", other: file }
      } as any)
      const encoded = MessageLog.encodeCommand(command)
      assert.deepStrictEqual(encoded.args, {
        tail: [{}, { "~redacted": true }],
        middle: ["1", {}, {}, { "~redacted": true }, "2"],
        keyed: { n: "3", "file-a": {}, "secret-a": { "~redacted": true } },
        overlapping: { "secret-a": { "~redacted": true }, other: {} }
      })
      assert.notInclude(JSON.stringify(encoded), "must-not-log")
    })

    it("the Wire redacts a key that two record signatures match, through the codec and in the fallback", () => {
      const EncodedSecret = Schema.Redacted(Schema.String).pipe(
        Schema.decodeTo(
          Schema.String,
          SchemaTransformation.transform({
            decode: Redacted.value,
            encode: Redacted.make
          })
        )
      )
      // Two signatures that redact different fields. With `withFile` a leaf fails, so the codec falls back.
      const Entries = (withFile: boolean) =>
        Schema.StructWithRest(Schema.Struct({}), [
          Schema.Record(
            Schema.String,
            Schema.Struct({
              a: EncodedSecret,
              b: Schema.String,
              ...(withFile ? { file: Schema.instanceOf(File) } : {})
            })
          ),
          Schema.Record(
            Schema.TemplateLiteral(["secret-", Schema.String]),
            Schema.Struct({
              a: Schema.String,
              b: EncodedSecret,
              ...(withFile ? { file: Schema.instanceOf(File) } : {})
            })
          )
        ])
      const Save = Command.make(
        "Save",
        { args: { codec: Entries(false), fallback: Entries(true) } },
        () => Effect.succeed(1)
      )
      const file = new File(["x"], "a.txt")
      const encoded = MessageLog.encodeCommand(Save.make({
        codec: {
          "secret-a": { a: "hidden-one", b: "hidden-two" },
          plain: { a: "hidden-three", b: "shown" }
        },
        fallback: {
          "secret-a": { a: "hidden-one", b: "hidden-two", file },
          plain: { a: "hidden-three", b: "shown", file }
        }
      } as any))
      assert.deepStrictEqual(encoded.args, {
        codec: {
          "secret-a": { "~redacted": true },
          plain: { a: { "~redacted": true }, b: "shown" }
        },
        fallback: {
          "secret-a": { "~redacted": true },
          plain: { a: { "~redacted": true }, b: "shown", file: {} }
        }
      })
      assert.notInclude(JSON.stringify(encoded), "hidden")
    })

    it("the Wire redacts a named property that a redacting index signature matches, through the codec and in the fallback", () => {
      const EncodedSecret = Schema.Redacted(Schema.String).pipe(
        Schema.decodeTo(
          Schema.String,
          SchemaTransformation.transform({
            decode: Redacted.value,
            encode: Redacted.make
          })
        )
      )
      // `token` is a named property, and the `tok` signature, which redacts, matches it too.
      const Entry = (withFile: boolean) =>
        Schema.StructWithRest(
          Schema.Struct({
            token: Schema.String,
            other: Schema.NumberFromString,
            ...(withFile ? { file: Schema.instanceOf(File) } : {})
          }),
          [Schema.Record(
            Schema.TemplateLiteral(["tok", Schema.String]),
            EncodedSecret
          )]
        )
      // The reverse: the property redacts, and a plain signature matches it.
      const Reverse = Schema.StructWithRest(
        Schema.Struct({ token: EncodedSecret }),
        [
          Schema.Record(Schema.String, Schema.String)
        ]
      )
      const Save = Command.make(
        "Save",
        {
          args: { codec: Entry(false), fallback: Entry(true), reverse: Reverse }
        },
        () => Effect.succeed(1)
      )
      const file = new File(["x"], "a.txt")
      const encoded = MessageLog.encodeCommand(Save.make({
        codec: { token: "hidden-one", other: 1, tokB: "hidden-two" },
        fallback: { token: "hidden-three", other: 2, file },
        reverse: { token: "hidden-four", note: "shown" }
      } as any))
      assert.deepStrictEqual(encoded.args, {
        codec: {
          token: { "~redacted": true },
          other: "1",
          tokB: { "~redacted": true }
        },
        fallback: { token: { "~redacted": true }, other: "2", file: {} },
        reverse: { token: { "~redacted": true }, note: "shown" }
      })
      assert.notInclude(JSON.stringify(encoded), "hidden")
    })

    it("the Wire reads only what the Schema declares, and a value that throws is a placeholder", () => {
      const Save = Command.make(
        "Save",
        {
          args: {
            codec: Schema.Struct({ id: Schema.NumberFromString }),
            fallback: Schema.Struct({
              id: Schema.NumberFromString,
              file: Schema.instanceOf(File)
            }),
            throws: Schema.Struct({
              id: Schema.NumberFromString,
              file: Schema.instanceOf(File)
            })
          }
        },
        () => Effect.succeed(1)
      )
      const file = new File(["x"], "a.txt")
      const unread = <A extends object>(value: A): A =>
        Object.defineProperty(value, "unused", {
          enumerable: true,
          get: () => {
            throw new Error("must not be read")
          }
        })
      const throws = Object.defineProperty({ file }, "id", {
        enumerable: true,
        get: () => {
          throw new Error("declared, and it throws")
        }
      })
      const encoded = MessageLog.encodeCommand(Save.make({
        codec: unread({ id: 1 }),
        fallback: unread({ id: 2, file }),
        throws: throws as any
      }))
      assert.deepStrictEqual(encoded.args, {
        codec: { id: "1" },
        fallback: { id: "2", file: {} },
        throws: { id: { "~unserialisable": "encode" }, file: {} }
      })
    })

    it("the Wire encodes a cyclic arg with a placeholder for the cycle, instead of overflowing", () => {
      interface Node {
        readonly label: string
        readonly secret: Redacted.Redacted<string>
        readonly next: Node | null
      }
      const Node: Schema.Codec<Node, unknown> = Schema.Struct({
        label: Schema.String,
        secret: Schema.Redacted(Schema.String),
        next: Schema.NullOr(
          Schema.suspend((): Schema.Codec<Node, unknown> => Node)
        )
      })
      interface Link {
        readonly next: Link
      }
      const Link: Schema.Codec<Link> = Schema.Struct({
        next: Schema.suspend((): Schema.Codec<Link> => Link)
      })
      const Walk = Command.make(
        "Walk",
        {
          args: { node: Node, link: Link, list: Schema.Array(Schema.Unknown) }
        },
        () => Effect.succeed(1)
      )
      const node: {
        label: string
        secret: Redacted.Redacted<string>
        next: unknown
      } = {
        label: "a",
        secret: Redacted.make("must-not-log"),
        next: null
      }
      node.next = node
      const list: Array<unknown> = [1]
      list.push(list)
      const link: { next: unknown } = { next: null }
      link.next = link
      const encoded = MessageLog.encodeCommand(
        Walk.make({ node: node as Node, link: link as Link, list })
      )
      assert.deepStrictEqual(encoded.args, {
        node: {
          label: "a",
          secret: { "~redacted": true },
          next: { "~unserialisable": "cycle" }
        },
        link: { next: { "~unserialisable": "cycle" } },
        list: [1, { "~unserialisable": "cycle" }]
      })
      assert.notInclude(JSON.stringify(encoded), "must-not-log")
    })

    it("Renderer.Ref encodes as its key, and the log shows a ref Command's args that way", () => {
      const Field = Renderer.ref("Field")
      const row = Field.at(3)
      assert.strictEqual(Schema.encodeSync(Renderer.Ref)(row), "Field[3]")
      const decoded = Schema.decodeSync(Renderer.Ref)("Field[3]")
      assert.deepStrictEqual([decoded.name, decoded.key, decoded.at(1).key], [
        "Field",
        "Field[3]",
        "Field[3][1]"
      ])
      assert.deepStrictEqual(
        MessageLog.encodeCommand(HtmlCommand.Focus.make({ ref: row })).args,
        { ref: "Field[3]" }
      )
    })

    it("truncates a Model over maxEntryBytes, and fromLog names the entry", () => {
      const encoder = MessageLog.makeEncoder({ maxEntryBytes: 10 })
      const entry: MessageLog.Mounted = {
        _tag: "Mounted",
        seq: 1,
        at: 0,
        session: "s",
        path: "/Counter",
        instance: 1,
        component: Counter,
        props: { initial: 123456789 },
        model: { count: 123456789 },
        commands: [],
        events: [],
        adopted: false
      }
      const wire = encoder.encode(entry)
      assert.deepStrictEqual((wire as any).model, { "~truncated": 19 })
      assert.throws(
        () => Story.fromLog(Counter, [wire]),
        /entry #1 \(\/Counter\).*~truncated/
      )
    })

    it("truncates a message over maxEntryBytes, as it does a Model", () => {
      // The message is 20 bytes and the Model 11.
      const encoder = MessageLog.makeEncoder({ maxEntryBytes: 15 })
      const entry: MessageLog.Update = {
        _tag: "Update",
        seq: 2,
        at: 0,
        session: "s",
        path: "/Counter",
        instance: 1,
        component: Counter,
        source: { _tag: "Dispatch" },
        message: CounterMessage.Increment(),
        props: { initial: 1 },
        model: { count: 1 },
        commands: [],
        events: [],
        lists: [],
        sends: []
      }
      assert.deepStrictEqual((encoder.encode(entry) as any).message, {
        "~truncated": 20
      })
      assert.deepStrictEqual((encoder.encode(entry) as any).model, { count: 1 })
    })

    it("encodes FetchStarted on the Wire as it is, and decodes it back", () => {
      const entry: MessageLog.FetchStarted = {
        _tag: "FetchStarted",
        seq: 3,
        at: 10,
        session: "s",
        query: "users/GetUser",
        logKey: `{"id":"1"}`,
        trigger: "visibility",
        restart: false,
        inWindow: false,
        stored: true
      }
      const wire = MessageLog.makeEncoder().encode(entry)
      assert.deepStrictEqual(wire, entry)
      assert.deepStrictEqual(
        Schema.decodeUnknownSync(MessageLog.Wire)(
          JSON.parse(JSON.stringify(wire))
        ),
        wire
      )
    })

    it("Redacted values in component Schemas are sent as placeholders", () => {
      class User extends Schema.Class<User>("User")({
        name: Schema.String,
        pin: Schema.Redacted(Schema.Number)
      }) {}
      const Secret = Component.define({
        name: "Secret",
        props: Schema.Struct({ key: Schema.Redacted(Schema.String) }),
        model: Schema.Struct({
          token: Schema.Redacted(Schema.String),
          fromValue: Schema.RedactedFromValue(Schema.String),
          maybe: Schema.optional(Schema.Redacted(Schema.String)),
          option: Schema.Option(Schema.Redacted(Schema.String)),
          users: Schema.Array(User)
        }),
        message: UiSchema.TaggedEnum({
          Login: { password: Schema.Redacted(Schema.String) }
        }),
        events: Schema.Redacted(Schema.String)
      }).make({
        init: () => ({
          token: Redacted.make("t"),
          fromValue: Redacted.make("v"),
          option: Option.none(),
          users: []
        }),
        update: ($) => $.model,
        view: (h) => h.text("")
      })
      const placeholder = { "~redacted": true }
      const warnings: Array<string> = []
      const entry: MessageLog.Update = {
        _tag: "Update",
        seq: 1,
        at: 0,
        session: "s",
        path: "/Secret",
        instance: 1,
        component: Secret,
        source: { _tag: "Dispatch" },
        message: { _tag: "Login", password: Redacted.make("hunter2") },
        props: { key: Redacted.make("k") },
        model: {
          token: Redacted.make("t"),
          fromValue: Redacted.make("v"),
          maybe: Redacted.make("m"),
          option: Option.some(Redacted.make("o")),
          users: [new User({ name: "ada", pin: Redacted.make(1234) })]
        },
        commands: [],
        events: [Redacted.make("e")],
        lists: [],
        sends: []
      }
      const wire = MessageLog.makeEncoder({
        onWarning: (warning) => warnings.push(warning)
      }).encode(entry) as any
      assert.deepStrictEqual(wire.message, {
        _tag: "Login",
        password: placeholder
      })
      assert.deepStrictEqual(wire.props, { key: placeholder })
      assert.deepStrictEqual(wire.model, {
        token: placeholder,
        fromValue: placeholder,
        maybe: placeholder,
        option: { _tag: "Some", value: placeholder },
        users: [{ name: "ada", pin: placeholder }]
      })
      assert.deepStrictEqual(wire.events, [placeholder])
      assert.deepStrictEqual(warnings, [])
    })

    it("Redacted values inside declarations and transformations are sent as placeholders", () => {
      const Secret = Schema.RedactedFromValue(Schema.String)
      class Holder extends Schema.Class<Holder>("Holder")({ secret: Secret }) {}
      const Model = Schema.Struct({
        option: Schema.Option(Secret),
        nested: Schema.Option(Schema.Option(Holder)),
        map: Schema.ReadonlyMap(Schema.String, Secret),
        encodedSide: Schema.Redacted(Schema.String).pipe(
          Schema.decodeTo(
            Schema.String,
            SchemaTransformation.transform({
              decode: Redacted.value,
              encode: Redacted.make
            })
          )
        ),
        plain: Schema.Option(Schema.ReadonlyMap(Schema.String, Schema.Date))
      })
      const model: typeof Model.Type = {
        option: Option.some(Redacted.make("s1")),
        nested: Option.some(
          Option.some(new Holder({ secret: Redacted.make("s2") }))
        ),
        map: new Map([["k", Redacted.make("s3")]]),
        encodedSide: "s4",
        plain: Option.some(new Map([["at", new Date(0)]]))
      }
      const Secrets = Component.define({
        name: "Secrets",
        model: Model,
        message: Schema.Never
      }).make({
        init: () => model,
        update: ($) => $.model,
        view: (h) => h.text("")
      })
      const placeholder = { "~redacted": true }
      const wire = MessageLog.makeEncoder().encode({
        _tag: "Mounted",
        seq: 1,
        at: 0,
        session: "s",
        path: "/Secrets",
        instance: 1,
        component: Secrets,
        props: {},
        model,
        commands: [],
        events: [],
        adopted: false
      }) as any
      assert.deepStrictEqual(wire.model, {
        option: { _tag: "Some", value: placeholder },
        nested: {
          _tag: "Some",
          value: { _tag: "Some", value: { secret: placeholder } }
        },
        map: [["k", placeholder]],
        encodedSide: placeholder,
        // Schemas without a Redacted value encode as `Schema.toCodecJson` does.
        plain: Schema.encodeSync(Schema.toCodecJson(Model.fields.plain))(
          model.plain
        )
      })
    })

    it("memory keeps the last entries, and fanout feeds several logs", () => {
      const memory = MessageLog.makeMemory({ size: 2 })
      const other = MessageLog.makeMemory()
      const log = MessageLog.fanoutAll([memory, other, MessageLog.noop])
      for (let seq = 1; seq <= 3; seq++) {
        log.record({
          _tag: "Unmounted",
          seq,
          at: 0,
          session: "s",
          path: "/x",
          instance: 1,
          component: Counter
        })
      }
      assert.deepStrictEqual(memory.entries().map((entry) => entry.seq), [2, 3])
      assert.deepStrictEqual(other.entries().map((entry) => entry.seq), [
        1,
        2,
        3
      ])
      assert.isFalse(MessageLog.fanoutAll([MessageLog.noop]).enabled)
    })

    it.effect("fanout keeps the other services its Layers provide", () =>
      Effect.gen(function*() {
        class Extra extends Context.Service<Extra, string>()("test/Extra") {}
        const memory = MessageLog.makeMemory()
        const services = yield* Layer.build(MessageLog.fanout([
          Layer.succeedContext(
            Context.make(MessageLog.MessageLog, memory).pipe(
              Context.add(Extra, "kept")
            )
          ),
          Layer.succeed(MessageLog.MessageLog, MessageLog.makeMemory())
        ]))
        assert.strictEqual(Context.get(services, Extra as any), "kept")
        Context.get(services, MessageLog.MessageLog).record({
          _tag: "Unmounted",
          seq: 1,
          at: 0,
          session: "s",
          path: "/x",
          instance: 1,
          component: Counter
        })
        assert.strictEqual(memory.entries().length, 1)
      }).pipe(Effect.scoped))
  })

  describe("vocabularies", () => {
    it.effect("h.el rejects text outside the vocabulary's text parents", () =>
      provideHost(Effect.gen(function*() {
        const Loose = Component.define({
          name: "Loose",
          model: Schema.Number,
          message: Schema.Never,
          elements: Tiny
        }).make({
          init: () => 0,
          update: ($) => $.model,
          view: (h) => h.el("box", "loose text")
        })
        const root = yield* TestHost.mount(Loose, {})
        const failed = root.log().find((entry) =>
          entry._tag === "Failed"
        ) as MessageLog.Failed
        assert.strictEqual(failed.in, "view")
        assert.include(String(failed.cause), "text goes inside label")
      })))

    it.effect("h.el checks text when children follow a chain", () =>
      provideHost(Effect.gen(function*() {
        const Chained = Component.define({
          name: "Chained",
          model: Schema.Number,
          message: Schema.Never,
          elements: Tiny
        }).make({
          init: () => 0,
          update: ($) => $.model,
          view: (h) =>
            h.el("box").key("k").attr("id", "box").children("loose text")
        })
        const root = yield* TestHost.mount(Chained, {})
        const failed = root.log().find((entry) =>
          entry._tag === "Failed"
        ) as MessageLog.Failed
        assert.include(String(failed.cause), "text goes inside label")
      })))

    it.effect("a nested component whose vocabulary the host doesn't show fails as a child", () =>
      Effect.gen(function*() {
        const Inner = Component.define({
          name: "Inner",
          model: Schema.Number,
          message: Schema.Never,
          elements: Tiny
        }).make({
          init: () => 0,
          update: ($) => $.model,
          view: (h) => h.label("tiny")
        })
        const Outer = Component.define({
          name: "Outer",
          model: Schema.Number,
          message: Schema.Never
        }).make({
          init: () => 0,
          update: ($) => $.model,
          view: (h) =>
            h.el(
              "div",
              "outer ",
              Inner(h, {
                key: "i",
                props: {},
                fallback: () => h.text("unsupported")
              })
            )
        })
        const root = yield* TestHost.mount(Outer, {})
        assert.strictEqual(root.text(), "outer unsupported")
        const failed = root.log().find((entry) =>
          entry._tag === "Failed"
        ) as MessageLog.Failed
        assert.deepStrictEqual([failed.path, failed.in], [
          "/Outer/Inner[i]",
          "init"
        ])
        // It never logged `Mounted`, so the failure says what was there.
        assert.strictEqual(failed.component, Inner)
        assert.deepStrictEqual(failed.props, {})
      }).pipe(
        Effect.provide(
          Renderer.layer({ ...TestHost.makeHost(), elements: ["html"] })
        ),
        provideHost
      ))

    it.effect("controlled properties are re-applied after every patch", () =>
      provideHost(Effect.gen(function*() {
        const Msg = UiSchema.TaggedEnum({
          Typed: { value: Schema.String },
          Touch: {}
        })
        const Form = Component.define({
          name: "Form",
          model: Schema.Struct({
            value: Schema.String,
            touched: Schema.Number
          }),
          message: Msg,
          elements: Tiny
        }).make({
          init: () => ({ value: "a", touched: 0 }),
          update: ($, message) =>
            Msg.match(message, {
              Typed: ({ value }) => ({
                ...$.model,
                value: value.toUpperCase()
              }),
              Touch: () => ({ ...$.model, touched: $.model.touched + 1 })
            }),
          view: (h, model) =>
            h.box(
              h.field.value(model.value).on("input", ({ value }) =>
                Msg.Typed({ value })),
              h.label.on("click", Msg.Touch()).children(String(model.touched))
            )
        })
        const root = yield* TestHost.mount(Form, {})
        const field = root.get(Locator.tag("field")) as TestHost.TestElement
        // The user edits the live value; the next patch puts the Model's value back.
        field.props.value = "edited"
        click(root, "0")
        yield* TestHost.settle
        assert.strictEqual(field.props.value, "a")
        field.props.value = "b"
        Locator.fire(field, "input", { value: "b" })
        yield* TestHost.settle
        assert.strictEqual(field.props.value, "B")
      })))

    it.effect("onMount runs with the element's node on hosts that run mounts", () =>
      Effect.gen(function*() {
        const Msg = UiSchema.TaggedEnum({ Mounted: { tag: Schema.String } })
        const ReadTag = Mount.make(
          "ReadTag",
          { args: { token: Schema.Redacted(Schema.String) } },
          (node: TinyField) =>
            Effect.succeed((node as unknown as TestHost.TestElement).tag)
        )
        const token = Redacted.make("secret")
        const Auto = Component.define({
          name: "Auto",
          model: Schema.String,
          message: Msg,
          elements: Tiny
        }).make({
          init: () => "",
          update: (_, message) => message.tag,
          view: (h, tag) =>
            h.box(
              h.label(tag),
              h.field.onMount(
                ReadTag({ token }).pipe(
                  Mount.map((tag) => Msg.Mounted({ tag }))
                )
              )
            )
        })
        const root = yield* TestHost.mount(Auto, {})
        yield* TestHost.settle
        assert.strictEqual(root.text(), "field")
        const start = root.log().find((entry) => entry._tag === "MountStarted")
        const end = root.log().find((entry) => entry._tag === "MountEnded")
        assert.isDefined(start)
        assert.isDefined(end)
        const update = root.log().find((entry) =>
          entry._tag === "Update"
        ) as MessageLog.Update
        assert.deepStrictEqual(update.source, {
          _tag: "Mount",
          name: "ReadTag",
          seq: start.seq,
          args: { token },
          argsSchema: ReadTag.args
        })
        // The Wire encodes the args through the definition's Schema, redacted.
        const encoder = MessageLog.makeEncoder()
        const wire = encoder.encode(update) as Extract<
          MessageLog.Wire,
          { _tag: "Update" }
        >
        const args = { token: { "~redacted": true } }
        assert.deepStrictEqual(wire.source, {
          _tag: "Mount",
          name: "ReadTag",
          seq: start.seq,
          args
        })
        assert.deepInclude(encoder.encode(start), {
          _tag: "MountStarted",
          path: "/Auto",
          name: "ReadTag",
          args
        })
        assert.deepInclude(encoder.encode(end), {
          _tag: "MountEnded",
          path: "/Auto",
          name: "ReadTag",
          started: start.seq,
          reason: "completed",
          silent: false
        })
        assert.deepStrictEqual(
          tags(root).filter((tag) =>
            ["MountStarted", "Update", "MountEnded"].includes(tag)
          ),
          [
            "MountStarted",
            "Update",
            "MountEnded"
          ]
        )
      }).pipe(
        Effect.provide(
          Renderer.layer({ ...TestHost.makeHost(), runsMounts: true })
        ),
        provideHost
      ))

    it.effect("TestHost never runs onMount", () =>
      provideHost(Effect.gen(function*() {
        const Auto = Component.define({
          name: "Auto",
          model: Schema.String,
          message: Schema.String,
          elements: Tiny
        }).make({
          init: () => "waiting",
          update: (_, message) => message,
          view: (h, text) =>
            h.box(
              h.label(text),
              h.field.onMount(
                Mount.make(
                  "Focus",
                  { args: {} },
                  () => Effect.succeed("mounted")
                )()
              )
            )
        })
        const root = yield* TestHost.mount(Auto, {})
        yield* TestHost.settle
        assert.strictEqual(root.text(), "waiting")
        assert.deepStrictEqual(
          tags(root).filter((tag) =>
            tag === "MountStarted" || tag === "MountEnded"
          ),
          []
        )
      })))

    it.effect("two elements running the same mount link their own silent and failed ends", () =>
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const Focus = Mount.make(
          "Focus",
          { args: { crash: Schema.Boolean } },
          (_, { crash }) =>
            crash
              ? Effect.andThen(Deferred.await(gate), Effect.die("mount defect"))
              : Effect.succeed(Component.noop)
        )
        const Box = Component.define({
          name: "Box",
          model: Schema.Null,
          message: Schema.Never,
          elements: Tiny
        }).make({
          init: () => null,
          update: ($) => $.model,
          view: (h) =>
            h.box(
              h.field.onMount(Focus({ crash: true })),
              h.field.onMount(Focus({ crash: false }))
            )
        })
        const root = yield* TestHost.mount(Box, {})
        yield* TestHost.settle
        yield* Deferred.succeed(gate, undefined)
        yield* Effect.flip(TestHost.settle)
        const starts = root.log().filter((entry) =>
          entry._tag === "MountStarted"
        )
        const ends = root.log().filter((entry) => entry._tag === "MountEnded")
        const failure = root.log().find((entry) => entry._tag === "Failed")
        assert.lengthOf(starts, 2)
        assert.lengthOf(ends, 2)
        assert.deepStrictEqual(starts.map((entry) => entry.args), [{
          crash: true
        }, { crash: false }])
        assert.deepInclude(ends[0], {
          started: starts[1].seq,
          reason: "completed",
          silent: true
        })
        assert.deepInclude(ends[1], {
          started: starts[0].seq,
          reason: "failed",
          silent: false
        })
        assert.isDefined(failure)
        assert.deepInclude(failure, { in: "mount", causedBy: ends[1].seq })
        assert.notInclude(tags(root), "Update")
      }).pipe(
        Effect.provide(
          Renderer.layer({ ...TestHost.makeHost(), runsMounts: true })
        ),
        provideHost
      ))

    it.effect("a mount runs once, sees each new args by their Schema, and its Scope closes with the element", () =>
      Effect.gen(function*() {
        const Msg = UiSchema.TaggedEnum({
          Set: { n: Schema.Number },
          Touch: {},
          Hide: {}
        })
        const runs: Array<number> = []
        const seen: Array<number> = []
        let closed = 0
        const Draw = Mount.make(
          "Draw",
          { args: { n: Schema.Number } },
          (_node, args, changes) =>
            Effect.gen(function*() {
              runs.push(args.n)
              yield* Effect.addFinalizer(() => Effect.sync(() => closed++))
              yield* Stream.runForEach(changes, ({ n }) =>
                Effect.sync(() => seen.push(n)))
              return Component.noop
            })
        )
        const Chart = Component.define({
          name: "Chart",
          model: Schema.Struct({
            n: Schema.Number,
            touches: Schema.Number,
            shown: Schema.Boolean
          }),
          message: Msg,
          elements: Tiny
        }).make({
          init: () => ({ n: 0, touches: 0, shown: true }),
          update: ($, message) =>
            Msg.match(message, {
              Set: ({ n }) => ({ ...$.model, n }),
              Touch: () => ({ ...$.model, touches: $.model.touches + 1 }),
              Hide: () => ({ ...$.model, shown: false })
            }),
          view: (h, model) =>
            h.box(
              h.label(`touches ${model.touches}`),
              model.shown
                ? h.field.onMount(Draw({ n: model.n }))
                : null
            )
        })
        const root = yield* TestHost.mount(Chart, {})
        yield* TestHost.settle
        assert.deepStrictEqual(seen, [0])
        root.send(Msg.Set({ n: 1 }))
        yield* TestHost.settle
        // A render whose args are equal gives no new value.
        root.send(Msg.Touch())
        yield* TestHost.settle
        assert.strictEqual(root.text(), "touches 1")
        root.send(Msg.Set({ n: 2 }))
        yield* TestHost.settle
        assert.deepStrictEqual(seen, [0, 1, 2])
        assert.deepStrictEqual(runs, [0])
        assert.strictEqual(closed, 0)
        const hideMessage = Msg.Hide()
        root.send(hideMessage)
        yield* TestHost.settle
        assert.strictEqual(closed, 1)
        assert.deepStrictEqual(runs, [0])
        const starts = root.log().filter((entry) =>
          entry._tag === "MountStarted"
        )
        const ends = root.log().filter((entry) => entry._tag === "MountEnded")
        const hide = root.log().find((entry) =>
          entry._tag === "Update" && entry.message === hideMessage
        )
        assert.lengthOf(starts, 1)
        assert.lengthOf(ends, 1)
        assert.isDefined(hide)
        assert.deepInclude(ends[0], {
          started: starts[0].seq,
          reason: "closed",
          causedBy: hide.seq,
          silent: false
        })
      }).pipe(
        Effect.provide(
          Renderer.layer({ ...TestHost.makeHost(), runsMounts: true })
        ),
        provideHost
      ))

    it.effect("a reader of a mount's args that outlives the mount ends when the element is removed", () =>
      Effect.gen(function*() {
        const seen: Array<number> = []
        let reader: Fiber.Fiber<void> | undefined
        // The reader isn't the mount's fiber or in its Scope, so only the end of `changes` ends it.
        const Draw = Mount.make(
          "Draw",
          { args: { n: Schema.Number } },
          (_node, _args, changes) =>
            Effect.gen(function*() {
              reader = yield* Effect.forkDetach(
                Stream.runForEach(changes, ({ n }) =>
                  Effect.sync(() => seen.push(n)))
              )
              return Component.noop
            })
        )
        const Chart = Component.define({
          name: "OutlivedReader",
          model: Schema.Boolean,
          message: Schema.Boolean,
          elements: Tiny
        }).make({
          init: () => true,
          update: (_, shown) => shown,
          view: (h, shown) =>
            h.box(shown ? h.field.onMount(Draw({ n: 0 })) : null)
        })
        const root = yield* TestHost.mount(Chart, {})
        yield* TestHost.settle
        assert.deepStrictEqual(seen, [0])
        assert.isUndefined(reader?.pollUnsafe())
        root.send(false)
        yield* TestHost.settle
        assert.strictEqual(reader?.pollUnsafe()?._tag, "Success")
      }).pipe(
        Effect.provide(
          Renderer.layer({ ...TestHost.makeHost(), runsMounts: true })
        ),
        provideHost
      ))

    it.effect("a mount returning during scope closure logs one closed end caused by removal", () =>
      Effect.gen(function*() {
        const finishBody = yield* Deferred.make<void>()
        const finishClose = yield* Deferred.make<void>()
        const Hold = Mount.make(
          "Hold",
          { args: {} },
          () =>
            Effect.gen(function*() {
              // Register after the interrupt finalizer so this gate holds the close ahead of it.
              yield* Effect.yieldNow
              yield* Effect.addFinalizer(() => Deferred.await(finishClose))
              yield* Deferred.await(finishBody)
              return Component.noop
            })
        )
        const Box = Component.define({
          name: "Box",
          model: Schema.Boolean,
          message: Schema.String,
          elements: Tiny
        })
          .make({
            init: () => true,
            update: () => false,
            view: (h, shown) => h.box(shown ? h.field.onMount(Hold()) : null)
          })
        const root = yield* TestHost.mount(Box, {})
        yield* TestHost.settle
        root.send("hide")
        yield* TestHost.settle
        yield* Deferred.succeed(finishBody, undefined)
        yield* TestHost.settle
        yield* Deferred.succeed(finishClose, undefined)
        yield* TestHost.settle
        const hide = root.log().find((entry) =>
          entry._tag === "Update" && entry.message === "hide"
        )
        assert.isDefined(hide)
        const ends = root.log().filter((entry) => entry._tag === "MountEnded")
        assert.lengthOf(ends, 1)
        assert.deepInclude(ends[0], {
          reason: "closed",
          causedBy: hide.seq,
          silent: true
        })
      }).pipe(
        Effect.provide(
          Renderer.layer({ ...TestHost.makeHost(), runsMounts: true })
        ),
        provideHost
      ))

    it.effect("a mount's result goes through the Mount.map of the latest render", () =>
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const Wait = Mount.make(
          "Wait",
          { args: {} },
          () => Effect.as(Deferred.await(gate), "done")
        )
        const Late = Component.define({
          name: "Late",
          model: Schema.String,
          message: Schema.String,
          elements: Tiny
        })
          .make({
            init: () => "first",
            update: (_, message) => message,
            view: (h, model) =>
              h.field.onMount(
                Wait().pipe(Mount.map((result) => `${result} after ${model}`))
              )
          })
        const root = yield* TestHost.mount(Late, {})
        yield* TestHost.settle
        root.send("second")
        yield* TestHost.settle
        yield* Deferred.succeed(gate, undefined)
        yield* TestHost.settle
        assert.strictEqual(root.model(), "done after second")
      }).pipe(
        Effect.provide(
          Renderer.layer({ ...TestHost.makeHost(), runsMounts: true })
        ),
        provideHost
      ))

    it.effect("a mount that is busy while two args arrive gets the latest one", () =>
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const seen: Array<number> = []
        const Draw = Mount.make(
          "Draw",
          { args: { n: Schema.Number } },
          (_node, _args, changes) =>
            Stream.runForEach(changes, ({ n }) =>
              Effect.gen(function*() {
                seen.push(n)
                if (n === 0) {
                  yield* Deferred.await(gate)
                }
              })).pipe(Effect.as(Component.noop))
        )
        const Chart = Component.define({
          name: "SlowChart",
          model: Schema.Number,
          message: Schema.Number,
          elements: Tiny
        })
          .make({
            init: () => 0,
            update: (_, n) => n,
            view: (h, n) => h.field.onMount(Draw({ n }))
          })
        const root = yield* TestHost.mount(Chart, {})
        yield* TestHost.settle
        root.send(1)
        yield* TestHost.settle
        root.send(2)
        yield* TestHost.settle
        yield* Deferred.succeed(gate, undefined)
        yield* TestHost.settle
        assert.deepStrictEqual(seen, [0, 2])
      }).pipe(
        Effect.provide(
          Renderer.layer({ ...TestHost.makeHost(), runsMounts: true })
        ),
        provideHost
      ))

    it.effect("a mount that reads its args again starts from the latest ones", () =>
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const seen: Array<number> = []
        const read = (
          changes: Stream.Stream<{ readonly n: number }>,
          count: number
        ) =>
          Stream.runForEach(
            Stream.take(changes, count),
            ({ n }) => Effect.sync(() => seen.push(n))
          )
        const Draw = Mount.make(
          "Draw",
          { args: { n: Schema.Number } },
          (_node, _args, changes) =>
            Effect.gen(function*() {
              yield* read(changes, 2)
              yield* Deferred.await(gate)
              yield* read(changes, 1)
              return Component.noop
            })
        )
        const Chart = Component.define({
          name: "Reread",
          model: Schema.Number,
          message: Schema.Number,
          elements: Tiny
        })
          .make({
            init: () => 0,
            update: (_, n) => n,
            view: (h, n) => h.field.onMount(Draw({ n }))
          })
        const root = yield* TestHost.mount(Chart, {})
        yield* TestHost.settle
        root.send(1)
        yield* TestHost.settle
        // Nothing reads these args when they arrive.
        root.send(2)
        yield* TestHost.settle
        yield* Deferred.succeed(gate, undefined)
        yield* TestHost.settle
        assert.deepStrictEqual(seen, [0, 1, 2])
      }).pipe(
        Effect.provide(
          Renderer.layer({ ...TestHost.makeHost(), runsMounts: true })
        ),
        provideHost
      ))

    it.effect("a reader of a mount's args that starts while new ones arrive gets them once", () =>
      Effect.gen(function*() {
        const seen: Array<string> = []
        const Draw = Mount.make(
          "Draw",
          { args: { n: Schema.Number } },
          (_node, _args, changes) =>
            Effect.gen(function*() {
              const second = Stream.runForEach(changes, ({ n }) =>
                Effect.sync(() => seen.push("second " + n)))
              yield* Effect.forkScoped(Stream.runForEach(changes, ({ n }) => {
                seen.push("first " + n)
                return n === 1
                  ? Effect.forkScoped(second, { startImmediately: true })
                  : Effect.void
              }))
              return Component.noop
            })
        )
        const Chart = Component.define({
          name: "StartsReader",
          model: Schema.Number,
          message: Schema.Number,
          elements: Tiny
        })
          .make({
            init: () => 0,
            update: (_, n) => n,
            view: (h, n) => h.field.onMount(Draw({ n }))
          })
        const root = yield* TestHost.mount(Chart, {})
        yield* TestHost.settle
        root.send(1)
        yield* TestHost.settle
        assert.deepStrictEqual(seen, ["first 0", "first 1", "second 1"])
      }).pipe(
        Effect.provide(
          Renderer.layer({ ...TestHost.makeHost(), runsMounts: true })
        ),
        provideHost
      ))

    it.effect("a render that adds, swaps or drops an element's mount starts and stops it", () =>
      Effect.gen(function*() {
        const events: Array<string> = []
        const tracked = (name: string) =>
          Mount.make(name, { args: {} }, () =>
            Effect.gen(function*() {
              events.push(`start ${name}`)
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => events.push(`stop ${name}`))
              )
              return yield* Effect.never
            }))
        const A = tracked("A")
        const B = tracked("B")
        const Swap = Component.define({
          name: "Swap",
          model: Schema.String,
          message: Schema.String,
          elements: Tiny
        })
          .make({
            init: () => "none",
            update: (_, message) => message,
            view: (h, model) => {
              const field = h.field.value(model)
              return model === "A"
                ? field.onMount(A())
                : model === "B"
                ? field.onMount(B())
                : field
            }
          })
        const root = yield* TestHost.mount(Swap, {})
        yield* TestHost.settle
        root.send("A")
        yield* TestHost.settle
        assert.deepStrictEqual(events, ["start A"])
        root.send("B")
        yield* TestHost.settle
        assert.deepStrictEqual(events, ["start A", "stop A", "start B"])
        root.send("none")
        yield* TestHost.settle
        assert.deepStrictEqual(events, [
          "start A",
          "stop A",
          "start B",
          "stop B"
        ])
      }).pipe(
        Effect.provide(
          Renderer.layer({ ...TestHost.makeHost(), runsMounts: true })
        ),
        provideHost
      ))

    it.effect("a stream mount sends each value through the Mount.map of the latest render", () =>
      Effect.gen(function*() {
        const first = yield* Deferred.make<string>()
        const second = yield* Deferred.make<string>()
        const Clicks = Mount.makeStream(
          "Clicks",
          { args: {} },
          () =>
            Stream.concat(
              Stream.fromEffect(Deferred.await(first)),
              Stream.fromEffect(Deferred.await(second))
            )
        )
        const Widget = Component.define({
          name: "Widget",
          model: Schema.Array(Schema.String),
          message: Schema.String,
          elements: Tiny
        }).make({
          init: () => [],
          update: ($, message) => [...$.model, message],
          view: (h, model) =>
            h.field.onMount(
              Clicks().pipe(Mount.map((id) => `${id} after ${model.length}`))
            )
        })
        const root = yield* TestHost.mount(Widget, {})
        yield* TestHost.settle
        yield* Deferred.succeed(first, "a")
        yield* TestHost.settle
        yield* Deferred.succeed(second, "b")
        yield* TestHost.settle
        assert.deepStrictEqual(root.model(), ["a after 0", "b after 1"])
      }).pipe(
        Effect.provide(
          Renderer.layer({ ...TestHost.makeHost(), runsMounts: true })
        ),
        provideHost
      ))

    it("an element takes one mount", () => {
      const Focus = Mount.make(
        "Focus",
        { args: {} },
        () => Effect.succeed(Component.noop)
      )
      const Measure = Mount.make(
        "Measure",
        { args: {} },
        () => Effect.succeed(Component.noop)
      )
      assert.throws(
        () => Tiny.tags.field.onMount(Focus()).onMount(Measure()),
        /already has the mount Focus/
      )
    })
  })

  it.effect("a removed element's mount that was waiting for its Layer never runs", () =>
    Effect.gen(function*() {
      let mounts = 0
      const Count = Mount.make("Count", { args: {} }, () =>
        Effect.sync(() => {
          mounts++
          return false
        }))
      class Slow extends Context.Service<Slow, number>()("test/SlowMount") {}
      const App = Component.provide(
        Component.define({
          name: "App",
          model: Schema.Boolean,
          message: Schema.Boolean
        }).make({
          init: () => true,
          update: (_, shown) => shown,
          view: (h, shown) =>
            h.el(
              "main",
              shown ?
                h.el("input").onMount(Count()) :
                null
            )
        }),
        Layer.effect(Slow, Effect.as(Effect.sleep("1 second"), 1))
      )
      const root = yield* TestHost.mount(App, {})
      root.send(false)
      yield* TestHost.settle
      yield* TestClock.adjust("1 second")
      yield* TestHost.settle
      assert.strictEqual(mounts, 0)
      assert.deepStrictEqual(
        tags(root).filter((tag) =>
          tag === "MountStarted" || tag === "MountEnded"
        ),
        []
      )
    }).pipe(
      Effect.provide(
        Renderer.layer({ ...TestHost.makeHost(), runsMounts: true })
      ),
      provideHost
    ))

  it.effect("Renderer.mount closes every instance before it removes the root nodes", () =>
    provideHost(Effect.gen(function*() {
      const testHost = yield* TestHost.TestHost
      const container = testHost.host.createElement(
        "#app"
      ) as TestHost.TestElement
      let childrenAtRelease = -1
      const App = Component.provide(
        Component.define({
          name: "App",
          model: Schema.Number,
          message: Schema.Never
        }).make({
          init: () => 0,
          update: ($) => $.model,
          view: (h) => h.el("div", "still here")
        }),
        Layer.effectDiscard(Effect.addFinalizer(() =>
          Effect.sync(() => {
            childrenAtRelease = container.children.length
          })
        ))
      )
      yield* Effect.scoped(Renderer.mount(App, {}, container))
      yield* TestHost.settle
      assert.strictEqual(childrenAtRelease, 1)
      assert.strictEqual(container.children.length, 0)
    })))

  it.effect("Renderer.mount stopped at any yield point leaves nothing behind once its Scope closes", () =>
    Effect.gen(function*() {
      // No TestHost executor: the mount runs on the scheduler below throughout, the query cache's build included.
      const host = TestHost.makeHost()
      // The mount is interrupted and its Scope closes after it exits, or while it's pending. Or the Scope
      // closes under a pending mount that isn't interrupted, which then mounts nothing.
      for (
        const mode of [
          "interrupt, then close",
          "interrupt and close",
          "close"
        ] as const
      ) {
        for (let at = 1;; at++) {
          let listeners = 0
          const signal: Query.Signal = {
            get: () => true,
            subscribe: () => {
              listeners++
              return () => {
                listeners--
              }
            }
          }
          // Yields once, at the `at`-th check.
          let checks = 0
          const scheduler = new Scheduler.MixedScheduler()
          scheduler.shouldYield = () => ++checks === at
          const container = host.createElement("#app") as TestHost.TestElement
          const scope = yield* Scope.make()
          const fiber = Effect.runFork(
            Renderer.mount(Counter, { initial: 1 }, container).pipe(
              Scope.provide(scope),
              Effect.provide(Renderer.layer(host)),
              Effect.provideService(Query.Visibility, signal),
              Effect.provideService(Query.Connectivity, signal),
              Effect.provideService(Scheduler.Scheduler, scheduler)
            )
          )
          if (mode !== "close") fiber.interruptUnsafe()
          if (mode === "interrupt, then close") yield* Fiber.await(fiber)
          const closed = yield* Effect.exit(Scope.close(scope, Exit.void))
          yield* Fiber.await(fiber)
          assert.deepStrictEqual([
            mode,
            at,
            closed._tag,
            listeners,
            container.children.length
          ], [
            mode,
            at,
            "Success",
            0,
            0
          ])
          if (checks < at) break
        }
      }
    }))

  it.effect("Renderer.mount whose owner a setup callback closes mounts nothing, and cleans up in order", () =>
    Effect.gen(function*() {
      const host = TestHost.makeHost()
      for (const site of ["Problems", "init", "view", "Layer"] as const) {
        // The fiber closing the owner yields once, at its `at`-th check, and its tasks run on `flush`.
        for (let at = 1;; at++) {
          let checks = 0
          const tasks: Array<() => void> = []
          const dispatcher: Scheduler.SchedulerDispatcher = {
            scheduleTask: (task) => {
              tasks.push(task)
            },
            flush: () => {
              while (tasks.length > 0) tasks.shift()!()
            }
          }
          const scheduler: Scheduler.Scheduler = {
            executionMode: "async",
            shouldYield: () => ++checks === at,
            makeDispatcher: () => dispatcher
          }
          let listeners = 0
          const signal: Query.Signal = {
            get: () => true,
            subscribe: () => {
              listeners++
              return () => {
                listeners--
              }
            }
          }
          const scope = yield* Scope.make()
          const container = host.createElement("#app") as TestHost.TestElement
          let closing: Fiber.Fiber<void> | undefined
          const close = () => {
            closing ??= Effect.runFork(
              Scope.close(scope, Exit.void).pipe(
                Effect.provideService(Scheduler.Scheduler, scheduler)
              )
            )
          }
          let childrenAtRelease = -1
          const App = Component.provide(
            Component.define({
              name: "App",
              model: Schema.Number,
              message: Schema.Never
            }).make({
              init: () => {
                if (site === "init") close()
                return 0
              },
              update: ($) => $.model,
              view: (h) => {
                if (site === "view") close()
                return h.el("div", "ok")
              }
            }),
            Layer.effectDiscard(Effect.andThen(
              Effect.addFinalizer(() =>
                Effect.sync(() => {
                  childrenAtRelease = container.children.length
                })
              ),
              Effect.sync(() => {
                if (site === "Layer") close()
              })
            ))
          )
          const mounted = yield* Effect.exit(
            runtime.mount(App, {}, container, {
              hydrate: hydrateRun.hydrating({ "~query": "malformed" })
            }).pipe(
              Scope.provide(scope),
              Effect.provide(Renderer.layer(host)),
              Effect.provideService(Query.Visibility, signal),
              Effect.provideService(Query.Connectivity, signal),
              Effect.provideService(Query.Problems, () => {
                if (site === "Problems") close()
              })
            )
          )
          // A close that yielded before it closed the owner leaves the mount to succeed.
          const ownerClosed = scope.state._tag === "Closed"
          dispatcher.flush()
          // The close waits for setup, then closes the instances before it removes the root's nodes.
          assert.deepStrictEqual(
            [
              site,
              at,
              Exit.hasInterrupts(mounted),
              closing!.pollUnsafe()?._tag,
              childrenAtRelease,
              listeners,
              container.children.length
            ],
            [site, at, ownerClosed, "Success", 1, 0, 0]
          )
          if (checks < at) {
            assert.isTrue(ownerClosed)
            break
          }
        }
      }
    }))

  it.effect("Renderer.mount mounts in a container on the Renderer's host", () =>
    provideHost(Effect.gen(function*() {
      const testHost = yield* TestHost.TestHost
      const container = testHost.host.createElement(
        "#app"
      ) as TestHost.TestElement
      const root = yield* Renderer.mount(Counter, { initial: 7 }, container)
      assert.strictEqual(Locator.textOf(container), "-7+")
      root.send(CounterMessage.Decrement())
      yield* TestHost.settle
      assert.strictEqual(Locator.textOf(container), "-6+")
      assert.isAbove(testHost.host.commits(), 1)
    })))

  it.effect("a LayerMap shares one build per key between unrelated components", () =>
    provideHost(Effect.gen(function*() {
      class Greeter
        extends Context.Service<Greeter, { readonly room: string }>()(
          "test/RoomGreeter"
        )
      {}
      let builds = 0
      class Rooms extends LayerMap.Service<Rooms>()("test/Rooms", {
        lookup: (room: string) =>
          Layer.sync(Greeter, () => {
            builds++
            return { room }
          })
      }) {}
      class Show extends Command.Service<Show>()(
        "test/Show",
        {
          args: {},
          success: Schema.String,
          error: Schema.Never,
          invalidates: () => []
        }
      ) {
        static readonly layer = this.toLayer(
          Greeter.useSync((greeter) => () => Effect.succeed(greeter.room))
        )
      }
      const RoomView = Component.define({
        name: "RoomView",
        props: Schema.Struct({ room: Schema.String }),
        model: Schema.String,
        message: Schema.String
      }).make({
        init: ($) => $.set("").run(Show.make()),
        update: (_, message) => message,
        view: (h, text) => h.text(`[${text}]`)
      })
      const Room = Component.provide(
        RoomView,
        (props) => Show.layer.pipe(Layer.provideMerge(Rooms.get(props.room)))
      )
      const Lobby = Component.define({
        name: "Lobby",
        model: Schema.Number,
        message: Schema.Never
      }).make({
        init: () => 0,
        update: ($) => $.model,
        view: (h) =>
          h.el(
            "div",
            Room(h, { key: "1", props: { room: "a" } }),
            Room(h, { key: "2", props: { room: "a" } }),
            Room(h, { key: "3", props: { room: "b" } })
          )
      })
      const root = yield* TestHost.mount(Lobby, {}).pipe(
        Effect.provide(Rooms.layer)
      )
      yield* TestHost.settle
      assert.strictEqual(root.text(), "[a][a][b]")
      assert.strictEqual(builds, 2)
    })))

  describe("a keyed provide", () => {
    class Greeter extends Context.Service<Greeter, { readonly room: string }>()(
      "test/KeyedGreeter"
    ) {}
    const Msg = UiSchema.TaggedEnum({
      Move: { room: Schema.String },
      Shown: { room: Schema.String }
    })
    class Show extends Command.Service<Show>()(
      "test/KeyedShow",
      { args: {}, success: Msg, error: Schema.Never, invalidates: () => [] }
    ) {
      static readonly layer = this.toLayer(
        Greeter.useSync((greeter) => () =>
          Effect.succeed(Msg.Shown({ room: greeter.room }))
        )
      )
    }
    /** Starts in room "a". Its text is its room, then the room each `Show` ran against, in order. */
    const RoomView = Component.define({
      name: "RoomView",
      model: Schema.Struct({
        room: Schema.String,
        shown: Schema.Array(Schema.String)
      }),
      message: Msg
    }).make({
      init: ($) => $.set({ room: "a", shown: [] }).run(Show.make()),
      update: ($, message) =>
        Msg.match(message, {
          Move: ({ room }) => $.set({ ...$.model, room }).run(Show.make()),
          Shown: ({ room }) => ({ ...$.model, shown: [...$.model.shown, room] })
        }),
      view: (h, model) =>
        h.el("button").on("click", Msg.Move({ room: "b" })).children(
          `${model.room}:${model.shown.join("")}`
        )
    })

    it.effect("an update that leaves the key equal, though a new object, doesn't call layer or build anything", () =>
      provideHost(Effect.gen(function*() {
        const calls: Array<string> = []
        let builds = 0
        const Room = Component.provide(RoomView, {
          key: (_, model) => ({ room: model.room }),
          layer: ({ room }) => {
            calls.push(room)
            return Show.layer.pipe(Layer.provide(Layer.sync(Greeter, () => {
              builds++
              return { room }
            })))
          }
        })
        const root = yield* TestHost.mount(Room, {})
        yield* TestHost.settle
        root.send(Msg.Move({ room: "a" }))
        yield* TestHost.settle
        assert.strictEqual(root.text(), "a:aa")
        assert.deepStrictEqual([calls, builds], [["a"], 1])
      })))

    it.effect("a key change calls layer once, keeps the Model, and runs the flush's Commands against the new services", () =>
      provideHost(Effect.gen(function*() {
        const calls: Array<string> = []
        const Room = Component.provide(RoomView, {
          key: (_, model) => model.room,
          layer: (room) => {
            calls.push(room)
            return Show.layer.pipe(
              Layer.provide(Layer.succeed(Greeter, { room }))
            )
          }
        })
        const root = yield* TestHost.mount(Room, {})
        yield* TestHost.settle
        // One flush: the key is read once both updates are in, so "b" is never selected.
        root.send(Msg.Move({ room: "b" }))
        root.send(Msg.Move({ room: "c" }))
        yield* TestHost.settle
        assert.strictEqual(root.text(), "c:acc")
        assert.deepStrictEqual(calls, ["a", "c"])
      })))

    it.effect("a key change remounts descendants and interrupts the instance's in-flight Command", () =>
      provideHost(Effect.gen(function*() {
        let starts = 0
        let interrupted = false
        const Hold = Command.make(
          "test/KeyedHold",
          { args: {} },
          () =>
            Effect.onInterrupt(Effect.never, () =>
              Effect.sync(() => {
                interrupted = true
              }))
        )
        const Child = Component.define({
          name: "Child",
          model: Schema.Number,
          message: Schema.Never
        }).make({
          init: () => ++starts,
          update: ($) => $.model,
          view: (h, n) => h.text(`child${n}`)
        })
        const Parent = Component.define({
          name: "Parent",
          model: Schema.String,
          message: Schema.String
        }).make({
          init: ($) => $.set("a").run(Hold.make()),
          update: (_, room) => room,
          view: (h, room) =>
            h.el("div", room, Child(h, { key: "child", props: {} }))
        })
        const Keyed = Component.provide(Parent, {
          key: (_, room) => room,
          layer: () => Layer.empty
        })
        const root = yield* TestHost.mount(Keyed, {})
        yield* TestHost.settle
        assert.strictEqual(root.text(), "achild1")
        root.send("b")
        yield* TestHost.settle
        assert.strictEqual(root.text(), "bchild2")
        assert.isTrue(interrupted)
      })))

    it.effect("the old Layer is released once the new one is built, and the current one at unmount", () =>
      provideHost(Effect.gen(function*() {
        const events: Array<string> = []
        const Room = Component.provide(RoomView, {
          key: (_, model) => model.room,
          layer: (room) =>
            Show.layer.pipe(Layer.provide(Layer.effect(
              Greeter,
              Effect.acquireRelease(
                Effect.map(Effect.sleep("1 second"), () => {
                  events.push(`built ${room}`)
                  return { room }
                }),
                () => Effect.sync(() => events.push(`released ${room}`))
              )
            )))
        })
        yield* Effect.scoped(Effect.gen(function*() {
          const root = yield* TestHost.mount(Room, {})
          yield* TestClock.adjust("1 second")
          yield* TestHost.settle
          root.send(Msg.Move({ room: "b" }))
          yield* TestHost.settle
          // "a" is held while "b" builds.
          assert.deepStrictEqual(events, ["built a"])
          yield* TestClock.adjust("1 second")
          yield* TestHost.settle
          assert.deepStrictEqual(events, ["built a", "built b", "released a"])
        }))
        yield* TestHost.settle
        assert.deepStrictEqual(events, [
          "built a",
          "built b",
          "released a",
          "released b"
        ])
      })))

    it.effect("two instances on one LayerMap key share its build, and moving one leaves the other's service alive", () => {
      const events: Array<string> = []
      class Rooms extends LayerMap.Service<Rooms>()("test/KeyedRooms", {
        lookup: (room: string) =>
          Layer.effect(
            Greeter,
            Effect.acquireRelease(
              Effect.sync(() => {
                events.push(`built ${room}`)
                return { room }
              }),
              () => Effect.sync(() => events.push(`released ${room}`))
            )
          )
      }) {}
      const Room = Component.provide(RoomView, {
        key: (_, model) => model.room,
        layer: (room) => Show.layer.pipe(Layer.provideMerge(Rooms.get(room)))
      })
      const Lobby = Component.define({
        name: "Lobby",
        model: Schema.Null,
        message: Schema.Never
      }).make({
        init: () => null,
        update: ($) => $.model,
        view: (h) =>
          h.el(
            "div",
            Room(h, { key: "1", props: {} }),
            Room(h, { key: "2", props: {} })
          )
      })
      // The LayerMap outlives the mount, so it is open when a room is selected later.
      return provideHost(
        Effect.gen(function*() {
          const root = yield* TestHost.mount(Lobby, {})
          yield* TestHost.settle
          assert.strictEqual(root.text(), "a:aa:a")
          Locator.fire(root.all(Locator.tag("button"))[0], "click")
          yield* TestHost.settle
          assert.strictEqual(root.text(), "b:aba:a")
          assert.deepStrictEqual(events, ["built a", "built b"])
        }).pipe(Effect.provide(Rooms.layer))
      )
    })

    it.effect("a failed reselection goes to onFailure, isn't retried for an unchanged key, and a later key builds again", () =>
      provideHost(Effect.gen(function*() {
        const calls: Array<string> = []
        const Room = Component.provide(RoomView, {
          key: (_, model) => model.room,
          layer: (room) => {
            calls.push(room)
            return Show.layer.pipe(Layer.provide(
              room === "b"
                ? Layer.effect(Greeter, Effect.fail("no room b"))
                : Layer.succeed(Greeter, { room })
            ))
          }
        }, { onFailure: () => Msg.Shown({ room: "!" }) })
        const root = yield* TestHost.mount(Room, {})
        yield* TestHost.settle
        root.send(Msg.Move({ room: "b" }))
        yield* TestHost.settle
        // The Command waiting for "b" is interrupted. onFailure's message changes the Model, not the key.
        assert.strictEqual(root.text(), "b:a!")
        assert.deepStrictEqual(calls, ["a", "b"])
        root.send(Msg.Move({ room: "c" }))
        yield* TestHost.settle
        assert.strictEqual(root.text(), "c:a!c")
        assert.deepStrictEqual(calls, ["a", "b", "c"])
      })))

    /** A service from above the keyed provide, outside its selection. */
    class Host extends Context.Service<Host, { readonly name: string }>()(
      "test/KeyedHost"
    ) {}

    it.effect("after a handled failed selection, a new Command runs against the parent's services, and fails the instance if it needs a selected one", () => {
      const Act = UiSchema.TaggedEnum({
        Move: {},
        Ping: {},
        Need: {},
        Done: { by: Schema.String }
      })
      class Ping extends Command.Service<Ping>()(
        "test/KeyedPing",
        { args: {}, success: Act, error: Schema.Never, invalidates: () => [] }
      ) {
        static readonly layer = this.toLayer(
          Host.useSync((host) => () =>
            Effect.succeed(Act.Done({ by: host.name }))
          )
        )
      }
      class Need extends Command.Service<Need>()(
        "test/KeyedNeed",
        { args: {}, success: Act, error: Schema.Never, invalidates: () => [] }
      ) {
        static readonly layer = this.toLayer(
          Greeter.useSync((greeter) => () =>
            Effect.succeed(Act.Done({ by: greeter.room }))
          )
        )
      }
      const Acting = Component.define({
        name: "Acting",
        model: Schema.Struct({ room: Schema.String, done: Schema.String }),
        message: Act
      }).make({
        init: () => ({ room: "a", done: "" }),
        update: ($, message) =>
          Act.match(message, {
            Move: () => ({ ...$.model, room: "b" }),
            Ping: () => $.run(Ping.make()),
            Need: () => $.run(Need.make()),
            Done: ({ by }) => ({ ...$.model, done: by })
          }),
        view: (h, model) => h.text(`${model.room}:${model.done}`)
      })
      const Room = Component.provide(Acting, {
        key: (_, model) => model.room,
        layer: (room) =>
          Need.layer.pipe(Layer.provide(
            room === "b"
              ? Layer.effect(Greeter, Effect.fail("no room b"))
              : Layer.succeed(Greeter, { room })
          ))
      }, { onFailure: () => Act.Done({ by: "failed" }) })
      return provideHost(
        Effect.gen(function*() {
          const root = yield* TestHost.mount(Room, {})
          root.send(Act.Move())
          yield* TestHost.settle
          assert.strictEqual(root.text(), "b:failed")
          root.send(Act.Ping())
          yield* TestHost.settle
          assert.strictEqual(root.text(), "b:parent")
          root.send(Act.Need())
          const crashed = yield* Effect.flip(TestHost.settle)
          assert.strictEqual(crashed._tag, "RootCrashed")
        }).pipe(
          Effect.provide(
            Ping.layer.pipe(
              Layer.provide(Layer.succeed(Host, { name: "parent" }))
            )
          )
        )
      )
    })

    it.effect("after a handled failed selection, a Subscription that uses only the parent's services waits too, and starts on the next selection", () =>
      provideHost(
        Effect.gen(function*() {
          const started: Array<string> = []
          const Watching = Component.define({
            name: "Watching",
            model: Schema.String,
            message: Schema.String
          }).make({
            init: () => "a",
            update: ($, message) => message === "failed" ? $.model : message,
            subscriptions: ({ model: room }) => [
              Subscription.make(
                "host",
                Stream.unwrap(
                  Host.useSync((host) =>
                    Stream.fromEffect(
                      Effect.sync(() => started.push(`${host.name}@${room}`))
                    ).pipe(Stream.drain)
                  )
                )
              )
            ],
            view: (h, room) => h.text(room)
          })
          const Room = Component.provide(Watching, {
            key: (_, room) => room,
            layer: (room) =>
              room === "b"
                ? Layer.effectDiscard(Effect.fail("no room b"))
                : Layer.empty
          }, { onFailure: () => "failed" })
          const root = yield* TestHost.mount(Room, {})
          yield* TestHost.settle
          root.send("b")
          yield* TestHost.settle
          // Stopped by the swap, and not started again while no selection is built.
          assert.deepStrictEqual(started, ["parent@a"])
          root.send("c")
          yield* TestHost.settle
          assert.deepStrictEqual(started, ["parent@a", "parent@c"])
        }).pipe(Effect.provideService(Host, { name: "parent" }))
      ))

    it.effect("a key change keeps the query cache: a query gets the old selection's entry unless the key is in its args", () =>
      provideHost(Effect.gen(function*() {
        class Read extends Query.Service<Read>()("test/KeyedRead", {
          args: { room: Schema.String },
          success: Schema.String,
          error: Schema.Never,
          staleTime: "30 seconds"
        }) {
          static readonly layer = this.toLayer(
            Greeter.useSync((greeter) => () => Effect.succeed(greeter.room))
          )
        }
        const value = (result: AsyncResult.AsyncResult<string, never>) =>
          AsyncResult.isSuccess(result) ? result.value : "-"
        const Reading = Component.define({
          name: "Reading",
          model: Schema.String,
          message: Schema.String,
          queries: {
            fixed: { query: Read, args: () => ({ room: "any" }) },
            byRoom: { query: Read, args: ({ model: room }) => ({ room }) }
          }
        }).make({
          init: () => "a",
          update: (_, room) => room,
          view: (h, room) =>
            h.text(
              `${room}:${value(h.queries.fixed)}${value(h.queries.byRoom)}`
            )
        })
        const Room = Component.provide(Reading, {
          key: (_, room) => room,
          layer: (room) =>
            Read.layer.pipe(Layer.provide(Layer.succeed(Greeter, { room })))
        })
        const root = yield* TestHost.mount(Room, {})
        yield* TestHost.settle
        assert.strictEqual(root.text(), "a:aa")
        root.send("b")
        yield* TestHost.settle
        // The cache is the root's, by read and args: within staleTime the entry "a" fetched is reused.
        assert.strictEqual(root.text(), "b:ab")
      })))

    /** A Layer that logs its release. */
    const releasing = (name: string, events: Array<string>) =>
      Layer.effectDiscard(
        Effect.addFinalizer(() =>
          Effect.sync(() => events.push(`release ${name}`))
        )
      )
    /** Never ends. Interrupted, its cleanup waits on `gate`, then logs. */
    const held = (gate: Deferred.Deferred<void>, events: Array<string>) =>
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.andThen(
            Deferred.await(gate),
            Effect.sync(() => events.push("clean"))
          )
        )
      )

    it.effect("an old selection is released only after the cleanup of a Command the key change interrupted, at unmount too", () =>
      provideHost(Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const events: Array<string> = []
        const Hold = Command.make(
          "test/KeyedHeld",
          { args: {} },
          () => held(gate, events)
        )
        const Holding = Component.define({
          name: "Holding",
          model: Schema.String,
          message: Schema.String
        }).make({
          init: ($) => $.set("a").run(Hold.make()),
          update: (_, room) => room,
          view: (h, room) => h.text(room)
        })
        const Room = Component.provide(Holding, {
          key: (_, room) => room,
          layer: (room) => releasing(room, events)
        })
        const scope = yield* Scope.make()
        const root = yield* TestHost.mount(Room, {}).pipe(Scope.provide(scope))
        yield* TestHost.settle
        root.send("b")
        yield* TestHost.settle
        // "b" is built, and "a" is kept while the Command's cleanup runs.
        assert.deepStrictEqual(events, [])
        const closed = yield* Scope.close(scope, Exit.void).pipe(
          Effect.forkChild
        )
        yield* Effect.yieldNow
        yield* TestHost.settle
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(closed)
        // The close waits for the instance's runs before any of its Layers is released.
        assert.deepStrictEqual(events, ["clean", "release a", "release b"])
        assert.deepStrictEqual(
          root.log().flatMap((entry) =>
            entry._tag === "CommandInterrupted" ? [entry.reason] : []
          ),
          [
            "layer"
          ]
        )
      })))

    it.effect("cleanup still running from an earlier flush is waited for before a key change releases the services it may use", () =>
      provideHost(Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const events: Array<string> = []
        const Holder = Component.define({
          name: "Holder",
          model: Schema.Struct({
            holding: Schema.Boolean,
            room: Schema.String
          }),
          message: Schema.String
        }).make({
          init: () => ({ holding: true, room: "a" }),
          update: ($, message) =>
            message === "stop"
              ? { ...$.model, holding: false }
              : { ...$.model, room: message },
          subscriptions: ({ model }) =>
            model.holding
              ? [
                Subscription.make("hold", Stream.fromEffect(held(gate, events)))
              ]
              : [],
          view: (h, model) => h.text(model.room)
        })
        const Room = Component.provide(Holder, {
          key: (_, model) => model.room,
          layer: (room) => releasing(room, events)
        })
        const root = yield* TestHost.mount(Room, {})
        yield* TestHost.settle
        // Stopped in one flush: its cleanup starts, and holds.
        root.send("stop")
        yield* TestHost.settle
        // The key changes in a later one.
        root.send("b")
        yield* TestHost.settle
        assert.deepStrictEqual(events, [])
        yield* Deferred.succeed(gate, undefined)
        yield* TestHost.settle
        assert.deepStrictEqual(events, ["clean", "release a"])
      })))

    it.effect("an unmount waits for the cleanup of a selection still building before the parent's services are released", () =>
      provideHost(Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const events: Array<string> = []
        const Child = Component.provide(
          Component.define({
            name: "Child",
            model: Schema.Null,
            message: Schema.Never
          }).make({
            init: () => null,
            update: ($) => $.model,
            view: (h) => h.text("child")
          }),
          {
            key: () => "a",
            layer: () => Layer.effectDiscard(held(gate, events))
          }
        )
        const Parent = Component.provide(
          Component.define({
            name: "Parent",
            model: Schema.Null,
            message: Schema.Never
          }).make({
            init: () => null,
            update: ($) => $.model,
            view: (h) => h.el("div", Child(h, { key: "child", props: {} }))
          }),
          () => releasing("parent", events)
        )
        const scope = yield* Scope.make()
        yield* TestHost.mount(Parent, {}).pipe(Scope.provide(scope))
        yield* TestHost.settle
        const closed = yield* Scope.close(scope, Exit.void).pipe(
          Effect.forkChild
        )
        yield* Effect.yieldNow
        yield* TestHost.settle
        assert.deepStrictEqual(events, [])
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(closed)
        assert.deepStrictEqual(events, ["clean", "release parent"])
      })))

    it.effect("a keyed provide removed in the flush that changes its key, while its Layer cleans up, doesn't select again", () =>
      provideHost(Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const entered = yield* Deferred.make<void>()
        const events: Array<string> = []
        const Counter = Component.define({
          name: "Counter",
          model: Schema.Number,
          message: Schema.Null,
          events: Schema.Null
        })
          .make({
            init: () => 1,
            update: ($) => $.set($.model + 1).emit(null),
            view: (h, n) => h.el("button").on("click", null).children(String(n))
          })
        const Child = Component.provide(Counter, {
          key: (_, n) => n,
          layer: (n) =>
            Layer.effectDiscard(Effect.andThen(
              Effect.sync(() => events.push(`build ${n}`)),
              Effect.addFinalizer(() =>
                Effect.andThen(
                  Deferred.succeed(entered, undefined),
                  Deferred.await(gate)
                ).pipe(
                  Effect.andThen(Effect.sync(() => events.push(`release ${n}`)))
                )
              )
            ))
        })
        // The child's update changes its key and tells the parent, which removes it before it renders.
        const Parent = Component.define({
          name: "Parent",
          model: Schema.Boolean,
          message: Schema.Null
        })
          .make({
            init: () => true,
            update: () => false,
            view: (h, shown) =>
              shown
                ? Child(h, { key: "child", props: {}, onEmit: () => null })
                : h.text("gone")
          })
        const scope = yield* Scope.make()
        const root = yield* TestHost.mount(Parent, {}).pipe(
          Scope.provide(scope)
        )
        yield* TestHost.settle
        Locator.fire(root.get(Locator.tag("button")), "click")
        yield* TestHost.settle
        yield* Deferred.await(entered)
        yield* Deferred.succeed(gate, undefined)
        yield* TestHost.settle
        assert.strictEqual(root.text(), "gone")
        yield* Scope.close(scope, Exit.void)
        assert.deepStrictEqual(events, ["build 1", "release 1"])
      })))

    it.effect("a keyed provide in a removed branch selects nothing and starts no Command while a sibling's cleanup holds the close", () =>
      provideHost(Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const entered = yield* Deferred.make<void>()
        const events: Array<string> = []
        const Write = Command.make(
          "test/KeyedRemovedWrite",
          { args: {} },
          () =>
            Effect.sync(() => {
              events.push("command")
              return Component.noop
            })
        )
        const Counter = Component.define({
          name: "Counter",
          model: Schema.Number,
          message: Schema.Null,
          events: Schema.Null
        })
          .make({
            init: () => 1,
            update: ($) => $.set($.model + 1).run(Write.make()).emit(null),
            view: (h, n) => h.el("button").on("click", null).children(String(n))
          })
        const Child = Component.provide(Counter, {
          key: (_, n) => n,
          layer: (n) =>
            Layer.effectDiscard(Effect.sync(() => events.push(`build ${n}`)))
        })
        // Closes before the child, as it mounted after it, and holds the branch's close open.
        const Blocker = Component.provide(
          Component.define({
            name: "Blocker",
            model: Schema.Null,
            message: Schema.Never
          }).make({
            init: () => null,
            update: ($) => $.model,
            view: (h) => h.text("")
          }),
          () =>
            Layer.effectDiscard(
              Effect.addFinalizer(() =>
                Effect.andThen(
                  Deferred.succeed(entered, undefined),
                  Deferred.await(gate)
                )
              )
            )
        )
        const Branch = Component.define({
          name: "Branch",
          model: Schema.Null,
          message: Schema.Null,
          events: Schema.Null
        })
          .make({
            init: () => null,
            update: ($) => $.emit(null),
            view: (h) =>
              h.el(
                "div",
                Child(h, { key: "child", props: {}, onEmit: () => null }),
                Blocker(h, { key: "blocker", props: {} })
              )
          })
        // The child's update changes its key and tells the parent, which removes its branch before it renders.
        const Parent = Component.define({
          name: "Parent",
          model: Schema.Boolean,
          message: Schema.Null
        })
          .make({
            init: () => true,
            update: () => false,
            view: (h, shown) =>
              shown
                ? Branch(h, { key: "branch", props: {}, onEmit: () => null })
                : h.text("gone")
          })
        const root = yield* TestHost.mount(Parent, {})
        yield* TestHost.settle
        Locator.fire(root.get(Locator.tag("button")), "click")
        yield* TestHost.settle
        yield* Deferred.await(entered)
        assert.deepStrictEqual(events, ["build 1"])
        yield* Deferred.succeed(gate, undefined)
        yield* TestHost.settle
        assert.deepStrictEqual(events, ["build 1"])
        assert.strictEqual(root.text(), "gone")
      })))
  })

  it.effect("each provided Layer build is stamped with the flush it began in", () =>
    provideHost(Effect.gen(function*() {
      class Slow
        extends Context.Service<Slow, { readonly name: string }>()("test/Slow")
      {}
      const Inner = Component.provide(
        Component.define({
          name: "Inner",
          props: Schema.Struct({ name: Schema.String }),
          model: Schema.Number,
          message: Schema.String
        }).make({
          init: () => 0,
          update: ($) => $.model,
          view: (h) => h.text(h.props.name)
        }),
        (props) =>
          Layer.effect(
            Slow,
            props.name === "fail"
              ? Effect.fail("no")
              : Effect.as(Effect.sleep("1 hour"), { name: props.name })
          ),
        { onFailure: () => "failed" }
      )
      const Msg = UiSchema.TaggedEnum({ Add: { name: Schema.String } })
      const Shell = Component.define({
        name: "Shell",
        model: Schema.Array(Schema.String),
        message: Msg
      }).make({
        init: () => ["first"],
        update: ($, message) => [...$.model, message.name],
        view: (h, names) =>
          h.el(
            "div",
            names.map((name) => Inner(h, { key: name, props: { name } }))
          )
      })
      const testHost = yield* TestHost.TestHost
      const root = yield* runtime.mount(
        Shell,
        {},
        testHost.host.createElement("#app")
      )
      assert.strictEqual(root.flush(), 0)
      assert.strictEqual(root.buildsPendingSince(0), 1)

      root.send(Msg.Add({ name: "second" }))
      yield* TestHost.settle
      const navigated = root.flush()
      assert.isAbove(navigated, 0)
      // The first build was already running, so it doesn't count from the later flush.
      assert.strictEqual(root.buildsPendingSince(0), 2)
      assert.strictEqual(root.buildsPendingSince(navigated), 1)

      root.send(Msg.Add({ name: "fail" }))
      yield* TestHost.settle
      assert.strictEqual(root.buildsPendingSince(navigated), 1)
      // A failed build counts as settled.
      root.send(Msg.Add({ name: "x" }))
      yield* TestHost.settle
      assert.strictEqual(root.buildsPendingSince(0), 3)
    })))

  it.effect("settle fails with the log's tail when work never stops", () =>
    Effect.gen(function*() {
      const Msg = UiSchema.TaggedEnum({ Again: {} })
      const Again = Command.make(
        "Again",
        { args: {} },
        () => Effect.succeed(Msg.Again())
      )
      const Loop = Component.define({
        name: "Loop",
        model: Schema.Number,
        message: Msg
      }).make({
        init: ($) => $.set(0).run(Again.make()),
        update: ($) => $.set($.model + 1).run(Again.make()),
        view: (h, n) => h.text(String(n))
      })
      yield* TestHost.mount(Loop, {})
      const error = yield* Effect.flip(TestHost.settle)
      assert.strictEqual(error._tag, "SettleError")
      assert.include(error.message, "/Loop Update")
      assert.include(error.message, "Again")
    }).pipe(Effect.provide(TestHost.layer({ budget: 200 }))))

  it.effect("prerenders the tree as nodes: an instance's elements and text in a Range under its path", () =>
    Effect.gen(function*() {
      const state = { model: Schema.Null, message: Schema.Never }
      const impl = { init: () => null, update: () => null }
      const Leaf = Component.define({ name: "Leaf", ...state })
        .make({
          ...impl,
          view: (h) => h.text("leaf")
        })
      const Page = Component.define({ name: "Page", ...state })
        .make({
          ...impl,
          view: (h) =>
            h.el("p").attr("class", "a").prop("hidden", true).children(
              "x",
              Leaf(h, { key: "k" })
            )
        })
      const rendered = yield* Renderer.prerender(Page, {})
      assert.deepStrictEqual(rendered.nodes, [{
        _tag: "Range",
        path: "/Page",
        children: [{
          _tag: "Element",
          tag: "p",
          attrs: { class: "a" },
          props: { hidden: true },
          children: [
            { _tag: "Text", text: "x" },
            {
              _tag: "Range",
              path: "/Page/Leaf[k]",
              children: [{ _tag: "Text", text: "leaf" }]
            }
          ]
        }]
      }])
    }))

  it.effect("default logging formats annotations and records span events on a throwing view", () =>
    Effect.gen(function*() {
      const logs: Array<ReadonlyArray<unknown>> = []
      const errors: Array<ReadonlyArray<unknown>> = []
      const spanEvents: Array<string> = []
      const currentConsole = yield* Console.Console
      const fakeConsole: Console.Console = {
        ...currentConsole,
        log: (...args) => {
          logs.push(args)
        },
        error: (...args) => {
          errors.push(args)
        }
      }
      const Broken = Component.define({
        name: "BrokenLog",
        model: Schema.Null,
        message: Schema.Never
      }).make({
        init: () => null,
        update: ($) => $.model,
        view: () => {
          throw new Error("boom")
        }
      })
      const parentTracer = yield* Effect.tracer
      const tracer = Tracer.make({
        span: (options) => {
          const span = parentTracer.span(options)
          const orig = span.event.bind(span)
          span.event = (name, startTime, attributes) => {
            spanEvents.push(name)
            return orig(name, startTime, attributes)
          }
          return span
        }
      })
      yield* TestHost.mount(Broken, {}).pipe(
        Effect.annotateLogs({ area: "view-test" }),
        Effect.withSpan("mount-span"),
        Effect.provideService(Console.Console, fakeConsole),
        Effect.provideService(Tracer.Tracer, tracer)
      )
      yield* Effect.yieldNow
      assert.strictEqual(errors.length, 0)
      assert.isTrue(
        logs.some((args) =>
          args.some((arg) =>
            typeof arg === "string" && arg.includes("/BrokenLog failed in view")
          ) &&
          args.some((arg) =>
            typeof arg === "object" && arg !== null &&
            (arg as { readonly area?: unknown }).area === "view-test"
          )
        )
      )
      assert.isTrue(
        spanEvents.some((name) => name.includes("/BrokenLog failed in view"))
      )
    }).pipe(Effect.scoped, provideHost))

  it.effect("records root emitted events from init and updates in order on TestHost", () =>
    provideHost(
      Effect.gen(function*() {
        const Events = UiSchema.TaggedEnum({
          Ready: {},
          Stepped: { value: Schema.Number }
        })
        const Message = UiSchema.TaggedEnum({ Step: {} })
        const Emitter = Component.define({
          name: "Emitter",
          model: Schema.Number,
          message: Message,
          events: Events
        }).make({
          init: ($) => $.set(0).emit(Events.Ready()),
          update: ($) => {
            const next = $.model + 1
            return $.set(next).emit(
              Events.Stepped({ value: next }),
              Events.Stepped({ value: next * 10 })
            )
          },
          view: (h, n) =>
            h.el("button").on("click", Message.Step()).children(String(n))
        })
        const root = yield* TestHost.mount(Emitter, {})
        assert.deepStrictEqual(root.emitted, [Events.Ready()])
        click(root, "0")
        yield* TestHost.settle
        root.send(Message.Step())
        yield* TestHost.settle
        assert.deepStrictEqual(root.emitted, [
          Events.Ready(),
          Events.Stepped({ value: 1 }),
          Events.Stepped({ value: 10 }),
          Events.Stepped({ value: 2 }),
          Events.Stepped({ value: 20 })
        ])
      }).pipe(Effect.scoped)
    ))
})
