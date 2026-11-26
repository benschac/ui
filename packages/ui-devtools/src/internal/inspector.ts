import * as MessageLog from "@effect/ui/MessageLog"
import type * as Schema from "effect/Schema"
import type * as Inspector from "../Inspector.ts"
import { isRun, nameOf, reasonTone, tagOf } from "./read.ts"

type Entry = MessageLog.WireEntry
type InstanceEntry = Exclude<
  Entry,
  { readonly _tag: "SessionStarted" | "FetchStarted" }
>
type Source = Extract<Entry, { readonly _tag: "Update" }>["source"]
type Mutable<A> = { -readonly [K in keyof A]: A[K] }

interface Baseline {
  readonly seq: number
  readonly model: Schema.Json
  readonly props: Schema.Json
}

interface InstanceState {
  readonly info: Mutable<Inspector.Instance>
  readonly records: Array<Mutable<Inspector.Record>>
  readonly subscriptions: Map<string, Mutable<Inspector.Record>>
  layer: Mutable<Inspector.Record> | undefined
  state: number | undefined
  latest: Baseline | undefined
  baseline: Baseline | undefined
  buffered: number
  readonly search: string
  waiting: number
  running: number
  readonly ended: Map<Inspector.Reason, number>
  lastActive: number | undefined
  failing: boolean
  going: boolean
  readonly parent: InstanceState | undefined
  readonly children: Set<InstanceState>
  readonly below: Mutable<Inspector.Summary["below"]>
}

const isActivity = (entry: Entry) =>
  entry._tag === "Update" || entry._tag === "Failed" || isRun(entry)

type Emit = (
  kind: Inspector.Change["kind"],
  before: Schema.Json | undefined,
  after: Schema.Json | undefined
) => boolean

const isObject = (value: Schema.Json): value is Schema.JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const walk = (
  before: Schema.Json,
  after: Schema.Json,
  path: Array<string | number>,
  emit: Emit
): boolean => {
  if (MessageLog.isPlaceholder(before) || MessageLog.isPlaceholder(after)) {
    return emit("unknown", before, after)
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length)
    for (let index = 0; index < length; index++) {
      path.push(index)
      const stop = index >= before.length
        ? emit("added", undefined, after[index])
        : index >= after.length
        ? emit("removed", before[index], undefined)
        : walk(before[index], after[index], path, emit)
      path.pop()
      if (stop) return true
    }
    return false
  }
  if (isObject(before) && isObject(after)) {
    for (const key of Object.keys(before)) {
      path.push(key)
      const stop = Object.hasOwn(after, key)
        ? walk(before[key], after[key], path, emit)
        : emit("removed", before[key], undefined)
      path.pop()
      if (stop) return true
    }
    for (const key of Object.keys(after)) {
      if (Object.hasOwn(before, key)) continue
      path.push(key)
      const stop = emit("added", undefined, after[key])
      path.pop()
      if (stop) return true
    }
    return false
  }
  return before !== after && emit("changed", before, after)
}

const compare = (
  before: Schema.Json,
  after: Schema.Json
): boolean | "unknown" => {
  let unknown = false
  const changed = walk(before, after, [], (kind) => {
    if (kind !== "unknown") return true
    unknown = true
    return false
  })
  return changed || (unknown ? "unknown" : false)
}

export const diff = (
  before: Schema.Json,
  after: Schema.Json
): ReadonlyArray<Inspector.Change> => {
  const changes: Array<Inspector.Change> = []
  const path: Array<string | number> = []
  walk(before, after, path, (kind, from, to) => {
    changes.push({
      kind,
      path: path.slice(),
      ...(from === undefined ? undefined : { before: from }),
      ...(to === undefined ? undefined : { after: to })
    })
    return false
  })
  return changes
}

const runKey = (issued: MessageLog.Issued) => `${issued.seq}:${issued.index}`

