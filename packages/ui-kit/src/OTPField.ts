/**
 * A one-time code field: a row of one-character inputs for a verification
 * code, which move focus as the user types, take a pasted or autofilled
 * code whole, and submit it as one form value.
 *
 * `OTPField` is a headless component. It keeps which slot has focus and the
 * slot an input method is composing in, moves focus and selects a slot's text
 * with Commands, and emits `Updated`, `Completed` and `Rejected`. The code
 * itself is the consumer's: it comes in as the `value` prop.
 *
 * **Anatomy**
 *
 * | Part    | Element                        |
 * | :------ | :----------------------------- |
 * | `root`  | any element that can contain an `<input>`, usually a `<div>` |
 * | `input` | `<input>`, one for each slot   |
 *
 * `root` takes the consumer's builder and returns it, so the consumer goes
 * on chaining and adds the slots with `.children(...)`. `input` takes
 * `{ element, index }`, the slot's `<input>` and its place in the code from
 * 0, and returns the builder. An index outside the field's `length`, or
 * drawn twice, fails the render.
 *
 * The root adds elements after the consumer's children. First a `hidden`
 * `<span>` for each slot, holding its position, such as "2 of 6", which the
 * slot's name points at. Last a visually hidden `<input type="text">`. It
 * holds the whole code under the `name` prop, so the form submits one
 * value, carries `required` and the pattern so the browser can refuse an
 * incomplete code, and takes the browser's autofill. None of them takes up
 * room or counts in a flex or grid `gap`, but `:last-child`,
 * `:nth-child` and a selector such as `.otp input` do match them. Style
 * the slots by a class of their own.
 *
 * Anything may sit between the slots, such as a `Separator` between two
 * groups of three.
 *
 * **Data attributes**
 *
 * On the root and on every slot, present with an empty value or absent:
 *
 * - `data-disabled`, `data-readonly` and `data-required`, from the props
 * - `data-complete`: every slot has a character
 * - `data-filled`: on the root, the code isn't empty; on a slot, the slot
 *   has a character
 * - `data-focused`: a slot has focus
 *
 * **Keyboard**
 *
 * A key handler on each slot, since no native element gives these:
 *
 * | Key                                 | Action                                                    |
 * | :---------------------------------- | :-------------------------------------------------------- |
 * | a character                         | fills the slot and moves to the next                      |
 * | Left, Right                         | move one slot                                             |
 * | Ctrl or Cmd with Left, Home, Up     | move to the first slot                                    |
 * | Ctrl or Cmd with Right, End, Down   | move to the first empty slot                              |
 * | Backspace                           | removes the slot's character and moves back, or removes   |
 * |                                     | the previous one from an empty slot                       |
 * | Ctrl or Cmd with Backspace          | clears the code                                           |
 * | Delete                              | removes the slot's character and stays                    |
 *
 * Removing a character moves the later ones one slot back, so the code has
 * no gaps, and focus never goes past the first empty slot. Only one slot is
 * in the Tab order: the focused one, or else the first empty one. In a
 * right-to-left layout, Left and Right swap. The field follows the nearest
 * `DirectionProvider` above it or, without one, the root's CSS `direction`.
 * A key held with Alt does nothing and keeps its default, such as Back on
 * Alt+Left, and so does a navigation key held with Shift, which selects
 * text. A read-only field keeps the navigation keys and drops the editing
 * ones. A disabled field handles none.
 *
 * **Usage**
 *
 * The value is controlled and redacted (`Redacted<string>`), so the code
 * stays out of message logs, server page state and history. Each edit emits
 * `Updated` with the code the user asked for, and the slots show it once the
 * consumer passes it back as `value`. Focus moves on with the edit, and goes
 * back to the first empty slot when the consumer stored fewer characters than
 * were typed. So the consumer's `update` is where a code is changed on the way
 * in: store `Redacted.make(Redacted.value(value).toUpperCase())` to show
 * capitals, or use `validationType: "none"` and drop the characters a rule of
 * your own rejects. A form's `submit` event hands the code over as a plain
 * string in `fields[name]`. Wrap it with `Redacted.make` before it goes into
 * a message, or read the code from your Model.
 *
 * The consumer usually answers an edit in the `update` that handles
 * `Updated`. If `value` is another code on the render that follows, the edit
 * was accepted, whatever the consumer made of it. If `value` is still the
 * same code, the field drops its temporary value and returns focus to the
 * first empty slot, but remembers a complete requested code until the next
 * `value` change or the next edit: if the next `value` change stores that
 * exact code, it still completes; a different code or a newer edit discards
 * it. Keys that arrive before the render settles carry on from the code the
 * last edit asked for.
 *
 * `Completed` and `autoSubmit` follow an accepted edit, and read the code
 * the consumer stored. A consumer that declines the edit and later stores an
 * unrelated code gets no completion. `autoSubmit` submits a form that holds
 * the code, through the form's own validation and its `submit` handler.
 *
 * Pasted text fills the slots from the one it was pasted into. Text an
 * input method composes is entered once, when the composition ends.
 *
 * Name the field for assistive technology. The root is a `group`: give it
 * `aria-labelledby`, which `field.group` does from `field.legend`, or an
 * `aria-label`. Or use a `<label>`, around the first slot or with `for`
 * pointing at the `id` prop: it focuses the first slot, and the field finds
 * it when it mounts and names the root by it, giving it an `id` if it has
 * none. Each slot with no `aria-label` and no `aria-labelledby` of its own
 * is then named by the group's name and its position, wherever it is drawn,
 * such as "Verification code 2 of 6". It points `aria-labelledby` at the
 * group's label, or at a root named by `aria-label`, which gets an `id` if
 * it has none, and at the slot's hidden position. The position is in English.
 * For another language, give every slot an `aria-label` of its own, such as
 * "Chiffre 2 sur 6". A field with no name leaves the slots unnamed.
 *
 * In a `Field`, the root takes `field.group`, each slot's element takes
 * `field.member`, and the props take `disabled: field.disabled`. Apply the
 * field's part first, `otpField.root(field.group(h.div))`, so the slot's
 * own `data-filled` and `data-focused` are the ones that show.
 *
 * **Example** (A six-digit code)
 *
 * ```ts import.meta.vitest
 * import { UiSchema } from "@effect/ui"
 * import { Html, HtmlServer } from "@effect/ui/html"
 * import { OTPField } from "@effect/ui-kit"
 * import { Effect, Redacted, Schema } from "effect"
 *
 * const VerifyMessage = UiSchema.TaggedEnum({ UpdatedCode: { value: Schema.Redacted(Schema.String) } })
 *
 * const Verify = Html.component({
 *   name: "Verify",
 *   model: Schema.Struct({ code: Schema.Redacted(Schema.String) }),
 *   message: VerifyMessage
 * }).make({
 *   init: () => ({ code: Redacted.make("12") }),
 *   update: { UpdatedCode: (_, { value }) => ({ code: value }) },
 *   view: (h, model) =>
 *     OTPField(h, {
 *       props: { value: model.code, length: 6, name: "code" },
 *       onEmit: {
 *         Updated: ({ value }) => VerifyMessage.UpdatedCode({ value }),
 *         Completed: () => undefined,
 *         Rejected: () => undefined
 *       },
 *       view: (otpField) =>
 *         otpField.root(h.div.class("otp").attr("aria-label", "Verification code")).children(
 *           Array.from({ length: otpField.length }, (_, index) =>
 *             otpField.input({ element: h.input.class("slot"), index }))
 *         )
 *     })
 * })
 *
 * // Six slots, two of them filled, each named with its position, and one hidden input that submits the code.
 * const { html } = await Effect.runPromise(HtmlServer.renderToHtml(Verify, {}))
 * if (html.match(/<input class="slot"/g)?.length !== 6) throw new Error("the field doesn't draw six slots")
 * if (!html.includes(">2 of 6</span>")) throw new Error("the second slot's position isn't there")
 * if (html.match(/<input class="slot"[^>]* data-filled/g)?.length !== 2) throw new Error("two slots aren't filled")
 * if (!/<input [^>]*name="code"[^>]* value="12"/.test(html)) throw new Error("the hidden input doesn't hold the code")
 * ```
 *
 * @stability experimental
 * @since 0.1.0
 */
