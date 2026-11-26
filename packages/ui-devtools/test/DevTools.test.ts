// @vitest-environment happy-dom
import { Command, Component, Feature, MessageLog, UiSchema } from "@effect/ui"
import { DevTools } from "@effect/ui-devtools"
import { BrowserHost, Html } from "@effect/ui/html"
import { HtmlLocator } from "@effect/ui/html/testing"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Schema, Scope } from "effect"
import { type Capture, play } from "./fixtures/TwoEditors.ts"

const wait = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))
const settle = wait(10)
const token = "tok_live_9f2c"

const text = (node: Element | null | undefined) =>
  (node?.textContent ?? "").replace(/\s+/g, " ").trim()

const overlay = () =>
  document.querySelector<HTMLIFrameElement>("iframe[data-effect-ui-devtools]")!
    .contentDocument!.body

const mount = Effect.fnUntraced(function*(capture: Capture, size?: number) {
  localStorage.clear()
  const memory = MessageLog.makeMemory({ size: 500 })
  const services = yield* Layer.build(
    MessageLog.fanout([
      size === undefined ? DevTools.layer() : DevTools.layer({ size }),
      Layer.succeed(MessageLog.MessageLog, memory)
    ])
  )
  const app = yield* play(capture).pipe(Effect.provide(services))
  yield* settle
  return { app, memory, root: overlay(), services }
})

const sized = (root: HTMLElement) => {
  const view = root.ownerDocument.defaultView!
  const prototype = view.HTMLElement.prototype
  const clientHeight =
    Object.getOwnPropertyDescriptor(prototype, "clientHeight") ??
      Object.getOwnPropertyDescriptor(view.Element.prototype, "clientHeight")
  const rect = view.Element.prototype.getBoundingClientRect
  const timeline = (element: Element) =>
    element.matches(".timeline, .timeline > .rows")
  Object.defineProperty(prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return timeline(this) ? 2000 : clientHeight?.get?.call(this) ?? 0
    }
  })
  view.Element.prototype.getBoundingClientRect = function(this: Element) {
    return timeline(this) ? new view.DOMRect(0, 0, 340, 2000) : rect.call(this)
  }
}

const open = Effect.fnUntraced(function*(root: HTMLElement) {
  sized(root)
  HtmlLocator.click(
    HtmlLocator.getByRole(root, "button", {
      name: "Open the Effect UI inspector"
    })
  )
  for (
    let tries = 0;
    tries < 50 && root.querySelectorAll(".row").length <= 4;
    tries++
  ) yield* settle
})

const click = Effect.fnUntraced(function*(element: Element) {
  HtmlLocator.click(element)
  yield* settle
})

const instance = (root: HTMLElement, name: string) =>
  root.querySelector(`[data-instance="${name}"]`)!

const status = (root: HTMLElement, name: string) =>
  text(instance(root, name).querySelector(".status")!)

const find = Effect.fnUntraced(function*(root: HTMLElement, value: string) {
  HtmlLocator.type(
    HtmlLocator.getByRole(root, "searchbox", { name: "Find an instance" }),
    value
  )
  yield* settle
})

const entry = (root: HTMLElement, name: RegExp) => {
  const found = HtmlLocator.queryAllByRole(root, "button", { name }).filter((
    node
  ) => node.classList.contains("row-button"))
  assert.isAbove(found.length, 0, "no timeline entry named " + name)
  return found
}

const oldest = (root: HTMLElement, name: RegExp) => entry(root, name).at(-1)!

const steps = (root: HTMLElement) =>
  Array.from(root.querySelectorAll(".chain .step")).map((step) => ({
    step,
    kind: step.getAttribute("data-step")! +
      (step.hasAttribute("data-index")
        ? " " + step.getAttribute("data-index")
        : ""),
    what: text(step.querySelector(".what")),
    args: text(step.querySelector(".args"))
  }))

const step = (root: HTMLElement, kind: string, what?: RegExp) => {
  const found = steps(root).find((step) =>
    step.kind === kind && (what === undefined || what.test(step.what))
  )
  assert.isDefined(
    found,
    "no chain step " + kind + " in " +
      JSON.stringify(steps(root).map((step) => step.kind + ": " + step.what))
  )
  return found!
}

const headline = (root: HTMLElement) =>
  text(root.querySelector(".ehead .headline"))
const subtitle = (root: HTMLElement) => text(root.querySelector(".ehead .sub"))

const follow = (root: HTMLElement, kind: string, selector = "button.ref") =>
  click(step(root, kind).step.querySelector(selector)!)

const tab = (root: HTMLElement, name: RegExp) =>
  click(HtmlLocator.getByRole(root, "tab", { name }))

const selectClickedSave = Effect.fnUntraced(
  function*(root: HTMLElement, pick = oldest) {
    yield* click(instance(root, "Editor[n2]"))
    yield* click(pick(root, /Update ClickedSave$/))
  }
)

const commonChecks = Effect.fnUntraced(function*(root: HTMLElement) {
  const changed = root.querySelectorAll(".tree .tl[data-change=changed]")
  assert.strictEqual(changed.length, 1)
  assert.strictEqual(changed[0].querySelector(".k")?.textContent, "status")
  assert.strictEqual(changed[0].querySelector("del")?.textContent, "\"Dirty\"")
  assert.strictEqual(changed[0].querySelector("ins")?.textContent, "\"Saving\"")
  assert.include(
    text(HtmlLocator.getByRole(root, "tab", { name: /Model/ })),
    "1 change"
  )

  yield* tab(root, /Raw/)
  const copied: Array<string> = []
  Object.defineProperty(
    root.ownerDocument.defaultView!.navigator,
    "clipboard",
    {
      configurable: true,
      value: {
        writeText: (value: string) => Promise.resolve(void copied.push(value))
      }
    }
  )
  yield* click(HtmlLocator.getByRole(root, "button", { name: "Copy frame" }))
  assert.strictEqual(copied.length, 1)
  assert.include(copied[0], "\"~redacted\": true")
  assert.notInclude(copied[0], token)
  assert.include(text(root.querySelector(".raw")), "\"~redacted\": true")
  assert.notInclude(root.textContent, token)
  yield* tab(root, /Model/)
})

const lifecycle = (root: HTMLElement, kind: string) =>
  Array.from(root.querySelectorAll(`.life tr[data-kind=${kind}] > *`)).map((
    cell
  ) => text(cell))

const PairMessage = UiSchema.TaggedEnum({ ClickedAdd: {} })

class Slot
  extends Feature.Service<Slot>()("test/Slot", { props: Schema.Struct({}) })
{}

