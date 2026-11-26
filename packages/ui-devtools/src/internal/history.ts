import type * as BrowserHost from "@effect/ui/html/BrowserHost"
import * as MessageLog from "@effect/ui/MessageLog"

type Entry = MessageLog.Entry | MessageLog.WireEntry

export interface Held {
  readonly path: string
  readonly model: unknown
  readonly props: unknown
  readonly queries: unknown
  readonly unmounted?: number | undefined
}

export type State = (path: string) => BrowserHost.Recorded | undefined

export interface History {
  readonly record: (entry: Entry) => void
  readonly clear: (session: string, upTo: number) => void
  readonly drop: (session: string) => void
  readonly holds: (session: string, seq: number) => boolean
  /** An entry held, shown or excluded. */
  readonly entry: (session: string, seq: number) => Entry | undefined
  /** The last seq recorded, shown or not. */
  readonly latest: (session: string) => number | undefined
  /** Whether a seq never arrived, while later ones did. */
  readonly skipped: (session: string, seq: number) => boolean
  readonly at: (session: string, seq: number) => State | undefined
  readonly instanceAt: (
    session: string,
    seq: number,
    instance: number
  ) => Held | "outside" | undefined
}

const merge = (queries: unknown, name: string, result: unknown) =>
  MessageLog.isPlaceholder(queries)
    ? queries
    : { ...(queries as object | undefined), [name]: result }

const apply = (
  states: Map<number, Held>,
  entry: Entry,
  keepUnmounted: boolean
) => {
  switch (entry._tag) {
    case "Waiting":
    case "Mounted":
    case "Update":
      states.set(entry.instance, {
        path: entry.path,
        props: entry.props,
        model: entry.model,
        queries: entry.queries ?? states.get(entry.instance)?.queries
      })
      return
    case "PropsChanged": {
      const held = states.get(entry.instance)
      if (held !== undefined) {
        states.set(entry.instance, { ...held, props: entry.props })
      }
      return
    }
    case "QueryChanged": {
      const held = states.get(entry.instance)
      if (held !== undefined) {
        states.set(entry.instance, {
          ...held,
          queries: merge(held.queries, entry.name, entry.result)
        })
      }
      return
    }
    case "Unmounted": {
      const held = states.get(entry.instance)
      if (keepUnmounted && held !== undefined) {
        states.set(entry.instance, { ...held, unmounted: entry.seq })
      } else states.delete(entry.instance)
      return
    }
  }
}

const isDirty = (dirty: ReadonlySet<string>, path: string) => {
  if (dirty.has(path)) return true
  for (const ancestor of dirty) {
    if (path.startsWith(ancestor + "/")) return true
  }
  return false
}

const makeSession = (size: number) => {
  const base = new Map<number, Held>()
  const entries: Array<Entry> = []
  const shown = new Map<number, Entry>()
  const coalesced = new Map<number, Entry>()
  // Ranges of seqs that never arrived, kept until older than the entries held.
  const gaps: Array<readonly [number, number]> = []
  let floor = -Infinity
  let last = -Infinity
  const drop = () => {
    const oldest = entries.shift()!
    floor = oldest.seq
    shown.delete(oldest.seq)
    if (oldest._tag === "Update" && coalesced.get(oldest.instance) === oldest) {
      coalesced.delete(oldest.instance)
    }
    apply(base, oldest, false)
    while (gaps.length > 0 && gaps[0]![1] < floor) gaps.shift()
  }
  const fold = (seq: number) => {
    const states = new Map(base)
    for (const entry of entries) {
      if (entry.seq > seq) break
      apply(states, entry, true)
    }
    return states
  }
  return {
    record: (entry: Entry) => {
      if (entry.seq <= last) return
      if (entry.seq > last + 1 && last !== -Infinity) {
        gaps.push([last + 1, entry.seq - 1])
      }
      last = entry.seq
      if (entry._tag === "Update" && entry.excluded === true) {
        const replaced = coalesced.get(entry.instance)
        if (replaced !== undefined) {
          entries.splice(entries.lastIndexOf(replaced), 1)
        }
        const queries = replaced !== undefined && "queries" in replaced
          ? replaced.queries
          : undefined
        const merged = entry.queries === undefined && queries !== undefined
          ? { ...entry, queries } as Entry
          : entry
        entries.push(merged)
        coalesced.set(entry.instance, merged)
        return
      }
      coalesced.clear()
      entries.push(entry)
      shown.set(entry.seq, entry)
      while (shown.size > size) drop()
    },
    clear: (upTo: number) => {
      while (entries.length > 0 && entries[0]!.seq <= upTo) drop()
    },
    holds: (seq: number) => shown.has(seq),
    entry: (seq: number) =>
      shown.get(seq) ?? entries.find((entry) => entry.seq === seq),
    latest: () => last,
    skipped: (seq: number) =>
      gaps.some(([from, to]) => from <= seq && seq <= to),
    at: (seq: number): State => {
      const states = fold(seq)
      const byPath = new Map<string, BrowserHost.Recorded>()
      for (const instance of Array.from(states.keys()).sort((a, b) => a - b)) {
        const { path, unmounted, ...recorded } = states.get(instance)!
        if (unmounted === undefined) {
          byPath.set(path, recorded as BrowserHost.Recorded)
        }
      }
      // A render can log child mounts after the selected entry, even when their
      // cause is at or before it. Changes to a path or ancestor block reuse.
      const dirty = new Set<string>()
      for (const entry of entries) {
        if (entry.seq <= seq) continue
        switch (entry._tag) {
          case "Mounted":
          case "Waiting":
            if (
              entry.causedBy !== undefined && entry.causedBy <= seq &&
              !byPath.has(entry.path) && !isDirty(dirty, entry.path)
            ) {
              byPath.set(entry.path, {
                props: entry.props,
                model: entry.model,
                queries: entry.queries
              } as BrowserHost.Recorded)
            }
            break
          case "Update":
          case "PropsChanged":
          case "QueryChanged":
          case "Unmounted":
            dirty.add(entry.path)
            break
        }
      }
      return (path) => byPath.get(path)
    },
    instanceAt: (seq: number, instance: number): Held | "outside" | undefined =>
      seq < floor ? "outside" : fold(seq).get(instance)
  }
}

export const make = (size: number): History => {
  const sessions = new Map<string, ReturnType<typeof makeSession>>()
  return {
    record: (entry) => {
      let session = sessions.get(entry.session)
      if (session === undefined) {
        sessions.set(entry.session, session = makeSession(size))
      }
      session.record(entry)
    },
    clear: (session, upTo) => {
      sessions.get(session)?.clear(upTo)
    },
    drop: (session) => {
      sessions.delete(session)
    },
    holds: (session, seq) => sessions.get(session)?.holds(seq) ?? false,
    entry: (session, seq) => sessions.get(session)?.entry(seq),
    latest: (session) => sessions.get(session)?.latest(),
    skipped: (session, seq) => sessions.get(session)?.skipped(seq) ?? false,
    at: (session, seq) => {
      const held = sessions.get(session)
      return held === undefined || !held.holds(seq) ? undefined : held.at(seq)
    },
    instanceAt: (session, seq, instance) =>
      sessions.get(session)?.instanceAt(seq, instance)
  }
}
