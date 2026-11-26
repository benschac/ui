/**
 * The inspector's core: it reads the Wire entries of a message log and keeps
 * what a devtools view asks of them. It has no UI and no Layer.
 *
 * `make` gives an `Inspector`, which keeps one `Session` for each session
 * id it's given entries of. A session holds its last entries in a ring buffer
 * and answers by `seq`: the entry behind a number, the entries an entry
 * names and the ones that name it, the Command run an `update` issued, the
 * Layer builds, Subscriptions, mounts and Command runs of an instance, and
 * the entry an instance's Model is compared with. It also keeps a `Summary`
 * of each instance as entries arrive and leave, so a view can list the
 * instances that have something to report without reading every record.
 *
 * It reads Wire frames only, so a `Schema.Redacted` value reaches it as the
 * encoder's placeholder and never in clear. It states what the entries say
 * and nothing else: a Command run has a start when the log has its
 * `CommandStarted`, and an end when the log has its end entry.
 *
 * **Example** (Feeding an inspector from a running app)
 *
 * ```ts
 * import { MessageLog } from "@effect/ui"
 * import { Inspector } from "@effect/ui-devtools"
 * import { Effect, Layer } from "effect"
 *
 * const inspector = Inspector.make()
 *
 * const InspectorLog = Layer.effect(
 *   MessageLog.MessageLog,
 *   MessageLog.makeEncoded((batch) => Effect.sync(() => inspector.ingest(batch)))
 * )
 * ```
 *
 * @stability experimental
 * @since 0.1.0
 */
import type * as MessageLog from "@effect/ui/MessageLog"
import type * as Schema from "effect/Schema"
import * as internal from "./internal/inspector.ts"

/**
 * What `Session.resolve` gives for a `seq` the session doesn't hold: the
 * ring buffer dropped the entry, the session was cleared, or the entry was
 * never given to it.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Outside {
  readonly _tag: "Outside"
  readonly seq: number
}

/**
 * How a `Record` ended.
 *
 * **Details**
 *
 * - A Command run: `"ended"` for `CommandEnded`, `"server"` for
 *   `CommandDropped`, `"failed"` for a `Failed` whose `issued` is the
 *   run's, and the entry's own `reason` for `CommandInterrupted`:
 *   `"interrupt"`, `"switch"`, `"unmount"`, `"layer"` or `"self"`.
 * - A mount: `MountEnded`'s `reason`, `"completed"`, `"closed"` or
 *   `"failed"`.
 * - A Layer build: `"ready"` for `LayerReady`, `"failed"` for
 *   `LayerFailed`, and `"unmount"` for one still pending at its instance's
 *   `Unmounted`.
 * - A Subscription: `"stopped"` for `SubscriptionStopped`, and
 *   `"unmount"` for one still going at its instance's `Unmounted`.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type Reason =
  | MessageLog.InterruptReason
  | "ended"
  | "server"
  | "completed"
  | "closed"
  | "failed"
  | "ready"
  | "stopped"

/**
 * One thing an instance started that goes on for a while: a Layer build, a
 * Subscription, a mount or a Command run.
 *
 * **Details**
 *
 * `start` and `end` are the `seq` of the entries that started and ended
 * it, and `reason` says how it ended. A record without `end` is still open.
 *
 * - `"layer"`: from `LayerPending` to `LayerReady`, `LayerFailed` or the
 *   instance's `Unmounted`. `name` is the component's. A Layer that is
 *   built or fails at once logs no `LayerPending`, and has no record.
 * - `"subscription"`: from `SubscriptionStarted` to `SubscriptionStopped`
 *   or the instance's `Unmounted`. `name` and `key` are the
 *   Subscription's.
 * - `"mount"`: from `MountStarted` to `MountEnded`. `name` is the
 *   mount's.
 * - `"command"`: a Command run. `issued` is the entry that issued it and
 *   its index in that entry's `commands`, and `name` the Command's. The
 *   record begins when an `Update` or a `Mounted` issues the Command, and
 *   `start` is its `CommandStarted`. A run without `start` hasn't begun
 *   its work: it's queued in its group, it waits for its instance's Layer,
 *   or it was stopped first, and then it has an `end` and no `start`. An
 *   entry ends the run its `issued` names and no other: a `Failed` without
 *   `issued` ends none, whatever Command it names.
 *
 * A record is made from the entry that begins it. An entry about something
 * the session never saw begin makes none, so a session that was given the
 * end of a run and not its start doesn't say the run never started. The one
 * exception is a `CommandStarted` whose issuing entry the session never
 * had: it makes a record that has its `start`.
 *
 * On the server no Command runs, and the Commands `init` returned are
 * dropped without an entry, so their records stay open with no `start`.
 *
 * An open record outlives its entries: its `start` can be a `seq` that
 * `Session.resolve` no longer holds. A record that ended is kept while the
 * entry that ended it is in the buffer.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Record {
  readonly kind: "layer" | "subscription" | "mount" | "command"
  /** The `instance` number of the instance it belongs to. */
  readonly instance: number
  readonly name: string
  /** A Subscription's key. Only a `"subscription"` record has it. */
  readonly key?: string
  /** The entry that issued the run and its index in that entry's `commands`. Only a `"command"` record has it. */
  readonly issued?: MessageLog.Issued
  /** The `seq` of the entry that started it. Only a Command run can be without one. */
  readonly start?: number
  /** The `seq` of the entry that ended it. */
  readonly end?: number
  readonly reason?: Reason
}

