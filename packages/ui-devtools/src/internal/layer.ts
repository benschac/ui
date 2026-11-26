import * as BrowserHost from "@effect/ui/html/BrowserHost"
import * as MessageLog from "@effect/ui/MessageLog"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as PubSub from "effect/PubSub"
import * as Semaphore from "effect/Semaphore"
import * as Socket from "effect/socket/Socket"
import * as Stream from "effect/Stream"
import * as Control from "./control.ts"
import * as History from "./history.ts"
import * as InspectorInternal from "./inspector.ts"
import { type Feed, mountOverlay, Pages, type Position } from "./overlay.ts"
import { isFailure, tagOf } from "./read.ts"
import * as Remote from "./remote.ts"
import { styles } from "./styles.ts"
import * as Tools from "./tools.ts"
import * as WebMcp from "./webmcp.ts"

export type { Position }

export interface WebMcpOptions {
  readonly dispatch?: boolean | undefined
}

const sizeKey = "@effect/ui-devtools/size"
const openKey = "@effect/ui-devtools/open"
const positionKey = "@effect/ui-devtools/position"
const recordingKey = "@effect/ui-devtools/recording"
const devToolsKey = Symbol.for("@effect/ui/devtools")

const positions = new Set<string>([
  "TopLeft",
  "TopRight",
  "BottomLeft",
  "BottomRight"
])
const isPosition = (value: unknown): value is Position =>
  typeof value === "string" && positions.has(value)

interface Attached {
  readonly messageLog: MessageLog.MessageLog
  readonly controllables: BrowserHost.Controllables
  readonly takeOver: () => void
}

export interface Options {
  readonly position?: Position | undefined
  readonly size?: number | undefined
  readonly exclude?: ReadonlyArray<string> | undefined
  readonly server?: string | undefined
  readonly webMcp?: boolean | WebMcpOptions | undefined
}

const corners: { readonly [P in Position]: string } = {
  TopLeft: "top:12px;left:12px",
  TopRight: "top:12px;right:12px",
  BottomLeft: "bottom:12px;left:12px",
  BottomRight: "bottom:12px;right:12px"
}

// A painted copy's dialogs and popovers sit in the top layer, above any z-index. While paused the frame
// joins the top layer after them, so the copy never covers the panel. Leaving the top layer takes the frame
// out of the page for a moment, so it only re-joins when something opened since it last joined.
const raise = (frame: HTMLIFrameElement, covered: boolean) => {
  if (typeof frame.showPopover !== "function") return
  if (frame.matches(":popover-open")) {
    if (!covered) return
    frame.hidePopover()
  }
  frame.setAttribute("popover", "manual")
  frame.showPopover()
}

const lower = (frame: HTMLIFrameElement) => {
  if (!frame.hasAttribute("popover")) return
  if (frame.matches(":popover-open")) frame.hidePopover()
  frame.removeAttribute("popover")
}

let explicit = 0

export const make = (options: Options): Layer.Layer<never> =>
  makeInternal(options, false)

