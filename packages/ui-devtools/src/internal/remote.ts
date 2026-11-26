import type * as BrowserHost from "@effect/ui/html/BrowserHost"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Socket from "effect/socket/Socket"
import * as Stream from "effect/Stream"
import * as Control from "./control.ts"

export interface Controller {
  readonly roots: ReadonlyMap<string, BrowserHost.Controllable>
  readonly size: number
  readonly paused: () => Control.Paused | undefined
  readonly paint: (
    session: string,
    seq: number
  ) => Effect.Effect<BrowserHost.Painted | undefined>
  readonly resume: Effect.Effect<void>
  readonly notRecording: () => ReadonlyArray<string>
  readonly setRecording: (tag: string, recording: boolean) => void
  readonly changes: Stream.Stream<void>
}

type Json = Schema.Json

const isObject = (value: unknown): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const tagOf = (schema: Json, definitions: Record<string, Json>): unknown => {
  const resolved = isObject(schema) && typeof schema.$ref === "string"
    ? definitions[schema.$ref.slice(schema.$ref.lastIndexOf("/") + 1)]
    : schema
  const tag = isObject(resolved) && isObject(resolved.properties)
    ? resolved.properties._tag
    : undefined
  return isObject(tag)
    ? tag.const ??
      (Array.isArray(tag.enum) && tag.enum.length === 1
        ? tag.enum[0]
        : undefined)
    : undefined
}

const messageSchema = (
  schema: Schema.Top,
  tag: string | undefined
): Effect.Effect<Json, string> =>
  Effect.suspend(() => {
    const document = Schema.toJsonSchemaDocument(
      Schema.toCodecJson(schema)
    ) as unknown as {
      readonly schema: Json
      readonly definitions: Record<string, Json>
    }
    if (tag === undefined) {
      return Effect.succeed({
        schema: document.schema,
        definitions: document.definitions
      })
    }
    const root = document.schema
    const members = isObject(root) && Array.isArray(root.anyOf)
      ? root.anyOf
      : [root]
    const member = members.find((member) =>
      tagOf(member, document.definitions) === tag
    )
    if (member === undefined) {
      const tags = members.map((member) => tagOf(member, document.definitions))
        .filter((t) => typeof t === "string")
      return Effect.fail(
        "No message _tag " + tag + ". The tags are " + tags.join(", ") + "."
      )
    }
    return Effect.succeed({ schema: member, definitions: document.definitions })
  })

export const makeHandler = (
  controller: Omit<Controller, "changes">
): (request: Control.Request) => Effect.Effect<Json, string> => {
  const noRoot = (session: string) =>
    "Session " + session + " has no root on this page."

  const target = (session: string, instance: number) =>
    Effect.suspend(() => {
      const root = controller.roots.get(session)
      if (root === undefined) return Effect.fail(noRoot(session))
      const found = root.instance(instance)
      return found === undefined
        ? Effect.fail(
          "Instance " + instance + " is not mounted in session " + session + "."
        )
        : Effect.succeed(found)
    })

  return (request: Control.Request): Effect.Effect<Json, string> => {
    switch (request._tag) {
      case "Show":
        return Effect.flatMap(
          controller.paint(request.session, request.seq),
          (painted) =>
            painted !== undefined
              ? Effect.succeed({
                fellBack: [...painted.fellBack],
                fallbacks: [...painted.fallbacks],
                skipped: [...painted.skipped]
              })
              : Effect.fail(
                controller.roots.has(request.session)
                  ? "#" + request.seq + " is not among the last " +
                    controller.size + " entries the page keeps to paint from."
                  : noRoot(request.session)
              )
        )
      case "Resume":
        return Effect.as(controller.resume, null)
      case "SetRecording":
        return Effect.sync(() => {
          controller.setRecording(request.tag, request.recording)
          return controller.notRecording()
        })
      case "MessageSchema":
        return Effect.flatMap(
          target(request.session, request.instance),
          (found) => messageSchema(found.message, request.tag)
        )
      case "Dispatch":
        return Effect.gen(function*() {
          const found = yield* target(request.session, request.instance)
          const decode = Schema.decodeUnknownEffect(
            Schema.toCodecJson(found.message as Schema.Codec<unknown>)
          )
          const messages = yield* Effect.forEach(
            request.messages,
            (message, index) =>
              Effect.mapError(
                decode(message),
                (error) =>
                  "Message " + index + " does not decode: " + error.message
              )
          )
          const deadline = Date.now() + request.within
          const outcomes: Array<Control.Outcome> = []
          for (const message of messages) {
            const left = deadline - Date.now()
            if (left <= 0) break
            const outcome = yield* found.dispatch(message).pipe(
              Effect.timeoutOrElse({
                duration: left,
                orElse: () => Effect.succeed({ _tag: "Unknown" } as const)
              })
            )
            outcomes.push(outcome)
            if (outcome._tag !== "Updated") break
          }
          const paused = controller.paused()
          return {
            outcomes,
            paused: paused?.session === request.session ? paused.seq : null
          }
        })
    }
  }
}

export const connect = (
  url: string,
  controller: Controller
): Effect.Effect<void, never, Scope.Scope | Socket.WebSocketConstructor> => {
  const handle = makeHandler(controller)

  const connection = Effect.gen(function*() {
    const socket = yield* Socket.makeWebSocket(url)
    const writer = yield* socket.writer
    const pull = yield* Socket.readerString(socket)
    const send = (message: Control.ToServer) =>
      writer.write(Control.encodeToServer(message))
    const state = Effect.suspend(() =>
      send({
        _tag: "State",
        sessions: Array.from(controller.roots.keys()),
        paused: controller.paused() ?? null,
        notRecording: controller.notRecording()
      })
    )
    yield* state
    yield* controller.changes.pipe(
      Stream.runForEach(() => state),
      Effect.ignore,
      Effect.forkScoped
    )
    return yield* Effect.forever(
      Effect.flatMap(pull, (chunks) =>
        Effect.forEach(chunks, (chunk) => {
          const decoded = Control.decodeToPage(chunk)
          if (decoded._tag === "None") return Effect.void
          const message = decoded.value
          return handle(message.request).pipe(
            Effect.matchEffect({
              onSuccess: (value) =>
                send({ _tag: "Reply", id: message.id, ok: true, value }),
              onFailure: (value) =>
                send({ _tag: "Reply", id: message.id, ok: false, value })
            }),
            Effect.ignore,
            Effect.forkScoped
          )
        }, { discard: true }))
    )
  }).pipe(Effect.scoped)

  return connection.pipe(
    Effect.retry(
      Schedule.min([
        Schedule.exponential("200 millis"),
        Schedule.spaced("5 seconds")
      ])
    ),
    Effect.forever,
    Effect.ignore,
    Effect.forkScoped,
    Effect.asVoid
  )
}
