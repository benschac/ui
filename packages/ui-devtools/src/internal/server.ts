import * as MessageLog from "@effect/ui/MessageLog"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Socket from "effect/socket/Socket"
import * as Control from "./control.ts"
import * as History from "./history.ts"
import * as InspectorInternal from "./inspector.ts"
import * as Tools from "./tools.ts"

export interface Options {
  readonly size: number
  readonly dispatch: boolean
  readonly keep: number
  readonly timeout?: number | undefined
}

interface Page extends Tools.Page {
  readonly sessions: Set<string>
  paused: Control.Paused | null
  notRecording: ReadonlyArray<string>
}

interface Meta {
  host: MessageLog.WireHost | undefined
  connected: boolean
  closed: number
  latest?: number | undefined
  started?: MessageLog.WireEntry | undefined
}

const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

const decodeWire = Schema.decodeUnknownOption(
  Schema.fromJsonString(MessageLog.Wire)
)

export const make = (options: Options) => {
  const inspector = InspectorInternal.make({ size: options.size })
  const history = History.make(options.size)
  const meta = new Map<string, Meta>()
  const pages = new Set<Page>()
  const watchers = new Set<Queue.Queue<string>>()
  const { notify, until } = Tools.makeWaiters()
  let closed = 0
  const timeout = options.timeout ?? 10_000

  const held = () =>
    Control.encodeHeld({
      _tag: "Held",
      sessions: inspector.sessions().map((session) => session.id)
    })
  const broadcast = (text: string) => {
    for (const watcher of watchers) Queue.offerUnsafe(watcher, text)
  }

  const prune = () => {
    const gone = Array.from(meta).filter(([, m]) => !m.connected).sort((
      [, a],
      [, b]
    ) => a.closed - b.closed)
    const dropped = gone.slice(0, Math.max(0, gone.length - options.keep))
    for (const [session] of dropped) {
      meta.delete(session)
      inspector.remove(session)
      history.drop(session)
    }
    if (dropped.length > 0) broadcast(held())
  }

  const allowed = (origin: string | undefined) => {
    if (origin === undefined) return true
    try {
      const { hostname } = new URL(origin)
      return loopback.has(hostname) || hostname.endsWith(".localhost")
    } catch {
      return false
    }
  }

  const upgrade = Effect.fnUntraced(function*(
    f: (
      socket: Socket.Socket
    ) => Effect.Effect<void, Socket.SocketError, Scope.Scope>
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (!allowed(request.headers["origin"])) {
      return HttpServerResponse.empty({ status: 403 })
    }
    const socket = yield* request.upgrade
    yield* f(socket).pipe(Effect.catchTag("SocketError", () => Effect.void))
    return HttpServerResponse.empty()
  }, Effect.scoped)

  const log = HttpRouter.add(
    "GET",
    "/log",
    upgrade((socket) => {
      let host: MessageLog.WireHost | undefined
      const sessions = new Set<string>()
      return Effect.gen(function*() {
        const pull = yield* Socket.readerString(socket)
        return yield* Effect.forever(Effect.map(pull, (chunks) => {
          const batch: Array<MessageLog.WireEntry> = []
          for (const chunk of chunks) {
            const decoded = decodeWire(chunk)
            if (decoded._tag === "None") continue
            const frame = decoded.value
            if (frame._tag === "Hello") {
              host = frame.host
              continue
            }
            let known = meta.get(frame.session)
            if (known === undefined) {
              meta.set(
                frame.session,
                known = { host, connected: true, closed: 0 }
              )
            } else if (!sessions.has(frame.session)) known.connected = true
            sessions.add(frame.session)
            known.latest = Math.max(known.latest ?? -1, frame.seq)
            if (frame._tag === "SessionStarted") known.started = frame
            batch.push(frame)
            broadcast(chunk)
          }
          if (batch.length === 0) return
          inspector.ingest(batch)
          for (const frame of batch) history.record(frame)
          notify()
        }))
      }).pipe(Effect.ensuring(Effect.sync(() => {
        for (const session of sessions) {
          const known = meta.get(session)
          if (known !== undefined) {
            known.connected = false
            known.closed = ++closed
          }
        }
        prune()
        notify()
      })))
    })
  )

  const control = HttpRouter.add(
    "GET",
    "/control",
    upgrade(Effect.fnUntraced(function*(socket) {
      const pending = new Map<
        number,
        Deferred.Deferred<Schema.Json, Tools.RequestError>
      >()
      let id = 0
      const writer = yield* socket.writer
      const pull = yield* Socket.readerString(socket)
      const page: Page = {
        sessions: new Set(),
        paused: null,
        notRecording: [],
        request: (request) => {
          const at = ++id
          return Effect.gen(function*() {
            const deferred = yield* Deferred.make<
              Schema.Json,
              Tools.RequestError
            >()
            pending.set(at, deferred)
            yield* writer.write(Control.encodeToPage({ id: at, request })).pipe(
              Effect.mapError(() => ({
                lost: false,
                message: "the page's control connection is closed"
              }))
            )
            return yield* Deferred.await(deferred).pipe(
              Effect.timeoutOrElse({
                duration: timeout,
                orElse: () =>
                  Effect.fail({
                    lost: true,
                    message: "the page did not answer within " + timeout + "ms"
                  })
              })
            )
          }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(at))))
        }
      }
      pages.add(page)
      yield* Effect.addFinalizer(() => {
        pages.delete(page)
        notify()
        return Effect.forEach(
          pending.values(),
          (deferred) =>
            Deferred.fail(deferred, { lost: true, message: "the page closed" }),
          { discard: true }
        )
      })
      return yield* Effect.forever(
        Effect.flatMap(pull, (chunks) =>
          Effect.forEach(chunks, (chunk) => {
            const decoded = Control.decodeToServer(chunk)
            if (decoded._tag === "None") return Effect.void
            const message = decoded.value
            if (message._tag === "State") {
              page.sessions.clear()
              for (const session of message.sessions) {
                page.sessions.add(session)
              }
              page.paused = message.paused
              page.notRecording = message.notRecording
              notify()
              return Effect.void
            }
            const deferred = pending.get(message.id)
            if (deferred === undefined) return Effect.void
            return message.ok
              ? Deferred.succeed(deferred, message.value)
              : Deferred.fail(deferred, {
                lost: false,
                message: String(message.value)
              })
          }, { discard: true }))
      )
    }))
  )

  // Replay SessionStarted even after eviction so late viewers have the app name.
  // The viewer's Inspector ignores duplicate frames.
  const watch = HttpRouter.add(
    "GET",
    "/watch",
    upgrade(Effect.fnUntraced(function*(socket) {
      const writer = yield* socket.writer
      const pull = yield* Socket.readerString(socket)
      const outbox = yield* Queue.unbounded<string>()
      Queue.offerUnsafe(outbox, held())
      for (const session of inspector.sessions()) {
        const started = meta.get(session.id)?.started
        if (started !== undefined) {
          Queue.offerUnsafe(outbox, JSON.stringify(started))
        }
        // Excluded frames too, so the viewer's diffs match a live one's.
        for (const frame of inspector.frames(session.id)) {
          Queue.offerUnsafe(outbox, JSON.stringify(frame))
        }
      }
      watchers.add(outbox)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => watchers.delete(outbox))
      )
      return yield* Effect.raceFirst(
        Effect.forever(Effect.flatMap(Queue.take(outbox), writer.write)),
        Effect.forever(pull)
      )
    }))
  )

  const server: Tools.Backend = {
    options,
    inspector,
    history,
    meta: (session) => meta.get(session),
    pageOf: (session) =>
      Array.from(pages).reverse().find((page) => page.sessions.has(session)),
    until,
    within: Math.round(timeout * 0.8),
    latest: (id) => meta.get(id)?.latest,
    gap: "skipped"
  }
  return { server, routes: Layer.mergeAll(log, control, watch) }
}