import * as Command from "@effect/ui/Command"
import type * as Component from "@effect/ui/Component"
import * as Html from "@effect/ui/html/Html"
import * as HtmlCommand from "@effect/ui/html/HtmlCommand"
import * as Mount from "@effect/ui/Mount"
import * as Subscription from "@effect/ui/Subscription"
import * as UiSchema from "@effect/ui/UiSchema"
import * as UiStruct from "@effect/ui/UiStruct"
import * as View from "@effect/ui/View"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { DirectionProvider } from "./DirectionProvider.ts"
import { type Attributed, flag, visuallyHidden } from "./internal/attributes.ts"
import { rightToLeft, TrackDirection } from "./internal/direction.ts"
import { input } from "./internal/formInputs.ts"
import { isAndroid } from "./internal/platform.ts"
import { clamp } from "./internal/range.ts"

const Code = Schema.Redacted(Schema.String)

/**
 * Which characters a one-time code field accepts: digits, letters, both, or
 * anything that isn't whitespace.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const OTPFieldValidationType = Schema.Literals([
  "numeric",
  "alpha",
  "alphanumeric",
  "none"
])

/**
 * Which characters a one-time code field accepts.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type OTPFieldValidationType = typeof OTPFieldValidationType.Type

/**
 * The virtual keyboard a one-time code field asks for, as the `inputmode`
 * attribute names them.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const OTPFieldInputMode = Schema.Literals([
  "none",
  "text",
  "tel",
  "url",
  "email",
  "numeric",
  "decimal",
  "search"
])

/**
 * The virtual keyboard a one-time code field asks for.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type OTPFieldInputMode = typeof OTPFieldInputMode.Type

/**
 * Props for the state of an `OTPField`.
 *
 * **Details**
 *
 * - `value`: the code, a `Redacted<string>`. The slots show it with
 *   whitespace and the characters `validationType` rejects removed, cut to
 *   `length`.
 * - `length`: the number of slots, a positive whole number.
 * - `id`: the first slot's id. The others get `id-2`, `id-3` and so on,
 *   so a `<label for>` focuses the first slot. Left out, each slot keeps
 *   the id the consumer gave it.
 * - `validationType`: `"numeric"` by default, `"alpha"`,
 *   `"alphanumeric"`, or `"none"` to accept any character and leave the
 *   rule to the consumer's `update`.
 * - `mask`: draws each slot as a password input, unless the slot has a
 *   `type` of its own.
 * - `inputMode`: the virtual keyboard. By default `"numeric"` for a
 *   numeric field, `"text"` for letters, and none for `"none"`.
 * - `autoComplete`: the `autocomplete` of the first slot and the hidden
 *   input, `"one-time-code"` by default. The other slots get `"off"`.
 * - `autoSubmit`: submits the form the field belongs to once the stored
 *   code is complete.
 * - `disabled`: disables every slot and the hidden input, so the field
 *   takes no focus, reports nothing and submits nothing.
 * - `readOnly`: keeps focus and the navigation keys, and drops every edit.
 * - `required`: the form doesn't submit while the code is empty.
 * - `name`: the name the form submits the code under.
 * - `form`: the id of the form the field belongs to, when it isn't inside
 *   it.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const OTPFieldProps = Schema.Struct({
  value: Code,
  length: Schema.Number,
  id: Schema.optional(Schema.String),
  validationType: Schema.optional(OTPFieldValidationType),
  mask: Schema.optional(Schema.Boolean),
  inputMode: Schema.optional(OTPFieldInputMode),
  autoComplete: Schema.optional(Schema.String),
  autoSubmit: Schema.optional(Schema.Boolean),
  disabled: Schema.optional(Schema.Boolean),
  readOnly: Schema.optional(Schema.Boolean),
  required: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String),
  form: Schema.optional(Schema.String)
})

/**
 * The props of an `OTPField`.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type OTPFieldProps = typeof OTPFieldProps.Type

/**
 * How the user changed the code: `"input-change"` for typing, an input
 * method or autofill, `"input-clear"` for emptying a slot, `"input-paste"`
 * for a paste, and `"keyboard"` for Backspace and Delete.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const OTPFieldUpdateReason = Schema.Literals([
  "input-change",
  "input-clear",
  "input-paste",
  "keyboard"
])

/**
 * How the user changed the code.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type OTPFieldUpdateReason = typeof OTPFieldUpdateReason.Type

/**
 * How the user entered text: `"input-change"` for typing, an input method
 * or autofill, and `"input-paste"` for a paste.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const OTPFieldEntryReason = Schema.Literals([
  "input-change",
  "input-paste"
])

/**
 * How the user entered text.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type OTPFieldEntryReason = typeof OTPFieldEntryReason.Type

/**
 * What a one-time code field emits.
 *
 * **Details**
 *
 * - `Updated`: asks for the code in `value`. Store `value` and pass it back
 *   as the `value` prop, changed if need be, such as in upper case. Until
 *   then the slots go on showing the old code.
 * - `Completed`: the consumer answered text the user typed or pasted by
 *   storing a code that fills every slot. `value` is the stored code, so a
 *   consumer that synchronously changes or shortens what it stores gets the
 *   code it kept, or no event. If `value` doesn't change right away, the
 *   field still completes if the next `value` change stores the exact
 *   complete code it asked for before another edit arrives; an unrelated
 *   code or a newer edit discards it. A complete code pasted over the same
 *   code reports it again. Backspace and Delete never complete a code.
 * - `Rejected`: the text the user typed or pasted held characters the
 *   field dropped, or more characters than the field has slots. `value` is
 *   that text as entered. The accepted part, if any, is reported by
 *   `Updated`.
 *
 * Every `value` is a `Redacted<string>`.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const OTPFieldEvents = UiSchema.TaggedEnum({
  Updated: { value: Code, reason: OTPFieldUpdateReason },
  Completed: { value: Code, reason: OTPFieldEntryReason },
  Rejected: { value: Code, reason: OTPFieldEntryReason }
})

/**
 * What an `OTPField` emits.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type OTPFieldEvents = typeof OTPFieldEvents.Type

const OTPFieldMessage = UiSchema.TaggedEnum({
  UpdatedSlot: { index: Schema.Number, value: Code, composing: Schema.Boolean },
  EndedComposition: { index: Schema.Number, value: Code },
  PastedText: { index: Schema.Number, text: Code },
  PressedKey: {
    index: Schema.Number,
    key: Schema.String,
    boundary: Schema.Boolean
  },
  PressedSlot: { index: Schema.Number },
  FocusedSlot: { index: Schema.Number },
  BlurredSlot: { index: Schema.Number },
  FocusedHiddenInput: {},
  UpdatedHiddenInput: { value: Code },
  Settled: {},
  DisabledWhileFocused: {},
  CompletedSelectSlot: {},
  CompletedInspectFirstSlot: {
    label: Schema.NullOr(Schema.String),
    android: Schema.Boolean
  },
  FoundDirection: { rtl: Schema.Boolean }
})

type OTPFieldMessage = typeof OTPFieldMessage.Type

const OTPFieldModel = Schema.Struct({
  focused: Schema.Boolean,
  focusedIndex: Schema.Number,
  target: Schema.NullOr(Schema.Number),
  moving: Schema.Number,
  composing: Schema.NullOr(Schema.Number),
  composed: Schema.NullOr(Schema.Struct({ index: Schema.Number, text: Code })),
  edit: Schema.NullOr(Schema.Struct({
    before: Code,
    asked: Code,
    reason: Schema.NullOr(OTPFieldEntryReason),
    settled: Schema.Boolean
  })),
  edits: Schema.Number,
  label: Schema.NullOr(Schema.String),
  android: Schema.Boolean,
  rtl: Schema.Boolean
})

type OTPFieldModel = typeof OTPFieldModel.Type

type OTPFieldUpdate = Component.Update<
  OTPFieldModel,
  OTPFieldMessage,
  OTPFieldEvents,
  OTPFieldProps
>

interface Rule {
  readonly accepted: string
  readonly rejected: RegExp
  readonly inputMode: OTPFieldInputMode
}

const rules: Record<OTPFieldValidationType, Rule | undefined> = {
  numeric: { accepted: "\\d", rejected: /[^\d]/g, inputMode: "numeric" },
  alpha: { accepted: "[a-zA-Z]", rejected: /[^a-zA-Z]/g, inputMode: "text" },
  alphanumeric: {
    accepted: "[a-zA-Z0-9]",
    rejected: /[^a-zA-Z0-9]/g,
    inputMode: "text"
  },
  none: undefined
}

const normalize = (
  text: string,
  length: number,
  type: OTPFieldValidationType
): readonly [characters: ReadonlyArray<string>, rejected: boolean] => {
  const stripped = text.replace(/\s/g, "")
  const rule = rules[type]
  const kept = rule === undefined
    ? stripped
    : stripped.replace(rule.rejected, "")
  const characters = Array.from(kept)
  return [
    characters.slice(0, length),
    stripped.length > kept.length || characters.length > length
  ]
}

const without = (
  characters: ReadonlyArray<string>,
  index: number
): ReadonlyArray<string> =>
  index < 0 || index >= characters.length
    ? characters
    : [...characters.slice(0, index), ...characters.slice(index + 1)]

interface Settings {
  readonly length: number
  readonly type: OTPFieldValidationType
  readonly stored: string
  readonly characters: ReadonlyArray<string>
  readonly value: string
  readonly disabled: boolean
  readonly readOnly: boolean
}

const storedOf = (props: OTPFieldProps): ReadonlyArray<string> =>
  normalize(
    Redacted.value(props.value),
    props.length,
    props.validationType ?? "numeric"
  )[0]

type Edit = NonNullable<OTPFieldModel["edit"]>

const startedFrom = (edit: Edit, stored: string): boolean =>
  Redacted.value(edit.before) === stored

const settingsOf = (
  props: OTPFieldProps,
  edit: OTPFieldModel["edit"] = null
): Settings => {
  const characters = storedOf(props)
  const stored = characters.join("")
  const unanswered = edit !== null && !edit.settled && startedFrom(edit, stored)
  const value = unanswered ? Redacted.value(edit.asked) : stored
  return {
    length: props.length,
    type: props.validationType ?? "numeric",
    stored,
    characters: unanswered ? Array.from(value) : characters,
    value,
    disabled: props.disabled === true,
    readOnly: props.readOnly === true
  }
}

const locked = (props: OTPFieldProps): boolean =>
  props.disabled === true || props.readOnly === true

const completes = (edit: Edit, length: number): boolean =>
  edit.reason === "input-paste" ||
  Array.from(Redacted.value(edit.before)).length !== length

const completed = (
  edit: OTPFieldModel["edit"],
  s: Settings
): OTPFieldEntryReason | null =>
  edit === null || edit.reason === null || startedFrom(edit, s.stored) ||
    s.characters.length !== s.length
    ? null
    : (edit.settled
        ? Redacted.value(edit.asked) === s.stored
        : completes(edit, s.length))
    ? edit.reason
    : null

const settle = (
  edit: OTPFieldModel["edit"],
  s: Settings
): OTPFieldModel["edit"] => {
  if (edit === null || !startedFrom(edit, s.stored)) return null
  if (edit.settled) return edit
  return edit.reason !== null &&
      Array.from(Redacted.value(edit.asked)).length === s.length &&
      completes(edit, s.length)
    ? UiStruct.evolve(edit, { settled: true })
    : null
}

const Slot = Html.ref("OTPFieldSlot", "input")
const HiddenInput = Html.ref("OTPFieldHiddenInput", "input")

const selectSlot = (index: number) =>
  HtmlCommand.select(
    Slot.at(index),
    () => OTPFieldMessage.CompletedSelectSlot()
  )

const focusSlot = (index: number) => [
  HtmlCommand.Focus.make({ ref: Slot.at(index) }).pipe(Command.asNoop),
  selectSlot(index)
]

const submit = HtmlCommand.RequestSubmit.make({ ref: HiddenInput }).pipe(
  Command.asNoop
)

const firstEmpty = (s: Settings): number =>
  Math.min(s.characters.length, s.length - 1)

// A Command moves focus and selects a slot's text a moment after the edit that asked for it, and
// a key pressed in between reaches the slot as it was. So the Model keeps the slot focus is on its
// way to, as `target`, until the last `selectSlot` it issued has run, and `moving` counts those.
const aim = (model: OTPFieldModel, index: number): OTPFieldModel =>
  UiStruct.evolve(model, { target: index, moving: (moving) => moving + 1 })

const moveTo = (model: OTPFieldModel, $: OTPFieldUpdate, index: number) =>
  $.set(aim(model, index)).run(...focusSlot(index))

const reselect = (model: OTPFieldModel, $: OTPFieldUpdate, index: number) =>
  $.set(aim(model, index)).run(selectSlot(index))

const aimedAt = (model: OTPFieldModel, s: Settings, index: number): number =>
  model.target === null || model.target === index
    ? index
    : Math.min(model.target, firstEmpty(s))

const InspectFirstSlot = Mount.make(
  "InspectFirstSlot",
  { args: { id: Schema.String } },
  (node: HTMLInputElement, { id }) =>
    Effect.sync(() => {
      const label = node.labels?.[0]
      // The label is the consumer's element. The other slots can only point at it by id.
      if (label !== undefined && label.id === "") label.id = id
      return {
        label: label?.id ?? null,
        android: isAndroid(node.ownerDocument.defaultView)
      }
    })
)

const settled = (model: OTPFieldModel, props: OTPFieldProps) => {
  const stored = storedOf(props)
  const edit = model.edit
  const stale = edit !== null && edit.settled &&
    !startedFrom(edit, stored.join(""))
  return Subscription.make(
    "settled",
    [model.edits, stored.length, stale],
    () => Stream.make(OTPFieldMessage.Settled())
  )
}

// A browser may send no blur event for an input disabled while it has
// focus, so the field reports the blur itself.
const disabledWhileFocused = Subscription.make(
  "disabledWhileFocused",
  Stream.make(OTPFieldMessage.DisabledWhileFocused())
)

const setValue = (
  model: OTPFieldModel,
  $: OTPFieldUpdate,
  s: Settings,
  characters: ReadonlyArray<string>,
  reason: OTPFieldUpdateReason,
  options: {
    readonly events?: ReadonlyArray<OTPFieldEvents> | undefined
    readonly focus?: number | undefined
    readonly focusWhenUnchanged?: boolean | undefined
  }
) => {
  const value = characters.join("")
  const entry = reason === "input-change" || reason === "input-paste"
    ? reason
    : null
  const edit = model.edit
  const unanswered = edit !== null && !edit.settled &&
    startedFrom(edit, s.stored)
  const unchanged = value === s.value
  const earlier = completed(edit, s)
  const again = unchanged && !unanswered && entry === "input-paste" &&
    characters.length === s.length
  const focus = !unchanged || options.focusWhenUnchanged === true
    ? options.focus
    : undefined
  return $.set(focus === undefined ? model : aim(model, focus))
    .evolve({
      edit: unchanged
        ? (unanswered
          ? UiStruct.evolve(edit, { reason: entry ?? edit.reason })
          : null)
        : {
          before: Redacted.make(s.stored),
          asked: Redacted.make(value),
          reason: entry,
          settled: false
        },
      edits: unchanged ? model.edits : model.edits + 1
    })
    .run(
      ...(focus === undefined ? [] : focusSlot(focus)),
      ...((earlier !== null || again) && $.props.autoSubmit === true
        ? [submit]
        : [])
    )
    .emit(
      ...(earlier === null
        ? []
        : [
          OTPFieldEvents.Completed({
            value: Redacted.make(s.stored),
            reason: earlier
          })
        ]),
      ...(options.events ?? []),
      ...(unchanged
        ? []
        : [OTPFieldEvents.Updated({ value: Redacted.make(value), reason })]),
      ...(again
        ? [
          OTPFieldEvents.Completed({
            value: Redacted.make(value),
            reason: "input-paste"
          })
        ]
        : [])
    )
}

const enter = (
  model: OTPFieldModel,
  $: OTPFieldUpdate,
  s: Settings,
  slot: number,
  shown: string,
  reason: OTPFieldEntryReason
) => {
  const own = s.characters[slot] ?? ""
  // Until its text is selected, the slot shows its own character before the one just typed.
  const unselected = reason === "input-change" && model.target !== null &&
    shown.length > own.length &&
    shown.startsWith(own)
  const text = unselected ? shown.slice(own.length) : shown
  const index = text === "" ? slot : aimedAt(model, s, slot)
  const [entered, rejected] = normalize(text, s.length, s.type)
  const events = rejected
    ? [OTPFieldEvents.Rejected({ value: Redacted.make(text), reason })]
    : []
  if (entered.length === 0) {
    if (reason === "input-paste") return $.set(model).emit(...events)
    if (text === "") {
      return setValue(
        model,
        $,
        s,
        without(s.characters, index),
        "input-clear",
        { events }
      )
    }
    return reselect(model, $, index).emit(...events)
  }
  const merged = [
    ...s.characters.slice(0, index),
    ...entered,
    ...s.characters.slice(index + entered.length)
  ]
  return setValue(
    model,
    $,
    s,
    normalize(merged.join(""), s.length, s.type)[0],
    reason,
    {
      events,
      focus: Math.min(index + entered.length, s.length - 1),
      focusWhenUnchanged: true
    }
  )
}

const navigationKeys = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End"
])
const editingKeys = new Set(["Backspace", "Delete"])

const pressKey = (
  $: OTPFieldUpdate,
  message: {
    readonly index: number
    readonly key: string
    readonly boundary: boolean
  },
  rtl: boolean
) => {
  if ($.props.disabled === true || $.model.composing !== null) return $.model
  const s = settingsOf($.props, $.model.edit)
  const { boundary, key } = message
  const index = aimedAt($.model, s, message.index)
  const end = firstEmpty(s)
  const go = (target: number) => moveTo($.model, $, clamp(target, 0, end))
  if (key === (rtl ? "ArrowRight" : "ArrowLeft")) {
    return go(boundary ? 0 : index - 1)
  }
  if (key === (rtl ? "ArrowLeft" : "ArrowRight")) {
    return go(boundary ? end : index + 1)
  }
  if (key === "Home" || key === "ArrowUp") return go(0)
  if (key === "End" || key === "ArrowDown") return go(end)
  if (s.readOnly) return $.model
  if (key === "Delete") {
    return setValue($.model, $, s, without(s.characters, index), "keyboard", {
      focus: index
    })
  }
  if (key !== "Backspace") return $.model
  if (boundary) return setValue($.model, $, s, [], "keyboard", { focus: 0 })
  const target = Math.max(0, index - 1)
  const removed = index < s.characters.length ? index : target
  return setValue($.model, $, s, without(s.characters, removed), "keyboard", {
    focus: target
  })
}

type SlotOf<B extends View.PartTarget<"input">> = ReturnType<B["attr"]>

const isNamed = (attrs: View.Element<any, any>["attrs"]): boolean =>
  attrs["aria-label"] !== undefined || attrs["aria-labelledby"] !== undefined

const named = <N extends View.Element<any, any>>(
  node: N,
  label: string | undefined
): N =>
  label === undefined || isNamed(node.attrs)
    ? node
    : { ...node, attrs: { ...node.attrs, "aria-labelledby": label } }

const checked = (
  node: View.Node<any, any>,
  label: (index: number) => string | undefined,
  slots: ReadonlyMap<string, number>,
  drawn: Set<number>
): View.Node<any, any> => {
  if (node._tag !== "Element") return node
  const index = node.owned?.reduce<number | undefined>(
    (found, layer) =>
      found ??
        (layer.refKey === undefined ? undefined : slots.get(layer.refKey)),
    undefined
  )
  if (index !== undefined) {
    if (drawn.has(index)) {
      throw new Error(
        "OTPField: the slot at index " + index + " was drawn twice"
      )
    }
    drawn.add(index)
    return named(node, label(index))
  }
  let children: Array<View.Node<any, any>> | undefined
  node.children.forEach((child, at) => {
    const next = checked(child, label, slots, drawn)
    if (next !== child) (children ??= node.children.slice())[at] = next
  })
  return children === undefined ? node : { ...node, children }
}

/**
 * A headless one-time code field. Call it with the consumer's `h`, the
 * `props`, an `onEmit` for its events, and a `view` closure that draws the
 * root with `otpField.root(h.div)` and, inside it, one
 * `otpField.input({ element: h.input, index })` for each slot.
 *
 * **Details**
 *
 * The parts also return `value`, a `Redacted<string>` of the code the slots
 * show, `length`, and `complete`, `filled`, `focused`, `disabled`,
 * `readOnly` and `required` as booleans, for markup that depends on them.
 *
 * The field's own attributes win over the ones the consumer set on the
 * builder before the part, including the ones a state leaves absent:
 *
 * - `root`: `role="group"`, `data-disabled`, `data-readonly`,
 *   `data-required`, `data-complete`, `data-filled` and `data-focused`
 * - `input`: the `value` property, `id` when the `id` prop is set,
 *   `inputmode`, `autocomplete`, `autocorrect`, `spellcheck`,
 *   `enterkeyhint`, `maxlength`, `tabindex`, `form`, `pattern`,
 *   `readonly`, `required`, `disabled`, `aria-disabled`, which it never
 *   sets, and the same data attributes as the root, with `data-filled` for
 *   the slot's own character
 *
 * A part writes them when it is applied, so an attribute the consumer
 * chains after the part is the consumer's to answer for. Two are left to
 * the consumer: a slot's own `type` is kept, and the field writes
 * `password` or `text` only on a slot with none; and a slot's
 * `aria-label` or `aria-labelledby` is kept, and the field names only a
 * slot with neither. A root with `aria-label` and no `aria-labelledby`
 * keeps its `id`, and gets one if it has none.
 *
 * A slot handles `input`, `compositionend`, `keydown`, `paste`,
 * `mousedown`, `focus` and `blur` on a layer of its own, so the
 * consumer's handlers for them still run. It cancels the keys it handles,
 * every paste, and the mouse press, which would otherwise put a caret
 * beside the character. A key held with Alt, and a navigation key held
 * with Shift, keep their default.
 *
 * The root has a mount, which reads its CSS `direction`. The field
 * follows the nearest `DirectionProvider` above it or, without one, that
 * direction, and swaps Left and Right in a right-to-left layout.
 *
 * History restore saves nothing of it: after Back, forward or a reload it
 * starts from `init`.
 *
 * @stability experimental
 * @category components
 * @since 0.1.0
 */
