/**
 * Tabs: a list of tabs, each showing one panel when it is active. Pass the
 * active tab as `value` and update it when the tabs emit `Selected`. The
 * consumer's view supplies the markup, and the tabs add the ARIA, the ids,
 * the roving focus and the panel transitions. A headless component.
 *
 * **Anatomy**
 *
 * | Part        | Element                                     |
 * | :---------- | :------------------------------------------ |
 * | `root`      | any element, around the list and the panels |
 * | `list`      | any element, around the tabs                |
 * | `tab`       | `<button>` or `<a>`, inside the list            |
 * | `indicator` | any element, inside the list                |
 * | `panel`     | any element, inside the root                |
 *
 * `root`, `list` and `indicator` take the consumer's builder.
 * `tab({ element, value })` and `panel({ element, value })` also take the
 * value of an entry in the `tabs` prop. `panel` returns `undefined` while
 * its panel is hidden, unless it is kept mounted, and `indicator` returns
 * `undefined` while no tab is active, so the consumer writes
 * `tabs.panel({ element: h.div, value: "a" })?.children(...)`. No part adds
 * markup.
 *
 * Draw the root around the list and the panels: it points each tab at its
 * panel. The indicator must sit inside the list, since it is placed against
 * it, and the list needs `position: relative` or another containing block for
 * an absolutely positioned indicator.
 *
 * **Data attributes**
 *
 * On every part:
 *
 * - `data-orientation`: `horizontal` or `vertical`
 * - `data-activation-direction`: where the active tab moved, relative to
 *   the one before it: `left`, `right`, `up`, `down`, or `none` before
 *   the first change
 *
 * On `tab`, each present with an empty value or absent:
 *
 * - `data-active`
 * - `data-disabled`
 *
 * On `panel`:
 *
 * - `data-index`: the index of its tab in `tabs`
 * - `data-hidden`: present while the panel is hidden
 * - `data-starting-style`: present for the first frame of a panel that
 *   becomes active
 * - `data-ending-style`: present while a panel that stopped being active
 *   plays its exit, until its animations and transitions finish
 *
 * On `indicator`, as custom properties in pixels, measured from the list's
 * padding box: `--active-tab-left`, `--active-tab-right`, `--active-tab-top`,
 * `--active-tab-bottom`, `--active-tab-width` and `--active-tab-height`.
 * The indicator is `hidden` until they are measured, including in server
 * HTML.
 *
 * **Keyboard**
 *
 * One tab is in the page's Tab order: the one focus last left, or, while
 * focus is outside the list, the active tab. A disabled active tab leaves
 * the previous one in place, and with none the first enabled tab is used.
 *
 * - Left and Right move focus between the tabs of a horizontal list, swapped
 *   in a right-to-left layout. Up and Down do it in a vertical list.
 * - Home and End move focus to the first and the last tab.
 * - The arrow keys wrap around, unless `loopFocus` is `false`.
 * - Space clicks the focused tab once, when the key goes down, with the
 *   key's modifiers, so a link tab still follows its `href`. Holding it
 *   down doesn't click again.
 * - Enter clicks a `<button>` or a link natively, and the tabs click an
 *   `<a>` that has no `href`, once while the key is held.
 * - With `activateOnFocus`, moving focus activates the tab as well, unless
 *   a mouse button other than the main one is pressing it.
 *
 * Disabled tabs take focus and are not skipped, so a screen reader can find
 * them, but they never activate.
 *
 * The tabs follow the nearest `DirectionProvider` above them or, without
 * one, the list's CSS `direction`.
 *
 * **Example** (Three tabs, one of them disabled)
 *
 * ```ts import.meta.vitest
 * import { UiSchema } from "@effect/ui"
 * import { Html, HtmlServer } from "@effect/ui/html"
 * import { Tabs } from "@effect/ui-kit"
 * import { Effect, Schema } from "effect"
 *
 * const SettingsMessage = UiSchema.TaggedEnum({ SelectedTab: { value: Schema.String } })
 *
 * const Settings = Html.component({
 *   name: "Settings",
 *   model: Schema.Struct({ tab: Schema.String }),
 *   message: SettingsMessage
 * }).make({
 *   init: () => ({ tab: "overview" }),
 *   update: {
 *     SelectedTab: ($, { value }) => $.evolve({ tab: value })
 *   },
 *   view: (h, model) =>
 *     Tabs(h, {
 *       props: {
 *         value: model.tab,
 *         tabs: [{ value: "overview" }, { value: "projects" }, { value: "account", disabled: true }]
 *       },
 *       onEmit: { Selected: ({ value }) => SettingsMessage.SelectedTab({ value }) },
 *       view: (tabs) =>
 *         tabs.root(h.div.class("tabs")).children(
 *           tabs.list(h.div.class("list")).children(
 *             tabs.tab({ element: h.button.class("tab"), value: "overview" }).children("Overview"),
 *             tabs.tab({ element: h.button.class("tab"), value: "projects" }).children("Projects"),
 *             tabs.tab({ element: h.button.class("tab"), value: "account" }).children("Account"),
 *             tabs.indicator(h.span.class("indicator"))
 *           ),
 *           tabs.panel({ element: h.div, value: "overview" })?.children("Workspace stats"),
 *           tabs.panel({ element: h.div, value: "projects" })?.children("Milestones"),
 *           tabs.panel({ element: h.div, value: "account" })?.children("Profile")
 *         )
 *     })
 * })
 *
 * // The active tab keeps the consumer's class and is selected; only its panel is drawn.
 * const { html } = await Effect.runPromise(HtmlServer.renderToHtml(Settings, {}))
 * if (!/<button class="tab"[^>]* role="tab"[^>]* aria-selected="true"/.test(html)) throw new Error("no selected tab")
 * if (html.match(/role="tabpanel"/g)?.length !== 1) throw new Error("more than the active panel is drawn")
 * ```
 *
 * @stability experimental
 * @since 0.1.0
 */