const makeInternal = (options: Options, auto: boolean): Layer.Layer<never> =>
  Layer.effectContext(
    Effect.gen(function*() {
      if (!auto) {
        explicit++
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            explicit--
          })
        )
        ;(globalThis as unknown as Record<symbol, Attached | undefined>)[
          devToolsKey
        ]?.takeOver()
      }
      const page = Control.fromPage()
      const server = options.server ??
        (typeof page.url === "string" ? page.url : undefined)
      const size = Math.max(
        1,
        options.size ?? (typeof page.size === "number" ? page.size : 1_000)
      )
      const modelContext = options.webMcp === false
        ? undefined
        : WebMcp.modelContext()
      const inspector = InspectorInternal.make({ size })
      const history = History.make(size)
      const wireHistory = modelContext && History.make(size)
      const roots = new Map<string, BrowserHost.Controllable>()
      let paused: {
        readonly root: BrowserHost.Controllable
        readonly at: Control.Paused
      } | undefined
      const lock = Semaphore.makeUnsafe(1)
      const origins = new Map<string, number>()
      const latest = new Map<string, number>()
      const { notify, until } = Tools.makeWaiters()
      let failures = 0
      const changes = yield* PubSub.sliding<void>(1)
      const states = yield* PubSub.sliding<void>(1)
      const changed = () => {
        PubSub.publishUnsafe(changes, undefined)
        PubSub.publishUnsafe(states, undefined)
      }
      const view = document.defaultView
      type Store = "localStorage" | "sessionStorage"
      const load = (key: string, store: Store = "localStorage"): unknown => {
        try {
          return JSON.parse(view?.[store].getItem(key) ?? "null")
        } catch {
          return null
        }
      }
      const save = (
        key: string,
        value: unknown,
        store: Store = "localStorage"
      ) => {
        try {
          view?.[store].setItem(key, JSON.stringify(value))
        } catch {
          return
        }
      }
      // Choices made at runtime override `exclude` for the rest of the tab.
      const chosen = load(recordingKey, "sessionStorage")
      const choices = new Map<string, boolean>()
      const stopped = new Set(options.exclude)
      const choose = (tag: string, recording: boolean) => {
        choices.set(tag, recording)
        if (recording) stopped.delete(tag)
        else stopped.add(tag)
      }
      if (typeof chosen === "object" && chosen !== null) {
        for (const [tag, recording] of Object.entries(chosen)) {
          if (typeof recording === "boolean") choose(tag, recording)
        }
      }
      const isStopped = InspectorInternal.matchTags(stopped)
      const notRecording = () => Array.from(stopped)
      const setRecording = (tag: string, recording: boolean) => {
        choose(tag, recording)
        save(recordingKey, Object.fromEntries(choices), "sessionStorage")
        changed()
      }
      const savedPosition = load(positionKey)
      let position: Position = isPosition(savedPosition)
        ? savedPosition
        : (options.position ?? "BottomRight")
      const feed: Feed = {
        inspector,
        origin: (session) => origins.get(session),
        changes: Stream.fromPubSub(changes),
        paintable: (session, seq) =>
          roots.has(session) && history.holds(session, seq),
        paused: () => paused?.at,
        failures: () => failures,
        open: load(openKey) === true,
        position: () => position,
        notRecording,
        // The raw message's tag: an encoded one may be under another key.
        stoppable: (session, seq) => {
          const entry = history.entry(session, seq)
          const tag = entry?._tag === "Update"
            ? tagOf(entry.message)
            : undefined
          return tag === undefined || stopped.has(tag) ? undefined : tag
        }
      }
      const unpause: Effect.Effect<void> = Effect.suspend(() => {
        const was = paused
        if (was === undefined) return Effect.void
        return Effect.andThen(
          was.root.resume,
          Effect.sync(() => {
            if (paused !== was) return
            paused = undefined
            lower(frame)
            changed()
          })
        )
      })
      const resume = lock.withPermit(unpause)
      const paint = (
        session: string,
        seq: number
      ): Effect.Effect<BrowserHost.Painted | undefined> =>
        lock.withPermit(Effect.uninterruptible(Effect.suspend(() => {
          const root = roots.get(session)
          const state = history.at(session, seq)
          if (root === undefined || state === undefined) return Effect.undefined
          return (paused === undefined || paused.root === root
            ? Effect.void
            : unpause).pipe(
              Effect.andThen(root.pause(state)),
              Effect.map((painted) => {
                paused = {
                  root,
                  at: {
                    session,
                    seq,
                    fellBack: painted.fellBack,
                    fallbacks: painted.fallbacks,
                    skipped: painted.skipped
                  }
                }
                raise(frame, covered)
                covered = false
                changed()
                return painted
              })
            )
        })))
      const pages = Pages.of({
        paint,
        resume,
        clear: (sessionId) =>
          Effect.sync(() => {
            const upTo = latest.get(sessionId)
            if (paused !== undefined || upTo === undefined) return
            inspector.sessions().find((session) => session.id === sessionId)
              ?.clear()
            history.clear(sessionId, upTo)
            wireHistory?.clear(sessionId, upTo)
            notify()
          }),
        setOpen: (open) => Effect.sync(() => save(openKey, open)),
        setRecording: (tag, recording) =>
          Effect.sync(() => setRecording(tag, recording)),
        setPosition: (next) => Effect.sync(() => setPosition(next))
      })
      const controllables: BrowserHost.Controllables = {
        register: (root) => {
          roots.set(root.session, root)
          PubSub.publishUnsafe(states, undefined)
          return () => {
            if (roots.get(root.session) === root) roots.delete(root.session)
            if (paused?.root === root) {
              paused = undefined
              lower(frame)
            }
            changed()
          }
        }
      }

      const frame = document.createElement("iframe")
      frame.setAttribute("data-effect-ui-devtools", "")
      frame.title = "Effect UI inspector"
      frame.setAttribute(
        "style",
        "position:fixed;inset:auto;" + corners[position] +
          ";z-index:2147483000;border:0;margin:0;padding:0;width:0;height:0;overflow:hidden;" +
          "background:transparent;color-scheme:light dark;max-width:none;max-height:none;" +
          "box-shadow:0 8px 28px light-dark(rgb(0 0 0 / .14), rgb(0 0 0 / .5))"
      )
      frame.srcdoc =
        "<!doctype html><html><head><meta charset=\"utf-8\"><style>" + styles +
        "</style></head><body><div id=\"root\"></div></body></html>"
      yield* Effect.addFinalizer(() => Effect.sync(() => frame.remove()))
      yield* Effect.callback<void>((resume) => {
        frame.addEventListener("load", () => resume(Effect.void), {
          once: true
        })
        document.body.appendChild(frame)
      })
      let covered = true
      const opened = (event: Event) => {
        if (
          event.target !== frame && (event as ToggleEvent).newState === "open"
        ) {
          covered = true
        }
      }
      document.addEventListener("beforetoggle", opened, true)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          document.removeEventListener("beforetoggle", opened, true)
        )
      )
      const inner = frame.contentDocument!
      const container = inner.getElementById("root")!

      const root = inner.documentElement
      const place = (next: Position) => {
        position = next
        frame.style.top = next.startsWith("Top") ? "12px" : "auto"
        frame.style.bottom = next.startsWith("Bottom") ? "12px" : "auto"
        frame.style.left = next.endsWith("Left") ? "12px" : "auto"
        frame.style.right = next.endsWith("Right") ? "12px" : "auto"
        root.setAttribute("data-position", next)
      }
      const setPosition = (next: Position) => {
        place(next)
        save(positionKey, next)
        changed()
      }
      place(position)
      const resize = (width: number, height: number) => {
        root.style.setProperty(
          "--panel-w",
          Math.max(480, Math.round(width)) + "px"
        )
        root.style.setProperty(
          "--panel-h",
          Math.max(300, Math.round(height)) + "px"
        )
      }
      const saved = load(sizeKey)
      if (
        Array.isArray(saved) && typeof saved[0] === "number" &&
        typeof saved[1] === "number"
      ) {
        resize(saved[0], saved[1])
      }
      let suppressClick = false
      inner.addEventListener("click", (event) => {
        if (!suppressClick) return
        suppressClick = false
        event.preventDefault()
        event.stopImmediatePropagation()
      }, true)
      const clamp = (value: number, min: number, max: number) =>
        Math.min(Math.max(value, min), Math.max(min, max))
      container.addEventListener("pointerdown", (event) => {
        const target = event.target as Element
        const grip = target.closest<HTMLElement>(".grip")
        if (grip != null && event.button === 0) {
          const panel = grip.parentElement
          if (panel == null) return
          event.preventDefault()
          const grow = {
            x: position.endsWith("Right") ? -1 : 1,
            y: position.startsWith("Bottom") ? -1 : 1
          }
          const start = {
            x: event.screenX,
            y: event.screenY,
            rect: panel.getBoundingClientRect()
          }
          const move = (moved: PointerEvent) =>
            resize(
              start.rect.width + grow.x * (moved.screenX - start.x),
              start.rect.height + grow.y * (moved.screenY - start.y)
            )
          const end = () => {
            grip.removeEventListener("pointermove", move)
            const rect = panel.getBoundingClientRect()
            save(sizeKey, [rect.width, rect.height])
          }
          grip.setPointerCapture(event.pointerId)
          grip.addEventListener("pointermove", move)
          grip.addEventListener("lostpointercapture", end, { once: true })
          return
        }
        const launcher = target.closest<HTMLElement>(".launcher")
        if (launcher == null || event.button !== 0) return
        suppressClick = false
        const start = {
          x: event.screenX,
          y: event.screenY,
          rect: frame.getBoundingClientRect()
        }
        let dragging = false
        let left = start.rect.left
        let top = start.rect.top
        const move = (moved: PointerEvent) => {
          const dx = moved.screenX - start.x
          const dy = moved.screenY - start.y
          if (!dragging) {
            if (Math.hypot(dx, dy) < 6) return
            dragging = true
            root.setAttribute("data-dragging", "true")
          }
          const vw = view?.innerWidth ?? 0
          const vh = view?.innerHeight ?? 0
          left = clamp(start.rect.left + dx, 12, vw - start.rect.width - 12)
          top = clamp(start.rect.top + dy, 12, vh - start.rect.height - 12)
          frame.style.left = Math.round(left) + "px"
          frame.style.top = Math.round(top) + "px"
          frame.style.right = "auto"
          frame.style.bottom = "auto"
        }
        let done = false
        const finish = (cancelled: boolean) => {
          if (done) return
          done = true
          launcher.removeEventListener("pointermove", move)
          launcher.removeEventListener("pointerup", onUp)
          launcher.removeEventListener("pointercancel", onCancel)
          launcher.removeEventListener("lostpointercapture", onLost)
          if (!dragging) return
          root.removeAttribute("data-dragging")
          suppressClick = true
          setTimeout(() => {
            suppressClick = false
          }, 0)
          if (cancelled) {
            place(position)
            return
          }
          const vw = view?.innerWidth ?? 0
          const vh = view?.innerHeight ?? 0
          const vertical = top + start.rect.height / 2 < vh / 2
            ? "Top"
            : "Bottom"
          const horizontal = left + start.rect.width / 2 < vw / 2
            ? "Left"
            : "Right"
          setPosition((vertical + horizontal) as Position)
        }
        const onUp = () => finish(false)
        const onCancel = () => finish(true)
        const onLost = () => finish(false)
        launcher.setPointerCapture?.(event.pointerId)
        launcher.addEventListener("pointermove", move)
        launcher.addEventListener("pointerup", onUp)
        launcher.addEventListener("pointercancel", onCancel)
        launcher.addEventListener("lostpointercapture", onLost)
      })

      const viewport = () => {
        if (view === null) return
        root.style.setProperty("--vw", view.innerWidth + "px")
        root.style.setProperty("--vh", view.innerHeight + "px")
      }
      viewport()
      view?.addEventListener("resize", viewport)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => view?.removeEventListener("resize", viewport))
      )
      const Observer =
        (frame.contentWindow as (Window & typeof globalThis) | null)
          ?.ResizeObserver
      if (Observer !== undefined) {
        const observer = new Observer(() => {
          const shape = container.firstElementChild?.firstElementChild
          frame.style.width = container.offsetWidth + "px"
          frame.style.height = container.offsetHeight + "px"
          frame.style.borderRadius = shape == null
            ? "0"
            : inner.defaultView!.getComputedStyle(shape).borderRadius
        })
        observer.observe(container)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => observer.disconnect())
        )
      }

      yield* mountOverlay(container, feed, pages)

      const encoded = yield* MessageLog.makeEncoded((batch) =>
        Effect.suspend(() => {
          for (const entry of batch) {
            if (!origins.has(entry.session)) {
              origins.set(entry.session, entry.at)
            }
            latest.set(entry.session, entry.seq)
            wireHistory?.record(entry)
          }
          inspector.ingest(batch)
          notify()
          return PubSub.publish(changes, undefined)
        })
      )
      const record = (entry: MessageLog.Entry) => {
        if (isFailure(entry)) failures++
        history.record(entry)
      }
      const logs = [{ enabled: true, record }, encoded]
      const controller = {
        roots,
        size,
        paused: () => paused?.at,
        paint,
        resume,
        notRecording,
        setRecording
      }
      if (server !== undefined) {
        const sent = yield* Layer.build(
          MessageLog.socket(Control.socketUrl(server, "/log"), { buffer: size })
        )
        logs.push(Context.get(sent, MessageLog.MessageLog))
        yield* Remote.connect(Control.socketUrl(server, "/control"), {
          ...controller,
          changes: Stream.fromPubSub(states)
        })
      }
      if (modelContext !== undefined && wireHistory !== undefined) {
        const handle = Remote.makeHandler(controller)
        const request: Tools.Page["request"] = (control) =>
          Effect.mapError(
            handle(control),
            (message) => ({ lost: false, message })
          )
        yield* WebMcp.register(modelContext, {
          options: {
            size,
            dispatch: typeof options.webMcp === "object" &&
              options.webMcp.dispatch === true
          },
          inspector,
          history: wireHistory,
          meta: (session) => ({
            host: "browser",
            connected: roots.has(session)
          }),
          pageOf: (session) =>
            roots.has(session)
              ? {
                paused: paused?.at ?? null,
                notRecording: notRecording(),
                request
              }
              : undefined,
          until,
          within: 8_000
        })
      }
      const log = MessageLog.fanoutAll(logs)
      // The flag carries the choice to every reader, the server's copy too.
      const marked: MessageLog.MessageLog = {
        enabled: true,
        record: (entry) =>
          log.record(
            entry._tag === "Update" && isStopped(entry)
              ? { ...entry, excluded: true }
              : entry
          )
      }
      return Context.make(MessageLog.MessageLog, marked)
        .pipe(
          Context.add(BrowserHost.Controllables, controllables)
        )
    }).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal))
  )

