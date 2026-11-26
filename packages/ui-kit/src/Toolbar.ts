/**
 * A row or column of controls, such as buttons, toggle groups, menus and a
 * search input, that takes one stop in the Tab order and moves focus between
 * its controls with the arrow keys.
 *
 * `Toolbar` is a headless component. It keeps which item holds the tab stop,
 * and moves focus between the items through a Command. It emits nothing: each
 * control inside reports its own press, toggle or choice.
 *
 * **Anatomy**
 *
 * | Part        | Element                                |
 * | :---------- | :------------------------------------- |
 * | `root`      | `<div>`                                |
 * | `group`     | `<div>`, around some of the items      |
 * | `button`    | `<button>`, one for each button item   |
 * | `link`      | `<a>`, one for each link item          |
 * | `input`     | `<input>`, one for each input item     |
 * | `separator` | `<div>`, between items                 |
 *
 * `root` and `separator` take the consumer's builder and return it, so the
 * consumer goes on chaining and adds children with `.children(...)`. `group`,
 * `button`, `link` and `input` take `{ element, value }`: the builder and the
 * `value` of one entry in the `groups` or `items` prop. A `value` that isn't
 * there fails the render. No part adds markup.
 *
 * An item part is the element of another kit call too. Stack it inside a
 * trigger or a toggle group item, and pass the result to `Button`:
 *
 * - `toolbar.button({ element: menu.trigger(h.button), value })`, and the same
 *   for the trigger of a `Select`, `Popover`, `Dialog` or `AlertDialog`
 * - `toolbar.button({ element: toggleGroup.item({ element: h.button, value }), value })`
 * - `tooltip.trigger(toolbar.button({ element: h.button, value }))`
 * - `Button(h, { element: toolbar.button({ element: h.button, value }), onPress })`
 *
 * A `ToggleGroup` inside a toolbar leaves the tab stop and the arrow keys to
 * the toolbar, and each of its items is disabled with the toolbar item of
 * the same value. In a vertical toolbar, a `Menu` or `Select` trigger
 * leaves Down and Up to the toolbar, and opens with Enter or Space.
 *
 * **Data attributes**
 *
 * Each present with an empty value or absent, except `data-orientation`,
 * which holds an orientation:
 *
 * - `root`, `group`: `data-orientation` and `data-disabled`
 * - `button`, `input`: `data-orientation`, `data-disabled` and
 *   `data-focusable`, present while the item stays focusable when disabled
 * - `link`: `data-orientation`
 * - `separator`: `data-orientation`, across the toolbar's: `"vertical"` in
 *   a horizontal toolbar
 *
 * **Keyboard**
 *
 * Only one item is in the Tab order: the one focused last, or else the first
 * item that can take focus. A key handler on each item moves focus:
 *
 * | Key         | Action                                     |
 * | :---------- | :----------------------------------------- |
 * | Right, Left | next and previous item, horizontally       |
 * | Down, Up    | next and previous item, vertically         |
 * | Home, End   | first and last item, from a button or link |
 *
 * The arrow keys follow `orientation`, and with `loopFocus` they wrap from
 * the last item to the first and back. A disabled item stays in the order
 * unless its entry sets `focusableWhenDisabled: false`. In a right-to-left
 * layout, Left and Right swap. A key held with Alt, Ctrl, Meta or Shift does
 * nothing.
 *
 * In a text input, the arrow keys move the caret, and leave the input only
 * from the end of the text, or from its start for the previous item. Home,
 * End and a selection stay with the input. An input reached with the arrow
 * keys has its text selected.
 *
 * **Usage**
 *
 * The `items` prop lists every item in the order they are drawn, so the
 * toolbar can move focus without reading the page. Draw one item part for
 * each entry. Left and Right also move the caret, so put at most one text
 * input in a horizontal toolbar, as its last item.
 *
 * A disabled item cancels the clicks the consumer handles on it, and those of
 * a `Button` stacked outside the part. A component stacked inside, such as a
 * `Menu` trigger or a `Select`, handles clicks on its own layer: pass it
 * `disabled: toolbar.isDisabled(value)` too. A `ToggleGroup` needs nothing.
 *
 * **Example** (A formatting toolbar)
 *
 * ```ts import.meta.vitest
 * import { UiSchema } from "@effect/ui"
 * import { Html, HtmlServer } from "@effect/ui/html"
 * import { Button, Toolbar } from "@effect/ui-kit"
 * import { Effect, Schema } from "effect"
 *
 * const EditorMessage = UiSchema.TaggedEnum({ PressedBold: {}, PressedItalic: {} })
 *
 * const Editor = Html.component({
 *   name: "Editor",
 *   model: Schema.Null,
 *   message: EditorMessage
 * }).make({
 *   init: () => null,
 *   update: ($) => $.model,
 *   view: (h) =>
 *     Toolbar(h, {
 *       props: { items: [{ value: "bold" }, { value: "italic" }, { value: "help" }] },
 *       view: (toolbar) =>
 *         toolbar.root(h.div.class("toolbar").attr("aria-label", "Formatting")).children(
 *           Button(h, { element: toolbar.button({ element: h.button, value: "bold" }), onPress: EditorMessage.PressedBold() })
 *             .children("Bold"),
 *           Button(h, {
 *             element: toolbar.button({ element: h.button, value: "italic" }),
 *             onPress: EditorMessage.PressedItalic()
 *           }).children("Italic"),
 *           toolbar.separator(h.div),
 *           toolbar.link({ element: h.a.attr("href", "/help"), value: "help" }).children("Help")
 *         )
 *     })
 * })
 *
 * const { html } = await Effect.runPromise(HtmlServer.renderToHtml(Editor, {}))
 * if (!/<div class="toolbar"[^>]* role="toolbar"/.test(html)) throw new Error("the root isn't a toolbar")
 * if (!/tabindex="0"[^>]*>Bold</.test(html) || !/tabindex="-1"[^>]*>Italic</.test(html)) {
 *   throw new Error("the first item doesn't hold the only tab stop")
 * }
 * ```
 *
 * @stability experimental
 * @since 0.1.0
 */