/**
 * An instance the session has entries of.
 *
 * **Details**
 *
 * `mounted` and `unmounted` are the `seq` of its `Mounted` and
 * `Unmounted` entries, absent when the session wasn't given one. An
 * instance is kept while it's mounted. One that unmounted, or that the
 * session never saw mount, is dropped once the buffer holds none of its
 * entries and none of its records are left.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Instance {
  readonly instance: number
  readonly path: string
  readonly component: string
  readonly mounted?: number
  readonly unmounted?: number
}

/**
 * What an instance's Command runs and entries come to, kept as entries
 * arrive and leave the buffer.
 *
 * **Details**
 *
 * - `waiting`, `running` and `ended` count the instance's `"command"`
 *   records: open without a `start`, open with one, and ended, by reason in
 *   the order each reason first ended. An ended run leaves the counts when
 *   the entry that ended it leaves the buffer.
 * - `latest` is the `seq` of the instance's latest `Update`, `Failed`,
 *   `CommandStarted`, `CommandAwaiting`, `CommandEnded`,
 *   `CommandInterrupted` or `CommandDropped` that `entries` holds, absent
 *   when it holds none. An excluded `Update` doesn't count.
 * - `parent` is the `instance` this one is under: the closest whose
 *   `path` this one's is under, and of those at that path the latest that
 *   came before it. So an instance that mounts again at a path gets its own
 *   children. It's absent for a root and for an instance whose parent the
 *   session never held, and a parent stays while it has children.
 * - `below` counts the instances under this one, at any depth: all of
 *   them, the ones with an ended run whose reason isn't `"ended"` (it
 *   failed, was interrupted or was dropped), and the ones with a run going.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Summary extends Instance {
  readonly parent?: number
  readonly waiting: number
  readonly running: number
  readonly ended: ReadonlyArray<
    { readonly reason: Reason; readonly count: number }
  >
  readonly latest?: number
  readonly below: {
    readonly instances: number
    readonly failing: number
    readonly running: number
  }
}

/**
 * One entry naming another.
 *
 * **Details**
 *
 * From `Session.back`, `seq` is the entry named. From `Session.forward`,
 * it's the entry that names.
 *
 * - `"causedBy"`: the entry's `causedBy`.
 * - `"issued"`: the `issued` of a `CommandStarted`, `CommandAwaiting`,
 *   `CommandEnded`, `CommandInterrupted`, `CommandDropped` or
 *   `SendDropped`, and of a `Failed` that has one. `index` is its index.
 * - `"source"`: what sent the message of an `Update`, or of a `Failed`
 *   whose `update` threw. A Command's result names the entry that issued the
 *   run, with its `index`. A Subscription's message names the
 *   `SubscriptionStarted` of that key on the instance. A query, an emit, a
 *   failure, a send, a shared value and a mount name the `seq` the source
 *   carries. A DOM event, a dispatch and a collected report name nothing.
 * - `"started"`: a `MountEnded`'s `started`.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Link {
  readonly rel: "causedBy" | "issued" | "source" | "started"
  readonly seq: number
  readonly index?: number
}

/**
 * The entry an instance's state is compared with: its `Waiting`, `Mounted`
 * or `Update` before this one.
 *
 * **Details**
 *
 * `changed` says whether the Model differs from that entry's: `true` when a
 * value differs, `false` when none does, and `"unknown"` when the only
 * values that could differ are placeholders (see `diff`).
 *
 * The two are compared when the later entry is given to the session, and
 * the session keeps the answer, not the entry. `changed` is absent when the
 * buffer no longer held the earlier entry by then: its Model is gone, and
 * nothing says whether it differed. An answer already there stays when the
 * earlier entry leaves the buffer after it.
 *
 * When the earlier entry left through `Session.clear`, the mounted instance
 * kept its last Wire Model and props as a baseline, so `changed`, `model`
 * and `props` are present even though `Session.resolve` returns `Outside`
 * for `seq`.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Previous {
  readonly seq: number
  readonly changed?: boolean | "unknown"
  readonly model?: Schema.Json
  readonly props?: Schema.Json
}

/**
 * One difference between two Wire values, at `path`.
 *
 * **Details**
 *
 * `"changed"` has both values, `"added"` only `after` and `"removed"`
 * only `before`. `"unknown"` is a place where either value is a
 * placeholder: whether it changed can't be told.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Change {
  readonly kind: "changed" | "added" | "removed" | "unknown"
  readonly path: ReadonlyArray<string | number>
  readonly before?: Schema.Json
  readonly after?: Schema.Json
}

/**
 * What an inspector keeps of one session of a message log.
 *
 * **Details**
 *
 * Every `seq` an entry, a `Record`, a `Link` or a `Previous` holds goes
 * through `resolve`. What a method returns is a copy as of the call: it
 * doesn't change when the session is given more entries.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Session {
  readonly id: string
  /** The `app` of the session's `SessionStarted`, once the session was given it. */
  readonly app: string | undefined
  /** The entries in the buffer, oldest first. */
  readonly entries: () => ReadonlyArray<MessageLog.WireEntry>
  /** The entry with this `seq`, or `Outside` when the buffer doesn't hold it. */
  readonly resolve: (seq: number) => MessageLog.WireEntry | Outside
  /** The instances, in the order they were first seen. */
  readonly instances: () => ReadonlyArray<Instance>
  /** How many instances the session has. */
  readonly instanceCount: () => number
  /** The summary of one instance, by its `instance` number. */
  readonly summary: (instance: number) => Summary | undefined
  /** The instances with a Command record or a `latest` entry, latest first, and those with no `latest` last. */
  readonly active: () => ReadonlyArray<Summary>
  /** The instances whose `parent` is `instance`, in the order they were first seen. With no `instance`, those with no `parent`. */
  readonly children: (instance?: number) => ReadonlyArray<Summary>
  /** The instances whose name, the last segment of their `path`, or `component` holds `text`, ignoring case, in the order they were first seen. */
  readonly find: (text: string) => ReadonlyArray<Summary>
  /** The records of one instance, or of every instance, oldest first within an instance. */
  readonly records: (instance?: number) => ReadonlyArray<Record>
  /** The record of the Command run an entry issued at this index. */
  readonly run: (issued: MessageLog.Issued) => Record | undefined
  /** The entries the entry with this `seq` names. */
  readonly back: (seq: number) => ReadonlyArray<Link>
  /** The entries in the buffer that name this `seq`, oldest first. */
  readonly forward: (seq: number) => ReadonlyArray<Link>
  /** For a `Waiting`, `Mounted` or `Update`: the instance's state entry before it, when there is one. */
  readonly previous: (seq: number) => Previous | undefined
  /**
   * Empties the buffer. Open records and mounted instances stay, and no entry
   * remains in `entries` or `resolve`. Each mounted instance keeps the `seq`,
   * Model and props of its last state entry as a baseline so the next entry
   * can still be diffed against the state before the clear.
   */
  readonly clear: () => void
}

