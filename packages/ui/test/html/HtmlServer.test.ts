// @vitest-environment happy-dom
import {
  Command,
  Component,
  Feature,
  Head,
  MessageLog,
  Mount,
  Query,
  Renderer,
  Router,
  Subscription,
  UiSchema,
  View
} from "@effect/ui"
import { BrowserHost, Html, HtmlHydrate, HtmlServer } from "@effect/ui/html"
import { ssr } from "@effect/ui/html/testing"
import { TestHost } from "@effect/ui/testing"
import { assert, expect, it } from "@effect/vitest"
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  SchemaGetter,
  type Scope,
  Stream
} from "effect"
import { AsyncResult } from "effect/reactivity"
import { TestClock } from "effect/testing"
import { describe, vi } from "vitest"
import { Confirm, ConfirmMessage } from "./fixtures/confirm.ts"
import { Menu, popoverStub } from "./fixtures/popover.ts"
import { App, AppRoute, People } from "./fixtures/routed.ts"

/** A mount that ends with `message`. */
const mountSending = <A>(name: string, message: A) =>
  Mount.make(name, { args: {} }, () => Effect.succeed(message))()

const tick = Effect.promise(() =>
  new Promise<void>((resolve) => setTimeout(resolve, 30))
)

/** Runs a block that hydrates with `ssr` on its own `TestHost`, which owns the client tree. */
const hosted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(TestHost.layer())) as Effect.Effect<
    A,
    E,
    Exclude<R, TestHost.TestHost | Scope.Scope | Renderer.Renderer>
  >

const routed = Effect.fnUntraced(function*(url: string) {
  const router = Router.memory({ routes: AppRoute, url })
  const route = yield* Router.currentRoute(AppRoute).pipe(
    Effect.provide(router)
  )
  return { props: { route }, router }
})

const slowPeople = Layer.succeed(People, {
  bio: (id: number) =>
    Effect.as(Effect.sleep("300 millis"), `Bio of person ${id}`)
})

const container = (html: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const element = document.body.appendChild(document.createElement("div"))
      element.innerHTML = html
      return element
    }),
    (element) => Effect.sync(() => element.remove())
  )

/**
 * Three rows under a list, rendered on the server and hydrated from `tamper`'s copy of the HTML. Each row
 * has a button with a handler and a mount, and a Subscription.
 */
const hydrateRows = Effect.fnUntraced(
  function*(tamper: (html: string) => string) {
    const mounted: Array<Element> = []
    let streams = 0
    const Seen = Mount.make(
      "Seen",
      { args: {} },
      (element: Element) =>
        Effect.sync(() => {
          mounted.push(element)
          return RowMessage.Seen()
        })
    )
    const RowMessage = UiSchema.TaggedEnum({ Clicked: {}, Seen: {} })
    const Row = Html.component({
      name: "Row",
      props: Schema.Struct({ label: Schema.String }),
      model: Schema.Number,
      message: RowMessage
    }).make({
      init: () => 0,
      update: ($, message) =>
        message._tag === "Clicked" ? $.model + 1 : $.model,
      subscriptions: () => [
        Subscription.make("stream", 0, (): Stream.Stream<never> => {
          streams++
          return Stream.never
        })
      ],
      view: (h, clicks) =>
        h.li(
          h.button.on("click", RowMessage.Clicked()).onMount(Seen()).children(
            h.props.label
          ),
          h.span(`${clicks} clicked`),
          h.em(`row ${h.props.label}`)
        )
    })
    const Rows = Html.component({
      name: "Rows",
      model: Schema.Null,
      message: Schema.Never
    }).make({
      init: () => null,
      update: ($) => $.model,
      view: (h) =>
        h.ul(
          ...["A", "B", "C"].map((label) =>
            Row(h, { key: label, props: { label } })
          )
        )
    })
    const rendered = yield* HtmlServer.renderToHtml(Rows, {})
    const html = tamper(rendered.html)
    assert.notStrictEqual(html, rendered.html)
    const app = yield* container(html)
    const server = {
      items: [...app.querySelectorAll("li")],
      buttons: [...app.querySelectorAll("button")]
    }
    const root = yield* HtmlHydrate.hydrateEffect(Rows, {}, app, rendered.state)
    yield* root.adopted
    yield* tick
    /** Fails if a handler, a mount or a Subscription started twice, on a node that stayed or one that went. */
    const startedOnce = Effect.gen(function*() {
      const buttons = [...app.querySelectorAll("button")]
      assert.deepStrictEqual(
        buttons.map((button) => button.textContent),
        ["A", "B", "C"]
      )
      assert.deepStrictEqual(
        [...app.querySelectorAll("em")].map((em) => em.textContent),
        ["row A", "row B", "row C"]
      )
      assert.strictEqual(app.querySelector("ul")!.childNodes.length, 3)
      assert.sameMembers(mounted, buttons)
      assert.strictEqual(streams, 3)
      for (const button of buttons) {
        button.click()
      }
      yield* tick
      assert.deepStrictEqual(
        [...app.querySelectorAll("span")].map((span) => span.textContent),
        ["1 clicked", "1 clicked", "1 clicked"]
      )
    })
    return { app, server, startedOnce }
  }
)

