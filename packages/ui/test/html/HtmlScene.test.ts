// @vitest-environment happy-dom
import { Command, Component, Mount, UiSchema } from "@effect/ui"
import { BrowserHost, Html } from "@effect/ui/html"
import { HtmlLocator, HtmlScene } from "@effect/ui/html/testing"
import { Locator } from "@effect/ui/testing"
import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Schema } from "effect"
import { Settings } from "./fixtures/settings.ts"

const Board = Html.component({
  name: "Board",
  model: Schema.Array(Schema.String),
  message: Schema.String
}).make({
  init: (): ReadonlyArray<string> => [],
  update: ($, message) => [...$.model, message],
  view: (h, log) =>
    h.section.dropTarget({ accepts: ["application/x-todo", "Files"] })
      .on(
        "drop",
        ({ data, files }) =>
          `outer ${
            data["application/x-todo"] ??
              files.map((file) => file.name).join(",")
          }`
      ).children(
        h.div.attr("aria-label", "Inner")
          .dropTarget({ accepts: ["text/uri-list"] }).on("drop", () => "inner")
          .children(
            h.p("Inner child")
          ),
        h.p.on("click", () => undefined).children("Plain"),
        h.output(log.join("|"))
      )
})

const log = Locator.tag("output")

describe("HtmlScene", () => {
  it.effect("drop goes to the innermost target that accepts the drag, and throws when none does", () =>
    Effect.gen(function*() {
      const scene = yield* HtmlScene.make(Board, {})
      // The inner target doesn't accept a todo, so the outer one takes it.
      scene.drop(Locator.text("Inner child"), {
        data: { "application/x-todo": "milk" }
      })
      assert.isTrue(scene.defaultPrevented)
      scene.drop(Locator.text("Inner child"), {
        data: { "text/uri-list": "https://example.com" }
      })
        .drop(Locator.text("Plain"), { files: [new File(["x"], "a.txt")] })
        .expect(log).toHaveText("outer milk|inner|outer a.txt")
      assert.throws(
        () =>
          scene.drop(Locator.text("Plain"), {
            data: { "text/plain": "hello" }
          }),
        /HtmlScene\.drop: nothing at text "Plain" accepts "text\/plain"/
      )
    }))

  it("a message step reports unacknowledged work before a lookup that fails", () => {
    const missing = Locator.text("Missing")
    const steps: Record<
      string,
      (scene: HtmlScene.Steps<typeof Board>) => unknown
    > = {
      click: (scene) => scene.click(missing),
      fire: (scene) => scene.fire(missing, "click"),
      type: (scene) => scene.type(missing, "x"),
      change: (scene) => scene.change(missing, "x"),
      compositionEnd: (scene) => scene.compositionEnd(missing),
      keydown: (scene) => scene.keydown(missing, "a"),
      submit: (scene) => scene.submit(missing),
      focus: (scene) => scene.focus(missing),
      blur: (scene) => scene.blur(missing),
      drop: (scene) =>
        scene.drop(missing, { data: { "application/x-todo": "milk" } }),
      childEmit: (scene) => scene.childEmit(Board, "none", undefined as never),
      childFailure: (scene) =>
        scene.childFailure(Board, "none", Cause.fail("boom"))
    }
    for (const [name, run] of Object.entries(steps)) {
      const scene = HtmlScene.start(Board, {}).click("Plain")
      assert.throws(
        () => run(scene),
        new RegExp(
          `^HtmlScene\\.${name}: earlier work isn't settled or acknowledged`
        )
      )
      scene.expectIgnored()
      assert.throws(
        () => run(scene),
        new RegExp(`^HtmlScene\\.${name}: (nothing matches|no child)`)
      )
    }
  })

  it.effect("a scene names a mount by its definition, checks its args and ends it with the definition's result", () =>
    Effect.gen(function*() {
      const Message = UiSchema.TaggedEnum({
        Add: { point: Schema.Number },
        Drawn: { width: Schema.Number }
      })
      const DrawChart = Mount.make(
        "DrawChart",
        { args: { points: Schema.Array(Schema.Number) } },
        (canvas: HTMLCanvasElement) => Effect.sync(() => canvas.width)
      )
      const Chart = Html.component({
        name: "Chart",
        model: Schema.Struct({
          points: Schema.Array(Schema.Number),
          width: Schema.Number
        }),
        message: Message
      }).make({
        init: () => ({ points: [1, 2], width: 0 }),
        update: ($, message) =>
          Message.match(message, {
            Add: ({ point }) => ({
              ...$.model,
              points: [...$.model.points, point]
            }),
            Drawn: ({ width }) => ({ ...$.model, width })
          }),
        view: (h, model) =>
          h.div(
            h.canvas.onMount(
              DrawChart({ points: model.points }).pipe(
                Mount.map((width) => Message.Drawn({ width }))
              )
            ),
            h.button.on("click", Message.Add({ point: 3 })).children("Add"),
            h.p(`width ${model.width}`)
          )
      })
      const scene = yield* HtmlScene.make(Chart, {})
      scene.expectMount(DrawChart({ points: [1, 2] }))
        .click("Add")
        // The mount keeps running with the new args.
        .expectMount(DrawChart({ points: [1, 2, 3] }))
        // The definition's own result: the view's Mount.map makes the message.
        .mounted(DrawChart, 300)
        .expect(Locator.tag("p")).toHaveText("width 300")
      assert.throws(
        () => scene.expectMount(DrawChart({ points: [] })),
        /HtmlScene\.expectMount: no rendered mount matches DrawChart\(\{"points":\[\]\}\); mounts: DrawChart\(\{"points":\[1,2,3\]\}\)/
      )
    }))

  it.effect("type, keydown, label and placeholder send what the browser host sends", () =>
    Effect.gen(function*() {
      const scene = yield* HtmlScene.make(Settings, {})
      scene.type(HtmlLocator.label("Zip code"), "10001")
        .expect(HtmlLocator.placeholder("90210")).toHaveValue("10001")
        .keydown(HtmlLocator.label("Zip code"), "Enter", { shift: true })
        .expect(log).toHaveText("zip:10001|key:Enter+shift")
    }))

  it("type, change, compositionEnd and keydown default the edit, the composition and the selection, and take them", () => {
    const Field = Html.component({
      name: "Field",
      model: Schema.Array(Schema.String),
      message: Schema.String
    }).make({
      init: (): ReadonlyArray<string> => [],
      update: ($, message) => [...$.model, message],
      view: (h, log) => {
        const saw = (event: string) => (payload: object) =>
          `${event} ${JSON.stringify(payload)}`
        return h.div(
          h.input.attr("aria-label", "Name").value("Ada").on(
            "input",
            saw("input")
          )
            .on("change", saw("change"))
            .on("compositionend", saw("compositionend")).on(
              "keydown",
              saw("keydown")
            ),
          h.input.prop("type", "checkbox").attr("aria-label", "PropBox")
            .on("keydown", saw("keydown")),
          h.div.attr("contenteditable", "true").on("keydown", saw("keydown"))
            .children(
              h.span.attr("id", "ce-child").children("Edit"),
              h.div.attr("contenteditable", "false").children(
                h.button.attr("id", "ce-island-btn").children("Stop")
              )
            ),
          h.output(log.join("\n"))
        )
      }
    })
    const name = HtmlLocator.label("Name")
    const propBox = HtmlLocator.label("PropBox")
    const scene = HtmlScene.start(Field, {})
      .type(name, "A")
      .type(name, "Ad", { composing: true, inputType: "insertCompositionText" })
      .compositionEnd(name, "Adam")
      .compositionEnd(name)
      .change(name, "Ada")
      .change(name, { inputType: "insertReplacementText" })
      .keydown(name, "a")
      .keydown(name, "a", {
        composing: true,
        repeat: true,
        editable: false,
        selectionStart: 1,
        selectionEnd: 3
      })
      .keydown(propBox, " ")
      .keydown(Locator.attr("id", "ce-child"), "g")
      .keydown(Locator.attr("id", "ce-island-btn"), "g")
    assert.deepStrictEqual(
      scene.get(log).children?.map((child) => child.text).join("").split("\n"),
      [
        `input {"value":"A","checked":false,"files":[],"composing":false,"inputType":"insertText"}`,
        `input {"value":"Ad","checked":false,"files":[],"composing":true,"inputType":"insertCompositionText"}`,
        `compositionend {"value":"Adam"}`,
        `compositionend {"value":"Ada"}`,
        `change {"value":"Ada","checked":false,"files":[],"composing":false,"inputType":""}`,
        `change {"value":"Ada","checked":false,"files":[],"composing":false,"inputType":"insertReplacementText"}`,
        `keydown {"key":"a","shift":false,"ctrl":false,"alt":false,"meta":false,"composing":false,"repeat":false,"editable":true,"selectionStart":null,"selectionEnd":null}`,
        `keydown {"key":"a","shift":false,"ctrl":false,"alt":false,"meta":false,"composing":true,"repeat":true,"editable":false,"selectionStart":1,"selectionEnd":3}`,
        `keydown {"key":" ","shift":false,"ctrl":false,"alt":false,"meta":false,"composing":false,"repeat":false,"editable":false,"selectionStart":null,"selectionEnd":null}`,
        `keydown {"key":"g","shift":false,"ctrl":false,"alt":false,"meta":false,"composing":false,"repeat":false,"editable":true,"selectionStart":null,"selectionEnd":null}`,
        `keydown {"key":"g","shift":false,"ctrl":false,"alt":false,"meta":false,"composing":false,"repeat":false,"editable":false,"selectionStart":null,"selectionEnd":null}`
      ]
    )
  })

  it.effect("change with files sends them to a file input's change, and other inputs get none", () =>
    Effect.gen(function*() {
      const Message = UiSchema.TaggedEnum({
        Changed: { names: Schema.Array(Schema.String) }
      })
      const Upload = Html.component({
        name: "Upload",
        model: Schema.Array(Schema.String),
        message: Message
      }).make({
        init: (): ReadonlyArray<string> => [],
        update: ($, { names }) => [...$.model, names.join(",")],
        view: (h, log) =>
          h.div(
            h.input.attrs({ type: "file", "aria-label": "File" }).value("")
              .on("change", ({ files }) =>
                Message.Changed({
                  names: files.map((file) => file.name)
                })),
            h.input.attr("aria-label", "Name").on("change", ({ files }) =>
              Message.Changed({ names: [`${files.length}`] })),
            h.output(log.join(" | "))
          )
      })
      const scene = yield* HtmlScene.make(Upload, {})
      scene.change(HtmlLocator.label("File"), {
        files: [new File(["a"], "a.txt"), new File(["b"], "b.txt")]
      })
        .change(HtmlLocator.label("Name"), {
          value: "Ada",
          files: [new File(["c"], "c.txt")]
        })
        .expect(Locator.text("a.txt,b.txt | 0")).toExist()
    }))

  it.effect("a submit button submits its form with the fields read from the view", () =>
    Effect.gen(function*() {
      const scene = yield* HtmlScene.make(Settings, {})
      scene.type(HtmlLocator.label("Zip code"), "10001")
        .click(HtmlLocator.role("checkbox", { name: "Agree" }))
        .click(HtmlLocator.role("button", { name: "Go" }))
        // The disabled checkbox is left out, the submitter is in.
        .expect(log).toHaveText(
          "zip:10001|agree:true|submit:zip=10001&agree=on&via=go"
        )
        // Submitting without a submitter.
        .submit(HtmlLocator.label("Zip code"))
        .expect(log).toHaveText(/\|submit:zip=10001&agree=on$/)
    }))

  it.effect("a checkbox fires input and change, and the matchers read fields", () =>
    Effect.gen(function*() {
      const scene = yield* HtmlScene.make(Settings, {})
      scene.expect(HtmlLocator.label("Agree")).toBeChecked(false)
        .click(HtmlLocator.label("Agree"))
        .expect(HtmlLocator.label("Agree")).toBeChecked()
        .click(HtmlLocator.label("Agree"))
        .expect(log).toHaveText("agree:true|agree:false")
        .expect(HtmlLocator.label("Off")).toBeDisabled()
        .expect(HtmlLocator.label("Agree")).toBeDisabled(false)
        .expect(HtmlLocator.label("Off")).toHaveAttribute("disabled", "")
        .expect(HtmlLocator.label("Zip code")).toHaveAccessibleName("Zip code")
      const started = HtmlScene.start(Settings, {})
      assert.throws(
        () => started.expect(HtmlLocator.label("Agree")).toBeChecked(),
        /toBeChecked\(\): it is unchecked/
      )
      assert.throws(
        () => started.expect(HtmlLocator.label("Agree")).toBeDisabled(),
        /toBeDisabled\(\): it is enabled/
      )
      assert.throws(
        () => started.expect(HtmlLocator.label("Zip code")).toHaveValue("1"),
        /toHaveValue\("1"\): its value is ""/
      )
      assert.throws(
        () =>
          started.expect(HtmlLocator.label("Zip code")).toHaveAccessibleName(
            "Zip"
          ),
        /toHaveAccessibleName\("Zip"\): its accessible name is "Zip code"/
      )
    }))

  it("clicking a disabled control throws", () => {
    const scene = HtmlScene.start(Settings, {})
    assert.throws(
      () => scene.click(HtmlLocator.label("Off")),
      /^HtmlScene\.click: label "Off" is disabled/
    )
    assert.throws(
      () => scene.click("Later"),
      /^HtmlScene\.click: text "Later" is disabled/
    )
  })

  it.effect("click, type and keydown send what BrowserHost sends for the same actions", () =>
    Effect.gen(function*() {
      const app = yield* Effect.acquireRelease(
        Effect.sync(() =>
          document.body.appendChild(document.createElement("div"))
        ),
        (element) => Effect.sync(() => element.remove())
      )
      yield* BrowserHost.mountEffect(Settings, {}, app)
      const zip = HtmlLocator.getByRole(app, "textbox", {
        name: "Zip code"
      }) as HTMLInputElement
      HtmlLocator.type(zip, "10001")
      zip.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true
        })
      )
      HtmlLocator.click(
        HtmlLocator.getByRole(app, "checkbox", { name: "Agree" })
      )
      HtmlLocator.click(HtmlLocator.getByRole(app, "button", { name: "Go" }))
      yield* Effect.promise(() =>
        new Promise<void>((resolve) => setTimeout(resolve, 30))
      )
      const browser = app.querySelector("output")!.textContent
      const scene = yield* HtmlScene.make(Settings, {})
      scene.type(HtmlLocator.label("Zip code"), "10001")
        .keydown(HtmlLocator.label("Zip code"), "Enter", { shift: true })
        .click(HtmlLocator.role("checkbox", { name: "Agree" }))
        .click(HtmlLocator.role("button", { name: "Go" }))
      assert.strictEqual(
        browser,
        "zip:10001|key:Enter+shift|agree:true|submit:zip=10001&agree=on&via=go"
      )
      assert.strictEqual(
        scene.get(log).children?.map((child) => child.text).join(""),
        browser
      )
    }).pipe(Effect.scoped))

  it.effect("a popovertarget button toggles its popover", () =>
    Effect.gen(function*() {
      const scene = yield* HtmlScene.make(Settings, {})
      scene.click(HtmlLocator.role("button", { name: "Menu" }))
        .expect(log).toHaveText("toggle:open")
    }))

  describe("a click's defaults", () => {
    const Checkout = Html.component({
      name: "Checkout",
      model: Schema.Struct({
        log: Schema.Array(Schema.String),
        zip: Schema.String
      }),
      message: Schema.String
    }).make({
      init: () => ({ log: [], zip: "old" }),
      update: ($, message) => ({
        log: [...$.model.log, message],
        zip: message === "fill" ? "new" : $.model.zip
      }),
      view: (h, model) =>
        h.div(
          h.form.attr("id", "f").on("submit", ({ entries }) =>
            `submit:${
              entries.map(([name, value]) =>
                `${name}=${value}`
              ).join("&")
            }`).children(
              h.input.attrs({ name: "zip", "aria-label": "Zip" }).value(
                model.zip
              ),
              // Inside the form, but owned by another one.
              h.input.attrs({ name: "elsewhere", form: "other" }).value("x"),
              h.button.on("click", "fill").children("Fill"),
              h.button.on("click", "stopped", { preventDefault: true })
                .children(
                  "Stop"
                ),
              h.input.attrs({ type: "checkbox", "aria-label": "Agree" })
                .on("click", "checked?", { preventDefault: true })
                .on("change", ({ checked }) => `agree:${checked}`)
            ),
          // Outside the form, owned by it through its form attribute.
          h.input.attrs({ name: "note", form: "f" }).value("hi"),
          h.button.attr("popovertarget", "menu").on("click", "menu?", {
            preventDefault: true
          }).children("Menu"),
          h.div.attrs({ id: "menu", popover: "" }).on(
            "toggle",
            ({ newState }) => `toggle:${newState}`
          ),
          h.fieldset.attr("disabled", "").children(
            h.legend(
              h.button.attr("type", "button").on("click", "legend").children(
                "In legend"
              )
            ),
            h.button.attr("type", "button").on("click", "body").children(
              "In body"
            )
          ),
          h.output(model.log.join("|"))
        )
    })

    it.effect("a cancelled click runs none of them: no submit, no checkbox change, no popover toggle", () =>
      Effect.gen(function*() {
        const scene = yield* HtmlScene.make(Checkout, {})
        scene.click("Stop")
          .click(HtmlLocator.label("Agree"))
          .click("Menu")
          .expect(log).toHaveText("stopped|checked?|menu?")
      }))

    it.effect("a submit reads the fields as the click left them, by form owner", () =>
      Effect.gen(function*() {
        const scene = yield* HtmlScene.make(Checkout, {})
        scene.click("Fill")
          .expect(log).toHaveText("fill|submit:zip=new&note=hi")
      }))

    it("the first legend of a disabled fieldset stays clickable, and the rest of it doesn't", () => {
      const scene = HtmlScene.start(Checkout, {}).click("In legend").expect(log)
        .toHaveText("legend")
      assert.throws(
        () => scene.click("In body"),
        /^HtmlScene\.click: text "In body" is disabled/
      )
    })

    it.effect("sends pointerdown, mousedown, mouseup, click in order, follows cancel rules, and stops when press removes or disables the element", () =>
      Effect.gen(function*() {
        const Sequence = Html.component({
          name: "Sequence",
          model: Schema.Struct({
            log: Schema.Array(Schema.String),
            gone: Schema.Boolean,
            off: Schema.Boolean
          }),
          message: Schema.String
        }).make({
          init: () => ({ log: [], gone: false, off: false }),
          update: ($, message) => ({
            log: [...$.model.log, message],
            gone: $.model.gone || message === "remove-down",
            off: $.model.off || message === "disable-pd"
          }),
          view: (h, model) =>
            h.div(
              h.form.on("submit", "submit").children(
                h.button.on("pointerdown", "pd")
                  .on("mousedown", "md")
                  .on("mouseup", "mu")
                  .on("click", "ck")
                  .children("All")
              ),
              h.input.attrs({ type: "checkbox", "aria-label": "CancelPD" })
                .on("pointerdown", "pd-cancel", { preventDefault: true })
                .on("mousedown", "md")
                .on("mouseup", "mu")
                .on("click", "ck")
                .on("change", "ch"),
              h.input.attrs({ type: "checkbox", "aria-label": "CancelMouse" })
                .on("pointerdown", "pd")
                .on("mousedown", "md-cancel", { preventDefault: "always" })
                .on("mouseup", "mu-cancel", { preventDefault: "always" })
                .on("click", "ck")
                .on("change", "ch"),
              model.gone
                ? undefined
                : h.button.key("remove").attr("type", "button")
                  .on("mousedown", "remove-down")
                  .on("mouseup", "remove-up")
                  .on("click", "remove-click")
                  .children("Remove"),
              h.button.attr("type", "button")
                .disabled(model.off)
                .on("pointerdown", "disable-pd")
                .on("mousedown", "disable-md")
                .on("mouseup", "disable-mu")
                .on("click", "disable-click")
                .children("Disable"),
              h.span("Unhandled"),
              h.output(model.log.join("|"))
            )
        })
        const scene = yield* HtmlScene.make(Sequence, {})
        scene.click("All")
          .expectDefaultPrevented()
          .expect(log).toHaveText("pd|md|mu|ck|submit")
          .click(HtmlLocator.label("CancelPD"))
          .expectDefaultPrevented(false)
          .expect(log).toHaveText("pd|md|mu|ck|submit|pd-cancel|ck|ch")
          .click(HtmlLocator.label("CancelMouse"))
          .expectDefaultPrevented(false)
          .expect(log).toHaveText(
            "pd|md|mu|ck|submit|pd-cancel|ck|ch|pd|md-cancel|mu-cancel|ck|ch"
          )
          .click("Remove")
          .expect(log).toHaveText(/\|remove-down$/)
          .click("Disable")
          .expect(log).toHaveText(/\|disable-pd$/)
        assert.throws(
          () => scene.click("Unhandled"),
          /^HtmlScene\.click: nothing handles "click" at text "Unhandled"/
        )
      }))

    it.effect("skips child-only press handlers when the parent handles click, and honors unconditional child cancellation", () =>
      Effect.gen(function*() {
        const TooltipLike = Html.component({
          name: "TooltipLike",
          model: Schema.Boolean,
          message: Schema.Literal("Pressed")
        }).make({
          init: () => false,
          update: () => true,
          parts: (p) => ({
            trigger: p.part("button", (b) => b.on("mousedown", "Pressed")),
            cancelPointer: p.part(
              "button",
              (b) =>
                b.on("pointerdown", "Pressed", { preventDefault: "always" })
            ),
            cancelClick: p.part(
              "button",
              (b) => b.on("click", "Pressed", { preventDefault: "always" })
            )
          })
        })
        const Parent = Html.component({
          name: "Parent",
          model: Schema.Array(Schema.String),
          message: Schema.String
        }).make({
          init: (): ReadonlyArray<string> => [],
          update: ($, message) => [...$.model, message],
          view: (h, entries) =>
            h.div(
              TooltipLike(h, {
                view: (tip) =>
                  h.div(
                    tip.trigger(h.button.on("click", "saved")).children("Save"),
                    tip.trigger(h.button).children("ChildOnly"),
                    tip.cancelPointer(
                      h.button.on("mousedown", "md")
                        .on("mouseup", "mu")
                        .on("click", "ck")
                    ).children("ChildPD"),
                    h.form.on("submit", "submitted").children(
                      tip.cancelClick(
                        h.button.on("mousedown", "form-md")
                      ).children("ChildClick")
                    )
                  )
              }),
              h.output(entries.join("|"))
            )
        })
        const scene = yield* HtmlScene.make(Parent, {})
        scene.click("Save").expect(log).toHaveText("saved")
        scene.click("ChildPD").expect(log).toHaveText("saved|ck")
        scene.click("ChildClick")
          .expectDefaultPrevented()
          .expect(log).toHaveText("saved|ck|form-md")
        assert.throws(
          () => scene.click("ChildOnly"),
          /only \/Parent\/TooltipLike\[\] handles "mousedown"/
        )
      }))

    it.effect("drops release when a headless root replaces its keyed button or a button moves across slots", () =>
      Effect.gen(function*() {
        const Shell = Html.component({
          name: "Shell",
          model: Schema.Null,
          message: Schema.Never
        }).make({
          init: () => null,
          update: ($) => $.model,
          parts: () => ({})
        })
        const RootSwap = Html.component({
          name: "RootSwap",
          model: Schema.Array(Schema.String),
          message: Schema.String
        }).make({
          init: (): ReadonlyArray<string> => [],
          update: ($, message) => [...$.model, message],
          view: (h, entries) =>
            Shell(h, {
              view: () =>
                entries.length === 0
                  ? h.button.key("first")
                    .on("mousedown", "first-md")
                    .on("click", "first-ck")
                    .children("Go")
                  : h.button.key("second")
                    .on("click", "second-ck")
                    .children(entries.join("|"))
            })
        })
        const rootScene = yield* HtmlScene.make(RootSwap, {})
        rootScene.click("Go")
          .expect(Locator.tag("button")).toHaveText("first-md")

        const TwoSlots = Html.component({
          name: "TwoSlots",
          model: Schema.Null,
          message: Schema.Never,
          slots: ["first", "second"] as const
        }).make({
          init: () => null,
          update: ($) => $.model,
          view: (h) => h.div(h.slots.first, h.slots.second)
        })
        const SlotSwap = Html.component({
          name: "SlotSwap",
          model: Schema.Array(Schema.String),
          message: Schema.String
        }).make({
          init: (): ReadonlyArray<string> => [],
          update: ($, message) => [...$.model, message],
          view: (h, entries) =>
            h.div(
              TwoSlots(h, {
                slots: {
                  first: entries.length === 0
                    ? h.button.key("same")
                      .on("mousedown", "slot1-md")
                      .on("click", "slot1-ck")
                      .children("Move")
                    : undefined,
                  second: entries.length > 0
                    ? h.button.key("same")
                      .on("click", "slot2-ck")
                      .children("Moved")
                    : undefined
                }
              }),
              h.output(entries.join("|"))
            )
        })
        const slotScene = yield* HtmlScene.make(SlotSwap, {})
        slotScene.click("Move").expect(log).toHaveText("slot1-md")
      }))
  })
})