/**
 * Reads Wire entries into one `Session` for each session id.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Inspector {
  /**
   * Takes entries in the order they were logged. An entry whose `seq` isn't
   * above the last one its session was given is ignored, so a batch given
   * twice is read once.
   */
  readonly ingest: (batch: ReadonlyArray<MessageLog.WireEntry>) => void
  /** The sessions, in the order they were first seen. */
  readonly sessions: () => ReadonlyArray<Session>
  /** Forgets a session and every entry of it. Later entries of that id start a new `Session`. */
  readonly remove: (session: string) => void
}

/**
 * Every difference between two Wire values, such as the Models of two
 * entries, in the order of `before`'s keys and then `after`'s new ones.
 *
 * **Details**
 *
 * Objects are compared key by key and arrays index by index, so an item
 * inserted at the front of an array reads as a change to every item after
 * it. A placeholder (see `MessageLog.isPlaceholder`) is a leaf whose value
 * isn't known, so a place where either value is one is reported as
 * `"unknown"`, even when both are the same placeholder.
 *
 * **Example** (Comparing two Models)
 *
 * ```ts
 * import { Inspector } from "@effect/ui-devtools"
 *
 * const changes = Inspector.diff(
 *   { status: "Dirty", token: { "~redacted": true } },
 *   { status: "Saving", token: { "~redacted": true } }
 * )
 *
 * console.log(changes)
 * // [
 * //   { kind: "changed", path: ["status"], before: "Dirty", after: "Saving" },
 * //   { kind: "unknown", path: ["token"], before: { "~redacted": true }, after: { "~redacted": true } }
 * // ]
 * ```
 *
 * @stability experimental
 * @category diffing
 * @since 0.1.0
 */
export const diff: (
  before: Schema.Json,
  after: Schema.Json
) => ReadonlyArray<Change> = internal.diff

/**
 * Makes an inspector whose sessions each hold their last `size` shown entries
 * (1,000 by default).
 *
 * **Details**
 *
 * `exclude` lists message `_tag` values, matched across every component. An
 * `Update` whose message has one of those tags is omitted from `entries`, and
 * a run of them takes one slot per instance: each replaces the instance's
 * earlier excluded entry while no shown entry of any instance sits between
 * them. Links to a replaced entry resolve to `Outside`. The next shown entry
 * is still compared with the latest excluded state. An `Update` frame marked
 * `excluded`, as `DevTools.layer` sends one, is excluded too.
 *
 * `exclude` is not a way to hide sensitive data: later entries still carry
 * whatever an excluded message changed in the Model. Use `Schema.Redacted`
 * for sensitive values.
 *
 * @stability experimental
 * @category constructors
 * @since 0.1.0
 */
export const make = (options?: {
  readonly size?: number | undefined
  readonly exclude?: ReadonlyArray<string> | undefined
}): Inspector =>
  internal.make({
    size: options?.size,
    isExcluded: internal.matchTags(new Set(options?.exclude))
  })
