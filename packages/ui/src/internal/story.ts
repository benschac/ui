/**
 * The engine behind `Story`: the record of one instance between steps, and
 * the pure dispatch, Command, query and event logic the steps run on it.
 * Errors name the step they come from, as the calling module passes it, such
 * as `Story.resolve`.
 *
 * @internal
 */
import * as Cause from "effect/Cause"
import * as Duration from "effect/Duration"
import * as Equal from "effect/Equal"
import * as Option from "effect/Option"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import * as Schema from "effect/Schema"
import * as Command from "../Command.ts"
import type * as Component from "../Component.ts"
import * as Feature from "../Feature.ts"
import * as MessageLog from "../MessageLog.ts"
import * as Query from "../Query.ts"
import type * as Subscription from "../Subscription.ts"
import * as Locator from "../testing/Locator.ts"
import type {
  AwaitedQuery,
  KeyedLoad,
  Pending,
  QueryInfo,
  StreamTarget,
  Target
} from "../testing/Steps.ts"
import * as View from "../View.ts"
import * as childOf from "./child.ts"
import { sharedEqual } from "./equal.ts"
import { handle } from "./handler.ts"
import { isNoop } from "./noop.ts"
import {
  checkAuthorPlacements,
  checkAuthorWrites,
  checkChildPaths,
  checkContentPaths,
  childName,
  type ChildPaths,
  segment,
  slotSegment
} from "./paths.ts"
import * as componentQueries from "./queries.ts"
import * as schedule from "./schedule.ts"
import * as sharedReads from "./shared.ts"
import type { SlotResult } from "./slotStatus.ts"
import * as subscriptionKeys from "./subscriptions.ts"

/**
 * One instance between steps, as the engine records it: everything a Story or
 * a Scene record shows, plus what the acknowledgement rule tracks. Each kind
 * of test hands out a projection of it.
 *
 * @internal
 */
export interface State<Props, Model, Msg, Events> {
  readonly component: Component.Component<
    any,
    Props,
    Model,
    Msg,
    Events,
    any,
    any,
    any,
    never
  >
  readonly props: Props
  readonly model: Model
  readonly results: Component.Results | undefined
  readonly queries: () => any
  readonly pending: ReadonlyArray<Pending<Msg>>
  /** The events emitted and not acknowledged yet, oldest first. */
  readonly emitted: ReadonlyArray<Events>
  /** The sends not acknowledged yet, oldest first. */
  readonly sent: ReadonlyArray<Component.Send>
  readonly interrupted: ReadonlyArray<Pending<Msg>["command"]>
  readonly loadingMore: ReadonlyArray<string>
  /** The current `subscriptions` result, falsy entries dropped. Throws on a duplicate key, as the runtime fails. */
  readonly declared: () => ReadonlyArray<Subscription.Subscription<any, any>>
  readonly subscriptions: () => ReadonlyArray<string>
  readonly queryInfo: () => ReadonlyArray<QueryInfo>
  readonly defaultPrevented: boolean
  readonly view: () => View.Node<Msg, any>
  readonly root: Locator.Node
  readonly get: (locator: Locator.Locator) => Locator.Node
  readonly query: (locator: Locator.Locator) => Locator.Node | undefined
  readonly all: (locator: Locator.Locator) => ReadonlyArray<Locator.Node>
  readonly ack: Ack<Msg>
}

/**
 * What the acknowledgement rule tracks between steps.
 *
 * @internal
 */
export interface Ack<Msg> {
  /** Pending Commands a `keepPending` step marked. A mark ends when the run settles. */
  readonly kept: ReadonlyArray<Pending<Msg>>
  /** Query entries with no result a `keepPending` step marked, by query name and args key. */
  readonly keptQueries: ReadonlyArray<
    { readonly name: string; readonly argsKey: string }
  >
  /** List queries whose pending load more a `keepPending` step marked. */
  readonly keptMore: ReadonlyArray<string>
  /** How the interaction that made this record went: a message, or none. Every other step resets it. */
  readonly interaction: "handled" | "ignored" | undefined
  /** An ignored interaction that no `expectIgnored` acknowledged yet. */
  readonly ignored: boolean
  /** Whether an acting step ran after `init`. Until one does, `given` replaces what `init` produced. */
  readonly acted: boolean
  /** A scene's: the mounts of the component under test in the view, as of `tree`. */
  readonly mounts: ReadonlyArray<LiveMount>
  /** The view `mounts` were taken from, `undefined` before the first render or after `given`. */
  readonly tree: View.Node<any, any> | undefined
}

/**
 * A mount in a scene's view, followed across renders as the runtime keeps it running.
 *
 * @internal
 */
export interface LiveMount {
  /** The mount as the element last rendered it. */
  readonly mount: View.Mount<any>
  /**
   * The path of the part's owner for a part's mount, or of the child the scene runs for one of its
   * elements' mounts, `undefined` for the element's own.
   */
  readonly owner: string | undefined
  readonly element: View.Element<any, any>
  /** Whether `mounted` or `expectMount` named it. Until then it is work in flight. */
  readonly acknowledged: boolean
  /** Whether `mounted` ended it with a result. A mount that isn't a stream ends once. */
  readonly ended: boolean
}

/** @internal */
export const noAck: Ack<never> = {
  kept: [],
  keptQueries: [],
  keptMore: [],
  interaction: undefined,
  ignored: false,
  acted: false,
  mounts: [],
  tree: undefined
}

/** @internal */
export type Fields<Props, Model, Msg, Events> =
  & Pick<
    State<Props, Model, Msg, Events>,
    | "component"
    | "props"
    | "model"
    | "results"
    | "pending"
    | "emitted"
    | "sent"
    | "interrupted"
    | "loadingMore"
    | "defaultPrevented"
    | "ack"
  >
  & {
    readonly childModels?: ReadonlyMap<string, unknown> | undefined
    readonly childStatus?: ReadonlyMap<string, SlotResult> | undefined
    /**
     * What every feature slot reads that the component's view declares, its slot content included, when
     * its services aren't ready: a replay's Layer status. Not the slots in a `fallback`, which renders
     * against the nearest settled services, nor those in content a parent passed.
     */
    readonly slotStatus?: SlotResult | undefined
    /** `h.isRunning` when it isn't derived from `pending`: a replay's open runs. */
    readonly running?:
      | ((name: string, groupKey: string | undefined) => boolean)
      | undefined
    readonly shared?: ReadonlyMap<Component.Definition.Any, unknown> | undefined
    readonly collected?: Collected | undefined
    /** The children the scene runs, and their Models. See `Run`. */
    readonly run?: Run | undefined
  }

// What a failed slot without a `fallback` shows.
const emptyText: View.Node<never, never> = { _tag: "Text", text: "" }

// -- headless children ------------------------------------------------------
// A story shows a headless child expanded: the closure it was declared with, run against the parts of the
// child's `init` Model or of the Model `givenChild` set. No runtime is involved.
/**
 * The Models `givenChild` set, by the path of the headless child each one is for.
 *
 * @internal
 */
export const childModels = new WeakMap<object, ReadonlyMap<string, unknown>>()

/**
 * The slots `childPending` and `childFailure` recorded, by the child's path: each shows its `fallback` of
 * that result in place of the child, as the runtime's slot does.
 *
 * @internal
 */
export const childStatuses = new WeakMap<
  object,
  ReadonlyMap<string, SlotResult>
>()

/**
 * The path a story gives `found`: the expansion's, or, in a view it left as it was, where every child is
 * the root's own, the root's path and the child's segment.
 *
 * @internal
 */
export const pathOf = (
  story: State<any, any, any, any>,
  found: Occurrence
): string =>
  found.path ??
    "/" + story.component.definition.name + "/" + segment(found.child)

/**
 * One place a view shows a child: the child as declared, and, in a view a story expanded, the path the
 * expansion gave it and the child paths of the view, closure or slot content that declared it, labelled
 * as asked. A child node may be shown at several places, in one view or in several stories' views, so
 * each place is its own occurrence.
 *
 * @internal
 */
export interface Occurrence {
  readonly child: View.Child<any, any>
  readonly path: string | undefined
  readonly scope: ((label: string) => ChildPaths) | undefined
}
// Every child an expansion placed, by the expanded root, in the order it placed them.
const occurrences = new WeakMap<object, ReadonlyArray<Occurrence>>()
// The children an expansion replaced, by the expanded root: `childEmit` and `childFailure` still find them.
const expandedChildren = new WeakMap<
  object,
  ReadonlyArray<View.Child<any, any>>
>()

/**
 * Tracks the declaring children of an expanded root, outermost first. Scene uses
 * this identity rather than the rendered root to match headless siblings.
 *
 * @internal
 */
export const expansionOf = new WeakMap<
  object,
  ReadonlyArray<Expansion>
>()

/** @internal */
export interface Expansion {
  readonly child: View.Child<any, any>
  readonly fallback: boolean
  /** The child's path when the scene runs it: the nodes below are that child's own. */
  readonly run?: string | undefined
}

/**
 * Each slot a slotted child's `children` shows, with how many nodes it placed, in order: the runtime
 * matches each slot's content on its own.
 *
 * @internal
 */
export const slotLengths = new WeakMap<
  object,
  ReadonlyArray<readonly [string, number]>
>()

// A copy per render: a closure may return a node it cached, and the identities are this render's.
const standsFor = (
  child: View.Child<any, any>,
  fallback: boolean,
  inner: View.Node<any, any>,
  run?: string
): View.Node<any, any> => {
  const out = { ...inner } as View.Node<any, any>
  expansionOf.set(out, [
    run === undefined ? { child, fallback } : { child, fallback, run },
    ...(expansionOf.get(inner) ?? [])
  ])
  const lengths = slotLengths.get(inner)
  if (lengths !== undefined) slotLengths.set(out, lengths)
  return out
}

// What a story of a slotted component passed for its slots, by the component `withSlots` made.
const storySlots = new WeakMap<
  object,
  Readonly<Record<string, View.Input<never, any>>>
>()

// The values `shared` gave, by owner definition: definitions, since `withView` copies components.
/** @internal */
export const sharedGiven = new WeakMap<
  object,
  ReadonlyMap<Component.Definition.Any, unknown>
>()

// -- children a scene runs ---------------------------------------------------
// A scene leaves a child as a leaf unless `run` names its component. A child it runs shows its view
// against its own Model, its handlers and mounts send to its own `update`, and its events reach the
// component that wrote it through `onEmit`. No runtime is involved.

/**
 * The children a scene runs: the components `run` named, and the Model of each instance by its path.
 *
 * @internal
 */
export interface Run {
  readonly components: ReadonlyArray<object>
  readonly models: ReadonlyMap<string, unknown>
}

/** @internal */
export const runOf = new WeakMap<object, Run>()

/** One child the scene runs, as the view placed it. */
interface Ran {
  readonly child: View.Child<any, any>
  readonly model: unknown
  /** The path of the child the scene runs that wrote it, `undefined` for the story's component. */
  readonly writer: string | undefined
  readonly shared: Component.SharedLookup
}

