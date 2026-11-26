import * as Effect from "effect/Effect"
import * as PubSub from "effect/PubSub"
import * as Schedule from "effect/Schedule"
import type * as Scope from "effect/Scope"
import * as Socket from "effect/socket/Socket"
import * as Stream from "effect/Stream"
import * as Control from "./control.ts"
import * as InspectorInternal from "./inspector.ts"
import { type Feed, mountOverlay, Pages } from "./overlay.ts"
import { styles } from "./styles.ts"

const pageStyles = `
html, body, #root, .overlay { height: 100%; }
body { background: var(--bg); }
#root { width: auto; }
.panel { width: 100%; height: 100%; border: 0; border-radius: 0; }
.grip, .corner-wrap, .close, .show { display: none; }
`

export const mount = (
  container: HTMLElement,
  options: { readonly server: string; readonly size: number }
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function*() {
    const inspector = InspectorInternal.make({ size: options.size })
    const origins = new Map<string, number>()
    const changes = yield* PubSub.sliding<void>(1)
    const feed: Feed = {
      inspector,
      origin: (session) => origins.get(session),
      changes: Stream.fromPubSub(changes),
      paintable: () => false,
      paused: () => undefined,
      failures: () => 0,
      open: true,
      position: () => "BottomRight"
    }
    const pages = Pages.of({
      paint: () => Effect.undefined,
      resume: Effect.void,
      clear: (id) =>
        Effect.sync(() =>
          inspector.sessions().find((session) => session.id === id)?.clear()
        ),
      setOpen: () => Effect.void,
      setRecording: () => Effect.void,
      setPosition: () => Effect.void
    })
    yield* mountOverlay(container, feed, pages)
    const watch = Effect.gen(function*() {
      const socket = yield* Socket.makeWebSocket(
        Control.socketUrl(options.server, "/watch")
      )
      const pull = yield* Socket.readerString(socket)
      return yield* Effect.forever(Effect.flatMap(pull, (chunks) => {
        let changed = false
        for (const chunk of chunks) {
          const decoded = Control.decodeWatched(chunk)
          if (decoded._tag === "None" || decoded.value._tag === "Hello") {
            continue
          }
          const frame = decoded.value
          changed = true
          if (frame._tag === "Held") {
            const held = new Set(frame.sessions)
            for (const session of inspector.sessions()) {
              if (held.has(session.id)) continue
              inspector.remove(session.id)
              origins.delete(session.id)
            }
            continue
          }
          if (!origins.has(frame.session)) origins.set(frame.session, frame.at)
          inspector.ingest([frame])
        }
        return changed ? PubSub.publish(changes, undefined) : Effect.void
      }))
    }).pipe(Effect.scoped)
    yield* watch.pipe(
      Effect.retry(Schedule.spaced("1 second")),
      Effect.forkScoped
    )
  }).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal))

export const main = (): void => {
  const style = document.createElement("style")
  style.textContent = styles + pageStyles
  document.head.appendChild(style)
  const root = document.getElementById("root")!
  const { size } = Control.fromPage()
  mount(root, {
    server: location.origin,
    size: typeof size === "number" ? size : 1_000
  }).pipe(
    Effect.andThen(Effect.never),
    Effect.scoped,
    Effect.runFork
  )
}
