// @vitest-environment happy-dom
import { UiSchema } from "@effect/ui"
import { DirectionProvider, Menu, type MenuItem } from "@effect/ui-kit"
import { BrowserHost, Html } from "@effect/ui/html"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { byId, container, holdExits, popovers, tick } from "./utils/document.ts"

type Rect = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

const rects = new Map<string, Rect>()

const geometry = Effect.acquireRelease(
  Effect.sync(() => {
    const element = window.Element.prototype as any
    const root = document.documentElement as any
    const saved = {
      rect: element.getBoundingClientRect,
      ResizeObserver: (window as any).ResizeObserver
    }
    ;(window as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    element.getBoundingClientRect = function(this: Element) {
      const { height, width, x, y } = rects.get(this.id) ??
        rects.get(this.getAttribute("data-testid") ?? "") ??
        { x: 0, y: 0, width: 0, height: 0 }
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
      ;(window as any).ResizeObserver = saved.ResizeObserver
      delete root.clientWidth
      delete root.clientHeight
      rects.clear()
    }
  }),
  (restore) => Effect.sync(restore)
)

const items: ReadonlyArray<MenuItem> = [
  { value: "copy", label: "Copy" },
  { value: "cut", label: "Cut", disabled: true },
  { value: "paste", label: "Paste" },
  { value: "share", label: "Share" }
]

const shareItems: ReadonlyArray<MenuItem> = [
  { value: "email", label: "Email" },
  { value: "link", label: "Copy link" }
]

const Config = Schema.Struct({
  filter: Schema.Boolean,
  viewport: Schema.Boolean,
  closeParentOnEsc: Schema.Boolean,
  refuseClose: Schema.Boolean,
  shareDisabled: Schema.Boolean,
  rtlRoot: Schema.Boolean,
  rtlShare: Schema.Boolean,
  topLayer: Schema.optional(Schema.Boolean)
})
type Config = typeof Config.Type

const Message = UiSchema.TaggedEnum({
  RequestedOpen: {
    menu: Schema.String,
    reason: Schema.String,
    triggerId: Schema.NullOr(Schema.String)
  },
  RequestedClose: { menu: Schema.String, reason: Schema.String },
  Picked: { menu: Schema.String, value: Schema.String },
  RequestedQuery: { query: Schema.String },
  ChangedModal: { modal: Schema.Boolean }
})

const Page = Html.component({
  name: "Page",
  props: Config,
  model: Schema.Struct({
    open: Schema.Boolean,
    modal: Schema.Boolean,
    triggerId: Schema.NullOr(Schema.String),
    share: Schema.Boolean,
    query: Schema.String,
    log: Schema.Array(Schema.String)
  }),
  message: Message
}).make({
  init: () => ({
    open: false,
    modal: true,
    triggerId: null,
    share: false,
    query: "",
    log: []
  }),
  update: {
    RequestedOpen: ($, { menu, reason, triggerId }) => ({
      ...$.model,
      [menu === "root" ? "open" : "share"]: true,
      triggerId: menu === "root" ? triggerId : $.model.triggerId,
      log: [
        ...$.model.log,
        menu + " RequestedOpen " + reason +
        (triggerId !== null && triggerId !== "trigger"
          ? " from " + triggerId
          : "")
      ]
    }),
    RequestedClose: ($, { menu, reason }) => ({
      ...$.model,
      [menu === "root" ? "open" : "share"]: menu === "root" &&
        $.props.refuseClose && $.model.open,
      log: [...$.model.log, menu + " RequestedClose " + reason]
    }),
    Picked: ($, { menu, value }) => ({
      ...$.model,
      log: [...$.model.log, menu + " Picked " + value]
    }),
    RequestedQuery: ($, { query }) => ({ ...$.model, query }),
    ChangedModal: ($, { modal }) => ({ ...$.model, modal })
  },
  view: (h, model) =>
    DirectionProvider(h, {
      props: { direction: h.props.rtlRoot ? "rtl" : "ltr" },
      view: () =>
        Menu(h, {
          props: {
            open: model.open,
            items: h.props.shareDisabled
              ? items.map((item) =>
                item.value === "share" ? { ...item, disabled: true } : item
              )
              : items,
            id: "menu",
            modal: model.modal,
            topLayer: h.props.topLayer,
            triggerId: h.props.viewport ? model.triggerId : undefined,
            ...(h.props.filter ? { query: model.query } : {})
          },
          onEmit: {
            RequestedOpen: ({ reason, triggerId }) =>
              Message.RequestedOpen({ menu: "root", reason, triggerId }),
            RequestedClose: ({ reason }) =>
              Message.RequestedClose({ menu: "root", reason }),
            Picked: ({ value }) => Message.Picked({ menu: "root", value }),
            Highlighted: () => undefined,
            RequestedQuery: ({ query }) => Message.RequestedQuery({ query }),
            Settled: () => undefined
          },
          view: (menu) =>
            h.div(
              h.button.attrs({ id: "before", type: "button" }).children(
                "Before"
              ),
              menu.trigger({ element: h.button.attr("id", "trigger") })
                .children(
                  "Edit"
                ),
              h.props.viewport
                ? menu.trigger({
                  element: h.button.attr("id", "trigger-2"),
                  openOnHover: true,
                  delay: 0,
                  closeDelay: 300
                })
                  .children("View")
                : null,
              h.props.viewport
                ? menu.trigger({
                  element: h.button.attr("id", "trigger-3"),
                  disabled: true
                }).children("Off")
                : null,
              menu.positioner(h.div.attr("id", "positioner")).children(
                menu.popup(h.div).children(
                  h.props.viewport
                    ? menu.viewport(h.div.attr("id", "viewport")).children(
                      h.span.children("Content")
                    )
                    : null,
                  h.props.filter
                    ? menu.input(h.input.attr("data-testid", "input"))
                    : null,
                  menu.item({
                    element: h.div.attr("data-testid", "copy"),
                    value: "copy"
                  }).children("Copy"),
                  menu.item({
                    element: h.div.attr("data-testid", "cut"),
                    value: "cut"
                  }).children("Cut"),
                  menu.item({
                    element: h.div.attr("data-testid", "paste"),
                    value: "paste"
                  }).children("Paste"),
                  DirectionProvider(h, {
                    props: { direction: h.props.rtlShare ? "rtl" : "ltr" },
                    view: () =>
                      Menu(h, {
                        props: {
                          open: model.share,
                          items: shareItems,
                          parentItem: "share",
                          id: "share-menu",
                          closeParentOnEsc: h.props.closeParentOnEsc
                        },
                        onEmit: {
                          RequestedOpen: ({ reason }) =>
                            Message.RequestedOpen({
                              menu: "share",
                              reason,
                              triggerId: null
                            }),
                          RequestedClose: ({ reason }) =>
                            Message.RequestedClose({ menu: "share", reason }),
                          Picked: ({ value }) =>
                            Message.Picked({ menu: "share", value }),
                          Highlighted: () => undefined,
                          RequestedQuery: () => undefined,
                          Settled: () => undefined
                        },
                        view: (share) =>
                          h.div(
                            menu.item({
                              element: share.submenuTrigger(
                                h.div.attr("data-testid", "share")
                              ),
                              value: "share"
                            })
                              .children("Share"),
                            share.positioner(
                              h.div.attr("id", "share-positioner")
                            )
                              .children(
                                share.popup(h.div).children(
                                  share.item({
                                    element: h.div.attr("data-testid", "email"),
                                    value: "email"
                                  }).children("Email"),
                                  share.item({
                                    element: h.div.attr("data-testid", "link"),
                                    value: "link"
                                  }).children("Copy link")
                                )
                              )
                          )
                      })
                  }),
                  h.props.filter
                    ? menu.empty(h.div.attr("data-testid", "empty"))?.children(
                      "No matches"
                    )
                    : null
                )
              ),
              h.button.attrs({ id: "after", type: "button" }).children("After")
            )
        })
    })
})

const mountPage = Effect.fnUntraced(function*(config: Partial<Config> = {}) {
  yield* popovers
  yield* geometry
  rects.set("trigger", { x: 100, y: 100, width: 80, height: 30 })
  const app = yield* container
  const root = yield* BrowserHost.mountEffect(Page, {
    filter: false,
    viewport: false,
    closeParentOnEsc: false,
    refuseClose: false,
    shareDisabled: false,
    rtlRoot: false,
    rtlShare: false,
    ...config
  }, app)
  yield* tick
  return { root, log: () => root.model()?.log ?? [] }
})

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
const mousedown = (target: Element) => {
  target.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      isPrimary: true,
      pointerType: "mouse",
      button: 0
    })
  )
  target.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 })
  )
}
const shown = (id: string) => byId(id).matches(":popover-open")
const popupOf = (positioner: string) =>
  byId(positioner).querySelector<HTMLElement>("[data-menu-popup]")!