import * as Command from "@effect/ui/Command"
import * as Component from "@effect/ui/Component"
import * as Html from "@effect/ui/html/Html"
import * as Mount from "@effect/ui/Mount"
import * as Renderer from "@effect/ui/Renderer"
import * as UiSchema from "@effect/ui/UiSchema"
import * as View from "@effect/ui/View"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { DirectionProvider } from "./DirectionProvider.ts"
import {
  type Attributed,
  flag,
  type Keyed,
  separatorAttrs
} from "./internal/attributes.ts"
import {
  type Directed,
  rightToLeft,
  TrackDirection
} from "./internal/direction.ts"
import { valued } from "./internal/list.ts"
import * as ListNavigation from "./ListNavigation.ts"

/**
 * The direction a toolbar's items run in, which picks its arrow keys.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const ToolbarOrientation = Schema.Literals(["horizontal", "vertical"])

/**
 * The direction a toolbar's items run in.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type ToolbarOrientation = typeof ToolbarOrientation.Type

/**
 * One item of a toolbar: the `value` its part is drawn with, and its state.
 *
 * **Details**
 *
 * - `disabled`: the item is disabled.
 * - `focusableWhenDisabled`: a disabled item stays focusable and in the
 *   arrow keys' order. On by default.
 *
 * A link is never disabled, so leave both off a link's entry.
 * - `group`: the `value` of the entry in `groups` whose `group` part is drawn
 *   around the item, so a disabled group disables it.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const ToolbarItem = Schema.Struct({
  value: Schema.String,
  disabled: Schema.optional(Schema.Boolean),
  focusableWhenDisabled: Schema.optional(Schema.Boolean),
  group: Schema.optional(Schema.String)
})

/**
 * One item of a toolbar.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type ToolbarItem = typeof ToolbarItem.Type

/**
 * One group of a toolbar: the `value` its `group` part is drawn with, and
 * whether it disables the items inside.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const ToolbarGroup = Schema.Struct({
  value: Schema.String,
  disabled: Schema.optional(Schema.Boolean)
})

/**
 * One group of a toolbar.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type ToolbarGroup = typeof ToolbarGroup.Type

/**
 * Props for the state of a `Toolbar`.
 *
 * **Details**
 *
 * - `items`: every button, link and input, in the order they are drawn.
 *   Required.
 * - `groups`: every group drawn with the `group` part. None by default.
 * - `disabled`: disables every button and input.
 * - `orientation`: `"horizontal"` by default, which moves with Right and
 *   Left, or `"vertical"`, which moves with Down and Up.
 * - `loopFocus`: the arrow keys wrap from the last item to the first and
 *   back. On by default.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const ToolbarProps = Schema.Struct({
  items: Schema.Array(ToolbarItem),
  groups: Schema.optional(Schema.Array(ToolbarGroup)),
  disabled: Schema.optional(Schema.Boolean),
  orientation: Schema.optional(ToolbarOrientation),
  loopFocus: Schema.optional(Schema.Boolean)
})

/**
 * The props of a `Toolbar`.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type ToolbarProps = typeof ToolbarProps.Type

const ToolbarMessage = UiSchema.TaggedEnum({
  FocusedItem: { value: Schema.String },
  PressedItemKey: { value: Schema.String, key: Schema.String },
  PressedInputKey: {
    value: Schema.String,
    key: Schema.String,
    caret: Schema.NullOr(Schema.Number)
  },
  FoundDirection: { rtl: Schema.Boolean }
})

// `rtl`: the root's CSS `direction` is right-to-left.
const ToolbarModel = Schema.Struct({
  active: Schema.NullOr(Schema.String),
  rtl: Schema.Boolean
})

type ToolbarModel = typeof ToolbarModel.Type

const Item = Html.ref("ToolbarItem", "button")

const textField = (element: globalThis.Element): boolean =>
  element.localName === "textarea" ||
  (element.localName === "input" &&
    (element as HTMLInputElement).selectionStart != null)

const FocusItem = Command.make(
  "FocusItem",
  {
    args: {
      ref: Renderer.Ref,
      leaving: Schema.optional(
        Schema.Struct({ ref: Renderer.Ref, caret: Schema.Number })
      )
    }
  },
  ({ leaving, ref }) =>
    Renderer.Refs.use((refs) =>
      Effect.gen(function*() {
        if (leaving !== undefined) {
          const from = yield* refs.lookup(leaving.ref)
          if (
            Option.isSome(from) &&
            (from.value as HTMLInputElement).value.length !== leaving.caret
          ) return
        }
        const to = yield* refs.lookup(ref)
        if (Option.isNone(to)) return
        const element = to.value as globalThis.Element
        yield* Html.Host.useSync((host) => {
          host.focus(element, {})
          if (textField(element)) host.select(element)
        })
      })
    ).pipe(Effect.as(Component.noop))
)

const cancelClick = <
  N extends {
    readonly on: (
      event: "click",
      handler: () => undefined,
      options: View.EventOptions
    ) => N
  }
>(
  node: N
): N => node.on("click", () => undefined, { preventDefault: "always" })

const groupOf = (
  props: ToolbarProps,
  value: string
): ToolbarGroup | undefined =>
  props.groups?.find((group) => group.value === value)

const disabledOf = (props: ToolbarProps, item: ToolbarItem): boolean =>
  props.disabled === true || item.disabled === true ||
  (item.group !== undefined && groupOf(props, item.group)?.disabled === true)

const reachable = (props: ToolbarProps, item: ToolbarItem): boolean =>
  item.focusableWhenDisabled !== false || !disabledOf(props, item)

const tabStopOf = (model: ToolbarModel, props: ToolbarProps): string | null => {
  const items = props.items.filter((item) => reachable(props, item))
  return (items.find((item) => item.value === model.active) ?? items[0])
    ?.value ?? null
}

type ToolbarUpdate =
  & Component.Update<
    ToolbarModel,
    typeof ToolbarMessage.Type,
    never,
    ToolbarProps
  >
  & Directed

const keysOf = ($: ToolbarUpdate) =>
  ListNavigation.arrowKeys(
    $.props.orientation ?? "horizontal",
    rightToLeft($.reads.provider, $.model.rtl)
  )

const targetOf = (
  value: string,
  key: string,
  $: ToolbarUpdate
): ToolbarItem | undefined => {
  const items = $.props.items.filter((item) => reachable($.props, item))
  const index = ListNavigation.target(key, {
    at: items.findIndex((item) => item.value === value),
    last: items.length - 1,
    orientation: $.props.orientation ?? "horizontal",
    rtl: rightToLeft($.reads.provider, $.model.rtl),
    loop: $.props.loopFocus !== false ? "wrap" : "none"
  })
  const target = index === undefined ? undefined : items[index]
  return target === undefined || target.value === value ? undefined : target
}

const moveTo = ($: ToolbarUpdate, target: ToolbarItem) =>
  $.set({ ...$.model, active: target.value }).run(
    FocusItem.make({ ref: Item.at(target.value) })
  )

/**
 * A headless toolbar. Call it with the consumer's `h`, the `props`, and a `view`
 * closure that draws the root with `toolbar.root(h.div)` and, inside it, one
 * `toolbar.button`, `toolbar.link` or `toolbar.input` for each item.
 *
 * **Details**
 *
 * The parts also return `disabled` and `orientation`, resolved, and
 * `isDisabled(value)`, whether an item is disabled by its entry, its group or
 * the toolbar.
 *
 * The toolbar's own attributes win over the ones the consumer set on the
 * builder before the part, including the ones a state leaves absent:
 *
 * - `root`: `role="toolbar"`, `aria-orientation`, `data-orientation` and
 *   `data-disabled`
 * - `group`: `role="group"`, `data-orientation` and `data-disabled`
 * - `button`: `type="button"`, `tabindex`, `disabled`, `aria-disabled`,
 *   `data-orientation`, `data-disabled` and `data-focusable`
 * - `input`: the same but `type`, and `readonly` while it is disabled and
 *   focusable, which keeps the consumer's otherwise
 * - `link`: `tabindex` and `data-orientation`
 * - `separator`: `role="separator"`, `aria-orientation` and
 *   `data-orientation`
 *
 * A part writes them when it is applied. A button or input writes
 * `disabled`, `aria-disabled` and `data-disabled` again on the finished
 * element, over a `Button` stacked outside it.
 *
 * Each item handles `focus` and `keydown` on a layer of its own, so the
 * consumer's handlers for them still run. A button or link cancels only the
 * keys it moves focus with, and an input none. A disabled, focusable button
 * cancels its clicks, and replaces a click handler set outside its layer.
 *
 * The toolbar shares `{ disabled, orientation, disabledItems }` with the
 * components in its `view` closure, `disabledItems` holding the values of
 * the disabled items. A `ToggleGroup` inside reads all three, and a `Menu`
 * or `Select` its `orientation`. It follows the nearest
 * `DirectionProvider` above it or, without one, the root's CSS `direction`.
 *
 * @stability experimental
 * @category components
 * @since 0.1.0
 */
