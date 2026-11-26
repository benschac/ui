// @vitest-environment happy-dom
import { UiSchema } from "@effect/ui"
import {
  Calendar,
  Combobox,
  DirectionProvider,
  OTPField,
  RadioGroup,
  Slider,
  Tabs,
  ToggleGroup,
  Toolbar
} from "@effect/ui-kit"
import { BrowserHost, Html } from "@effect/ui/html"
import { assert, it } from "@effect/vitest"
import { DateTime, Effect, Redacted, Schema } from "effect"
import { container, tick } from "./utils/document.ts"

const Mode = Schema.Literals(["none", "rtl", "nested", "dir"])
const Message = UiSchema.TaggedEnum({ SetMode: { mode: Mode } })
const day = DateTime.makeUnsafe("2026-12-01T00:00:00Z")
const fruits = [{ value: "apple", label: "Apple" }]
const values = ["a", "b", "c"]

// Every component that tracks the CSS direction, under `mode`'s providers.
const Page = Html.component({
  name: "Page",
  model: Schema.Struct({ mode: Mode }),
  message: Message
}).make({
  init: () => ({ mode: "rtl" as const }),
  update: { SetMode: ($, { mode }) => ({ ...$.model, mode }) },
  view: (h, { mode }) => {
    const dir = mode === "dir" ? "rtl" as const : undefined
    const widgets = () =>
      h.div.children(
        Tabs(h, {
          props: { value: "a", tabs: values.map((value) => ({ value })) },
          view: (tabs) =>
            tabs.list(h.div).children(
              ...values.map((value) =>
                tabs.tab({ element: h.button.class(value), value })
              )
            )
        }),
        ToggleGroup(h, {
          props: { value: [], items: [{ value: "x" }] },
          view: (group) =>
            group.root(h.div).children(
              group.item({ element: h.button, value: "x" })
            )
        }),
        Toolbar(h, {
          props: { items: [{ value: "x" }] },
          view: (toolbar) =>
            toolbar.root(h.div).children(
              toolbar.button({ element: h.button, value: "x" })
            )
        }),
        RadioGroup(h, {
          props: { value: "x", items: [{ value: "x" }] },
          view: (radio) =>
            radio.root(h.div).children(
              radio.radio({ element: h.button, value: "x" })
            )
        }),
        Slider(h, {
          props: { value: 50 },
          view: (slider) =>
            slider.control(h.div).children(
              slider.thumb({ element: h.div, input: h.input })
            )
        }),
        Calendar(h, {
          props: { value: null, month: day, today: day },
          view: (calendar) => calendar.root(h.div)
        }),
        OTPField(h, {
          props: { value: Redacted.make(""), length: 1 },
          view: (otp) =>
            otp.root(h.div).children(otp.input({ element: h.input, index: 0 }))
        }),
        Combobox(h, {
          key: "chips",
          props: {
            open: false,
            multiple: true,
            dir,
            inputValue: "",
            value: ["apple"],
            items: fruits
          },
          view: (combobox) =>
            combobox.chips(h.div).children(combobox.input(h.input))
        }),
        Combobox(h, {
          key: "inline",
          props: {
            open: false,
            inline: true,
            dir,
            inputValue: "",
            value: null,
            items: fruits
          },
          view: (combobox) =>
            h.div.children(combobox.input(h.input), combobox.list(h.div))
        })
      )
    return mode === "none" || mode === "dir" ?
      widgets() :
      DirectionProvider(h, {
        props: { direction: "rtl" },
        view: () =>
          mode === "nested"
            ? DirectionProvider(h, {
              props: { direction: "ltr" },
              view: widgets
            })
            : widgets()
      })
  }
})

// Counts reads of a computed style's `direction`.
const countReads = Effect.acquireRelease(
  Effect.sync(() => {
    const original = window.getComputedStyle
    const count = { reads: 0 }
    window.getComputedStyle = function(this: Window, ...args) {
      const style = original.apply(this, args)
      return new Proxy(style, {
        get(target, key) {
          if (key === "direction") count.reads++
          const value = Reflect.get(target, key, target)
          return typeof value === "function" ? value.bind(target) : value
        }
      })
    }
    return { count, original }
  }),
  ({ original }) => Effect.sync(() => (window.getComputedStyle = original))
)

it.effect("a DirectionProvider spares every component's CSS direction reads, and its removal brings them back", () =>
  Effect.gen(function*() {
    const { count } = yield* countReads
    const app = yield* container
    const root = yield* BrowserHost.mountEffect(Page, {}, app)
    yield* tick
    const tab = (name: string) => app.querySelector<HTMLElement>("." + name)!
    // The tab ArrowLeft from B lands on: A left to right, C right to left.
    const arrowLeftFromB = function*() {
      tab("b").focus()
      tab("b").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })
      )
      yield* tick
      return values.find((value) => document.activeElement === tab(value))
    }

    app.className = "changed"
    for (const input of app.querySelectorAll("input")) input.focus()
    yield* tick
    assert.strictEqual(yield* arrowLeftFromB(), "c")

    root.send(Message.SetMode({ mode: "nested" }))
    yield* tick
    assert.strictEqual(yield* arrowLeftFromB(), "a")
    assert.strictEqual(count.reads, 0)

    app.style.direction = "rtl"
    root.send(Message.SetMode({ mode: "none" }))
    yield* tick
    assert.isAbove(count.reads, 0)
    assert.strictEqual(yield* arrowLeftFromB(), "c")

    // Without a remount, a Combobox that loses its `dir` reads CSS again.
    root.send(Message.SetMode({ mode: "dir" }))
    yield* tick
    count.reads = 0
    root.send(Message.SetMode({ mode: "none" }))
    yield* tick
    assert.isAbove(count.reads, 0)
  }).pipe(Effect.scoped))
