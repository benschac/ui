// @vitest-environment happy-dom
import { UiSchema } from "@effect/ui"
import { Dialog, Field, Select } from "@effect/ui-kit"
import { BrowserHost, Html } from "@effect/ui/html"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import {
  byId,
  container,
  holdExits,
  popovers,
  press,
  tick
} from "./utils/document.ts"

type Rect = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

const rects = new Map<string, Rect>()
const positionerSize = { width: 200, height: 150 }

const rectOf = (element: Element): Rect => {
  const style = (element as HTMLElement).style
  if (element.id === "positioner") {
    return {
      x: parseFloat(style?.left) || 0,
      y: parseFloat(style?.top) || 0,
      width: positionerSize.width,
      height: parseFloat(style?.height) || positionerSize.height
    }
  }
  const key = element.getAttribute("data-geo")
  if (key?.startsWith("text-")) {
    const positioner = rectOf(byId("positioner"))
    const index = items.findIndex(({ value }) => "text-" + value === key)
    return {
      x: positioner.x + 8,
      y: positioner.y + 10 + index * 30,
      width: 80,
      height: 20
    }
  }
  return rects.get(element.id || key || "") ??
    { x: 0, y: 0, width: 0, height: 0 }
}

class StillResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const geometry = Effect.acquireRelease(
  Effect.sync(() => {
    const element = window.Element.prototype as any
    const html = window.HTMLElement.prototype as any
    const root = document.documentElement as any
    const saved = {
      rect: element.getBoundingClientRect,
      offsetWidth: Object.getOwnPropertyDescriptor(html, "offsetWidth"),
      offsetHeight: Object.getOwnPropertyDescriptor(html, "offsetHeight"),
      ResizeObserver: (window as any).ResizeObserver,
      getComputedStyle: window.getComputedStyle
    }
    ;(window as any).ResizeObserver = StillResizeObserver
    window.getComputedStyle = (target: Element, pseudo?: string | null) => {
      const computed = saved.getComputedStyle.call(window, target, pseudo)
      if (target.id !== "positioner") return computed
      const inline = (target as HTMLElement).style
      const usedMargin = (declared: string) =>
        declared !== ""
          ? declared
          : inline.top === "0px" && inline.bottom === "0px"
          ? "400px"
          : "0px"
      return new Proxy(computed, {
        get: (style, name) => {
          const value = Reflect.get(style, name)
          if (name === "marginTop" || name === "marginBottom") {
            return usedMargin(value)
          }
          return typeof value === "function" ? value.bind(style) : value
        }
      })
    }
    element.getBoundingClientRect = function(this: Element) {
      const { height, width, x, y } = rectOf(this)
      return {
        x,
        y,
        width,
        height,
        left: x,
        top: y,
        right: x + width,
        bottom: y + height
      }
    }
    Object.defineProperty(html, "offsetWidth", {
      configurable: true,
      get: function(this: Element) {
        return rectOf(this).width
      }
    })
    Object.defineProperty(html, "offsetHeight", {
      configurable: true,
      get: function(this: Element) {
        return rectOf(this).height
      }
    })
    Object.defineProperty(root, "clientWidth", {
      configurable: true,
      value: 1000
    })
    Object.defineProperty(root, "clientHeight", {
      configurable: true,
      value: 800
    })
    return () => {
      element.getBoundingClientRect = saved.rect
      Object.defineProperty(html, "offsetWidth", saved.offsetWidth!)
      Object.defineProperty(html, "offsetHeight", saved.offsetHeight!)
      ;(window as any).ResizeObserver = saved.ResizeObserver
      window.getComputedStyle = saved.getComputedStyle
      delete root.clientWidth
      delete root.clientHeight
      rects.clear()
    }
  }),
  (restore) => Effect.sync(restore)
)

const items = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" }
]

const Config = Schema.Struct({
  align: Schema.Boolean,
  required: Schema.Boolean,
  dialog: Schema.Boolean,
  finalFocus: Schema.Boolean,
  holdExit: Schema.Boolean,
  refuseFocusOut: Schema.Boolean
})
type Config = typeof Config.Type

