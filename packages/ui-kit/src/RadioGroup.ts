/**
 * A controlled group of radio buttons. Pass the selected value as `value`,
 * the group's options as `items`, and update `value` when the group emits
 * `Picked`. Your view supplies the markup; the component owns roving focus,
 * arrow-key navigation, ARIA and data attributes, indicator transitions and
 * the form field.
 *
 * `RadioGroup` is a headless component: it keeps the highlighted radio and
 * the indicator transitions, and moves focus with a Command.
 *
 * **Anatomy**
 *
 * | Part        | Element                                          |
 * | :---------- | :----------------------------------------------- |
 * | `root`      | `<div role="radiogroup">`                        |
 * | `radio`     | `<button role="radio">` for each item            |
 * | `indicator` | `<span>` inside a radio, shown while it's picked |
 *
 * `root` takes the consumer's builder and returns it; `radio` and
 * `indicator` take an options object with `element` and `value` (and
 * `keepMounted` on `indicator`). `indicator` returns `undefined` while its
 * radio is unchecked and not leaving, unless `keepMounted` is `true`, so
 * chain children on it with `?.`:
 * `radioGroup.indicator({ element: h.span, value })?.children(...)`.
 *
 * When `name` is set, a value is picked, and neither the group nor the
 * checked item is disabled, `root` appends a hidden `<input>` after any
 * children already on the div and before children chained afterward.
 *
 * Name the group with `aria-label`, `aria-labelledby`, or a `Field`'s
 * `field.group` and `field.legend`. Name each radio with a wrapping
 * `<label>`, a sibling `<label for>`, `aria-label`, or text inside the
 * button. Inside a `Field`, apply `field.group` on the root, `field.member`
 * on each radio, and pass `disabled: field.disabled` and
 * `invalid: field.invalid`: `radio` removes the `aria-invalid` that
 * `field.member` sets so validity lives on the `radiogroup`.
 *
 * **Data attributes**
 *
 * Each present with an empty value or absent:
 *
 * - `root`: `data-disabled`, `data-readonly`, `data-required`
 * - `radio` and `indicator`: `data-checked` / `data-unchecked`,
 *   `data-disabled`, `data-readonly`, `data-required`
 * - `indicator`: `data-starting-style` for the first frame after its radio
 *   becomes checked, and `data-ending-style` while it stays mounted for exit
 *   animations after its radio becomes unchecked
 *
 * **Keyboard**
 *
 * One radio in the group sits in the tab order (`tabindex="0"`); the rest
 * have `tabindex="-1"`. Down and Right move focus to the next enabled radio
 * and pick it; Up and Left move to the previous one, wrapping at the ends.
 * In a right-to-left layout, Left and Right swap.
 * In a read-only group or on a read-only item, arrow keys move focus and
 * the tab stop without emitting `Picked`. Space picks the focused radio
 * through the native button click; Enter is cancelled. Arrow keys with
 * Ctrl, Alt or Meta held are left alone.
 *
 * **Example** (A labelled radio group whose value lives in the consumer's Model)
 *
 * ```ts import.meta.vitest
 * import { UiSchema } from "@effect/ui"
 * import { Html, HtmlServer } from "@effect/ui/html"
 * import { RadioGroup } from "@effect/ui-kit"
 * import { Effect, Schema } from "effect"
 *
 * const storage = [
 *   { value: "ssd", label: "SSD" },
 *   { value: "hdd", label: "HDD" }
 * ]
 *
 * const PickerMessage = UiSchema.TaggedEnum({ PickedStorage: { value: Schema.String } })
 *
 * const Picker = Html.component({
 *   name: "Picker",
 *   model: Schema.Struct({ storage: Schema.NullOr(Schema.String) }),
 *   message: PickerMessage
 * }).make({
 *   init: () => ({ storage: "ssd" }),
 *   update: {
 *     PickedStorage: ($, { value }) => $.evolve({ storage: value })
 *   },
 *   view: (h, model) =>
 *     RadioGroup(h, {
 *       props: { value: model.storage, items: storage, name: "storage" },
 *       onEmit: { Picked: ({ value }) => PickerMessage.PickedStorage({ value }) },
 *       view: (radioGroup) =>
 *         radioGroup.root(h.div.class("group").attr("aria-label", "Storage")).children(
 *           storage.map(({ label, value }) =>
 *             h.label.children(
 *               radioGroup.radio({ element: h.button.class("radio"), value }).children(
 *                 radioGroup.indicator({ element: h.span.class("dot"), value })
 *               ),
 *               label
 *             )
 *           )
 *         )
 *     })
 * })
 *
 * const { html } = await Effect.runPromise(HtmlServer.renderToHtml(Picker, {}))
 * if (!/<div class="group"[^>]* role="radiogroup"/.test(html)) throw new Error("the root isn't a styled radiogroup")
 * if (!/<input type="hidden" name="storage" value="ssd"/.test(html)) throw new Error("the hidden input is missing")
 * ```
 *
 * @stability experimental
 * @since 0.1.0
 */