describe("HtmlServer", { concurrent: false }, () => {
  it.effect("drops unsafe attribute names on the server, fresh client and hydrated client", () =>
    Effect.gen(function*() {
      const names = [
        "",
        "x onclick",
        "x\tonclick",
        "x\nonclick",
        "x\ronclick",
        "x\fonclick",
        "x\u0000",
        "x\u001f",
        "x'",
        "x\"",
        "x=onclick",
        "x<",
        "x>",
        "x/",
        "a\"><script>alert(2)</script"
      ]
      const Page = Html.component({
        name: "SafeAttributes",
        model: Schema.Boolean,
        message: Schema.Boolean
      }).make({
        init: () => false,
        update: (_, message) => message,
        view: (h, remove) => {
          const unsafe = <
            E extends { attr(name: string, value: string | undefined): E }
          >(element: E): E =>
            names.reduce(
              (element, name) =>
                element.attr(name, remove ? undefined : "alert(1)"),
              element
            )
          return h.div.children(
            unsafe(h.div.attr("data-safe", remove ? "updated" : "a\"<&"))
              .children("hi"),
            unsafe(h.el("x-safe")),
            unsafe(h.el("svg"))
          )
        }
      })
      const rendered = yield* HtmlServer.renderToHtml(Page, {})
      expect(rendered.html).toBe(
        "<!--[/SafeAttributes--><div><div data-safe=\"a&quot;&lt;&amp;\">hi</div><x-safe></x-safe><svg></svg></div><!--]/SafeAttributes-->"
      )
      for (const hydrate of [false, true]) {
        const app = yield* container(hydrate ? rendered.html : "")
        const before = app.firstElementChild
        const root = yield* (hydrate
          ? HtmlHydrate.hydrateEffect(Page, {}, app, rendered.state)
          : BrowserHost.mountEffect(Page, {}, app))
        if (hydrate) expect(app.firstElementChild).toBe(before)
        const elements = app.firstElementChild!.children
        const attributeNames = () =>
          Array.from(elements, (element) => element.getAttributeNames())
        expect(attributeNames()).toEqual([["data-safe"], [], []])
        expect(elements[0]!.getAttribute("data-safe")).toBe("a\"<&")
        expect(app.querySelector("script")).toBeNull()
        root.send(true)
        yield* tick
        expect(attributeNames()).toEqual([["data-safe"], [], []])
        expect(elements[0]!.getAttribute("data-safe")).toBe("updated")
      }
    }).pipe(Effect.scoped))

  it.effect("drops javascript: and vbscript: URLs on the server, fresh client and hydrated client", () =>
    Effect.gen(function*() {
      const Page = Html.component({
        name: "Urls",
        props: Schema.Struct({ url: Schema.String }),
        model: Schema.String,
        message: Schema.String
      }).make({
        init: ($) => $.props.url,
        update: (_, message) => message,
        view: (h, url) =>
          h.div.children(
            h.a.attr("href", url),
            h.form.attr("action", url).children(
              h.button.attr("formaction", url)
            ),
            h.img.attr("src", url),
            h.el("object").attr("data", url),
            h.el("svg").children(
              h.el("a").attr("href", url).attr("xlink:href", url)
            )
          )
      })
      const blocked = " Java\tScript:"
      const rendered = yield* HtmlServer.renderToHtml(Page, { url: blocked })
      expect(rendered.html).toBe(
        "<!--[/Urls--><div><a></a><form><button></button></form><img><object></object>" +
          "<svg><a></a></svg></div><!--]/Urls-->"
      )
      const relative = yield* HtmlServer.renderToHtml(Page, {
        url: "/relative"
      })
      expect(relative.html).toBe(
        "<!--[/Urls--><div><a href=\"/relative\"></a><form action=\"/relative\"><button formaction=\"/relative\"></button></form>" +
          "<img src=\"/relative\"><object data=\"/relative\"></object>" +
          "<svg><a href=\"/relative\" xlink:href=\"/relative\"></a></svg></div><!--]/Urls-->"
      )
      const written = (url: string) =>
        ["href", "action", "formaction", "src", "data", "href", "xlink:href"]
          .map((name) => `${name}=${url}`)
      for (const hydrate of [false, true]) {
        const app = yield* container(hydrate ? rendered.html : "")
        const before = app.firstElementChild
        const root = yield* (hydrate
          ? HtmlHydrate.hydrateEffect(
            Page,
            { url: blocked },
            app,
            rendered.state
          )
          : BrowserHost.mountEffect(Page, { url: blocked }, app))
        if (hydrate) expect(app.firstElementChild).toBe(before)
        // `attributes`, not `getAttribute`: happy-dom's is stale for an SVG `a` with both hrefs.
        const urls = () =>
          Array.from(
            app.querySelectorAll("*"),
            (element) =>
              Array.from(element.attributes, (attribute) =>
                `${attribute.name}=${attribute.value}`)
          ).flat()
        expect(urls()).toEqual([])
        for (
          const [url, expected] of [
            ["/relative", written("/relative")],
            ["VBSCRIPT:", []],
            ["mailto:a@b.c", written("mailto:a@b.c")]
          ] as const
        ) {
          root.send(url)
          yield* tick
          expect(urls()).toEqual(expected)
        }
      }
    }).pipe(Effect.scoped))

  it.effect("a blocked URL property removes only the attribute it reflects, and adoption drops a stale blocked URL", () =>
    Effect.gen(function*() {
      let sets = 0
      customElements.define(
        "x-url-prop",
        class extends HTMLElement {
          get href() {
            return "javascript:"
          }
          set href(_: string) {
            sets++
          }
        }
      )
      const Page = Html.component({
        name: "Props",
        model: Schema.Null,
        message: Schema.Never
      }).make({
        init: () => null,
        update: ($) => $.model,
        view: (h) =>
          h.div.children(
            h.a.attr("href", "javascript:"),
            h.a.attr("href", "/save").prop("href", "javascript:"),
            h.a.prop("href", "javascript:"),
            h.button.attr("formaction", "/save").prop(
              "formaction",
              "javascript:"
            ),
            h.button.attr("formaction", "/save").prop(
              "formAction",
              "javascript:"
            ),
            h.el("x-url-prop").prop("href", "javascript:")
          )
      })
      const rendered = yield* HtmlServer.renderToHtml(Page, {})
      expect(rendered.html).toBe(
        "<!--[/Props--><div><a></a><a></a><a></a><button formaction=\"/save\"></button><button></button><x-url-prop></x-url-prop></div><!--]/Props-->"
      )
      for (const hydrate of [false, true]) {
        // Hydrates markup that still has the blocked href, as an older server wrote it.
        const app = yield* container(
          hydrate
            ? rendered.html.replaceAll("<a>", "<a href=\"javascript:\">")
            : ""
        )
        const before = app.firstElementChild
        sets = 0
        yield* (hydrate
          ? HtmlHydrate.hydrateEffect(Page, {}, app, rendered.state)
          : BrowserHost.mountEffect(Page, {}, app))
        if (hydrate) expect(app.firstElementChild).toBe(before)
        // A custom element's equal property isn't written again on adoption.
        expect(sets).toBe(hydrate ? 0 : 1)
        expect(
          Array.from(
            app.querySelectorAll("*"),
            (element) => element.getAttributeNames()
          ).flat()
        ).toEqual(["formaction"])
      }
    }).pipe(Effect.scoped))

  describe("reports across hydration", () => {
    const Plain = UiSchema.TaggedEnum({ ChangedOn: { on: Schema.Boolean } })
    // An unrelated variant holds a secret, so the last message can't be shipped.
    const Secret = UiSchema.TaggedEnum({
      ChangedOn: { on: Schema.Boolean },
      Unlocked: { key: Schema.Redacted(Schema.String) }
    })
    /** An owner that counts the messages its reports send, so a duplicate and a missed one both show. */
    const counting = (
      message: typeof Plain | typeof Secret,
      item?: (component: any) => any
    ) => {
      const Group = Component.define({
        name: "Group",
        model: Schema.Number,
        message: message as typeof Plain,
        shares: {
          value: ({ model: count }) => count,
          collects: {
            schema: Schema.Boolean,
            onChange: (collected) =>
              Plain.ChangedOn({ on: collected.includes(true) })
          }
        }
      }).make({
        init: () => 0,
        update: ($) => $.model + 1,
        parts: (_, count) => ({ count })
      })
      const Item = Html.component({
        name: "Item",
        props: Schema.Struct({ open: Schema.Boolean }),
        model: Schema.Null,
        message: Schema.Never,
        reads: { group: { owner: Group, report: (_, props) => props.open } }
      }).make({
        init: () => null,
        update: ($) => $.model,
        view: (h) => h.span.children("item")
      })
      const Shown = item === undefined ? Item : item(Item)
      return Html.component({
        name: "Page",
        props: Schema.Struct({ item: Schema.NullOr(Schema.Boolean) }),
        model: Schema.Null,
        message: Schema.Never
      }).make({
        init: () => null,
        update: ($) => $.model,
        view: (h) =>
          Group(h, {
            key: "g",
            view: (group) =>
              h.div.children(
                h.p.children(`collected ${group.count}`),
                h.props.item !== null &&
                  Shown(h, { key: "i", props: { open: h.props.item } })
              )
          })
      })
    }
    const cases = [
      {
        name: "the same report, with a Redacted message variant",
        message: Secret,
        server: true,
        client: true,
        count: 1
      },
      {
        name: "a report that changes on the client",
        message: Plain,
        server: true,
        client: false,
        count: 2
      },
      {
        name: "the only reader gone on the client",
        message: Plain,
        server: true,
        client: null,
        count: 2
      }
    ] as const
    for (const { client, count, message, name, server } of cases) {
      it.effect(`delivers each report once: ${name}`, () =>
        Effect.gen(function*() {
          const Page = counting(message)
          const rendered = yield* HtmlServer.renderToHtml(Page, {
            item: server
          })
          expect(rendered.html).toContain("<p>collected 1</p>")
          // An owner whose last message can't ship is built fresh, with its subtree.
          expect(rendered.state["~deferred"]).toEqual(
            message === Secret ? ["/Page/Group[g]"] : []
          )
          expect(rendered.state["~reported"]).toEqual(
            message === Secret
              ? undefined
              : { "/Page/Group[g]": { _tag: "ChangedOn", on: true } }
          )
          const app = yield* container(rendered.html)
          const log = MessageLog.makeMemory({ size: 1000 })
          yield* HtmlHydrate.hydrateEffect(
            Page,
            { item: client },
            app,
            rendered.state
          ).pipe(
            Effect.provideService(MessageLog.MessageLog, log)
          )
          yield* tick
          expect(app.querySelector("p")!.textContent).toBe(`collected ${count}`)
          // One on the client each: the Redacted owner is built fresh from 0, the others change.
          expect(
            log.entries().filter((entry) =>
              entry._tag === "Update" && entry.source._tag === "Collected"
            )
          )
            .toHaveLength(1)
        }).pipe(Effect.scoped))
    }

    it.effect("waits for a reader still building its Layer before comparing, and sends nothing when it reports the same", () =>
      Effect.gen(function*() {
        const slow = Layer.effectDiscard(Effect.sleep("50 millis"))
        const Page = counting(
          Plain,
          (Item) => Item.pipe(Component.provide(slow))
        )
        const fiber = yield* Effect.forkChild(
          HtmlServer.renderToHtml(Page, { item: true })
        )
        yield* TestClock.adjust("50 millis")
        const rendered = yield* Fiber.join(fiber)
        expect(rendered.state["~deferred"]).toEqual([])
        expect(rendered.html).toContain("<p>collected 1</p>")
        const app = yield* container(rendered.html)
        const log = MessageLog.makeMemory({ size: 1000 })
        const root = yield* HtmlHydrate.hydrateEffect(
          Page,
          { item: true },
          app,
          rendered.state
        ).pipe(
          Effect.provideService(MessageLog.MessageLog, log)
        )
        yield* tick
        yield* TestClock.adjust("50 millis")
        yield* root.adopted
        yield* tick
        expect(app.querySelector("p")!.textContent).toBe("collected 1")
        const collected = log.entries().filter((entry) =>
          entry._tag === "Update" && entry.source._tag === "Collected"
        )
        expect(collected).toEqual([])
      }).pipe(Effect.scoped))

    it.effect("adopts the server's nodes when the last message ships", () =>
      Effect.gen(function*() {
        const Page = counting(Plain)
        const rendered = yield* HtmlServer.renderToHtml(Page, { item: true })
        const app = yield* container(rendered.html)
        const p = app.querySelector("p")
        yield* HtmlHydrate.hydrateEffect(
          Page,
          { item: true },
          app,
          rendered.state
        )
        yield* tick
        expect(app.querySelector("p")).toBe(p)
        expect(p!.textContent).toBe("collected 1")
      }).pipe(Effect.scoped))
  })

  it.effect("folds HTML attribute names with last-write wins, but preserves SVG casing", () =>
    Effect.gen(function*() {
      const Page = Html.component({
        name: "AttributeCase",
        model: Schema.Null,
        message: Schema.Never
      }).make({
        init: () => null,
        update: ($) => $.model,
        view: (h) =>
          h.div.attrs({ TYPE: "first", type: "last" }).children(
            h.el("x-safe").attrs({ "DATA-X": "first", "data-x": "last" }),
            h.select.value("chosen").children(
              h.option.attr("VALUE", "chosen").children("label")
            ),
            h.el("svg").attr("viewBox", "0 0 10 10").children(
              h.el("linearGradient").attr("gradientUnits", "userSpaceOnUse")
            )
          )
      })
      const rendered = yield* HtmlServer.renderToHtml(Page, {})
      expect(rendered.html).toBe(
        "<!--[/AttributeCase--><div type=\"last\"><x-safe data-x=\"last\"></x-safe>" +
          "<select><option value=\"chosen\" selected>label</option></select>" +
          "<svg viewBox=\"0 0 10 10\"><linearGradient gradientUnits=\"userSpaceOnUse\"></linearGradient></svg></div><!--]/AttributeCase-->"
      )
      for (const hydrate of [false, true]) {
        const app = yield* container(hydrate ? rendered.html : "")
        const before = app.firstElementChild
        yield* (hydrate
          ? HtmlHydrate.hydrateEffect(Page, {}, app, rendered.state)
          : BrowserHost.mountEffect(Page, {}, app))
        if (hydrate) expect(app.firstElementChild).toBe(before)
        const div = app.firstElementChild!
        expect(div.getAttributeNames()).toEqual(["type"])
        expect(div.getAttribute("type")).toBe("last")
        expect(div.querySelector("x-safe")!.getAttribute("data-x")).toBe("last")
        expect(div.querySelector("select")!.value).toBe("chosen")
        expect(div.querySelector("option")!.selected).toBe(true)
        expect(div.querySelector("svg")!.getAttributeNames()).toEqual([
          "viewBox"
        ])
        expect(div.querySelector("linearGradient")!.getAttributeNames())
          .toEqual(["gradientUnits"])
      }
    }).pipe(Effect.scoped))

  it.effect("escapes text, keeps a leading newline, and selects the option whose text is the select's value", () =>
    Effect.gen(function*() {
      const Page = Html.component({
        name: "Text",
        model: Schema.Null,
        message: Schema.Never
      }).make({
        init: () => null,
        update: ($) => $.model,
        view: (h) =>
          h.div.children(
            h.p.children("a<b>&c"),
            h.pre.children("\nx"),
            h.select.value("b").children(
              h.option.children("a"),
              h.option.children("b")
            )
          )
      })
      const rendered = yield* HtmlServer.renderToHtml(Page, {})
      expect(rendered.html).toBe(
        "<!--[/Text--><div><p>a&lt;b&gt;&amp;c</p><pre>\n\nx</pre><select><option>a</option><option selected>b</option></select></div><!--]/Text-->"
      )
    }))

  it.effect("never reads the properties of markup it leaves out", () =>
    Effect.gen(function*() {
      // `String` of it throws.
      const unreadable: unknown = Object.create(null)
      const Page = Html.component({
        name: "LeftOut",
        model: Schema.Null,
        message: Schema.Never
      }).make({
        init: () => null,
        update: ($) => $.model,
        view: (h) =>
          h.div.children(
            h.textarea.children(
              h.el("span").prop("value", unreadable).children("only text")
            ),
            h.el("br").children(
              h.el("span").prop("value", unreadable).children("none")
            )
          )
      })
      const rendered = yield* HtmlServer.renderToHtml(Page, {})
      expect(rendered.html).toBe(
        "<!--[/LeftOut--><div><textarea>only text</textarea><br></div><!--]/LeftOut-->"
      )
    }))

  it.effect("reads a non-void element's value property on both writer paths before later siblings", () =>
    Effect.gen(function*() {
      const steps = ["first", "second", "third"]
      let index = 0
      const next = () => steps[index++]!
      const withHiddenValue = (
        node: View.Content<never, never>
      ): View.Node<never> => ({
        ...(View.toNode(node) as View.Element<never>),
        props: Object.freeze(Object.defineProperty({}, "value", { get: next }))
      })
      const Page = Html.component({
        name: "ValueReads",
        model: Schema.Null,
        message: Schema.Never
      }).make({
        init: () => null,
        update: ($) => $.model,
        view: (h) =>
          h.div.children(
            withHiddenValue(h.button),
            h.select.value("a").children(
              withHiddenValue(h.option.attr("value", "a").children("A"))
            ),
            h.input.prop("value", Object.freeze({ toString: next }))
          )
      })
      const rendered = yield* HtmlServer.renderToHtml(Page, {})
      expect(rendered.html).toBe(
        "<!--[/ValueReads--><div><button></button><select><option value=\"a\" selected>A</option></select><input value=\"third\"></div><!--]/ValueReads-->"
      )
    }))

  it.effect("writes element values after the render's Layers are released", () =>
    Effect.gen(function*() {
      let closed = false
      const value = Object.freeze({
        toString: () => closed ? "closed" : "open"
      })
      const Page = Html.component({
        name: "AfterRelease",
        model: Schema.Null,
        message: Schema.Never
      }).make({
        init: () => null,
        update: ($) => $.model,
        view: (h) => h.div.children(h.input.prop("value", value))
      }).pipe(
        Component.provide(
          Layer.effectDiscard(Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed = true
            })
          ))
        )
      )
      const rendered = yield* HtmlServer.renderToHtml(Page, {})
      expect(rendered.html).toBe(
        "<!--[/AfterRelease--><div><input value=\"closed\"></div><!--]/AfterRelease-->"
      )
    }))

  it.effect("keeps winning HTML aliases through updates and removals without folding SVG attributes", () =>
    Effect.gen(function*() {
      // What each step sets, and what the elements then hold. The HTML parser folds
      // SVG names, so both case-sensitive SVG attributes are checked after an update.
      const steps = [
        { loser: "0", winner: "winner", html: "winner", svg: "0" }, // As mounted.
        { loser: "1", winner: "winner", html: "winner", svg: "1" }, // Change the losing alias.
        { loser: undefined, winner: "winner", html: "winner", svg: null }, // Remove the losing alias.
        { loser: "1", winner: "winner", html: "winner", svg: "1" }, // Restore it without changing the winner.
        { loser: "1", winner: undefined, html: "1", svg: "1" }, // Remove the winner, revealing the losing alias.
        { loser: undefined, winner: undefined, html: null, svg: null } // Remove the final alias.
      ] as const
      const Page = Html.component({
        name: "AttributeUpdates",
        model: Schema.Number,
        message: Schema.Number
      }).make({
        init: () => 0,
        update: (_, message) => message,
        view: (h, step) => {
          const { loser, winner } = steps[step]!
          return h.div.children(
            h.div.attrs({ "DATA-X": loser, "data-x": winner }),
            h.el("x-safe").attrs({ "DATA-X": loser, "data-x": winner }),
            h.el("svg").attrs({ viewBox: "0 0 10 10", viewbox: loser })
          )
        }
      })
      const rendered = yield* HtmlServer.renderToHtml(Page, {})
      for (const hydrate of [false, true]) {
        const app = yield* container(hydrate ? rendered.html : "")
        const before = app.firstElementChild
        const root = yield* (hydrate
          ? HtmlHydrate.hydrateEffect(Page, {}, app, rendered.state)
          : BrowserHost.mountEffect(Page, {}, app))
        if (hydrate) expect(app.firstElementChild).toBe(before)
        for (let step = 1; step < steps.length; step++) {
          root.send(step)
          yield* tick
          const { html, svg } = steps[step]!
          const children = app.firstElementChild!.children
          expect(children[0]!.getAttribute("data-x")).toBe(html)
          expect(children[1]!.getAttribute("data-x")).toBe(html)
          expect(children[2]!.getAttribute("viewBox")).toBe("0 0 10 10")
          expect(children[2]!.getAttribute("viewbox")).toBe(svg)
        }
      }
    }).pipe(Effect.scoped))

  it.effect("samples root subscriptions once on the server without building Streams, and surfaces throws", () =>
    Effect.gen(function*() {
      let sampled = 0
      let built = 0
      const Root = Component.define({
        name: "LazyRoot",
        model: Schema.Number,
        message: Schema.Never
      }).make({
        init: () => 0,
        update: ($) => $.model,
        subscriptions: () => {
          sampled++
          return [
            Subscription.make("browser", null, (): Stream.Stream<never> => {
              built++
              throw new Error("browser-only builder")
            })
          ]
        },
        view: (h) => h.text("root")
      })
      const result = yield* HtmlServer.renderToHtml(Root, {})
      assert.include(result.html, "root")
      assert.strictEqual(sampled, 1)
      assert.strictEqual(built, 0)
      const Broken = Component.define({
        name: "BrokenRoot",
        model: Schema.Number,
        message: Schema.Never
      }).make({
        init: () => 0,
        update: ($) => $.model,
        subscriptions: () => {
          throw new Error("subscription declaration failed")
        },
        view: (h) => h.text("unreachable")
      })
      const error = yield* Effect.exit(HtmlServer.renderToHtml(Broken, {}))
      assert.isTrue(Exit.isFailure(error))
    }))

  it.effect("checks only the first Router subscription on the server", () => {
    const problems: Array<Query.Problem.Any> = []
    const Root = Component.define({
      name: "FirstRoute",
      model: Schema.Number,
      message: Schema.Never
    }).make({
      init: () => 0,
      update: ($) => $.model,
      subscriptions: () => [
        Router.subscription(AppRoute, AppRoute.Home(), () => {
          throw new Error("Stream ran")
        }),
        Router.subscription(AppRoute, AppRoute.Slow(), () => {
          throw new Error("Stream ran")
        })
      ],
      view: (h) => h.text("root")
    })
    return Effect.gen(function*() {
      yield* HtmlServer.renderToHtml(Root, {})
      assert.deepStrictEqual(problems, [])
    }).pipe(
      Effect.provide(Router.static({ routes: AppRoute, url: "/" })),
      Effect.provideService(Query.Problems, (problem) => problems.push(problem))
    )
  })

  it.effect("reports a server route mismatch even after navigation, but accepts a fresh snapshot", () => {
    const problems: Array<Query.Problem.Any> = []
    return Effect.gen(function*() {
      const router = yield* Router.Router
      const route = yield* Router.currentRoute(AppRoute)
      yield* router.navigate("/")
      const stale = yield* HtmlServer.renderToHtml(App, { route })
      assert.include(stale.html, "Person 1")
      assert.strictEqual(problems.length, 1)
      assert.strictEqual(problems[0]._tag, "RouteMismatch")
      problems.length = 0
      yield* HtmlServer.renderToHtml(App, {
        route: yield* Router.currentRoute(AppRoute)
      })
      assert.deepStrictEqual(problems, [])
    }).pipe(
      Effect.provide([
        People.layer,
        Router.memory({ routes: AppRoute, url: "/people/1" })
      ]),
      Effect.provideService(Query.Problems, (problem) => problems.push(problem))
    )
  })

  it.effect("renders the routed example with its route data, and hydration adopts it", () =>
    Effect.gen(function*() {
      const router = Router.memory({ routes: AppRoute, url: "/people/1" })
      const rendered = yield* HtmlServer.renderToHtml(
        App,
        Router.props(AppRoute)
      ).pipe(
        Effect.provide([People.layer, router])
      )
      expect(rendered.html).toContain("<p id=\"bio\">Bio of person 1</p>")
      expect(rendered.html).toContain("<!--[/App/Person[/people/1]-->")
      expect(rendered.state["~query"]).toEqual({
        GetBio: [["{\"id\":1}", 0, "Bio of person 1", 0]]
      })
      expect("~pending" in rendered.state).toBe(false)
      expect(rendered.head).toBe(
        "<title data-eui>Person 1 · App</title>" +
          "<meta name=\"description\" content=\"About person 1\" data-eui>" +
          "<script type=\"application/ld+json\" data-eui>{\"@type\":\"Person\",\"identifier\":1}</script>"
      )
      expect(rendered.htmlAttributes).toBe(
        "lang=\"en\" class=\"routed\" data-eui=\"lang class\""
      )

      yield* hosted(Effect.gen(function*() {
        const result = yield* ssr(App, Router.props(AppRoute)).pipe(
          Effect.provide([People.layer, router])
        )
        expect(result.adopted).toEqual(["/App", "/App/Person[/people/1]"])
        expect(result.misses).toEqual([])
        // The bio is hydrated, so the client doesn't fetch it. The hydrated result is on Mounted, and the
        // watch's first value equals it, so it isn't written again.
        expect(result.root.fetches()).toEqual([])
        expect(result.log.filter((entry) => entry._tag === "QueryChanged"))
          .toEqual([])
        expect(
          result.log.some((entry) =>
            entry._tag === "Update" && entry.path === "/App/Person[/people/1]"
          )
        ).toBe(
          false
        )
        expect(result.document.title).toBe("Person 1 · App")
      }))
    }).pipe(Effect.scoped))

  it.effect("renders a modal dialog closed, with no open attribute, and hydration shows it", () =>
    Effect.gen(function*() {
      const props = { state: "modal", acceptEscape: false } as const
      const modal = yield* HtmlServer.renderToHtml(Confirm, props)
      expect(modal.html).toContain("<dialog aria-label=\"Delete note?\">")
      const open = yield* HtmlServer.renderToHtml(Confirm, {
        ...props,
        state: "open"
      })
      expect(open.html).toContain("<dialog aria-label=\"Delete note?\" open>")

      const showModal = vi.spyOn(
        window.HTMLDialogElement.prototype,
        "showModal"
      )
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => showModal.mockRestore())
      )
      const app = yield* container(modal.html)
      const dialog = app.querySelector("dialog")!
      yield* HtmlHydrate.hydrateEffect(Confirm, props, app, modal.state)
      yield* tick
      // The server's dialog is adopted and shown as a modal once it's live.
      expect(app.querySelector("dialog")).toBe(dialog)
      expect(showModal.mock.contexts).toEqual([dialog])
      expect(dialog.open).toBe(true)
    }).pipe(Effect.scoped))

  it.effect("a hydrated open dialog's close belongs to that showing, not to a modal shown since", () =>
    Effect.gen(function*() {
      const props = { state: "open", acceptEscape: false } as const
      const rendered = yield* HtmlServer.renderToHtml(Confirm, props)
      const app = yield* container(rendered.html)
      const dialog = app.querySelector("dialog")!
      const root = yield* HtmlHydrate.hydrateEffect(
        Confirm,
        props,
        app,
        rendered.state
      )
      expect(app.querySelector("dialog")).toBe(dialog)
      // Browsers report a close a task later; happy-dom reports it at once.
      const pending: Array<() => void> = []
      const close = vi.spyOn(dialog, "close").mockImplementation(() => {
        dialog.open = false
        pending.push(() => dialog.dispatchEvent(new Event("close")))
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => close.mockRestore()))
      // The browser closes the adopted showing, and the Model shows a modal before the report.
      dialog.close()
      root.send(ConfirmMessage.Mode({ state: "modal" }))
      yield* Effect.promise(() => Promise.resolve())
      expect(dialog.open).toBe(true)
      pending.shift()!()
      expect(root.model()!.log).toEqual([])
      // The modal's own close still reaches the app.
      dialog.close()
      pending.shift()!()
      expect(root.model()!.log).toEqual(["closed"])
    }).pipe(Effect.scoped))

  it.effect("renders a popover closed with its mode, and hydration shows it", () =>
    Effect.gen(function*() {
      const props = { mode: "manual", open: true, follow: false } as const
      const rendered = yield* HtmlServer.renderToHtml(Menu, props)
      expect(rendered.html).toContain(
        "<div aria-label=\"Menu\" role=\"menu\" popover=\"manual\">"
      )
      const stub = yield* popoverStub
      const app = yield* container(rendered.html)
      const menu = app.querySelector("[aria-label=Menu]")!
      yield* HtmlHydrate.hydrateEffect(Menu, props, app, rendered.state)
      yield* tick
      expect(app.querySelector("[aria-label=Menu]")).toBe(menu)
      expect(stub.calls).toEqual(["showPopover Menu"])
    }).pipe(Effect.scoped))

  it.effect("hydrates what missed the budget: a fetch in flight and a deferred Layer", () =>
    hosted(Effect.gen(function*() {
      const person = yield* routed("/people/2")
      const missed = yield* ssr(App, person.props, {
        budget: "50 millis",
        frames: (container) =>
          container.querySelector("#bio")?.textContent ?? ""
      }).pipe(
        Effect.provide([slowPeople, person.router])
      )
      expect(missed.html).toContain("<p id=\"bio\">Loading</p>")
      // The fetch in flight at the budget was interrupted and isn't shipped: the client fetches it.
      expect(missed.misses).toEqual([{ query: "GetBio", logKey: "{\"id\":2}" }])
      expect(missed.state["~query"]).toEqual({})
      expect(
        missed.root.fetches().map((
          fetch
        ) => [fetch.query, fetch.trigger, fetch.inWindow])
      ).toEqual([
        ["GetBio", "watch", false]
      ])
      yield* TestClock.adjust("300 millis")
      yield* TestHost.settle
      expect(missed.container.querySelector("#bio")!.textContent).toBe(
        "Bio of person 2"
      )
      // From the server's markup through hydration to the fetch the client made.
      expect(missed.root.frames()).toEqual(["Loading", "Bio of person 2"])

      const slow = yield* routed("/slow")
      const deferred = yield* ssr(App, slow.props, { budget: "50 millis" })
        .pipe(
          Effect.provide([People.layer, slow.router])
        )
      // A Layer that missed the budget ships its status with the Model, and the client adopts both.
      expect(deferred.state["~deferred"]).toEqual([])
      expect(deferred.state["~status"]).toEqual({
        "/App/Slow[/slow]": "Pending"
      })
      expect(deferred.state["/App/Slow[/slow]"]).toBeDefined()
      yield* TestClock.adjust("1 second")
      yield* TestHost.settle
      expect(deferred.container.querySelector("h1")!.textContent).toBe("Slow")
    })))

  it.effect("starts no fetch with a budget of 0, and the client fetches what missed it", () =>
    hosted(Effect.gen(function*() {
      const { props, router } = yield* routed("/people/1")
      const result = yield* ssr(App, props, { budget: 0 }).pipe(
        Effect.provide([People.layer, router])
      )
      expect(result.html).toContain("<p id=\"bio\">Loading</p>")
      expect(result.serverLog.filter((entry) => entry._tag === "FetchStarted"))
        .toEqual([])
      expect(result.misses).toEqual([{ query: "GetBio", logKey: "{\"id\":1}" }])
      yield* TestHost.settle
      expect(result.container.querySelector("#bio")!.textContent).toBe(
        "Bio of person 1"
      )
    })))

  it.effect("runs no Command on the server, applies events, and defers failures and opted-out Layers", () =>
    Effect.gen(function*() {
      class GetText extends Query.Service<GetText>()("GetText", {
        args: {},
        success: Schema.String,
        error: Schema.Never,
        staleTime: "30 seconds"
      }) {
        static readonly layer = this.toLayer(() => Effect.succeed("loaded"))
      }
      const ChildMessage = UiSchema.TaggedEnum({ Loaded: {}, Tracked: {} })
      const Track = Command.make(
        "Track",
        { args: {} },
        () => Effect.succeed(ChildMessage.Tracked())
      )
      let builds = 0
      const Child = Html.component({
        name: "Child",
        model: Schema.Struct({ status: Schema.String }),
        message: ChildMessage,
        events: Schema.Literal("loaded"),
        queries: {
          text: {
            query: GetText,
            args: () => ({}),
            onChange: () => ChildMessage.Loaded()
          }
        }
      }).make({
        // init's Command is dropped silently: the client runs it when it adopts.
        init: ($) => $.set({ status: "loading" }).run(Track.make()),
        update: ($, message) =>
          message._tag === "Loaded"
            ? $.set({ status: "loaded" }).run(Command.interrupt(Track)).run(
              Track.make()
            ).emit(
              "loaded"
            )
            : { ...$.model, status: "tracked" },
        subscriptions: () => [
          // subscriptions() runs on the server, but a Stream's builder doesn't.
          Subscription.make("browser", 0, () => {
            builds++
            return Stream.never
          })
        ],
        view: (h, model) => h.span(model.status)
      }).pipe(Component.provide(GetText.layer))
      const Broken = Html.component({
        name: "Broken",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: () => {
          throw new Error("boom")
        }
      })
      class Connection
        extends Context.Service<Connection, string>()("test/Connection")
      {}
      const Live = Html.component({
        name: "Live",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) => h.p("live")
      }).pipe(
        Component.provide(Layer.succeed(Connection, "socket"), {
          server: false
        })
      )
      const ParentMessage = UiSchema.TaggedEnum({ Ready: {} })
      const Parent = Html.component({
        name: "Parent",
        model: Schema.Boolean,
        message: ParentMessage
      }).make({
        init: () => false,
        update: () => true,
        view: (h, ready) =>
          h.div(
            h.p(ready ? "ready" : "waiting"),
            Child(
              h,
              { key: "a", props: {}, onEmit: () => ParentMessage.Ready() }
            ),
            Broken(h, { key: "b", props: {}, fallback: () => h.p("broken") }),
            Live(h, { key: "c", props: {} })
          )
      })

      // The opted-out Layer doesn't spend the budget: under the TestClock, waiting for it would never end.
      const log = MessageLog.makeMemory({ size: 1000 })
      const problems: Array<Query.Problem.Any> = []
      const result = yield* HtmlServer.renderToHtml(Parent, {}, {
        budget: "1 hour"
      }).pipe(
        Effect.provideService(MessageLog.MessageLog, log),
        Effect.provideService(
          Query.Problems,
          (problem) => problems.push(problem)
        )
      )
      expect(result.html).toContain("<p>ready</p>")
      expect(result.html).toContain("<span>loaded</span>")
      expect(result.html).toContain(
        "<!--[/Parent/Broken[b]--><p>broken</p><!--]/Parent/Broken[b]-->"
      )
      expect(result.state["~deferred"]).toEqual([
        "/Parent/Broken[b]",
        "/Parent/Live[c]"
      ])
      expect(builds).toBe(0)
      // Only update's Commands are logged and reported, its interrupt included. init's was dropped silently.
      const dropped = log.entries().filter((entry) =>
        entry._tag === "CommandDropped"
      )
      expect(dropped).toEqual([
        expect.objectContaining({
          path: "/Parent/Child[a]",
          name: "Track",
          reason: "server"
        }),
        expect.objectContaining({
          path: "/Parent/Child[a]",
          name: "Track",
          reason: "server"
        })
      ])
      expect(problems).toEqual([
        expect.objectContaining({
          _tag: "ServerCommandIssued",
          path: "/Parent/Child[a]",
          command: "Track"
        }),
        expect.objectContaining({
          _tag: "ServerCommandIssued",
          path: "/Parent/Child[a]",
          command: "Track"
        })
      ])
    }))

  it.effect("reports ServerCommandIssued every time, and fails ssr with it", () =>
    Effect.gen(function*() {
      const Message = UiSchema.TaggedEnum({ Go: {} })
      const Log = Command.make("Log", { args: {} }, () => Effect.never)
      const Page = Html.component({
        name: "Page",
        model: Schema.Number,
        message: Message
      }).make({
        init: ($) => $.set(0).run(Log.make()),
        update: ($) => $.set($.model + 1).run(Log.make()),
        view: (h, count) =>
          h.p.onMount(mountSending("Go", Message.Go())).children(String(count))
      })
      // An event from a child drives the parent's update twice on the server.
      const Child = Html.component({
        name: "Child",
        model: Schema.Struct({}),
        message: Schema.Never,
        events: Schema.Literal("twice")
      }).make({
        init: ($) => $.set({}).emit("twice").emit("twice"),
        update: ($) => $.model,
        view: (h) => h.span("child")
      })
      const Parent = Html.component({
        name: "Parent",
        model: Schema.Number,
        message: Message
      }).make({
        init: () => 0,
        update: ($) => $.set($.model + 1).run(Log.make()),
        view: (h, count) =>
          h.div(
            h.p(String(count)),
            Child(h, { key: "c", props: {}, onEmit: () => Message.Go() })
          )
      })
      const problems: Array<Query.Problem.Any> = []
      const rendered = yield* HtmlServer.renderToHtml(Parent, {}).pipe(
        Effect.provideService(
          Query.Problems,
          (problem) => problems.push(problem)
        )
      )
      expect(rendered.html).toContain("<p>2</p>")
      expect(problems.map((problem) => problem._tag)).toEqual([
        "ServerCommandIssued",
        "ServerCommandIssued"
      ])

      yield* hosted(Effect.gen(function*() {
        const error = yield* Effect.flip(ssr(Parent, {}))
        expect(
          error.problems.filter((problem) =>
            problem.startsWith("ServerCommandIssued:")
          )
        ).toHaveLength(2)
        yield* TestHost.expectProblem("ServerCommandIssued")
      }))
      // init's Command on its own is no problem.
      yield* hosted(Effect.gen(function*() {
        const result = yield* ssr(Page, {})
        expect(result.commands).toEqual([{
          path: "/Page",
          name: "Log",
          index: 0
        }])
      }))
    }))

  it.effect("keeps an instance whose Layer is still building inert until it adopts, then fires onMount", () =>
    Effect.gen(function*() {
      class Store extends Context.Service<Store, string>()("test/Store") {}
      const Message = UiSchema.TaggedEnum({ Mounted: {}, Clicked: {} })
      const Panel = Html.component({
        name: "Panel",
        model: Schema.Struct({
          mounted: Schema.Boolean,
          clicks: Schema.Number
        }),
        message: Message
      }).make({
        init: () => ({ mounted: false, clicks: 0 }),
        update: ($, message) =>
          message._tag === "Mounted"
            ? { ...$.model, mounted: true }
            : { ...$.model, clicks: $.model.clicks + 1 },
        view: (h, model) =>
          h.button
            .on("click", Message.Clicked())
            .onMount(mountSending("Mounted", Message.Mounted())).children(
              `${model.clicks} ${model.mounted ? "mounted" : "server"}`
            )
      }).pipe(
        Component.provide(
          Layer.effect(Store, Effect.as(Effect.sleep("50 millis"), "ready"))
        )
      )

      const fiber = yield* Effect.forkChild(HtmlServer.renderToHtml(Panel, {}))
      yield* TestClock.adjust("50 millis")
      const rendered = yield* Fiber.join(fiber)
      expect(rendered.state["~deferred"]).toEqual([])
      const app = yield* container(rendered.html)
      const button = app.querySelector("button")!
      const log = MessageLog.makeMemory({ size: 1000 })
      const root = yield* HtmlHydrate.hydrateEffect(
        Panel,
        {},
        app,
        rendered.state
      ).pipe(
        Effect.provideService(MessageLog.MessageLog, log)
      )
      button.click()
      yield* tick
      expect(button.textContent).toBe("0 server")
      // The log says what is on screen while it waits: the server's Model, and no Model of its own.
      expect(log.entries().map((entry) => entry._tag)).toEqual([
        "SessionStarted",
        "Waiting",
        "LayerPending"
      ])
      expect((log.entries()[1] as MessageLog.Waiting).model).toEqual({
        mounted: false,
        clicks: 0
      })

      yield* TestClock.adjust("50 millis")
      yield* root.adopted
      yield* tick
      expect(log.entries().slice(3, 5).map((entry) => entry._tag)).toEqual([
        "LayerReady",
        "Mounted"
      ])
      expect(app.querySelector("button")).toBe(button)
      expect(button.textContent).toBe("0 mounted")
      button.click()
      yield* tick
      expect(button.textContent).toBe("1 mounted")
      expect(app.innerHTML).not.toContain("<!--")
    }).pipe(Effect.scoped))

  describe("keeps what the user changed before adoption", () => {
    const Message = UiSchema.TaggedEnum({
      Input: { field: Schema.String, value: Schema.String },
      Change: { field: Schema.String, value: Schema.String }
    })
    const makeForm = (seen: Array<string>) =>
      Html.component({
        name: "Form",
        model: Schema.Struct({
          name: Schema.String,
          other: Schema.String,
          note: Schema.String,
          agree: Schema.Boolean
        }),
        message: Message
      }).make({
        init: () => ({
          name: "server",
          other: "server",
          note: "server",
          agree: false
        }),
        update: ($, message) => {
          seen.push(`${message._tag} ${message.field}=${message.value}`)
          // The note rejects every edit.
          if (message.field === "note") return $.model
          if (message.field === "agree") {
            return { ...$.model, agree: message.value === "true" }
          }
          return { ...$.model, [message.field]: message.value }
        },
        view: (h, model) => {
          const input =
            (field: string) => ({ value }: { readonly value: string }) =>
              Message.Input({ field, value })
          return h.form(
            h.input.attr("aria-label", "Name").value(model.name).on(
              "input",
              input("name")
            )
              .on("change", ({ value }) =>
                Message.Change({ field: "name", value })),
            h.input.attr("aria-label", "Other").value(model.other).on(
              "input",
              input("other")
            ),
            h.textarea.attr("aria-label", "Note").value(model.note).on(
              "input",
              input("note")
            ),
            h.input.attrs({ type: "checkbox", "aria-label": "Agree" }).checked(
              model.agree
            )
              .on("change", ({ checked }) =>
                Message.Change({ field: "agree", value: String(checked) }))
          )
        }
      })
    const field = <A extends globalThis.Element>(
      app: globalThis.Element,
      label: string
    ) => app.querySelector<A>(`[aria-label="${label}"]`)!

    it.effect("reports an edit made while the instance waits for its Layer", () =>
      Effect.gen(function*() {
        const seen: Array<string> = []
        const Form = makeForm(seen).pipe(
          Component.provide(Layer.effectDiscard(Effect.sleep("50 millis")))
        )
        const fiber = yield* Effect.forkChild(HtmlServer.renderToHtml(Form, {}))
        yield* TestClock.adjust("50 millis")
        const rendered = yield* Fiber.join(fiber)
        const app = yield* container(rendered.html)
        const root = yield* HtmlHydrate.hydrateEffect(
          Form,
          {},
          app,
          rendered.state
        )
        const name = field<HTMLInputElement>(app, "Name")
        const note = field<HTMLTextAreaElement>(app, "Note")
        name.value = "edited"
        // Cleared, which a textarea's rebuilt text can't be told from by its default alone.
        note.value = ""
        yield* tick
        expect(seen).toEqual([])

        yield* TestClock.adjust("50 millis")
        yield* root.adopted
        yield* tick
        expect(field(app, "Name")).toBe(name)
        expect(name.value).toBe("edited")
        expect(field<HTMLInputElement>(app, "Other").value).toBe("server")
        expect(note.value).toBe("server")
        expect(root.model()).toMatchObject({
          name: "edited",
          other: "server",
          note: "server"
        })
        expect(seen).toEqual([
          "Input name=edited",
          "Change name=edited",
          "Input note="
        ])
      }).pipe(Effect.scoped))

    it.effect("reports edits made before the client mounts: a checkbox and a focused field", () =>
      Effect.gen(function*() {
        const seen: Array<string> = []
        const Form = makeForm(seen)
        const rendered = yield* HtmlServer.renderToHtml(Form, {})
        const app = yield* container(rendered.html)
        const agree = field<HTMLInputElement>(app, "Agree")
        const name = field<HTMLInputElement>(app, "Name")
        agree.checked = true
        name.focus()
        name.value = "typed"

        const root = yield* HtmlHydrate.hydrateEffect(
          Form,
          {},
          app,
          rendered.state
        )
        yield* root.adopted
        yield* tick
        expect(agree.checked).toBe(true)
        expect(name.value).toBe("typed")
        expect(root.model()).toMatchObject({ name: "typed", agree: true })
        // The browser still fires the focused field's `change` when it loses focus.
        expect(seen).toEqual(["Input name=typed", "Change agree=true"])
      }).pipe(Effect.scoped))

    // The client Model picks what the server's HTML didn't, so the adoption writes reach the edited group.
    const Choice = Html.component({
      name: "Choice",
      model: Schema.Struct({ choice: Schema.String, pick: Schema.String }),
      message: Message
    })
    const choiceView = (seen: Array<string>) =>
      Choice.make({
        init: () => ({ choice: "a", pick: "" }),
        update: ($, message) => {
          seen.push(`${message._tag} ${message.field}=${message.value}`)
          return { ...$.model, [message.field]: message.value }
        },
        view: (h, model) => {
          const radios = ["a", "b", "c"].map((value) =>
            h.input.attrs({
              type: "radio",
              name: "choice",
              "aria-label": value,
              form: "choices"
            })
              .checked(model.choice === value).on(
                "change",
                () => Message.Change({ field: "choice", value })
              )
          )
          // The browser starts on B: A is disabled by its group.
          const select = h.select.attr("aria-label", "Pick").value(model.pick)
            .on(
              "change",
              ({ value }) => Message.Change({ field: "pick", value })
            )
            .children(
              h.optgroup.attr("disabled", "").children(
                h.option.attr("value", "a").children("A")
              ),
              h.option.attr("value", "b").children("B"),
              h.option.attr("value", "c").children("C")
            )
          return h.div(h.form.attr("id", "choices").children(select), ...radios)
        }
      })

    for (const picked of [false, true]) {
      const name = picked
        ? "keeps a radio picked outside its form"
        : "initializes untouched radios and a select"
      it.effect(name, () =>
        Effect.gen(function*() {
          const seen: Array<string> = []
          const Form = choiceView(seen)
          const rendered = yield* HtmlServer.renderToHtml(Form, {})
          const app = yield* container(rendered.html)
          const radios = ["a", "b", "c"].map((label) =>
            field<HTMLInputElement>(app, label)
          )
          const pick = field<HTMLSelectElement>(app, "Pick")
          expect(pick.value).toBe("b")
          if (picked) radios[1].checked = true
          const expected = picked ? [false, true, false] : [false, false, true]

          const root = yield* HtmlHydrate.hydrateEffect(Form, {}, app, {
            ...rendered.state,
            "/Choice": { choice: "c", pick: "c" }
          })
          expect(radios.map((radio) => radio.checked)).toEqual(expected)
          yield* root.adopted
          yield* tick
          expect(radios.map((radio) => radio.checked)).toEqual(expected)
          expect(pick.value).toBe("c")
          expect(root.model()).toMatchObject({
            choice: picked ? "b" : "c",
            pick: "c"
          })
          expect(seen).toEqual(picked ? ["Change choice=b"] : [])
        }).pipe(Effect.scoped))
    }
  })

  it.effect("a keyed provide selects its Layer from the Model the client adopts", () =>
    Effect.gen(function*() {
      class Store extends Context.Service<Store, string>()("test/KeyedStore") {}
      class ReadStore extends Command.Service<ReadStore>()(
        "test/ReadKeyedStore",
        {
          args: {},
          success: Schema.String,
          error: Schema.Never,
          invalidates: () => []
        }
      ) {
        static readonly layer = this.toLayer(
          Store.useSync((store) => () => Effect.succeed(store))
        )
      }
      // What `init` returns where it runs: the client's is dropped for the Model the server rendered.
      let side = "server"
      const Panel = Component.provide(
        Html.component({
          name: "Panel",
          model: Schema.Struct({ side: Schema.String, store: Schema.String }),
          message: Schema.String
        }).make({
          init: ($) => $.set({ side, store: "" }).run(ReadStore.make()),
          update: ($, store) => ({ ...$.model, store }),
          view: (h, model) => h.p(`${model.side}:${model.store}`)
        }),
        {
          key: (_, model) => model.side,
          layer: (side) =>
            ReadStore.layer.pipe(Layer.provide(Layer.succeed(Store, side)))
        }
      )
      const rendered = yield* HtmlServer.renderToHtml(Panel, {})
      expect(rendered.html).toContain("<p>server:</p>")
      side = "client"
      const app = yield* container(rendered.html)
      const root = yield* HtmlHydrate.hydrateEffect(
        Panel,
        {},
        app,
        rendered.state
      )
      yield* root.adopted
      yield* tick
      expect(app.querySelector("p")!.textContent).toBe("server:server")
    }).pipe(Effect.scoped))

  it.effect("rebuilds nothing outside the instance whose nodes don't match", () =>
    Effect.gen(function*() {
      const Item = Html.component({
        name: "Item",
        props: Schema.Struct({ label: Schema.String }),
        model: Schema.String,
        message: Schema.Never
      }).make({
        init: ($) => $.props.label,
        update: ($) => $.model,
        view: (h, label) => h.li(label)
      })
      const List = Html.component({
        name: "List",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) =>
          h.ul(
            Item(h, { key: "a", props: { label: "A" } }),
            Item(h, { key: "b", props: { label: "B" } })
          )
      })
      const rendered = yield* HtmlServer.renderToHtml(List, {})
      const app = yield* container(
        rendered.html.replace("<li>A</li>", "<li>changed</li>")
      )
      const second = app.querySelectorAll("li")[1]
      yield* HtmlHydrate.hydrateEffect(List, {}, app, rendered.state)
      const [a, b] = app.querySelectorAll("li")
      expect(a.textContent).toBe("A")
      expect(b).toBe(second)
      expect(app.querySelector("ul")!.childNodes.length).toBe(2)
    }).pipe(Effect.scoped))

  it.effect("a mismatch after a row's own nodes keeps the rows beside it, and starts nothing twice", () =>
    Effect.gen(function*() {
      const { app, server, startedOnce } = yield* hydrateRows((html) =>
        html.replace("</ul>", "<hr>$&")
      )
      const items = [...app.querySelectorAll("li")]
      assert.strictEqual(items[0], server.items[0])
      assert.strictEqual(items[1], server.items[1])
      yield* startedOnce
    }).pipe(Effect.scoped))

  // A child whose slot holds another child, with two buttons in a slot of its own, and a node after it.
  // `partly` puts a stray element before the second button, and one after the outer slot.
  const partly = (html: string) =>
    html.replace("<button>go</button>", "<hr>$&").replace(
      "<!--]/Page/Card[c]-->",
      "<hr>$&"
    )
  for (
    const [name, at, tamper, order] of [
      ["a child builds fresh among the server's nodes", "child", partly, [
        "before",
        "first",
        "go",
        "tail",
        "mid",
        "after"
      ]],
      [
        "the root's child builds fresh among the server's nodes",
        "root",
        partly,
        ["first", "go", "tail"]
      ],
      [
        "a child that waited for its Layer builds fresh among the server's nodes",
        "waiting",
        partly,
        [
          "before",
          "mid",
          "first",
          "go",
          "tail",
          "after"
        ]
      ],
      // A stray element where the child's view starts.
      [
        "a child that waited for its Layer builds fresh in place of the server's nodes",
        "waiting",
        (html: string) =>
          html.replace("<!--[/Page/Card[c]/[body]-->", "<hr>$&"),
        ["before", "mid", "first", "go", "tail", "after"]
      ]
    ] as const
  ) {
    it.effect(`places what ${name}`, () =>
      Effect.gen(function*() {
        class Store extends Context.Service<Store, string>()("test/Store") {}
        const Go = Html.ref("Go", "button")
        const mounted: Array<Element> = []
        const looked: Array<Option.Option<Element>> = []
        const Message = UiSchema.TaggedEnum({ Look: {}, Move: {}, Done: {} })
        const Seen = Mount.make("Seen", { args: {} }, (element: Element) =>
          Effect.sync(() => {
            mounted.push(element)
            return Message.Done()
          }))
        const Look = Command.make("Look", { args: {} }, () =>
          Effect.gen(function*() {
            const refs = yield* Renderer.Refs
            looked.push(yield* refs.lookup(Go))
            return Message.Done()
          }))
        const slotted = (name: string) =>
          Html.component({
            name,
            model: Schema.Null,
            message: Schema.Never,
            slots: ["body"]
          }).make({
            init: () =>
              null,
            update: ($) =>
              $.model,
            view: (h) =>
              h.slots.body
          })
        const Inner = slotted("Inner")
        const Ready = slotted("Card")
        const Card = at === "waiting"
          ? Ready.pipe(
            Component.provide(
              Layer.effect(Store, Effect.as(Effect.sleep("50 millis"), "ready"))
            )
          )
          : Ready
        const Page = Html.component({
          name: "Page",
          model: Schema.Boolean,
          message: Message
        }).make({
          init: () =>
            false,
          update: ($, message) =>
            message._tag === "Look"
              ? $.run(Look.make())
              : message._tag === "Move"
              ? true
              : $.model,
          view: (h, moved) => {
            const card = Card(h, {
              key: "c",
              slots: {
                body: [
                  Inner(h, {
                    key: "i",
                    slots: {
                      body: [
                        h.button("first"),
                        h.button.ref(Go).onMount(Seen()).children("go")
                      ]
                    }
                  }),
                  h.u("tail")
                ]
              }
            })
            const mid = h.s.key("m").children("mid")
            return at === "root"
              ? card
              : h.main(
                h.i("before"),
                moved ? [mid, card] : [card, mid],
                h.b("after")
              )
          }
        })
        const fiber = yield* Effect.forkChild(HtmlServer.renderToHtml(Page, {}))
        yield* TestClock.adjust("50 millis")
        const rendered = yield* Fiber.join(fiber)
        const html = tamper(rendered.html)
        assert.include(html, "<hr>")
        const app = yield* container(html)
        const server: Array<Node> = [...app.querySelectorAll("*")]
        const root = yield* HtmlHydrate.hydrateEffect(
          Page,
          {},
          app,
          rendered.state
        )
        if (at === "waiting") {
          // Moved while it waits. Once it has adopted, a move would place all its nodes, one left out too.
          root.send(Message.Move())
          yield* tick
          yield* TestClock.adjust("50 millis")
        }
        yield* root.adopted
        yield* tick
        root.send(Message.Look())
        yield* tick
        const nodes = [...(app.querySelector("main") ?? app).childNodes]
        assert.deepStrictEqual(
          nodes.map((node) =>
            node.textContent
          ),
          [...order]
        )
        // Hydration keeps the nodes that match.
        assert.deepStrictEqual(
          nodes.filter((node) =>
            !server.includes(node)
          ).map((node) => node.textContent),
          tamper === partly ? ["go"] : ["first", "go", "tail"]
        )
        const go = nodes[order.indexOf("go")]
        assert.deepStrictEqual(mounted, [go])
        assert.deepStrictEqual(looked, [Option.some(go)])
      }).pipe(Effect.scoped))
  }

  it.effect("keeps the nodes before a mismatch in the view it's in", () =>
    Effect.gen(function*() {
      const { app, server, startedOnce } = yield* hydrateRows((html) =>
        html.replace("row C", "stale")
      )
      assert.deepStrictEqual([...app.querySelectorAll("li")], server.items)
      assert.deepStrictEqual(
        [...app.querySelectorAll("button")],
        server.buttons
      )
      yield* startedOnce
    }).pipe(Effect.scoped))

  it.effect(
    "keeps the rows before a node the view doesn't render, and builds the rest once",
    () =>
      Effect.gen(function*() {
        // A stray element between the second row and the third, where the list's view has the third.
        const { app, server, startedOnce } = yield* hydrateRows((html) =>
          html.replace("<li><button>C", "<hr>$&")
        )
        const items = [...app.querySelectorAll("li")]
        assert.strictEqual(items[0], server.items[0])
        assert.strictEqual(items[1], server.items[1])
        yield* startedOnce
      }).pipe(Effect.scoped)
  )
  it.effect("fails the parent whose view has two children at one path when it adopts", () =>
    Effect.gen(function*() {
      // The server renders two keys; the client's view at adoption renders one of them twice.
      let client = false
      const Item = Html.component({
        name: "Item",
        props: Schema.Struct({ label: Schema.String }),
        model: Schema.String,
        message: Schema.Never
      }).make({
        init: ($) => $.props.label,
        update: ($) => $.model,
        view: (h, label) => h.li(label)
      })
      const List = Html.component({
        name: "List",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) =>
          h.ul(
            Item(h, { key: "a", props: { label: "A" } }),
            Item(h, { key: client ? "a" : "b", props: { label: "B" } })
          )
      })
      const Page = Html.component({
        name: "Page",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) =>
          h.main(
            List(h, { key: "l", props: {}, fallback: () => h.p("failed") })
          )
      })
      const rendered = yield* HtmlServer.renderToHtml(Page, {})
      expect(rendered.html).toContain("<li>B</li>")
      client = true
      const app = yield* container(rendered.html)
      const log = MessageLog.makeMemory({ size: 1000 })
      yield* HtmlHydrate.hydrateEffect(Page, {}, app, rendered.state)
        .pipe(
          Effect.provideService(MessageLog.MessageLog, log)
        )
      expect(app.querySelector("main")!.innerHTML).toBe("<p>failed</p>")
      const failed = log.entries().filter((entry) => entry._tag === "Failed")
      expect(failed).toEqual([
        expect.objectContaining({ path: "/Page/List[l]", in: "view" })
      ])
      expect(
        log.entries().filter((entry) => entry._tag === "Mounted").map((entry) =>
          entry.path
        )
      ).toEqual([
        "/Page",
        "/Page/List[l]"
      ])
    }).pipe(Effect.scoped))
  it.effect("waits for the instance a Layer that settles in budget wakes, and for the fetches it starts", () =>
    Effect.gen(function*() {
      class GetText extends Query.Service<GetText>()("GetText", {
        args: {},
        success: Schema.String,
        error: Schema.Never,
        staleTime: "30 seconds"
      }) {
        static readonly layer = this.toLayer(() =>
          Effect.as(Effect.sleep("10 millis"), "data")
        )
      }
      class Panel extends Feature.Service<Panel>()("Panel", {
        props: Schema.Struct({}),
        events: Schema.Never
      }) {}
      const PanelLive = Html.component({
        name: "PanelLive",
        model: Schema.Struct({}),
        message: Schema.Never,
        queries: { text: { query: GetText, args: () => ({}) } }
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) =>
          h.p(
            AsyncResult.isSuccess(h.queries.text)
              ? h.queries.text.value
              : "loading"
          )
      }).pipe(Component.provide(GetText.layer))
      const Page = Html.component({
        name: "Page",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) =>
          h.div(
            Panel.render(h, {
              key: "p",
              props: {},
              fallback: () => h.p("fallback")
            })
          )
      }).pipe(
        Component.provide(
          Layer.merge(
            Panel.toLayer(PanelLive),
            Layer.effectDiscard(Effect.sleep("20 millis"))
          )
        )
      )

      const fiber = yield* Effect.forkChild(HtmlServer.renderToHtml(Page, {}))
      yield* TestClock.adjust("20 millis")
      yield* TestClock.adjust("10 millis")
      const rendered = yield* Fiber.join(fiber)
      expect(rendered.html).toContain("<p>data</p>")
      expect(rendered.state["~deferred"]).toEqual([])
      expect(rendered.state["~query"]).toEqual({
        GetText: [["{}", 0, "data", 30]]
      })
    }))

  it.effect("fails and defers the instance whose fetcher dies, and ships no entry for it", () =>
    Effect.gen(function*() {
      class Die extends Query.Service<Die>()("Die", {
        args: {},
        success: Schema.String,
        error: Schema.Never,
        staleTime: "30 seconds"
      }) {
        static readonly layer = this.toLayer(() => Effect.die("boom"))
      }
      const Doomed = Html.component({
        name: "Doomed",
        model: Schema.Struct({}),
        message: Schema.Never,
        queries: { text: { query: Die, args: () => ({}) } }
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) => h.p("loading")
      }).pipe(Component.provide(Die.layer))
      const Page = Html.component({
        name: "Page",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) =>
          h.div(
            Doomed(h, { key: "d", props: {}, fallback: () => h.p("failed") })
          )
      })

      const rendered = yield* HtmlServer.renderToHtml(Page, {})
      expect(rendered.html).toContain(
        "<!--[/Page/Doomed[d]--><p>failed</p><!--]/Page/Doomed[d]-->"
      )
      expect(rendered.state["~deferred"]).toEqual(["/Page/Doomed[d]"])
      expect(rendered.state["~query"]).toEqual({})
    }))

  it.effect("shows the fallback of an instance whose Layer fails on the client, and adopts what follows it", () =>
    Effect.gen(function*() {
      let serving = true
      class Greeting extends Context.Service<Greeting, string>()("Greeting") {}
      const Inner = Html.component({
        name: "Inner",
        model: Schema.String,
        message: Schema.Never
      }).make({
        init: () => "inner",
        update: ($) => $.model,
        view: (h, text) => h.p(text)
      }).pipe(Component.provide(Layer.effect(
        Greeting,
        Effect.suspend(() =>
          serving ? Effect.succeed("hello") : Effect.die("offline")
        )
      )))
      const Page = Html.component({
        name: "Page",
        model: Schema.Null,
        message: Schema.Never
      }).make({
        init: () => null,
        update: ($) => $.model,
        view: (h) =>
          h.main(
            Inner(h, { key: "i", fallback: () => h.em("fallback") }),
            h.span("after")
          )
      })
      const rendered = yield* HtmlServer.renderToHtml(Page, {})
      expect(rendered.html).toContain("<p>inner</p>")
      serving = false
      const app = yield* container(rendered.html)
      const after = app.querySelector("span")
      const root = yield* HtmlHydrate.hydrateEffect(
        Page,
        {},
        app,
        rendered.state
      )
      yield* root.adopted
      expect(app.querySelector("main")!.innerHTML.replace(/<!--.*?-->/g, ""))
        .toBe("<em>fallback</em><span>after</span>")
      expect(app.querySelector("span")).toBe(after)
    }).pipe(Effect.scoped))

  /** What `Object.prototype` has under each reserved key as a render runs: setting one of them wouldn't add it. */
  const inherited: ReadonlyArray<
    readonly [string, PropertyDescriptor | undefined]
  > = [
    ["nothing", undefined],
    ["a value that can't be written", { value: undefined, writable: false }],
    ["a setter", { get: () => undefined, set: () => undefined }]
  ]
  it.effect.each(inherited)(
    "returns the state as a plain record: each path in document order, then the reserved keys, over %s inherited",
    ([, descriptor]) =>
      Effect.gen(function*() {
        class GetText extends Query.Service<GetText>()("GetText", {
          args: {},
          success: Schema.String,
          error: Schema.Never,
          staleTime: "30 seconds"
        }) {
          static readonly layer = this.toLayer(() => Effect.succeed("data"))
        }
        const Changed = UiSchema.TaggedEnum({
          ChangedOn: { on: Schema.Boolean }
        })
        const Group = Component.define({
          name: "Group",
          model: Schema.Number,
          message: Changed,
          shares: {
            value: ({ model: count }) => count,
            collects: {
              schema: Schema.Boolean,
              onChange: (collected) =>
                Changed.ChangedOn({ on: collected.includes(true) })
            }
          }
        }).make({
          init: () => 0,
          update: ($) => $.model + 1,
          parts: (_, count) => ({ count })
        })
        const leaf = {
          model: Schema.Null,
          message: Schema.Never,
          elements: Html
        } as const
        const made = {
          init: () => null,
          update: ($: { readonly model: null }) => $.model
        } as const
        const Item = Component.define({
          ...leaf,
          name: "Item",
          reads: { group: { owner: Group, report: () => true } }
        })
          .make({ ...made, view: (h) => h.span("item") })
        const Asks = Component.define({
          ...leaf,
          name: "Asks",
          queries: { text: { query: GetText, args: () => ({}) } }
        })
          .make({ ...made, view: (h) => h.p("asks") }).pipe(
            Component.provide(GetText.layer)
          )
        const Off = Component.define({ ...leaf, name: "Off" })
          .make({
            ...made,
            view: (h) => h.p("off")
          }).pipe(
            Component.provide(Layer.empty, { server: false })
          )
        const Slow = Component.define({ ...leaf, name: "Slow" })
          .make({
            ...made,
            view: (h) => h.p("slow")
          }).pipe(
            Component.provide(Layer.effectDiscard(Effect.sleep("1 second")))
          )
        const Page = Component.define({ ...leaf, name: "Page" })
          .make({
            ...made,
            view: (h) =>
              h.div(
                Slow(h, { key: "s", props: {} }),
                Group(h, {
                  key: "g",
                  view: () => Item(h, { key: "i", props: {} })
                }),
                Off(h, { key: "o", props: {} }),
                Asks(h, { key: "a", props: {} })
              )
          })

        const reserved = [
          "~deferred",
          "~status",
          "~query",
          "~reported",
          "~static"
        ]
        if (descriptor !== undefined) {
          for (const key of reserved) {
            // Only while the render below runs: it's what the render is held to.
            // oxlint-disable-next-line no-extend-native
            Object.defineProperty(Object.prototype, key, {
              ...descriptor,
              configurable: true
            })
          }
        }
        const { state } = yield* Effect.gen(function*() {
          const fiber = yield* Effect.forkChild(
            HtmlServer.renderToHtml(Page, {}, {
              budget: "50 millis",
              static: true
            })
          )
          yield* TestClock.adjust("50 millis")
          return yield* Fiber.join(fiber)
        }).pipe(Effect.ensuring(Effect.sync(() => {
          for (const key of reserved) delete (Object.prototype as any)[key]
        })))
        // A copy made from it, or its JSON, would be the same for any prototype, and for any order.
        assert.strictEqual(Object.getPrototypeOf(state), Object.prototype)
        const entries: ReadonlyArray<readonly [string, unknown]> = [
          ["/Page", null],
          ["/Page/Slow[s]", null],
          ["/Page/Group[g]", 1],
          ["/Page/Group[g]/Item[i]", null],
          ["/Page/Asks[a]", {
            model: null,
            queries: { text: ["{}", 2] }
          }],
          ["~deferred", ["/Page/Off[o]"]],
          ["~status", { "/Page/Slow[s]": "Pending" }],
          ["~query", { GetText: [["{}", 0, "data", 0]] }],
          ["~reported", { "/Page/Group[g]": { _tag: "ChangedOn", on: true } }],
          ["~static", true]
        ]
        assert.deepStrictEqual(
          Reflect.ownKeys(state),
          entries.map(([key]) => key)
        )
        assert.deepStrictEqual(
          Object.getOwnPropertyDescriptors(state),
          Object.fromEntries(
            entries.map((
              [key, value]
            ) => [key, {
              value,
              writable: true,
              enumerable: true,
              configurable: true
            }])
          )
        )
      })
  )

  it.effect("closes everything it started when the render is interrupted", () =>
    Effect.gen(function*() {
      let acquired = 0
      let released = 0
      const Held = Layer.effectDiscard(
        Effect.acquireRelease(
          Effect.sync(() => acquired++),
          () => Effect.sync(() => released++)
        ).pipe(
          Effect.andThen(Effect.sleep("100 millis"))
        )
      )
      const Page = Html.component({
        name: "Page",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) => h.p("page")
      }).pipe(Component.provide(Held))
      const fiber = yield* Effect.forkChild(HtmlServer.renderToHtml(Page, {}))
      yield* TestClock.adjust("20 millis")
      expect([acquired, released]).toEqual([1, 0])
      yield* Fiber.interrupt(fiber)
      yield* TestClock.adjust("150 millis")
      expect([acquired, released]).toEqual([1, 1])
    }))

  it.effect("writes only text inside a textarea, and hydration rebuilds just that text", () =>
    hosted(Effect.gen(function*() {
      const Word = Html.component({
        name: "Word",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) => h.text("hello")
      })
      const Form = Html.component({
        name: "Form",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) =>
          h.div(h.textarea(Word(h, { key: "a", props: {} })), h.p("after"))
      })
      const result = yield* ssr(Form, {})
      expect(result.html).toBe(
        "<!--[/Form--><div><textarea>hello</textarea><p>after</p></div><!--]/Form-->"
      )
      expect(result.adopted).toEqual(["/Form", "/Form/Word[a]"])
      expect(result.container.querySelector("textarea")!.value).toBe("hello")
    })))

  it.effect("judges adoption when it commits, before onMount updates replace nodes", () =>
    hosted(Effect.gen(function*() {
      const Message = UiSchema.TaggedEnum({ Mounted: {} })
      const Swap = Html.component({
        name: "Swap",
        model: Schema.Boolean,
        message: Message
      }).make({
        init: () => false,
        update: () => true,
        view: (h, mounted) =>
          mounted
            ? h.div("mounted")
            : h.p.onMount(mountSending("Swap", Message.Mounted())).children(
              "server"
            )
      })
      const result = yield* ssr(Swap, {})
      yield* TestHost.settle
      expect(result.container.textContent).toBe("mounted")
    })))
  it.effect("keeps marker paths through the parser's normalisation of CR, NUL and lone surrogates", () =>
    Effect.gen(function*() {
      const Leaf = Html.component({
        name: "Leaf",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) => h.p("leaf")
      })
      const Root = Html.component({
        name: "Root",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) => Leaf(h, { key: "a\rb\r\nc\u0000d\ud800e-->", props: {} })
      })
      const rendered = yield* HtmlServer.renderToHtml(Root, {})
      // What a browser does before it parses: UTF-8 replaces a lone surrogate, the input stream turns CR
      // and CRLF into LF, and a comment turns NUL into U+FFFD. Happy DOM does none of it.
      const parsed = new TextDecoder().decode(
        new TextEncoder().encode(rendered.html)
      )
        .replace(/\r\n?/g, "\n")
        .replaceAll("\u0000", "\ufffd")
      expect(parsed).toBe(rendered.html)
      const app = yield* container(parsed)
      const leaf = app.querySelector("p")
      yield* HtmlHydrate.hydrateEffect(Root, {}, app, rendered.state)
      expect(app.querySelector("p")).toBe(leaf)
      expect(app.innerHTML).toBe("<p>leaf</p>")
    }).pipe(Effect.scoped))

  it.effect("compares the client's first fold, so a mount update while an instance waits isn't a mismatch", () =>
    hosted(Effect.gen(function*() {
      class Slow extends Context.Service<Slow, string>()("test/Slow") {}
      const Waiting = Html.component({
        name: "Waiting",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) => h.p("waiting")
      }).pipe(
        Component.provide(
          Layer.effect(Slow, Effect.as(Effect.sleep("30 millis"), "ready"))
        )
      )
      const Message = UiSchema.TaggedEnum({ Mounted: {} })
      const Titled = Html.component({
        name: "Titled",
        model: Schema.String,
        message: Message
      }).make({
        init: () => "server",
        update: () => "mounted",
        head: ({ model: title }) => [Head.title(title)],
        view: (h) =>
          h.div.onMount(mountSending("Title", Message.Mounted())).children(
            Waiting(h, { key: "w", props: {} })
          )
      })
      const result = yield* ssr(Titled, {})
      expect(result.adopted).toEqual(["/Titled", "/Titled/Waiting[w]"])
      yield* TestHost.settle
      expect(result.document.title).toBe("mounted")
    })))
  it.effect("compares the client's first fold, so a head that mounts while an instance waits isn't a mismatch", () =>
    hosted(Effect.gen(function*() {
      class Slow extends Context.Service<Slow, string>()("test/Slow") {}
      const Waiting = Html.component({
        name: "Waiting",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) => h.p("waiting")
      }).pipe(
        Component.provide(
          Layer.effect(Slow, Effect.as(Effect.sleep("30 millis"), "ready"))
        )
      )
      const Titled = Html.component({
        name: "Titled",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        head: () => [Head.title("mounted")],
        view: (h) => h.p("titled")
      })
      const Message = UiSchema.TaggedEnum({ Mounted: {} })
      // Nothing has a head until the mount's message places the child that does.
      const Page = Html.component({
        name: "Page",
        model: Schema.Boolean,
        message: Message
      }).make({
        init: () => false,
        update: () => true,
        view: (h, titled) =>
          h.div.onMount(mountSending("Title", Message.Mounted())).children(
            Waiting(h, { key: "w", props: {} }),
            titled && Titled(h, { key: "t", props: {} })
          )
      })
      const result = yield* ssr(Page, {})
      expect(result.adopted).toEqual(["/Page", "/Page/Waiting[w]"])
      yield* TestHost.settle
      expect(result.document.title).toBe("mounted")
    })))
  it.effect("compares the head the client evaluated, over the instance tree, not one rebuilt from paths", () =>
    hosted(Effect.gen(function*() {
      // Alternates per evaluation, so evaluating it again after adoption would agree with the server.
      let runs = 0
      const Unstable = Html.component({
        name: "Unstable",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        head: () => [Head.title(runs++ % 2 === 0 ? "server" : "client")],
        view: (h) => h.p("same")
      })
      const unstable = yield* Effect.flip(ssr(Unstable, {}))
      expect(unstable.problems).toEqual([
        "head title: the server has \"server\", the client \"client\""
      ])
      expect(runs).toBe(2)

      // Siblings whose keys make one path look like the other's descendant: no template applies, and both
      // folds report the siblings' conflict rather than a head mismatch.
      const Box = Html.component({
        name: "Box",
        props: Schema.Struct({ title: Schema.String }),
        model: Schema.String,
        message: Schema.Never
      }).make({
        init: ($) => $.props.title,
        update: ($) => $.model,
        head: (
          { model: title }
        ) => [
          Head.title(title),
          Head.titleTemplate((inner) => `wrap(${inner})`)
        ],
        view: (h, title) => h.p(title)
      })
      const Siblings = Html.component({
        name: "Siblings",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) =>
          h.div(
            Box(h, { key: "a", props: { title: "A" } }),
            Box(h, { key: "a]/Box[b", props: { title: "B" } })
          )
      })
      const siblings = yield* Effect.flip(ssr(Siblings, {}))
      const conflict =
        "HeadConflict: Head: /Siblings/Box[a] and /Siblings/Box[a]%2FBox[b] set title to different " +
        "values, so it's left unset"
      expect(siblings.problems).toEqual([conflict, conflict])
      yield* TestHost.expectProblem("HeadConflict")

      // A template that really applies, and differs on the client, still fails.
      let templates = 0
      const Outer = Html.component({
        name: "Outer",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        head: () => {
          const side = templates++ % 2 === 0 ? "server" : "client"
          return [Head.titleTemplate((inner) => `${inner} (${side})`)]
        },
        view: (h) => h.div(Box(h, { key: "a", props: { title: "Inner" } }))
      })
      const nested = yield* Effect.flip(ssr(Outer, {}))
      expect(nested.problems).toEqual([
        "head title: the server has \"Inner (server)\", the client \"Inner (client)\""
      ])
    })))
  it.effect("compares the head a waiting child's subtree had with the props it was placed with", () =>
    hosted(Effect.gen(function*() {
      class Slow extends Context.Service<Slow, string>()("test/Slow") {}
      const titled = (suffix: () => string) => {
        const Grandchild = Html.component({
          name: "Grandchild",
          model: Schema.Struct({}),
          message: Schema.Never,
          props: Schema.Struct({ title: Schema.String })
        }).make({
          init: () => ({}),
          update: ($) => $.model,
          head: ({ props }) => [Head.title(props.title + suffix())],
          view: (h) => h.p("grandchild")
        })
        const Child = Html.component({
          name: "Child",
          model: Schema.Struct({}),
          message: Schema.Never,
          props: Schema.Struct({ title: Schema.String })
        }).make({
          init: () => ({}),
          update: ($) => $.model,
          head: (
            { props }
          ) => [Head.titleTemplate((title) => `${props.title}: ${title}`)],
          // The title is in the nodes too: the child adopts them with the props it was placed with.
          view: (h) =>
            h.div(
              h.span(h.props.title),
              Grandchild(h, { key: "g", props: { title: h.props.title } })
            )
        }).pipe(
          Component.provide(
            Layer.effect(Slow, Effect.as(Effect.sleep("30 millis"), "ready"))
          )
        )
        const Message = UiSchema.TaggedEnum({ Mounted: {} })
        return Html.component({
          name: "Parent",
          model: Schema.String,
          message: Message
        }).make({
          init: () => "Server",
          update: () => "Mounted",
          view: (h, title) =>
            h.div.onMount(mountSending("Rename", Message.Mounted())).children(
              Child(h, { key: "c", props: { title } })
            )
        })
      }

      const matching = yield* ssr(titled(() => ""), {})
      expect(matching.adopted).toEqual([
        "/Parent",
        "/Parent/Child[c]",
        "/Parent/Child[c]/Grandchild[g]"
      ])
      expect(matching.head.title).toBe("Server: Server")
      yield* TestHost.settle
      expect(matching.root.head<Head.Head>().title).toBe("Mounted: Mounted")
      expect(matching.document.title).toBe("Mounted: Mounted")
      expect(matching.container.textContent).toContain("Mounted")

      let calls = 0
      const drifting = yield* Effect.flip(
        ssr(titled(() => calls++ === 0 ? "" : "!"), {})
      )
      expect(drifting.problems).toEqual([
        "head title: the server has \"Server: Server\", the client \"Server: Server!\""
      ])
    })))

  it.effect("adopts a waiting child with the slots it was placed with, and applies the new ones after", () =>
    hosted(Effect.gen(function*() {
      class Slow extends Context.Service<Slow, string>()("test/Slow") {}
      const titled = (suffix: () => string) => {
        const Grandchild = Html.component({
          name: "Grandchild",
          model: Schema.Struct({}),
          message: Schema.Never,
          props: Schema.Struct({ title: Schema.String })
        }).make({
          init: () => ({}),
          update: ($) => $.model,
          head: ({ props }) => [Head.title(props.title + suffix())],
          view: (h) => h.p(h.props.title)
        })
        const Framed = Html.component({
          name: "Framed",
          model: Schema.Struct({}),
          message: Schema.Never,
          slots: ["body"]
        }).make({
          init: () => ({}),
          update: ($) => $.model,
          view: (h) => h.div(h.slots.body)
        }).pipe(
          Component.provide(
            Layer.effect(Slow, Effect.as(Effect.sleep("30 millis"), "ready"))
          )
        )
        const Message = UiSchema.TaggedEnum({ Mounted: {} })
        return Html.component({
          name: "Parent",
          model: Schema.String,
          message: Message
        }).make({
          init: () => "Server",
          update: () => "Mounted",
          // The slot's content changes while the child waits: it adopts what it was placed with, "Server".
          view: (h, title) =>
            h.div.onMount(mountSending("Rename", Message.Mounted())).children(
              Framed(h, {
                key: "c",
                slots: { body: Grandchild(h, { key: "g", props: { title } }) }
              })
            )
        })
      }

      const matching = yield* ssr(titled(() => ""), {})
      expect(matching.adopted).toEqual([
        "/Parent",
        "/Parent/Framed[c]",
        "/Parent/Framed[c]/[body]/Grandchild[g]"
      ])
      expect(matching.head.title).toBe("Server")
      yield* TestHost.settle
      expect(matching.root.head<Head.Head>().title).toBe("Mounted")
      expect(matching.document.title).toBe("Mounted")
      expect(matching.container.textContent).toBe("Mounted")

      let calls = 0
      const drifting = yield* Effect.flip(
        ssr(titled(() => calls++ === 0 ? "" : "!"), {})
      )
      expect(drifting.problems).toEqual([
        "head title: the server has \"Server\", the client \"Server!\""
      ])
    })))

  it.effect("compares the client's first fold, so removing an instance while another waits isn't a mismatch", () =>
    hosted(Effect.gen(function*() {
      class Slow extends Context.Service<Slow, string>()("test/Slow") {}
      const Waiting = Html.component({
        name: "Waiting",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) => h.p("waiting")
      }).pipe(
        Component.provide(
          Layer.effect(Slow, Effect.as(Effect.sleep("30 millis"), "ready"))
        )
      )
      const Titled = Html.component({
        name: "Titled",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        head: () => [Head.title("title")],
        view: (h) => h.p("titled")
      })
      const Message = UiSchema.TaggedEnum({ Mounted: {} })
      const Page = Html.component({
        name: "Page",
        model: Schema.Boolean,
        message: Message
      }).make({
        init: () => true,
        update: () => false,
        view: (h, showTitled) =>
          h.div.onMount(mountSending("Hide", Message.Mounted())).children(
            showTitled ? Titled(h, { key: "t", props: {} }) : h.p("gone"),
            Waiting(h, { key: "w", props: {} })
          )
      })
      const result = yield* ssr(Page, {})
      expect(result.head.title).toBe("title")
      expect(result.adopted).toEqual([
        "/Page",
        "/Page/Titled[t]",
        "/Page/Waiting[w]"
      ])
      yield* TestHost.settle
      expect(result.container.textContent).toBe("gonewaiting")
    })))

  it.effect("an instance removed while it waits logs Waiting, then Unmounted, and nothing once its Layer would be ready", () =>
    Effect.gen(function*() {
      class Slow extends Context.Service<Slow, string>()("test/Slow") {}
      class GetText extends Query.Service<GetText>()("GetText", {
        args: {},
        success: Schema.String,
        error: Schema.Never,
        staleTime: "30 seconds"
      }) {
        static readonly layer = this.toLayer(() => Effect.succeed("loaded"))
      }
      const Panel = Html.component({
        name: "Panel",
        props: Schema.Struct({ id: Schema.String }),
        model: Schema.Struct({ label: Schema.String }),
        message: Schema.Never,
        queries: { text: { query: GetText, args: () => ({}) } }
      }).make({
        init: ($) => ({ label: `panel ${$.props.id}` }),
        update: ($) => $.model,
        view: (h, model) => h.p(model.label)
      }).pipe(
        Component.provide(
          Layer.effect(Slow, Effect.as(Effect.sleep("50 millis"), "ready"))
        )
      )
      const Page = Html.component({
        name: "Page",
        model: Schema.Boolean,
        message: Schema.Boolean
      }).make({
        init: () => true,
        update: (_, show) => show,
        view: (h, show) =>
          h.div(show ? Panel(h, { key: "p", props: { id: "a" } }) : h.p("gone"))
      })

      const fiber = yield* Effect.forkChild(
        HtmlServer.renderToHtml(Page, {}).pipe(Effect.provide(GetText.layer))
      )
      yield* TestClock.adjust("50 millis")
      const rendered = yield* Fiber.join(fiber)
      const app = yield* container(rendered.html)
      expect(app.textContent).toBe("panel a")
      const log = MessageLog.makeMemory({ size: 1000 })
      const root = yield* HtmlHydrate.hydrateEffect(
        Page,
        {},
        app,
        rendered.state
      ).pipe(
        Effect.provideService(MessageLog.MessageLog, log),
        Effect.provide(GetText.layer)
      )
      // Removed while its Layer is still building, which then gets the time it would have needed.
      root.send(false)
      yield* tick
      expect(app.textContent).toBe("gone")
      yield* TestClock.adjust("50 millis")
      yield* tick

      const panel = log.entries().filter((
        entry
      ): entry is MessageLog.InstanceEntry =>
        "path" in entry && entry.path === "/Page/Panel[p]"
      )
      expect(panel.map((entry) => entry._tag)).toEqual([
        "Waiting",
        "LayerPending",
        "Unmounted"
      ])
      expect(new Set(panel.map((entry) => entry.instance)).size).toBe(1)
      // The only entry that says what the server's nodes showed: it crosses the Wire whole.
      const wire = MessageLog.makeEncoder().encode(panel[0]!) as Extract<
        MessageLog.Wire,
        { _tag: "Waiting" }
      >
      expect(wire.props).toEqual({ id: "a" })
      expect(wire.model).toEqual({ label: "panel a" })
      expect(
        (wire.queries as { readonly text: ReadonlyArray<unknown> }).text.slice(
          0,
          3
        )
      ).toEqual([
        "{}",
        0,
        "loaded"
      ])
      expect(
        Schema.decodeUnknownSync(MessageLog.Wire)(
          JSON.parse(JSON.stringify(wire))
        )
      ).toEqual(wire)
    }).pipe(Effect.scoped))

  it.effect("drops the placement held for a waiting instance its parent removes, and never applies it", () =>
    Effect.gen(function*() {
      class Slow extends Context.Service<Slow, string>()("test/Slow") {}
      const Panel = Html.component({
        name: "Panel",
        props: Schema.Struct({ id: Schema.String }),
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) => h.p(`panel ${h.props.id}`)
      }).pipe(
        Component.provide(
          Layer.effect(Slow, Effect.as(Effect.sleep("50 millis"), "ready"))
        )
      )
      const Page = Html.component({
        name: "Page",
        model: Schema.String,
        message: Schema.String
      }).make({
        init: () => "a",
        update: (_, id) => id,
        view: (h, id) =>
          h.div(id === "" ? h.p("gone") : Panel(h, { key: "p", props: { id } }))
      })

      const fiber = yield* Effect.forkChild(HtmlServer.renderToHtml(Page, {}))
      yield* TestClock.adjust("50 millis")
      const rendered = yield* Fiber.join(fiber)
      const app = yield* container(rendered.html)
      const log = MessageLog.makeMemory({ size: 1000 })
      const root = yield* HtmlHydrate.hydrateEffect(
        Page,
        {},
        app,
        rendered.state
      ).pipe(
        Effect.provideService(MessageLog.MessageLog, log)
      )
      // New props while it waits are held, not applied: the server's nodes stay as they are.
      root.send("b")
      yield* tick
      expect(app.textContent).toBe("panel a")
      root.send("")
      yield* tick
      expect(app.textContent).toBe("gone")
      yield* TestClock.adjust("50 millis")
      yield* tick
      yield* root.adopted

      const panel = log.entries().filter((
        entry
      ): entry is MessageLog.InstanceEntry =>
        "path" in entry && entry.path === "/Page/Panel[p]"
      )
      expect(panel.map((entry) => entry._tag)).toEqual([
        "Waiting",
        "LayerPending",
        "Unmounted"
      ])
    }).pipe(Effect.scoped))

  it.effect("calls a title template once in the server's fold and once in the client's first fold", () =>
    hosted(Effect.gen(function*() {
      const Leaf = Html.component({
        name: "Leaf",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        head: () => [Head.title("leaf")],
        view: (h) => h.p("leaf")
      })
      const withTemplate = (template: (calls: number) => string) => {
        let calls = 0
        const Parent = Html.component({
          name: "Parent",
          model: Schema.Struct({}),
          message: Schema.Never
        }).make({
          init: () => ({}),
          update: ($) => $.model,
          head: () => [Head.titleTemplate(() => template(calls++))],
          view: (h) => h.div(Leaf(h, { key: "l", props: {} }))
        })
        return { Parent, calls: () => calls }
      }

      // One call in the server's fold and one in the client's. Both return "server", which is what the
      // client shows, so hydration agrees.
      const agrees = withTemplate((calls) => calls < 2 ? "server" : "client")
      const result = yield* ssr(agrees.Parent, {})
      expect(agrees.calls()).toBe(2)
      expect(result.head.title).toBe("server")
      expect(result.document.title).toBe("server")

      // The client's one call differs from the server's, and the mismatch shows the client's result.
      const differs = withTemplate((calls) => calls < 1 ? "server" : "client")
      const error = yield* Effect.flip(ssr(differs.Parent, {}))
      expect(differs.calls()).toBe(2)
      expect(error.problems).toEqual([
        "head title: the server has \"server\", the client \"client\""
      ])
    })))
  it.effect("leaves an instance its own title template fails out of the client's fold, as the server does", () =>
    hosted(Effect.gen(function*() {
      const Leaf = Html.component({
        name: "Leaf",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        head: () => [Head.title("leaf")],
        view: (h) => h.p("leaf")
      })
      const Broken = Html.component({
        name: "Broken",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        head: () => [
          Head.titleTemplate(() => {
            throw new Error("template")
          })
        ],
        view: (h) => h.div(Leaf(h, { key: "l", props: {} }))
      })
      const Parent = Html.component({
        name: "Parent",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        // Two siblings, each failed by its own template in the fold: neither contributes, on either side.
        view: (h) =>
          h.div(
            Broken(h, {
              key: "a",
              props: {},
              fallback: () => h.p("fallback a")
            }),
            Broken(h, {
              key: "b",
              props: {},
              fallback: () => h.p("fallback b")
            })
          )
      })
      const result = yield* ssr(Parent, {})
      expect(result.head.title).toBeUndefined()
      expect(result.state["~deferred"]).toEqual([
        "/Parent/Broken[a]",
        "/Parent/Broken[b]"
      ])
      expect(result.container.textContent).toBe("fallback afallback b")
    })))

  it.effect("calls a title template once per fold", () =>
    Effect.gen(function*() {
      let calls = 0
      // One entry shared by every head evaluation, so a cache keyed on entries would keep it.
      const template = Head.titleTemplate((title) => {
        calls++
        return `${title} - App`
      })
      const Leaf = Html.component({
        name: "Leaf",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        head: () => [Head.title("leaf")],
        view: (h) => h.p("leaf")
      })
      const Message = UiSchema.TaggedEnum({ Bump: {} })
      const Layout = Html.component({
        name: "Layout",
        model: Schema.Number,
        message: Message
      }).make({
        init: () => 0,
        update: ($) => $.model + 1,
        head: () => [template],
        view: (h, count) =>
          h.div(h.p(String(count)), Leaf(h, { key: "l", props: {} }))
      })
      const bumpThrice = Effect.fnUntraced(
        function*(
          root: { readonly send: (message: typeof Message.Type) => void }
        ) {
          for (let i = 0; i < 3; i++) {
            root.send(Message.Bump())
            yield* tick
          }
        }
      )

      // A plain mount: each of the four folds (mount and three updates) calls the template.
      const app = yield* container("")
      const mounted = yield* BrowserHost.mountEffect(Layout, {}, app)
      yield* bumpThrice(mounted)
      expect(calls).toBe(4)

      // Hydration: one call in the server's fold, one in the client's first, then one per update.
      calls = 0
      yield* hosted(Effect.gen(function*() {
        const result = yield* ssr(Layout, {})
        expect(calls).toBe(2)
        for (let i = 0; i < 3; i++) {
          result.root.send(Message.Bump())
          yield* TestHost.settle
        }
        expect(calls).toBe(5)
        expect(result.document.title).toBe("leaf - App")
      }))
    }).pipe(Effect.scoped))

  it.effect("recovers from mismatches on marker-free single-element children", () =>
    Effect.gen(function*() {
      let client = false
      const Item = Html.component({
        name: "Item",
        props: Schema.Struct({ label: Schema.String, tag: Schema.String }),
        model: Schema.String,
        message: Schema.Never
      }).make({
        init: ($) => $.props.label,
        update: ($) => $.model,
        view: (h, label) =>
          client && h.props.tag === "empty"
            ? h.text("")
            : client && h.props.tag === "p"
            ? h.p.attr("data-l", label).children(label)
            : h.li.attr("data-l", label).children(h.span(label))
      })
      const makeList = (
        order: (isClient: boolean) => ReadonlyArray<readonly [string, string?]>
      ) =>
        Html.component({
          name: "List",
          model: Schema.Struct({}),
          message: Schema.Never
        }).make({
          init: () => ({}),
          update: ($) => $.model,
          view: (h) =>
            h.ul(
              order(client).map(([label, tag]) =>
                Item(h, { key: label, props: { label, tag: tag ?? "" } })
              ),
              h.li("tail")
            )
        })
      const assertMatchesDeclared = (actual: Element, expected: Element) => {
        const actualNodes = [...actual.querySelector("ul")!.childNodes]
        const expectedNodes = [...expected.querySelector("ul")!.childNodes]
        assert.strictEqual(actualNodes.length, expectedNodes.length)
        for (let i = 0; i < expectedNodes.length; i++) {
          const a = actualNodes[i]!
          const e = expectedNodes[i]!
          assert.strictEqual(a.nodeType, e.nodeType)
          assert.strictEqual(a.textContent, e.textContent)
          if (e.nodeType === 1) {
            assert.strictEqual((a as Element).tagName, (e as Element).tagName)
            for (const attr of (e as Element).attributes) {
              assert.strictEqual(
                (a as Element).getAttribute(attr.name),
                attr.value
              )
            }
          }
        }
      }

      for (
        const [order, exact, identity] of [
          [() => [["A"], ["B", "p"], ["C"]], true, "neighbors"],
          [() => [["A"], ["B", "empty"], ["C"]], true, "neighbors"],
          [
            (isClient: boolean) =>
              isClient ? [["Z"], ["A"], ["B"]] : [["A"], ["B"]],
            true,
            "rebuilt"
          ],
          [
            (isClient: boolean) =>
              isClient ? [["B"], ["C"]] : [["A"], ["B"], ["C"]],
            false,
            "shifted"
          ]
        ] as ReadonlyArray<
          readonly [
            (isClient: boolean) => ReadonlyArray<readonly [string, string?]>,
            boolean,
            "neighbors" | "rebuilt" | "shifted"
          ]
        >
      ) {
        const List = makeList(order)
        client = false
        const rendered = yield* HtmlServer.renderToHtml(List, {})
        assert.notInclude(rendered.html, "<!--[/List/Item[")
        const fresh = yield* container("")
        client = true
        yield* BrowserHost.mountEffect(List, {}, fresh, {})
        const app = yield* container(rendered.html)
        const serverItems = [...app.querySelectorAll("li")]
        const root = yield* HtmlHydrate.hydrateEffect(
          List,
          {},
          app,
          rendered.state
        )
        yield* root.adopted
        yield* tick
        if (exact) assert.strictEqual(app.innerHTML, fresh.innerHTML)
        else assertMatchesDeclared(app, fresh)
        const hydratedItems = [...app.querySelectorAll("li")]
        if (identity === "neighbors") {
          assert.strictEqual(hydratedItems[0], serverItems[0])
          assert.strictEqual(hydratedItems[1], serverItems[2])
        } else if (identity === "rebuilt") {
          for (const item of hydratedItems) assert.notInclude(serverItems, item)
        } else {
          assert.strictEqual(hydratedItems[0], serverItems[0])
          assert.strictEqual(hydratedItems[1], serverItems[1])
        }
      }
    }).pipe(Effect.scoped))

  it.effect("hydrates single-element children wrapped in legacy marker pairs", () =>
    Effect.gen(function*() {
      const Item = Html.component({
        name: "Item",
        props: Schema.Struct({ label: Schema.String }),
        model: Schema.String,
        message: Schema.Never
      }).make({
        init: ($) => $.props.label,
        update: ($) => $.model,
        view: (h, label) => h.li(label)
      })
      const List = Html.component({
        name: "List",
        model: Schema.Struct({}),
        message: Schema.Never
      })
        .make({
          init: () => ({}),
          update: ($) => $.model,
          view: (h) =>
            h.ul(
              Item(h, { key: "A", props: { label: "A" } }),
              Item(h, { key: "B", props: { label: "B" } })
            )
        })
      const rendered = yield* HtmlServer.renderToHtml(List, {})
      const legacyHtml = rendered.html
        .replace(
          "<li>A</li>",
          "<!--[/List/Item[A]--><li>A</li><!--]/List/Item[A]-->"
        )
        .replace(
          "<li>B</li>",
          "<!--[/List/Item[B]--><li>B</li><!--]/List/Item[B]-->"
        )
      const app = yield* container(legacyHtml)
      const serverItems = [...app.querySelectorAll("li")]
      const root = yield* HtmlHydrate.hydrateEffect(
        List,
        {},
        app,
        rendered.state
      )
      yield* root.adopted
      yield* tick
      assert.deepStrictEqual([...app.querySelectorAll("li")], serverItems)
      assert.notInclude(app.innerHTML, "<!--")
    }).pipe(Effect.scoped))

  it.effect("ssr() includes the rebuilt node's tag when a marker-free child mismatches", () =>
    hosted(Effect.gen(function*() {
      let renders = 0
      const Item = Html.component({
        name: "Item",
        model: Schema.Null,
        message: Schema.Never
      }).make({
        init: () => null,
        update: ($) => $.model,
        view: (h) => renders++ === 0 ? h.li("a") : h.p("a")
      })
      const List = Html.component({
        name: "List",
        model: Schema.Null,
        message: Schema.Never
      }).make({
        init: () => null,
        update: ($) => $.model,
        view: (h) => h.ul(Item(h, { key: "a", props: {} }))
      })
      const error = yield* Effect.flip(ssr(List, {}))
      assert.include(
        String(error),
        "/List: the client rebuilt the server's nodes instead of adopting them, starting at <li>"
      )
    })))
})

