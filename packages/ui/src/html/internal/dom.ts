import * as Cause from "effect/Cause"
import * as Kernel from "../../internal/kernel.ts"
import * as transitionRun from "../../internal/transitionRun.ts"
import type * as View from "../../View.ts"
import type * as Html from "../Html.ts"
import * as documentHead from "./documentHead.ts"
import { attributeName, isCustomTag, svgTags } from "./elements.ts"
import { bubblingEvents, ownEvents } from "./ownEvents.ts"
import {
  type FieldState,
  fieldStateOf,
  offsetIn,
  payloadOf
} from "./payload.ts"
import { pointerTypeOf } from "./pointer.ts"
import * as submit from "./submit.ts"
import * as url from "./url.ts"

/** @internal */
export const SVG = "http://www.w3.org/2000/svg"

/** @internal */
export const attributeOf = (
  element: globalThis.Element,
  name: string
): string | undefined => {
  const html = attributeName(name, false)
  return html === name || element.namespaceURI !== SVG
    ? html
    : attributeName(name, true)
}

/** @internal */
export const controlled: ReadonlySet<string> = new Set([
  "value",
  "checked",
  "selected",
  "open",
  "popoverOpen"
])

const restoring: ReadonlySet<string> = new Set([
  "input",
  "change",
  "compositionend",
  "toggle",
  "close",
  "reset"
])

const dropTargetEvents: ReadonlySet<string> = new Set([
  "dragenter",
  "dragleave",
  "dragover",
  "drop"
])

const typesOf = (event: DragEvent): ReadonlyArray<string> =>
  Array.from(event.dataTransfer?.types ?? [], (type) => type.toLowerCase())

const boxOf = (
  event: DragEvent,
  element: globalThis.Element
): Html.DragOverPayload => {
  const rect = element.getBoundingClientRect()
  return {
    x: (event.clientX ?? 0) - rect.left,
    y: (event.clientY ?? 0) - rect.top,
    width: rect.width,
    height: rect.height
  }
}

const isDialog = (node: globalThis.Node): node is HTMLDialogElement =>
  (node as globalThis.Element).localName === "dialog"

const matches = (element: globalThis.Element, selector: string): boolean => {
  try {
    return element.matches(selector)
  } catch {
    return false
  }
}

const inOrder = <A extends globalThis.Node>(nodes: Array<A>): Array<A> =>
  nodes.sort((a, b) => (a.compareDocumentPosition(b) & 4) !== 0 ? -1 : 1)

interface Showing {
  byHost: boolean
  closed: boolean
}

/** @internal */
export const isRadio = (node: globalThis.Node): node is HTMLInputElement =>
  (node as globalThis.Element).localName === "input" &&
  (node as HTMLInputElement).type === "radio"

/** @internal */
export const radioGroup = (
  radio: HTMLInputElement
): ReadonlyArray<HTMLInputElement> => {
  if (radio.name === "") return [radio]
  const root = radio.getRootNode() as Document | DocumentFragment
  return Array.from(
    root.querySelectorAll<HTMLInputElement>(`input[type="radio"]`)
  ).filter((other) => other.name === radio.name && other.form === radio.form)
}

const canonicalAttrs = (
  attrs: Readonly<Record<string, string>>
): Readonly<Record<string, string>> => {
  const out: Record<string, string> = Object.create(null)
  for (const name in attrs) {
    const normalized = attributeName(name, false)
    if (normalized !== undefined) out[normalized] = attrs[name]!
  }
  return out
}

const ignore = () => {}

// The nodes a render is taking out of the document while focus is inside
// them. Chromium blurs a focused element as it goes, and a dialog closing in
// one can move focus to another element in it first. Shared by every host,
// because `BrowserHost` removes through one host while another one listens.
const leaving: Array<
  { readonly node: globalThis.Node; readonly kept: boolean }
> = []

/** Whether `target` is `node` or inside it, through shadow roots. */
const within = (node: globalThis.Node, target: globalThis.Node | null) => {
  for (
    let at = target;
    at !== null;
    at = at.parentNode ?? (at as ShadowRoot).host ?? null
  ) {
    if (at === node) return true
  }
  return false
}

const isLeaving = (target: globalThis.Node): boolean =>
  leaving.some(({ kept, node }) =>
    !(kept && target === node) && within(node, target)
  )