// Every child an expansion ran, by the expanded root, by its path.
const ranIn = new WeakMap<object, ReadonlyMap<string, Ran>>()
const noneRan: ReadonlyMap<string, Ran> = new Map()

const ranOf = (story: State<any, any, any, any>): ReadonlyMap<string, Ran> =>
  ranIn.get(story.view()) ?? noneRan

const runs = (run: Run, node: View.Child<any, any>): boolean =>
  (node.component as { readonly parts?: unknown }).parts === undefined &&
  run.components.some((component) => isChildOf(node, component))

/**
 * The path of the innermost child the scene runs that `node` is the root of, if any.
 *
 * @internal
 */
export const runPathOf = (node: View.Node<any, any>): string | undefined => {
  let path: string | undefined
  for (const each of expansionOf.get(node) ?? []) {
    if (each.run !== undefined) path = each.run
  }
  return path
}

/** The child the scene runs that `handler` belongs to: the nearest run root at or above it in `path`. */
const runOwner = (
  path: ReadonlyArray<View.Node<any, any>>,
  handler: View.Node<any, any>
): string | undefined => {
  for (let index = path.indexOf(handler); index < path.length; index++) {
    const run = runPathOf(path[index]!)
    if (run !== undefined) return run
  }
  return undefined
}

const unsupported = (
  next: Component.Next<any, any, any, any>,
  path: string,
  step: string
): void => {
  if (next.commands.length > 0) {
    throw new Error(
      `${step}: ${path} started ${
        next.commands.map((command) => command.name).join(", ")
      }, and a scene doesn't run a child's Commands: test them in a Story of the child, or in a Play`
    )
  }
  if ((next.lists?.length ?? 0) > 0) {
    throw new Error(
      `${step}: ${path} loaded more of a query, and a scene doesn't run a child's queries: test it in a Play`
    )
  }
}

/** Sends what a child the scene runs emitted to the one that wrote it, through the child's `onEmit`. */
const toWriter = (
  story: State<any, any, any, any>,
  ran: Ran,
  events: ReadonlyArray<unknown>,
  step: string
): State<any, any, any, any> => {
  let out = story
  for (const event of events) {
    out = dispatchTo(out, ran.writer, ran.child.onEmit(event), step)
  }
  return out
}

/**
 * Runs `message` through the `update` of the child the scene runs at `path`: its Model changes, its sends
 * are the scene's to acknowledge with `sent`, and its events go to the component that wrote it.
 *
 * @internal
 */
export const dispatchRun = (
  story: State<any, any, any, any>,
  path: string,
  message: unknown,
  step: string
): State<any, any, any, any> => {
  if (message === undefined || isNoop(message)) return story
  const ran = ranOf(story).get(path)
  const run = runOf.get(story)
  if (ran === undefined || run === undefined) {
    throw new Error(`${step}: the scene runs no child at ${path}`)
  }
  const child = ran.child.component as unknown as Component.Component<
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    never
  >
  const next = child.update(
    ran.model,
    message,
    ran.child.props,
    undefined,
    sharedReads.record(child, ran.shared)
  )
  unsupported(next, path, step)
  let out = update(story, {
    run: { ...run, models: new Map(run.models).set(path, next.model) }
  })
  // The owners a child sends to are headless, and a scene doesn't run their `update`.
  const sends = next.sends?.filter((send) => delivered(out, send)) ?? []
  if (sends.length > 0) out = update(out, { sent: [...out.sent, ...sends] })
  return toWriter(out, ran, next.events, step)
}

/**
 * Sends `message` to the child the scene runs at `path`, or to the story's component when `path` names
 * none.
 *
 * @internal
 */
export const dispatchTo = (
  story: State<any, any, any, any>,
  path: string | undefined,
  message: unknown,
  step: string
): State<any, any, any, any> =>
  path !== undefined && ranOf(story).has(path)
    ? dispatchRun(story, path, message, step)
    : dispatch(story, message)

/**
 * Starts the children the scene runs that the view placed since the last step, and ends those it no
 * longer places, as the runtime mounts and unmounts them. A child starts with its `init`, whose events go
 * to the component that wrote it.
 *
 * @internal
 */
export const syncRun = (
  story: State<any, any, any, any>,
  step: string
): State<any, any, any, any> => {
  let out = story
  // loop: a child's `init` events can place more children, so it runs until nothing new is placed.
  for (let round = 0; round < 100; round++) {
    const run = runOf.get(out)
    if (run === undefined) return out
    const ran = ranOf(out)
    const fresh = [...ran].filter(([path]) => !run.models.has(path))
    const gone = [...run.models.keys()].filter((path) => !ran.has(path))
    if (fresh.length === 0 && gone.length === 0) return out
    const models = new Map(run.models)
    for (const path of gone) models.delete(path)
    const started = fresh.map(([path, each]) => {
      const first = (each.child.component as unknown as Component.Any).init(
        each.child.props
      )
      unsupported(first, path, step)
      models.set(path, first.model)
      return [each, first.events] as const
    })
    out = update(out, { run: { ...run, models } })
    for (const [each, events] of started) {
      out = toWriter(out, each, events, step)
    }
  }
  throw new Error(
    `${step}: the children the scene runs keep placing new children`
  )
}

// -- shared state -----------------------------------------------------------
// The owners above a point in the story's view, nearest last: their values as the readers there see them.
type Owners = ReadonlyMap<Component.Definition.Any, unknown>
const noOwners: Owners = new Map()

/** The owners the readers below `component` see: `owners`, and `component` nearest when it's an owner. */
const ownersBelow = (
  given: Owners | undefined,
  owners: Owners,
  component: { readonly definition: Component.Definition.Any },
  model: unknown,
  props: unknown
): Owners => {
  const definition = component.definition
  return definition.shares === undefined
    ? owners
    : new Map(owners).set(
      definition,
      sharedReads.ownerValue(
        definition,
        model,
        props,
        sharedLookup(given, owners)
      )
    )
}

/**
 * What the story's component itself reads: only given values, as nothing is above it. A component that
 * reads its own kind doesn't read itself.
 *
 * @internal
 */
export const rootShared = (given: Owners | undefined): Component.SharedLookup =>
  sharedLookup(given, noOwners)

// A reader's owner has no value in the story: a render that a `shared` step could still fix may miss it.
class MissingShared extends Error {}

/**
 * Renders `story`, letting a missing shared value through: another `shared` step may give it.
 *
 * @internal
 */
export const renderSharing = (story: State<any, any, any, any>): boolean => {
  try {
    story.view()
    return true
  } catch (error) {
    if (!(error instanceof MissingShared)) throw error
    return false
  }
}

/**
 * The values `story` was given, with `entries` set over them.
 *
 * @internal
 */
export const withShared = (
  story: State<any, any, any, any>,
  entries: ReadonlyArray<readonly [Component.Headless.Any, unknown]>,
  step: string
): Owners | undefined => {
  const before = sharedGiven.get(story)
  if (entries.length === 0) return before
  const given = new Map(before)
  for (const [owner, value] of entries) {
    if (owner.definition.shares === undefined) {
      throw new Error(
        `${step}: ${owner.definition.name} shares nothing: it has no shares`
      )
    }
    given.set(owner.definition, value)
  }
  return given
}

/**
 * What `owner` shares with no instance of it in the story: from `init` with no props, if it takes none.
 * It stands above the story, so it reads only the given values.
 */
const sharedDefault = (
  owner: Component.Headless.Any,
  given: Owners | undefined
): unknown => {
  const name = owner.definition.name
  const props = {}
  if (!Schema.is(owner.props)(props)) {
    throw new MissingShared(
      `Scene: the scene reads the shared state of ${name}, whose props aren't all optional, so it has no default. Give it with .shared(${name}, value)`
    )
  }
  return sharedReads.ownerValue(
    owner.definition,
    owner.init(props).model,
    props,
    rootShared(given)
  )
}

/**
 * `h.reads` and `p.reads` in a story: a given value, else the nearest owner above, else `undefined`
 * for an optional read and the default for a required one.
 *
 * @internal
 */
export const sharedLookup =
  (given: Owners | undefined, owners: Owners): Component.SharedLookup =>
  (owner, optional) => {
    const definition = owner.definition
    if (given?.has(definition)) return given.get(definition)
    if (owners.has(definition)) return owners.get(definition)
    return optional === true ? undefined : sharedDefault(owner, given)
  }

/** What the story's component reads of `owner`: a given value, or the default of a required read. */
const sharedBefore = (
  story: State<any, any, any, any>,
  read: sharedReads.Read
): { readonly value: unknown } | undefined => {
  const given = sharedGiven.get(story)
  if (given?.has(read.owner.definition)) {
    return { value: given.get(read.owner.definition) }
  }
  if (read.optional) return undefined
  try {
    return { value: sharedDefault(read.owner, given) }
  } catch (error) {
    if (error instanceof MissingShared) return undefined
    throw error
  }
}

/**
 * The `onChange` messages a new value of `owner` sends: one for each entry of the story's component
 * that reads it with an `onChange`, when the value it read before differs. A first value of an
 * optional owner sends nothing, since the runtime never sees an owner appear.
 *
 * @internal
 */
export const sharedMessages = (
  story: State<any, any, any, any>,
  owner: Component.Headless.Any,
  value: unknown
): ReadonlyArray<unknown> => {
  const messages: Array<unknown> = []
  for (const read of sharedReads.readsOf(story.component.definition)) {
    if (
      read.onChange === undefined || read.owner.definition !== owner.definition
    ) continue
    const before = sharedBefore(story, read)
    if (before !== undefined && !sharedEqual(before.value, value)) {
      messages.push(read.onChange(value))
    }
  }
  return messages
}

/** What an owner's `collects.onChange` last returned in a story. */
interface Collected {
  readonly message: unknown
}
const collectedLast = new WeakMap<object, Collected>()

/**
 * Runs the story's component's `collects.onChange` for `reports`, and sends its message when it differs
 * from the last one, starting from its message for no reports.
 *
 * @internal
 */
export const withReports = (
  story: State<any, any, any, any>,
  reports: ReadonlyArray<unknown>,
  step: string
): State<any, any, any, any> => {
  const definition = story.component.definition
  if (definition.collects === undefined) {
    throw new Error(
      `${step}: ${definition.name} collects no reports: its shares has no collects`
    )
  }
  const onChange = definition.collects.onChange as (
    collected: ReadonlyArray<unknown>
  ) => unknown
  const last = collectedLast.get(story) ?? { message: onChange([]) }
  const message = onChange(reports)
  if (sharedEqual(last.message, message)) return story
  return dispatch(update(story, { collected: { message } }), message)
}

/**
 * What the story's component reports to each owner it reads, by the name `reads` lists it under. An
 * optional owner with no value given is absent, and gets no report.
 *
 * @internal
 */