export const Toolbar = Html.component({
  name: "Toolbar",
  props: ToolbarProps,
  model: ToolbarModel,
  message: ToolbarMessage,
  restore: false,
  shares: {
    value: ({ props }) => ({
      disabled: props.disabled === true,
      orientation: props.orientation ?? "horizontal",
      disabledItems: props.items.filter((item) => disabledOf(props, item)).map((
        item
      ) => item.value)
    }),
    schema: Schema.Struct({
      disabled: Schema.Boolean,
      orientation: ToolbarOrientation,
      disabledItems: Schema.Array(Schema.String)
    })
  },
  reads: {
    provider: { owner: DirectionProvider, optional: true }
  }
}).make({
  init: () => ({ active: null, rtl: false }),
  update: {
    FocusedItem: ($, { value }) =>
      $.model.active === value ? $.model : { ...$.model, active: value },
    PressedItemKey: ($, { key, value }) => {
      const target = targetOf(value, key, $)
      return target === undefined ? $.model : moveTo($, target)
    },
    PressedInputKey: ($, { caret, key, value }) => {
      const keys = keysOf($)
      const target = targetOf(value, key, $)
      if (target === undefined) return $.model
      if (caret === null) return moveTo($, target)
      if (key === keys.next) {
        return $.run(
          FocusItem.make({
            ref: Item.at(target.value),
            leaving: { ref: Item.at(value), caret }
          })
        )
      }
      return caret > 0 ? $.model : moveTo($, target)
    },
    FoundDirection: ($, { rtl }) => $.evolve({ rtl })
  },
  parts: (p, model) => {
    const props = p.props
    const disabled = props.disabled === true
    const orientation = props.orientation ?? "horizontal"
    const tabStop = tabStopOf(model, props)
    const axis = ListNavigation.arrowKeys(orientation, false)
    const entries = new Map<string, ToolbarItem>()
    for (const item of props.items) {
      if (entries.has(item.value)) {
        throw new Error(
          "Toolbar: two items have the value " + JSON.stringify(item.value)
        )
      }
      if (
        item.group !== undefined && groupOf(props, item.group) === undefined
      ) {
        throw new Error(
          "Toolbar: the item " + JSON.stringify(item.value) +
            " names the group " + JSON.stringify(item.group) +
            ", which isn't in groups"
        )
      }
      entries.set(item.value, item)
    }
    const entryOf = (value: string): ToolbarItem => {
      const entry = entries.get(value)
      if (entry === undefined) {
        throw new Error(
          "Toolbar: no item with value " + JSON.stringify(value) + " in items"
        )
      }
      return entry
    }
    const isDisabled = (value: string): boolean =>
      disabledOf(props, entryOf(value))

    const roving = <
      N extends Html.VoidElement<typeof ToolbarMessage.Type, any, any, any, any>
    >(
      node: N,
      value: string
    ): N =>
      node.attrs({
        "data-orientation": orientation,
        tabindex: value === tabStop ? "0" : "-1"
      })
        .ref(Item.at(value) as never)
        .on("focus", ToolbarMessage.FocusedItem({ value }))

    const disabledAttrs = <
      N extends Attributed<N> & { readonly disabled: (disabled: boolean) => N }
    >(
      node: N,
      off: boolean,
      focusable: boolean
    ): N =>
      node.attrs({
        "aria-disabled": off && focusable ? "true" : undefined,
        "data-disabled": flag(off)
      })
        .disabled(off && !focusable)

    const movesFocus = <
      N extends Html.VoidElement<typeof ToolbarMessage.Type, any, any, any, any>
    >(
      node: N,
      value: string
    ): N =>
      roving(node, value).on(
        "keydown",
        (key) =>
          ListNavigation.isKey(key, orientation)
            ? ToolbarMessage.PressedItemKey({ value, key: key.key })
            : undefined,
        { preventDefault: true }
      )

    const buttonPart = p.part(
      "button",
      (b, value: string, off: boolean, focusable: boolean) => {
        const own = disabledAttrs(movesFocus(b, value), off, focusable)
          .attrs({ type: "button", "data-focusable": flag(focusable) })
        return off && focusable ? cancelClick(own) : own
      }
    )

    // Decorate the consumer's layer so a disabled focusable button replaces
    // the consumer's click handler instead of adding a separate cancel handler.
    const button = View.wrapPart(
      buttonPart,
      <B extends Keyed<"button">>(
        { element, value }: { readonly element: B; readonly value: string }
      ): ReturnType<B["attr"]> => {
        const entry = entryOf(value)
        const off = disabledOf(props, entry)
        const focusable = entry.focusableWhenDisabled !== false
        const decorated = buttonPart(element.key(value), value, off, focusable)
        return decorated.forward((node: typeof decorated) =>
          disabledAttrs(
            off && focusable && node.handlers.click !== undefined
              ? cancelClick(node)
              : node,
            off,
            focusable
          )
        )
      }
    )

    const linkPart = p.part("a", (b, value: string) => {
      entryOf(value)
      return movesFocus(b, value)
    })

    const inputPart = p.part("input", (b, value: string) => {
      const entry = entryOf(value)
      const off = disabledOf(props, entry)
      const focusable = entry.focusableWhenDisabled !== false
      const own = disabledAttrs(roving(b, value), off, focusable)
        .attr("data-focusable", flag(focusable))
        .on("keydown", (
          {
            alt,
            composing,
            ctrl,
            key,
            meta,
            selectionEnd,
            selectionStart,
            shift
          }
        ) =>
          alt || ctrl || meta || shift || composing ||
            (key !== axis.next && key !== axis.previous) ||
            selectionStart !== selectionEnd
            ? undefined
            : ToolbarMessage.PressedInputKey({
              value,
              key,
              caret: selectionEnd
            }))
      const readOnly = <N extends Attributed<N>>(node: N): N =>
        off && focusable ? node.attr("readonly", "") : node
      return readOnly(own).forward((node) =>
        readOnly(disabledAttrs(node, off, focusable))
      )
    })

    const groupPart = p.part("div", (b, value: string) => {
      const group = groupOf(props, value)
      if (group === undefined) {
        throw new Error(
          "Toolbar: no group with value " + JSON.stringify(value) + " in groups"
        )
      }
      return b.attrs({
        role: "group",
        "data-orientation": orientation,
        "data-disabled": flag(disabled || group.disabled === true)
      })
    })

    return {
      disabled,
      orientation,
      isDisabled,
      root: p.part("div", (b) =>
        b.attrs({
          role: "toolbar",
          "aria-orientation": orientation,
          "data-orientation": orientation,
          "data-disabled": flag(disabled)
        }).onMount(
          TrackDirection({ css: p.reads.provider === undefined }).pipe(
            Mount.map((rtl) => ToolbarMessage.FoundDirection({ rtl }))
          )
        )),
      group: View.wrapPart(
        groupPart,
        <B extends View.PartTarget<"div">>(
          { element, value }: { readonly element: B; readonly value: string }
        ): ReturnType<B["attr"]> => groupPart(element, value)
      ),
      button,
      link: valued(linkPart),
      input: valued(inputPart),
      separator: p.part(
        "div",
        (b) =>
          separatorAttrs(
            b,
            orientation === "vertical" ? "horizontal" : "vertical"
          )
      )
    }
  }
})