/**
 * Runs `f`, which takes `node` out of the document, or only its children
 * when `kept`. It counts only when focus was inside before `f`, so a first
 * insertion doesn't. A move (`moved`) counts only until focus is back
 * inside, so focus a custom element's `connectedCallback` takes and then
 * moves out is a real exit. That is `focus`, not `focusin`, which a
 * `focus` handler moving focus on comes after.
 */
const takingOut = (
  node: globalThis.Node,
  how: "removed" | "kept" | "moved",
  f: () => void
): void => {
  const kept = how === "kept"
  const focused = node.isConnected
    ? (node.getRootNode() as Document | ShadowRoot).activeElement
    : null
  if (
    focused === null || focused === undefined || (kept && focused === node) ||
    !node.contains(focused)
  ) return f()
  const entry = { node, kept }
  const back = () => {
    const at = leaving.indexOf(entry)
    if (at >= 0) leaving.splice(at, 1)
  }
  leaving.push(entry)
  if (how === "moved") node.addEventListener("focus", back, true)
  try {
    f()
  } finally {
    back()
    if (how === "moved") node.removeEventListener("focus", back, true)
  }
}

type Node = globalThis.Node & { $r?: Kernel.Rec }

/** @internal */
export const written = new WeakMap<globalThis.Node, Map<string, unknown>>()

const plain = new WeakMap<globalThis.Node, Map<string, unknown>>()

interface HostOptions {
  readonly head?: boolean | undefined
  readonly warn: (message: string) => void
  readonly step?: ((f: () => boolean) => boolean) | undefined
}

