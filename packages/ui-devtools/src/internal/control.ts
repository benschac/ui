import * as MessageLog from "@effect/ui/MessageLog"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export const Request = Schema.Union([
  Schema.TaggedStruct("Show", { session: Schema.String, seq: Schema.Number }),
  Schema.TaggedStruct("Resume", {}),
  Schema.TaggedStruct("SetRecording", {
    tag: Schema.String,
    recording: Schema.Boolean
  }),
  Schema.TaggedStruct("MessageSchema", {
    session: Schema.String,
    instance: Schema.Number,
    tag: Schema.optionalKey(Schema.String)
  }),
  Schema.TaggedStruct("Dispatch", {
    session: Schema.String,
    instance: Schema.Number,
    messages: Schema.Array(Schema.Json),
    within: Schema.Number
  })
])

export type Request = typeof Request.Type

export const ToPage = Schema.Struct({ id: Schema.Number, request: Request })

export type ToPage = typeof ToPage.Type

export const Paused = Schema.Struct({
  session: Schema.String,
  seq: Schema.Number,
  fellBack: Schema.Array(Schema.String),
  fallbacks: Schema.Array(Schema.String),
  // Absent from a page on an older version.
  skipped: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  )
})

export type Paused = typeof Paused.Type

export const ToServer = Schema.Union([
  Schema.TaggedStruct("State", {
    sessions: Schema.Array(Schema.String),
    paused: Schema.NullOr(Paused),
    // Absent from a page on an older version.
    notRecording: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed([]))
    )
  }),
  Schema.TaggedStruct("Reply", {
    id: Schema.Number,
    ok: Schema.Boolean,
    value: Schema.Json
  })
])

export type ToServer = typeof ToServer.Type

export const Outcome = Schema.Union([
  Schema.TaggedStruct("Updated", { seq: Schema.Number }),
  Schema.TaggedStruct("Failed", { seq: Schema.Number }),
  Schema.TaggedStruct("Ignored", { reason: Schema.String }),
  Schema.TaggedStruct("Unknown", {})
])

export type Outcome = typeof Outcome.Type

export const Dispatched = Schema.Struct({
  outcomes: Schema.Array(Outcome),
  paused: Schema.NullOr(Schema.Number)
})

export const encodeToPage = Schema.encodeSync(Schema.fromJsonString(ToPage))
export const decodeToPage = Schema.decodeUnknownOption(
  Schema.fromJsonString(ToPage)
)
export const encodeToServer = Schema.encodeSync(Schema.fromJsonString(ToServer))
export const decodeToServer = Schema.decodeUnknownOption(
  Schema.fromJsonString(ToServer)
)

export const metaName = "effect-ui-devtools"

export const fromPage = (): {
  readonly url?: unknown
  readonly size?: unknown
} => {
  const content = document.querySelector<HTMLMetaElement>(
    "meta[name=\"" + metaName + "\"]"
  )?.content
  try {
    return content === undefined ? {} : JSON.parse(content)
  } catch {
    return {}
  }
}

// Sent on /watch at connection and after eviction so viewers can remove dropped sessions.
export const Held = Schema.TaggedStruct("Held", {
  sessions: Schema.Array(Schema.String)
})

export const encodeHeld = Schema.encodeSync(Schema.fromJsonString(Held))
export const decodeWatched = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([MessageLog.Wire, Held]))
)

export const defaultPort = 4774

export const serverUrl = (port: number = defaultPort): string =>
  "http://127.0.0.1:" + port

export const socketUrl = (server: string, path: string) => {
  const url = new URL(path, server)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.href
}