import * as Command from "@effect/ui/Command"
import * as Html from "@effect/ui/html/Html"
import * as HtmlCommand from "@effect/ui/html/HtmlCommand"
import * as Mount from "@effect/ui/Mount"
import * as Subscription from "@effect/ui/Subscription"
import * as UiSchema from "@effect/ui/UiSchema"
import * as View from "@effect/ui/View"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { DirectionProvider } from "./DirectionProvider.ts"
import { type Attributed, flag } from "./internal/attributes.ts"
import { rightToLeft, watchDirectionWhile } from "./internal/direction.ts"
import { field } from "./internal/field.ts"
import { keyed } from "./internal/list.ts"
import { frameOf, whenFinished } from "./internal/transition.ts"
import * as ListNavigation from "./ListNavigation.ts"

/**
 * One option in a `RadioGroup`.
 *
 * **Details**
 *
 * - `value`: unique string identifying the radio in the group.
 * - `disabled`: disables this radio, skips it during arrow-key navigation
 *   and prevents it from submitting a form value.
 * - `readOnly`: keeps this radio focusable while preventing clicks and
 *   arrow keys from picking it.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const RadioGroupItem = Schema.Struct({
  value: Schema.String,
  disabled: Schema.optional(Schema.Boolean),
  readOnly: Schema.optional(Schema.Boolean)
})

/**
 * One option in a `RadioGroup`.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type RadioGroupItem = typeof RadioGroupItem.Type

/**
 * Props for controlling a `RadioGroup` and the value it submits.
 *
 * **Details**
 *
 * - `value`: the currently picked radio's `value`, or `null` when none is
 *   picked. Required: the consumer owns it.
 * - `items`: the radios in navigation order, each with its `value` and
 *   optional `disabled` and `readOnly` flags.
 * - `disabled`: disables every radio in the group and prevents form
 *   submission.
 * - `readOnly`: keeps radios focusable and navigable with arrow keys while
 *   preventing any pick from emitting `Picked`.
 * - `required`: sets `aria-required` on the root and `data-required` on
 *   every part.
 * - `invalid`: sets `aria-invalid` on the root.
 * - `name` and `form`: the hidden form input's attributes when a non-disabled
 *   radio is picked.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const RadioGroupProps = Schema.Struct({
  value: Schema.NullOr(Schema.String),
  items: Schema.Array(RadioGroupItem),
  disabled: Schema.optional(Schema.Boolean),
  readOnly: Schema.optional(Schema.Boolean),
  required: Schema.optional(Schema.Boolean),
  invalid: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String),
  form: Schema.optional(Schema.String)
})

/**
 * The props of a `RadioGroup`.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type RadioGroupProps = typeof RadioGroupProps.Type

/**
 * `Picked` asks for the radio the user chose. Store `value` and pass it
 * back as the `value` prop to update the group.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const RadioGroupEvents = UiSchema.TaggedEnum({
  Picked: { value: Schema.String }
})

/**
 * What a `RadioGroup` emits.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type RadioGroupEvents = typeof RadioGroupEvents.Type

const RadioGroupModel = Schema.Struct({
  highlighted: Schema.NullOr(Schema.String),
  current: Schema.NullOr(Schema.String),
  settled: Schema.NullOr(Schema.String),
  mounted: Schema.Array(Schema.String),
  leaving: Schema.Array(Schema.String),
  // The root's CSS `direction` is right-to-left.
  rtl: Schema.Boolean
})

const RadioGroupMessage = UiSchema.TaggedEnum({
  ClickedRadio: { value: Schema.String },
  FocusedRadio: { value: Schema.String },
  PressedArrow: { value: Schema.String, direction: Schema.Literals([1, -1]) },
  PressedEnter: {},
  SyncedValue: { value: Schema.NullOr(Schema.String) },
  MountedIndicator: { value: Schema.String },
  UnmountedIndicator: { value: Schema.String },
  StartedIndicator: { value: Schema.String },
  EndedIndicator: { value: Schema.String },
  FoundDirection: { rtl: Schema.Boolean }
})

type RadioGroupMessage = typeof RadioGroupMessage.Type

type RadioGroupModel = typeof RadioGroupModel.Type

const Radio = Html.ref("RadioGroupRadio", "button")

const focusRadio = (value: string) =>
  HtmlCommand.Focus.make({ ref: Radio.at(value) }).pipe(Command.asNoop)

const synced = (value: string | null) =>
  Subscription.make(
    "synced",
    [value],
    () => Stream.make(RadioGroupMessage.SyncedValue({ value }))
  )

const TrackIndicatorArgs = Schema.Struct({
  value: Schema.String,
  checked: Schema.Boolean,
  starting: Schema.Boolean,
  ending: Schema.Boolean
})

const groupSend = new WeakMap<
  HTMLElement,
  (message: RadioGroupMessage) => void
>()

const TrackGroup = Mount.makeStream(
  "TrackGroup",
  { args: { css: Schema.Boolean } },
  (node: HTMLDivElement, args, changes) =>
    Stream.callback<RadioGroupMessage>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          groupSend.set(node, (message) => Queue.offerUnsafe(queue, message))
        }),
        () =>
          Effect.sync(() => {
            groupSend.delete(node)
          })
      ).pipe(
        Effect.andThen(
          watchDirectionWhile(
            node,
            args,
            changes,
            (rtl) =>
              Queue.offerUnsafe(
                queue,
                RadioGroupMessage.FoundDirection({ rtl })
              )
          )
        )
      )
    )
)

const TrackIndicator = Mount.makeStream(
  "TrackIndicator",
  { args: TrackIndicatorArgs },
  (node: HTMLSpanElement, args, changes) =>
    Stream.callback<RadioGroupMessage>((queue) => {
      const frame = frameOf(node.ownerDocument.defaultView)
      const send = (message: RadioGroupMessage) =>
        Queue.offerUnsafe(queue, message)
      const group = node.closest<HTMLElement>("[role=radiogroup]")
      let current = args
      let generation = 0
      const start = () => {
        const mine = ++generation
        frame(() => {
          if (
            mine === generation && node.isConnected && current.checked &&
            current.starting
          ) {
            send(RadioGroupMessage.StartedIndicator({ value: current.value }))
          }
        })
      }
      const leave = () => {
        const mine = ++generation
        frame(() =>
          whenFinished(
            () => [node],
            frame,
            () => mine === generation && node.isConnected,
            () =>
              send(RadioGroupMessage.EndedIndicator({ value: current.value }))
          )
        )
      }
      const onChange = (next: typeof TrackIndicatorArgs.Type) => {
        const previous = current
        current = next
        if (
          next.checked && next.starting &&
          (!previous.checked || !previous.starting)
        ) start()
        else if (
          !next.checked &&
          (previous.checked || (next.ending && !previous.ending))
        ) leave()
        else if (next.checked && !previous.checked) generation++
      }
      return Effect.acquireRelease(
        Effect.sync(() => {
          send(RadioGroupMessage.MountedIndicator({ value: current.value }))
          if (current.checked && current.starting) start()
          else if (!current.checked && current.ending) leave()
        }).pipe(
          Effect.tap(() =>
            Effect.forkScoped(
              Stream.runForEach(changes, (next) =>
                Effect.sync(() => onChange(next)))
            )
          )
        ),
        () =>
          Effect.sync(() => {
            generation++
            if (group !== null) {
              groupSend.get(group)?.(
                RadioGroupMessage.UnmountedIndicator({ value: current.value })
              )
            }
          })
      )
    })
)

interface ItemState {
  readonly checked: boolean
  readonly disabled: boolean
  readonly readOnly: boolean
}

const itemState = <B extends Attributed<B>>(
  builder: B,
  state: ItemState,
  required: boolean
): B =>
  builder.attrs({
    "data-checked": flag(state.checked),
    "data-unchecked": flag(!state.checked),
    "data-disabled": flag(state.disabled),
    "data-readonly": flag(state.readOnly),
    "data-required": flag(required)
  })

const itemOf = (
  items: ReadonlyArray<RadioGroupItem>,
  value: string
): RadioGroupItem | undefined => items.find((item) => item.value === value)

const picks = (props: RadioGroupProps, item: RadioGroupItem): boolean =>
  props.readOnly !== true && item.readOnly !== true &&
  props.value !== item.value

const without = (
  values: ReadonlyArray<string>,
  value: string
): ReadonlyArray<string> =>
  values.includes(value) ? values.filter((other) => other !== value) : values

const withValue = (
  values: ReadonlyArray<string>,
  value: string
): ReadonlyArray<string> => values.includes(value) ? values : [...values, value]

type KeyedButton = View.PartTarget<"button"> & {
  readonly key: (key: string) => View.PartTarget<"button">
}

/**
 * A headless radio group. Call it with the consumer's `h`, the `props`,
 * `onEmit`, and a `view` closure that draws `radioGroup.root(h.div)` with
 * `radioGroup.radio({ element: h.button, value })` and optional
 * `radioGroup.indicator({ element: h.span, value })` children.
 *
 * **Details**
 *
 * The parts object also exposes `value`, `disabled`, `readOnly`,
 * `required` and `invalid` for markup that depends on the group's state.
 *
 * Each part's attributes win over values the consumer set on the builder
 * before applying the part, including attributes a state leaves absent: on
 * `root`, `role`, `aria-required`, `aria-disabled`, `aria-readonly`,
 * `aria-invalid` and the data attributes; on `radio`, `type`, `role`,
 * `aria-checked`, `aria-disabled`, `aria-invalid`, `disabled`, `tabindex`
 * and the data attributes; on `indicator`, `aria-hidden="true"`, the radio's
 * data attributes, `data-starting-style` and `data-ending-style`.
 * The hidden indicator's content stays out of the radio's accessible name.
 *
 * `radio` and `indicator` throw when given a `value` that is not in
 * `items`. The group follows the nearest `DirectionProvider` above it or,
 * without one, the root's CSS `direction`.
 *
 * History restore saves nothing of the group's transient focus or indicator
 * transition state: after Back, forward or a reload it starts from `init`.
 *
 * @stability experimental
 * @category components
 * @since 0.1.0
 */