export const reportsOf = (
  story: State<any, any, any, any>
): { readonly [name: string]: unknown } => {
  const out: { [name: string]: unknown } = {}
  const given = sharedGiven.get(story)
  const own = "/" + story.component.definition.name
  for (const read of sharedReads.readsOf(story.component.definition)) {
    if (
      read.report === undefined ||
      (read.optional && !given?.has(read.owner.definition))
    ) continue
    out[read.name] = read.report(
      story.model,
      story.props,
      (name, key) => View.idOf(own, name, key)
    )
  }
  return out
}

/** A send to an owner the component reads as optional, with no value given for it, is dropped, as with no owner above. */
const delivered = (
  story: State<any, any, any, any>,
  send: Component.Send
): boolean => {
  if (send.owner === undefined) return true
  const definition = send.owner.definition
  if (sharedGiven.get(story)?.has(definition)) return true
  return !sharedReads.readsOf(story.component.definition).some((read) =>
    read.optional && read.owner.definition === definition
  )
}

const expandRoot = <Msg>(
  view: View.Node<Msg, any>,
  name: string,
  given: ReadonlyMap<string, unknown> | undefined,
  filled: Readonly<Record<string, View.Input<never, any>>> | undefined,
  shared: Owners | undefined,
  root: Owners,
  status: ReadonlyMap<string, SlotResult> | undefined,
  slotStatus: SlotResult | undefined,
  author: Pick<Fields<any, any, any, any>, "model" | "props" | "results">,
  run: Run | undefined
): View.Node<Msg, any> => {
  const replaced: Array<View.Child<any, any>> = []
  const placed: Array<Occurrence> = []
  const ran = new Map<string, Ran>()
  // As the runtime does: two children at one path fail the view or the closure that holds them, and the
  // view and the closures it gives its headless children can't place one slot twice between them.
  const written = [checkChildPaths("/" + name, view)]
  // Content is shown under `children`, where a query looks, at the path the runtime gives it.
  // `own`: the story's component wrote it, so its slots count with the component's. Content the story
  // passed for its slots was written by a parent, and so were the closures in it.
  // `reads`: what the feature slots there read, if their services aren't ready. See `Fields.slotStatus`.
  // `writer`: the path of the child the scene runs whose view wrote the node, `undefined` for the
  // story's component.
  const content = (
    input: View.Input<any, any>,
    path: string,
    depth: number,
    own: boolean,
    owners: Owners,
    reads: SlotResult | undefined,
    writer: string | undefined
  ) => {
    const nodes = View.children([input])
    const paths = checkContentPaths(path, nodes)
    if (own) written.push(paths)
    const scope = (label: string) => checkContentPaths(label, nodes)
    return nodes.map((child) =>
      expand(child, path, depth, own, owners, scope, reads, writer)
    )
  }
  const expand = (
    node: View.Node<any, any>,
    path: string,
    depth: number,
    own: boolean,
    owners: Owners,
    scope: (label: string) => ChildPaths,
    reads: SlotResult | undefined,
    writer: string | undefined
  ): View.Node<any, any> => {
    switch (node._tag) {
      case "Text":
        return node
      case "Outlet": {
        // The story's component placing a slot: it shows what the story passed.
        const input = writer === undefined ? filled?.[node.name] : undefined
        if (input === undefined) return node
        return {
          ...node,
          children: content(
            input,
            "/" + name + "/" + slotSegment(node.name),
            1,
            false,
            owners,
            undefined,
            undefined
          )
        } as View.Node<
          any,
          any
        >
      }
      case "Element": {
        let changed = false
        const children = node.children.map((child) => {
          const next = expand(
            child,
            path,
            depth,
            own,
            owners,
            scope,
            reads,
            writer
          )
          if (next !== child) changed = true
          return next
        })
        return changed ? { ...node, children } : node
      }
      case "Child": {
        const component = node.component as unknown as Component.Headless.Any
        const childPath = path + "/" + segment(node)
        if (
          own && typeof node.alive === "function" &&
          !node.alive({
            key: node.key,
            model: author.model,
            props: author.props,
            queries: author.results
          })
        ) return emptyText
        placed.push({ child: node, path: childPath, scope })
        const result = status?.get(childPath) ??
          (reads !== undefined && Feature.isService(node.component)
            ? reads
            : undefined)
        if (result !== undefined) {
          // The slot shows its `fallback`, whose children share the paths of the content that declared it.
          // It renders against settled services, so the feature slots in it show.
          replaced.push(node)
          const shown = node.fallback === undefined
            ? emptyText
            : View.toNode(node.fallback(result))
          return standsFor(
            node,
            true,
            expand(shown, path, depth, own, owners, scope, undefined, writer)
          )
        }
        if (run !== undefined && runs(run, node)) {
          // A child the scene runs shows its own view, against its Model, and the nodes in it are its own.
          const child = node.component as unknown as Component.Any
          if (node.slots !== undefined) {
            throw new Error(
              `Scene: ${childPath} is passed slots, and a scene doesn't run a child with slots`
            )
          }
          if (boundOf(child) !== undefined) {
            throw new Error(
              `Scene: ${childPath} reads queries, and a scene doesn't run a child's queries: test it in a Play`
            )
          }
          replaced.push(node)
          const model = run.models.has(childPath)
            ? run.models.get(childPath)
            : child.init(node.props).model
          const lookup = sharedLookup(shared, owners)
          ran.set(childPath, { child: node, model, writer, shared: lookup })
          const tree = View.toNode(
            child.view(
              model,
              node.props,
              () => false,
              undefined,
              childPath,
              lookup
            )
          )
          checkChildPaths(childPath, tree)
          const inner = expand(
            tree,
            childPath,
            depth + 1,
            false,
            ownersBelow(shared, owners, child, model, node.props),
            (label) => checkChildPaths(label, tree),
            reads,
            childPath
          )
          return standsFor(node, false, inner, childPath)
        }
        if (node.slots !== undefined) {
          // A child's view isn't run, but what the parent passed for its slots is the parent's.
          const shown: Array<View.Node<any, any>> = []
          const lengths: Array<readonly [string, number]> = []
          for (const slot in node.slots) {
            const placed = content(
              node.slots[slot],
              childPath + "/" + slotSegment(slot),
              depth + 1,
              own,
              owners,
              reads,
              writer
            )
            shown.push(...placed)
            lengths.push([slot, placed.length])
          }
          const out = { ...node, children: shown } as View.Node<any, any>
          slotLengths.set(out, lengths)
          return out
        }
        if (node.view === undefined || component.parts === undefined) {
          return node
        }
        replaced.push(node)
        const model = given?.has(childPath)
          ? given.get(childPath)
          : component.init(node.props).model
        const parts = component.parts(model, node.props, {
          owner: { path: childPath, depth: depth + 1 },
          shared: sharedLookup(shared, owners)
        })
        const tree = View.toNode(childOf.expand(parts, node.view))
        const paths = checkChildPaths(childPath, tree)
        if (own) written.push(paths)
        // An owner expanded here is the nearest one for the readers in its closure.
        const inner = expand(
          tree,
          childPath,
          depth + 1,
          own,
          ownersBelow(shared, owners, component, model, node.props),
          (label) => checkChildPaths(label, tree),
          reads,
          writer
        )
        return standsFor(node, false, inner)
      }
    }
  }
  const expanded = expand(
    view,
    "/" + name,
    0,
    true,
    root,
    (label) => checkChildPaths(label, view),
    slotStatus,
    undefined
  )
  checkAuthorPlacements("/" + name, written)
  checkAuthorWrites("/" + name, written)
  if (replaced.length > 0) expandedChildren.set(expanded, replaced)
  if (ran.size > 0) ranIn.set(expanded, ran)
  // A root the expansion left as it was may be a node the component cached and another story shows,
  // and its children are all declared by the view itself, so it keeps nothing.
  if (expanded !== view) occurrences.set(expanded, placed)
  return expanded
}

/**
 * Defers rendering until the view is first read, after the step's keyed
 * prunes settle. This skips intermediate records the runtime wouldn't render.
 * `render` gives the expanded view.
 *
 * @internal
 */
export const record = <Props, Model, Msg, Events>(
  fields: Fields<Props, Model, Msg, Events>,
  render: () => View.Node<Msg, any>
): State<Props, Model, Msg, Events> => {
  let rendered: View.Node<Msg, any> | undefined
  const view = () => rendered ??= render()
  // A view value is a `Locator.Node` tree; a child is a node with no tag or text.
  const root = () => view() as Locator.Node
  const context = () =>
    boundOf(fields.component)?.context(
      fields.model,
      fields.props,
      fields.results
    )
  const declared = () => {
    const keys = new Set<string>()
    const out: Array<Subscription.Subscription<any, any>> = []
    for (
      const sub of fields.component.subscriptions?.(
        fields.model,
        fields.props,
        fields.results
      ) ?? []
    ) {
      // The runtime fails the instance for it, so a test that reads the keys fails too.
      if (keys.has(sub.key)) {
        throw subscriptionKeys.duplicateKey(
          "/" + fields.component.definition.name,
          sub.key
        )
      }
      keys.add(sub.key)
      out.push(sub)
    }
    return out
  }
  const story: State<Props, Model, Msg, Events> = {
    component: fields.component,
    props: fields.props,
    model: fields.model,
    results: fields.results,
    queries: () => context()?.queries ?? {},
    pending: fields.pending,
    emitted: fields.emitted,
    sent: fields.sent,
    interrupted: fields.interrupted,
    loadingMore: fields.loadingMore,
    defaultPrevented: fields.defaultPrevented,
    ack: fields.ack,
    view,
    declared,
    subscriptions: () => declared().map((sub) => sub.key),
    queryInfo: () => {
      const bound = boundOf(fields.component)
      if (bound === undefined) return []
      const current = context()!
      return bound.entries.map((entry) => ({
        name: entry.name,
        query: Query.defOf(entry.query).name,
        args: current.argsOf(entry.name).args
      }))
    },
    get root() {
      return root()
    },
    get: (locator) => Locator.get(root(), locator),
    query: (locator) => Locator.query(root(), locator),
    all: (locator) => Locator.all(root(), locator)
  }
  if (fields.childModels !== undefined) {
    childModels.set(story, fields.childModels)
  }
  if (fields.childStatus !== undefined) {
    childStatuses.set(story, fields.childStatus)
  }
  if (fields.shared !== undefined) sharedGiven.set(story, fields.shared)
  if (fields.collected !== undefined) collectedLast.set(story, fields.collected)
  if (fields.run !== undefined) runOf.set(story, fields.run)
  return story
}