const Message = UiSchema.TaggedEnum({
  RequestedOpen: { reason: Schema.String },
  RequestedClose: { reason: Schema.String },
  Picked: { value: Schema.NullOr(Schema.String) },
  RequestedCloseDialog: { reason: Schema.String }
})

const Page = Html.component({
  name: "Page",
  props: Config,
  model: Schema.Struct({
    open: Schema.Boolean,
    value: Schema.NullOr(Schema.String),
    log: Schema.Array(Schema.String)
  }),
  message: Message
}).make({
  init: () => ({ open: false, value: null, log: [] }),
  update: {
    RequestedOpen: ($, { reason }) => ({
      ...$.model,
      open: true,
      log: [...$.model.log, "RequestedOpen " + reason]
    }),
    RequestedClose: ($, { reason }) => ({
      ...$.model,
      open: $.props.refuseFocusOut && reason === "focus-out",
      log: [...$.model.log, "RequestedClose " + reason]
    }),
    Picked: ($, { value }) => ({
      ...$.model,
      value,
      log: [...$.model.log, "Picked " + value]
    }),
    RequestedCloseDialog: ($, { reason }) => ({
      ...$.model,
      log: [...$.model.log, "RequestedCloseDialog " + reason]
    })
  },
  view: (h, model) => {
    const select = Field(h, {
      props: {},
      view: (field) =>
        Select(h, {
          props: {
            open: model.open,
            value: model.value,
            items,
            id: "trigger",
            name: "theme",
            required: h.props.required,
            alignItemWithTrigger: h.props.align,
            holdExit: h.props.holdExit
          },
          onEmit: {
            RequestedOpen: ({ reason }) => Message.RequestedOpen({ reason }),
            RequestedClose: ({ reason }) => Message.RequestedClose({ reason }),
            Picked: ({ value }) =>
              Message.Picked({
                value: typeof value === "string" ? value : null
              }),
            Settled: () => undefined
          },
          view: (select) =>
            field.root(h.div.attr("id", "field")).children(
              select.label(h.div.attr("id", "label")).children("Theme"),
              h.props.finalFocus
                ? select.finalFocus(h.button.attr("id", "final")).children(
                  "Final"
                )
                : null,
              field.focusWithin(h.div).children(
                select.trigger(field.member(h.button)).children(
                  select.value(h.span.attr("data-geo", "value"))
                ),
                select.positioner(h.div.attr("id", "positioner")).children(
                  select.popup(h.div.class("popup")).children(
                    ...items.map(({ label, value }) =>
                      select.item({
                        element: h.div.attr("data-testid", value),
                        value
                      }).children(
                        select.itemText(h.div.attr("data-geo", "text-" + value))
                          .children(label)
                      )
                    )
                  )
                )
              )
            )
        })
    })
    const form = h.form.attr("id", "form").children(
      h.button.attrs({ id: "before", type: "button" }).children("Before"),
      select,
      h.button.attrs({ id: "after", type: "button" }).children("After")
    )
    return h.props.dialog
      ? Dialog(h, {
        props: { open: true },
        onEmit: {
          RequestedOpen: () => undefined,
          RequestedClose: ({ reason }) =>
            Message.RequestedCloseDialog({ reason }),
          Settled: () => undefined
        },
        view: (dialog) =>
          h.div(
            dialog.portal(h.dialog)?.children(
              dialog.popup(h.div).children(form)
            )
          )
      })
      : form
  }
})

const mountPage = Effect.fnUntraced(function*(config: Partial<Config> = {}) {
  yield* popovers
  yield* geometry
  rects.set(
    "trigger",
    rects.get("trigger") ?? { x: 100, y: 300, width: 120, height: 30 }
  )
  rects.set("value", { x: 110, y: 305, width: 60, height: 20 })
  const app = yield* container
  const root = yield* BrowserHost.mountEffect(
    Page,
    {
      align: false,
      required: false,
      dialog: false,
      finalFocus: false,
      holdExit: false,
      refuseFocusOut: false,
      ...config
    },
    app
  )
  yield* tick
  return { root, log: () => root.model()?.log ?? [] }
})

const style = (name: string) => byId("positioner").style.getPropertyValue(name)
const item = (value: string) =>
  document.querySelector<HTMLElement>("[data-testid=" + value + "]")!