export const attach = (options: Options = {}): () => void => {
  if (explicit > 0) return () => {}
  const host = globalThis as unknown as Record<symbol, Attached | undefined>
  host[devToolsKey]?.takeOver()
  let active = true
  let targetLog: MessageLog.MessageLog | undefined
  let targetControllables: BrowserHost.Controllables | undefined
  const buffered: Array<MessageLog.Entry> = []
  const roots = new Set<BrowserHost.Controllable>()
  const unregisters = new Map<BrowserHost.Controllable, () => void>()
  let fiber: Fiber.Fiber<void, never> | undefined

  const takeOver = () => {
    if (!active) return
    active = false
    if (host[devToolsKey]?.takeOver === takeOver) delete host[devToolsKey]
    buffered.length = 0
    for (const unregister of unregisters.values()) unregister()
    unregisters.clear()
    roots.clear()
    if (fiber !== undefined) {
      const running = fiber
      fiber = undefined
      Effect.runFork(Fiber.interrupt(running))
    }
  }

  host[devToolsKey] = {
    messageLog: {
      enabled: true,
      record: (entry) => {
        if (!active) return
        if (targetLog !== undefined) targetLog.record(entry)
        else buffered.push(entry)
      }
    },
    controllables: {
      register: (root) => {
        if (!active) return () => {}
        if (targetControllables !== undefined) {
          return targetControllables.register(root)
        }
        roots.add(root)
        return () => {
          roots.delete(root)
          unregisters.get(root)?.()
          unregisters.delete(root)
        }
      }
    },
    takeOver
  }

  const bodyReady = document.body !== null
    ? Effect.void
    : Effect.callback<void>((resume) => {
      const done = () => resume(Effect.void)
      document.addEventListener("DOMContentLoaded", done, { once: true })
      return Effect.sync(() =>
        document.removeEventListener("DOMContentLoaded", done)
      )
    })

  fiber = Effect.gen(function*() {
    yield* bodyReady
    if (!active) return
    const ctx = yield* Layer.build(makeInternal(options, true))
    if (!active) return
    const realLog = Context.get(ctx, MessageLog.MessageLog)
    const realControllables = Context.get(ctx, BrowserHost.Controllables)
    targetLog = realLog
    targetControllables = realControllables
    for (const entry of buffered.splice(0)) realLog.record(entry)
    for (const root of roots) {
      unregisters.set(root, realControllables.register(root))
    }
    return yield* Effect.never
  }).pipe(Effect.scoped, Effect.runFork)

  return takeOver
}