const push = <K, V>(map: Map<K, Array<V>>, key: K, value: V) => {
  const list = map.get(key)
  if (list === undefined) map.set(key, [value])
  else list.push(value)
}

export const matchTags =
  (tags: ReadonlySet<string>) => (entry: MessageLog.Entry | Entry): boolean => {
    if (entry._tag !== "Update") return false
    const tag = tagOf(entry.message)
    return tag !== undefined && tags.has(tag)
  }

const makeSession = (
  id: string,
  size: number,
  isExcluded: ((entry: Entry) => boolean) | undefined
) => {
  const entries = new Map<number, Entry>()
  const hidden = new Set<number>()
  const coalesced = new Map<number, Entry>()
  const instances = new Map<number, InstanceState>()
  const runs = new Map<string, Mutable<Inspector.Record>>()
  const mounts = new Map<number, Mutable<Inspector.Record>>()
  const back = new Map<number, Array<Inspector.Link>>()
  const forward = new Map<number, Array<Inspector.Link>>()
  const previous = new Map<number, Inspector.Previous>()
  const ended = new Map<number, Array<Mutable<Inspector.Record>>>()
  const roots = new Set<InstanceState>()
  const byPath = new Map<string, Array<InstanceState>>()
  const active = new Set<InstanceState>()
  let app: string | undefined
  let last = -Infinity

  const link = (
    from: number,
    rel: Inspector.Link["rel"],
    seq: number,
    index?: number
  ) => {
    push(back, from, index === undefined ? { rel, seq } : { rel, seq, index })
    push(
      forward,
      seq,
      index === undefined ? { rel, seq: from } : { rel, seq: from, index }
    )
  }

  const parentFor = (path: string, instance: number) => {
    for (
      let end = path.lastIndexOf("/");
      end > 0;
      end = path.lastIndexOf("/", end - 1)
    ) {
      const there = byPath.get(path.slice(0, end))
      if (there === undefined) continue
      for (let index = there.length - 1; index >= 0; index--) {
        if (there[index].info.instance < instance) return there[index]
      }
    }
    return undefined
  }

  const ancestors = (
    inst: InstanceState,
    f: (below: InstanceState["below"]) => void
  ) => {
    for (let at = inst.parent; at !== undefined; at = at.parent) f(at.below)
  }

  const tally = (record: Inspector.Record, by: 1 | -1) => {
    if (record.kind !== "command") return
    const inst = instances.get(record.instance)!
    if (record.end === undefined) {
      if (record.start === undefined) inst.waiting += by
      else inst.running += by
      return
    }
    const count = (inst.ended.get(record.reason!) ?? 0) + by
    if (count === 0) inst.ended.delete(record.reason!)
    else inst.ended.set(record.reason!, count)
  }

  const refresh = (inst: InstanceState) => {
    let failing = false
    for (const reason of inst.ended.keys()) {
      if (reasonTone[reason] === "bad") failing = true
    }
    const going = inst.running > 0
    if (failing !== inst.failing) {
      inst.failing = failing
      ancestors(inst, (below) => below.failing += failing ? 1 : -1)
    }
    if (going !== inst.going) {
      inst.going = going
      ancestors(inst, (below) => below.running += going ? 1 : -1)
    }
    if (
      inst.waiting + inst.running + inst.ended.size > 0 ||
      inst.lastActive !== undefined
    ) active.add(inst)
    else active.delete(inst)
  }

  const add = (inst: InstanceState) => {
    instances.set(inst.info.instance, inst)
    push(byPath, inst.info.path, inst)
    ;(inst.parent?.children ?? roots).add(inst)
    ancestors(inst, (below) => below.instances++)
  }

  const droppable = (inst: InstanceState) =>
    inst.buffered === 0 && inst.records.length === 0 &&
    inst.children.size === 0 &&
    (inst.info.unmounted !== undefined || inst.info.mounted === undefined)

  const drop = (inst: InstanceState) => {
    const path = inst.info.path
    instances.delete(inst.info.instance)
    const same = byPath.get(path)!
    if (same.length === 1) byPath.delete(path)
    else same.splice(same.indexOf(inst), 1)
    ;(inst.parent?.children ?? roots).delete(inst)
    ancestors(inst, (below) => below.instances--)
    if (inst.parent !== undefined && droppable(inst.parent)) drop(inst.parent)
  }

  const amend = (
    record: Mutable<Inspector.Record>,
    patch: Partial<Inspector.Record>
  ) => {
    tally(record, -1)
    Object.assign(record, patch)
    tally(record, 1)
    refresh(instances.get(record.instance)!)
  }

  const open = (inst: InstanceState, record: Mutable<Inspector.Record>) => {
    inst.records.push(record)
    tally(record, 1)
    return record
  }

  const close = (
    record: Mutable<Inspector.Record>,
    seq: number,
    reason: Inspector.Reason
  ) => {
    amend(record, { end: seq, reason })
    push(ended, seq, record)
  }

  const end = (
    seq: number,
    issued: MessageLog.Issued,
    reason: Inspector.Reason
  ) => {
    link(seq, "issued", issued.seq, issued.index)
    const run = runs.get(runKey(issued))
    if (run !== undefined && run.end === undefined) close(run, seq, reason)
  }

  const linkSource = (inst: InstanceState, from: number, source: Source) => {
    switch (source._tag) {
      case "Command":
        return link(from, "source", source.issued.seq, source.issued.index)
      case "Subscription": {
        const start = inst.subscriptions.get(source.key)?.start
        return start === undefined ? undefined : link(from, "source", start)
      }
      case "Query":
      case "Emit":
      case "Failure":
      case "Send":
      case "Shared":
      case "Mount":
        return link(from, "source", source.seq)
    }
  }

  const track = (entry: InstanceEntry) => {
    let inst = instances.get(entry.instance)
    if (inst === undefined) {
      inst = {
        info: {
          instance: entry.instance,
          path: entry.path,
          component: entry.component
        },
        records: [],
        subscriptions: new Map(),
        layer: undefined,
        state: undefined,
        latest: undefined,
        baseline: undefined,
        buffered: 0,
        search: (nameOf(entry.path) + "\n" + entry.component).toLowerCase(),
        waiting: 0,
        running: 0,
        ended: new Map(),
        lastActive: undefined,
        failing: false,
        going: false,
        parent: parentFor(entry.path, entry.instance),
        children: new Set(),
        below: { instances: 0, failing: 0, running: 0 }
      }
      add(inst)
    }
    inst.buffered++
    if (isActivity(entry) && !hidden.has(entry.seq)) {
      inst.lastActive = entry.seq
    }
    change(inst, entry)
    refresh(inst)
  }

  const change = (inst: InstanceState, entry: InstanceEntry) => {
    const { instance, seq } = entry
    switch (entry._tag) {
      case "Waiting":
      case "Mounted":
      case "Update": {
        if (inst.state !== undefined) {
          const before = entries.get(inst.state)
          previous.set(
            seq,
            before !== undefined && "model" in before
              ? { seq: inst.state, changed: compare(before.model, entry.model) }
              : inst.baseline?.seq === inst.state
              ? {
                ...inst.baseline,
                changed: compare(inst.baseline.model, entry.model)
              }
              : { seq: inst.state }
          )
        }
        inst.state = seq
        inst.latest = { seq, model: entry.model, props: entry.props }
        if (entry._tag === "Waiting") return
        if (entry._tag === "Mounted") inst.info.mounted = seq
        else linkSource(inst, seq, entry.source)
        for (let index = 0; index < entry.commands.length; index++) {
          const command = entry.commands[index]
          if (command._tag === "Interrupt") continue
          const issued = { seq, index }
          runs.set(
            runKey(issued),
            open(inst, {
              kind: "command",
              instance,
              name: command.name,
              issued
            })
          )
        }
        return
      }
      case "Failed": {
        if (entry.update !== undefined) {
          linkSource(inst, seq, entry.update.source)
        }
        if (entry.issued !== undefined) end(seq, entry.issued, "failed")
        return
      }
      case "Unmounted": {
        inst.info.unmounted = seq
        inst.latest = undefined
        inst.baseline = undefined
        if (inst.layer !== undefined) close(inst.layer, seq, "unmount")
        inst.layer = undefined
        for (const record of inst.subscriptions.values()) {
          close(record, seq, "unmount")
        }
        inst.subscriptions.clear()
        return
      }
      case "LayerPending": {
        inst.layer ??= open(inst, {
          kind: "layer",
          instance,
          name: entry.component,
          start: seq
        })
        return
      }
      case "LayerReady":
      case "LayerFailed": {
        if (inst.layer !== undefined) {
          close(
            inst.layer,
            seq,
            entry._tag === "LayerReady" ? "ready" : "failed"
          )
        }
        inst.layer = undefined
        return
      }
      case "SubscriptionStarted": {
        const record = open(inst, {
          kind: "subscription",
          instance,
          name: entry.name,
          key: entry.key,
          start: seq
        })
        inst.subscriptions.set(entry.key, record)
        return
      }
      case "SubscriptionStopped": {
        const record = inst.subscriptions.get(entry.key)
        if (record === undefined) return
        close(record, seq, "stopped")
        inst.subscriptions.delete(entry.key)
        return
      }
      case "MountStarted": {
        mounts.set(
          seq,
          open(inst, { kind: "mount", instance, name: entry.name, start: seq })
        )
        return
      }
      case "MountEnded": {
        link(seq, "started", entry.started)
        const record = mounts.get(entry.started)
        if (record === undefined) return
        close(record, seq, entry.reason)
        mounts.delete(entry.started)
        return
      }
      case "CommandStarted": {
        link(seq, "issued", entry.issued.seq, entry.issued.index)
        const key = runKey(entry.issued)
        let run = runs.get(key)
        if (run === undefined) {
          run = open(inst, {
            kind: "command",
            instance,
            name: entry.name,
            issued: entry.issued
          })
          runs.set(key, run)
        }
        amend(run, { start: seq })
        return
      }
      case "CommandAwaiting":
      case "SendDropped":
        return link(seq, "issued", entry.issued.seq, entry.issued.index)
      case "CommandEnded":
      case "CommandInterrupted":
      case "CommandDropped":
        return end(
          seq,
          entry.issued,
          entry._tag === "CommandEnded" ? "ended" : entry.reason
        )
    }
  }

  const evict = (seq: number, entry: Entry, prune = true) => {
    entries.delete(seq)
    hidden.delete(seq)
    previous.delete(seq)
    for (const named of back.get(seq) ?? []) {
      const kept = forward.get(named.seq)?.filter((naming) =>
        naming.seq !== seq
      )
      if (kept === undefined) continue
      if (kept.length === 0) forward.delete(named.seq)
      else forward.set(named.seq, kept)
    }
    back.delete(seq)
    for (const record of ended.get(seq) ?? []) {
      const owner = instances.get(record.instance)!
      owner.records.splice(owner.records.indexOf(record), 1)
      if (record.issued !== undefined) runs.delete(runKey(record.issued))
      tally(record, -1)
      refresh(owner)
    }
    ended.delete(seq)
    if (entry._tag === "SessionStarted" || entry._tag === "FetchStarted") return
    const inst = instances.get(entry.instance)!
    inst.buffered--
    if (seq === inst.lastActive) {
      inst.lastActive = undefined
      refresh(inst)
    }
    if (prune && droppable(inst)) drop(inst)
  }

  const summarize = (inst: InstanceState): Inspector.Summary => ({
    ...inst.info,
    ...(inst.parent === undefined
      ? undefined
      : { parent: inst.parent.info.instance }),
    waiting: inst.waiting,
    running: inst.running,
    ended: Array.from(inst.ended, ([reason, count]) => ({ reason, count })),
    ...(inst.lastActive === undefined
      ? undefined
      : { latest: inst.lastActive }),
    below: { ...inst.below }
  })

  const session: Inspector.Session = {
    id,
    get app() {
      return app
    },
    entries: () => {
      const all = Array.from(entries.values())
      return hidden.size === 0
        ? all
        : all.filter((entry) => !hidden.has(entry.seq))
    },
    resolve: (seq) => entries.get(seq) ?? { _tag: "Outside", seq },
    instances: () =>
      Array.from(instances.values(), (inst) => ({ ...inst.info })),
    instanceCount: () => instances.size,
    summary: (instance) => {
      const inst = instances.get(instance)
      return inst === undefined ? undefined : summarize(inst)
    },
    active: () =>
      Array.from(active, summarize).sort((a, b) =>
        (b.latest ?? -1) - (a.latest ?? -1)
      ),
    children: (instance) =>
      Array.from(
        instance === undefined
          ? roots
          : instances.get(instance)?.children ?? [],
        summarize
      ),
    find: (text) => {
      const needle = text.toLowerCase()
      const found: Array<Inspector.Summary> = []
      for (const inst of instances.values()) {
        if (inst.search.includes(needle)) found.push(summarize(inst))
      }
      return found
    },
    records: (instance) =>
      (instance === undefined
        ? Array.from(instances.values()).flatMap((inst) => inst.records)
        : instances.get(instance)?.records ?? []).map((record) => ({
          ...record
        })),
    run: (issued) => {
      const record = runs.get(runKey(issued))
      return record === undefined ? undefined : { ...record }
    },
    back: (seq) => back.get(seq)?.slice() ?? [],
    forward: (seq) => forward.get(seq)?.slice() ?? [],
    previous: (seq) => previous.get(seq),
    clear: () => {
      for (const inst of instances.values()) inst.baseline = inst.latest
      for (const [seq, entry] of Array.from(entries)) evict(seq, entry)
      coalesced.clear()
    }
  }

  return {
    session,
    ingest: (entry: Entry) => {
      if (entry.seq <= last) return
      last = entry.seq
      if (
        entry._tag === "Update" &&
        (entry.excluded === true || isExcluded?.(entry) === true)
      ) {
        const replaced = coalesced.get(entry.instance)
        if (replaced !== undefined) {
          const inst = instances.get(entry.instance)
          if (inst?.state === replaced.seq) {
            inst.state = previous.get(replaced.seq)?.seq
          }
          evict(replaced.seq, replaced, false)
        }
        hidden.add(entry.seq)
        coalesced.set(entry.instance, entry)
      } else coalesced.clear()
      entries.set(entry.seq, entry)
      if (entry.causedBy !== undefined) {
        link(entry.seq, "causedBy", entry.causedBy)
      }
      if (entry._tag === "SessionStarted") app = entry.app
      else if (entry._tag !== "FetchStarted") track(entry)
      for (const [seq, oldest] of entries) {
        if (entries.size - hidden.size <= size) break
        evict(seq, oldest)
      }
    }
  }
}

export const make = (options: {
  readonly size?: number | undefined
  readonly isExcluded?: ((entry: Entry) => boolean) | undefined
}): Inspector.Inspector => {
  const size = Math.max(1, options.size ?? 1_000)
  const sessions = new Map<string, ReturnType<typeof makeSession>>()
  return {
    ingest: (batch) => {
      for (const entry of batch) {
        let state = sessions.get(entry.session)
        if (state === undefined) {
          state = makeSession(entry.session, size, options.isExcluded)
          sessions.set(entry.session, state)
        }
        state.ingest(entry)
      }
    },
    sessions: () => Array.from(sessions.values(), (state) => state.session),
    remove: (session) => {
      sessions.delete(session)
    }
  }
}