/** @internal */
export const update = <Props, Model, Msg, Events>(
  story: State<Props, Model, Msg, Events>,
  patch: Partial<Fields<Props, Model, Msg, Events>>
): State<Props, Model, Msg, Events> => {
  const fields: Fields<Props, Model, Msg, Events> = {
    component: story.component,
    props: story.props,
    model: story.model,
    results: story.results,
    pending: story.pending,
    emitted: story.emitted,
    sent: story.sent,
    interrupted: story.interrupted,
    loadingMore: story.loadingMore,
    // A step sets it last, once it has settled: an interaction to what it did, any other step to `false`.
    defaultPrevented: story.defaultPrevented,
    ack: story.ack,
    childModels: childModels.get(story),
    childStatus: childStatuses.get(story),
    shared: sharedGiven.get(story),
    collected: collectedLast.get(story),
    run: runOf.get(story),
    ...patch
  }
  // A defect in `view` fails the step that changed the Model, the query results, the props or what's pending.
  // An unchanged view is kept as expanded: expanding it again would rebuild slot content without the
  // owners whose nodes the first expansion replaced.
  const view =
    fields.model === story.model && fields.results === story.results &&
      fields.props === story.props &&
      fields.pending === story.pending &&
      fields.loadingMore === story.loadingMore &&
      fields.childModels === childModels.get(story) &&
      fields.childStatus === childStatuses.get(story) &&
      fields.shared === sharedGiven.get(story) &&
      fields.run === runOf.get(story)
      ? story.view
      : () => expandedView(fields)
  return record(fields, view)
}

/**
 * The story's view: the component's own, with its headless children and slot content expanded.
 *
 * @internal
 */
export const expandedView = (
  fields: Fields<any, any, any, any>
): View.Node<any, any> =>
  expandRoot(
    viewOfFields(fields),
    fields.component.definition.name,
    fields.childModels,
    storySlots.get(fields.component),
    fields.shared,
    ownersBelow(
      fields.shared,
      noOwners,
      fields.component,
      fields.model,
      fields.props
    ),
    fields.childStatus,
    fields.slotStatus,
    fields,
    fields.run
  )

/** The story's component's own view, before its headless children are expanded. */
const viewOfFields = (
  fields: Fields<any, any, any, any>
): View.Node<any, any> =>
  fields.component.view(
    fields.model,
    fields.props,
    fields.running ?? runningOf(fields.pending),
    fields.results,
    undefined,
    rootShared(fields.shared)
  )

const boundOf = componentQueries.boundOf

/** @internal */
export const isKeyed = (
  story: State<any, any, any, any>,
  name: string
): boolean => boundOf(story.component)?.byName.get(name)?.keyed === true

/** The query called `name`, or a throw naming the step. */
const queryOf = (
  story: State<any, any, any, any>,
  step: string,
  name: string
): componentQueries.Entry => {
  const entry = boundOf(story.component)?.byName.get(name)
  if (entry === undefined) {
    throw new Error(
      `${step}: "${name}" is not a query of ${story.component.definition.name}`
    )
  }
  return entry
}

/** A query's args for the story's Model, props and results. */
const argsAt = (story: State<any, any, any, any>, name: string) =>
  boundOf(story.component)!.context(story.model, story.props, story.results)
    .argsOf(name)

/**
 * Writes a query's result, then sends the message of its `onChange`, if any, as the runtime does.
 * A keyed query's `onChange` also gets `changes`.
 */
const writeResult = (
  story: State<any, any, any, any>,
  entry: componentQueries.Entry,
  result: unknown,
  changes: ReadonlyArray<componentQueries.KeyedChange>
): State<any, any, any, any> => {
  const bound = boundOf(story.component)!
  // As in the runtime, the same snapshot writes nothing.
  if (Equal.equals((story.results ?? bound.empty)[entry.name], result)) {
    return story
  }
  const out = update(story, {
    results: { ...(story.results ?? bound.empty), [entry.name]: result }
  })
  const message = bound.context(out.model, out.props, out.results).changed(
    entry.name,
    changes
  )
  return message === undefined ? out : dispatch(out, message.value)
}

/** The result a load step writes, from the query's last Success at its current args. */
type Build = (
  previous: Option.Option<AsyncResult.Success<any, any>>
) => AsyncResult.Success<any, any> | AsyncResult.Failure<any, any>

/** Writes `result` to a single or infinite query's result at its current args. */
const loadStep = (
  story: State<any, any, any, any>,
  step: string,
  name: string,
  build: Build,
  patched: boolean,
  more?: Query.More<any>
): State<any, any, any, any> => {
  const entry = queryOf(story, step, name)
  const current = argsAt(story, name)
  if (current.argsKey === undefined) {
    throw new Error(
      `${step}: the query "${name}" is disabled for the current Model and props`
    )
  }
  const result = build(storedAt(story, name, current.argsKey))
  const def = Query.defOf(entry.query)
  const snapshot = boundOf(story.component)!.snapshot(
    entry,
    { args: current.args, argsKey: current.argsKey },
    result,
    patched,
    more ??
      (def.list !== undefined && result._tag === "Success"
        ? moreOfPages(def, result.value)
        : undefined)
  )
  return writeResult(story, entry, snapshot, [])
}

/** The result's last Success at `argsKey`: its value, or a Failure's previous one. */
const storedAt = (
  story: State<any, any, any, any>,
  name: string,
  argsKey: string
): Option.Option<AsyncResult.Success<any, any>> => {
  const data = Query.snapshotData(story.results?.[name])
  const stored = data?.argsKey === argsKey ? data.result : undefined
  return stored === undefined
    ? Option.none()
    : stored._tag === "Success"
    ? Option.some(stored)
    : stored.previousSuccess
}

/**
 * The results `given` starts from, written with no `onChange` message. Each
 * named query holds its given results at the args it returns, and a keyed
 * query that isn't named keeps the keys it held before that it still returns. Args can
 * read other queries' results, so the writes repeat until none changes: the
 * result doesn't depend on the order of the names or on the results held before.
 *
 * @internal
 */
export const givenResults = (
  story: State<any, any, any, any>,
  given: { readonly [name: string]: unknown },
  step: string
): Component.Results | undefined => {
  for (const name of Object.keys(given)) queryOf(story, step, name)
  const bound = boundOf(story.component)
  if (bound === undefined) return story.results
  const before = story.results ?? bound.empty
  const results: { [name: string]: unknown } = { ...before }
  // The result a query should hold for the current results, or undefined while a named query is
  // disabled or doesn't return the given args.
  const target = (entry: componentQueries.Entry): unknown => {
    const current = bound.context(story.model, story.props, { ...results })
      .argsOf(entry.name)
    if (!Object.hasOwn(given, entry.name)) {
      // From the results held before: a key an earlier round dropped can come back once the args settle.
      const held = Query.snapshotMapData(before[entry.name])?.entries
      return bound.snapshotMany(
        entry,
        current.entries!.flatMap((key) => {
          const stored = held?.get(key.argsKey)
          return stored === undefined ? [] : [stored]
        })
      )
    }
    const def = Query.defOf(entry.query)
    if (entry.keyed) {
      const keys = current.entries!
      const snapshots: Array<unknown> = []
      for (const load of given[entry.name] as ReadonlyArray<KeyedLoad<any>>) {
        const key = keys.find((key) => key.argsKey === def.argsKey(load.args))
        if (key === undefined) return undefined
        const result = "value" in load
          ? AsyncResult.success(load.value, {
            waiting: load.waiting,
            timestamp: 0
          })
          : AsyncResult.failure(Cause.fail(load.error), {
            waiting: load.waiting
          })
        snapshots.push(
          bound.snapshot(entry, key, result as any, false, undefined)
        )
      }
      return bound.snapshotMany(entry, snapshots)
    }
    if (current.argsKey === undefined) return undefined
    const value = given[entry.name]
    return bound.snapshot(
      entry,
      { args: current.args, argsKey: current.argsKey },
      AsyncResult.success(value, { timestamp: 0 }),
      false,
      def.list !== undefined
        ? moreOfPages(def, value as ReadonlyArray<unknown>)
        : undefined
    )
  }
  const written = bound.entries.filter((entry) =>
    entry.keyed || Object.hasOwn(given, entry.name)
  )
  // Each round settles at least one more level of queries whose args read another's result, so a
  // write still due after a round per query never settles.
  for (let round = 0, changed = true; changed; round++) {
    changed = false
    for (const entry of written) {
      const next = target(entry)
      if (next === undefined || Equal.equals(results[entry.name], next)) {
        continue
      }
      if (round > written.length) {
        throw new Error(
          `${step}: the query "${entry.name}" doesn't settle: its args keep changing with the given results`
        )
      }
      results[entry.name] = next
      changed = true
    }
  }
  const unmet = written.find((entry) => target(entry) === undefined)
  if (unmet !== undefined) {
    throw new Error(
      `${step}: the query "${unmet.name}" is disabled, or doesn't return the given args, for the Model and props`
    )
  }
  return results
}

/** Whether a page array has a next page, by the definition's `next`. */
const moreOfPages = (
  def: ReturnType<typeof Query.defOf>,
  pages: ReadonlyArray<unknown>
): Query.More<never> =>
  pages.length > 0 &&
    Option.isSome(def.list!.next(pages[pages.length - 1], pages))
    ? { _tag: "Available" }
    : { _tag: "End" }

const listQuery = (
  story: State<any, any, any, any>,
  step: string,
  name: string
): void => {
  if (boundOf(story.component)?.byName.get(name)?.list !== true) {
    throw new Error(
      `${step}: "${name}" is not an infinite query of ${story.component.definition.name}`
    )
  }
}

/**
 * Settles a query's pending load more with `result`, written at its pages. A live patch makes it throw.
 *
 * @internal
 */
export const settleMore = (
  story: State<any, any, any, any>,
  step: string,
  name: string,
  pagesOf: (pages: ReadonlyArray<unknown>) => ReadonlyArray<unknown>,
  more?: Query.More<any>
): State<any, any, any, any> => {
  listQuery(story, step, name)
  const argsKey = argsAt(story, name).argsKey
  if (argsKey !== undefined) checkUnpatched(story, step, name, argsKey)
  if (!story.loadingMore.includes(name)) {
    throw new Error(`${step}: no load more of "${name}" is pending`)
  }
  return loadStep(
    settlePending(story, name),
    step,
    name,
    (previous) => {
      if (Option.isNone(previous)) {
        throw new Error(`${step}: "${name}" holds no pages at its args`)
      }
      return AsyncResult.success(pagesOf(previous.value.value), {
        timestamp: previous.value.timestamp
      })
    },
    false,
    more
  )
}

/**
 * A `$.loadMore` or `$.reset` from `update`, as the runtime runs it at the query's
 * current args: a load more is pending, and writes `Loading`; a reset writes the
 * first page, waiting, and ends a pending load more.
 */
