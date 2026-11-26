/**
 * A controlled slider with one thumb or several. Pass the current value as
 * `value`, a number or an array of numbers, and update it when the slider
 * emits `Moved`. Your view supplies the markup; the component adds ARIA and
 * data attributes, handles pointer and keyboard input, and places the native
 * range input inside each thumb. It is a headless component, because it
 * keeps the thumb being dragged and the focused one.
 *
 * **Anatomy**
 *
 * | Part        | Element                                        |
 * | :---------- | :--------------------------------------------- |
 * | `root`      | any element, `role="group"`                     |
 * | `value`     | `<output>`                                      |
 * | `control`   | `<div>`, the area that takes pointer presses    |
 * | `track`     | any element inside the control                 |
 * | `indicator` | any element inside the track, the filled range |
 * | `thumb`     | any element that can contain an `<input>`, with the `<input type="range">` inside |
 *
 * Each part takes the consumer's builder and returns it, so the consumer
 * goes on chaining and adds children with `.children(...)`. `thumb` takes
 * two builders, `{ element, input, index }`: `element` is the thumb you
 * see and drag, and `input` is the `<input>` that takes focus, the keys,
 * the screen reader and the form value. The thumb sets the input up as a
 * visually hidden range input and puts it inside `element`, before the
 * children you chain afterward. Because you hand over the input's builder,
 * what you set on it stays: its `name`, its `aria-label`, or a
 * `Field`'s `field.control` or `field.member`. `index` picks the value the thumb shows, and is
 * required when `value` is an array.
 *
 * The kit sets no layout. `thumb` gets `--slider-thumb-position` and
 * `indicator` gets `--slider-indicator-start` and
 * `--slider-indicator-size`, each a percentage along the control, from the
 * left or, when vertical, from the bottom. A horizontal right-to-left slider
 * has `min` on the right; its percentages still count from the left. The hidden input fills the
 * thumb with `position: absolute`, so give the thumb a position. For
 * dragging by touch, give the control `touch-action: none`.
 *
 * **Naming**
 *
 * Naming each thumb is the consumer's job, on its input. A `Field` names a
 * single thumb and adds a description, an error and the validity state:
 * draw its input with `field.control(h.input)`. A disabled field disables the
 * input, but the slider's other parts follow the `disabled` prop, so pass
 * `disabled: field.disabled` as well.
 *
 * In a `Field`, a range slider is the field's group. Draw the root with
 * `slider.root(field.group(h.div))`, the field's `field.legend` to name it, and each
 * thumb's input with `field.member(h.input)` and an `aria-label` of its own,
 * such as "Minimum". Each input then points at the description and the
 * error. The field is focused while either thumb has focus, and touched
 * once focus leaves the slider. Don't pass `field.control` to more than one
 * input, since that gives two elements one `id`.
 *
 * **Data attributes**
 *
 * On every part, each present with an empty value or absent, except
 * `data-orientation`:
 *
 * - `data-orientation`: `horizontal` or `vertical`
 * - `data-dragging`: a thumb is being dragged
 * - `data-disabled`
 *
 * `thumb` also gets `data-index`. A `Field`'s data attributes, such as
 * `data-invalid` and `data-touched`, go on its parts and on the input
 * `field.control` or `field.member` decorates.
 *
 * **Keyboard**
 *
 * Tab moves between the thumbs' inputs. On a focused thumb:
 *
 * - ArrowRight and ArrowUp add `step`; ArrowLeft and ArrowDown take it
 *   away, with Left and Right swapped on a horizontal right-to-left slider
 * - Shift with an arrow, PageUp and PageDown move by `largeStep`
 * - Home and End go to `min` and `max`, or, with several thumbs, as far
 *   as the neighbouring thumb allows
 *
 * A key moves to a value a step from `min` lands on, as the native input
 * does, so with `step: 3` and `largeStep: 5` PageUp from 0 goes to 6. A
 * `max` between two steps can't be reached: the last step below it is the
 * top. A `value` off the grid shows at its nearest step, as the native
 * input shows it, and `values` and the events report that step.
 *
 * A key held with Alt, Ctrl or Meta is left to the browser. The slider
 * follows the nearest `DirectionProvider` above it or, without one, the
 * control's CSS `direction`. The input's `keydown` handler cancels the
 * default of the keys it handles only, so the input gets every `keydown`
 * while it has focus, and an ancestor's `keydown` handler never sees them.
 * To handle them, add a `keydown` handler to the input's builder.
 *
 * **Pointer**
 *
 * A press with the primary button on a thumb drags it from where it was
 * grabbed. A press elsewhere on the control moves the nearest thumb there
 * and drags it. The drag follows the pointer outside the control until it
 * is released. The thumb being dragged gets focus without a focus ring,
 * and the first key pressed on it shows the ring.
 *
 * **Events**
 *
 * `Moved` reports each value the user moves to, during a drag and for each
 * key. `Committed` reports the value once the user is done: when the
 * pointer is released and after each key. Both carry a number when
 * `value` is a number, and an array otherwise.
 *
 * **Forms**
 *
 * Each input submits its value under the `name` you give it. Place the
 * slider inside the form that should submit it.
 *
 * **Example** (A labelled volume slider whose value lives in the consumer's Model)
 *
 * ```ts import.meta.vitest
 * import { UiSchema } from "@effect/ui"
 * import { Html, HtmlServer } from "@effect/ui/html"
 * import { Field, Slider } from "@effect/ui-kit"
 * import { Effect, Schema } from "effect"
 *
 * const PlayerMessage = UiSchema.TaggedEnum({ MovedVolume: { value: Schema.Number } })
 *
 * const Player = Html.component({
 *   name: "Player",
 *   model: Schema.Struct({ volume: Schema.Number }),
 *   message: PlayerMessage
 * }).make({
 *   init: () => ({ volume: 40 }),
 *   update: {
 *     MovedVolume: ($, { value }) => $.evolve({ volume: value })
 *   },
 *   view: (h, model) =>
 *     Field(h, {
 *       view: (field) =>
 *         field.root(h.div).children(
 *           field.label(h.label).children("Volume"),
 *           Slider(h, {
 *             props: { value: model.volume, disabled: field.disabled },
 *             onEmit: {
 *               Moved: ({ value }) => PlayerMessage.MovedVolume({ value: value as number }),
 *               Committed: () => undefined
 *             },
 *             view: (slider) =>
 *               slider.root(h.div.class("slider")).children(
 *                 slider.control(h.div.class("control")).children(
 *                   slider.track(h.div.class("track")).children(
 *                     slider.indicator(h.div.class("indicator")),
 *                     slider.thumb({
 *                       element: h.div.class("thumb"),
 *                       input: field.control(h.input).attr("name", "volume")
 *                     })
 *                   )
 *                 )
 *               )
 *           })
 *         )
 *     })
 * })
 *
 * // The thumb holds a range input at the value, which the Field's label names.
 * const { html } = await Effect.runPromise(HtmlServer.renderToHtml(Player, {}))
 * const input = /<input id="([^"]+)" name="volume" type="range"[^>]*>/.exec(html)
 * if (input === null || !html.includes('<label for="' + input[1] + '"')) throw new Error("the range input isn't labelled")
 * if (!input[0].includes('value="40"') || !html.includes("--slider-thumb-position:40%")) throw new Error("the thumb isn't at 40")
 * ```
 *
 * @stability experimental
 * @since 0.1.0
 */