export const OTPField = Html.component({
  name: "OTPField",
  props: OTPFieldProps,
  model: OTPFieldModel,
  message: OTPFieldMessage,
  events: OTPFieldEvents,
  reads: {
    provider: { owner: DirectionProvider, optional: true }
  },
  restore: false
}).make({
  init: () => ({
    focused: false,
    focusedIndex: 0,
    target: null,
    moving: 0,
    composing: null,
    composed: null,
    edit: null,
    edits: 0,
    label: null,
    android: false,
    rtl: false
  }),
  update: {
    UpdatedSlot: ($, { composing, index, value }) => {
      if (locked($.props)) return $.model
      if ((composing && !$.model.android) || $.model.composing === index) {
        return $.evolve({ composing: index })
      }
      const s = settingsOf($.props, $.model.edit)
      const shown = Redacted.value(value)
      if ($.model.composed === null) {
        return enter($.model, $, s, index, shown, "input-change")
      }
      const next = UiStruct.evolve($.model, { composed: null })
      // Some browsers send one more `input` after `compositionend`, with the text that was just
      // entered or, once the slot is restored, the character it holds.
      const repeated = $.model.composed.index === index &&
        (shown === Redacted.value($.model.composed.text) ||
          shown === (s.characters[index] ?? ""))
      return repeated ? next : enter(next, $, s, index, shown, "input-change")
    },
    EndedComposition: ($, { index, value }) => {
      if ($.model.composing === null) return $.model
      const next = UiStruct.evolve($.model, {
        composing: null,
        composed: { index, text: value }
      })
      return locked($.props)
        ? next
        : enter(
          next,
          $,
          settingsOf($.props, $.model.edit),
          index,
          Redacted.value(value),
          "input-change"
        )
    },
    PastedText: ($, { index, text }) =>
      locked($.props)
        ? $.model
        : enter(
          $.model,
          $,
          settingsOf($.props, $.model.edit),
          index,
          Redacted.value(text),
          "input-paste"
        ),
    PressedKey: ($, message) =>
      pressKey($, message, rightToLeft($.reads.provider, $.model.rtl)),
    PressedSlot: (
      $,
      { index }
    ) => ($.props.disabled === true ? $.model : reselect($.model, $, index)),
    FocusedSlot: ($, { index }) => {
      if ($.props.disabled === true) return $.model
      const s = settingsOf($.props, $.model.edit)
      const next = UiStruct.evolve($.model, {
        focused: true,
        focusedIndex: index
      })
      // Focus passing through on its way to `target` is left alone.
      if ($.model.target !== null && $.model.target !== index) return next
      if (index > s.characters.length) {
        return moveTo(
          UiStruct.evolve($.model, { focused: true }),
          $,
          firstEmpty(s)
        )
      }
      return $.model.target === null ? reselect(next, $, index) : next
    },
    BlurredSlot: ($) => $.evolve({ focused: false, composed: null }),
    FocusedHiddenInput: ($) =>
      $.props.disabled === true ? $.model : moveTo($.model, $, 0),
    UpdatedHiddenInput: ($, { value }) => {
      if (locked($.props)) return $.model
      const s = settingsOf($.props, $.model.edit)
      const [entered, rejected] = normalize(
        Redacted.value(value),
        s.length,
        s.type
      )
      return setValue($.model, $, s, entered, "input-change", {
        events: rejected
          ? [OTPFieldEvents.Rejected({ value, reason: "input-change" })]
          : [],
        focus: entered.length === 0 ? undefined : entered.length - 1
      })
    },
    Settled: ($) => {
      const s = settingsOf($.props)
      const complete = completed($.model.edit, s)
      const edit = settle($.model.edit, s)
      const next = UiStruct.evolve($.model, { edit })
      const at = $.model.target ??
        ($.model.focused ? $.model.focusedIndex : null)
      const back = !s.disabled && at !== null && at > s.characters.length
      if (complete === null) return back ? moveTo(next, $, firstEmpty(s)) : next
      return $.set(next)
        .run(
          ...($.props.autoSubmit === true && !locked($.props) ? [submit] : [])
        )
        .emit(
          OTPFieldEvents.Completed({
            value: Redacted.make(s.stored),
            reason: complete
          })
        )
    },
    DisabledWhileFocused: ($) =>
      $.evolve({
        focused: false,
        target: null,
        composing: null,
        composed: null
      }),
    CompletedSelectSlot: ($) =>
      $.model.moving > 1
        ? $.evolve({ moving: (moving) => moving - 1 })
        : $.evolve({ moving: 0, target: null }),
    CompletedInspectFirstSlot: ($, { android, label }) =>
      $.evolve({ android, label }),
    FoundDirection: ($, { rtl }) => $.evolve({ rtl })
  },
  subscriptions: ({ model, props }) => [
    settled(model, props),
    model.focused && props.disabled === true && disabledWhileFocused
  ],
  parts: (p, model) => {
    const props = p.props
    if (!Number.isInteger(props.length) || props.length <= 0) {
      throw new Error(
        "OTPField: length is the number of slots, a positive whole number, and it was " +
          props.length
      )
    }
    const s = settingsOf(props)
    const { characters, disabled, length, readOnly, value } = s
    const rule = rules[s.type]
    const required = props.required === true
    const complete = characters.length === length
    const filled = characters.length > 0
    const focused = model.focused && !disabled
    const last = length - 1
    const active = focused ? Math.min(model.focusedIndex, last) : firstEmpty(s)
    const inputMode = props.inputMode ?? rule?.inputMode
    const autoComplete = props.autoComplete ?? "one-time-code"
    const slots = new Map(
      Array.from({ length }, (_, index) => [Slot.at(index).key, index])
    )
    // A slot's name is the group's name and its position, such as "Code 2
    // of 6". Hidden elements hold the positions, so they join the group's
    // name by id, whether that comes from ids or from text.
    const position = (index: number) => p.id("position", index)
    const positions = Array.from(
      { length },
      (_, index) =>
        new Html.Element<never>("span")
          .attrs({ id: position(index), hidden: "" })
          .children(index + 1 + " of " + length)
    )
    // A field with no name leaves its slots alone, so a `<label>` keeps
    // naming the first one until the field finds it.
    const slotLabel = (index: number) =>
      inherited === undefined ? undefined : inherited + " " + position(index)
    // Set once the root is built, to the ids that name the group.
    let inherited: string | undefined
    const state = <B extends Attributed<B>>(builder: B): B =>
      builder
        .attrs({
          "data-disabled": flag(disabled),
          "data-readonly": flag(readOnly),
          "data-required": flag(required),
          "data-complete": flag(complete),
          "data-focused": flag(focused)
        })
    const hiddenInput = p.part("input", (b) =>
      b.ref(HiddenInput)
        .attrs({
          type: "text",
          id: props.id !== undefined && props.name === undefined
            ? props.id + "-hidden-input"
            : undefined,
          name: props.name,
          form: props.form,
          autocomplete: autoComplete,
          inputmode: inputMode,
          minlength: String(length),
          maxlength: String(length),
          pattern: rule === undefined
            ? undefined
            : rule.accepted + "{" + length + "}",
          readonly: flag(readOnly),
          required: flag(required),
          "aria-hidden": "true",
          tabindex: "-1",
          style: visuallyHidden
        })
        .disabled(disabled)
        .value(value)
        .on("focus", OTPFieldMessage.FocusedHiddenInput())
        .on("input", ({ value }) =>
          OTPFieldMessage.UpdatedHiddenInput({ value: Redacted.make(value) })))
    const slot = p.part("input", (b, index: number) => {
      const character = characters[index] ?? ""
      const identified = props.id === undefined
        ? b
        : b.attr("id", index === 0 ? props.id : props.id + "-" + (index + 1))
      const first = index === 0
        ? identified.onMount(
          InspectFirstSlot({ id: p.id("label") }).pipe(
            Mount.map(OTPFieldMessage.CompletedInspectFirstSlot)
          )
        )
        : identified
      return state(first)
        .ref(Slot.at(index))
        .attrs({
          "data-filled": flag(character !== ""),
          inputmode: inputMode,
          autocomplete: index === 0 ? autoComplete : "off",
          autocorrect: "off",
          spellcheck: "false",
          enterkeyhint: index === last ? "done" : "next",
          // Only the first slot, so a password manager doesn't offer to fill each of the others.
          maxlength: index === 0 ? String(length) : undefined,
          tabindex: index === active ? "0" : "-1",
          form: props.form,
          pattern: rule === undefined ? undefined : rule.accepted + "{1}",
          readonly: flag(readOnly),
          required: flag(required),
          "aria-disabled": undefined
        })
        .disabled(disabled)
        .value(character)
        .on(
          "keydown",
          ({ alt, composing, ctrl, key, meta, shift }) =>
            composing || model.composing !== null ||
              // Alt keeps the browser's shortcuts, such as Back on Alt+Left,
              // and Shift keeps selecting text.
              alt || (shift && navigationKeys.has(key)) ||
              !(navigationKeys.has(key) || (!readOnly && editingKeys.has(key)))
              ? undefined
              : OTPFieldMessage.PressedKey({
                index,
                key,
                boundary: ctrl || meta
              }),
          { preventDefault: true }
        )
        .on("input", ({ composing, value }) =>
          OTPFieldMessage.UpdatedSlot({
            index,
            value: Redacted.make(value),
            composing
          }))
        .on("compositionend", ({ value }) =>
          OTPFieldMessage.EndedComposition({
            index,
            value: Redacted.make(value)
          }))
        .on(
          "paste",
          ({ text }) =>
            OTPFieldMessage.PastedText({ index, text: Redacted.make(text) }),
          {
            preventDefault: true
          }
        )
        // Only on the slot that has focus: a press elsewhere moves focus natively, at once, where a
        // Command would move it a moment later and lose a key typed right after the press.
        .on(
          "mousedown",
          () => (focused && model.focusedIndex === index
            ? OTPFieldMessage.PressedSlot({ index })
            : undefined),
          {
            preventDefault: true
          }
        )
        .on("focus", OTPFieldMessage.FocusedSlot({ index }))
        .on("blur", OTPFieldMessage.BlurredSlot({ index }))
        .forward((node) => {
          const typed = node.elementAttrs.type === undefined
            ? node.attr("type", props.mask === true ? "password" : "text")
            : node
          // Only a slot drawn inside another component finds a name here: that component renders after
          // the root is built. The root names the slots among its own children itself.
          const label = slotLabel(index)
          return label === undefined || isNamed(typed.elementAttrs)
            ? typed
            : typed.attr("aria-labelledby", label)
        })
    })
    return {
      value: Redacted.make(value),
      length,
      complete,
      filled,
      focused,
      disabled,
      readOnly,
      required,
      root: p.part((b) =>
        state(b)
          .attrs({ role: "group", "data-filled": flag(filled) })
          .onMount(
            TrackDirection({ css: p.reads.provider === undefined }).pipe(
              Mount.map((rtl) => OTPFieldMessage.FoundDirection({ rtl }))
            )
          )
          .forward((node) => {
            const built = View.build(node, [
              ...positions,
              hiddenInput(input())
            ])
            const own = built.attrs["aria-labelledby"]
            const label = model.label ?? undefined
            // A root named by `aria-label` names the slots through its id.
            const id =
              own === undefined && built.attrs["aria-label"] !== undefined
                ? (built.attrs.id ?? p.id("group"))
                : undefined
            const root = id === undefined || built.attrs.id === id
              ? built
              : { ...built, attrs: { ...built.attrs, id } }
            inherited = own ?? id ?? label
            return named(
              checked(root, slotLabel, slots, new Set()) as typeof root,
              label
            )
          })
      ),
      input: View.wrapPart(
        slot,
        <B extends View.PartTarget<"input">>(
          { element, index }: { readonly element: B; readonly index: number }
        ): SlotOf<B> => {
          if (!Number.isInteger(index) || index < 0 || index >= length) {
            throw new Error(
              "OTPField: no slot at index " + index + " in a field of " +
                length + " slots"
            )
          }
          return slot(element, index)
        }
      )
    }
  }
})