/** A query that counts its fetches and fails for id 404, and an `Item` that watches it by its props. */
const makeItems = () => {
  const calls: Array<number> = []
  class GetItem extends Query.Service<GetItem>()(
    "GetItem",
    {
      args: { id: Schema.Number },
      success: Schema.String,
      error: Schema.String,
      staleTime: "1 minute"
    }
  ) {
    static readonly layer = this.toLayer(({ id }) =>
      Effect.suspend(() => {
        calls.push(id)
        return id === 404
          ? Effect.fail("missing")
          : Effect.succeed(`Item ${id}`)
      })
    )
  }
  const show = (result: AsyncResult.AsyncResult<string, string>) =>
    AsyncResult.isSuccess(result)
      ? result.value
      : AsyncResult.isFailure(result)
      ? "failed"
      : "loading"
  const Item = Html.component({
    name: "Item",
    model: Schema.Struct({}),
    message: Schema.Never,
    props: Schema.Struct({ id: Schema.Number }),
    queries: {
      item: { query: GetItem, args: ({ props }) => ({ id: props.id }) }
    }
  }).make({
    init: () => ({}),
    update: ($) => $.model,
    view: (h) => h.p(show(h.queries.item))
  }).pipe(Component.provide(GetItem.layer))
  return { calls, GetItem, Item, show }
}

