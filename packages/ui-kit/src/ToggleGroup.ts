/**
 * A row of toggle buttons that share one value: the values of the pressed
 * ones, such as text alignment in a toolbar.
 *
 * `ToggleGroup` is a headless component. It keeps which item holds the tab
 * stop, and moves focus between the items with the arrow keys through a
 * Command. The value is the consumer's: it comes in as the `value` prop,
 * and the group emits `Toggled` with the value the user asked for.
 *
 * **Anatomy**
 *
 * | Part   | Element                     |
 * | :----- | :-------------------------- |
 * | `root` | `<div>`                     |
 * | `item` | `<button>`, one for each item |
 *
 * `root` takes the consumer's builder and returns it, so the consumer goes
 * on chaining and adds the items with `.children(...)`. `item` takes
 * `{ element, value }`, the item's `<button>` and the `value` of one entry
 * in the `items` prop, and returns the builder. A `value` that isn't in
 * `items` fails the render. Neither part adds markup.
 *
 * An item writes the same attributes as `Toggle`, so don't stack `Toggle`
 * on it. Naming an item is the consumer's job, as for `Toggle`: text inside
 * it, or an `aria-label` on the button.
 *
 * **Data attributes**
 *
 * Each present with an empty value or absent, except `data-orientation`,
 * which holds the orientation:
 *
 * - `root`: `data-orientation`, `data-disabled` and `data-multiple`
 * - `item`: `data-pressed` and `data-disabled`
 *
 * **Keyboard**
 *
 * Only one item is in the Tab order: the one focused last, or else the
 * first enabled item. A key handler on each item moves focus:
 *
 * | Key          | Action                                  |
 * | :----------- | :-------------------------------------- |
 * | Right, Left  | next and previous item, horizontally    |
 * | Down, Up     | next and previous item, vertically      |
 * | Home, End    | first and last enabled item             |
 * | Space, Enter | press the item, from the native button  |
 *
 * The arrow keys follow `orientation`: a horizontal group ignores Down and
 * Up, and a vertical one Right and Left. They skip disabled items, and with `loopFocus` they wrap from the last
 * item to the first and back. In a right-to-left layout, Left and Right
 * swap. A key held with Alt, Ctrl, Meta or Shift does nothing.
 *
 * **Usage**
 *
 * The `items` prop lists every item in the order they are drawn, so the
 * group can move focus without reading the page. Draw one `item` for each
 * entry.
 *
 * Inside a `Toolbar`, the group leaves the tab stop and the arrow keys to
 * the toolbar, and is disabled with it. Stack each item inside a toolbar
 * button with the same value:
 * `toolbar.button({ element: toggleGroup.item({ element: h.button, value }), value })`.
 * An item is disabled with its toolbar item, by the item's entry, its group
 * or the toolbar.
 *
 * **Example** (Text alignment, one choice at a time)
 *
 * ```ts import.meta.vitest
 * import { UiSchema } from "@effect/ui"
 * import { Html, HtmlServer } from "@effect/ui/html"
 * import { ToggleGroup } from "@effect/ui-kit"
 * import { Effect, Schema } from "effect"
 *
 * const EditorMessage = UiSchema.TaggedEnum({ ToggledAlign: { value: Schema.Array(Schema.String) } })
 *
 * const alignments = ["left", "center", "right"]
 *
 * const Editor = Html.component({
 *   name: "Editor",
 *   model: Schema.Struct({ align: Schema.Array(Schema.String) }),
 *   message: EditorMessage
 * }).make({
 *   init: () => ({ align: ["left"] }),
 *   update: { ToggledAlign: (_, { value }) => ({ align: value }) },
 *   view: (h, model) =>
 *     ToggleGroup(h, {
 *       props: { value: model.align, items: alignments.map((value) => ({ value })) },
 *       onEmit: ({ value }) => EditorMessage.ToggledAlign({ value }),
 *       view: (toggleGroup) =>
 *         toggleGroup.root(h.div.class("alignment").attr("aria-label", "Text alignment")).children(
 *           alignments.map((value) =>
 *             toggleGroup.item({ element: h.button.class("tool").attr("aria-label", "Align " + value), value })
 *           )
 *         )
 *     })
 * })
 *
 * // The left item is pressed, and holds the one tab stop.
 * const { html } = await Effect.runPromise(HtmlServer.renderToHtml(Editor, {}))
 * if (!/<div class="alignment"[^>]* role="group"/.test(html)) throw new Error("the root isn't a group")
 * if (!/aria-label="Align left"[^>]* aria-pressed="true"[^>]* tabindex="0"/.test(html)) {
 *   throw new Error("the left item isn't pressed with the tab stop")
 * }
 * ```
 *
 * @stability experimental
 * @since 0.1.0
 */
