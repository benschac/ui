import type * as Html from "../Html.ts"
import { nonTextInputTypes } from "./editable.ts"
import { modifiers, pointerTypeOf } from "./pointer.ts"

const HTML = "http://www.w3.org/1999/xhtml"

/**
 * The `pointerType` of a click-like event's payload. A click with `detail`
 * 0, or a pointer event with an empty `pointerType`, came from no pointer:
 * the keyboard, or a script. Otherwise the last `pointerdown` says which
 * pointer it was, since a browser may report a tap's `click` as a mouse's,
 * as WebKit does. Without one, the event's own type, and `"mouse"` last.
 */
const pressedWith = (
  name: string,
  event: Event,
  last: Html.PointerType | undefined
): Html.PointerType => {
  const own = pointerTypeOf(event)
  if (own === "" || (name === "click" && (event as MouseEvent).detail === 0)) {
    return ""
  }
  return last ?? own ?? "mouse"
}

const fieldsOf = (
  form: HTMLFormElement,
  submitter: HTMLElement | null
) => {
  let data: FormData
  try {
    data = new FormData(form, submitter)
  } catch {
    data = new FormData(form)
  }
  // No prototype, so fields named `constructor` or `__proto__` are kept like any other.
  const fields: Record<string, string> = Object.create(null)
  const entries: Array<readonly [string, string]> = []
  data.forEach((value, name) => {
    if (typeof value !== "string") return
    entries.push([name, value])
    if (!Object.hasOwn(fields, name)) fields[name] = value
  })
  return { fields, entries }
}

/** The payload of `input` and `change` from `source`, the control that changed. */
const controlPayload = (
  source: globalThis.Element,
  event: Event | undefined
): unknown => {
  const control = source as HTMLInputElement
  const e = event as Partial<InputEvent> | undefined
  const composing = e?.isComposing === true
  const inputType = typeof e?.inputType === "string" ? e.inputType : ""
  return control.localName === "input"
    ? {
      value: control.value,
      checked: control.checked === true,
      files: control.files ? Array.from(control.files) : noFiles,
      composing,
      inputType
    }
    : { value: String(control.value ?? ""), composing, inputType }
}

const noFiles: ReadonlyArray<File> = []

const noSelection = { selectionStart: null, selectionEnd: null }

export const isEditable = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null
  if (element?.namespaceURI === HTML) {
    const tag = element.localName
    if (tag === "textarea" || tag === "select") return true
    if (tag === "input") {
      return !nonTextInputTypes.has((element as HTMLInputElement).type)
    }
  }
  return element?.isContentEditable === true
}

const selectionOf = (target: EventTarget | null) => {
  const field = target as HTMLInputElement | null
  const tag = (field as globalThis.Element | null)?.localName
  if (tag !== "input" && tag !== "textarea") return noSelection
  try {
    const start = field!.selectionStart
    const end = field!.selectionEnd
    return typeof start === "number" && typeof end === "number"
      ? { selectionStart: start, selectionEnd: end }
      : noSelection
  } catch {
    // Older browsers throw, rather than return `null`, for an input type without a selection.
    return noSelection
  }
}

/** The clipboard's plain text. A browser may refuse the read, which counts as no text. */
const pastedText = (event: Event): string => {
  try {
    return (event as ClipboardEvent).clipboardData?.getData("text/plain") ?? ""
  } catch {
    return ""
  }
}

/**
 * Whether `target`, where focus came from or goes, is inside `element`.
 * `null`, another window or nowhere, is not. An event a script made can name
 * any event target, such as the window, and `contains` throws for one that
 * isn't a node. Only the browser can tell: a node from another realm, such as
 * an iframe's adopted into this document, fails `instanceof Node`, and an
 * object can fake `nodeType`.
 */
const containsTarget = (
  element: globalThis.Element,
  target: EventTarget | null
): boolean => {
  try {
    return element.contains(target as globalThis.Node | null)
  } catch {
    return false
  }
}

export const isDisabled = (target: EventTarget | null): boolean =>
  typeof (target as globalThis.Element | null)?.matches === "function" &&
  (target as globalThis.Element).matches(":disabled")

const isFocusVisible = (target: EventTarget | null): boolean => {
  if (typeof (target as globalThis.Element | null)?.matches !== "function") {
    return true
  }
  try {
    return (target as globalThis.Element).matches(":focus-visible")
  } catch {
    return true
  }
}

const fieldOf = (
  target: EventTarget | null,
  element: globalThis.Element
) =>
  (target !== null && "value" in (target as object)
    ? target
    : element) as HTMLInputElement