describe("HtmlServer queries", { concurrent: false }, () => {
  it.effect("fetches each key once per request and ships every settled entry, typed Failures included", () =>
    hosted(Effect.gen(function*() {
      const { Item, calls } = makeItems()
      const Page = Html.component({
        name: "Page",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) =>
          h.div(
            Item(h, { key: "a", props: { id: 1 } }),
            Item(h, { key: "b", props: { id: 1 } }),
            Item(h, { key: "c", props: { id: 404 } })
          )
      })
      const result = yield* ssr(Page, {})
      expect(result.html).toContain("<p>Item 1</p>")
      expect(result.html).toContain("<p>failed</p>")
      expect(result.state["~query"]).toEqual({
        GetItem: expect.arrayContaining([["{\"id\":1}", 0, "Item 1", 0], [
          "{\"id\":404}",
          1,
          ["missing"],
          0
        ]])
      })
      expect((result.state["~query"] as any).GetItem).toHaveLength(2)
      // The client adopts both entries without fetching, and each instance's hydrated results are on its Mounted.
      expect(calls).toEqual([1, 404])
      expect(result.root.fetches()).toEqual([])
      expect(result.log.filter((entry) => entry._tag === "QueryChanged"))
        .toEqual([])
      expect(result.log.some((entry) => entry._tag === "Update")).toBe(false)
      expect(result.container.textContent).toBe("Item 1Item 1failed")
    })))

  it.effect("runs rounds: an onChange message that changes the args fetches the next key", () =>
    hosted(Effect.gen(function*() {
      const { GetItem, show, calls } = makeItems()
      const Message = UiSchema.TaggedEnum({ Loaded: { ok: Schema.Boolean } })
      const Pager = Html.component({
        name: "Pager",
        model: Schema.Struct({ page: Schema.Number }),
        message: Message,
        queries: {
          item: {
            query: GetItem,
            args: ({ model }) => ({ id: model.page }),
            onChange: (result) =>
              Message.Loaded({ ok: AsyncResult.isSuccess(result) })
          }
        }
      }).make({
        init: () => ({ page: 1 }),
        update: ($, message) => ({
          page: message.ok && $.model.page < 3 ? $.model.page + 1 : $.model.page
        }),
        view: (h) => h.p(show(h.queries.item))
      }).pipe(Component.provide(GetItem.layer))
      const result = yield* ssr(Pager, {})
      expect(result.html).toContain("<p>Item 3</p>")
      expect(calls).toEqual([1, 2, 3])
      expect(
        (result.state["~query"] as any).GetItem.map((
          tuple: ReadonlyArray<unknown>
        ) => tuple[0])
      ).toEqual([
        "{\"id\":1}",
        "{\"id\":2}",
        "{\"id\":3}"
      ])
      expect(result.root.fetches()).toEqual([])
    })))

  it.effect("ships the k of N keys of a keyed field that settled in budget, and the client fetches the rest", () =>
    hosted(Effect.gen(function*() {
      const calls: Array<number> = []
      class GetSlowItem extends Query.Service<GetSlowItem>()(
        "GetSlowItem",
        {
          args: { id: Schema.Number },
          success: Schema.String,
          error: Schema.String,
          staleTime: "1 minute"
        }
      ) {
        static readonly layer = this.toLayer(({ id }) =>
          Effect.suspend(() => {
            calls.push(id)
            return id === 404
              ? Effect.fail("missing")
              : Effect.as(
                Effect.sleep(id === 3 ? "300 millis" : "0 millis"),
                `Item ${id}`
              )
          })
        )
      }
      const List = Html.component({
        name: "List",
        model: Schema.Struct({}),
        message: Schema.Never,
        queries: {
          items: {
            queryMany: GetSlowItem,
            args: () => [{ id: 1 }, { id: 404 }, { id: 3 }]
          }
        }
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) =>
          h.ul(
            h.queries.items.map(({ args, result }) =>
              h.li.key(String(args.id)).children(
                AsyncResult.isSuccess(result)
                  ? result.value
                  : AsyncResult.isFailure(result)
                  ? "failed"
                  : "loading"
              )
            )
          )
      }).pipe(Component.provide(GetSlowItem.layer))
      const result = yield* ssr(List, {}, { budget: "50 millis" })
      expect(result.html).toContain(
        "<li>Item 1</li><li>failed</li><li>loading</li>"
      )
      // The result is the settled keys' tuples; Successes reference `~query` and Failures stay inline.
      expect(result.state["/List"]).toEqual({
        model: {},
        queries: {
          items: [["{\"id\":1}", 2], ["{\"id\":404}", 1, [
            "missing"
          ], null]]
        }
      })
      expect((result.state["~query"] as any).GetSlowItem).toHaveLength(2)
      expect(result.misses).toEqual([{
        query: "GetSlowItem",
        logKey: "{\"id\":3}"
      }])
      // The client adopts the two settled keys and fetches only the third.
      expect(result.root.fetches().map((fetch) => fetch.logKey)).toEqual([
        "{\"id\":3}"
      ])
      yield* TestClock.adjust("300 millis")
      yield* TestHost.settle
      expect(result.container.textContent).toBe("Item 1failedItem 3")
      expect(calls).toEqual([1, 404, 3, 3])
    })))

  it.effect("fails ssr when an entry doesn't encode, and doesn't ship it", () =>
    hosted(Effect.gen(function*() {
      class GetCount extends Query.Service<GetCount>()("GetCount", {
        args: {},
        success: Schema.Number,
        error: Schema.Never,
        staleTime: "1 minute"
      }) {
        static readonly layer = this.toLayer(() =>
          Effect.succeed("x" as unknown as number)
        )
      }
      const Page = Html.component({
        name: "Page",
        model: Schema.Struct({}),
        message: Schema.Never,
        queries: { count: { query: GetCount, args: () => ({}) } }
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) => h.p("count")
      }).pipe(Component.provide(GetCount.layer))
      const error = yield* Effect.flip(ssr(Page, {}))
      expect(error.problems).toContainEqual(
        expect.stringMatching(/^EncodeFailed:/)
      )
      yield* TestHost.expectProblem("EncodeFailed")
    })))

  it.effect("fails ssr when the client fetches a hydrated entry inside the window, unless static", () =>
    Effect.gen(function*() {
      const { GetItem, Item, calls } = makeItems()
      class Store extends Context.Service<Store, string>()("test/Store") {}
      let builds = 0
      // Built at once on the server, and 10 millis later on the client.
      const Slow = Html.component({
        name: "Slow",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) => h.p("slow")
      }).pipe(Component.provide(Layer.effect(
        Store,
        Effect.suspend(() =>
          builds++ % 2 === 0
            ? Effect.succeed("ready")
            : Effect.as(Effect.sleep("10 millis"), "ready")
        )
      )))
      const Message = UiSchema.TaggedEnum({ Refreshed: {} })
      class Refresh extends Command.Service<Refresh>()("Refresh", {
        args: {},
        success: Message,
        error: Schema.Never,
        invalidates: () => [GetItem]
      }) {
        static readonly layer = this.toLayer(() =>
          Effect.succeed(Message.Refreshed())
        )
      }
      const Page = Html.component({
        name: "Page",
        model: Schema.Struct({}),
        message: Message
      }).make({
        // init's Command reruns on the client, and its invalidation refetches the hydrated entry while
        // the instance below still holds the window open.
        init: ($) => $.set({}).run(Refresh.make()),
        update: ($) => $.model,
        view: (h) =>
          h.div(
            Item(h, { key: "a", props: { id: 1 } }),
            Slow(h, { key: "s", props: {} })
          )
      }).pipe(Component.provide(Refresh.layer))
      yield* hosted(Effect.gen(function*() {
        const error = yield* Effect.flip(ssr(Page, {}))
        expect(error.problems).toEqual([
          "GetItem {\"id\":1}: fetched inside the fetch-free window (invalidation)"
        ])
      }))
      calls.length = 0
      yield* hosted(Effect.gen(function*() {
        const result = yield* ssr(Page, {}, { static: true })
        expect(result.state["~static"]).toBe(true)
        // Static HTML has no window, and its entry has an unknown age: stale, so it refetches once.
        expect(calls).toEqual([1, 1])
        expect(result.root.fetches().some((fetch) => fetch.inWindow)).toBe(
          false
        )
      }))
    }))

  it.effect("closes the window at the first navigation, before a waiting instance adopts", () =>
    Effect.gen(function*() {
      const { GetItem, Item, calls } = makeItems()
      class Store extends Context.Service<Store, string>()("test/Store") {}
      let builds = 0
      const Slow = Html.component({
        name: "Slow",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) => h.p("slow")
      }).pipe(Component.provide(Layer.effect(
        Store,
        Effect.suspend(() =>
          builds++ === 0
            ? Effect.succeed("ready")
            : Effect.as(Effect.sleep("10 millis"), "ready")
        )
      )))
      const Message = UiSchema.TaggedEnum({ Navigated: {}, Refreshed: {} })
      class Refresh extends Command.Service<Refresh>()("Refresh", {
        args: {},
        success: Message,
        error: Schema.Never,
        invalidates: () => [GetItem]
      }) {
        static readonly layer = this.toLayer(() =>
          Effect.succeed(Message.Refreshed())
        )
      }
      const Page = Html.component({
        name: "Page",
        model: Schema.Struct({}),
        message: Message
      }).make({
        // On the client, init navigates, and only then invalidates: the fetch lands after the window closed.
        init: ($) =>
          $.set({}).run(
            Router.push(AppRoute, Option.getOrThrow(AppRoute.parse("/slow")))
              .pipe(
                Command.map(() => Message.Navigated())
              )
          ),
        update: ($, message) =>
          message._tag === "Navigated" ? $.run(Refresh.make()) : $.model,
        view: (h) =>
          h.div(
            Item(h, { key: "a", props: { id: 1 } }),
            Slow(h, { key: "s", props: {} })
          )
      }).pipe(Component.provide(Refresh.layer))
      const { router } = yield* routed("/")
      yield* hosted(Effect.gen(function*() {
        const result = yield* ssr(Page, {}).pipe(Effect.provide(router))
        expect(
          result.root.fetches().map((fetch) => [fetch.trigger, fetch.inWindow])
        ).toEqual([["invalidation", false]])
        expect(calls).toEqual([1, 1])
      }))
    }))

  it.effect("runs a push's Router.prefetch after the navigation closes the fetch-free window", () =>
    Effect.gen(function*() {
      // Always stale: inside the window a prefetch leaves the hydrated entry alone, and after it, fetches it.
      class GetNow extends Query.Service<GetNow>()("GetNow", {
        args: { id: Schema.Number },
        success: Schema.String,
        error: Schema.Never,
        staleTime: 0
      }) {
        static readonly layer = this.toLayer(({ id }) =>
          Effect.succeed(`Now ${id}`)
        )
      }
      const Now = Html.component({
        name: "Now",
        props: Schema.Struct({ id: Schema.Number }),
        model: Schema.Struct({}),
        message: Schema.Never,
        queries: {
          now: { query: GetNow, args: ({ props }) => ({ id: props.id }) }
        }
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) => h.p("now")
      })
      // Holds the window open on the client: the instance waits 10 millis for its Layer.
      class Store extends Context.Service<Store, string>()("test/Store") {}
      let builds = 0
      const Slow = Html.component({
        name: "Slow",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) => h.p("slow")
      }).pipe(Component.provide(Layer.effect(
        Store,
        Effect.suspend(() =>
          builds++ === 0
            ? Effect.succeed("ready")
            : Effect.as(Effect.sleep("10 millis"), "ready")
        )
      )))
      const Message = UiSchema.TaggedEnum({ Navigated: {} })
      const Page = Html.component({
        name: "Page",
        model: Schema.Struct({}),
        message: Message
      }).make({
        // On the client, init navigates while the instance holds the window open.
        init: ($) =>
          $.set({}).run(
            Router.push(
              AppRoute,
              Option.getOrThrow(AppRoute.parse("/people/1"))
            ).pipe(
              Command.map(() => Message.Navigated())
            )
          ),
        update: ($) => $.model,
        subscriptions: () => [
          Router.prefetch(AppRoute, {
            Home: () => [],
            Person: ({ params }) => [Router.page(Now, { id: params.id })],
            Search: () => [],
            Slow: () => [],
            NotFound: () => []
          })
        ],
        // The mounted page is older than the push, so the check after it skips it.
        view: (h) =>
          h.div(
            Now(h, { key: "a", props: { id: 1 } }),
            Slow(h, { key: "s", props: {} })
          )
      }).pipe(Component.provide(GetNow.layer))
      const { router } = yield* routed("/")
      yield* hosted(Effect.gen(function*() {
        const result = yield* ssr(Page, {}).pipe(Effect.provide(router))
        expect(
          result.root.fetches().map((
            fetch
          ) => [fetch.logKey, fetch.trigger, fetch.inWindow])
        ).toEqual([
          ["{\"id\":1}", "prefetch", false]
        ])
      }))
    }))

  it.effect("allows a caller-only fetch inside the window: it stores nothing", () =>
    hosted(Effect.gen(function*() {
      const { GetItem, Item } = makeItems()
      class ReadBack extends Command.Service<ReadBack>()(
        "ReadBack",
        {
          args: {},
          success: Schema.Never,
          error: Schema.Never,
          invalidates: () => [GetItem]
        }
      ) {
        static readonly layer = this.toLayer(
          Effect.map(
            Effect.context<InstanceType<typeof GetItem>>(),
            (context) => () =>
              // Reads back its own invalidation target, then never ends, so the fetch stays caller-only.
              Effect.andThen(
                GetItem.get({ id: 1 }).pipe(
                  Effect.provide(context),
                  Effect.ignore
                ),
                Effect.never
              )
          )
        )
      }
      class Store extends Context.Service<Store, string>()("test/Store") {}
      let builds = 0
      const Slow = Html.component({
        name: "Slow",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) => h.p("slow")
      }).pipe(Component.provide(Layer.effect(
        Store,
        Effect.suspend(() =>
          builds++ === 0
            ? Effect.succeed("ready")
            : Effect.as(Effect.sleep("10 millis"), "ready")
        )
      )))
      const Page = Html.component({
        name: "Page",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: ($) => $.set({}).run(ReadBack.make()),
        update: ($) => $.model,
        view: (h) =>
          h.div(
            Item(h, { key: "a", props: { id: 1 } }),
            Slow(h, { key: "s", props: {} })
          )
      }).pipe(
        Component.provide(
          ReadBack.layer.pipe(Layer.provideMerge(GetItem.layer))
        )
      )
      const result = yield* ssr(Page, {})
      expect(
        result.root.fetches().map((fetch) => [fetch.stored, fetch.inWindow])
      ).toEqual([[false, true]])
    })))

  it.effect("spends the whole budget on the client before failing, for a sleep its clock didn't see", () =>
    hosted(Effect.gen(function*() {
      const clock = yield* Clock.Clock
      class Store extends Context.Service<Store, string>()("test/Store") {}
      let builds = 0
      const Panel = Html.component({
        name: "Panel",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) => h.p("panel")
      }).pipe(Component.provide(Layer.effect(
        Store,
        Effect.suspend(() =>
          builds++ === 0
            ? Effect.succeed("ready")
            : Effect.as(clock.sleep(Duration.millis(10)), "ready")
        )
      )))
      const Page = Html.component({
        name: "Page",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) => Panel(h, { key: "p", props: {} })
      })
      const result = yield* ssr(Page, {}, { budget: "100 millis" })
      expect(result.adopted).toEqual(["/Page", "/Page/Panel[p]"])
    })))

  it.effect("fails ssr naming the instances still waiting for their Layer when the budget is spent", () =>
    hosted(Effect.gen(function*() {
      class Store extends Context.Service<Store, string>()("test/Store") {}
      let builds = 0
      const Panel = Html.component({
        name: "Panel",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) => h.p("panel")
      }).pipe(
        Component.provide(Layer.effect(
          Store,
          Effect.suspend(() =>
            builds++ === 0 ? Effect.succeed("ready") : Effect.never
          )
        ))
      )
      const Page = Html.component({
        name: "Page",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) => h.div(Panel(h, { key: "p", props: {} }))
      })
      const error = yield* Effect.flip(ssr(Page, {}, { budget: "1 second" }))
      expect(error.problems).toEqual([
        "/Page/Panel[p]: still waiting for its Layer to adopt when the budget was spent"
      ])
    })))

  it.effect(
    "renders once for the fetches of one flush that end together",
    () =>
      Effect.gen(function*() {
        class GetText extends Query.Service<GetText>()(
          "GetText",
          {
            args: { id: Schema.Number },
            success: Schema.String,
            error: Schema.Never,
            staleTime: "30 seconds"
          }
        ) {
          static readonly layer = this.toLayer(({ id }) =>
            Effect.as(Effect.yieldNow, `text ${id}`)
          )
        }
        let renders = 0
        const Page = Html.component({
          name: "Page",
          model: Schema.Struct({}),
          message: Schema.Never,
          queries: {
            first: { query: GetText, args: () => ({ id: 1 }) },
            second: { query: GetText, args: () => ({ id: 2 }) },
            third: { query: GetText, args: () => ({ id: 3 }) }
          }
        }).make({
          init: () => ({}),
          update: ($) => $.model,
          view: (h) => {
            renders++
            const text = (result: AsyncResult.AsyncResult<string>) =>
              AsyncResult.isSuccess(result) ? result.value : "…"
            return h.p(
              `${text(h.queries.first)}, ${text(h.queries.second)}, ${
                text(h.queries.third)
              }`
            )
          }
        }).pipe(Component.provide(GetText.layer))
        const rendered = yield* HtmlServer.renderToHtml(Page, {})
        expect(rendered.html).toContain("<p>text 1, text 2, text 3</p>")
        expect(renders).toBe(2)
      })
  )

  it.effect(
    "ships, encodes and decodes a settled query result once across multiple readers",
    () =>
      Effect.gen(function*() {
        const payload = "unique-shared-note-payload"
        let fetches = 0
        let encodes = 0
        let decodes = 0
        const NoteBody = Schema.String.pipe(Schema.decode({
          decode: SchemaGetter.transform((body: string) => {
            decodes++
            return body
          }),
          encode: SchemaGetter.transform((body: string) => {
            encodes++
            return body
          })
        }))
        class GetNote extends Query.Service<GetNote>()("GetNote", {
          args: { id: Schema.String },
          success: NoteBody,
          error: Schema.Never,
          staleTime: "1 minute"
        }) {
          static readonly layer = this.toLayer(() =>
            Effect.sync(() => {
              fetches++
              return payload
            })
          )
        }
        const Reader = Html.component({
          name: "Reader",
          model: Schema.Struct({}),
          message: Schema.Never,
          queries: {
            note: { query: GetNote, args: () => ({ id: "1" }) }
          }
        }).make({
          init: () => ({}),
          update: ($) => $.model,
          view: (h) =>
            h.p(
              AsyncResult.isSuccess(h.queries.note)
                ? h.queries.note.value
                : "loading"
            )
        })
        const Page = Html.component({
          name: "Page",
          model: Schema.Struct({}),
          message: Schema.Never
        }).make({
          init: () => ({}),
          update: ($) => $.model,
          view: (h) =>
            h.div(
              Reader(h, { key: "a", props: {} }),
              Reader(h, { key: "b", props: {} })
            )
        }).pipe(Component.provide(GetNote.layer))

        const rendered = yield* HtmlServer.renderToHtml(Page, {})
        const serialized = HtmlServer.serializeState(rendered.state)
        const copies = serialized.split(payload).length - 1
        const app = yield* container(rendered.html)
        const served = [...app.querySelectorAll("p")]
        const root = yield* HtmlHydrate.hydrateEffect(
          Page,
          {},
          app,
          JSON.parse(serialized)
        )
        yield* root.adopted

        const adopted = [...app.querySelectorAll("p")]
        expect(adopted).toHaveLength(2)
        expect(adopted[0]).toBe(served[0])
        expect(adopted[1]).toBe(served[1])
        expect(adopted.map((node) => node.textContent)).toEqual([
          payload,
          payload
        ])
        expect(fetches).toBe(1)
        expect({ copies, encodes, decodes }).toEqual({
          copies: 1,
          encodes: 1,
          decodes: 1
        })
      }).pipe(Effect.scoped)
  )

  it.effect(
    "adopts readers once when a query's success decoder is async, sharing cache-first decodes and cancelling unjoined ones",
    () =>
      Effect.gen(function*() {
        let gate: Effect.Effect<void> = Effect.void
        let orphanCancelled = false
        const decodes: Record<string, number> = {}
        const AsyncBody = Schema.String.pipe(Schema.decode({
          decode: SchemaGetter.transformEffect((body: string) =>
            Effect.suspend(() => {
              decodes[body] = (decodes[body] ?? 0) + 1
              if (body === "note-1") return Effect.succeed(body)
              if (body === "orphan") {
                return Effect.onInterrupt(
                  Effect.never,
                  () =>
                    Effect.sync(() => {
                      orphanCancelled = true
                    })
                )
              }
              return Effect.as(gate, body)
            })
          ),
          encode: SchemaGetter.transform((body: string) => body)
        }))
        class GetAsyncNote extends Query.Service<GetAsyncNote>()(
          "GetAsyncNote",
          {
            args: { id: Schema.String },
            success: AsyncBody,
            error: Schema.Never,
            staleTime: "1 minute"
          }
        ) {
          static readonly layer = this.toLayer(({ id }) =>
            Effect.succeed(`note-${id}`)
          )
        }
        const Reader = Html.component({
          name: "Reader",
          props: Schema.Struct({ id: Schema.String }),
          model: Schema.Struct({}),
          message: Schema.Never,
          queries: {
            note: {
              query: GetAsyncNote,
              args: ({ props }) => ({ id: props.id })
            }
          }
        }).make({
          init: () => ({}),
          update: ($) => $.model,
          view: (h) =>
            h.p(
              AsyncResult.isSuccess(h.queries.note)
                ? h.queries.note.value
                : "loading"
            )
        })
        const Page = Html.component({
          name: "Page",
          model: Schema.Struct({}),
          message: Schema.Never
        }).make({
          init: () => ({}),
          update: ($) => $.model,
          view: (h) =>
            h.div(
              Reader(h, { key: "a", props: { id: "1" } }),
              Reader(h, { key: "b", props: { id: "2" } })
            )
        }).pipe(Component.provide(GetAsyncNote.layer))

        const rendered = yield* HtmlServer.renderToHtml(Page, {})
        const serialized = HtmlServer.serializeState(rendered.state)
        expect(serialized.split("note-1").length - 1).toBe(1)
        expect(serialized.split("note-2").length - 1).toBe(1)

        const parsed = JSON.parse(serialized)
        parsed["~query"].GetAsyncNote.push(["{\"id\":\"3\"}", 0, "orphan", 0])

        const latch = yield* Deferred.make<void>()
        gate = Deferred.await(latch)
        const app = yield* container(rendered.html)
        const served = [...app.querySelectorAll("p")]
        const root = yield* HtmlHydrate.hydrateEffect(
          Page,
          {},
          app,
          parsed
        ).pipe(Effect.provideService(Query.Problems, () => {}))
        yield* Deferred.succeed(latch, undefined)
        yield* root.adopted
        yield* tick

        const adopted = [...app.querySelectorAll("p")]
        expect(adopted).toHaveLength(2)
        expect(adopted[0]).toBe(served[0])
        expect(adopted[1]).toBe(served[1])
        expect(adopted.map((node) => node.textContent)).toEqual([
          "note-1",
          "note-2"
        ])
        expect(decodes).toEqual({ "note-1": 1, "note-2": 1, orphan: 1 })
        expect(orphanCancelled).toBe(true)
      }).pipe(Effect.scoped)
  )

  it.effect(
    "scopes the ~query decode memo to each hydration execution",
    () =>
      Effect.gen(function*() {
        class GetDate extends Query.Service<GetDate>()("GetDate", {
          args: {},
          success: Schema.Date,
          error: Schema.Never,
          staleTime: "1 minute"
        }) {
          static readonly layer = this.toLayer(() =>
            Effect.succeed(new Date("2026-01-02T00:00:00.000Z"))
          )
        }
        const seen: Array<Date> = []
        const Page = Html.component({
          name: "Page",
          model: Schema.Struct({}),
          message: Schema.Never,
          queries: { when: { query: GetDate, args: () => ({}) } }
        }).make({
          init: () => ({}),
          update: ($) => $.model,
          view: (h) => {
            if (!AsyncResult.isSuccess(h.queries.when)) return h.p("loading")
            seen.push(h.queries.when.value)
            return h.p(String(h.queries.when.value.getUTCFullYear()))
          }
        }).pipe(Component.provide(GetDate.layer))

        const rendered = yield* HtmlServer.renderToHtml(Page, {})
        const parsed = JSON.parse(HtmlServer.serializeState(rendered.state))
        const app = yield* container(rendered.html)
        const mount = HtmlHydrate.hydrateEffect(Page, {}, app, parsed)

        seen.length = 0
        yield* Effect.scoped(Effect.flatMap(mount, (root) => root.adopted))
        seen[0]!.setUTCFullYear(1999)

        // Re-executing the same hydration Effect decodes the wire value afresh.
        app.innerHTML = rendered.html
        seen.length = 0
        yield* Effect.scoped(Effect.flatMap(mount, (root) => root.adopted))
        expect(seen[0]!.getUTCFullYear()).toBe(2026)
      }).pipe(Effect.scoped)
  )
})