const SlotView = Html.component({
  name: "SlotView",
  model: Schema.Null,
  message: Schema.Never
}).make({
  init: () => null,
  update: ($) => $.model,
  view: (h) => h.strong("ready")
})

const Shown = Html.component({
  name: "Shown",
  props: Schema.Struct({ n: Schema.Number }),
  model: Schema.Null,
  message: Schema.Never
}).make({
  init: () => null,
  update: ($) => $.model,
  view: (h) => h.span.children(String(h.props.n))
})

const Pair = Html.component({
  name: "Pair",
  model: Schema.Struct({ n: Schema.Number }),
  message: PairMessage
}).make({
  init: () => ({ n: 0 }),
  update: { ClickedAdd: ($) => $.evolve({ n: $.model.n + 1 }) },
  view: (h, model) =>
    h.div(
      h.button.on("click", PairMessage.ClickedAdd()).children("Add"),
      Slot.render(h, { key: "s", props: {}, fallback: () => h.em("fallback") }),
      Shown(h, { key: "a", props: { n: model.n } }),
      Shown(h, { key: "b", props: { n: model.n } })
    )
}).pipe(Component.provide(Slot.toLayer(SlotView)))

describe("DevTools overlay", { concurrent: false }, () => {
  afterEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it.live("aligns exclusion across encodeKeys, disables paint on excluded links, and keeps evicted baselines", () =>
    Effect.gen(function*() {
      const EncodedMessage = Schema.Union([
        Schema.Struct({ _tag: Schema.Literal("Move") }).pipe(
          Schema.encodeKeys({ _tag: "kind" })
        ),
        Schema.Struct({ _tag: Schema.Literal("Commit") }).pipe(
          Schema.encodeKeys({ _tag: "kind" })
        )
      ])
      const Encoded = Html.component({
        name: "Encoded",
        model: Schema.Struct({ x: Schema.Number, c: Schema.Number }),
        message: EncodedMessage
      }).make({
        init: () => ({ x: 0, c: 0 }),
        update: {
          Move: ($) => $.evolve({ x: $.model.x + 1 }),
          Commit: ($) => $.evolve({ c: $.model.c + 1 })
        },
        view: (h, model) =>
          h.div(
            h.output.children(`${model.x}:${model.c}`),
            h.button.on("click", { _tag: "Move" }).children("Move"),
            h.button.on("click", { _tag: "Commit" }).children("Commit")
          )
      })
      yield* Effect.scoped(Effect.gen(function*() {
        const app = document.body.appendChild(document.createElement("div"))
        yield* Effect.addFinalizer(() => Effect.sync(() => app.remove()))
        yield* Layer.build(DevTools.layer({ exclude: ["Move"] })).pipe(
          Effect.flatMap((services) =>
            BrowserHost.mountEffect(Encoded, {}, app).pipe(
              Effect.provide(services)
            )
          )
        )
        yield* settle
        const root = overlay()
        yield* open(root)
        const move = HtmlLocator.getByRole(app, "button", { name: "Move" })
        const commit = HtmlLocator.getByRole(app, "button", { name: "Commit" })
        yield* click(move)
        yield* click(move)
        assert.strictEqual(root.querySelectorAll(".row").length, 1)
        yield* click(commit)
        assert.strictEqual(root.querySelectorAll(".row").length, 2)
        const clear = () =>
          HtmlLocator.getByRole(root, "button", {
            name: "Clear"
          }) as HTMLButtonElement
        yield* click(oldest(root, /Mounted$/))
        yield* click(
          HtmlLocator.getByRole(root, "button", { name: "Time travel" })
        )
        assert.strictEqual(
          app.nextElementSibling?.querySelector("output")?.textContent,
          "0:0"
        )
        assert.isTrue(clear().disabled)
        yield* click(root.querySelector(".row-button")!)
        assert.strictEqual(
          app.nextElementSibling?.querySelector("output")?.textContent,
          "2:1"
        )
        yield* click(
          HtmlLocator.getByRole(root, "button", {
            name: "Resume the live page"
          })
        )
        assert.isFalse(clear().disabled)
      }))
      localStorage.clear()

      const PairMoveMessage = UiSchema.TaggedEnum({ Move: {}, Commit: {} })
      const Peer = Html.component({
        name: "Peer",
        props: Schema.Struct({ label: Schema.String }),
        model: Schema.Struct({ v: Schema.Number }),
        message: PairMoveMessage
      }).make({
        init: () => ({ v: 0 }),
        update: {
          Move: ($) => $.evolve({ v: $.model.v + 1 }),
          Commit: ($) => $.evolve({ v: $.model.v + 10 })
        },
        view: (h, model) =>
          h.div(
            h.output.attr("data-peer", h.props.label).children(String(model.v)),
            h.button.on("click", PairMoveMessage.Move()).children(
              "Move " + h.props.label
            ),
            h.button.on("click", PairMoveMessage.Commit()).children(
              "Commit " + h.props.label
            )
          )
      })
      const Two = Html.component({
        name: "Two",
        model: Schema.Null,
        message: Schema.Never
      }).make({
        init: () => null,
        update: ($) => $.model,
        view: (h) =>
          h.main(
            Peer(h, { key: "a", props: { label: "A" } }),
            Peer(h, { key: "b", props: { label: "B" } })
          )
      })
      yield* Effect.scoped(Effect.gen(function*() {
        const app = document.body.appendChild(document.createElement("div"))
        yield* Effect.addFinalizer(() => Effect.sync(() => app.remove()))
        yield* Layer.build(DevTools.layer({ size: 2, exclude: ["Move"] })).pipe(
          Effect.flatMap((services) =>
            BrowserHost.mountEffect(Two, {}, app).pipe(Effect.provide(services))
          )
        )
        yield* settle
        const root = overlay()
        yield* open(root)
        const moveA = HtmlLocator.getByRole(app, "button", { name: "Move A" })
        const moveB = HtmlLocator.getByRole(app, "button", { name: "Move B" })
        const commitA = HtmlLocator.getByRole(app, "button", {
          name: "Commit A"
        })
        const commitB = HtmlLocator.getByRole(app, "button", {
          name: "Commit B"
        })

        yield* click(moveA)
        yield* click(moveB)
        yield* click(moveA)
        yield* click(commitB)
        const prevLink = root.querySelector(".pane.model .note button.ref")!
        assert.isNotNull(prevLink)
        yield* click(prevLink)
        assert.strictEqual(headline(root), "Move")
        const travel = HtmlLocator.getByRole(root, "button", {
          name: "Time travel"
        }) as HTMLButtonElement
        assert.isTrue(travel.disabled)

        yield* click(commitB)
        yield* click(commitB)
        yield* click(HtmlLocator.getByRole(root, "button", { name: "Clear" }))
        assert.strictEqual(root.querySelectorAll(".row").length, 0)
        yield* find(root, "peer")
        assert.isNotNull(instance(root, "Peer[a]"))
        assert.isNotNull(instance(root, "Peer[b]"))
        yield* find(root, "")
        yield* click(commitA)
        const changed = root.querySelectorAll(".tree .tl[data-change=changed]")
        assert.strictEqual(changed.length, 1)
        assert.strictEqual(changed[0].querySelector(".k")?.textContent, "v")
        assert.strictEqual(changed[0].querySelector("del")?.textContent, "2")
        assert.strictEqual(changed[0].querySelector("ins")?.textContent, "12")
        yield* click(
          HtmlLocator.getByRole(root, "button", { name: "Time travel" })
        )
        assert.strictEqual(
          app.nextElementSibling?.querySelector("[data-peer=A]")?.textContent,
          "12"
        )
        assert.strictEqual(
          app.nextElementSibling?.querySelector("[data-peer=B]")?.textContent,
          "31"
        )
        yield* click(
          HtmlLocator.getByRole(root, "button", {
            name: "Resume the live page"
          })
        )
      }))
    }))

  it.live("stops and starts recording a tag from the overlay, so a tick burst keeps the click, and remembers it for the tab", () =>
    Effect.gen(function*() {
      const ClockMessage = UiSchema.TaggedEnum({ Ticked: {}, Clicked: {} })
      const Clock = Html.component({
        name: "Clock",
        model: Schema.Struct({ ticks: Schema.Number, clicks: Schema.Number }),
        message: ClockMessage
      }).make({
        init: () => ({ ticks: 0, clicks: 0 }),
        update: {
          Ticked: ($) => $.evolve({ ticks: $.model.ticks + 1 }),
          Clicked: ($) => $.evolve({ clicks: $.model.clicks + 1 })
        },
        view: (h) =>
          h.div(
            h.button.on("click", ClockMessage.Ticked()).children("Tick"),
            h.button.on("click", ClockMessage.Clicked()).children("Click")
          )
      })
      const updates = (root: HTMLElement, tag: string) =>
        HtmlLocator.queryAllByRole(root, "button", {
          name: new RegExp("Update " + tag + "$")
        }).filter((node) => node.classList.contains("row-button"))
      const session = (exclude: ReadonlyArray<string>) =>
        Effect.gen(function*() {
          localStorage.clear()
          const app = document.body.appendChild(document.createElement("div"))
          yield* Effect.addFinalizer(() => Effect.sync(() => app.remove()))
          yield* Layer.build(DevTools.layer({ size: 3, exclude })).pipe(
            Effect.flatMap((services) =>
              BrowserHost.mountEffect(Clock, {}, app).pipe(
                Effect.provide(services)
              )
            )
          )
          yield* settle
          const root = overlay()
          yield* open(root)
          const tick = HtmlLocator.getByRole(app, "button", { name: "Tick" })
          const ticks = Effect.fnUntraced(function*(count: number) {
            for (let n = 0; n < count; n++) yield* click(tick)
          })
          return { app, root, ticks }
        })

      yield* Effect.scoped(Effect.gen(function*() {
        const { app, root, ticks } = yield* session(["Ticked"])
        yield* ticks(2)
        assert.lengthOf(updates(root, "Ticked"), 0)
        yield* click(
          HtmlLocator.getByRole(root, "button", {
            name: "Start recording Ticked"
          })
        )
        yield* ticks(1)
        assert.lengthOf(updates(root, "Ticked"), 1)

        yield* click(updates(root, "Ticked")[0]!)
        yield* click(
          HtmlLocator.getByRole(root, "button", {
            name: "Stop recording Ticked"
          })
        )
        yield* click(HtmlLocator.getByRole(app, "button", { name: "Click" }))
        yield* ticks(5)
        assert.lengthOf(updates(root, "Clicked"), 1)
        assert.lengthOf(updates(root, "Ticked"), 1)
      }))

      // A reload in the same tab keeps the runtime choice over the config.
      yield* Effect.scoped(Effect.gen(function*() {
        const { root, ticks } = yield* session([])
        yield* ticks(2)
        assert.lengthOf(updates(root, "Ticked"), 0)
        assert.isDefined(
          HtmlLocator.getByRole(root, "button", {
            name: "Start recording Ticked"
          })
        )
      }))
    }))

  it.live("shows the page at an earlier entry beside the live tree, and Resume brings the live tree back", () =>
    Effect.gen(function*() {
      const { app, root } = yield* mount("closed")
      yield* open(root)
      const copy = () =>
        app.nextElementSibling?.hasAttribute("inert") === true
          ? app.nextElementSibling
          : null
      const show = () =>
        HtmlLocator.getByRole(root, "button", { name: "Time travel" })

      yield* selectClickedSave(root)
      yield* click(show())
      assert.strictEqual(show().getAttribute("aria-pressed"), "true")
      assert.match(
        text(root.querySelector(".paused-label")),
        /^Paused at #\d+$/
      )
      assert.match(text(root.querySelector(".scrub")), /^Time travel\s*#\d+$/)
      assert.strictEqual(app.style.getPropertyValue("display"), "none")
      assert.strictEqual(
        Array.from(copy()!.querySelectorAll("p")).map((status) =>
          status.textContent
        ).join(),
        "Saving,Saving"
      )
      assert.lengthOf(
        HtmlLocator.queryAllByRole(copy() as HTMLElement, "button", {
          name: "Close n2"
        }),
        1
      )
      assert.lengthOf(
        HtmlLocator.queryAllByRole(app, "button", { name: "Close n2" }),
        0
      )
      const note = root.querySelector(".pause-note")!
      assert.include(text(note.querySelector("summary")), "mount")
      assert.deepStrictEqual(
        Array.from(note.querySelectorAll("li"), (node) => text(node)),
        ["/Workspace/Editor[n1]", "/Workspace/Editor[n2]"]
      )

      yield* click(oldest(root, /Update UpdatedDraft$/))
      assert.strictEqual(document.querySelectorAll("[inert]").length, 1)
      assert.strictEqual(
        Array.from(copy()!.querySelectorAll("p")).map((status) =>
          status.textContent
        ).join(),
        "Saving,Dirty"
      )

      yield* click(
        HtmlLocator.getByRole(root, "button", { name: "Resume the live page" })
      )
      assert.isNull(copy())
      assert.isNull(root.querySelector(".paused"))
      assert.strictEqual(app.style.getPropertyValue("display"), "")
    }))

  it.live("keeps the panel on the paused root, and drops the pause when that root unmounts", () =>
    Effect.gen(function*() {
      const { app, root, services } = yield* mount("closed")
      yield* open(root)
      const inert = () => document.querySelectorAll("[inert]").length
      yield* selectClickedSave(root)
      yield* click(
        HtmlLocator.getByRole(root, "button", { name: "Time travel" })
      )
      assert.strictEqual(app.style.getPropertyValue("display"), "none")

      const scope = yield* Scope.make()
      const other = yield* play("closed").pipe(
        Effect.provide(services),
        Scope.provide(scope)
      )
      yield* settle
      yield* click(oldest(root, /Update UpdatedDraft$/))
      assert.strictEqual(app.style.getPropertyValue("display"), "none")
      assert.strictEqual(other.style.getPropertyValue("display"), "")
      assert.strictEqual(inert(), 1)

      yield* click(
        HtmlLocator.getByRole(root, "button", { name: "Resume the live page" })
      )
      assert.strictEqual(app.style.getPropertyValue("display"), "")
      assert.strictEqual(inert(), 0)

      yield* click(oldest(root, /Update UpdatedDraft$/))
      yield* click(
        HtmlLocator.getByRole(root, "button", { name: "Time travel" })
      )
      assert.strictEqual(other.style.getPropertyValue("display"), "none")
      assert.strictEqual(app.style.getPropertyValue("display"), "")
      assert.strictEqual(inert(), 1)
      yield* Scope.close(scope, Exit.void)
      yield* settle
      assert.strictEqual(inert(), 0)
      assert.isNull(root.querySelector(".paused"))
    }))

  it.live("paints each instance's props past the buffer and notes feature slot fallbacks", () =>
    Effect.gen(function*() {
      const memory = MessageLog.makeMemory({ size: 500 })
      const services = yield* Layer.build(
        MessageLog.fanout([
          DevTools.layer({ size: 2 }),
          Layer.succeed(MessageLog.MessageLog, memory)
        ])
      )
      const app = document.body.appendChild(document.createElement("div"))
      yield* Effect.addFinalizer(() => Effect.sync(() => app.remove()))
      yield* BrowserHost.mountEffect(Pair, {}, app).pipe(
        Effect.provide(services)
      )
      yield* settle
      yield* click(HtmlLocator.getByRole(app, "button", { name: "Add" }))
      const changed = memory.entries().filter((entry) =>
        entry._tag === "PropsChanged"
      )
      assert.deepStrictEqual(changed.map((entry) => entry.path), [
        "/Pair/Shown[a]",
        "/Pair/Shown[b]"
      ])
      assert.strictEqual(memory.entries().at(-1), changed[1])

      const root = overlay()
      sized(root)
      yield* click(
        HtmlLocator.getByRole(root, "button", {
          name: "Open the Effect UI inspector"
        })
      )
      yield* click(
        HtmlLocator.getByRole(root, "button", { name: "Everything" })
      )
      yield* click(entry(root, new RegExp("^#" + changed[0].seq + " "))[0]!)
      yield* click(
        HtmlLocator.getByRole(root, "button", { name: "Time travel" })
      )
      const copy = app.nextElementSibling!
      assert.isTrue(copy.hasAttribute("inert"))
      assert.strictEqual(
        Array.from(copy.querySelectorAll("span"), (node) => node.textContent)
          .join(),
        "1,0"
      )
      assert.strictEqual(
        Array.from(app.querySelectorAll("span"), (node) => node.textContent)
          .join(),
        "1,1"
      )
      assert.strictEqual(copy.querySelector("em")?.textContent, "fallback")
      assert.strictEqual(app.querySelector("strong")?.textContent, "ready")
      const notes = Array.from(
        root.querySelectorAll<HTMLDetailsElement>("details.pause-note")
      )
      assert.strictEqual(notes.length, 1)
      assert.isFalse(notes[0].open)
      assert.include(text(notes[0].querySelector("summary")), "fallback")
      assert.deepStrictEqual(
        Array.from(notes[0].querySelectorAll("li"), (node) => text(node)),
        ["/Pair"]
      )
    }))

  it.live("uses same-cause mount state without borrowing past a superseding parent update", () =>
    Effect.gen(function*() {
      let inits = 0
      const Row = Html.component({
        name: "Row",
        props: Schema.Struct({ n: Schema.Number }),
        model: Schema.Number,
        message: Schema.Never
      }).make({
        init: () => ++inits,
        update: ($) => $.model,
        view: (h, init) => h.li.children(`${h.props.n}:${init}`)
      })
      const TriggerMessage = UiSchema.TaggedEnum({ Clicked: {} })
      const TriggerEvents = UiSchema.TaggedEnum({ Set: { n: Schema.Number } })
      const Trigger = Html.component({
        name: "Trigger",
        model: Schema.Null,
        message: TriggerMessage,
        events: TriggerEvents
      }).make({
        init: () => null,
        update: {
          Clicked: ($) =>
            $.set(null).emit(TriggerEvents.Set({ n: 2 })).emit(
              TriggerEvents.Set({ n: 3 })
            )
        },
        view: (h) =>
          h.button.on("click", TriggerMessage.Clicked()).children("Go")
      })
      const ListMessage = UiSchema.TaggedEnum({ Set: { n: Schema.Number } })
      const List = Html.component({
        name: "List",
        model: Schema.Number,
        message: ListMessage
      }).make({
        init: () => 0,
        update: { Set: (_, { n }) => n },
        view: (h, n) =>
          h.div(
            h.button.on("click", ListMessage.Set({ n: 1 })).children("One"),
            Trigger(h, {
              key: "t",
              onEmit: { Set: ({ n }) => ListMessage.Set({ n }) }
            }),
            h.ul(
              Row(h, { key: "a", props: { n: 0 } }),
              Row(h, { key: "b", props: { n: 0 } }),
              n >= 1 ? Row(h, { key: "one", props: { n: 1 } }) : null,
              n >= 2 ? Row(h, { key: "two", props: { n } }) : null
            )
          )
      })
      const memory = MessageLog.makeMemory({ size: 500 })
      const services = yield* Layer.build(
        MessageLog.fanout([
          DevTools.layer(),
          Layer.succeed(MessageLog.MessageLog, memory)
        ])
      )
      const app = document.body.appendChild(document.createElement("div"))
      yield* Effect.addFinalizer(() => Effect.sync(() => app.remove()))
      yield* BrowserHost.mountEffect(List, {}, app).pipe(
        Effect.provide(services)
      )
      yield* settle
      yield* click(HtmlLocator.getByRole(app, "button", { name: "One" }))
      yield* click(HtmlLocator.getByRole(app, "button", { name: "Go" }))

      const rowA = memory.entries().find((entry) =>
        entry._tag === "Mounted" && entry.path === "/List/Row[a]"
      )!
      const [one, first, second] = memory.entries().filter((entry) =>
        entry._tag === "Update" && entry.path === "/List"
      )
      const root = overlay()
      yield* open(root)
      yield* click(
        HtmlLocator.getByRole(root, "button", { name: "Everything" })
      )
      const items = () =>
        Array.from(
          app.nextElementSibling!.querySelectorAll("li"),
          (node) => node.textContent
        )
      const select = (seq: number) =>
        click(entry(root, new RegExp("^#" + seq + " "))[0]!)

      yield* select(rowA.seq)
      yield* click(
        HtmlLocator.getByRole(root, "button", { name: "Time travel" })
      )
      assert.isNull(root.querySelector(".pause-note"))
      assert.deepStrictEqual(items(), ["0:1", "0:2"])

      yield* select(one.seq)
      assert.isNull(root.querySelector(".pause-note"))
      assert.deepStrictEqual(items(), ["0:1", "0:2", "1:3"])

      yield* select(first.seq)
      assert.deepStrictEqual(items(), ["0:1", "0:2", "1:3", "2:5"])
      const note = root.querySelector<HTMLDetailsElement>("details.pause-note")!
      assert.isNotNull(note)
      assert.isFalse(note.open)
      assert.include(
        text(note.querySelector("summary")),
        "1 instance shown from init"
      )
      assert.deepStrictEqual(
        Array.from(note.querySelectorAll("li"), (node) => text(node)),
        ["/List/Row[two]"]
      )

      yield* select(second.seq)
      assert.isNull(root.querySelector(".pause-note"))
      assert.deepStrictEqual(items(), ["0:1", "0:2", "1:3", "3:4"])
    }))

  it.live("finds Editor[n2]'s Save, follows it to its interruption and back", () =>
    Effect.gen(function*() {
      const { memory, root } = yield* mount("interrupted")
      yield* open(root)

      assert.strictEqual(status(root, "Editor[n1]"), "1 ended")
      assert.strictEqual(status(root, "Editor[n2]"), "1 interrupted, unmounted")
      assert.isNotNull(
        instance(root, "Editor[n2]").querySelector(".status .tone-bad")
      )
      assert.isNull(
        instance(root, "Editor[n1]").querySelector(".status .tone-bad")
      )

      const rows = () =>
        Array.from(root.querySelectorAll(".row")).map((row) =>
          row.getAttribute("data-tag")
        )
      assert.notInclude(rows(), "SubscriptionStarted")
      assert.include(rows(), "CommandStarted")
      assert.include(rows(), "Update")
      assert.match(
        text(root.querySelector(".hidden-note")),
        /^\d+ lifecycle entries hidden\. Show them$/
      )
      yield* click(root.querySelector(".hidden-note button")!)
      assert.strictEqual(
        HtmlLocator.getByRole(root, "button", { name: "Everything" })
          .getAttribute("aria-pressed"),
        "true"
      )
      assert.include(rows(), "SubscriptionStarted")
      assert.isNull(root.querySelector(".hidden-note"))

      yield* selectClickedSave(root)
      yield* click(instance(root, "Editor[n2]"))
      assert.isFalse(instance(root, "Editor[n2]").classList.contains("on"))
      assert.strictEqual(
        instance(root, "Editor[n2]").getAttribute("aria-current"),
        "true"
      )
      assert.isNull(instance(root, "Editor[n1]").getAttribute("aria-current"))
      yield* click(instance(root, "Editor[n2]"))
      assert.isTrue(instance(root, "Editor[n2]").classList.contains("on"))

      assert.strictEqual(headline(root), "ClickedSave")
      assert.match(subtitle(root), /^Update #\d+, \d+ ms after start$/)
      assert.strictEqual(
        text(root.querySelector(".crumbs")),
        "Workspace/Editor[n2]"
      )
      const chain = steps(root)
      assert.deepStrictEqual(chain.map((step) => step.kind), [
        "Source",
        "Entry",
        "Command 0",
        "Started",
        "End"
      ])
      assert.strictEqual(chain[0].what, "\"click\" event")
      assert.strictEqual(chain[1].what, "ClickedSave this entry")
      assert.strictEqual(chain[2].what, "Issued notes/SaveNote")
      assert.strictEqual(
        chain[2].args,
        "{ noteId: \"n2\", text: \"Follow the command\", token: redacted }"
      )
      assert.match(chain[3].what, /^Started #\d+$/)
      assert.match(
        chain[4].what,
        /^Interrupted after \d+ ms #\d+ by PressedEscape #\d+$/
      )
      assert.isTrue(chain[4].step.classList.contains("step-bad"))
      const clickedSave = subtitle(root)
      yield* commonChecks(root)

      yield* follow(root, "End", ".cause button.ref")
      assert.strictEqual(headline(root), "PressedEscape")
      assert.strictEqual(
        text(root.querySelector(".crumbs")),
        "Workspace/Editor[n2]"
      )
      assert.match(
        step(root, "Command 0").what,
        /^Interrupt notes\/SaveNote \{"noteId":"n2"\}, stopped #\d+$/
      )
      const source = step(root, "Source")
      assert.match(
        source.what,
        /^Subscription @effect\/ui\/html\/document \["keydown"\] #\d+$/
      )
      yield* click(source.step.querySelector("button.ref")!)
      assert.include(headline(root), "SubscriptionStarted")
      assert.strictEqual(
        text(root.querySelector(".crumbs")),
        "Workspace/Editor[n2]"
      )

      yield* click(instance(root, "Editor[n2]"))
      yield* click(HtmlLocator.getByRole(root, "button", { name: "Commands" }))
      yield* click(oldest(root, /notes\/SaveNote interrupted$/))
      assert.isTrue(step(root, "End").step.classList.contains("step-bad"))
      yield* follow(root, "Entry")
      assert.strictEqual(subtitle(root), clickedSave)

      yield* tab(root, /Lifecycle/)
      const [, path, mounted, unmounted] = lifecycle(root, "instance")
      assert.strictEqual(path, "/Workspace/Editor[n2]")
      assert.match(mounted, /^mounted #\d+$/)
      assert.match(unmounted, /^unmounted #\d+ by ClickedClose$/)
      assert.match(
        lifecycle(root, "command")[3],
        /^interrupted after \d+ ms #\d+$/
      )
      assert.match(
        lifecycle(root, "subscription")[3],
        /^closed by unmount #\d+$/
      )

      const count = text(root.querySelector(".bar .count"))
      const followLatest = HtmlLocator.getByRole(root, "button", {
        name: "Follow latest"
      })
      assert.strictEqual(followLatest.getAttribute("aria-pressed"), "false")
      yield* click(followLatest)
      assert.strictEqual(followLatest.getAttribute("aria-pressed"), "true")
      assert.strictEqual(headline(root), "Unmounted")
      assert.strictEqual(text(root.querySelector(".bar .count")), count)
      assert.notInclude(root.textContent, "DevToolsOverlay")
      assert.isFalse(
        memory.entries().some((entry) =>
          "path" in entry && entry.path.includes("DevToolsOverlay")
        )
      )
    }))

  it.live("reads the other captures as unmount, switch and still running", () =>
    Effect.gen(function*() {
      yield* Effect.scoped(Effect.gen(function*() {
        const { root } = yield* mount("closed")
        yield* open(root)
        assert.strictEqual(
          status(root, "Editor[n2]"),
          "1 interrupted (unmount), unmounted"
        )
        yield* selectClickedSave(root)
        assert.match(
          step(root, "End").what,
          /^Interrupted \(unmount\) after \d+ ms #\d+ by ClickedClose #\d+$/
        )
        yield* commonChecks(root)
      }))

      yield* Effect.scoped(Effect.gen(function*() {
        const { root } = yield* mount("switched")
        yield* open(root)
        assert.strictEqual(
          status(root, "Editor[n2]"),
          "1 interrupted (switch), 1 running"
        )
        assert.isNotNull(
          instance(root, "Editor[n2]").querySelector(".status .tone-open")
        )
        yield* selectClickedSave(root)
        assert.match(
          step(root, "End").what,
          /^Interrupted \(switch\) after \d+ ms #\d+ by ClickedSave #\d+$/
        )
        yield* commonChecks(root)
      }))

      yield* Effect.scoped(Effect.gen(function*() {
        const { root } = yield* mount("open")
        yield* open(root)
        assert.strictEqual(status(root, "Editor[n1]"), "1 ended")
        assert.strictEqual(status(root, "Editor[n2]"), "1 running")
        const running = Array.from(root.querySelectorAll(".row")).filter((
          row
        ) => text(row.querySelector(".label")) === "notes/SaveNote running")
        assert.strictEqual(running.length, 1)
        assert.isTrue(
          running[0].querySelector(".mark")!.matches(
            "[data-mark=start].tone-open"
          )
        )
        yield* selectClickedSave(root)
        assert.match(step(root, "Started").what, /^Started #\d+$/)
        const end = step(root, "Running")
        assert.match(end.what, /^Still running since #\d+, no end logged yet$/)
        assert.isTrue(end.step.classList.contains("step-open"))
        assert.isFalse(steps(root).some((step) => step.kind === "End"))
        yield* commonChecks(root)
        yield* tab(root, /Lifecycle/)
        assert.strictEqual(lifecycle(root, "command")[3], "running")
        assert.notInclude(text(root.querySelector(".life")), "interrupt")
      }))
    }))

  it.live("keeps a remounted instance apart from the one it replaced", () =>
    Effect.gen(function*() {
      const LeafMessage = UiSchema.TaggedEnum({ Pinged: {} })
      const Leaf = Html.component({
        name: "Leaf",
        model: Schema.Null,
        message: LeafMessage
      }).make({
        init: () => null,
        update: { Pinged: ($) => $.model },
        view: (h) => h.button.on("click", LeafMessage.Pinged()).children("Ping")
      })
      const Pane = Html.component({
        name: "Pane",
        model: Schema.Null,
        message: Schema.Never
      }).make({
        init: () => null,
        update: ($) => $.model,
        view: (h) => h.div(Leaf(h, { key: "l" }))
      })
      const HostMessage = UiSchema.TaggedEnum({ Toggled: {} })
      const Host = Html.component({
        name: "Host",
        model: Schema.Boolean,
        message: HostMessage
      }).make({
        init: () => true,
        update: { Toggled: ($) => !$.model },
        view: (h, on) =>
          h.main(
            h.button.on("click", HostMessage.Toggled()).children("Toggle"),
            on ? Pane(h, { key: "p" }) : null
          )
      })
      yield* Effect.scoped(Effect.gen(function*() {
        const app = document.body.appendChild(document.createElement("div"))
        yield* Effect.addFinalizer(() => Effect.sync(() => app.remove()))
        yield* Layer.build(DevTools.layer()).pipe(
          Effect.flatMap((services) =>
            BrowserHost.mountEffect(Host, {}, app).pipe(
              Effect.provide(services)
            )
          )
        )
        yield* settle
        const root = overlay()
        yield* open(root)
        const ping = () =>
          HtmlLocator.getByRole(app, "button", { name: "Ping" })
        const toggle = HtmlLocator.getByRole(app, "button", { name: "Toggle" })
        yield* click(ping())
        yield* click(toggle)
        yield* click(toggle)
        yield* click(ping())
        yield* click(entry(root, /Pinged/)[0])

        yield* click(
          HtmlLocator.getByRole(root, "button", { name: /^Browse all/ })
        )
        const rows = () =>
          Array.from(root.querySelectorAll(".iitem"), (item) =>
            [
              item.querySelector(".irow")!.getAttribute("data-instance"),
              item.querySelector(".chev")?.getAttribute("aria-expanded") ??
                "-",
              text(item.querySelector(".status"))
            ].filter(Boolean).join(" "))
        assert.deepStrictEqual(rows(), [
          "Host true",
          "Pane[p] false",
          "Pane[p] true",
          "Leaf[l] -"
        ])
        yield* click(root.querySelectorAll(".iitem .chev")[1]!)
        assert.deepStrictEqual(rows().slice(-4), [
          "Pane[p] true",
          "Leaf[l] - unmounted",
          "Pane[p] true",
          "Leaf[l] -"
        ])

        yield* click(root.querySelector(".crumbs .crumb")!)
        assert.strictEqual(entry(root, /Pinged/).length, 2)
        yield* click(Array.from(root.querySelectorAll(".iitem .irow")).at(-1)!)
        assert.strictEqual(entry(root, /Pinged/).length, 1)
      }))
    }))

  it.live("collapses Model branches and counts the changes hidden inside them", () =>
    Effect.gen(function*() {
      const Message = UiSchema.TaggedEnum({ Typed: {}, Replaced: {} })
      const Form = Html.component({
        name: "Form",
        model: Schema.Struct({
          form: Schema.Struct({
            name: Schema.Struct({ value: Schema.String })
          }),
          lists: Schema.Record(Schema.String, Schema.Array(Schema.Number))
        }),
        message: Message
      }).make({
        init: () => ({ form: { name: { value: "" } }, lists: { old: [1] } }),
        update: {
          Typed: ($) => $.set({ ...$.model, form: { name: { value: "Ada" } } }),
          Replaced: ($) => $.set({ ...$.model, lists: { fresh: [2, 3] } })
        },
        view: (h) =>
          h.div.children(
            h.button.on("click", Message.Typed()).children("Type"),
            h.button.on("click", Message.Replaced()).children("Replace")
          )
      })
      const app = document.body.appendChild(document.createElement("div"))
      yield* Effect.addFinalizer(() => Effect.sync(() => app.remove()))
      yield* Layer.build(DevTools.layer()).pipe(
        Effect.flatMap((services) =>
          BrowserHost.mountEffect(Form, {}, app).pipe(Effect.provide(services))
        )
      )
      yield* settle
      yield* click(HtmlLocator.getByRole(app, "button", { name: "Type" }))
      const root = overlay()
      yield* open(root)
      yield* click(oldest(root, /Update Typed$/))

      const toggle = (name: string) =>
        HtmlLocator.getByRole(root, "button", { name })
      assert.isNull(root.querySelector(".tree .tl[data-change]"))
      assert.strictEqual(
        toggle("form, 1 change").getAttribute("aria-expanded"),
        "false"
      )
      assert.strictEqual(
        text(toggle("form, 1 change").closest(".tl")),
        "▸form{ name } 1 change"
      )
      assert.strictEqual(text(toggle("lists").closest(".tl")), "▸lists{ old }")

      yield* click(toggle("form, 1 change"))
      assert.strictEqual(toggle("form").getAttribute("aria-expanded"), "true")
      yield* click(toggle("name, 1 change"))
      assert.strictEqual(
        text(root.querySelector(".tree .tl[data-change=changed]")),
        "value\"\" → \"Ada\""
      )

      yield* click(HtmlLocator.getByRole(app, "button", { name: "Replace" }))
      yield* click(oldest(root, /Update Replaced$/))
      assert.strictEqual(toggle("name").getAttribute("aria-expanded"), "true")

      yield* click(toggle("lists, 2 changes"))
      const rows = () =>
        Array.from(root.querySelectorAll(".tree .tl"), (row) => text(row))
      const lists = () => rows().slice(rows().indexOf("▾lists{"))
      assert.deepStrictEqual(lists(), [
        "▾lists{",
        "▸fresh[ 2 items ] added",
        "▸old[ 1 item ] removed",
        "}"
      ])
      yield* click(toggle("fresh, added"))
      assert.deepStrictEqual(lists(), [
        "▾lists{",
        "▾fresh[ added",
        "02",
        "13",
        "]",
        "▸old[ 1 item ] removed",
        "}"
      ])
      yield* click(toggle("fresh, added"))
      yield* click(toggle("old, removed"))
      assert.deepStrictEqual(lists(), [
        "▾lists{",
        "▸fresh[ 2 items ] added",
        "▾old[ removed",
        "01",
        "]",
        "}"
      ])
    }))

  it.live("reads a run whose defect failed its instance as failed, not running", () =>
    Effect.gen(function*() {
      const Upload = Command.make(
        "files/Upload",
        { args: {} },
        () => Effect.die("disk full")
      )
      const UploaderMessage = UiSchema.TaggedEnum({ ClickedUpload: {} })
      const Uploader = Html.component({
        name: "Uploader",
        model: Schema.Struct({}),
        message: UploaderMessage
      }).make({
        init: () => ({}),
        update: { ClickedUpload: ($) => $.run(Upload.make()) },
        view: (h) =>
          h.button.on("click", UploaderMessage.ClickedUpload()).children(
            "Upload"
          )
      })
      const Page = Html.component({
        name: "Page",
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) => h.main(Uploader(h, { key: "uploader", props: {} }))
      })
      const app = document.body.appendChild(document.createElement("div"))
      yield* Effect.addFinalizer(() => Effect.sync(() => app.remove()))
      yield* Layer.build(DevTools.layer()).pipe(
        Effect.flatMap((services) =>
          BrowserHost.mountEffect(Page, {}, app).pipe(Effect.provide(services))
        )
      )
      yield* settle
      HtmlLocator.click(
        HtmlLocator.getByRole(app, "button", { name: "Upload" })
      )
      yield* wait(30)
      const root = overlay()
      assert.strictEqual(
        text(root.querySelector(".launch .alert")),
        "1 failure"
      )
      yield* open(root)

      assert.strictEqual(
        status(root, "Uploader[uploader]"),
        "1 failed, unmounted"
      )
      yield* click(
        HtmlLocator.getByRole(root, "button", { name: "Close the inspector" })
      )
      assert.isNull(root.querySelector(".launch .alert"))
      yield* open(root)
      yield* click(instance(root, "Uploader[uploader]"))
      yield* click(oldest(root, /Update ClickedUpload$/))
      const end = step(root, "End")
      assert.match(
        end.what,
        /^Failed in command( after \d+ ms)? #\d+, which failed its instance$/
      )
      assert.isTrue(end.step.classList.contains("step-bad"))
      assert.isFalse(steps(root).some((step) => step.kind === "Running"))
      yield* tab(root, /Lifecycle/)
      const run = lifecycle(root, "command")
      assert.strictEqual(run[1], "files/Upload")
      assert.match(run[2], /^issued #\d+, started #\d+$/)
      assert.match(run[3], /^failed( after \d+ ms)? #\d+$/)

      yield* follow(root, "End")
      assert.strictEqual(headline(root), "Failed command files/Upload")
      assert.isFalse(step(root, "End").step.classList.contains("step-this"))
      assert.strictEqual(
        step(root, "Entry").what.replace(/ #\d+$/, ""),
        "ClickedUpload"
      )
    }))

  it.live("credits each interrupt with the run of its own group", () =>
    Effect.gen(function*() {
      const Message = UiSchema.TaggedEnum({ Escaped: {}, Saved: {} })
      const Save = Command.make("test/Save", {
        args: { id: Schema.String },
        group: ["id"]
      }, () => Effect.never)
      const save = (id: string) =>
        Save.make({ id }).pipe(Command.map(() => Message.Saved()))
      const Editor = Html.component({
        name: "Editor",
        model: Schema.Null,
        message: Message
      }).make({
        init: ($) => $.set(null).run(save("a")).run(save("b")),
        update: {
          Escaped: ($) =>
            $.set($.model).run(Command.interrupt(Save, { id: "b" })).run(
              Command.interrupt(Save, { id: "a" })
            ),
          Saved: ($) => $.model
        },
        view: (h) => h.button.on("click", Message.Escaped()).children("Escape")
      })
      const app = document.body.appendChild(document.createElement("div"))
      yield* Effect.addFinalizer(() => Effect.sync(() => app.remove()))
      yield* Layer.build(DevTools.layer()).pipe(
        Effect.flatMap((services) =>
          BrowserHost.mountEffect(Editor, {}, app).pipe(
            Effect.provide(services)
          )
        )
      )
      yield* settle
      yield* click(HtmlLocator.getByRole(app, "button", { name: "Escape" }))
      const root = overlay()
      yield* open(root)
      yield* click(oldest(root, /Update Escaped$/))
      assert.strictEqual(step(root, "Entry").what, "Escaped this entry")
      const stopped = (kind: string) =>
        step(root, kind).what.match(/stopped (#\d+)$/)?.[1]
      assert.isDefined(stopped("Command 0"))
      assert.isDefined(stopped("Command 1"))
      assert.notStrictEqual(stopped("Command 0"), stopped("Command 1"))
      yield* follow(root, "Command 0")
      assert.strictEqual(step(root, "Command 1").args, "{ id: \"b\" }")
      yield* click(oldest(root, /Update Escaped$/))
      yield* follow(root, "Command 1")
      assert.strictEqual(step(root, "Command 0").args, "{ id: \"a\" }")
    }))

  it.live("keeps a key pressed in the overlay from the app's document listeners", () =>
    Effect.gen(function*() {
      const { memory, root } = yield* mount("open")
      yield* open(root)
      yield* selectClickedSave(root)
      yield* tab(root, /Raw/)
      const copy = HtmlLocator.getByRole(root, "button", { name: "Copy frame" })
      copy.focus()
      const view = root.ownerDocument.defaultView!
      copy.dispatchEvent(
        new view.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          composed: true
        })
      )
      yield* wait(30)
      const interrupted = () =>
        memory.entries().filter((entry) => entry._tag === "CommandInterrupted")
          .length
      assert.strictEqual(interrupted(), 0)
      assert.include(text(instance(root, "Editor[n2]")), "1 running")

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
      yield* wait(30)
      assert.strictEqual(interrupted(), 1)
    }))

  it.live("handles evicted entries in the causal chain and Model diff", () =>
    Effect.gen(function*() {
      const { root } = yield* mount("interrupted", 7)
      yield* open(root)
      yield* click(HtmlLocator.getByRole(root, "button", { name: "Commands" }))
      yield* click(entry(root, /notes\/SaveNote interrupted$/)[0]!)
      const issuedBy = step(root, "Link", /^Issued by/)
      assert.isNotNull(issuedBy.step.querySelector(".ref.outside"))
      assert.isNull(issuedBy.step.querySelector("button.ref"))
      yield* click(
        step(root, "Link", /^Caused by/).step.querySelector("button.ref")!
      )
      assert.strictEqual(headline(root), "PressedEscape")
      const saved = oldest(root, /Update SucceededSaveNote$/)
      yield* click(saved)
      assert.include(
        text(HtmlLocator.getByRole(root, "tab", { name: /Model/ })),
        "no diff"
      )
      assert.match(
        text(root.querySelector(".pane.model .note")),
        /^Changed since #\d+, which is outside the buffer$/
      )
      assert.isNull(root.querySelector(".tree .tl[data-change]"))
    }))

  it.live("moves between corners with arrow keys and the corner picker, and remembers the corner", () =>
    Effect.gen(function*() {
      const frame = () =>
        document.querySelector<HTMLIFrameElement>(
          "iframe[data-effect-ui-devtools]"
        )!
      const press = Effect.fnUntraced(function*(element: Element, key: string) {
        const view = element.ownerDocument.defaultView!
        element.dispatchEvent(
          new view.KeyboardEvent("keydown", {
            key,
            bubbles: true,
            composed: true,
            cancelable: true
          })
        )
        yield* settle
      })
      yield* Effect.scoped(Effect.gen(function*() {
        const { root } = yield* mount("open")
        const doc = root.ownerDocument.documentElement
        assert.strictEqual(doc.getAttribute("data-position"), "BottomRight")

        const launcher = HtmlLocator.getByRole(root, "button", {
          name: "Open the Effect UI inspector"
        })
        yield* press(launcher, "ArrowLeft")
        assert.strictEqual(doc.getAttribute("data-position"), "BottomLeft")
        assert.strictEqual(frame().style.left, "12px")
        assert.strictEqual(frame().style.bottom, "12px")
        assert.isNull(root.querySelector(".panel"))

        yield* press(launcher, "ArrowUp")
        assert.strictEqual(doc.getAttribute("data-position"), "TopLeft")
        assert.strictEqual(frame().style.top, "12px")
        assert.strictEqual(frame().style.left, "12px")

        yield* open(root)
        yield* click(
          HtmlLocator.getByRole(root, "button", {
            name: "Move inspector to another corner"
          })
        )
        yield* click(
          HtmlLocator.getByRole(root, "button", { name: "Top right" })
        )
        assert.strictEqual(doc.getAttribute("data-position"), "TopRight")
        assert.strictEqual(frame().style.top, "12px")
        assert.strictEqual(frame().style.right, "12px")
        assert.isNull(root.querySelector(".corner-menu"))
      }))

      yield* Effect.scoped(Effect.gen(function*() {
        const services = yield* Layer.build(DevTools.layer())
        yield* play("open").pipe(Effect.provide(services))
        yield* settle
        assert.strictEqual(
          overlay().ownerDocument.documentElement.getAttribute("data-position"),
          "TopRight"
        )
      }))
    }))

  it.live("leaves the app's Model and DOM as they are", () =>
    Effect.gen(function*() {
      const models = (entries: ReadonlyArray<MessageLog.Wire>) => {
        const paths: { [path: string]: Array<unknown> } = {}
        for (const entry of entries) {
          if (entry._tag === "Update") {
            ;(paths[entry.path] ??= []).push([entry.message, entry.model])
          }
        }
        return paths
      }
      const encoder = MessageLog.makeEncoder()
      for (
        const capture of ["interrupted", "open", "closed", "switched"] as const
      ) {
        const without = yield* Effect.scoped(Effect.gen(function*() {
          const memory = MessageLog.makeMemory({ size: 500 })
          const app = yield* play(capture).pipe(
            Effect.provideService(MessageLog.MessageLog, memory)
          )
          return {
            html: app.innerHTML,
            models: models(
              memory.entries().map((entry) => encoder.encode(entry))
            )
          }
        }))
        const within = yield* Effect.scoped(Effect.gen(function*() {
          const { app, memory } = yield* mount(capture)
          return {
            html: app.innerHTML,
            models: models(
              memory.entries().map((entry) => encoder.encode(entry))
            )
          }
        }))
        assert.strictEqual(within.html, without.html)
        assert.deepStrictEqual(within.models, without.models)
        assert.isNull(document.querySelector("[data-effect-ui-devtools]"))
      }
    }))
})