describe("HtmlScene children it runs", () => {
  const Focus = Mount.make(
    "Focus",
    { args: {} },
    (node: HTMLElement) => Effect.sync(() => node.tagName)
  )
  const CounterMessage = UiSchema.TaggedEnum({
    ClickedAdd: {},
    CompletedFocus: { tag: Schema.String }
  })
  const CounterEvents = UiSchema.TaggedEnum({
    Counted: { count: Schema.Number }
  })
  const Counter = Html.component({
    name: "Counter",
    props: Schema.Struct({ label: Schema.String }),
    model: Schema.Struct({ count: Schema.Number, focused: Schema.String }),
    message: CounterMessage,
    events: CounterEvents
  }).make({
    init: () => ({ count: 0, focused: "" }),
    update: {
      ClickedAdd: ($) =>
        $.evolve({ count: $.model.count + 1 }).emit(
          CounterEvents.Counted({ count: $.model.count + 1 })
        ),
      CompletedFocus: ($, { tag }) => $.evolve({ focused: tag })
    },
    view: (h, model) =>
      h.div(
        h.button
          .onMount(
            Focus().pipe(
              Mount.map((tag) => CounterMessage.CompletedFocus({ tag }))
            )
          )
          .on("click", CounterMessage.ClickedAdd())
          .children(`${h.props.label} ${model.count}`),
        h.p(model.focused)
      )
  })
  const PageMessage = UiSchema.TaggedEnum({
    CountedCounter: { count: Schema.Number }
  })
  const Page = Html.component({
    name: "Page",
    model: Schema.Number,
    message: PageMessage
  }).make({
    init: () => 0,
    update: { CountedCounter: (_, { count }) => count },
    view: (h, heard) =>
      h.main(
        Counter(h, {
          props: { label: "add" },
          onEmit: (event) => PageMessage.CountedCounter({ count: event.count })
        }),
        h.output(String(heard))
      )
  })

  it.effect("run renders a child's view, sends its clicks to its update, its events to onEmit, and names its mounts", () =>
    Effect.gen(function*() {
      const scene = yield* HtmlScene.make(Page, {}, { run: [Counter] })
      scene
        .mounted(Focus, "BUTTON")
        .expect(Locator.tag("p")).toHaveText("BUTTON")
        .click("add 0")
        .expect(HtmlLocator.role("button")).toHaveText("add 1")
        .expect(Locator.tag("output")).toHaveText("1")
    }))

  it.effect("without run, a child is a leaf: its view isn't shown and childEmit stands in for it", () =>
    Effect.gen(function*() {
      const scene = yield* HtmlScene.make(Page, {})
      scene.expect(Locator.text("add 0")).toBeAbsent()
        .childEmit(Counter, CounterEvents.Counted({ count: 3 }))
        .expect(Locator.tag("output")).toHaveText("3")
    }))
  it.effect("a child it runs starts again with its init once the view places it again", () =>
    Effect.gen(function*() {
      const Toggle = Html.component({
        name: "Toggle",
        model: Schema.Boolean,
        message: Schema.Boolean
      }).make({
        init: () => true,
        update: (_, shown) => shown,
        view: (h, shown) =>
          h.div(
            h.button.on("click", !shown).children(shown ? "hide" : "show"),
            shown && Counter(h, { props: { label: "add" } })
          )
      })
      const scene = yield* HtmlScene.make(Toggle, {}, { run: [Counter] })
      scene.mounted(Focus, "BUTTON").click("add 0").click("hide").click("show")
        .mounted(Focus, "BUTTON")
        .expect(Locator.text("add 0")).toExist()
    }))

  it.effect("a Command a child it runs starts fails the step", () =>
    Effect.gen(function*() {
      class Save extends Command.Service<Save>()("test/Save", {
        args: {},
        success: Schema.Literal("ClickedSave")
      }) {}
      const Saver = Html.component({
        name: "Saver",
        model: Schema.Null,
        message: Schema.Literal("ClickedSave")
      }).make({
        init: () => null,
        update: ($) => $.run(Save.make({})),
        view: (h) => h.button.on("click", "ClickedSave").children("save")
      })
      const Host = Html.component({
        name: "Host",
        model: Schema.Null,
        message: Schema.Never
      }).make({
        init: () => null,
        update: ($) => $.model,
        view: (h) => h.main(Saver(h, {}))
      })
      const scene = yield* HtmlScene.make(Host, {}, { run: [Saver] })
      assert.throws(
        () => scene.click("save"),
        /^HtmlScene\.click: \/Host\/Saver\[\] started test\/Save, and a scene doesn't run a child's Commands/
      )
    }))
  it.effect("a child it runs reads the owner above it, and its sends are acknowledged with sent", () =>
    Effect.gen(function*() {
      const PickMessage = UiSchema.TaggedEnum({ Picked: { id: Schema.String } })
      const Selection = Component.define({
        name: "Selection",
        props: Schema.Struct({ current: Schema.String }),
        model: Schema.Null,
        message: PickMessage,
        shares: { value: ({ props }) => props.current, receives: ["Picked"] }
      }).make({ init: () => null, update: ($) => $.model, parts: () => ({}) })
      const Item = Html.component({
        name: "Item",
        props: Schema.Struct({ id: Schema.String }),
        model: Schema.Null,
        message: PickMessage,
        reads: { selection: Selection }
      }).make({
        init: () => null,
        update: ($, message) => $.send(Selection, message),
        view: (h) =>
          h.button
            .attr("aria-pressed", String(h.reads.selection === h.props.id))
            .on("click", PickMessage.Picked({ id: h.props.id }))
            .children(h.props.id)
      })
      const List = Html.component({
        name: "List",
        model: Schema.Null,
        message: Schema.Never
      }).make({
        init: () => null,
        update: ($) => $.model,
        view: (h) =>
          Selection(h, {
            props: { current: "b" },
            view: () =>
              h.ul(
                ["a", "b"].map((id) =>
                  h.li.key(id).children(Item(h, { key: id, props: { id } }))
                )
              )
          })
      })
      const scene = yield* HtmlScene.make(List, {}, { run: [Item] })
      scene
        .expect(Locator.text("b")).toHaveAttribute("aria-pressed", "true")
        .expect(Locator.text("a")).toHaveAttribute("aria-pressed", "false")
        .click("a")
        .sent(Selection, PickMessage.Picked({ id: "a" }))
    }))
})
