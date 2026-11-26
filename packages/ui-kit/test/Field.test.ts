// @vitest-environment happy-dom
import { type Component, View } from "@effect/ui"
import {
  Checkbox,
  Field,
  type FieldProps,
  fieldValidationProps,
  Input,
  Switch
} from "@effect/ui-kit"
import { Html, HtmlServer } from "@effect/ui/html"
import { Locator, Scene, Story } from "@effect/ui/testing"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

type Parts = Component.Headless.Parts<typeof Field>
type H = View.Helper<never, FieldProps> & View.Tags<Html.Elements, never>

// A field with every part. The control already describes itself with a hint
// of the consumer's own.
const standIn = {
  elements: Html,
  view: (field: Parts, h: H) =>
    field.root(h.div).children(
      field.label(h.label).children("Name"),
      field.control(h.input.attr("aria-describedby", "hint")),
      field.description(h.p).children("Visible on your profile"),
      field.error(h.span)?.children("Enter your name")
    )
}

const label = Locator.tag("label")
const control = Locator.tag("input")
const description = Locator.tag("p")
const error = Locator.tag("span")
const h = View.makeHelper<never, {}, Html.Elements>({}, Html)

const parts = (props: FieldProps) =>
  Story.parts(Field, { model: { focused: false, touched: false }, props })
const attrsOf = (builder: View.ElementBuilder<never, never, any, any>) =>
  View.build(builder, []).attrs