import type * as Component from "@effect/ui/Component"
import * as Html from "@effect/ui/html/Html"
import * as Mount from "@effect/ui/Mount"
import * as UiSchema from "@effect/ui/UiSchema"
import * as UiStruct from "@effect/ui/UiStruct"
import * as View from "@effect/ui/View"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { DirectionProvider } from "./DirectionProvider.ts"
import {
  type Attributed,
  flag,
  ownStyle,
  withStyle
} from "./internal/attributes.ts"
import {
  type Directed,
  rightToLeft,
  watchDirectionWhile
} from "./internal/direction.ts"
import { focusVisible } from "./internal/dom.ts"
import { clamp } from "./internal/range.ts"
import type { WithRequirements } from "./internal/requirements.ts"

// One number, or one per thumb.
const Value = Schema.Union([Schema.Number, Schema.Array(Schema.Number)])

type Value = typeof Value.Type

/**
 * Props for the slider's value, its range and how its thumbs move.
 *
 * **Details**
 *
 * - `value`: one number for one thumb, or an array with one number per
 *   thumb. The slider sorts the values and keeps them within `min` and
 *   `max`.
 * - `min` and `max`: `0` and `100` by default.
 * - `step`: `1` by default. A drag lands on a multiple of it from `min`.
 * - `largeStep`: what Shift with an arrow, PageUp and PageDown move by,
 *   `10` by default.
 * - `minStepsBetweenValues`: how many steps apart two thumbs stay, `0` by
 *   default. Part of a step counts as a whole one.
 * - `orientation`: `"horizontal"` by default.
 * - `thumbCollisionBehavior`: what a thumb dragged into another does.
 *   `"push"`, the default, pushes it along; `"swap"` passes it, and the
 *   drag goes on with the other thumb; `"none"` stops at it.
 * - `disabled`: disables every input, and the slider emits nothing.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const SliderProps = Schema.Struct({
  value: Value,
  min: Schema.optional(Schema.Number),
  max: Schema.optional(Schema.Number),
  step: Schema.optional(Schema.Number),
  largeStep: Schema.optional(Schema.Number),
  minStepsBetweenValues: Schema.optional(Schema.Number),
  orientation: Schema.optional(Schema.Literals(["horizontal", "vertical"])),
  thumbCollisionBehavior: Schema.optional(
    Schema.Literals(["push", "swap", "none"])
  ),
  disabled: Schema.optional(Schema.Boolean)
})

/**
 * The props of a `Slider`.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type SliderProps = typeof SliderProps.Type

/**
 * What a slider emits. `Moved` asks for each value the user moves to, and
 * `Committed` reports the value once a drag or a key press is done. `value` is
 * a number when the `value` prop is, and an array otherwise.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const SliderEvents = UiSchema.TaggedEnum({
  Moved: { value: Value },
  Committed: { value: Value }
})

/**
 * What a `Slider` emits.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type SliderEvents = typeof SliderEvents.Type

// The pointer facts come from the control's mount, the rest from a thumb's
// range input.
const SliderMessage = UiSchema.TaggedEnum({
  PressedPointer: {
    index: Schema.Number,
    fraction: Schema.Number,
    onThumb: Schema.Boolean
  },
  MovedPointer: { fraction: Schema.Number },
  ReleasedPointer: {},
  PressedKey: {
    index: Schema.Number,
    key: Schema.String,
    shift: Schema.Boolean
  },
  UpdatedThumb: { index: Schema.Number, value: Schema.String },
  FocusedThumb: { index: Schema.Number },
  BlurredThumb: { index: Schema.Number },
  FoundDirection: { rtl: Schema.Boolean }
})

type SliderMessage = typeof SliderMessage.Type

// `active`: the thumb whose input has focus, or -1. `pressed`: the thumb
// the pointer is dragging, or -1. `pressedValues`: the values when the press
// began, which a swap restores. `moved`: the last value the press reported,
// which its release commits. `rtl`: the control's CSS `direction` is
// right-to-left.
const SliderModel = Schema.Struct({
  active: Schema.Number,
  pressed: Schema.Number,
  pressedValues: Schema.Array(Schema.Number),
  moved: Schema.NullOr(Value),
  rtl: Schema.Boolean
})

type SliderModel = typeof SliderModel.Type

type SliderUpdate =
  & Component.Update<SliderModel, SliderMessage, SliderEvents, SliderProps>
  & Directed

// -- the value arithmetic ----------------------------------------------------

const decimals = (value: number): number => {
  if (value === 0 || !Number.isFinite(value)) return 0
  // A small number prints as `1e-8`.
  if (Math.abs(value) < 1) {
    const [mantissa, exponent] = value.toExponential().split("e-")
    return (mantissa!.split(".")[1]?.length ?? 0) + Number(exponent ?? 0)
  }
  return value.toString().split(".")[1]?.length ?? 0
}

// The nearest value a step from `min` lands on, without floating-point dust.
const roundToStep = (value: number, step: number, min: number): number =>
  Number(
    (Math.round((value - min) / step) * step + min).toFixed(
      Math.max(decimals(step), decimals(min))
    )
  )

// The step nearest `value`, between min and the top of the grid.
const snap = (value: number, step: number, min: number, top: number): number =>
  clamp(roundToStep(value, step, min), min, top)

// A sum or difference of values without floating-point dust, as `0.3 - 0.1`
// gives `0.19999999999999998`.
const exact = (value: number): number => Number(value.toFixed(12))

const sameValues = (
  a: ReadonlyArray<number>,
  b: ReadonlyArray<number>
): boolean => a.length === b.length && a.every((value, i) => value === b[i])

interface Settings {
  readonly min: number
  readonly max: number
  // The highest value on the step grid. The native input never goes past
  // it, so neither does the slider when `max` is off the grid.
  readonly top: number
  readonly step: number
  readonly largeStep: number
  readonly gap: number
  readonly vertical: boolean
  // Horizontal in a right-to-left layout, so `min` is on the right.
  readonly reversed: boolean
  readonly collision: "push" | "swap" | "none"
  // The value is an array, so the events carry one.
  readonly array: boolean
  // In order, each on the step grid between min and top.
  readonly values: ReadonlyArray<number>
  readonly disabled: boolean
}

const settingsOf = (props: SliderProps, rtl: boolean): Settings => {
  const min = props.min ?? 0
  const max = props.max ?? 100
  const step = props.step ?? 1
  const array = typeof props.value !== "number"
  const raw: ReadonlyArray<number> = typeof props.value === "number"
    ? [props.value]
    : props.value
  const top = max <= min
    ? min
    : roundToStep(min + Math.floor(exact((max - min) / step)) * step, step, min)
  return {
    min,
    max,
    top,
    step,
    largeStep: props.largeStep ?? 10,
    // Whole steps, so a thumb the gap from another stays on the grid.
    gap: exact(
      step * Math.max(0, Math.ceil(exact(props.minStepsBetweenValues ?? 0)))
    ),
    vertical: props.orientation === "vertical",
    reversed: rtl && props.orientation !== "vertical",
    collision: props.thumbCollisionBehavior ?? "push",
    array,
    // At the step the native input shows, so the input, its ARIA value
    // and what a key starts from agree.
    values: raw.map((value) => snap(value, step, min, top)).sort((a, b) =>
      a - b
    ),
    disabled: props.disabled === true
  }
}

// Every pair of neighbours at least `gap` apart.
const keepsGap = (s: Settings, values: ReadonlyArray<number>): boolean =>
  values.every((value, i) => i === 0 || exact(value - values[i - 1]!) >= s.gap)

// Where a value sits between min and max, in percent.
const percentOf = (s: Settings, value: number): number =>
  s.max === s.min ? 0 : ((value - s.min) / (s.max - s.min)) * 100

// Where a value sits from the left, or from the bottom when vertical.
const positionOf = (s: Settings, value: number): number =>
  s.reversed ? 100 - percentOf(s, value) : percentOf(s, value)

// The values with the thumb at `index` moved to `next`, pushing the
// thumbs it meets along and keeping them `gap` apart. A thumb pushed back
// past where it started, in `initial`, stops there.
const pushed = (
  s: Settings,
  values: ReadonlyArray<number>,
  index: number,
  next: number,
  initial: ReadonlyArray<number> = values
): Array<number> => {
  const out = values.slice()
  const last = out.length - 1
  out[index] = clamp(
    next,
    s.min + index * s.gap,
    s.top - (last - index) * s.gap
  )
  for (let i = index + 1; i <= last; i++) {
    const low = out[i - 1]! + s.gap
    const high = s.top - (last - i) * s.gap
    let candidate = Math.max(out[i]!, low)
    if (initial[i]! < candidate) candidate = Math.max(initial[i]!, low)
    out[i] = clamp(candidate, low, high)
  }
  for (let i = index - 1; i >= 0; i--) {
    const high = out[i + 1]! - s.gap
    const low = s.min + i * s.gap
    let candidate = Math.min(out[i]!, high)
    if (initial[i]! > candidate) candidate = Math.min(initial[i]!, high)
    out[i] = clamp(candidate, low, high)
  }
  return out.map((value) => exact(value))
}

// The values once the pointer puts the dragged thumb at `next`, by the
// collision rule, and the thumb dragged from then on: another one after a
// swap.
const collide = (
  s: Settings,
  initial: ReadonlyArray<number>,
  index: number,
  next: number
): { readonly values: ReadonlyArray<number>; readonly index: number } => {
  const values = s.values
  if (s.collision === "push") {
    return { values: pushed(s, values, index, next), index }
  }
  const candidate = values.slice()
  const previous = values[index - 1]
  const following = values[index + 1]
  const kept = exact(
    clamp(
      next,
      previous === undefined ? s.min : previous + s.gap,
      following === undefined ? s.top : following - s.gap
    )
  )
  candidate[index] = kept
  if (s.collision === "none") return { values: candidate, index }
  const epsilon = 1e-7
  const forward = next > values[index]! && following !== undefined &&
    next >= following - epsilon
  const backward = next < values[index]! && previous !== undefined &&
    next <= previous + epsilon
  if (!forward && !backward) return { values: candidate, index }
  // The dragged thumb takes its neighbour's place, and the neighbour goes
  // back to where the dragged one stopped.
  const target = forward ? index + 1 : index - 1
  const baseline = candidate.map((
    value,
    i
  ) => (i === index ? kept : initial[i] ?? value))
  const adjusted = pushed(
    s,
    candidate,
    target,
    forward
      ? Math.max(next, candidate[target]!)
      : Math.min(next, candidate[target]!),
    baseline
  )
  const neighbour = forward ? target - 1 : target + 1
  const before = adjusted[neighbour - 1]
  const after = adjusted[neighbour + 1]
  const low = Math.max(
    before === undefined ? s.min : before + s.gap,
    s.min + neighbour * s.gap
  )
  const high = Math.min(
    after === undefined ? s.top : after - s.gap,
    s.top - (adjusted.length - 1 - neighbour) * s.gap
  )
  adjusted[neighbour] = exact(clamp(kept, low, high))
  return { values: adjusted, index: target }
}

// The value at a point along the control, from 0 at the left or the bottom
// to 1 at the right or the top.
const valueAt = (s: Settings, fraction: number): number =>
  snap(
    s.min + (s.reversed ? 1 - fraction : fraction) * (s.max - s.min),
    s.step,
    s.min,
    s.top
  )

// The values with one thumb's input set to `next`, kept `gap` from its
// neighbours and within the range. A thumb with no such place stays.
const withThumb = (
  s: Settings,
  index: number,
  next: number
): ReadonlyArray<number> => {
  const previous = s.values[index - 1]
  const following = s.values[index + 1]
  const low = previous === undefined ? s.min : exact(previous + s.gap)
  const high = following === undefined ? s.top : exact(following - s.gap)
  if (low > high) return s.values
  const values = s.values.slice()
  values[index] = clamp(next, low, high)
  return values
}

const valueOf = (s: Settings, values: ReadonlyArray<number>): Value =>
  s.array ? values : values[0]!

// The value to report for `values`, or nothing when they break the gap or
// change nothing.
const changed = (
  s: Settings,
  values: ReadonlyArray<number>
): Value | undefined =>
  keepsGap(s, values) && !sameValues(values, s.values)
    ? valueOf(s, values)
    : undefined

// -- update ------------------------------------------------------------------

// A key or the input set a thumb: report the new value and commit it at once.
const setThumb = (
  $: SliderUpdate,
  s: Settings,
  index: number,
  next: number
) => {
  if (
    s.disabled || index < 0 || index >= s.values.length || Number.isNaN(next)
  ) return $.model
  const value = changed(s, withThumb(s, index, next))
  return value === undefined
    ? $.model
    : $.emit(SliderEvents.Moved({ value }), SliderEvents.Committed({ value }))
}

const sliderKeys = new Set([
  "ArrowUp",
  "ArrowRight",
  "ArrowDown",
  "ArrowLeft",
  "PageUp",
  "PageDown",
  "Home",
  "End"
])

// Keys with Alt, Ctrl or Meta are the browser's, such as Alt with an arrow
// going back.
const handles = (
  key: string,
  alt: boolean,
  ctrl: boolean,
  meta: boolean
): boolean => !alt && !ctrl && !meta && sliderKeys.has(key)

// Where an arrow, Page or Home and End key puts a thumb.
const keyed = (
  s: Settings,
  index: number,
  key: string,
  shift: boolean
): number | undefined => {
  const current = s.values[index]
  if (current === undefined) return undefined
  // `withThumb` stops them at a neighbouring thumb.
  if (key === "Home") return s.min
  if (key === "End") return s.top
  const direction = key === "ArrowUp" || key === "PageUp"
    ? 1
    : key === "ArrowDown" || key === "PageDown"
    ? -1
    : key === "ArrowRight"
    ? s.reversed ? -1 : 1
    : key === "ArrowLeft"
    ? s.reversed ? 1 : -1
    : 0
  if (direction === 0) return undefined
  const increment = shift || key === "PageUp" || key === "PageDown"
    ? s.largeStep
    : s.step
  // On the step grid, where the native input would put it, and at least a
  // step on when `largeStep` rounds to none.
  const next = roundToStep(current + increment * direction, s.step, s.min)
  return next * direction > current * direction
    ? next
    : roundToStep(current + s.step * direction, s.step, s.min)
}

// The pointer put the thumb the Model drags at `fraction` of the control.
const drag = (
  model: SliderModel,
  $: SliderUpdate,
  s: Settings,
  fraction: number
) => {
  const target = valueAt(s, fraction)
  const moved = s.values.length > 1
    ? collide(
      s,
      model.pressedValues.length === s.values.length
        ? model.pressedValues
        : s.values,
      model.pressed,
      target
    )
    : { values: [target], index: 0 }
  const next = UiStruct.evolve(model, { pressed: moved.index })
  const value = changed(s, moved.values)
  return value === undefined
    ? $.set(next)
    : $.set(next).evolve({ moved: value }).emit(SliderEvents.Moved({ value }))
}

const released: SliderModel = {
  active: -1,
  pressed: -1,
  pressedValues: [],
  moved: null,
  rtl: false
}

const settingsIn = (
  $: { readonly props: SliderProps; readonly model: SliderModel } & Directed
): Settings => settingsOf($.props, rightToLeft($.reads.provider, $.model.rtl))

// -- the pointer -------------------------------------------------------------

interface Thumb {
  readonly element: HTMLElement
  readonly input: HTMLInputElement
  readonly index: number
}

// The thumbs in the control, by the index each one carries.
const thumbsIn = (node: HTMLElement): Array<Thumb> =>
  Array.from(node.querySelectorAll<HTMLElement>("[data-index]"))
    .flatMap((element) => {
      const input = element.querySelector<HTMLInputElement>("input[type=range]")
      return input === null
        ? []
        : [{ element, input, index: Number(element.dataset.index) }]
    })
    .sort((a, b) => a.index - b.index)

const focusEvents = ["blur", "focusout", "focus", "focusin"] as const

const midpointOf = (element: Element, vertical: boolean): number => {
  const rect = element.getBoundingClientRect()
  return vertical ? rect.top + rect.height / 2 : rect.left + rect.width / 2
}

// Presses on the control, then the pointer's moves and its release
// anywhere in the document, the keys on a thumb a press focused, and the
// control's CSS `direction`. A
// press on a thumb drags it from where it was grabbed. A press on the track
// drags the nearest thumb. `pressed`: the thumb the Model drags, which gets
// focus. `vertical`: measure along the height, from the bottom. `css`:
// watch the CSS `direction`, with no `DirectionProvider` to decide it.
const TrackPointer = Mount.makeStream(
  "TrackPointer",
  {
    args: {
      pressed: Schema.Number,
      disabled: Schema.Boolean,
      vertical: Schema.Boolean,
      css: Schema.Boolean
    }
  },
  (node: HTMLElement, args, changes) =>
    Stream.callback<SliderMessage>((queue) =>
      Effect.gen(function*() {
        const document = node.ownerDocument
        let { disabled, vertical } = args
        let pointer: number | null = null
        // Where the pointer grabbed the thumb, from its middle.
        let offset = 0
        const along = (event: PointerEvent): number =>
          vertical ? event.clientY : event.clientX
        // A live declaration, so it's read once.
        const style = getComputedStyle(node)
        const inset = (side: string): number =>
          (Number.parseFloat(
            style.getPropertyValue("border-" + side + "-width")
          ) || 0) +
          (Number.parseFloat(style.getPropertyValue("padding-" + side)) || 0)
        // Along the control's content box, so its padding and border are
        // outside the track.
        const fractionAt = (event: PointerEvent): number => {
          const rect = node.getBoundingClientRect()
          const start = inset(vertical ? "top" : "left")
          const end = inset(vertical ? "bottom" : "right")
          const length = (vertical ? rect.height : rect.width) - start - end
          const at = along(event) - offset
          return length <= 0
            ? 0
            : (vertical ? rect.bottom - at - end : at - rect.left - start) /
              length
        }
        // The document's listeners for the press under way.
        let listening: AbortController | undefined
        const readDirection = yield* watchDirectionWhile(
          node,
          args,
          changes,
          (rtl) =>
            Queue.offerUnsafe(queue, SliderMessage.FoundDirection({ rtl }))
        )
        const release = () => {
          if (pointer === null) return
          if (node.hasPointerCapture?.(pointer)) {
            node.releasePointerCapture(pointer)
          }
          pointer = null
          listening?.abort()
          Queue.offerUnsafe(queue, SliderMessage.ReleasedPointer())
        }
        const onMove = (event: PointerEvent) => {
          if (event.pointerId !== pointer) return
          // Another element took the pointer's release.
          if (event.buttons === 0) return release()
          Queue.offerUnsafe(
            queue,
            SliderMessage.MovedPointer({ fraction: fractionAt(event) })
          )
        }
        const onUp = (event: PointerEvent) => {
          if (event.pointerId === pointer) release()
        }
        const onDown = (event: PointerEvent) => {
          if (
            disabled || pointer !== null || event.button !== 0 ||
            event.defaultPrevented
          ) return
          const thumbs = thumbsIn(node)
          const hit = thumbs.find((thumb) =>
            thumb.element.contains(event.target as Node | null)
          )
          if (hit?.input.disabled === true) return
          let index = -1
          offset = 0
          if (hit !== undefined) {
            index = hit.index
            offset = along(event) - midpointOf(hit.element, vertical)
          } else {
            let nearest = Infinity
            for (const thumb of thumbs) {
              if (thumb.input.disabled) continue
              const distance = Math.abs(
                along(event) - midpointOf(thumb.element, vertical)
              )
              // On a tie the later thumb wins, so thumbs stacked at the start
              // can be pulled apart.
              if (distance <= nearest) {
                nearest = distance
                index = thumb.index
              }
            }
          }
          if (index < 0 || Number.isNaN(index)) return
          // Keeps focus where it is and the text unselected. The thumb is
          // focused once the Model drags it.
          event.preventDefault()
          pointer = event.pointerId
          node.setPointerCapture?.(event.pointerId)
          listening = new AbortController()
          const { signal } = listening
          // The press may come before focus, so the direction is read first.
          readDirection()
          document.addEventListener("pointermove", onMove, { signal })
          document.addEventListener("pointerup", onUp, { signal })
          document.addEventListener("pointercancel", onUp, { signal })
          Queue.offerUnsafe(
            queue,
            SliderMessage.PressedPointer({
              index,
              fraction: fractionAt(event),
              onThumb: hit !== undefined
            })
          )
        }
        // A key on a thumb a press focused shows the focus ring, as Tab
        // would: the input is focused again, visibly. That blur and focus
        // stop at the window, so neither the slider nor a Field sees focus
        // leave. A thumb that lost focus to the key's handlers keeps it lost.
        const onKey = (event: KeyboardEvent) => {
          const input = event.target as HTMLInputElement
          const view = document.defaultView
          if (
            view === null || input.disabled ||
            !handles(event.key, event.altKey, event.ctrlKey, event.metaKey)
          ) return
          if (!input.matches(":focus") || focusVisible(input)) return
          if (!thumbsIn(node).some((thumb) => thumb.input === input)) return
          const hush = (focus: Event) => {
            if (focus.target === input) focus.stopImmediatePropagation()
          }
          for (const name of focusEvents) {
            view.addEventListener(name, hush, { capture: true })
          }
          try {
            input.blur()
            input.focus(
              { preventScroll: true, focusVisible: true } as FocusOptions
            )
          } finally {
            for (const name of focusEvents) {
              view.removeEventListener(name, hush, { capture: true })
            }
          }
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            node.addEventListener("pointerdown", onDown)
            node.addEventListener("keydown", onKey)
          }),
          () =>
            Effect.sync(() => {
              node.removeEventListener("pointerdown", onDown)
              node.removeEventListener("keydown", onKey)
              listening?.abort()
            })
        )
        yield* Stream.runForEach(changes, (next) =>
          Effect.sync(() => {
            disabled = next.disabled
            vertical = next.vertical
            // A slider disabled mid-drag lets go.
            if (disabled) {
              release()
            }
            if (next.pressed < 0) return
            const input = thumbsIn(node).find((thumb) =>
              thumb.index === next.pressed
            )?.input
            if (input !== undefined && document.activeElement !== input) {
              input.focus(
                { preventScroll: true, focusVisible: false } as FocusOptions
              )
            }
          })).pipe(Effect.forkScoped)
      })
    )
)

// -- parts -------------------------------------------------------------------

// The thumb's element with its input as a child, so it needs what the input
// needs too.
type ThumbOf<
  B extends View.PartTarget<string>,
  I extends View.PartTarget<"input">
> = WithRequirements<
  ReturnType<B["attr"]>,
  View.Requirements<I>
>

// Visually hidden, the size of the thumb, so a screen reader's focus ring
// matches the thumb.
const hidden =
  "position:absolute;width:100%;height:100%;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0"

/**
 * A headless slider. Call it with the consumer's `h`, the `props`, and a
 * `view` closure that draws the parts, with a thumb for each value inside
 * the control.
 *
 * **Details**
 *
 * The parts also return `values`, the sorted values, `dragging`,
 * `disabled`, `orientation` and `activeThumbIndex`, the thumb whose
 * input has focus or `-1`, for markup that depends on them.
 *
 * `thumb({ element, input, index })` returns `element` with the input
 * inside it. The other parts each return the builder they were given. A
 * handler the consumer adds runs after the slider's own.
 *
 * The slider's own attributes win over the ones the consumer set on the
 * builder before the part: `role` on `root`, the data attributes on every
 * part, and on the input `type`, `min`, `max`, `step`, `value`,
 * `disabled`, `aria-orientation`, `aria-valuenow` and `aria-disabled`,
 * which it removes. The thumb's and indicator's CSS variables and the
 * input's hiding style are added to the consumer's `style`, after it.
 * Every other attribute stays the consumer's.
 *
 * A thumb whose `index` has no value throws when the view renders.
 *
 * History restore saves nothing of it: after Back, forward or a reload it
 * starts from `init`.
 *
 * @stability experimental
 * @category components
 * @since 0.1.0
 */