/**
 * Builds the payload a handler gets: plain data, read from the event and the
 * elements involved.
 */
export const payloadOf = (
  name: string,
  event: Event,
  target: EventTarget | null,
  element: globalThis.Element,
  pointer: Html.PointerType | undefined,
  removed = false
): unknown => {
  switch (name) {
    case "click":
    case "dblclick":
    case "contextmenu":
    case "mousedown":
    case "mouseup":
    case "pointerdown":
    case "pointerup":
    case "pointercancel": {
      const e = event as MouseEvent
      return {
        button: e.button ?? 0,
        x: e.clientX ?? 0,
        y: e.clientY ?? 0,
        ...modifiers(event),
        pointerType: pressedWith(name, event, pointer)
      }
    }
    case "mouseenter":
    case "mouseleave": {
      const e = event as MouseEvent
      return { x: e.clientX ?? 0, y: e.clientY ?? 0 }
    }
    case "keydown":
    case "keyup": {
      const e = event as KeyboardEvent
      // Safari reports the key that ends a composition with `isComposing` false and `keyCode` 229.
      const composing = e.isComposing === true ||
        (e as { readonly keyCode?: number }).keyCode === 229
      return {
        key: e.key ?? "",
        ...modifiers(event),
        composing,
        repeat: e.repeat === true,
        editable: isEditable(event.composedPath()[0] ?? target),
        ...selectionOf(target)
      }
    }
    case "input":
    case "change":
      return controlPayload(fieldOf(target, element), event)
    case "compositionend":
      return { value: String(fieldOf(target, element).value ?? "") }
    case "paste":
      return { text: pastedText(event) }
    case "submit": {
      const form =
        (element.localName === "form" ? element : target) as HTMLFormElement
      return fieldsOf(form, (event as SubmitEvent).submitter ?? null)
    }
    case "toggle": {
      const e = event as Partial<ToggleEvent>
      // A popover's state is its own; a `details` or `dialog` reads `open`, with states derived where the
      // browser has no `ToggleEvent`.
      const open = element.hasAttribute("popover")
        ? e.newState === "open"
        : (element as HTMLDetailsElement).open === true
      const newState = e.newState === "open" || e.newState === "closed"
        ? e.newState
        : open
        ? "open"
        : "closed"
      const oldState = e.oldState === "open" || e.oldState === "closed"
        ? e.oldState
        : newState === "open"
        ? "closed"
        : "open"
      return { open, newState, oldState }
    }
    case "close":
      return { returnValue: (element as HTMLDialogElement).returnValue ?? "" }
    case "cancel":
      return { cancelable: event.cancelable }
    case "scroll":
      return { top: element.scrollTop, left: element.scrollLeft }
    case "focus":
      return { focusVisible: isFocusVisible(target) }
    case "blur":
      // A window listener's `blur` has no element that lost focus.
      return target === element
        ? { disabled: isDisabled(target), removed }
        : {}
    case "focusin":
      return {
        within: containsTarget(element, (event as FocusEvent).relatedTarget)
      }
    case "focusout":
      return {
        within: containsTarget(element, (event as FocusEvent).relatedTarget),
        disabled: isDisabled(target),
        removed
      }
    default:
      return {}
  }
}

export interface FieldState {
  readonly value: string
  readonly start: number
  readonly end: number
  readonly direction: "forward" | "backward" | "none"
}

export const fieldStateOf = (
  target: EventTarget | null
): FieldState | undefined => {
  const { selectionEnd, selectionStart } = selectionOf(target)
  if (selectionStart === null || selectionEnd === null) return undefined
  const field = target as HTMLInputElement
  return {
    value: field.value,
    start: selectionStart,
    end: selectionEnd,
    direction: field.selectionDirection ?? "none"
  }
}

export const offsetIn = (
  current: string,
  next: string,
  offset: number
): number => {
  const max = Math.min(current.length, next.length)
  let prefix = 0
  while (
    prefix < max && current.charCodeAt(prefix) === next.charCodeAt(prefix)
  ) prefix++
  if (offset <= prefix) return offset
  let suffix = 0
  while (
    suffix < max - prefix &&
    current.charCodeAt(current.length - 1 - suffix) ===
      next.charCodeAt(next.length - 1 - suffix)
  ) suffix++
  const fromEnd = current.length - offset
  return fromEnd <= suffix
    ? next.length - fromEnd
    : Math.min(offset, next.length - suffix)
}