/** @internal */
export const makeHost = (
  container: globalThis.Element,
  options: HostOptions
): Kernel.Host<globalThis.Node> & {
  readonly dispose: () => void
  readonly pause: (on: boolean) => void
} => {
  const document = container.ownerDocument
  const view = document.defaultView
  const listening = new Set<string>()
  const composing = new WeakSet<globalThis.Node>()
  const forms = new WeakSet<EventTarget>()
  const edits = new WeakMap<globalThis.Node, Map<string, FieldState>>()
  let pending: {
    readonly node: globalThis.Node
    readonly state: FieldState
    readonly event: Event
  } | undefined
  let scratch: CSSStyleDeclaration | undefined
  const step = options.step ?? ((f) => f())
  const remember = (node: globalThis.Node, state: FieldState | undefined) => {
    if (state === undefined) return
    let states = edits.get(node)
    if (states === undefined) edits.set(node, states = new Map())
    states.set(state.value, state)
  }
  let lastPointer: Html.PointerType | undefined
  let restore: Set<globalThis.Node> | undefined
  let transition: ViewTransition | undefined
  const later: (f: () => void) => void =
    typeof view?.requestAnimationFrame === "function"
      ? (f) => view.requestAnimationFrame(f)
      : (f) => setTimeout(f, 0)

  const writeControlled = (element: any, name: string, value: unknown) => {
    if (
      name === "value" &&
      (composing.has(element) || (value !== "" && element.type === "file"))
    ) return
    const state =
      name === "value" && element.getRootNode().activeElement === element
        ? fieldStateOf(element)
        : undefined
    if (state === undefined) {
      element[name] = value
      return
    }
    const { scrollLeft, scrollTop } = element
    element.value = value
    const shown: string = element.value
    const before = edits.get(element)?.get(shown)
    if (before !== undefined) {
      element.setSelectionRange(before.start, before.end, before.direction)
    } else if (state.start !== state.end || state.end !== state.value.length) {
      const start = offsetIn(state.value, shown, state.start)
      element.setSelectionRange(
        start,
        state.end === state.start
          ? start
          : offsetIn(state.value, shown, state.end),
        state.direction
      )
    } else return
    element.scrollLeft = scrollLeft
    element.scrollTop = scrollTop
  }

  const keepingScroll = (show: () => void) => {
    const focused = document.activeElement
    const left = view?.scrollX ?? 0
    const top = view?.scrollY ?? 0
    show()
    if (document.activeElement !== focused) {
      view?.scrollTo?.({ left, top, behavior: "instant" })
    }
  }

  const modals = new WeakSet<globalThis.Node>()
  const showings = new WeakMap<globalThis.Node, Array<Showing>>()
  const modalWanted = new Set<HTMLDialogElement>()
  const shown = new Set<HTMLDialogElement>()
  let modalPseudo: boolean | undefined
  const showingsOf = (dialog: globalThis.Node) => {
    let list = showings.get(dialog)
    if (list === undefined) showings.set(dialog, list = [])
    return list
  }
  const adoptShowing = (dialog: HTMLDialogElement) => {
    if (!dialog.open) return
    const list = showingsOf(dialog)
    if (list.at(-1)?.closed !== false) {
      list.push({ byHost: false, closed: false })
    }
    shown.add(dialog)
  }
  const closeDialog = (dialog: HTMLDialogElement, byHost: boolean) => {
    if (!dialog.open) return
    modals.delete(dialog)
    adoptShowing(dialog)
    shown.delete(dialog)
    const current = showingsOf(dialog).at(-1)!
    current.closed = true
    current.byHost = byHost
    dialog.close()
  }
  const closeShownIn = (node: globalThis.Node, self: boolean) => {
    for (const dialog of [...shown].reverse()) {
      if ((self || dialog !== node) && node.contains(dialog)) {
        closeDialog(dialog, true)
      }
    }
  }
  const showDialog = (dialog: HTMLDialogElement, want: unknown) => {
    adoptShowing(dialog)
    const current = !dialog.open
      ? false
      : modals.has(dialog) &&
          (modalPseudo !== true || matches(dialog, ":modal"))
      ? "modal"
      : true
    if (current === want) return
    if (want === false) return closeDialog(dialog, false)
    if (current !== false) closeDialog(dialog, true)
    if (want === "modal") {
      keepingScroll(() => dialog.showModal())
      modals.add(dialog)
      modalPseudo ??= matches(dialog, ":modal")
    } else dialog.show()
    showingsOf(dialog).push({ byHost: false, closed: false })
    shown.add(dialog)
  }

  const popoversToShow = new Set<HTMLElement>()
  let held = false
  const heldNodes = new Set<globalThis.Node>()
  const reported = new WeakMap<globalThis.Node, { state: string | undefined }>()
  const holdNode = (node: globalThis.Node) => {
    heldNodes.add(node)
    if (listening.has("toggle") && !reported.has(node)) {
      reported.set(node, { state: undefined })
    }
  }
  const releaseNode = (node: globalThis.Node) => {
    if (!heldNodes.delete(node)) return
    const entry = reported.get(node)
    if (entry !== undefined) entry.state = "closed"
  }
  const manualPopovers = new Set<HTMLElement>()
  const popoverModes = new WeakMap<globalThis.Node, string | null>()
  const applyPopover = (element: HTMLElement, want: unknown, now?: boolean) => {
    if (want !== true) {
      popoversToShow.delete(element)
      if (matches(element, ":popover-open")) element.hidePopover()
    } else if (!now) popoversToShow.add(element)
    else if (
      element.isConnected && element.hasAttribute("popover") &&
      !matches(element, ":popover-open")
    ) keepingScroll(() => element.showPopover())
  }

  const restoreNode = (node: globalThis.Node) => {
    const values = written.get(node)
    if (values === undefined) return
    for (const [name, value] of values) {
      if (name === "open" && isDialog(node)) {
        if (node.isConnected && !(held && value === "modal")) {
          showDialog(node, value)
        }
      } else if (name === "popoverOpen") {
        if ((node as globalThis.Element).getAttribute("popover") === "manual") {
          applyPopover(node as HTMLElement, value, true)
        }
      } else if ((node as any)[name] !== value) {
        writeControlled(node, name, value)
      }
    }
  }

  const restoreAffected = (node: globalThis.Node): void => {
    restoreNode(node)
    const element = node as globalThis.Element
    if (isRadio(element)) {
      for (const other of radioGroup(element)) restoreNode(other)
    } else if (element.localName === "select") {
      for (const option of (node as HTMLSelectElement).options) {
        restoreNode(option)
      }
    } else if (element.localName === "form") {
      for (const control of (node as HTMLFormElement).elements) {
        restoreAffected(control)
      }
    }
  }

  const restoreSoon = (target: globalThis.Node) => {
    if (restore === undefined) {
      const nodes = restore = new Set()
      later(() => {
        restore = undefined
        for (const node of nodes) {
          restoreAffected(node)
          if (!composing.has(node)) edits.delete(node)
        }
      })
    }
    restore.add(target)
  }

  const elementOf = (node: globalThis.Node) =>
    (node as Node).$r?.v as View.Element<any, any> | undefined

  const dispatch = (
    node: globalThis.Node,
    name: string,
    payload: () => unknown,
    event?: Event
  ): boolean => {
    const rec = (node as Node).$r
    const element = rec?.v as View.Element<any, any> | undefined
    const handler = element?.handlers[name]
    if (handler === undefined) return false
    const prevents = element!.eventOptions[name]?.preventDefault
    if (prevents === "always") event?.preventDefault()
    const inst = rec!.inst
    step(() => {
      if (inst.closed) return false
      if (handler?.["~fire"] !== undefined) {
        return handler["~fire"](payload(), name, () => event?.preventDefault())
      }
      let message = handler
      if (typeof handler === "function") {
        try {
          message = handler(payload())
        } catch (error) {
          Kernel.fail(inst, "event", Cause.die(error))
          return false
        }
      }
      if (message === undefined) return false
      if (prevents === true) event?.preventDefault()
      Kernel.send(inst, message, name)
      return true
    })
    return true
  }

  let active: globalThis.Element | undefined
  let entered: EventTarget | null = null
  let exitCheck: ReturnType<typeof setTimeout> | undefined
  let droppedHere = false
  let overFrame = false
  let over:
    | readonly [globalThis.Element, Html.DragOverPayload, ReadonlyArray<string>]
    | undefined
  let overSent: Html.DragOverPayload | undefined

  const accepts = (node: globalThis.Node, types: ReadonlyArray<string>) => {
    const element = elementOf(node)
    return element?.handlers.drop !== undefined &&
      (element.eventOptions.drop as Html.DropTargetOptions | undefined)?.accepts
          ?.some((type) => types.includes(type.toLowerCase())) === true
  }

  const dropTargetOf = (event: DragEvent, path: ReadonlyArray<Node>) => {
    const types = typesOf(event)
    for (const node of path) {
      if (node === container) return
      if (accepts(node, types)) return node as globalThis.Element
    }
  }

  const activate = (next: globalThis.Element | undefined) => {
    if (next === active) return
    const previous = active
    active = next
    over = overSent = undefined
    if (previous !== undefined) dispatch(previous, "dragleave", () => ({}))
    if (next !== undefined) dispatch(next, "dragenter", () => ({}))
  }

  const endTargets = () => {
    clearTimeout(exitCheck)
    entered = null
    activate(undefined)
  }

  const queueOver = (element: globalThis.Element, event: DragEvent) => {
    if (elementOf(element)?.handlers.dragover === undefined) return
    over = [element, boxOf(event, element), typesOf(event)]
    if (overFrame) return
    overFrame = true
    later(() => {
      overFrame = false
      const queued = over
      over = undefined
      if (queued === undefined) return
      const [element, next, types] = queued
      if (
        active !== element || !element.isConnected ||
        !accepts(element, types) ||
        (overSent !== undefined && overSent.x === next.x &&
          overSent.y === next.y && overSent.width === next.width &&
          overSent.height === next.height)
      ) return
      overSent = next
      dispatch(element, "dragover", () => next)
    })
  }

  const onDropTarget = (
    name: string,
    event: DragEvent,
    path: ReadonlyArray<Node>
  ) => {
    if (name === "dragleave") {
      if (event.target !== entered) return
      clearTimeout(exitCheck)
      exitCheck = setTimeout(endTargets, 0)
      return
    }
    const target = dropTargetOf(event, path)
    if (name === "drop") {
      if (target !== undefined) {
        event.preventDefault()
        droppedHere = true
        const transfer = event.dataTransfer
        const data: Record<string, string> = Object.create(null)
        for (const type of transfer?.types ?? []) {
          if (type !== "Files") data[type] = transfer!.getData(type)
        }
        const payload: Html.DropPayload = {
          data,
          files: Array.from(transfer?.files ?? []),
          ...boxOf(event, target)
        }
        dispatch(target, "drop", () => payload)
      }
      return endTargets()
    }
    clearTimeout(exitCheck)
    if (name === "dragenter") entered = event.target
    if (target !== undefined) {
      event.preventDefault()
      const dropEffect =
        (elementOf(target)!.eventOptions.drop as Html.DropTargetOptions)
          .dropEffect
      if (dropEffect !== undefined && event.dataTransfer !== null) {
        event.dataTransfer.dropEffect = dropEffect
      }
    }
    activate(target)
    if (name === "dragover" && target !== undefined) queueOver(target, event)
  }

  const startDrag = (event: DragEvent, path: ReadonlyArray<Node>) => {
    droppedHere = false
    const transfer = event.dataTransfer
    if (transfer === null) return
    for (const node of path) {
      if (node === container) return
      const source = elementOf(node)?.eventOptions.dragstart as
        | Html.DragSourceOptions
        | undefined
      if (source?.data !== undefined) {
        for (const type in source.data) {
          transfer.setData(type, source.data[type]!)
        }
        if (source.effectAllowed !== undefined) {
          transfer.effectAllowed = source.effectAllowed
        }
        return
      }
    }
  }

  const deliver = (
    event: Event,
    path: ReadonlyArray<Node>,
    own: boolean,
    payloadFor: (node: Node) => unknown
  ): boolean => {
    let node: Node
    const payload = () => payloadFor(node)
    const from = own ? Math.max(path.indexOf(event.target as Node), 0) : 0
    for (let index = from; index < path.length; index++) {
      node = path[index]!
      if (node === container) break
      if (dispatch(node, event.type, payload, event)) return true
      if (own) break
    }
    return false
  }

  const listener = (event: Event): void => {
    const name = event.type
    const path = event.composedPath() as Array<Node>
    const custom = view !== null && event instanceof view.CustomEvent
    const detailFor = (node: Node) =>
      custom && isCustomTag((node as globalThis.Element).localName ?? "")
    if (detailFor(event.target as Node)) {
      deliver(
        event,
        path,
        !event.bubbles || ownEvents.has(name),
        () => ({ detail: (event as CustomEvent).detail })
      )
      return
    }
    if (dropTargetEvents.has(name)) {
      return onDropTarget(name, event as DragEvent, path)
    }
    const target = path[0] ?? event.target as Node
    const entry = name === "toggle" ? reported.get(target) : undefined
    if (entry !== undefined) {
      entry.state ??= (event as ToggleEvent).oldState
      if (heldNodes.has(target)) return
      reported.delete(target)
      if ((event as ToggleEvent).newState === entry.state) return
    }
    const composed = (event as InputEvent).isComposing === true
    if (isDialog(target)) {
      if (name === "cancel") {
        if (written.get(target)?.get("open") === "modal") event.preventDefault()
      } else if (name === "close") {
        const list = showings.get(target)
        const ended = list?.shift()
        if (ended !== undefined && (ended.byHost || list!.length > 0)) return
        if (!target.open) modals.delete(target)
      }
    }
    if (name === "pointerdown") lastPointer = pointerTypeOf(event) || undefined
    else if (name === "beforeinput") {
      const state = composed || composing.has(target)
        ? undefined
        : fieldStateOf(target)
      const edit = pending = state === undefined
        ? undefined
        : { node: target, state, event }
      if (edit !== undefined) {
        setTimeout(() => pending === edit && (pending = undefined), 0)
      }
    } else if (
      name === "compositionstart" || name === "compositionend" ||
      name === "input"
    ) {
      if (name === "compositionstart") remember(target, fieldStateOf(target))
      else if (name === "input") {
        const edit = pending
        pending = undefined
        if (
          edit?.node === target && !edit.event.defaultPrevented &&
          (edit.event as InputEvent).inputType ===
            (event as InputEvent).inputType
        ) remember(target, edit.state)
      }
      if (name === "compositionstart" || composed) composing.add(target)
      else composing.delete(target)
    }
    if (name === "dragstart") startDrag(event as DragEvent, path)
    const removed = leaving.length > 0 && isLeaving(target)
    const handled = deliver(
      event,
      path,
      ownEvents.has(name) ||
        (!event.bubbles && (custom || !bubblingEvents.has(name))),
      (node) =>
        detailFor(node)
          ? { detail: (event as CustomEvent).detail }
          : name === "dragend"
          ? {
            dropped: droppedHere ||
              ((event as DragEvent).dataTransfer?.dropEffect ?? "none") !==
                "none"
          }
          : payloadOf(
            name,
            event,
            target,
            node as globalThis.Element,
            lastPointer,
            removed
          )
    )
    if (
      name === "submit" && event.target !== null && forms.has(event.target)
    ) {
      submit.ownedUnhandled.delete(event)
      if (handled) event.preventDefault()
      else {
        const kind = submit.kindOf(
          event.target as globalThis.Element,
          (event as SubmitEvent).submitter ?? null
        )
        if (kind !== "native") event.preventDefault()
        if (kind === "get") submit.ownedUnhandled.add(event)
      }
    }
    if (name === "dragend") endTargets()
    if (restoring.has(name) && target !== undefined && target !== null) {
      restoreSoon(target)
    }
  }

  const listen = (name: string) => {
    if (listening.has(name)) return
    listening.add(name)
    container.addEventListener(name, listener, true)
    if (name === "click") listen("pointerdown")
    else if (name === "dragend") listen("dragstart")
    else if (name === "drop") {
      for (const targetEvent of dropTargetEvents) listen(targetEvent)
      listen("dragend")
    }
  }

  const form = (node: globalThis.Node) => {
    forms.add(node)
    listen("submit")
  }

  const sync = options.head
    ? documentHead.make(document, options.warn)
    : undefined

  const start = (update: () => void, types: ReadonlyArray<string>) => {
    if (
      typeof document.startViewTransition !== "function" ||
      view?.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
    ) return update()
    let ran = false
    const run = () => {
      ran = true
      update()
    }
    try {
      transition = document.startViewTransition(
        types.length > 0 && "types" in (view?.ViewTransition?.prototype ?? {})
          ? { update: run, types: [...types] }
          : run
      )
    } catch (error) {
      if (ran) throw error
      return update()
    }
    transition.ready.catch(ignore)
    transition.finished.catch(ignore)
  }

  return {
    createElement(tag) {
      if (svgTags.has(tag)) return document.createElementNS(SVG, tag)
      const element = document.createElement(tag)
      if (tag.length === 4 && tag.toLowerCase() === "form") form(element)
      return element
    },
    form,
    createText: (text) => document.createTextNode(text),
    setText(node, text) {
      ;(node as globalThis.Text).data = text
    },
    normalizeAttrs(node, attrs) {
      for (const name in attrs) {
        if (attributeName(name, false) !== name) {
          return (node as globalThis.Element).namespaceURI === SVG
            ? attrs
            : canonicalAttrs(attrs)
        }
      }
      return attrs
    },
    setAttr(node, name, value, previous) {
      const element = node as HTMLElement
      const normalized = attributeOf(element, name)
      if (normalized === undefined) return
      if (value !== undefined && url.blockedAttribute(normalized, value)) {
        value = undefined
      }
      if (
        normalized !== "style" || element.style === undefined ||
        element.getAttribute("style") === (previous ?? null)
      ) {
        if (value === undefined) element.removeAttribute(normalized)
        else element.setAttribute(normalized, value)
        return
      }
      const style = element.style
      const before = scratch ??= document.createElement("div").style
      before.cssText = previous ?? ""
      const kept: Array<string> = []
      for (let index = 0; index < style.length; index++) {
        const property = style[index]!
        const own = style.getPropertyValue(property)
        const priority = style.getPropertyPriority(property)
        if (
          own !== before.getPropertyValue(property) ||
          priority !== before.getPropertyPriority(property)
        ) {
          kept.push(property, own, priority)
        }
      }
      if (value === undefined) element.removeAttribute("style")
      else element.setAttribute("style", value)
      for (let index = 0; index < kept.length; index += 3) {
        style.setProperty(kept[index]!, kept[index + 1]!, kept[index + 2])
      }
    },
    setProp(node, name, value) {
      const element = node as any
      const control = controlled.has(name)
      if (control && name !== "popoverOpen" && isCustomTag(element.localName)) {
        let values = plain.get(node)
        if (values === undefined) plain.set(node, values = new Map())
        if (values.has(name) && values.get(name) === value) return
        values.set(name, value)
      } else if (control) {
        let values = written.get(node)
        const dialog = name === "open" && isDialog(node)
        const popover = name === "popoverOpen"
        if (value === undefined && !dialog && !popover) {
          values?.delete(name)
          value = name === "value" ? "" : false
        } else {
          if (values === undefined) {
            written.set(node, values = new Map())
          }
          for (const event of restoring) listen(event)
          listen("compositionstart")
          listen("beforeinput")
          if (popover) {
            value = value === true
            const mode = element.getAttribute("popover")
            const same = values.get(name) === value &&
              popoverModes.get(node) === mode
            values.set(name, value)
            popoverModes.set(node, mode)
            manualPopovers[mode === "manual" ? "add" : "delete"](element)
            if (mode !== "auto" || !same) {
              releaseNode(node)
              applyPopover(element, value)
            }
            return
          }
          if (dialog) {
            value = value === "modal" ? value : value === true
            if (values.get(name) !== value) releaseNode(node)
            values.set(name, value)
            if (value === "modal") {
              modalWanted.add(node)
              listen("cancel")
            } else {
              modalWanted.delete(node)
              showDialog(node, value)
            }
            return
          }
          values.set(name, value)
        }
        if (element[name] !== value) writeControlled(element, name, value)
        if (name === "value" && !composing.has(node)) edits.delete(node)
        return
      }
      // Writing `""` would still navigate, so the reflected attribute goes.
      if (url.blockedProperty(element.localName, name, value)) {
        element.removeAttribute(name.toLowerCase())
        return
      }
      element[name] = value === undefined
        ? (typeof element[name] === "string"
          ? ""
          : typeof element[name] === "boolean"
          ? false
          : null)
        : value
    },
    setEvents(node, record, first) {
      if (first) (node as Node).$r = record
      const { eventOptions, handlers } = record.v as View.Element<any, any>
      for (const name in handlers) listen(name)
      // `dragend` brings `dragstart` with it.
      if (eventOptions.dragstart !== undefined) listen("dragend")
    },
    insert(parent, node, before) {
      // Moving a node takes it out first.
      takingOut(node, "moved", () => parent.insertBefore(node, before))
    },
    remove(parent, node) {
      takingOut(node, "removed", () => {
        if (shown.size > 0) closeShownIn(node, true)
        parent.removeChild(node)
      })
    },
    clear(parent) {
      takingOut(parent, "kept", () => {
        if (shown.size > 0) closeShownIn(parent, false)
        parent.textContent = ""
      })
    },
    parentOf: (node) => node.parentNode!,
    nextOf: (node) => node.nextSibling,
    createContainer: () => document.createDocumentFragment(),
    controlled,
    runsMounts: true,
    commit() {
      for (const dialog of shown) {
        if (!dialog.open || !dialog.isConnected) shown.delete(dialog)
      }
      if (modalWanted.size > 0) {
        for (const dialog of inOrder([...modalWanted])) {
          if (!dialog.isConnected) modalWanted.delete(dialog)
          else if (!held) showDialog(dialog, "modal")
        }
      }
      for (const element of manualPopovers) {
        if (!element.isConnected) manualPopovers.delete(element)
        else if (written.get(element)?.get("popoverOpen") === true) {
          popoversToShow.add(element)
        } else applyPopover(element, false)
      }
      if (popoversToShow.size > 0) {
        const popovers = inOrder([...popoversToShow])
        popoversToShow.clear()
        for (const element of popovers) {
          if (held && !manualPopovers.has(element)) popoversToShow.add(element)
          else applyPopover(element, true, true)
        }
      }
    },
    pause(on) {
      held = on
      if (!on) {
        this.commit!()
        heldNodes.clear()
        return
      }
      const popovers = Array.from(
        container.querySelectorAll<HTMLElement>("[popover]")
      ).filter((element) =>
        !manualPopovers.has(element) &&
        written.get(element)?.get("popoverOpen") === true &&
        matches(element, ":popover-open")
      )
      for (const dialog of [...shown].reverse()) {
        if (!modals.has(dialog)) continue
        closeDialog(dialog, true)
        holdNode(dialog)
      }
      for (const element of popovers.reverse()) {
        if (matches(element, ":popover-open")) element.hidePopover()
        popoversToShow.add(element)
        holdNode(element)
      }
    },
    head: sync === undefined ? undefined : (head) => sync.sync(head as never),
    transitions: transitionRun.make(start),
    dispose() {
      transition?.skipTransition()
      transition = undefined
      sync?.release()
      for (const node of container.querySelectorAll("*")) {
        delete (node as Node).$r
      }
      for (const name of listening) {
        container.removeEventListener(name, listener, true)
      }
      listening.clear()
      endTargets()
    }
  }
}