export const RadioGroup = Html.component({
  name: "RadioGroup",
  props: RadioGroupProps,
  model: RadioGroupModel,
  message: RadioGroupMessage,
  events: RadioGroupEvents,
  reads: {
    provider: { owner: DirectionProvider, optional: true }
  },
  restore: false
}).make({
  init: ({ props }) => ({
    highlighted: null,
    current: props.value,
    settled: props.value,
    mounted: [],
    leaving: [],
    rtl: false
  }),
  update: {
    ClickedRadio: ($, { value }) => {
      const item = itemOf($.props.items, value)
      if ($.props.disabled === true || !ListNavigation.available(item)) {
        return $.model
      }
      const highlighted = $.evolve({ highlighted: value })
      return picks($.props, item)
        ? highlighted.emit(RadioGroupEvents.Picked({ value }))
        : highlighted
    },
    FocusedRadio: ($, { value }) =>
      $.props.disabled === true ||
        !ListNavigation.available(itemOf($.props.items, value))
        ? $.model
        : $.evolve({ highlighted: value }),
    PressedArrow: ($, { direction, value }) => {
      const source = itemOf($.props.items, value)
      if ($.props.disabled === true || !ListNavigation.available(source)) {
        return $.model
      }
      const enabled = $.props.items.filter(ListNavigation.available)
      const at = enabled.indexOf(source)
      const target =
        enabled[ListNavigation.step(at, enabled.length - 1, direction, "wrap")]
      if (target === undefined) return $.model
      const moved = $.evolve({ highlighted: target.value }).run(
        focusRadio(target.value)
      )
      return source.readOnly !== true && picks($.props, target)
        ? moved.emit(RadioGroupEvents.Picked({ value: target.value }))
        : moved
    },
    PressedEnter: ($) => $.model,
    SyncedValue: ($, { value }) => {
      if ($.model.current === value) return $.evolve({ highlighted: null })
      const prev = $.model.current
      let leaving = prev !== null && $.model.mounted.includes(prev)
        ? withValue($.model.leaving, prev)
        : $.model.leaving
      if (value !== null) leaving = without(leaving, value)
      const settled = $.model.settled === value ? value : null
      return $.evolve({ highlighted: null, current: value, settled, leaving })
    },
    MountedIndicator: ($, { value }) =>
      $.evolve({ mounted: (mounted) => withValue(mounted, value) }),
    UnmountedIndicator: ($, { value }) =>
      $.evolve({
        settled: $.model.settled === value ? null : $.model.settled,
        mounted: (mounted) => without(mounted, value),
        leaving: (leaving) => without(leaving, value)
      }),
    StartedIndicator: ($, { value }) =>
      $.props.value !== value
        ? $.model
        : $.evolve({
          settled: value,
          leaving: (leaving) => without(leaving, value)
        }),
    EndedIndicator: ($, { value }) =>
      $.props.value === value
        ? $.model
        : $.evolve({
          settled: $.model.settled === value ? null : $.model.settled,
          leaving: (leaving) => without(leaving, value)
        }),
    FoundDirection: ($, { rtl }) => $.evolve({ rtl })
  },
  subscriptions: ({ props }) => [synced(props.value)],
  parts: (p, model) => {
    const props = p.props
    const disabled = props.disabled === true
    const readOnly = props.readOnly === true
    const required = props.required === true
    const invalid = props.invalid === true
    const rtl = rightToLeft(p.reads.provider, model.rtl)
    const byValue = new Map(props.items.map((item) => [item.value, item]))
    const stateOf = (value: string) => {
      const item = byValue.get(value)
      if (item === undefined) {
        throw new Error(
          "RadioGroup: no item with value " + JSON.stringify(value)
        )
      }
      const checked = props.value === value
      return {
        checked,
        disabled: disabled || item.disabled === true,
        readOnly: readOnly || item.readOnly === true,
        starting: checked && model.settled !== value,
        ending: !checked && (
          model.leaving.includes(value) ||
          (model.mounted.includes(value) &&
            (model.current === value || model.settled === value))
        )
      }
    }
    const tabStop = disabled
      ? null
      : [model.highlighted, props.value].find((value) =>
        value !== null && ListNavigation.available(byValue.get(value))
      ) ??
        props.items.find(ListNavigation.available)?.value ??
        null
    const checkedItem = props.value === null
      ? undefined
      : byValue.get(props.value)
    const hidden = field({
      checked: checkedItem !== undefined,
      disabled: disabled || checkedItem?.disabled === true,
      name: props.name,
      value: checkedItem?.value,
      form: props.form
    })

    const radioPart = keyed(p.part("button", (b, value: string) => {
      const state = stateOf(value)
      return itemState(b, state, required)
        .ref(Radio.at(value))
        .attrs({
          type: "button",
          role: "radio",
          "aria-checked": String(state.checked),
          "aria-disabled": undefined,
          "aria-invalid": undefined,
          tabindex: value === tabStop ? "0" : "-1"
        })
        .disabled(state.disabled)
        .on("click", RadioGroupMessage.ClickedRadio({ value }))
        .on("focus", RadioGroupMessage.FocusedRadio({ value }))
        .on("keydown", ({ alt, ctrl, key, meta }) => {
          if (key === "Enter") return RadioGroupMessage.PressedEnter()
          if (ctrl || alt || meta) return undefined
          if (key === "ArrowDown") {
            return RadioGroupMessage.PressedArrow({ value, direction: 1 })
          }
          if (key === "ArrowUp") {
            return RadioGroupMessage.PressedArrow({ value, direction: -1 })
          }
          if (key === "ArrowRight") {
            return RadioGroupMessage.PressedArrow({
              value,
              direction: rtl ? -1 : 1
            })
          }
          if (key === "ArrowLeft") {
            return RadioGroupMessage.PressedArrow({
              value,
              direction: rtl ? 1 : -1
            })
          }
          return undefined
        }, { preventDefault: true })
    }))

    const indicatorPart = p.part("span", (b, value: string) => {
      const { checked, ending, starting, ...state } = stateOf(value)
      return itemState(b, { checked, ...state }, required)
        .attrs({
          "aria-hidden": "true",
          "data-starting-style": flag(starting),
          "data-ending-style": flag(ending)
        })
        .onMount(TrackIndicator({ value, checked, starting, ending }))
    })

    return {
      value: props.value,
      disabled,
      readOnly,
      required,
      invalid,
      root: p.part("div", (b) =>
        b
          .attrs({
            role: "radiogroup",
            "aria-required": required ? "true" : undefined,
            "aria-disabled": disabled ? "true" : undefined,
            "aria-readonly": readOnly ? "true" : undefined,
            "aria-invalid": invalid ? "true" : undefined,
            "data-disabled": flag(disabled),
            "data-readonly": flag(readOnly),
            "data-required": flag(required)
          })
          .children(hidden)
          .onMount(TrackGroup({ css: p.reads.provider === undefined }))),
      radio: View.wrapPart(
        radioPart,
        <B extends KeyedButton>(
          { element, value }: { readonly element: B; readonly value: string }
        ) => radioPart(element, value)
      ),
      indicator: View.wrapPart(
        indicatorPart,
        <B extends View.PartTarget<"span">>(
          { element, keepMounted, value }: {
            readonly element: B
            readonly value: string
            readonly keepMounted?: boolean | undefined
          }
        ): ReturnType<B["attr"]> | undefined => {
          const built = indicatorPart(element, value)
          const { checked, ending } = stateOf(value)
          return checked || ending || keepMounted === true ? built : undefined
        }
      )
    }
  }
})