describe("Field", () => {
  it.effect("the label names the control, which points at the description and at the error while it shows", () =>
    Effect.gen(function*() {
      const scene = yield* Scene.make(
        Field,
        { described: true, invalid: true },
        standIn
      )
      const id = scene.get(control).attrs?.id
      assert.isString(id)
      assert.strictEqual(scene.get(label).attrs?.for, id)
      const ids = [scene.get(description).attrs?.id, scene.get(error).attrs?.id]
      assert.strictEqual(new Set([id, ...ids]).size, 3)
      assert.strictEqual(scene.get(error).attrs?.role, "alert")
      // Next to the consumer's own hint, which stays.
      assert.strictEqual(
        scene.get(control).attrs?.["aria-describedby"],
        `hint ${ids[0]} ${ids[1]}`
      )
      assert.strictEqual(scene.get(control).attrs?.["aria-invalid"], "true")

      scene.props({ id: "name", described: true, invalid: false })
        .expect(error).toBeAbsent()
      assert.strictEqual(scene.get(control).attrs?.id, "name")
      assert.strictEqual(scene.get(label).attrs?.for, "name")
      assert.strictEqual(
        scene.get(control).attrs?.["aria-describedby"],
        `hint ${ids[0]}`
      )
      assert.isUndefined(scene.get(control).attrs?.["aria-invalid"])
    }))

  it.effect("re-enabling a field restores neither focus nor a visit until the user focuses and leaves it", () =>
    Effect.gen(function*() {
      const scene = yield* Scene.make(Field, { described: true }, standIn)
      const state = () => [
        scene.get(control).attrs?.["data-focused"],
        scene.get(control).attrs?.["data-touched"]
      ]
      scene.fire(control, "focus").props({ described: true, disabled: true })
      assert.deepStrictEqual(state(), [undefined, undefined])
      scene.subscription("lostFocus", {
        _tag: "BlurredControl",
        disabled: true
      })
        .props({ described: true })
      assert.deepStrictEqual(state(), [undefined, undefined])
      scene.fire(control, "focus")
      assert.deepStrictEqual(state(), ["", undefined])
      scene.fire(control, "blur")
      assert.deepStrictEqual(state(), [undefined, ""])
    }))

  it("a group is a group unless its element says otherwise, and a disabled field disables its members", () => {
    const field = parts({})
    assert.strictEqual(attrsOf(field.group(h.div)).role, "group")
    assert.strictEqual(
      attrsOf(field.group(h.div).attr("role", "radiogroup")).role,
      "radiogroup"
    )
    assert.isUndefined(attrsOf(field.group(h.fieldset)).role)
    const member = attrsOf(
      parts({ disabled: true }).member(h.input).disabled(false)
    )
    assert.strictEqual(member.disabled, "")
    assert.strictEqual(member["data-disabled"], "")

    const scope = attrsOf(field.focusWithin(h.div))
    assert.isUndefined(scope.role)
    assert.isUndefined(scope["aria-labelledby"])
    assert.strictEqual(
      attrsOf(
        field.focusWithin(h.div.attr("aria-labelledby", "own"))
      )["aria-labelledby"],
      "own"
    )
  })

  it.effect("focusWithin keeps focus while it moves inside, touches when it leaves, and ignores disabled or removed blur", () =>
    Effect.gen(function*() {
      const wrapper = Locator.tag("section")
      const scene = yield* Scene.make(Field, { disabled: true }, {
        elements: Html,
        view: (field: Parts, h: H) =>
          field.root(h.div).children(
            field.focusWithin(h.section).children(field.member(h.button))
          )
      })
      const state = () => [
        scene.get(wrapper).attrs?.["data-focused"],
        scene.get(wrapper).attrs?.["data-touched"]
      ]
      scene.fire(wrapper, "focusin")
      assert.deepStrictEqual(state(), [undefined, undefined])
      scene.fire(wrapper, "focusout", { within: false })
      assert.deepStrictEqual(state(), [undefined, undefined])

      scene.props({}).fire(wrapper, "focusin")
      assert.deepStrictEqual(state(), ["", undefined])
      scene.fire(wrapper, "focusout", { within: true }).expectIgnored()
      assert.deepStrictEqual(state(), ["", undefined])
      scene.fire(wrapper, "focusout", { within: false, disabled: true })
      assert.deepStrictEqual(state(), [undefined, undefined])
      scene.fire(wrapper, "focusin")
      scene.fire(wrapper, "focusout", { within: false, removed: true })
      assert.deepStrictEqual(state(), [undefined, undefined])
      scene.fire(wrapper, "focusin")
      scene.fire(wrapper, "focusout", { within: false })
      assert.deepStrictEqual(state(), [undefined, ""])
    }))

  it("field state overrides stale attributes without replacing consumer attributes", () => {
    const field = parts({ invalid: false, dirty: true, filled: true })
    assert.deepStrictEqual(
      attrsOf(field.root(h.div.class("mine").attr("data-invalid", "stale"))),
      {
        class: "mine",
        "data-valid": "",
        "data-dirty": "",
        "data-filled": ""
      }
    )
    const own = attrsOf(
      field.control(h.input.disabled(true).attr("data-disabled", ""))
    )
    assert.strictEqual(own.disabled, "")
    assert.strictEqual(own["data-disabled"], "")
    const disabled = parts({ disabled: true, invalid: true })
    assert.isUndefined(disabled.error(h.span))
    const forced = attrsOf(
      disabled.control(h.input).disabled(false).attr("data-disabled", undefined)
    )
    assert.strictEqual(forced.disabled, "")
    assert.strictEqual(forced["data-disabled"], "")
    assert.isUndefined(forced["aria-invalid"])
  })

  it.effect("a disabled field submits nothing for its control, and an enabled one submits each value", () =>
    Effect.gen(function*() {
      const Form = Html.component({
        name: "Form",
        props: Schema.Struct({ disabled: Schema.Boolean }),
        model: Schema.Struct({}),
        message: Schema.Never
      }).make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) => {
          const formField = (
            key: string,
            draw: (field: Parts) => View.Content<never>
          ) =>
            Field(h, { key, props: { disabled: h.props.disabled }, view: draw })
          const props = { checked: true, name: "terms" }
          return h.form(
            formField(
              "name",
              (field) =>
                Input(h, {
                  element: field.control(h.input),
                  props: { value: "Ada" },
                  onUpdate: () => undefined
                })
                  .attr("name", "name")
            ),
            formField(
              "terms",
              (field) =>
                Checkbox(h, {
                  props,
                  view: (checkbox) =>
                    checkbox.root(field.control(h.button)).children(
                      h.input.attrs({
                        type: "hidden",
                        name: "extra",
                        value: "kept"
                      })
                    )
                })
            ),
            formField(
              "news",
              (field) =>
                Switch(h, {
                  props: { ...props, name: "news" },
                  view: (parts) =>
                    parts.root(field.control(h.button)).children(
                      h.input.attrs({
                        type: "hidden",
                        name: "other",
                        value: "also-kept"
                      })
                    )
                })
            )
          )
        }
      })
      const submitted = (disabled: boolean) =>
        HtmlServer.renderToHtml(Form, { disabled }).pipe(
          Effect.map(({ html }) => {
            const form = document.createElement("div")
            form.innerHTML = html
            return [...new FormData(form.querySelector("form")!).entries()]
          })
        )
      assert.deepStrictEqual(yield* submitted(false), [
        ["name", "Ada"],
        ["terms", "on"],
        ["extra", "kept"],
        ["news", "on"],
        ["other", "also-kept"]
      ])
      assert.deepStrictEqual(yield* submitted(true), [["extra", "kept"], [
        "other",
        "also-kept"
      ]])
    }))

  it("the label and the control take only their own tags, and a description needs the described prop", () => {
    const field = parts({})
    assert.throws(
      () => field.label(h.span as any),
      /a part for <label> was given <span>/
    )
    assert.throws(
      () => field.control(h.div as any),
      /a part for <input> or <textarea> or <select> or <button> was given <div>/
    )
    assert.throws(
      () => field.member(h.div as any),
      /a part for <input> or <textarea> or <select> or <button> was given <div>/
    )
    assert.throws(
      () => field.description(h.p),
      /Field: the description was drawn without the described prop/
    )
    assert.isUndefined(attrsOf(field.control(h.select))["aria-describedby"])
  })

  it("fieldValidationProps maps each Validation.Field state to invalid and filled", () => {
    const filled = { value: "ada", empty: false, required: true }
    assert.deepStrictEqual(
      fieldValidationProps({
        _tag: "NotValidated",
        value: " ",
        empty: true,
        required: true
      }),
      { invalid: undefined, filled: false }
    )
    assert.deepStrictEqual(
      fieldValidationProps({ _tag: "Validating", ...filled }),
      {
        invalid: undefined,
        filled: true
      }
    )
    assert.deepStrictEqual(fieldValidationProps({ _tag: "Valid", ...filled }), {
      invalid: false,
      filled: true
    })
    assert.deepStrictEqual(
      fieldValidationProps({
        _tag: "Invalid",
        ...filled,
        errors: ["Too short"]
      }),
      {
        invalid: true,
        filled: true
      }
    )
  })
})