const applyList = (
  story: State<any, any, any, any>,
  list: Component.ListIssue
): State<any, any, any, any> => {
  const entry = boundOf(story.component)?.byName.get(list.name)
  if (entry === undefined || !entry.list) return story
  const argsKey = argsAt(story, list.name).argsKey
  if (argsKey === undefined) return story
  const previous = storedAt(story, list.name, argsKey)
  const def = Query.defOf(entry.query)
  const data = Query.snapshotData(story.results?.[list.name])
  if (list.op === "loadMore") {
    if (story.loadingMore.includes(list.name)) return story
    // At the end, or with nothing held at these args, nothing is written and nothing waits.
    if (
      Option.isNone(previous) ||
      moreOfPages(def, previous.value.value)._tag === "End"
    ) return story
    const loading = update(story, {
      loadingMore: [...story.loadingMore, list.name]
    })
    if (data?.result?._tag !== "Success") return loading
    return loadStep(
      loading,
      "$.loadMore",
      list.name,
      () => data.result as AsyncResult.Success<any, any>,
      data.patched,
      { _tag: "Loading" }
    )
  }
  const reset = settlePending(story, list.name)
  if (Option.isNone(previous)) return reset
  const first = AsyncResult.success(previous.value.value.slice(0, 1), {
    timestamp: previous.value.timestamp
  })
  return loadStep(
    reset,
    "$.reset",
    list.name,
    // A Failure stays one, over the first page only, while the walk runs.
    () =>
      data?.result?._tag === "Failure"
        ? AsyncResult.failure(data.result.cause, {
          previousSuccess: Option.some(first),
          waiting: true
        })
        : AsyncResult.success(first.value, {
          timestamp: first.timestamp,
          waiting: true
        }),
    false
  )
}

/** Ends an infinite query's pending load more: a settle, Success or Failure, ends the walk it waits on. */
const settlePending = (
  story: State<any, any, any, any>,
  name: string
): State<any, any, any, any> =>
  story.loadingMore.includes(name)
    ? update(story, {
      loadingMore: story.loadingMore.filter((other) => other !== name),
      ack: {
        ...story.ack,
        keptMore: story.ack.keptMore.filter((other) => other !== name)
      }
    })
    : story

/** A `queryMany` query and its unique args, or a throw naming the step. */
const keyedQuery = (
  story: State<any, any, any, any>,
  step: string,
  name: string
): {
  readonly entry: componentQueries.Entry
  readonly keys: ReadonlyArray<componentQueries.Keyed>
} => {
  const entry = boundOf(story.component)?.byName.get(name)
  if (entry === undefined || !entry.keyed) {
    throw new Error(
      `${step}: "${name}" is not a queryMany query of ${story.component.definition.name}`
    )
  }
  return { entry, keys: argsAt(story, name).entries! }
}

/**
 * Writes a keyed query's result as the runtime does: the stored keys the
 * query still returns, with `loads` over them, and `changes` holds
 * `loads`.
 */
const writeKeyed = (
  story: State<any, any, any, any>,
  entry: componentQueries.Entry,
  keys: ReadonlyArray<componentQueries.Keyed>,
  loads: ReadonlyArray<
    {
      readonly argsKey: string
      readonly result: AsyncResult.AsyncResult<any, any>
      readonly patched: boolean
    }
  >
): State<any, any, any, any> => {
  const bound = boundOf(story.component)!
  const held = Query.snapshotMapData(story.results?.[entry.name])?.entries
  const byKey = new Map(loads.map((load) => [load.argsKey, load]))
  const snapshot = bound.snapshotMany(
    entry,
    keys.flatMap((key) => {
      const load = byKey.get(key.argsKey)
      if (load !== undefined) {
        return [
          bound.snapshot(
            entry,
            key,
            load.result as any,
            load.patched,
            undefined
          )
        ]
      }
      const stored = held?.get(key.argsKey)
      return stored === undefined ? [] : [stored]
    })
  )
  const changes = keys.flatMap((key) => {
    const load = byKey.get(key.argsKey)
    return load === undefined ? [] : [{ args: key.args, result: load.result }]
  })
  return writeResult(story, entry, snapshot, changes)
}

/**
 * Loads keys of a keyed query: each args must be one the query currently returns.
 *
 * @internal
 */
export const loadKeyedStep = (
  story: State<any, any, any, any>,
  step: string,
  name: string,
  loads: ReadonlyArray<KeyedLoad<any>>
): State<any, any, any, any> => {
  const { entry, keys } = keyedQuery(story, step, name)
  const def = Query.defOf(entry.query)
  const held = Query.snapshotMapData(story.results?.[name])?.entries
  const settled = new Set<string>()
  const written = writeKeyed(
    story,
    entry,
    keys,
    loads.map((load) => {
      const argsKey = def.argsKey(load.args)
      if (!keys.some((key) => key.argsKey === argsKey)) {
        throw new Error(
          `${step}: the query "${name}" doesn't return the args ${
            def.logKey(load.args, argsKey)
          }`
        )
      }
      const patched = "value" in load && load.patched === true
      if (!patched) checkUnpatched(story, step, name, argsKey)
      if (!patched && load.waiting !== true) settled.add(argsKey)
      return {
        argsKey,
        result: "value" in load
          ? AsyncResult.success(load.value, {
            waiting: load.waiting,
            timestamp: 0
          })
          : AsyncResult.failWithPrevious(load.error, {
            previous: Option.fromUndefinedOr(
              Query.snapshotData(held?.get(argsKey))?.result
            ),
            waiting: load.waiting
          }),
        patched
      }
    })
  )
  // After the result's write: the wait's own message comes second.
  return settleWaits(
    written,
    (awaited) => awaited.name === name && settled.has(def.argsKey(awaited.args))
  )
}

/** How many rounds of prunes one step may write before it throws. */
const pruneRounds = 100

/**
 * After a step: a keyed query whose result holds a key it no longer returns
 * gets the result pruned, with no changes, as the runtime's drain writes it. A
 * prune's `onChange` can change the key set again, so rounds run until none
 * is due, at most one write per query per round. The runtime doesn't bound
 * them; a step throws after `pruneRounds`.
 *
 * @internal
 */
export const pruneKeyed = (
  story: State<any, any, any, any>,
  module: string
): State<any, any, any, any> => {
  const bound = boundOf(story.component)
  if (bound === undefined) return story
  let out = story
  for (let round = 0;; round++) {
    let pruned = false
    for (const entry of bound.entries) {
      if (!entry.keyed) continue
      const held = Query.snapshotMapData(out.results?.[entry.name])
      if (held === undefined || held.entries.size === 0) continue
      const keys = argsAt(out, entry.name).entries!
      const declared = new Set(keys.map((key) => key.argsKey))
      if (Array.from(held.entries.keys()).every((key) => declared.has(key))) {
        continue
      }
      if (round === pruneRounds) {
        throw new Error(
          `${module}: ${story.component.definition.name}'s query "${entry.name}" was still pruned after ${pruneRounds} rounds in one step. Each prune's onChange changes its key set again, and the runtime would prune without limit.`
        )
      }
      out = writeKeyed(out, entry, keys, [])
      pruned = true
    }
    if (!pruned) return out
  }
}

/**
 * `h.isRunning` in a story: derived from what's pending.
 *
 * @internal
 */
const runningOf =
  (pending: ReadonlyArray<Pending<any>>) =>
  (name: string, groupKey: string | undefined): boolean =>
    pending.some((entry) =>
      entry.command.name === name &&
      (groupKey === undefined || entry.command.groupKey === groupKey)
    )

const toEntries = <Msg>(
  pending: ReadonlyArray<Pending<Msg>>
): Array<schedule.Entry<Pending<Msg>>> =>
  pending.map((entry) => ({
    name: entry.command.name,
    key: entry.command.groupKey,
    mode: entry.command.mode,
    status: entry.status,
    value: entry
  }))

/**
 * Applies what `init` or `update` returned: the Model, the Commands through `schedule`, and the events.
 * As in the runtime, a cut run that awaits delivers its message inside this `update`, before the
 * Command that cut it is added. A story runs no fiber, so a cut run has no cleanup: it leaves at once,
 * and a run queued behind it starts.
 *
 * @internal
 */
export const apply = <Props, Model, Msg, Events>(
  story: State<Props, Model, Msg, Events>,
  next: Component.Next<Model, Msg, Events, any>
): State<Props, Model, Msg, Events> => {
  let out = update(story, { model: next.model })
  for (const command of next.commands) {
    const decision = schedule.schedule(toEntries(out.pending), command)
    if (decision.interrupt.length > 0) {
      const gone = new Set(decision.interrupt.map((entry) => entry.value))
      out = update(out, {
        pending: out.pending.filter((entry) => !gone.has(entry)),
        interrupted: [
          ...out.interrupted,
          ...decision.interrupt.flatMap((entry) =>
            entry.value.status === "awaiting" ? [] : [entry.value.command]
          )
        ]
      })
      for (const entry of decision.interrupt) {
        if (entry.value.status === "awaiting") {
          out = dispatch(out, entry.value.message)
        }
      }
    }
    if (command._tag === "Interrupt") continue
    switch (decision.action) {
      case "start":
      case "queue": {
        const entry: Pending<Msg> = {
          command,
          status: decision.action === "start" ? "running" : "queued"
        }
        livePatches.set(entry, registeredPatches(out, command))
        out = update(out, { pending: [...out.pending, entry] })
        if (entry.status === "queued") out = startNext(out, entry)
        break
      }
      case "none":
        break
    }
  }
  out = update(out, { emitted: [...out.emitted, ...next.events] })
  const sends = next.sends?.filter((send) => delivered(out, send)) ?? []
  if (sends.length > 0) out = update(out, { sent: [...out.sent, ...sends] })
  for (const list of next.lists ?? []) out = applyList(out, list)
  return out
}

/** A run that one entry replaces, such as a queued run that starts, keeps its `keepPending` mark. */
const carryKept = <Msg>(
  ack: Ack<Msg>,
  replaced: ReadonlyMap<Pending<Msg>, Pending<Msg>>
): Ack<Msg> =>
  replaced.size === 0 || !ack.kept.some((entry) => replaced.has(entry))
    ? ack
    : { ...ack, kept: ack.kept.map((entry) => replaced.get(entry) ?? entry) }

/** Starts the next queued run of `entry`'s group, once nothing in the group runs. */
const startNext = <Props, Model, Msg, Events>(
  story: State<Props, Model, Msg, Events>,
  entry: Pending<Msg>
): State<Props, Model, Msg, Events> => {
  const next = schedule.next(toEntries(story.pending), toEntries([entry])[0])
    ?.value
  if (next === undefined) return story
  const running: Pending<Msg> = { command: next.command, status: "running" }
  livePatches.set(running, livePatches.get(next) ?? [])
  return update(story, {
    pending: story.pending.map((other) => other === next ? running : other),
    ack: carryKept(story.ack, new Map([[next, running]]))
  })
}

/**
 * A run's fiber exited: with a message it is awaiting, on `awaiting` or behind an earlier message of
 * its queue, and without one it leaves. The next queued run of its group starts either way.
 *
 * @internal
 */
export const exited = <Props, Model, Msg, Events>(
  story: State<Props, Model, Msg, Events>,
  entry: Pending<Msg>,
  held: {
    readonly message: Msg
    readonly awaiting: ReadonlyArray<AwaitedQuery>
  } | undefined
): State<Props, Model, Msg, Events> => {
  const awaiting: Pending<Msg> | undefined = held === undefined
    ? undefined
    : {
      command: entry.command,
      status: "awaiting",
      message: held.message,
      awaiting: held.awaiting
    }
  const pending = story.pending.flatMap((other) =>
    other !== entry ? [other] : awaiting === undefined ? [] : [awaiting]
  )
  const out = startNext(update(story, { pending }), entry)
  return awaiting === undefined ? out : release(out, awaiting)
}