import * as Command from "@effect/ui/Command"
import type * as Component from "@effect/ui/Component"
import * as Html from "@effect/ui/html/Html"
import * as HtmlCommand from "@effect/ui/html/HtmlCommand"
import * as HtmlSubscription from "@effect/ui/html/HtmlSubscription"
import * as Mount from "@effect/ui/Mount"
import * as Subscription from "@effect/ui/Subscription"
import * as UiSchema from "@effect/ui/UiSchema"
import * as UiStruct from "@effect/ui/UiStruct"
import * as View from "@effect/ui/View"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { DirectionProvider } from "./DirectionProvider.ts"
import { type Attributed, flag, withTokens } from "./internal/attributes.ts"
import {
  type Directed,
  rightToLeft,
  watchDirectionWhile
} from "./internal/direction.ts"
import { isHTMLElement } from "./internal/dom.ts"
import { keyed } from "./internal/list.ts"
import { frameOf, statusOf, whenFinished } from "./internal/transition.ts"
import * as ListNavigation from "./ListNavigation.ts"

/**
 * The direction the tabs are laid out in, which decides their arrow keys.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const TabsOrientation = Schema.Literals(["horizontal", "vertical"])

/**
 * The direction the tabs are laid out in.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type TabsOrientation = typeof TabsOrientation.Type

/**
 * Where a newly active tab sits relative to the one active before it, by
 * their order in `tabs`: `left` or `right` in a horizontal list, following the
 * text direction, `up` or `down` in a vertical one, and `none` when either
 * value is `null` or not a tab.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const TabsActivationDirection = Schema.Literals([
  "left",
  "right",
  "up",
  "down",
  "none"
])

/**
 * Where a newly active tab sits relative to the one before it.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type TabsActivationDirection = typeof TabsActivationDirection.Type

/**
 * One tab, in the order the list shows it.
 *
 * **Details**
 *
 * - `value`: names the tab and its panel.
 * - `disabled`: the tab keeps its focus and its place in the arrow keys'
 *   order, and never activates.
 * - `keepMounted`: keeps this tab's panel drawn, and `hidden`, while the
 *   tab isn't active. Overrides the `keepMounted` prop for this panel.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const TabsTab = Schema.Struct({
  value: Schema.String,
  disabled: Schema.optional(Schema.Boolean),
  keepMounted: Schema.optional(Schema.Boolean)
})

/**
 * One tab, in the order the list shows it.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type TabsTab = typeof TabsTab.Type

/**
 * Props for the tabs and the active one.
 *
 * **Details**
 *
 * - `value`: the active tab's value, or `null` for none. Required: the
 *   consumer owns it.
 * - `tabs`: every tab, in the order the list shows them. Each value is
 *   drawn once with `tab`, and may be drawn with `panel`.
 * - `orientation`: `"horizontal"` by default.
 * - `activateOnFocus`: activates a tab when it takes focus, such as from
 *   the arrow keys, and not only when it is clicked. While a mouse button
 *   other than the main one presses a tab, until `pointerup` or
 *   `pointercancel`, focus only focuses it.
 * - `loopFocus`: the arrow keys wrap from the last tab to the first and
 *   back. `true` by default.
 * - `keepMounted`: keeps every panel drawn, and `hidden`, while its tab isn't
 *   active, as `keepMounted` on a `TabsTab` does for one.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const TabsProps = Schema.Struct({
  value: Schema.NullOr(Schema.String),
  tabs: Schema.Array(TabsTab),
  orientation: Schema.optional(TabsOrientation),
  activateOnFocus: Schema.optional(Schema.Boolean),
  loopFocus: Schema.optional(Schema.Boolean),
  keepMounted: Schema.optional(Schema.Boolean)
})

/**
 * The props of `Tabs`.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type TabsProps = typeof TabsProps.Type

/**
 * `Selected` asks for the tab the user activated, by a click, Enter or Space,
 * or focus with `activateOnFocus`, and where it sits relative to the active
 * one. Store `value` and pass it back as the `value` prop. A disabled tab, or
 * the one already active, emits nothing.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const TabsEvents = UiSchema.TaggedEnum({
  Selected: {
    value: Schema.String,
    activationDirection: TabsActivationDirection
  }
})

/**
 * What `Tabs` emits.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type TabsEvents = typeof TabsEvents.Type

const TabsMessage = UiSchema.TaggedEnum({
  ClickedTab: { value: Schema.String },
  FocusedTab: { value: Schema.String },
  BlurredTab: {},
  PressedTab: { value: Schema.String, button: Schema.Number },
  ReleasedPointer: {},
  PressedKey: { value: Schema.String, key: Schema.String },
  ChangedValue: {},
  RenderedFirstFrame: { value: Schema.String },
  FinishedTransition: { value: Schema.String },
  MeasuredActiveTab: { sized: Schema.Boolean },
  FoundDirection: { rtl: Schema.Boolean }
})

type TabsMessage = typeof TabsMessage.Type

const TabsModel = Schema.Struct({
  highlighted: Schema.NullOr(Schema.String),
  focused: Schema.Boolean,
  secondary: Schema.NullOr(Schema.String),
  shown: Schema.NullOr(Schema.String),
  leaving: Schema.Array(Schema.String),
  started: Schema.Boolean,
  direction: TabsActivationDirection,
  indicator: Schema.Boolean,
  // The list's CSS `direction` is right-to-left.
  rtl: Schema.Boolean
})

type TabsModel = typeof TabsModel.Type

type TabsUpdate = Component.Update<
  TabsModel,
  TabsMessage,
  TabsEvents,
  TabsProps
>

const Tab = Html.ref("TabsTab", "button")

const indexOf = (tabs: ReadonlyArray<TabsTab>, value: string | null): number =>
  value === null ? -1 : tabs.findIndex((tab) => tab.value === value)

const directionOf = (
  props: TabsProps,
  rtl: boolean,
  from: string | null,
  to: string | null
): TabsActivationDirection => {
  const before = indexOf(props.tabs, from)
  const after = indexOf(props.tabs, to)
  if (before < 0 || after < 0 || before === after) return "none"
  const later = after > before
  if (props.orientation === "vertical") return later ? "down" : "up"
  return later !== rtl ? "right" : "left"
}

// The panels follow `value` from the render it changes in, before `update` hears
// of the change, so the new panel's first frame already has its starting style.
const phaseOf = (model: TabsModel, props: TabsProps, rtl: boolean): TabsModel =>
  props.value === model.shown ? model : UiStruct.evolve(model, {
    highlighted: !model.focused && enabledIn(props.tabs, props.value)
      ? props.value
      : model.highlighted,
    shown: props.value,
    leaving: [
      ...model.leaving.filter((value) => value !== props.value),
      ...(model.shown === null ? [] : [model.shown])
    ],
    started: false,
    direction: directionOf(props, rtl, model.shown, props.value),
    indicator: props.value === null ? false : model.indicator
  })

const enabledIn = (
  tabs: ReadonlyArray<TabsTab>,
  value: string | null
): value is string => {
  const tab = tabs[indexOf(tabs, value)]
  return tab !== undefined && tab.disabled !== true
}

const rtlOf = ($: Directed & { readonly model: TabsModel }) =>
  rightToLeft($.reads.provider, $.model.rtl)

const activate = (model: TabsModel, $: TabsUpdate, value: string) => {
  if (!enabledIn($.props.tabs, value) || value === $.props.value) return model
  return $.set(model).emit(
    TabsEvents.Selected({
      value,
      activationDirection: directionOf($.props, rtlOf($), $.props.value, value)
    })
  )
}

const navigate = ($: TabsUpdate, value: string, key: string) => {
  const tabs = $.props.tabs
  const from = indexOf(tabs, value)
  if (from < 0) return $.model
  const target = ListNavigation.target(key, {
    at: from,
    last: tabs.length - 1,
    orientation: $.props.orientation ?? "horizontal",
    rtl: rtlOf($),
    loop: $.props.loopFocus !== false ? "wrap" : "none"
  })
  const tab = target === undefined ? undefined : tabs[target]
  if (tab === undefined || target === from) return $.model
  return $.evolve({ highlighted: tab.value }).run(
    HtmlCommand.Focus.make({ ref: Tab.at(tab.value) }).pipe(Command.asNoop)
  )
}

const TrackPanel = Mount.makeStream(
  "TrackPanel",
  {
    args: {
      value: Schema.String,
      status: Schema.Literals(["starting", "ending"])
    }
  },
  (node: unknown, initial, changes) =>
    Stream.callback<TabsMessage>((queue) =>
      Effect.gen(function*() {
        if (!isHTMLElement(node)) return
        const frame = frameOf(node.ownerDocument.defaultView)
        const send = (message: TabsMessage) => Queue.offerUnsafe(queue, message)
        let generation = 0
        const follow = ({ status, value }: typeof initial) => {
          const mine = ++generation
          const live = () => mine === generation && node.isConnected
          if (status === "starting") {
            frame(() =>
              frame(() =>
                live() && send(TabsMessage.RenderedFirstFrame({ value }))
              )
            )
          } else {
            frame(() =>
              whenFinished(() => [node], frame, live, () =>
                send(TabsMessage.FinishedTransition({ value })))
            )
          }
        }
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            generation++
          })
        )
        yield* Stream.runForEach(changes, (next) =>
          Effect.sync(() =>
            follow(next)
          )).pipe(Effect.forkScoped)
      })
    )
)

const tabOf = (event: Event, list: unknown): HTMLElement | null => {
  const tab = event.target
  return isHTMLElement(tab) && tab.getAttribute("role") === "tab" &&
      tab.closest("[role=tablist]") === list
    ? tab
    : null
}

const clickFrom = (tab: HTMLElement, event: KeyboardEvent) => {
  const view = tab.ownerDocument.defaultView
  const Click = view?.PointerEvent ?? view?.MouseEvent ?? MouseEvent
  tab.dispatchEvent(
    new Click("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      detail: 0,
      view,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey
    })
  )
}

const ActivateFromKeys = Mount.makeStream(
  "ActivateFromKeys",
  { args: { css: Schema.Boolean } },
  (node: unknown, args, changes) =>
    Stream.callback<TabsMessage>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          // Suppress repeated synthetic clicks while the key is held.
          const onKeyDown = (event: KeyboardEvent) => {
            const tab = tabOf(event, node)
            if (tab === null) return
            const enabled = tab.getAttribute("aria-disabled") !== "true"
            if (event.key === " ") {
              event.preventDefault()
              if (enabled && !event.repeat) clickFrom(tab, event)
            } else if (
              event.key === "Enter" && enabled && tab.localName === "a" &&
              !tab.hasAttribute("href")
            ) {
              event.preventDefault()
              if (!event.repeat) clickFrom(tab, event)
            }
          }
          const onKeyUp = (event: KeyboardEvent) => {
            const tab = tabOf(event, node)
            if (
              tab !== null && event.key === " " && tab.localName === "button"
            ) event.preventDefault()
          }
          const controller = new AbortController()
          if (isHTMLElement(node)) {
            node.addEventListener("keydown", onKeyDown, {
              signal: controller.signal
            })
            node.addEventListener("keyup", onKeyUp, {
              signal: controller.signal
            })
          }
          return controller
        }),
        (controller) => Effect.sync(() => controller.abort())
      ).pipe(
        Effect.andThen(
          isHTMLElement(node)
            ? watchDirectionWhile(
              node,
              args,
              changes,
              (rtl) =>
                Queue.offerUnsafe(queue, TabsMessage.FoundDirection({ rtl }))
            )
            : Effect.void
        )
      )
    )
)

const linkPanels = <E extends View.Element<any, any>>(
  root: E,
  controls: ReadonlyMap<string, string>
): E => {
  const panels = new Set(controls.values())
  const link = (node: View.Node<any, any>): View.Node<any, any> => {
    if (
      node._tag !== "Element" ||
      (node.attrs.id !== undefined && panels.has(node.attrs.id))
    ) return node
    const panel = node.attrs.id === undefined
      ? undefined
      : controls.get(node.attrs.id)
    if (panel !== undefined) {
      return {
        ...node,
        attrs: {
          ...node.attrs,
          "aria-controls": withTokens(node.attrs["aria-controls"], panel)!
        }
      }
    }
    let changed = false
    const children = node.children.map((child) => {
      const next = link(child)
      changed ||= next !== child
      return next
    })
    return changed ? { ...node, children } : node
  }
  return link(root) as E
}

const MAX_LAYOUT_ROUNDING_ERROR = 2

const cssSize = (element: HTMLElement, style: CSSStyleDeclaration) => {
  const width = parseFloat(style.width) || 0
  const height = parseFloat(style.height) || 0
  return Math.round(width) !== element.offsetWidth ||
      Math.round(height) !== element.offsetHeight
    ? { width: element.offsetWidth, height: element.offsetHeight }
    : { width, height }
}

const cumulativeOffset = (element: HTMLElement) => {
  let left = 0
  let top = 0
  let current: HTMLElement | null = element
  while (current !== null) {
    left += current.offsetLeft
    top += current.offsetTop
    const parent = (current.offsetParent ?? null) as HTMLElement | null
    if (parent !== null) {
      left += parent.clientLeft
      top += parent.clientTop
    }
    current = parent
  }
  return { left, top }
}

const parentOf = (node: Node): Node | null => {
  const parent = (node as Element).assignedSlot ?? node.parentNode
  return parent !== null && parent.nodeType === 11
    ? (parent as ShadowRoot).host
    : parent
}

const layoutOffset = (tab: HTMLElement, list: HTMLElement) => {
  const own = cumulativeOffset(tab)
  const ancestor = cumulativeOffset(list)
  let left = own.left - ancestor.left - list.clientLeft
  let top = own.top - ancestor.top - list.clientTop
  let node = parentOf(tab)
  while (
    isHTMLElement(node) && node !== list && node.localName !== "body" &&
    node.localName !== "html"
  ) {
    left -= node.scrollLeft
    top -= node.scrollTop
    node = parentOf(node)
  }
  return { left, top }
}

const translateLength = (value: string | undefined, size: number): number => {
  const numeric = value === undefined ? NaN : parseFloat(value)
  if (!Number.isFinite(numeric)) return 0
  return value!.endsWith("%") ? (numeric / 100) * size : numeric
}

const translationOf = (tab: HTMLElement, style: CSSStyleDeclaration) => {
  let x = 0
  let y = 0
  const matrix = style.transform?.match(/matrix(?:3d)?\(([^)]+)\)/)
  if (matrix != null) {
    const values = matrix[1]!.split(",").map(parseFloat)
    if (values.length === 6) {
      x = values[4]!
      y = values[5]!
    } else if (values.length === 16) {
      x = values[12]!
      y = values[13]!
    }
  }
  const translate = style.translate
  if (translate !== undefined && translate !== "" && translate !== "none") {
    const [tx, ty] = translate.split(" ")
    x += translateLength(tx, tab.offsetWidth)
    y += translateLength(ty, tab.offsetHeight)
  }
  return { x, y }
}

const activeTabVars = [
  "left",
  "right",
  "top",
  "bottom",
  "width",
  "height"
] as const

// The rect offset is exact to the subpixel but a rotation, skew or flip
// distorts it, so it is used only when it agrees with the layout offset.
const place = (
  indicator: HTMLElement,
  tab: HTMLElement,
  list: HTMLElement,
  view: Window
): boolean => {
  const tabStyle = view.getComputedStyle(tab)
  const size = cssSize(tab, tabStyle)
  const listSize = cssSize(list, view.getComputedStyle(list))
  const tabRect = tab.getBoundingClientRect()
  const listRect = list.getBoundingClientRect()
  const scaleX = listSize.width > 0 ? listRect.width / listSize.width : 1
  const scaleY = listSize.height > 0 ? listRect.height / listSize.height : 1
  let { left, top } = layoutOffset(tab, list)
  const rectLeft = (tabRect.left - listRect.left) / scaleX + list.scrollLeft -
    list.clientLeft
  const rectTop = (tabRect.top - listRect.top) / scaleY + list.scrollTop -
    list.clientTop
  const translation = translationOf(tab, tabStyle)
  if (
    Math.abs(rectLeft - translation.x - left) <= MAX_LAYOUT_ROUNDING_ERROR &&
    Math.abs(rectTop - translation.y - top) <= MAX_LAYOUT_ROUNDING_ERROR
  ) {
    left = rectLeft
    top = rectTop
  }
  const values = {
    left,
    right: list.scrollWidth - left - size.width,
    top,
    bottom: list.scrollHeight - top - size.height,
    width: size.width,
    height: size.height
  }
  for (const name of activeTabVars) {
    indicator.style.setProperty("--active-tab-" + name, values[name] + "px")
  }
  return size.width > 0 && size.height > 0
}

const TrackIndicator = Mount.makeStream(
  "TrackIndicator",
  {
    args: {
      tab: Schema.NullOr(Schema.String),
      tabs: Schema.Array(Schema.String)
    }
  },
  (node: unknown, initial, changes) =>
    Stream.callback<TabsMessage>((queue) =>
      Effect.gen(function*() {
        if (!isHTMLElement(node)) return
        const document = node.ownerDocument
        const view = document.defaultView
        const list = node.closest<HTMLElement>("[role=tablist]")
        let args = initial
        let observed: ReadonlyArray<string> | null = null
        let sized: boolean | null = null
        const measure = () => {
          const tab = args.tab === null
            ? null
            : document.getElementById(args.tab)
          const next = view !== null && list !== null && isHTMLElement(tab) &&
            place(node, tab, list, view)
          if (!next) {
            for (const name of activeTabVars) {
              node.style.removeProperty("--active-tab-" + name)
            }
          }
          if (next !== sized) {
            Queue.offerUnsafe(
              queue,
              TabsMessage.MeasuredActiveTab({ sized: next })
            )
          }
          sized = next
        }
        const resizeObserver =
          view === null || typeof view.ResizeObserver === "undefined"
            ? null
            : new view.ResizeObserver(measure)
        const observe = (tabs: ReadonlyArray<string>) => {
          if (resizeObserver === null) return
          resizeObserver.disconnect()
          if (list !== null) resizeObserver.observe(list)
          for (const id of tabs) {
            const tab = document.getElementById(id)
            if (tab !== null) resizeObserver.observe(tab)
          }
        }
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => resizeObserver?.disconnect())
        )
        yield* Stream.runForEach(changes, (next) =>
          Effect.sync(() => {
            args = next
            if (
              observed === null || observed.length !== next.tabs.length ||
              observed.some((id, i) => id !== next.tabs[i])
            ) {
              observed = next.tabs
              observe(next.tabs)
            }
            measure()
          })).pipe(Effect.forkScoped)
      })
    )
)

const releasedPointer = [
  HtmlSubscription.onDocument("pointerup", TabsMessage.ReleasedPointer()),
  HtmlSubscription.onDocument("pointercancel", TabsMessage.ReleasedPointer())
]

type Keyed<Tag extends string> = View.PartTarget<Tag> & {
  readonly key: (key: string) => View.PartTarget<Tag>
}

type TabOf<B extends View.PartTarget<"button" | "a">> = ReturnType<B["attr"]>

/**
 * A headless tabs component. Call it with the consumer's `h`, the `props`, an
 * `onEmit` for `Selected`, and a `view` closure that draws `tabs.root(h.div)`
 * around `tabs.list(h.div)`, with `tabs.tab({ element: h.button, value })` for
 * each entry of `tabs` inside it, and the panels with
 * `tabs.panel({ element: h.div, value })`.
 *
 * **Details**
 *
 * The parts also return `value`, `orientation` and `activationDirection`, for
 * markup that depends on them.
 *
 * Each part's own attributes win over the ones the consumer set on the
 * builder before the part, including the ones a state leaves absent:
 *
 * - every part: `data-orientation` and `data-activation-direction`
 * - `list`: `role="tablist"`, and `aria-orientation`, written only for a
 *   vertical list
 * - `tab`: `role="tab"`, `id`, `aria-selected`, `aria-controls`, added only
 *   while the view draws its panel, `aria-disabled`, `tabindex`, `disabled`, which it
 *   never sets so a disabled tab keeps its focus, `type="button"` on a
 *   `<button>`, `data-active` and `data-disabled`
 * - `panel`: `role="tabpanel"`, `id`, `aria-labelledby`, `hidden`, `inert` on
 *   a panel that isn't active, `tabindex`, `data-index`, `data-hidden`,
 *   `data-starting-style` and `data-ending-style`
 * - `indicator`: `role="presentation"` and `hidden`
 *
 * `aria-controls` and `aria-labelledby` are lists of ids, so the part adds
 * its id to the consumer's instead of replacing them.
 *
 * A part writes them when it is applied, so an attribute the consumer
 * chains after the part is the consumer's to answer for.
 *
 * A tab handles `click`, `keydown`, `focus` and `blur`, and `pointerdown` with
 * `activateOnFocus`, on a layer of its own, so the consumer's handlers for them
 * still run. It cancels the keys it handles, and a click on a disabled tab,
 * so a disabled link doesn't follow its `href`. A click on an enabled link
 * is left alone and follows it.
 *
 * Drawing a `tab` or a `panel` for a value that isn't in `tabs`, or two tabs
 * with one value, fails the render.
 *
 * History restore saves nothing of the tabs' own state, which is focus,
 * transitions and the indicator's measurement. The active tab is the
 * consumer's `value`, which restores with the consumer.
 *
 * @stability experimental
 * @category components
 * @since 0.1.0
 */