export const Slider = Html.component({
  name: "Slider",
  props: SliderProps,
  model: SliderModel,
  message: SliderMessage,
  events: SliderEvents,
  reads: {
    provider: { owner: DirectionProvider, optional: true }
  },
  restore: false
}).make({
  init: () => released,
  update: {
    PressedPointer: ($, { fraction, index, onThumb }) => {
      const s = settingsIn($)
      if (s.disabled || index < 0 || index >= s.values.length) return $.model
      // Thumbs stacked at the end are dragged from the first of them, so
      // they can be pulled apart.
      let thumb = index
      if (onThumb) {
        while (
          thumb > 0 && s.values[thumb]! >= s.top &&
          s.values[thumb - 1]! >= s.top
        ) thumb--
      }
      const next = UiStruct.evolve($.model, {
        pressed: thumb,
        pressedValues: s.values,
        moved: null
      })
      // A thumb grabbed where it is doesn't move until the pointer does.
      return onThumb ? next : drag(next, $, s, fraction)
    },
    MovedPointer: ($, { fraction }) =>
      $.model.pressed < 0 || $.props.disabled === true
        ? $.model
        : drag($.model, $, settingsIn($), fraction),
    ReleasedPointer: ($) => {
      if ($.model.pressed < 0) return $.model
      const next = UiStruct.evolve($.model, {
        pressed: -1,
        pressedValues: [],
        moved: null
      })
      return $.model.moved === null || $.props.disabled === true
        ? next
        : $.set(next).emit(SliderEvents.Committed({ value: $.model.moved }))
    },
    PressedKey: ($, { index, key, shift }) => {
      const s = settingsIn($)
      const next = keyed(s, index, key, shift)
      return next === undefined ? $.model : setThumb($, s, index, next)
    },
    UpdatedThumb: ($, { index, value }) =>
      value.trim() === ""
        ? $.model
        : setThumb($, settingsIn($), index, Number(value)),
    FocusedThumb: ($, { index }) => $.evolve({ active: index }),
    BlurredThumb: ($, { index }) =>
      $.model.active === index ? $.evolve({ active: -1 }) : $.model,
    FoundDirection: ($, { rtl }) => $.evolve({ rtl })
  },
  parts: (p, model) => {
    const s = settingsIn({ props: p.props, model, reads: p.reads })
    const dragging = model.pressed >= 0 && !s.disabled
    const orientation = p.props.orientation ?? "horizontal"
    const state = <B extends Attributed<B>>(builder: B): B =>
      builder
        .attrs({
          "data-dragging": flag(dragging),
          "data-orientation": orientation,
          "data-disabled": flag(s.disabled)
        })
    const low = s.values.length > 1 ? percentOf(s, s.values[0]!) : 0
    const high = s.values.length === 0
      ? 0
      : percentOf(s, s.values[s.values.length - 1]!)
    const start = s.reversed ? 100 - high : low
    const end = s.reversed ? 100 - low : high
    const inputPart = p.part("input", (b, index: number) => {
      const value = s.values[index]!
      return b.attrs({
        type: "range",
        min: String(s.min),
        max: String(s.max),
        step: String(s.step),
        "aria-orientation": orientation,
        "aria-valuenow": String(value),
        // Never set: the native `disabled` reports it.
        "aria-disabled": undefined
      })
        .disabled(s.disabled)
        .value(String(value))
        .on(
          "keydown",
          ({ alt, ctrl, key, meta, shift }) =>
            handles(key, alt, ctrl, meta)
              ? SliderMessage.PressedKey({ index, key, shift })
              : undefined,
          // Only for the keys the slider handles: a key it doesn't keeps its
          // default, such as Tab.
          { preventDefault: true }
        )
        .on(
          "input",
          ({ value }) => SliderMessage.UpdatedThumb({ index, value })
        )
        .on("focus", SliderMessage.FocusedThumb({ index }))
        .on("blur", SliderMessage.BlurredThumb({ index }))
        .forward(ownStyle(
          hidden + (s.vertical ? ";writing-mode:vertical-lr" : "")
        ))
    })
    const thumbPart = p.part((
      b,
      index: number,
      input: View.Content<unknown, any>
    ) =>
      state(b)
        .attr("data-index", String(index))
        .forward((node) =>
          node.attr(
            "style",
            withStyle(
              node.elementAttrs.style,
              "--slider-thumb-position:" + positionOf(s, s.values[index]!) + "%"
            )
          )
        )
        .children(input as never)
    )
    return {
      values: s.values,
      dragging,
      disabled: s.disabled,
      orientation,
      activeThumbIndex: model.active,
      root: p.part((b) => state(b).attr("role", "group")),
      value: p.part("output", (b) => state(b).attr("aria-live", "off")),
      control: p.part("div", (b) =>
        state(b).onMount(
          TrackPointer({
            pressed: dragging ? model.pressed : -1,
            disabled: s.disabled,
            vertical: s.vertical,
            css: p.reads.provider === undefined
          })
        )),
      track: p.part(state),
      indicator: p.part((b) =>
        state(b).forward((node) =>
          node.attr(
            "style",
            withStyle(
              node.elementAttrs.style,
              "--slider-indicator-start:" + start +
                "%;--slider-indicator-size:" + (end - start) + "%"
            )
          )
        )
      ),
      thumb: View.wrapPart(
        thumbPart,
        <B extends View.PartTarget<string>, I extends View.PartTarget<"input">>(
          { element, index, input }: {
            readonly element: B
            readonly input: I
            readonly index?: number | undefined
          }
        ): ThumbOf<B, I> => {
          if (index === undefined && Array.isArray(p.props.value)) {
            throw new Error(
              "Slider: a thumb of a slider whose value is an array needs its index"
            )
          }
          const at = index ?? 0
          if (!Number.isInteger(at) || at < 0 || at >= s.values.length) {
            throw new Error("Slider: no value for the thumb at index " + at)
          }
          return thumbPart(element, at, inputPart(input, at)) as ThumbOf<B, I>
        }
      )
    }
  }
})