const keydown = (
  target: Element,
  key: string,
  init: KeyboardEventInit = {}
) => {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init
  })
  target.dispatchEvent(event)
  return event
}
const keyup = (target: Element, key: string) =>
  target.dispatchEvent(
    new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true })
  )
const mousedown = (target: Element) =>
  target.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 })
  )
const shown = () => byId("positioner").matches(":popover-open")
const reveals = Effect.acquireRelease(
  Effect.sync(() => {
    const element = window.Element.prototype as any
    const saved = element.scrollIntoView
    const seen: Array<string> = []
    element.scrollIntoView = function(this: Element) {
      seen.push(
        this.getAttribute("data-testid") + " with the popup at " + style("top")
      )
    }
    return { seen, restore: () => (element.scrollIntoView = saved) }
  }),
  ({ restore }) => Effect.sync(restore)
).pipe(Effect.map(({ seen }) => seen))
const until = (done: () => boolean) =>
  Effect.promise(async () => {
    for (let waited = 0; !done() && waited < 2000; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  })
const touched = () => byId("field").hasAttribute("data-touched")

describe("Select in a document", { concurrent: false }, () => {
  it.effect("places the popup below the trigger, flips it near the bottom, and reports the side", () =>
    Effect.gen(function*() {
      const revealed = yield* reveals
      const { root } = yield* mountPage()
      keydown(byId("trigger"), "ArrowDown")
      yield* tick
      assert.isTrue(shown())
      assert.strictEqual(style("left"), "60px")
      assert.strictEqual(style("top"), "330px")
      yield* until(() => revealed.length > 0)
      assert.deepStrictEqual(revealed, ["light with the popup at 330px"])
      assert.strictEqual(style("--anchor-width"), "120px")
      assert.strictEqual(byId("positioner").getAttribute("data-side"), "bottom")
      assert.strictEqual(
        byId("trigger").getAttribute("data-popup-side"),
        "bottom"
      )
      root.send(Message.RequestedClose({ reason: "test" }))
      yield* tick
      rects.set("trigger", { x: 100, y: 700, width: 120, height: 30 })
      keydown(byId("trigger"), "ArrowDown")
      yield* tick
      assert.strictEqual(style("top"), "550px")
      assert.strictEqual(byId("positioner").getAttribute("data-side"), "top")
    }).pipe(Effect.scoped))

  it.effect("aligned with the trigger, the selected item's text is over the value, inside the CSS margins", () =>
    Effect.gen(function*() {
      const { root } = yield* mountPage({ align: true })
      root.send(Message.Picked({ value: "dark" }))
      yield* tick
      mousedown(byId("trigger"))
      yield* tick
      assert.isTrue(shown())
      assert.strictEqual(byId("positioner").getAttribute("data-side"), "none")
      assert.strictEqual(style("left"), "102px")
      assert.strictEqual(style("top"), "255px")
      assert.strictEqual(style("margin-top"), "10px")
      assert.strictEqual(style("margin-bottom"), "10px")
      assert.strictEqual(style("height"), "150px")
      assert.strictEqual(style("max-height"), "none")
      assert.strictEqual(style("--anchor-width"), "120px")
      document.dispatchEvent(new Event("scroll"))
      yield* tick
      assert.strictEqual(style("left"), "102px")
      assert.strictEqual(style("top"), "255px")
      assert.strictEqual(document.activeElement, item("dark"))
      const margins = document.head.appendChild(document.createElement("style"))
      yield* Effect.addFinalizer(() => Effect.sync(() => margins.remove()))
      for (
        const [css, top, marginTop, marginBottom] of [
          ["margin-top: 0; margin-bottom: 50px", "265px", "0px", "50px"],
          ["margin-top: 30px; margin-bottom: 0", "235px", "30px", "0px"]
        ]
      ) {
        root.send(Message.RequestedClose({ reason: "test" }))
        yield* tick
        margins.textContent = "#positioner { " + css + " }"
        mousedown(byId("trigger"))
        yield* tick
        assert.strictEqual(style("top"), top)
        assert.strictEqual(style("margin-top"), marginTop)
        assert.strictEqual(style("margin-bottom"), marginBottom)
      }
    }).pipe(Effect.scoped))

  it.effect("falls back to placing the popup below a trigger near the top of the viewport", () =>
    Effect.gen(function*() {
      rects.set("trigger", { x: 100, y: 10, width: 120, height: 30 })
      const revealed = yield* reveals
      const { root } = yield* mountPage({ align: true })
      root.send(Message.Picked({ value: "dark" }))
      yield* tick
      mousedown(byId("trigger"))
      yield* until(() => revealed.length > 0)
      assert.deepStrictEqual(revealed, ["dark with the popup at 40px"])
      assert.strictEqual(byId("positioner").getAttribute("data-side"), "bottom")
      assert.strictEqual(style("left"), "60px")
      assert.strictEqual(style("top"), "40px")
      assert.strictEqual(style("height"), "")
      const blocker = byId("positioner").querySelector<HTMLElement>(
        "[data-select-blocker]"
      )!
      assert.include(blocker.style.getPropertyValue("clip-path"), "100px 10px")
    }).pipe(Effect.scoped))

  it.effect("aligned from the bottom after a fallback, it drops the top the fallback left", () =>
    Effect.gen(function*() {
      rects.set("trigger", { x: 100, y: 10, width: 120, height: 30 })
      const { root } = yield* mountPage({ align: true })
      mousedown(byId("trigger"))
      yield* until(() => style("top") !== "")
      assert.strictEqual(style("top"), "40px")
      root.send(Message.RequestedClose({ reason: "test" }))
      yield* tick
      rects.set("trigger", { x: 100, y: 300, width: 120, height: 30 })
      const html = window.HTMLElement.prototype as any
      const sized = (size: number) => ({
        configurable: true,
        get(this: Element) {
          return this.classList.contains("popup") ? size : 0
        }
      })
      Object.defineProperty(html, "scrollHeight", sized(400))
      Object.defineProperty(html, "clientHeight", sized(150))
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          delete html.scrollHeight
          delete html.clientHeight
        })
      )
      mousedown(byId("trigger"))
      yield* tick
      assert.strictEqual(byId("positioner").getAttribute("data-side"), "none")
      assert.strictEqual(style("bottom"), "0px")
      assert.strictEqual(style("top"), "auto")
    }).pipe(Effect.scoped))

  it.effect("moves focus into the items, and back to the trigger before it hides, so the field isn't touched", () =>
    Effect.gen(function*() {
      const scrolled = yield* reveals
      const { log } = yield* mountPage()
      byId(byId("trigger").getAttribute("aria-labelledby")!).click()
      yield* tick
      assert.strictEqual(document.activeElement, byId("trigger"))
      assert.isFalse(shown())
      keydown(byId("trigger"), "ArrowDown")
      yield* tick
      assert.strictEqual(document.activeElement, item("light"))
      assert.strictEqual(item("light").tabIndex, 0)
      scrolled.length = 0
      keydown(item("light"), "ArrowDown")
      yield* tick
      assert.strictEqual(document.activeElement, item("dark"))
      yield* until(() => scrolled.length > 0)
      assert.deepStrictEqual(scrolled, ["dark with the popup at 330px"])
      scrolled.length = 0
      item("system").dispatchEvent(new MouseEvent("mouseenter"))
      yield* tick
      assert.strictEqual(document.activeElement, item("system"))
      assert.deepStrictEqual(scrolled, [])
      const escape = keydown(item("system"), "Escape")
      assert.isTrue(escape.defaultPrevented)
      yield* tick
      assert.strictEqual(document.activeElement, byId("trigger"))
      assert.isFalse(shown())
      assert.isFalse(touched())
      keydown(byId("trigger"), "ArrowDown")
      yield* tick
      keydown(item("light"), "ArrowDown")
      yield* tick
      keydown(item("dark"), "Enter")
      yield* tick
      assert.strictEqual(document.activeElement, byId("trigger"))
      assert.strictEqual(byId("trigger").textContent, "Dark")
      assert.isFalse(touched())
      assert.deepStrictEqual(log(), [
        "RequestedOpen list-navigation",
        "RequestedClose escape-key",
        "RequestedOpen list-navigation",
        "Picked dark",
        "RequestedClose item-press"
      ])
    }).pipe(Effect.scoped))

  it.effect("a press moves focus into the popup after the browser focuses the trigger", () =>
    Effect.gen(function*() {
      yield* mountPage()
      mousedown(byId("trigger"))
      // The render flushes on a microtask, before the browser's default action focuses the trigger.
      yield* Effect.promise(() => Promise.resolve())
      byId("trigger").focus()
      yield* tick
      assert.isTrue(shown())
      assert.isTrue(byId("positioner").contains(document.activeElement))
    }).pipe(Effect.scoped))

  it.effect("Escape gives focus back to the trigger as the close starts, and the popup is inert through its exit", () =>
    Effect.gen(function*() {
      yield* holdExits
      yield* mountPage()
      keydown(byId("trigger"), "ArrowDown")
      yield* tick
      assert.isNull(item("light").closest("[inert]"))
      keydown(item("light"), "Escape")
      yield* tick
      assert.isTrue(shown())
      assert.isNotNull(item("light").closest("[inert]"))
      assert.strictEqual(document.activeElement, byId("trigger"))
    }).pipe(Effect.scoped))

  it.effect("Space picks on keyup, so the trigger doesn't open again", () =>
    Effect.gen(function*() {
      const { log } = yield* mountPage()
      keydown(byId("trigger"), "ArrowDown")
      yield* tick
      keydown(item("light"), " ")
      keyup(item("light"), " ")
      yield* tick
      assert.strictEqual(document.activeElement, byId("trigger"))
      keyup(byId("trigger"), " ")
      yield* tick
      assert.deepStrictEqual(log(), [
        "RequestedOpen list-navigation",
        "Picked light",
        "RequestedClose item-press"
      ])
    }).pipe(Effect.scoped))

  it.effect("a close the consumer makes returns focus, whatever the last dismissal did, unless focus is still outside", () =>
    Effect.gen(function*() {
      for (const kept of [false, true]) {
        yield* Effect.scoped(Effect.gen(function*() {
          const { root } = yield* mountPage({
            finalFocus: kept,
            holdExit: kept
          })
          const back = byId(kept ? "final" : "trigger")
          const visible: Array<unknown> = []
          const focus = back.focus
          back.focus = (options?: FocusOptions) => {
            visible.push(
              (options as { readonly focusVisible?: boolean } | undefined)
                ?.focusVisible
            )
            focus.call(back, options)
          }
          const reopenAndClose = Effect.gen(function*() {
            root.send(Message.RequestedOpen({ reason: "test" }))
            yield* tick
            assert.strictEqual(document.activeElement, item("light"))
            root.send(Message.RequestedClose({ reason: "test" }))
            yield* tick
            assert.strictEqual(document.activeElement, back, String(kept))
          })
          keydown(byId("trigger"), "ArrowDown")
          yield* tick
          byId("after").focus()
          yield* tick
          assert.strictEqual(document.activeElement, byId("after"))
          yield* reopenAndClose
          keydown(byId("trigger"), "ArrowDown")
          yield* tick
          keydown(item("light"), "Escape")
          yield* tick
          yield* reopenAndClose
          assert.deepStrictEqual(visible, [undefined, true, undefined])
        }))
        yield* Effect.scoped(Effect.gen(function*() {
          const { log, root } = yield* mountPage({
            finalFocus: kept,
            refuseFocusOut: true
          })
          for (const returned of [false, true]) {
            keydown(byId("trigger"), "ArrowDown")
            yield* tick
            byId("after").focus()
            yield* tick
            assert.isTrue(shown())
            if (returned) item("light").focus()
            root.send(Message.RequestedClose({ reason: "test" }))
            yield* tick
            assert.isFalse(shown())
            const expected = returned ? (kept ? "final" : "trigger") : "after"
            assert.strictEqual(
              document.activeElement,
              byId(expected),
              kept + " " + returned
            )
          }
          assert.deepStrictEqual(log(), [
            "RequestedOpen list-navigation",
            "RequestedClose focus-out",
            "RequestedClose test",
            "RequestedOpen list-navigation",
            "RequestedClose focus-out",
            "RequestedClose test"
          ])
        }))
      }
    }))

  it.effect("focus leaving closes it and touches the field, and a press outside closes it, but not on a scrollbar", () =>
    Effect.gen(function*() {
      const { log } = yield* mountPage()
      keydown(byId("trigger"), "ArrowDown")
      yield* tick
      byId("after").focus()
      yield* tick
      assert.isFalse(shown())
      assert.strictEqual(document.activeElement, byId("after"))
      assert.isTrue(touched())
      keydown(byId("trigger"), "ArrowDown")
      yield* tick
      const page = document.documentElement
      Object.defineProperty(page, "scrollHeight", {
        configurable: true,
        value: 2000
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => delete (page as any).scrollHeight)
      )
      const pressPage = (offsetX: number) => {
        const event = new PointerEvent("pointerdown", {
          bubbles: true,
          isPrimary: true,
          pointerType: "mouse",
          button: 0
        })
        Object.defineProperty(event, "offsetX", { value: offsetX })
        page.dispatchEvent(event)
      }
      pressPage(1005)
      yield* tick
      assert.isTrue(shown())
      pressPage(500)
      yield* tick
      assert.isFalse(shown())
      assert.deepStrictEqual(log(), [
        "RequestedOpen list-navigation",
        "RequestedClose focus-out",
        "RequestedOpen list-navigation",
        "RequestedClose outside-press"
      ])
    }).pipe(Effect.scoped))

  it.effect("a press on the modal backdrop keeps focus, so only leaving touches the field", () =>
    Effect.gen(function*() {
      yield* mountPage()
      const popup = document.querySelector(".popup")
      byId("trigger").focus()
      keydown(byId("trigger"), "ArrowDown")
      yield* tick
      assert.strictEqual(document.querySelector(".popup"), popup)
      assert.strictEqual(document.body.style.overflowY, "hidden")
      const blocker = byId("positioner").querySelector("[data-select-blocker]")!
      assert.isNotNull(blocker)
      const down = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0
      })
      blocker.dispatchEvent(down)
      assert.isTrue(down.defaultPrevented)
      press(blocker)
      yield* tick
      assert.isFalse(shown())
      assert.strictEqual(document.body.style.overflowY, "")
      assert.strictEqual(document.activeElement, byId("trigger"))
      assert.isFalse(touched())
    }).pipe(Effect.scoped))

  it.effect("a modal select hides the page from screen readers, and its dismiss button closes it", () =>
    Effect.gen(function*() {
      const { log } = yield* mountPage()
      const hidden = (id: string) =>
        byId(id).closest("[aria-hidden=true]") !== null
      keydown(byId("trigger"), "ArrowDown")
      yield* tick
      assert.isTrue(hidden("before"))
      assert.isFalse(hidden("trigger"))
      assert.isFalse(hidden("positioner"))
      const dismiss = byId("positioner").querySelector<HTMLElement>(
        "[role=button][aria-label=Dismiss]"
      )!
      dismiss.click()
      yield* tick
      assert.isFalse(hidden("before"))
      assert.deepStrictEqual(log(), [
        "RequestedOpen list-navigation",
        "RequestedClose close-press"
      ])
    }).pipe(Effect.scoped))

  it.effect("in a modal dialog, Escape closes only the select", () =>
    Effect.gen(function*() {
      const { log } = yield* mountPage({ dialog: true })
      keydown(byId("trigger"), "ArrowDown")
      yield* tick
      keydown(item("light"), "Escape")
      yield* tick
      press(item("dark"))
      yield* tick
      assert.deepStrictEqual(log(), [
        "RequestedOpen list-navigation",
        "RequestedClose escape-key"
      ])
      assert.strictEqual(document.activeElement, byId("trigger"))
    }).pipe(Effect.scoped))

  it.effect("a required select blocks its form until it has a value, and submits it", () =>
    Effect.gen(function*() {
      const { root } = yield* mountPage({ required: true })
      const form = byId("form") as HTMLFormElement
      const input = form.querySelector("input")!
      assert.strictEqual(byId("trigger").parentElement, input.parentElement)
      assert.strictEqual(input.parentElement!.style.display, "contents")
      assert.isFalse(form.checkValidity())
      root.send(Message.Picked({ value: "system" }))
      yield* tick
      assert.isTrue(form.checkValidity())
      assert.strictEqual(new FormData(form).get("theme"), "system")
      input.focus()
      yield* tick
      assert.strictEqual(document.activeElement, byId("trigger"))
    }).pipe(Effect.scoped))
})