import * as Command from "@effect/ui/Command"
import * as Html from "@effect/ui/html/Html"
import * as HtmlCommand from "@effect/ui/html/HtmlCommand"
import * as Mount from "@effect/ui/Mount"
import * as UiSchema from "@effect/ui/UiSchema"
import * as Schema from "effect/Schema"
import { DirectionProvider } from "./DirectionProvider.ts"
import { flag, pressedAttrs } from "./internal/attributes.ts"
import { rightToLeft, TrackDirection } from "./internal/direction.ts"
import { valued } from "./internal/list.ts"
import * as ListNavigation from "./ListNavigation.ts"
import { Toolbar } from "./Toolbar.ts"

/**
 * The direction a toggle group's items run in, which picks its arrow keys.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const ToggleGroupOrientation = Schema.Literals([
  "horizontal",
  "vertical"
])

/**
 * The direction a toggle group's items run in.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type ToggleGroupOrientation = typeof ToggleGroupOrientation.Type

/**
 * One item of a toggle group: the `value` its `item` part is drawn with,
 * and whether it is disabled.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const ToggleGroupItem = Schema.Struct({
  value: Schema.String,
  disabled: Schema.optional(Schema.Boolean)
})

/**
 * One item of a toggle group.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type ToggleGroupItem = typeof ToggleGroupItem.Type

/**
 * Props for the state of a `ToggleGroup`.
 *
 * **Details**
 *
 * - `value`: the values of the pressed items. Required: the consumer owns
 *   it.
 * - `items`: every item, in the order they are drawn. Required. A disabled
 *   item ignores clicks and is skipped by the arrow keys.
 * - `disabled`: disables every item.
 * - `multiple`: lets several items be pressed at once. Off by default, so
 *   pressing an item releases the others.
 * - `orientation`: `"horizontal"` by default, which moves with Right and
 *   Left, or `"vertical"`, which moves with Down and Up.
 * - `loopFocus`: the arrow keys wrap from the last item to the first and
 *   back. On by default.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const ToggleGroupProps = Schema.Struct({
  value: Schema.Array(Schema.String),
  items: Schema.Array(ToggleGroupItem),
  disabled: Schema.optional(Schema.Boolean),
  multiple: Schema.optional(Schema.Boolean),
  orientation: Schema.optional(ToggleGroupOrientation),
  loopFocus: Schema.optional(Schema.Boolean)
})

/**
 * The props of a `ToggleGroup`.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type ToggleGroupProps = typeof ToggleGroupProps.Type

/**
 * What a toggle group emits.
 *
 * **Details**
 *
 * - `Toggled`: asks for the group's value in `value`. Pressing an item
 *   gives `[value]` and pressing the pressed one gives `[]`. With
 *   `multiple`, the item's value is added at the end or removed. Store it
 *   and pass it back as the `value` prop. A disabled group or item emits
 *   nothing.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const ToggleGroupEvents = UiSchema.TaggedEnum({
  Toggled: { value: Schema.Array(Schema.String) }
})

/**
 * What a `ToggleGroup` emits.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type ToggleGroupEvents = typeof ToggleGroupEvents.Type

const ToggleGroupMessage = UiSchema.TaggedEnum({
  ClickedItem: { value: Schema.String },
  FocusedItem: { value: Schema.String },
  PressedKey: { value: Schema.String, key: Schema.String },
  FoundDirection: { rtl: Schema.Boolean }
})

// `rtl`: the root's CSS `direction` is right-to-left.
const ToggleGroupModel = Schema.Struct({
  active: Schema.NullOr(Schema.String),
  rtl: Schema.Boolean
})

type ToggleGroupModel = typeof ToggleGroupModel.Type

const Item = Html.ref("ToggleGroupItem", "button")

interface InToolbar {
  readonly disabled: boolean
  readonly disabledItems: ReadonlyArray<string>
}

const disabledOf = (
  props: ToggleGroupProps,
  toolbar: InToolbar | undefined
): boolean => props.disabled === true || toolbar?.disabled === true

const itemDisabled = (
  props: ToggleGroupProps,
  toolbar: InToolbar | undefined,
  item: ToggleGroupItem
): boolean =>
  disabledOf(props, toolbar) || !ListNavigation.available(item) ||
  toolbar?.disabledItems.includes(item.value) === true

const enabledOf = (
  props: ToggleGroupProps,
  toolbar: InToolbar | undefined
): ReadonlyArray<ToggleGroupItem> =>
  props.items.filter((item) => !itemDisabled(props, toolbar, item))

const enabled = (
  props: ToggleGroupProps,
  toolbar: InToolbar | undefined,
  value: string
): boolean => enabledOf(props, toolbar).some((item) => item.value === value)

const toggled = (
  props: ToggleGroupProps,
  value: string
): ReadonlyArray<string> => {
  const pressed = props.value.includes(value)
  if (props.multiple !== true) return pressed ? [] : [value]
  return pressed
    ? props.value.filter((other) => other !== value)
    : [...props.value, value]
}

const tabStopOf = (
  model: ToggleGroupModel,
  props: ToggleGroupProps,
  toolbar: InToolbar | undefined
): string | null => {
  const items = enabledOf(props, toolbar)
  return (items.find((item) => item.value === model.active) ?? items[0])
    ?.value ?? null
}

/**
 * A headless toggle group. Call it with the consumer's `h`, the `props`,
 * an `onEmit` for `Toggled`, and a `view` closure that draws the root with
 * `toggleGroup.root(h.div)` and, inside it, one
 * `toggleGroup.item({ element: h.button, value })` for each item.
 *
 * **Details**
 *
 * The parts also return `value`, `disabled`, `multiple` and
 * `orientation`, resolved, for markup that depends on them.
 *
 * The group's own attributes win over the ones the consumer set on the
 * builder before the part, including the ones a state leaves absent:
 *
 * - `root`: `role="group"`, `data-orientation`, `data-disabled` and
 *   `data-multiple`
 * - `item`: `type="button"`, `aria-pressed`, `disabled`, `aria-disabled`,
 *   which it never sets, `tabindex`, `data-pressed` and `data-disabled`
 *
 * A part writes them when it is applied, so an attribute the consumer
 * chains after the part is the consumer's to answer for.
 *
 * An item handles `click`, `focus` and `keydown` on a layer of its own,
 * so the consumer's handlers for them still run. It cancels only the keys
 * it moves focus with.
 *
 * The group follows the nearest `DirectionProvider` above it or, without
 * one, the root's CSS `direction`. Inside a
 * `Toolbar`, an item writes no `tabindex` and handles no `focus` or
 * `keydown`. The toolbar's `disabled` disables the group, and a disabled
 * toolbar item disables the group's item with the same value.
 *
 * @stability experimental
 * @category components
 * @since 0.1.0
 */