describe("Menu in a document", { concurrent: false }, () => {
  it.effect("a press moves focus into the popup after the browser focuses the trigger", () =>
    Effect.gen(function*() {
      yield* mountPage()
      mousedown(byId("trigger"))
      // The render flushes on a microtask, before the browser's default action focuses the trigger.
      yield* Effect.promise(() => Promise.resolve())
      byId("trigger").focus()
      yield* tick
      assert.isTrue(shown("positioner"))
      assert.strictEqual(document.activeElement, popupOf("positioner"))
    }))

  it.effect("opens from the keyboard onto the first enabled item, moves focus across disabled items, and returns focus on Enter", () =>
    Effect.gen(function*() {
      const { log } = yield* mountPage()
      const trigger = byId("trigger")
      trigger.focus()
      keydown(trigger, "ArrowDown")
      yield* tick
      assert.isTrue(shown("positioner"))
      assert.strictEqual(document.activeElement, item("copy"))
      keydown(item("copy"), "ArrowDown")
      yield* tick
      assert.strictEqual(document.activeElement, item("cut"))
      assert.strictEqual(item("cut").getAttribute("aria-disabled"), "true")
      keydown(item("cut"), "Enter")
      yield* tick
      assert.isTrue(shown("positioner"))
      keydown(item("cut"), "ArrowDown")
      yield* tick
      keydown(item("paste"), "Enter")
      yield* tick
      assert.deepStrictEqual(log(), [
        "root RequestedOpen list-navigation",
        "root Picked paste",
        "root RequestedClose item-press"
      ])
      assert.strictEqual(document.activeElement, trigger)
    }))

  it.effect("Escape gives focus back to the trigger as the close starts, and the popup is inert through its exit", () =>
    Effect.gen(function*() {
      yield* holdExits
      yield* mountPage()
      keydown(byId("trigger"), "ArrowDown")
      yield* tick
      assert.isNull(popupOf("positioner").closest("[inert]"))
      keydown(item("copy"), "Escape")
      yield* tick
      assert.isTrue(shown("positioner"))
      assert.isNotNull(popupOf("positioner").closest("[inert]"))
      assert.strictEqual(document.activeElement, byId("trigger"))
    }))

  it.effect("Escape, outside press and Tab close it, and mouse open focuses the popup", () =>
    Effect.gen(function*() {
      const { log } = yield* mountPage()
      keydown(byId("trigger"), "ArrowDown")
      yield* tick
      keydown(item("copy"), "Escape")
      yield* tick
      assert.isFalse(shown("positioner"))
      assert.strictEqual(document.activeElement, byId("trigger"))
      mousedown(byId("trigger"))
      yield* tick
      assert.strictEqual(document.activeElement, popupOf("positioner"))
      assert.isNull(document.querySelector("[data-highlighted]"))
      mousedown(byId("after"))
      yield* tick
      assert.isFalse(shown("positioner"))
      keydown(byId("trigger"), "ArrowDown")
      yield* tick
      keydown(item("copy"), "Tab")
      yield* tick
      assert.deepStrictEqual(log(), [
        "root RequestedOpen list-navigation",
        "root RequestedClose escape-key",
        "root RequestedOpen trigger-press",
        "root RequestedClose outside-press",
        "root RequestedOpen list-navigation",
        "root RequestedClose focus-out"
      ])
    }))

  it.effect("Escape and Tab ask once to close, and a refused close leaves the popup open and interactive", () =>
    Effect.gen(function*() {
      const { log } = yield* mountPage({ refuseClose: true, filter: true })
      keydown(byId("trigger"), "ArrowDown")
      yield* tick
      assert.isTrue(keydown(item("input"), "Escape").defaultPrevented)
      yield* tick
      keydown(item("input"), "Tab")
      yield* tick
      assert.deepStrictEqual(log(), [
        "root RequestedOpen list-navigation",
        "root RequestedClose escape-key",
        "root RequestedClose focus-out"
      ])
      assert.isTrue(shown("positioner"))
      assert.isNull(popupOf("positioner").closest("[inert]"))
      item("copy").focus()
      keydown(item("copy"), "Enter")
      yield* tick
      assert.isTrue(shown("positioner"))
      assert.deepStrictEqual(log().slice(-2), [
        "root Picked copy",
        "root RequestedClose item-press"
      ])
    }))

  it.effect("Escape on the page closes a menu that hovering opened, unless something already handled it", () =>
    Effect.gen(function*() {
      const { log } = yield* mountPage({ viewport: true })
      byId("trigger-2").dispatchEvent(new MouseEvent("mouseenter"))
      yield* TestClock.adjust("1 millis")
      yield* tick
      assert.isTrue(shown("positioner"))
      assert.strictEqual(document.activeElement, document.body)
      const handled = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true
      })
      document.body.addEventListener(
        "keydown",
        (event) => event.preventDefault(),
        { once: true }
      )
      document.body.dispatchEvent(handled)
      yield* tick
      assert.isTrue(shown("positioner"))
      assert.isTrue(keydown(document.body, "Escape").defaultPrevented)
      yield* tick
      assert.isFalse(shown("positioner"))
      assert.deepStrictEqual(log(), [
        "root RequestedOpen trigger-hover from trigger-2",
        "root RequestedClose escape-key"
      ])
    }))

  it.effect("a submenu opens with ArrowRight, closes with ArrowLeft or sibling hover, and a pick closes both", () =>
    Effect.gen(function*() {
      const { log } = yield* mountPage()
      keydown(byId("trigger"), "ArrowDown")
      yield* tick
      keydown(item("copy"), "End")
      yield* tick
      const share = item("share")
      assert.strictEqual(document.activeElement, share)
      assert.strictEqual(share.getAttribute("aria-haspopup"), "menu")
      assert.strictEqual(share.getAttribute("aria-expanded"), "false")
      keydown(share, "ArrowRight")
      yield* tick
      assert.isTrue(shown("share-positioner"))
      assert.strictEqual(share.getAttribute("aria-expanded"), "true")
      assert.strictEqual(document.activeElement, item("email"))
      assert.strictEqual(
        popupOf("share-positioner").getAttribute("aria-labelledby"),
        share.id
      )
      keydown(item("email"), "ArrowLeft")
      yield* tick
      assert.isFalse(shown("share-positioner"))
      assert.isTrue(shown("positioner"))
      assert.strictEqual(document.activeElement, share)
      keydown(share, "ArrowRight")
      yield* tick
      item("paste").dispatchEvent(new MouseEvent("mouseenter"))
      yield* tick
      assert.isFalse(shown("share-positioner"))
      keydown(share, "Enter")
      yield* tick
      assert.strictEqual(document.activeElement, item("email"))
      keydown(item("email"), "Escape")
      yield* tick
      assert.isFalse(shown("share-positioner"))
      assert.isTrue(shown("positioner"))
      keydown(share, "Enter")
      yield* tick
      keydown(item("email"), "Enter")
      yield* tick
      assert.isFalse(shown("share-positioner"))
      assert.isFalse(shown("positioner"))
      assert.deepStrictEqual(log(), [
        "root RequestedOpen list-navigation",
        "share RequestedOpen list-navigation",
        "share RequestedClose list-navigation",
        "share RequestedOpen list-navigation",
        "share RequestedClose sibling-open",
        "share RequestedOpen trigger-press",
        "share RequestedClose escape-key",
        "share RequestedOpen trigger-press",
        "root RequestedClose item-press",
        "share Picked email",
        "share RequestedClose item-press"
      ])
    }))

  it.effect("a disabled submenu trigger opens its submenu with no key, press or hover", () =>
    Effect.gen(function*() {
      const { log } = yield* mountPage({ shareDisabled: true })
      keydown(byId("trigger"), "ArrowDown")
      yield* tick
      keydown(item("copy"), "End")
      yield* tick
      const share = item("share")
      assert.strictEqual(document.activeElement, share)
      for (const key of ["ArrowRight", "Enter", " "]) keydown(share, key)
      mousedown(share)
      share.click()
      share.dispatchEvent(new MouseEvent("mouseenter"))
      yield* Effect.promise(() =>
        new Promise((resolve) => setTimeout(resolve, 150))
      )
      yield* tick
      assert.isFalse(shown("share-positioner"))
      assert.deepStrictEqual(log(), ["root RequestedOpen list-navigation"])
    }))

  it.effect("Escape in a submenu with closeParentOnEsc closes the whole menu and returns focus to the trigger", () =>
    Effect.gen(function*() {
      const { log } = yield* mountPage({ closeParentOnEsc: true })
      keydown(byId("trigger"), "ArrowDown")
      yield* tick
      keydown(item("copy"), "End")
      yield* tick
      keydown(item("share"), "ArrowRight")
      yield* tick
      keydown(item("email"), "Escape")
      yield* tick
      assert.isFalse(shown("share-positioner"))
      assert.isFalse(shown("positioner"))
      assert.strictEqual(document.activeElement, byId("trigger"))
      assert.deepStrictEqual(log().slice(-2), [
        "root RequestedClose escape-key",
        "share RequestedClose escape-key"
      ])
    }))

  it.effect("filtering keeps focus in the input, hides what doesn't match, and Enter picks the highlighted item", () =>
    Effect.gen(function*() {
      const { log } = yield* mountPage({ filter: true })
      mousedown(byId("trigger"))
      yield* tick
      const input = item("input") as HTMLInputElement
      assert.strictEqual(document.activeElement, input)
      assert.strictEqual(
        popupOf("positioner").getAttribute("role"),
        "presentation"
      )
      input.value = "pa"
      input.dispatchEvent(new Event("input", { bubbles: true }))
      yield* tick
      assert.isTrue(item("copy").hidden)
      assert.isFalse(item("paste").hidden)
      assert.isTrue(keydown(input, "ArrowDown").defaultPrevented)
      yield* tick
      assert.strictEqual(document.activeElement, input)
      assert.strictEqual(
        input.getAttribute("aria-activedescendant"),
        item("paste").id
      )
      input.value = "zz"
      input.dispatchEvent(new Event("input", { bubbles: true }))
      yield* tick
      assert.isNotNull(document.querySelector("[data-testid=empty]"))
      input.value = "pas"
      input.dispatchEvent(new Event("input", { bubbles: true }))
      yield* tick
      keydown(input, "ArrowDown")
      yield* tick
      keydown(input, "Enter")
      yield* tick
      assert.deepStrictEqual(log(), [
        "root RequestedOpen trigger-press",
        "root Picked paste",
        "root RequestedClose item-press"
      ])
    }))

  it.effect("a filtered menu opens a submenu under another direction with its own key, and the submenu's keys follow the submenu", () =>
    Effect.forEach([false, true], (rtlRoot) =>
      Effect.gen(function*() {
        // Share's direction is the parent's reversed, so one key both opens
        // and closes it.
        const key = rtlRoot ? "ArrowLeft" : "ArrowRight"
        const { log } = yield* mountPage({
          filter: true,
          rtlRoot,
          rtlShare: !rtlRoot
        })
        mousedown(byId("trigger"))
        yield* tick
        const input = item("input") as HTMLInputElement
        input.value = "sh"
        input.dispatchEvent(new Event("input", { bubbles: true }))
        yield* tick
        keydown(input, "ArrowDown")
        yield* tick
        assert.strictEqual(
          input.getAttribute("aria-activedescendant"),
          item("share").id
        )
        input.setSelectionRange(2, 2)
        // The parent's direction opens it.
        assert.isTrue(keydown(input, key).defaultPrevented)
        yield* tick
        assert.isTrue(shown("share-positioner"))
        assert.strictEqual(document.activeElement, item("email"))
        // The submenu's direction closes it.
        keydown(item("email"), key)
        yield* tick
        assert.isFalse(shown("share-positioner"))
        assert.deepStrictEqual(log(), [
          "root RequestedOpen trigger-press",
          "share RequestedOpen list-navigation",
          "share RequestedClose list-navigation"
        ])
      }).pipe(Effect.scoped)))

  it.effect("releasing an opening press outside cancels it, and releasing over an item picks it after 200ms", () =>
    Effect.gen(function*() {
      const { log } = yield* mountPage()
      mousedown(byId("trigger"))
      yield* tick
      byId("after").dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          button: 0,
          clientX: 900,
          clientY: 700
        })
      )
      yield* tick
      assert.isFalse(shown("positioner"))
      mousedown(byId("trigger"))
      yield* tick
      item("copy").dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, button: 0 })
      )
      yield* tick
      assert.isTrue(shown("positioner"))
      mousedown(byId("trigger"))
      yield* tick
      mousedown(byId("trigger"))
      yield* Effect.promise(() =>
        new Promise((resolve) => setTimeout(resolve, 250))
      )
      item("paste").dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, button: 0 })
      )
      yield* tick
      assert.isFalse(shown("positioner"))
      assert.deepStrictEqual(log(), [
        "root RequestedOpen trigger-press",
        "root RequestedClose cancel-open",
        "root RequestedOpen trigger-press",
        "root RequestedClose trigger-press",
        "root RequestedOpen trigger-press",
        "root Picked paste",
        "root RequestedClose item-press"
      ])
    }))

  it.effect("a modal menu blocks and hides the page behind it but for the trigger, once it is cut", () =>
    Effect.gen(function*() {
      yield* mountPage()
      mousedown(byId("trigger"))
      yield* tick
      const blocker = byId("positioner").querySelector<HTMLElement>(
        "[data-menu-blocker]"
      )!
      assert.isNotNull(blocker)
      assert.include(blocker.style.getPropertyValue("clip-path"), "100px 100px")
      assert.isFalse(blocker.inert)
      assert.strictEqual(document.body.style.overflowY, "hidden")
      assert.strictEqual(byId("before").getAttribute("aria-hidden"), "true")
      assert.isNull(byId("trigger").closest("[aria-hidden]"))
      assert.isNull(byId("positioner").closest("[aria-hidden]"))
      keydown(item("copy"), "Escape")
      yield* tick
      assert.strictEqual(document.body.style.overflowY, "")
      assert.isTrue(blocker.inert)
      assert.isNull(byId("before").getAttribute("aria-hidden"))
    }))

  it.effect("drawn in place, the menu isn't modal, and its submenu is drawn in place too", () =>
    Effect.gen(function*() {
      yield* mountPage({ topLayer: false })
      const positioner = byId("positioner")
      assert.isTrue(positioner.hidden)
      mousedown(byId("trigger"))
      yield* tick
      assert.isFalse(positioner.hidden)
      assert.isFalse(positioner.hasAttribute("popover"))
      assert.strictEqual(document.body.style.overflowY, "")
      assert.isFalse(byId("share-positioner").hasAttribute("popover"))
    }))

  it.effect("the positioner lets the pointer through until its first frames, before it may be placed", () =>
    Effect.gen(function*() {
      yield* mountPage()
      const styles: Array<string> = []
      const observer = new MutationObserver(() =>
        styles.push(byId("positioner").style.pointerEvents)
      )
      observer.observe(byId("positioner"), {
        attributes: true,
        attributeFilter: ["style"]
      })
      mousedown(byId("trigger"))
      yield* tick
      observer.disconnect()
      assert.include(styles, "none")
      assert.strictEqual(byId("positioner").style.pointerEvents, "")
    }))

  it.effect("a menu that becomes modal while open blocks the page but for the trigger", () =>
    Effect.gen(function*() {
      const { root } = yield* mountPage()
      root.send(Message.ChangedModal({ modal: false }))
      mousedown(byId("trigger"))
      yield* tick
      assert.isNull(byId("positioner").querySelector("[data-menu-blocker]"))
      root.send(Message.ChangedModal({ modal: true }))
      yield* tick
      const blocker = byId("positioner").querySelector<HTMLElement>(
        "[data-menu-blocker]"
      )!
      assert.isFalse(blocker.inert)
      assert.include(blocker.style.getPropertyValue("clip-path"), "100px 100px")
    }))

  it.effect("the viewport keeps the previous content while the popup moves to another trigger", () =>
    Effect.gen(function*() {
      const { log } = yield* mountPage({ viewport: true })
      rects.set("trigger-2", { x: 300, y: 100, width: 80, height: 30 })
      mousedown(byId("trigger"))
      yield* tick
      const viewport = byId("viewport")
      assert.strictEqual(viewport.children.length, 1)
      assert.isTrue(viewport.children[0]!.hasAttribute("data-current"))
      mousedown(byId("trigger-2"))
      yield* tick
      assert.deepStrictEqual(log(), [
        "root RequestedOpen trigger-press",
        "root RequestedOpen trigger-press from trigger-2"
      ])
      assert.strictEqual(
        byId("trigger-2").getAttribute("aria-expanded"),
        "true"
      )
      assert.strictEqual(byId("trigger").getAttribute("aria-expanded"), "false")
      assert.strictEqual(
        viewport.getAttribute("data-activation-direction"),
        "right "
      )
      assert.strictEqual(
        byId("positioner").getAttribute("data-instant"),
        "trigger-change"
      )
      assert.isNull(viewport.querySelector("[data-previous]"))
      assert.isFalse(viewport.hasAttribute("data-transitioning"))
      assert.strictEqual(viewport.querySelectorAll("[data-current]").length, 1)
      assert.strictEqual(viewport.textContent, "Content")
      keydown(popupOf("positioner"), "ArrowDown")
      yield* tick
      assert.strictEqual(viewport.textContent, "Content")
    }))

  it.effect("each trigger has its own hover settings, and hovering another trigger moves an open menu to it", () =>
    Effect.gen(function*() {
      const { log } = yield* mountPage({ viewport: true })
      byId("trigger").dispatchEvent(new MouseEvent("mouseenter"))
      yield* TestClock.adjust("200 millis")
      yield* tick
      mousedown(byId("trigger-3"))
      yield* tick
      assert.isFalse(shown("positioner"))
      assert.isTrue(byId("trigger-3").hasAttribute("disabled"))
      mousedown(byId("trigger"))
      yield* tick
      byId("trigger-2").dispatchEvent(new MouseEvent("mouseenter"))
      yield* tick
      assert.strictEqual(
        byId("trigger-2").getAttribute("aria-expanded"),
        "true"
      )
      document.body.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientX: 900,
          clientY: 700
        })
      )
      yield* TestClock.adjust("200 millis")
      yield* tick
      assert.isTrue(shown("positioner"))
      yield* TestClock.adjust("100 millis")
      yield* tick
      assert.isFalse(shown("positioner"))
      assert.deepStrictEqual(log(), [
        "root RequestedOpen trigger-press",
        "root RequestedOpen trigger-hover from trigger-2",
        "root RequestedClose trigger-hover"
      ])
    }))

  it.effect("hovering a submenu trigger opens it, and the pointer can cross to it through the safe triangle", () =>
    Effect.gen(function*() {
      const { log } = yield* mountPage()
      rects.set("share", { x: 100, y: 100, width: 80, height: 30 })
      rects.set("share-positioner", { x: 300, y: 80, width: 150, height: 100 })
      mousedown(byId("trigger"))
      yield* tick
      const share = item("share")
      share.dispatchEvent(new MouseEvent("mouseenter"))
      yield* TestClock.adjust("100 millis")
      yield* tick
      assert.isTrue(shown("share-positioner"))
      assert.strictEqual(document.activeElement, share)
      share.dispatchEvent(
        new MouseEvent("mouseout", {
          bubbles: true,
          clientX: 180,
          clientY: 115
        })
      )
      document.body.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientX: 250,
          clientY: 120
        })
      )
      yield* TestClock.adjust("10 millis")
      yield* tick
      assert.isTrue(shown("share-positioner"))
      assert.strictEqual(popupOf("positioner").style.pointerEvents, "none")
      item("paste").dispatchEvent(
        new MouseEvent("mouseenter", { clientX: 250, clientY: 120 })
      )
      yield* tick
      assert.isFalse(item("paste").hasAttribute("data-highlighted"))
      assert.isTrue(shown("share-positioner"))
      item("email").dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientX: 320,
          clientY: 100
        })
      )
      yield* tick
      assert.strictEqual(popupOf("positioner").style.pointerEvents, "")
      document.body.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientX: 900,
          clientY: 700
        })
      )
      yield* TestClock.adjust("10 millis")
      yield* tick
      assert.isFalse(shown("share-positioner"))
      assert.isTrue(shown("positioner"))
      assert.deepStrictEqual(log(), [
        "root RequestedOpen trigger-press",
        "share RequestedOpen trigger-hover",
        "share RequestedClose trigger-hover"
      ])
    }))
})