/** Delivers the messages of `entry`'s group that can go now, in the order `schedule.deliverable` gives. */
const release = <Props, Model, Msg, Events>(
  story: State<Props, Model, Msg, Events>,
  entry: Pending<Msg>
): State<Props, Model, Msg, Events> => {
  let out = story
  for (;;) {
    const next = schedule.deliverable(
      toEntries(out.pending),
      toEntries([entry])[0],
      (other) => other.awaiting === undefined || other.awaiting.length === 0
    )
    if (next === undefined) return out
    out = dispatch(
      update(out, {
        pending: out.pending.filter((other) => other !== next.value)
      }),
      next.value.message
    )
  }
}

/**
 * Takes awaited queries off the awaiting runs, delivering what a wait that ends lets go.
 *
 * @internal
 */
export const settleWaits = <Props, Model, Msg, Events>(
  story: State<Props, Model, Msg, Events>,
  settled: (awaited: AwaitedQuery) => boolean
): State<Props, Model, Msg, Events> => {
  let out = story
  for (const entry of story.pending) {
    if (
      entry.awaiting === undefined || !entry.awaiting.some(settled) ||
      !out.pending.includes(entry)
    ) continue
    const rest: Pending<Msg> = {
      ...entry,
      awaiting: entry.awaiting.filter((awaited) => !settled(awaited))
    }
    out = update(out, {
      pending: out.pending.map((other) => other === entry ? rest : other),
      ack: carryKept(out.ack, new Map([[entry, rest]]))
    })
    if (rest.awaiting!.length === 0) out = release(out, rest)
  }
  return out
}

/**
 * A single or infinite query's `loaded` or `loadFailed`: unless `patched`, a live patch makes it throw,
 * and unless `waiting` too, it settles the query's entry for the waits on it, after its write.
 *
 * @internal
 */
export const settleStep = (
  story: State<any, any, any, any>,
  step: string,
  name: string,
  patched: boolean,
  waiting: boolean,
  build: Build
): State<any, any, any, any> => {
  const entry = queryOf(story, step, name)
  const argsKey = argsAt(story, name).argsKey
  if (!patched && argsKey !== undefined) {
    checkUnpatched(story, step, name, argsKey)
  }
  // A settle ends the walk a list's pending load more waits on, unless a walk is still running.
  const loaded = loadStep(
    waiting ? story : settlePending(story, name),
    step,
    name,
    build,
    patched
  )
  return patched || waiting ? loaded : settleWaits(
    loaded,
    (awaited) =>
      awaited.name === name &&
      Query.defOf(entry.query).argsKey(awaited.args) === argsKey
  )
}

/** The component's own queries, each with the entries it is at: one per args it returns now. */
function* currentEntries(
  story: State<any, any, any, any>
): Generator<
  {
    readonly query: componentQueries.Entry
    readonly entries: ReadonlyArray<componentQueries.Keyed>
  }
> {
  const bound = boundOf(story.component)
  if (bound === undefined) return
  const context = bound.context(story.model, story.props, story.results)
  for (const query of bound.entries) {
    const current = context.argsOf(query.name)
    yield {
      query,
      entries: current.entries ??
        (current.argsKey === undefined
          ? []
          : [{ args: current.args, argsKey: current.argsKey }])
    }
  }
}

/**
 * What a `Command.afterRefetch` run resolved with `result` waits for: the component's own queries,
 * at their current args, that its declared targets match, less the entries its `writes` store.
 *
 * @internal
 */
export const awaitedLoaders = (
  story: State<any, any, any, any>,
  command:
    | Command.Issued<any, any, never, "Effect">
    | Command.Issued<any, any, never, "Stream">,
  result: unknown
): ReadonlyArray<AwaitedQuery> => {
  const budget = command.afterRefetch
  if (
    command._tag !== "Effect" || budget === undefined || Duration.isZero(budget)
  ) return []
  if (boundOf(story.component) === undefined) return []
  const written = (command.writes?.(result) ?? []).map((write) => ({
    name: Query.defOf(write.query).name,
    argsKey: Query.defOf(write.query).argsKey(write.args)
  }))
  const out: Array<AwaitedQuery> = []
  for (const { entries, query } of currentEntries(story)) {
    const queryName = Query.defOf(query.query).name
    for (const { args, argsKey } of entries) {
      if (!Query.invalidatesEntry(command, query.query, args)) continue
      if (
        written.some((write) =>
          write.name === queryName && write.argsKey === argsKey
        )
      ) continue
      out.push({ name: query.name, args })
    }
  }
  return out
}

/**
 * Patches registered at issue, by query name and args key. As in the cache, only entries that
 * held a Success then register a patch; cold or failed entries don't delay settling.
 */
const livePatches = new WeakMap<
  Pending<any>,
  ReadonlyArray<{ readonly name: string; readonly argsKey: string }>
>()

/** The component's own queries, at their current args, that `command`'s patches register on. */
const registeredPatches = (
  story: State<any, any, any, any>,
  command:
    | Command.Issued<any, any, never, "Effect">
    | Command.Issued<any, any, never, "Stream">
): ReadonlyArray<{ readonly name: string; readonly argsKey: string }> => {
  if (command.optimistic.length === 0) return []
  const out: Array<{ readonly name: string; readonly argsKey: string }> = []
  for (const { entries, query } of currentEntries(story)) {
    const result = story.results?.[query.name]
    const held = query.keyed
      ? Query.snapshotMapData(result)?.entries
      : undefined
    for (const { args, argsKey } of entries) {
      const data = Query.snapshotData(
        held !== undefined ? held.get(argsKey) : result
      )
      if (data?.argsKey !== argsKey || data.result?._tag !== "Success") continue
      if (
        !Query.invalidatesEntry(
          { invalidates: [], optimistic: command.optimistic },
          query.query,
          args
        )
      ) continue
      out.push({ name: query.name, argsKey })
    }
  }
  return out
}

/**
 * Throws when a running or queued Command's optimistic patch is live on the entry of query `name`
 * at `argsKey`: the runtime settles no fetch there, so only a patched value can be written.
 */
const checkUnpatched = (
  story: State<any, any, any, any>,
  step: string,
  name: string,
  argsKey: string
): void => {
  const patcher = story.pending.find((entry) =>
    entry.status !== "awaiting" &&
    livePatches.get(entry)?.some((patch) =>
        patch.name === name && patch.argsKey === argsKey
      ) === true
  )
  if (patcher !== undefined) {
    throw new Error(
      `${step}: "${name}" is under the optimistic patch of ${
        describe(patcher.command)
      } [${patcher.status}], and no fetch settles under a live patch. Resolve or fail it first, or write the patched value with \`{ patched: true }\`.`
    )
  }
}

/** @internal */
export const describe = (
  command:
    | Command.Issued<any, any, never, "Effect">
    | Command.Issued<any, any, never, "Stream">
): string =>
  `${command.name}(${
    JSON.stringify(MessageLog.encodeArgs(command.argsSchema, command.args))
  })`

/** @internal */
export const describePending = (pending: ReadonlyArray<Pending<any>>): string =>
  pending.length === 0 ?
    "nothing" :
    pending.map((entry) =>
      `${describe(entry.command)} [${entry.status}${
        entry.awaiting === undefined || entry.awaiting.length === 0
          ? ""
          : ` on ${entry.awaiting.map((awaited) => awaited.name).join(", ")}`
      }]`
    ).join(", ")

/** @internal */
export const matches = (target: Target, entry: Pending<any>): boolean => {
  if (Command.isDefinition(target)) {
    return entry.command.name === Command.nameOf(target)
  }
  return entry.command.name === target.name &&
    Equal.equals(entry.command.args, target.args)
}

/** @internal */
export const describeTarget = (target: Target): string =>
  Command.isDefinition(target) ? Command.nameOf(target) : describe(target)

/** @internal */
export const findRunning = (
  story: State<any, any, any, any>,
  target: Target,
  step: string
): Pending<any> => {
  const entry = story.pending.find((entry) =>
    entry.status === "running" && matches(target, entry)
  )
  if (entry === undefined) {
    throw new Error(
      `${step}: no running ${describeTarget(target)}; pending: ${
        describePending(story.pending)
      }`
    )
  }
  return entry
}

/** @internal */
export const dispatch = <Props, Model, Msg, Events>(
  story: State<Props, Model, Msg, Events>,
  message: Msg | Component.Noop | undefined
): State<Props, Model, Msg, Events> =>
  // `undefined` is a handler's "no message", and `Component.noop` a Command's or a mount's.
  message === undefined || isNoop(message)
    ? story
    : apply(
      story,
      story.component.update(
        story.model,
        message,
        story.props,
        story.results,
        sharedReads.record(story.component, rootShared(sharedGiven.get(story)))
      )
    )

/** `node` and its ancestors in `root`, innermost first, or `undefined` when `node` isn't in `root`. */
const pathTo = (
  root: View.Node<any, any>,
  node: Locator.Node
): Array<View.Node<any, any>> | undefined => {
  if (root === node) return [root]
  // An element's children, or the content a story shows under a child or an outlet.
  const children =
    (root as { readonly children?: ReadonlyArray<View.Node<any, any>> })
      .children
  if (children === undefined) return undefined
  for (const child of children) {
    const path = pathTo(child, node)
    if (path !== undefined) {
      path.push(root)
      return path
    }
  }
  return undefined
}

/**
 * The one element `locator` matches in the record's view, or a throw naming the step.
 *
 * @internal
 */
export const findOne = <N extends Locator.Node>(
  story: {
    readonly all: (locator: Locator.Locator) => ReadonlyArray<N>
    readonly root: Locator.Node
  },
  locator: Locator.Locator,
  step: string
): N => {
  const found = story.all(locator)
  if (found.length !== 1) {
    throw new Error(
      `${step}: ${
        found.length === 0
          ? "nothing matches"
          : `${found.length} elements match`
      } ${locator.description}${
        found.length === 0 ? "; " + describeCandidates(story.root) : ""
      }`
    )
  }
  return found[0]!
}

/**
 * The elements of a tree, one per line, for a failure message: what a locator could have matched.
 *
 * @internal
 */
export const describeCandidates = (root: Locator.Node): string => {
  const lines = Locator.elements(root).map((node) => {
    const attrs = Object.entries(node.attrs ?? {}).flatMap(([name, value]) =>
      value === undefined ? [] : [` ${name}=${JSON.stringify(value)}`]
    ).join("")
    const text = Locator.textOf(node).replace(/\s+/g, " ").trim()
    return `<${node.tag}${attrs}>${
      text.length > 40 ? text.slice(0, 40) + "…" : text
    }`
  })
  return lines.length === 0 ?
    "the view has no elements" :
    `elements:\n  ${lines.slice(0, 30).join("\n  ")}${
      lines.length > 30 ? `\n  … and ${lines.length - 30} more` : ""
    }`
}

/**
 * `node` and its ancestors in the record's view, innermost first, or a throw when it isn't there.
 *
 * @internal
 */