export const ToggleGroup = Html.component({
  name: "ToggleGroup",
  props: ToggleGroupProps,
  model: ToggleGroupModel,
  message: ToggleGroupMessage,
  events: ToggleGroupEvents,
  restore: false,
  reads: {
    provider: { owner: DirectionProvider, optional: true },
    toolbar: { owner: Toolbar, optional: true }
  }
}).make({
  init: () => ({ active: null, rtl: false }),
  update: {
    ClickedItem: ($, { value }) =>
      enabled($.props, $.reads.toolbar, value)
        ? $.emit(ToggleGroupEvents.Toggled({ value: toggled($.props, value) }))
        : $.model,
    FocusedItem: ($, { value }) => $.evolve({ active: value }),
    PressedKey: ($, { key, value }) => {
      const items = enabledOf($.props, $.reads.toolbar)
      const index = ListNavigation.target(key, {
        at: items.findIndex((item) => item.value === value),
        last: items.length - 1,
        orientation: $.props.orientation ?? "horizontal",
        rtl: rightToLeft($.reads.provider, $.model.rtl),
        loop: $.props.loopFocus !== false ? "wrap" : "none"
      })
      const target = index === undefined ? undefined : items[index]
      if (target === undefined || target.value === value) return $.model
      return $.evolve({ active: target.value }).run(
        HtmlCommand.Focus.make({ ref: Item.at(target.value) }).pipe(
          Command.asNoop
        )
      )
    },
    FoundDirection: ($, { rtl }) => $.evolve({ rtl })
  },
  parts: (p, model) => {
    const props = p.props
    const toolbar = p.reads.toolbar
    const disabled = disabledOf(props, toolbar)
    const multiple = props.multiple === true
    const orientation = props.orientation ?? "horizontal"
    const tabStop = tabStopOf(model, props, toolbar)
    const item = p.part("button", (b, value: string) => {
      const entry = props.items.find((item) => item.value === value)
      if (entry === undefined) {
        throw new Error(
          "ToggleGroup: no item with value \"" + value + "\" in items"
        )
      }
      const pressed = pressedAttrs(
        b,
        props.value.includes(value),
        itemDisabled(props, toolbar, entry)
      )
        .on("click", ToggleGroupMessage.ClickedItem({ value }))
      if (toolbar !== undefined) return pressed
      return pressed
        .attr("tabindex", value === tabStop ? "0" : "-1")
        .ref(Item.at(value))
        .on("focus", ToggleGroupMessage.FocusedItem({ value }))
        .on(
          "keydown",
          (event) =>
            ListNavigation.isKey(event, orientation)
              ? ToggleGroupMessage.PressedKey({ value, key: event.key })
              : undefined,
          { preventDefault: true }
        )
    })
    return {
      value: props.value,
      disabled,
      multiple,
      orientation,
      root: p.part("div", (b) => {
        const root = b.attrs({
          role: "group",
          "data-orientation": orientation,
          "data-disabled": flag(disabled),
          "data-multiple": flag(multiple)
        })
        // In a toolbar the toolbar's keys move focus, and a provider decides
        // the direction.
        return toolbar !== undefined || p.reads.provider !== undefined
          ? root
          : root.onMount(
            TrackDirection().pipe(
              Mount.map((rtl) => ToggleGroupMessage.FoundDirection({ rtl }))
            )
          )
      }),
      item: valued(item)
    }
  }
})