export const Tabs = Html.component({
  name: "Tabs",
  props: TabsProps,
  model: TabsModel,
  message: TabsMessage,
  events: TabsEvents,
  reads: {
    provider: { owner: DirectionProvider, optional: true }
  },
  restore: false
}).make({
  init: ({ props }) => ({
    highlighted: enabledIn(props.tabs, props.value) ? props.value : null,
    focused: false,
    secondary: null,
    shown: props.value,
    leaving: [],
    started: true,
    direction: "none",
    indicator: false,
    rtl: false
  }),
  update: {
    ClickedTab: ($, { value }) => activate($.model, $, value),
    FocusedTab: ($, { value }) => {
      const next = UiStruct.evolve($.model, {
        focused: true,
        highlighted: value
      })
      return $.props.activateOnFocus === true && $.model.secondary !== value
        ? activate(next, $, value)
        : next
    },
    BlurredTab: ($) => $.evolve({ focused: false }),
    PressedTab: ($, { button, value }) =>
      $.evolve({ secondary: button === 0 ? null : value }),
    ReleasedPointer: ($) => $.evolve({ secondary: null }),
    PressedKey: ($, { key, value }) => navigate($, value, key),
    ChangedValue: ($) => phaseOf($.model, $.props, rtlOf($)),
    RenderedFirstFrame: ($, { value }) => {
      const next = phaseOf($.model, $.props, rtlOf($))
      return value === next.shown
        ? UiStruct.evolve(next, { started: true })
        : next
    },
    FinishedTransition: ($, { value }) => {
      const next = phaseOf($.model, $.props, rtlOf($))
      return next.leaving.includes(value)
        ? UiStruct.evolve(next, {
          leaving: (leaving) => leaving.filter((v) => v !== value)
        })
        : next
    },
    MeasuredActiveTab: ($, { sized }) => $.evolve({ indicator: sized }),
    FoundDirection: ($, { rtl }) => $.evolve({ rtl })
  },
  subscriptions: ({ model, props }) => [
    props.value !== model.shown &&
    Subscription.make(
      "changedValue",
      [props.value],
      () => Stream.make(TabsMessage.ChangedValue())
    ),
    ...(model.secondary === null ? [] : releasedPointer)
  ],
  parts: (p, model) => {
    const props = p.props
    const tabs = props.tabs
    const orientation = props.orientation ?? "horizontal"
    const rtl = rightToLeft(p.reads.provider, model.rtl)
    const phase = phaseOf(model, props, rtl)
    const entries = new Map<
      string,
      { readonly tab: TabsTab; readonly index: number }
    >()
    tabs.forEach((tab, index) => {
      if (entries.has(tab.value)) {
        throw new Error(
          "Tabs: two tabs have the value " + JSON.stringify(tab.value)
        )
      }
      entries.set(tab.value, { tab, index })
    })
    const entryOf = (value: string, part: string) => {
      const entry = entries.get(value)
      if (entry === undefined) {
        throw new Error(
          "Tabs: a " + part + " was drawn for " + JSON.stringify(value) +
            ", which isn't in tabs"
        )
      }
      return entry
    }
    const tabId = (value: string) => p.id("tab", value)
    const panelId = (value: string) => p.id("panel", value)
    const mounted = (value: string) =>
      value === props.value || phase.leaving.includes(value)
    const drawn = new Set<string>()
    const stop = phase.highlighted !== null && entries.has(phase.highlighted)
      ? phase.highlighted
      : (tabs.find((tab) => tab.disabled !== true) ?? tabs[0])?.value ?? null
    const common = <B extends Attributed<B>>(builder: B): B =>
      builder.attrs({
        "data-orientation": orientation,
        "data-activation-direction": phase.direction
      })

    const tabPart = keyed(p.part(["button", "a"], (b, value: string) => {
      const { tab } = entryOf(value, "tab")
      const active = value === props.value
      const disabled = tab.disabled === true
      const decorated = common(b)
        .ref(Tab.at(value) as never)
        .attrs({
          role: "tab",
          id: tabId(value),
          "aria-selected": String(active),
          "aria-disabled": disabled ? "true" : undefined,
          tabindex: value === stop ? "0" : "-1",
          disabled: undefined,
          "data-active": flag(active),
          "data-disabled": flag(disabled)
        })
        .on(
          "click",
          TabsMessage.ClickedTab({ value }),
          disabled ? { preventDefault: "always" } : undefined
        )
        .on(
          "keydown",
          (event) =>
            ListNavigation.isKey(event, orientation)
              ? TabsMessage.PressedKey({ value, key: event.key })
              : undefined,
          { preventDefault: true }
        )
        .on("focus", TabsMessage.FocusedTab({ value }))
        .on("blur", TabsMessage.BlurredTab())
      const typed = b.tag === "button"
        ? decorated.attr("type", "button")
        : decorated
      return props.activateOnFocus === true
        ? typed.on(
          "pointerdown",
          ({ button }: Html.PointerPayload) =>
            TabsMessage.PressedTab({ value, button })
        )
        : typed
    }))

    const panelPart = keyed(p.part((b, value: string) => {
      const { index } = entryOf(value, "panel")
      const open = value === props.value
      const shown = mounted(value)
      const status = statusOf({
        mounted: phase.leaving.includes(value),
        started: phase.started
      }, { open })
      const decorated = common(b).attrs({
        role: "tabpanel",
        id: panelId(value),
        "aria-labelledby": tabId(value),
        hidden: flag(!shown),
        inert: flag(!open),
        tabindex: open ? "0" : "-1",
        "data-index": String(index),
        "data-hidden": flag(!shown),
        "data-starting-style": flag(status === "starting"),
        "data-ending-style": flag(status === "ending")
      })
      return status === null
        ? decorated
        : decorated.onMount(TrackPanel({ value, status }))
    }))

    const indicatorPart = p.part((b) =>
      common(b)
        .attrs({ role: "presentation", hidden: flag(!phase.indicator) })
        .onMount(TrackIndicator({
          tab: props.value !== null && entries.has(props.value)
            ? tabId(props.value)
            : null,
          tabs: tabs.map((tab) => tabId(tab.value))
        }))
    )

    return {
      value: props.value,
      orientation,
      activationDirection: phase.direction,
      root: p.part((b) =>
        common(b).forward((node) =>
          drawn.size === 0
            ? node
            : linkPanels(
              View.build(node, []),
              new Map([...drawn].map((value) => [tabId(value), panelId(value)]))
            )
        )
      ),
      list: p.part((b) =>
        common(b)
          .attrs({
            role: "tablist",
            "aria-orientation": orientation === "vertical"
              ? "vertical"
              : undefined
          })
          .onMount(ActivateFromKeys({ css: p.reads.provider === undefined }))
      ),
      tab: View.wrapPart(
        tabPart,
        <B extends Keyed<"button" | "a">>(
          { element, value }: { readonly element: B; readonly value: string }
        ): TabOf<B> => tabPart(element, value) as TabOf<B>
      ),
      panel: View.wrapPart(
        panelPart,
        <B extends Keyed<string>>(
          { element, value }: { readonly element: B; readonly value: string }
        ): ReturnType<B["attr"]> | undefined => {
          const panel = panelPart(element, value)
          if (
            !mounted(value) &&
            !(entryOf(value, "panel").tab.keepMounted ??
              props.keepMounted === true)
          ) {
            return undefined
          }
          drawn.add(value)
          return panel
        }
      ),
      indicator: <B extends View.PartTarget<string>>(
        element: B
      ): ReturnType<B["attr"]> | undefined => {
        const indicator = indicatorPart(element)
        return props.value === null ? undefined : indicator
      }
    }
  }
})