export const ancestry = (
  story: State<any, any, any, any>,
  node: Locator.Node
): ReadonlyArray<View.Node<any, any>> => pathTo(story.view(), node) ?? []

/** The innermost element on `path` with any layer for `event`, as on a host. */
const handlerOn = (
  path: ReadonlyArray<View.Node<any, any>>,
  event: string
): View.Element<any, any> | undefined =>
  path.find((node): node is View.Element<any, any> =>
    node._tag === "Element" &&
    (Object.hasOwn(node.handlers, event) ||
      (node.owned ?? []).some((layer) => Object.hasOwn(layer.handlers, event)))
  )

/** What one event did: the record after it, whether its default was cancelled, and whether a layer sent a message. */
export interface Fired<Props, Model, Msg, Events> {
  readonly story: State<Props, Model, Msg, Events>
  readonly prevented: boolean
  readonly handled: boolean
}

/** @internal */
export interface ChildOnly {
  readonly error: string
  readonly prevented: boolean
}

/** @internal */
export const tryFireNode = <Props, Model, Msg, Events>(
  story: State<Props, Model, Msg, Events>,
  node: Locator.Node,
  event: string,
  payload: unknown,
  step: string,
  description: string
): Fired<Props, Model, Msg, Events> | ChildOnly | undefined => {
  const path = ancestry(story, node)
  const handler = handlerOn(path, event)
  if (handler === undefined) return undefined
  // A scene runs its own component's layers: the element's handlers, and in an author's scene the
  // parts' layers it owns, wherever its view applied them. A headless child's layer needs the child's `update`.
  // An element of a child the scene runs is that child's, and its handler sends to the child's `update`.
  const ran = runOwner(path, handler)
  const own = "/" + story.component.definition.name
  const owned = handler.owned ?? []
  const layers = [
    ...(ran === undefined
      ? owned.filter((layer) => layer.owner.path === own)
      : []),
    handler
  ].filter((layer) => Object.hasOwn(layer.handlers, event))
  // `"always"` from any layer cancels, a child's included.
  const always = [...owned, handler].some((layer) =>
    layer.eventOptions[event]?.preventDefault === "always"
  )
  if (layers.length === 0) {
    const owners = owned.filter((layer) => Object.hasOwn(layer.handlers, event))
      .map((layer) => layer.owner.path)
    return {
      error:
        `${step}: only ${
          owners.join(" and ")
        } handles "${event}" at ${description}. ` +
        "A scene doesn't run a child's update: use givenChild for its Model, or a Play.",
      prevented: always
    }
  }
  // Each layer runs once, in the runtime's order: its message decides whether its own
  // `preventDefault: true` cancels, then it's sent.
  let prevented = event === "submit" || always
  let handled = false
  let out = story
  for (const layer of layers) {
    const message = handle(layer.handlers[event]!, payload)
    if (message === undefined) continue
    handled = true
    if (layer.eventOptions[event]?.preventDefault === true) prevented = true
    // Every layer here is the scene's own component's, or the run child's, so each message is theirs.
    out = ran === undefined
      ? dispatch(out, message as Msg)
      : dispatchRun(out, ran, message, step)
  }
  return { story: out, prevented, handled }
}

/**
 * Sends `event` to `node`, bubbling to the innermost element that handles it, and tells whether its default
 * was cancelled and whether a layer sent a message. Every element in a scene is the app's, so a `submit` is
 * always cancelled.
 *
 * @internal
 */
export const fireNode = <Props, Model, Msg, Events>(
  story: State<Props, Model, Msg, Events>,
  node: Locator.Node,
  event: string,
  payload: unknown,
  step: string,
  description: string
): Fired<Props, Model, Msg, Events> => {
  const fired = tryFireNode(story, node, event, payload, step, description)
  if (fired === undefined) {
    throw new Error(`${step}: nothing handles "${event}" at ${description}`)
  }
  if ("error" in fired) throw new Error(fired.error)
  return fired
}

// ---------------------------------------------------------------------------
// the acknowledgement rule
// ---------------------------------------------------------------------------

/**
 * A value as a failure message shows it, encoded as the log encodes it: by `schema` with every
 * `Schema.Redacted` redacted, and a part that fails to encode a placeholder, so a secret never reaches
 * the message.
 */
const show = (schema: Schema.Top | undefined, value: unknown): string =>
  JSON.stringify(
    schema === undefined
      ? MessageLog.structural(value)
      : MessageLog.encodeArgs(schema, value)
  )

const describeEvent = (
  story: State<any, any, any, any>,
  event: unknown
): string => show(story.component.events, event)

const describeSend = (send: Component.Send): string =>
  `${
    show(send.owner.receives, send.message)
  } to the owner ${send.owner.definition.name}`

/** Whether a Command's mode lets a message arrive while it runs: what such a mode is for. */
const exempt = (entry: Pending<any>): boolean =>
  entry.command._tag === "Stream" || entry.command.mode === "switch" ||
  entry.command.mode === "queue"

const settleHint = (entry: Pending<any>): string =>
  entry.status === "awaiting"
    ? `end its wait with loaded or loadFailed on ${
      (entry.awaiting ?? []).map((awaited) => `"${awaited.name}"`).join(", ")
    }, or waitExpired`
    : entry.command._tag === "Stream"
    ? "settle it with next, end or fail"
    : "settle it with resolve or fail"

/**
 * The entries of the component's enabled queries that hold no result at their current args: what
 * `h.queries` opens as `Initial`, waiting.
 *
 * @internal
 */
export const unloaded = (
  story: State<any, any, any, any>
): ReadonlyArray<
  { readonly name: string; readonly argsKey: string; readonly label: string }
> => {
  const out: Array<
    { readonly name: string; readonly argsKey: string; readonly label: string }
  > = []
  for (const { entries, query } of currentEntries(story)) {
    const result = story.results?.[query.name]
    const held = query.keyed
      ? Query.snapshotMapData(result)?.entries
      : undefined
    const def = Query.defOf(query.query)
    for (const { args, argsKey } of entries) {
      const data = Query.snapshotData(query.keyed ? held?.get(argsKey) : result)
      if (data?.argsKey === argsKey && data.result !== undefined) continue
      out.push({
        name: query.name,
        argsKey,
        label: query.keyed ? ` at ${def.logKey(args, argsKey)}` : ""
      })
    }
  }
  return out
}

/**
 * A mount as a failure message shows it: its name, and its args encoded by their Schema, as the log
 * would, a redacted value included.
 *
 * @internal
 */
export const describeMount = (mount: View.Mount<any>): string =>
  `${mount.name}(${
    JSON.stringify(MessageLog.encodeArgs(mount.argsSchema, mount.args))
  })`

/** Mounts that started and that nothing acknowledged. */
const unacknowledgedMounts = (
  story: State<any, any, any, any>
): Array<string> =>
  story.ack.mounts.flatMap((live) =>
    live.acknowledged
      ? []
      : [
        `the mount ${
          describeMount(live.mount)
        } on <${live.element.tag}> started: end it with mounted, or acknowledge it running with expectMount`
      ]
  )

/** Whether a `keepPending` step marked the query entry. */
const isKept = (
  story: State<any, any, any, any>,
  entry: { readonly name: string; readonly argsKey: string }
): boolean =>
  story.ack.keptQueries.some((kept) =>
    kept.name === entry.name && kept.argsKey === entry.argsKey
  )

/** Enabled queries with no result that no `keepPending` marked. */
const missingQueries = (story: State<any, any, any, any>): Array<string> =>
  unloaded(story).flatMap((entry) =>
    isKept(story, entry)
      ? []
      : [
        `the query "${entry.name}" has no result${entry.label}: load it with loaded or loadFailed, or keep it with keepPending("${entry.name}")`
      ]
  )

/** Work in flight that blocks a message step: what nothing settled, kept or exempts. */
const inFlight = (story: State<any, any, any, any>): Array<string> => [
  ...story.pending.flatMap((entry) =>
    exempt(entry) || story.ack.kept.includes(entry)
      ? []
      : [
        `${describe(entry.command)} [${entry.status}] is pending: ${
          settleHint(entry)
        }, or keep it with keepPending`
      ]
  ),
  ...story.loadingMore.flatMap((name) =>
    story.ack.keptMore.includes(name)
      ? []
      : [
        `a load more of "${name}" is pending: settle it with loadedMore or loadMoreFailed, or keep it with keepPending("${name}")`
      ]
  ),
  ...missingQueries(story),
  ...unacknowledgedMounts(story)
]

/** Every pending Command and load more, kept or exempt included: what the end of a test and `given` can't leave. */
const allPending = (story: State<any, any, any, any>): Array<string> => [
  ...story.pending.map((entry) =>
    `${describe(entry.command)} [${entry.status}] is pending: ${
      settleHint(entry)
    }`
  ),
  ...story.loadingMore.map((name) =>
    `a load more of "${name}" is pending: settle it with loadedMore or loadMoreFailed`
  )
]

/** Outputs no step acknowledged yet. */
const outputs = (story: State<any, any, any, any>): Array<string> => [
  ...story.emitted.map((event) =>
    `${describeEvent(story, event)} was emitted: acknowledge it with emitted`
  ),
  ...story.sent.map((send) =>
    `${describeSend(send)} was sent: acknowledge it with sent`
  ),
  ...(story.ack.ignored
    ? [
      "the last interaction produced no message: acknowledge it with expectIgnored"
    ]
    : [])
]

const report = (
  step: string,
  what: string,
  problems: ReadonlyArray<string>
): void => {
  if (problems.length > 0) {
    throw new Error(`${step}: ${what}:\n  - ${problems.join("\n  - ")}`)
  }
}

/**
 * The checks before a step. A message step throws on work in flight and on outputs nothing acknowledged;
 * any other acting step on the outputs only.
 *
 * @internal
 */
export const checkBefore = (
  story: State<any, any, any, any>,
  step: string,
  kind: "message" | "acting"
): void =>
  report(
    step,
    "earlier work isn't settled or acknowledged",
    kind === "message"
      ? [...inFlight(story), ...outputs(story)]
      : outputs(story)
  )

/**
 * The check at the end of `make`: nothing pending, kept or exempt included, no load more, no query with no
 * result unless it was kept, and no output left unacknowledged.
 *
 * @internal
 */
export const checkEnd = (
  story: State<any, any, any, any>,
  step: string
): void =>
  report(step, "the test ends with work not settled or acknowledged", [
    ...allPending(story),
    ...missingQueries(story),
    ...unacknowledgedMounts(story),
    ...outputs(story)
  ])

/**
 * `given` after an acting step: it throws rather than discard what's pending or unacknowledged, a query
 * with no result included.
 *
 * @internal
 */
export const checkGiven = (
  story: State<any, any, any, any>,
  step: string
): void =>
  report(step, "given would discard work not settled or acknowledged", [
    ...allPending(story),
    ...unacknowledgedMounts(story),
    ...outputs(story)
  ])

/**
 * `given` after an acting step, once it made `after`: it throws when an entry of an enabled query that
 * had no result, kept or not, is gone without one, as when the given Model or props disable the query or
 * move its args. An entry still waiting, or one `given` loaded, isn't discarded.
 *
 * @internal
 */
export const checkGivenQueries = (
  before: State<any, any, any, any>,
  after: State<any, any, any, any>,
  step: string
): void => {
  // An entry `after` still has is waiting or holds the result `given` loaded.
  const current = new Set(
    Array.from(currentEntries(after)).flatMap(({ entries, query }) =>
      entries.map(({ argsKey }) => query.name + "\u0000" + argsKey)
    )
  )
  report(
    step,
    "given would discard work not settled or acknowledged",
    unloaded(before).flatMap(({ argsKey, label, name }) =>
      current.has(name + "\u0000" + argsKey)
        ? []
        : [
          `the query "${name}" has no result${label}, and given would drop it: load it with loaded or loadFailed first, or give its result to given`
        ]
    )
  )
}

/**
 * Marks what `target` names so it stops blocking message steps: every pending Command it matches, or a
 * query's entries with no result, or its pending load more. Throws when nothing pending matches.
 *
 * @internal
 */
export const keep = <Props, Model, Msg, Events>(
  story: State<Props, Model, Msg, Events>,
  target: Target | string,
  step: string
): State<Props, Model, Msg, Events> => {
  if (typeof target === "string") {
    queryOf(story, step, target)
    const more = story.loadingMore.includes(target) &&
      !story.ack.keptMore.includes(target)
    const missing = unloaded(story).filter((entry) =>
      entry.name === target && !isKept(story, entry)
    )
    if (!more && missing.length === 0) {
      throw new Error(
        `${step}: the query "${target}" has a result at its args and no load more pending`
      )
    }
    return update(story, {
      ack: {
        ...story.ack,
        keptMore: more ? [...story.ack.keptMore, target] : story.ack.keptMore,
        keptQueries: [
          ...story.ack.keptQueries,
          ...missing.map(({ argsKey, name }) => ({ name, argsKey }))
        ]
      }
    })
  }
  const matched = story.pending.filter((entry) => matches(target, entry))
  if (matched.length === 0) {
    throw new Error(
      `${step}: no ${describeTarget(target)} is pending; pending: ${
        describePending(story.pending)
      }`
    )
  }
  return update(story, {
    ack: {
      ...story.ack,
      kept: [
        ...story.ack.kept,
        ...matched.filter((entry) => !story.ack.kept.includes(entry))
      ]
    }
  })
}

/**
 * Acknowledges the oldest unacknowledged events, after checking they are `events`, in order, compared
 * with the component's `events` Schema.
 *
 * @internal
 */
export const acknowledgeEmitted = <Props, Model, Msg, Events>(
  story: State<Props, Model, Msg, Events>,
  events: ReadonlyArray<unknown>,
  step: string
): State<Props, Model, Msg, Events> => {
  const same = Schema.toEquivalence(
    story.component.events as Schema.Codec<unknown, unknown>
  )
  const oldest = story.emitted.slice(0, events.length)
  if (
    events.length === 0 || oldest.length < events.length ||
    !oldest.every((event, i) => same(event, events[i]))
  ) {
    throw new Error(
      `${step}: expected ${
        events.length === 0
          ? "at least one event"
          : events.map((event) => describeEvent(story, event)).join(", ")
      }; unacknowledged: ${
        story.emitted.length === 0
          ? "nothing"
          : story.emitted.map((event) => describeEvent(story, event)).join(", ")
      }`
    )
  }
  return update(story, { emitted: story.emitted.slice(events.length) })
}

/**
 * Acknowledges the oldest unacknowledged send, after checking it went to `owner` with `message`, compared
 * with the owner's `receives` Schema.
 *
 * @internal
 */
export const acknowledgeSent = <Props, Model, Msg, Events>(
  story: State<Props, Model, Msg, Events>,
  owner: Component.Headless.Any,
  message: unknown,
  step: string
): State<Props, Model, Msg, Events> => {
  const oldest = story.sent[0]
  const receives: Schema.Codec<unknown, unknown> = owner.receives
  const matched = oldest !== undefined &&
    oldest.owner.definition === owner.definition &&
    Schema.toEquivalence(receives)(oldest.message, message)
  if (!matched) {
    throw new Error(
      `${step}: expected ${describeSend({ owner, message })}; unacknowledged: ${
        story.sent.length === 0
          ? "nothing"
          : story.sent.map(describeSend).join(", ")
      }`
    )
  }
  return update(story, { sent: story.sent.slice(1) })
}

// Pending Commands are stored with their Source erased; `findRunning` matched `target`, so
// `result` is the Source of this entry's Command.
/** @internal */
export const resolveWith = (entry: Pending<any>, result: unknown): any =>
  (entry.command.resolve as (result: unknown) => unknown)(result)

/** @internal */
export const findStream = (
  story: State<any, any, any, any>,
  target: StreamTarget,
  step: string
): Pending<any> => {
  const entry = findRunning(story, target, step)
  if (entry.command._tag !== "Stream") {
    throw new Error(
      `${step}: ${describe(entry.command)} is not a stream Command`
    )
  }
  return entry
}

/** @internal */
export const rootParts = <Props, Parts>(
  component: Pick<
    Component.Headless<Props, any, Parts, any, any>,
    "definition" | "parts"
  >,
  model: unknown,
  props: Props,
  lookup: object
): Parts => {
  const shared = sharedGiven.get(lookup)
  const given = childModels.get(lookup)
  const resolve = (
    value: unknown,
    owner: View.Owner,
    owners: Owners
  ): readonly [unknown, View.Owner, Owners] => {
    while (childOf.isComposed(value)) {
      const child = value.child
      const owned = child.component as unknown as Component.Headless.Any
      const at: View.Owner = {
        path: owner.path + "/" + segment(child),
        depth: owner.depth + 1
      }
      const ownedModel = given?.has(at.path)
        ? given.get(at.path)
        : owned.init(child.props).model
      const [parts, inner, below] = resolve(
        owned.parts(ownedModel, child.props, {
          owner: at,
          shared: sharedLookup(shared, owners)
        }),
        at,
        ownersBelow(shared, owners, owned, ownedModel, child.props)
      )
      value = value.parts(parts)
      owner = inner
      owners = below
    }
    return [value, owner, owners]
  }
  const owner: View.Owner = { path: "/" + component.definition.name, depth: 0 }
  return resolve(
    component.parts(model, props, { owner, shared: rootShared(shared) }),
    owner,
    ownersBelow(shared, noOwners, component, model, props)
  )[0] as Parts
}

/**
 * A headless component with `view` as its consumer, as a component a story
 * can run. `view` has no messages of its own, so every handler that runs is
 * a layer of the component's parts: `fireNode` runs the layers whose owner is
 * the story's component, wherever the view applied them.
 *
 * @internal
 */
export const withView = (
  component: Component.Headless.Any,
  view: (parts: any, h: any) => View.Content<any, any>,
  elements: View.Vocabulary<any> | undefined
): Component.Component<any, any, any, any, any, any, any, any, any> => {
  const owner: View.Owner = { path: "/" + component.definition.name, depth: 0 }
  return Object.assign(Object.create(component), {
    view: (
      model: unknown,
      props: unknown,
      running?: View.Running,
      queries?: Component.Results,
      _path?: string,
      shared?: Component.SharedLookup
    ) => {
      const h = View.makeHelper(
        props,
        elements ?? component.elements,
        running,
        owner.path
      )
      return View.toNode(
        childOf.expand(
          component.parts(model, props, { owner, running, queries, shared }),
          (parts) => view(parts, h)
        )
      )
    }
  })
}

/**
 * A component whose story passed `slots`: the content shows where its view places each slot.
 *
 * @internal
 */
export const withSlots = (
  component: Component.Any,
  slots: (h: any) => Readonly<Record<string, View.Input<never, any>>>,
  elements: View.Vocabulary<any> | undefined
): Component.Any => {
  const made = Object.create(component)
  storySlots.set(
    made,
    slots(
      View.makeHelper(
        {},
        elements ?? component.elements,
        undefined,
        "/" + component.definition.name
      )
    )
  )
  return made
}

/**
 * The children declared in a view, with the ones an expansion replaced.
 *
 * @internal
 */
export const children = <Msg>(
  view: View.Node<Msg, any>,
  component?: Component.Any | { readonly key: string }
): ReadonlyArray<View.Child<Msg, any>> =>
  [...(expandedChildren.get(view) ?? []), ...shownNodes(view)].filter((
    node
  ): node is View.Child<Msg, any> =>
    node._tag === "Child" &&
    (component === undefined || node.component === component)
  )

/**
 * `node` and the nodes below it, as a story shows them: the content it expanded under a child or an
 * outlet, or, in a view it didn't expand, what a child's slots were passed.
 */
const shownNodes = function*(
  node: View.Node<any, any>
): Generator<View.Node<any, any>> {
  yield node
  const shown =
    (node as { readonly children?: ReadonlyArray<View.Node<any, any>> })
      .children
  if (shown !== undefined) {
    for (const child of shown) yield* shownNodes(child)
  } else if (node._tag === "Child") {
    for (const child of View.slotNodes(node)) yield* shownNodes(child)
  }
}

/**
 * Whether `child` was declared from `component`: the component itself, a provided copy of it, the lazy
 * component or the feature service.
 */
const isChildOf = (child: View.Child<any, any>, component: object): boolean => {
  if (child.component === component) return true
  const definition =
    (child.component as { readonly definition?: unknown }).definition
  return definition !== undefined &&
    definition === (component as { readonly definition?: unknown }).definition
}

/**
 * The one child of `component` with `key`: a string matches a child rendered with that key, and no key a
 * child rendered without one.
 *
 * @internal
 */
export const findChild = (
  view: View.Node<any, any>,
  component:
    | Component.Any
    | Component.Headless.Any
    | Component.Lazy.Any
    | Feature.Any,
  key: string | undefined,
  step: string
): Occurrence => {
  const all = occurrences.get(view) ??
    children(view).map((child): Occurrence => ({
      child,
      path: undefined,
      scope: undefined
    }))
  const found = all.filter(({ child }) =>
    isChildOf(child, component) && child.key === (key ?? "")
  )
  if (found.length === 1) return found[0]!
  const name = childName(component as Component.Any)
  const which = key === undefined ? "without a key" : `with key "${key}"`
  if (found.length === 0) {
    throw new Error(
      `${step}: no child ${name} ${which}; children: ${
        all.map(({ child }) => segment(child)).join(", ")
      }`
    )
  }
  const owners = found.flatMap(({ child }) =>
    child.owner === undefined ? [] : [child.owner.path]
  )
  throw new Error(
    owners.length === 0
      ? `${step}: ${found.length} children ${name} ${which}: give each one its own key`
      : `${step}: ${found.length} children ${name} ${which}, declared with p.child by ${
        owners.join(" and ")
      }. A scene can't choose between the children that one component owns in several places`
  )
}
