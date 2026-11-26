/**
 * The cursor behind `Scene` and `HtmlScene`: the shared steps, plus the
 * steps that drive the rendered view and assert on it.
 *
 * @internal
 */
import { dev } from "#dev"
import type * as Cause from "effect/Cause"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import type * as Component from "../Component.ts"
import type * as Feature from "../Feature.ts"
import * as Mount from "../Mount.ts"
import * as Locator from "../testing/Locator.ts"
import type * as View from "../View.ts"
import * as match from "./match.ts"
import { noop } from "./noop.ts"
import type { SlotResult } from "./slotStatus.ts"
import { Cursor } from "./steps.ts"
import * as cursor from "./steps.ts"
import * as engine from "./story.ts"

const findDeclared = (
  state: engine.State<any, any, any, any>,
  child: ChildTarget,
  key: string | undefined,
  step: string
): engine.Occurrence => {
  const found = engine.findChild(state.view(), child, key, step)
  const owner = found.child.owner
  if (
    owner !== undefined && owner.path !== "/" + state.component.definition.name
  ) {
    throw new Error(
      `${step}: ${
        engine.pathOf(state, found)
      } is declared with p.child by ${owner.path}, whose update takes its events. ` +
        "A scene doesn't run a child's update: write a scene of that component, or a TestHost test."
    )
  }
  return found
}

/**
 * A check on the elements a locator matched. It returns what it found when the check fails, or
 * `undefined` when it passes. `root` is the whole tree, for checks such as an accessible name that read
 * outside the element.
 *
 * @internal
 */
export type Matcher = (
  nodes: ReadonlyArray<Locator.Node>,
  root: Locator.Node
) => string | undefined

/**
 * One element, for the matchers that check a single one.
 *
 * @internal
 */
export const single = (
  check: (node: Locator.Node, root: Locator.Node) => string | undefined
): Matcher =>
(nodes, root) =>
  nodes.length === 1
    ? check(nodes[0]!, root)
    : `${nodes.length} elements match`

const matches = (value: string, expected: string | RegExp): boolean =>
  typeof expected === "string"
    ? value === expected
    : new RegExp(expected).test(value)

const compare = (
  value: string | undefined,
  expected: string | RegExp | false | undefined,
  name: string,
  kind: string
): string | undefined => {
  const pass = expected === false
    ? value === undefined
    : value !== undefined &&
      (expected === undefined || matches(value, expected))
  if (pass) return undefined
  const what = JSON.stringify(name) + " " + kind
  return value === undefined
    ? `it has no ${what}`
    : `its ${what} is ${JSON.stringify(value)}`
}

/** @internal */
export type Expected = { readonly [name: string]: string | RegExp | false }

const own = (values: Locator.Node["attrs"], name: string) =>
  values !== undefined && Object.hasOwn(values, name) ? values[name] : undefined

/**
 * `key` normalizes expected names for both lookup and failure messages.
 *
 * @internal
 */
export const record = (
  expected: Expected,
  kind: string,
  read: (node: Locator.Node) => Locator.Node["attrs"],
  key: (name: string) => string = (name) => name
): Matcher =>
  single((node) => {
    const values = read(node)
    const failures: Array<string> = []
    for (const [name, value] of Object.entries(expected)) {
      const at = key(name)
      const failure = value === undefined
        ? `${JSON.stringify(at)} is undefined, use false for an absent ${kind}`
        : compare(own(values, at), value, at, kind)
      if (failure !== undefined) failures.push(failure)
    }
    return failures.length === 0 ? undefined : failures.join(", ")
  })

/**
 * The matchers every scene's `expect` has, each made from the arguments the test gave it.
 *
 * @internal
 */
export const matchers = {
  toExist: (): Matcher => (nodes) =>
    nodes.length === 0 ? "nothing matches" : undefined,
  toBeAbsent: (): Matcher => (nodes) =>
    nodes.length === 0 ? undefined : `${nodes.length} elements match`,
  toHaveCount: (count: number): Matcher => (nodes) =>
    nodes.length === count ? undefined : `${nodes.length} elements match`,
  toHaveText: (expected: string | RegExp): Matcher =>
    single((node) => {
      const text = Locator.textOf(node).replace(/\s+/g, " ").trim()
      return matches(text, expected)
        ? undefined
        : `its text is ${JSON.stringify(text)}`
    }),
  toHaveAttribute: (
    name: string,
    expected?: string | RegExp | false
  ): Matcher =>
    single(({ attrs }) =>
      compare(own(attrs, name), expected, name, "attribute")
    ),
  toHaveAttributes: (expected: Expected): Matcher =>
    record(expected, "attribute", ({ attrs }) => attrs)
}

const describeExpected = (expected: unknown): string =>
  expected instanceof RegExp
    ? String(expected)
    : typeof expected === "object" && expected !== null
    ? `{${
      Object.entries(expected).map(([name, value]) =>
        JSON.stringify(name) + ": " + describeExpected(value)
      ).join(", ")
    }}`
    : JSON.stringify(expected)

/** @internal */
export const makeExpectation = <A>(
  step: string,
  locator: Locator.Locator,
  matchers: { readonly [name: string]: (...args: Array<any>) => Matcher },
  run: (
    check: (
      nodes: ReadonlyArray<Locator.Node>,
      root: Locator.Node,
      listed?: Locator.Node
    ) => void,
    method: Function
  ) => A
): object => {
  const out: { [name: string]: (...args: Array<any>) => A } = {}
  for (const [name, make] of Object.entries(matchers)) {
    const method = (...args: Array<any>): A =>
      run((nodes, root, listed = root) => {
        const failure = make(...args)(nodes, root)
        if (failure !== undefined) {
          throw new Error(
            `${step}(${locator.description}).${name}(${
              args.map(describeExpected).join(", ")
            }): ${failure}; ${engine.describeCandidates(listed)}`
          )
        }
      }, method)
    out[name] = method
  }
  return out
}

/** A child a scene step names. */
type ChildTarget =
  | Component.Any
  | Component.Headless.Any
  | Component.Lazy.Any
  | Feature.Any

/** `state` with the slot of `found` recorded as `result`: the view shows its `fallback` of it. */
const withSlot = (
  state: engine.State<any, any, any, any>,
  found: engine.Occurrence,
  result: SlotResult
): engine.State<any, any, any, any> => {
  const statuses = new Map(engine.childStatuses.get(state))
  statuses.set(engine.pathOf(state, found), result)
  return engine.update(state, { childStatus: statuses })
}

/** The arguments after a child step's component: an optional key, then the step's value. */
type KeyAnd<A> = readonly [value: A] | readonly [key: string, value: A]

const keyAnd = <A>(
  args: KeyAnd<A>
): readonly [key: string | undefined, value: A] =>
  args.length === 1 ? [undefined, args[0]] : args

// ---------------------------------------------------------------------------
// mounts
// ---------------------------------------------------------------------------

/** A node as its siblings match it: an expanded headless child by the outermost child it was. */
const asSibling = (node: View.Node<any, any>): View.Node<any, any> =>
  engine.expansionOf.get(node)?.[0]?.child ?? node

/**
 * Whether `node` patches `old` once matched, as the runtime decides. A child that
 * switches from its view to its fallback is new: the runtime creates the fallback.
 */
const continues = (
  old: View.Node<any, any>,
  node: View.Node<any, any>
): boolean => {
  const olds = engine.expansionOf.get(old) ?? []
  const news = engine.expansionOf.get(node) ?? []
  return olds.length === news.length &&
    news.every((each, index) =>
      each.fallback === olds[index]!.fallback &&
      match.patches(olds[index]!.child, each.child)
    ) &&
    match.patches(old, node)
}

const childrenOf = (
  node: View.Node<any, any>
): ReadonlyArray<View.Node<any, any>> =>
  (node as { readonly children?: ReadonlyArray<View.Node<any, any>> })
    .children ?? []

/** A slotted child's `children` by slot, else the one list. */
const groups = (
  node: View.Node<any, any>
): Map<string, ReadonlyArray<View.Node<any, any>>> => {
  const children = childrenOf(node)
  const lengths = engine.slotLengths.get(node)
  if (lengths === undefined) return new Map([["", children]])
  const out = new Map<string, ReadonlyArray<View.Node<any, any>>>()
  let at = 0
  for (const [name, length] of lengths) {
    out.set(name, children.slice(at, at + length))
    at += length
  }
  return out
}

const nodePath = (
  root: View.Node<any, any>,
  target: View.Node<any, any>
): ReadonlyArray<readonly [slot: string, index: number]> | undefined => {
  if (root === target) return []
  for (const [name, list] of groups(root)) {
    for (let index = 0; index < list.length; index++) {
      const rest = nodePath(list[index]!, target)
      if (rest !== undefined) return [[name, index], ...rest]
    }
  }
  return undefined
}

/** @internal */
export const followNode = (
  oldRoot: View.Node<any, any>,
  node: View.Node<any, any>,
  newRoot: View.Node<any, any>
): View.Node<any, any> | undefined => {
  if (oldRoot === newRoot) return node
  const path = nodePath(oldRoot, node)
  if (path === undefined || !continues(oldRoot, newRoot)) return undefined
  let oldAt = oldRoot
  let newAt = newRoot
  for (const [slot, oldIndex] of path) {
    const olds = groups(oldAt).get(slot) ?? []
    const news = groups(newAt).get(slot) ?? []
    const paired = match.matchSiblings(
      olds.map(asSibling),
      news.map(asSibling)
    )
    const newIndex = paired.indexOf(oldIndex)
    if (newIndex < 0) return undefined
    const oldChild = olds[oldIndex]!
    const newChild = news[newIndex]!
    if (!continues(oldChild, newChild)) return undefined
    oldAt = oldChild
    newAt = newChild
  }
  return newAt
}

/**
 * The scene's mounts in `tree`, each followed from the render before as the runtime keeps a mount
 * running: on an element the runtime patched, an element's own mount for the same definition, and a
 * part's for the same owner and definition. Any other is new, and in flight until a step acknowledges
 * it. Only the component's own mounts count: its elements', those in content it passed to a child's
 * slots, and those of the parts it owns.
 */
const followMounts = (
  state: engine.State<any, any, any, any>,
  tree: View.Node<any, any>
): {
  readonly mounts: ReadonlyArray<engine.LiveMount>
  readonly removed: ReadonlyArray<engine.LiveMount>
} => {
  const own = "/" + state.component.definition.name
  const before = new Map<View.Element<any, any>, Array<engine.LiveMount>>()
  for (const live of state.ack.mounts) {
    const list = before.get(live.element)
    if (list === undefined) before.set(live.element, [live])
    else list.push(live)
  }
  const mounts: Array<engine.LiveMount> = []
  const continued = new Set<engine.LiveMount>()
  const follow = (
    mount: View.Mount<any>,
    owner: string | undefined,
    element: View.Element<any, any>,
    old: ReadonlyArray<engine.LiveMount>
  ) => {
    const kept = old.find((live) =>
      live.owner === owner && live.mount.name === mount.name
    )
    if (kept !== undefined) continued.add(kept)
    mounts.push(
      kept === undefined ?
        { mount, owner, element, acknowledged: false, ended: false } :
        { ...kept, mount, element }
    )
  }
  // `ran`: the path of the child the scene runs whose view holds the node. Its elements' mounts are its own.
  const walk = (
    old: View.Node<any, any> | undefined,
    node: View.Node<any, any>,
    authored: boolean,
    outer: string | undefined
  ): void => {
    const ran = engine.runPathOf(node) ?? outer
    if (node._tag === "Element") {
      const olds = old === undefined
        ? []
        : before.get(old as View.Element<any, any>) ?? []
      if ((authored || ran !== undefined) && node.mount !== undefined) {
        follow(node.mount, ran, node, olds)
      }
      for (const layer of node.owned ?? []) {
        if (layer.mount !== undefined && layer.owner.path === own) {
          follow(layer.mount, own, node, olds)
        }
      }
    }
    // A slotted child and an outlet show their content under `children`: an outlet's is a parent's.
    const below = authored && node._tag !== "Outlet"
    if (old === undefined) {
      // Nothing to match against: every mount below is new.
      for (const child of childrenOf(node)) walk(undefined, child, below, ran)
      return
    }
    const oldGroups = groups(old)
    for (const [name, news] of groups(node)) {
      const olds: ReadonlyArray<View.Node<any, any>> = oldGroups.get(name) ?? []
      const paired = match.matchSiblings(
        olds.map(asSibling),
        news.map(asSibling)
      )
      news.forEach((child, index) => {
        const was = paired[index]! < 0 ? undefined : olds[paired[index]!]
        walk(
          was !== undefined && continues(was, child) ? was : undefined,
          child,
          below,
          ran
        )
      })
    }
  }
  // With no mount to follow, every mount in `tree` is new.
  const root = state.ack.mounts.length === 0 ? undefined : state.ack.tree
  walk(
    root !== undefined && continues(root, tree) ? root : undefined,
    tree,
    true,
    undefined
  )
  return {
    mounts,
    removed: state.ack.mounts.filter((live) => !continued.has(live))
  }
}

/**
 * Records the scene's mounts in its view after a step. Throws when the step removed a mount nothing
 * acknowledged: a test that never named it couldn't know it was there.
 */
const trackMounts = (
  state: engine.State<any, any, any, any>,
  step: string
): engine.State<any, any, any, any> => {
  const tree = state.view()
  if (tree === state.ack.tree) return state
  const { mounts, removed } = followMounts(state, tree)
  const lost = removed.filter((live) => !live.acknowledged)
  if (lost.length > 0) {
    throw new Error(
      `${step}: the step removed a mount nothing acknowledged:\n  - ${
        lost.map((live) =>
          `${
            engine.describeMount(live.mount)
          } on <${live.element.tag}>: end it with mounted, or acknowledge it running with expectMount, before the step that removes it`
        ).join("\n  - ")
      }`
    )
  }
  return engine.update(state, { ack: { ...state.ack, mounts, tree } })
}

/** The one mount of the scene matching `target`. Throws when none or several do, listing them. */
const findMount = (
  state: engine.State<any, any, any, any>,
  target: Mount.Definition.Any | Mount.Any,
  step: string
): engine.LiveMount => {
  const rendered = state.ack.mounts
  const found = rendered.filter((live) =>
    Mount.isDefinition(target)
      ? live.mount.name === target.name
      : Mount.sameArgs(live.mount, target)
  )
  if (found.length === 1) return found[0]!
  const wanted = Mount.isDefinition(target)
    ? target.name
    : engine.describeMount(target as View.Mount<any>)
  const list = rendered.length === 0
    ? "nothing"
    : rendered.map((live) => engine.describeMount(live.mount)).join(", ")
  throw new Error(
    found.length === 0
      ? `${step}: no rendered mount matches ${wanted}; mounts: ${list}`
      : `${step}: ${found.length} rendered mounts match ${wanted}; mounts: ${list}`
  )
}

/**
 * One event of an interaction.
 *
 * @internal
 */
export interface PlannedEvent {
  /** The element it goes to, in the view as it is when the event runs. */
  readonly node: (state: engine.State<any, any, any, any>) => Locator.Node
  readonly description: string
  readonly event: string
  /** Its payload, read when the event runs, with the element it goes to. */
  readonly payload: (
    state: engine.State<any, any, any, any>,
    node: Locator.Node
  ) => unknown
}

const withMount = (
  state: engine.State<any, any, any, any>,
  live: engine.LiveMount,
  next: engine.LiveMount
): engine.State<any, any, any, any> =>
  engine.update(state, {
    ack: {
      ...state.ack,
      mounts: state.ack.mounts.map((each) => each === live ? next : each)
    }
  })

/**
 * The cursor of a scene.
 *
 * @internal
 */
export class SceneCursor extends Cursor {
  protected project(state: engine.State<any, any, any, any>): object {
    return {
      ...cursor.baseRecord(state),
      defaultPrevented: state.defaultPrevented,
      view: state.view,
      get root() {
        return state.root
      },
      get: state.get,
      query: state.query,
      all: state.all
    }
  }
  get defaultPrevented(): boolean {
    return this.state.defaultPrevented
  }
  get view(): View.Node<any, any> {
    return this.state.view()
  }
  get root(): Locator.Node {
    return this.state.root
  }
  get(locator: Locator.Locator): Locator.Node {
    return this.state.get(locator)
  }
  query(locator: Locator.Locator): Locator.Node | undefined {
    return this.state.query(locator)
  }
  all(locator: Locator.Locator): ReadonlyArray<Locator.Node> {
    return this.state.all(locator)
  }
  protected override settled(
    state: engine.State<any, any, any, any>,
    step: string
  ): engine.State<any, any, any, any> {
    // Rendered once the step has settled, so a defect in `view` fails it.
    return trackMounts(engine.syncRun(state, step), step)
  }

  /**
   * Runs one interaction made of several events on elements of the view, in order. `events` plans them
   * from the view the interaction starts on. Each event goes to the view as it is after the one before.
   * The interaction is ignored only when none of them produced a message, and its default is cancelled
   * when any was.
   */
  protected interact(
    step: string,
    events: (
      state: engine.State<any, any, any, any>
    ) => ReadonlyArray<PlannedEvent>
  ): this {
    let prevented = false
    let handled = false
    return this.act(
      step,
      "message",
      (state) => {
        let out = state
        for (const { description, event, node, payload } of events(state)) {
          const target = node(out)
          const fired = engine.fireNode(
            out,
            target,
            event,
            payload(out, target),
            this.name(step),
            description
          )
          prevented ||= fired.prevented
          handled ||= fired.handled
          out = fired.story
        }
        return out
      },
      () => ({
        interaction: handled ? "handled" : "ignored",
        defaultPrevented: prevented
      })
    )
  }
  protected findOne(
    state: engine.State<any, any, any, any>,
    locator: Locator.Locator,
    step: string
  ): Locator.Node {
    return engine.findOne(state, locator, this.name(step))
  }
  /** An interaction of one event, on the one element `locator` matches. */
  protected one(
    step: string,
    locator: Locator.Locator,
    event: string,
    payload: (
      node: Locator.Node,
      state: engine.State<any, any, any, any>
    ) => unknown
  ): this {
    return this.interact(step, (state) => {
      const node = this.findOne(state, locator, step)
      return [{
        node: () => node,
        description: locator.description,
        event,
        payload: () => payload(node, state)
      }]
    })
  }

  click(target: string | Locator.Locator): this {
    return this.one(
      "click",
      typeof target === "string" ? Locator.text(target) : target,
      "click",
      () => pointer
    )
  }
  fire(locator: Locator.Locator, event: string, payload: unknown = {}): this {
    return this.one("fire", locator, event, () => payload)
  }
  childEmit(child: ChildTarget, ...args: KeyAnd<unknown>): this {
    const [key, event] = keyAnd(args)
    return this.act("childEmit", "message", (state) => {
      const found =
        findDeclared(state, child, key, this.name("childEmit")).child
      return engine.dispatch(state, found.onEmit(event))
    })
  }
  childFailure(
    child: ChildTarget,
    ...args: KeyAnd<Cause.Cause<unknown>>
  ): this {
    const [key, cause] = keyAnd(args)
    return this.act("childFailure", "message", (state) => {
      const found = findDeclared(state, child, key, this.name("childFailure"))
      const failure: AsyncResult.Failure<never, unknown> = AsyncResult.failure(
        cause
      )
      return engine.dispatch(
        withSlot(state, found, failure),
        found.child.onFailure?.(failure)
      )
    })
  }
  childPending(child: ChildTarget, key?: string): this {
    const step = this.name("childPending")
    return this.act("childPending", "acting", (state) => {
      const found = findDeclared(state, child, key, step)
      if (found.child.fallback === undefined) {
        throw new Error(
          `${step}: the child has no fallback to show while it's pending`
        )
      }
      return withSlot(state, found, AsyncResult.initial(true))
    })
  }
  givenChild(child: Component.Headless.Any, ...args: KeyAnd<unknown>): this {
    const [key, model] = keyAnd(args)
    const step = this.name("givenChild")
    // The Model is for the instance the step selected: the one at its path, as the runtime keys instances.
    const path = engine.findChild(this.state.view(), child, key, step).path
    if (path === undefined) {
      throw new Error(`${step}: the child isn't one the scene expands`)
    }
    return this.act("givenChild", "acting", (state) => {
      const given = new Map(engine.childModels.get(state))
      given.set(path, model)
      return engine.update(state, { childModels: given })
    })
  }
  collected(reports: ReadonlyArray<unknown>): this {
    const step = this.name("collected")
    return this.act(
      "collected",
      "message",
      (state) => engine.withReports(state, reports, step)
    )
  }
  protected override givenShared(
    state: engine.State<any, any, any, any>,
    step: string
  ): engine.State<any, any, any, any> {
    // Another `shared` step may give a value the view still misses.
    return engine.renderSharing(state)
      ? trackMounts(engine.syncRun(state, step), step)
      : state
  }
  mounted(
    target: Mount.Definition.Any | Mount.Any,
    ...result: ReadonlyArray<unknown>
  ): this {
    const step = this.name("mounted")
    const live = findMount(this.state, target, step)
    if (live.ended && !live.mount.stream) {
      throw new Error(
        `${step}: the mount ${
          engine.describeMount(live.mount)
        } already ended: one that isn't from Mount.makeStream ends once`
      )
    }
    // `findMount` matched `target`, so `result` is the Source of this mount. A mount that ends with
    // `Component.noop` takes no result, but `undefined` given is a result.
    const message = (live.mount.resolve as (result: unknown) => unknown)(
      result.length === 0 ? noop : result[0]
    )
    // A mount of a child the scene runs ends in that child's `update`.
    return this.act(
      "mounted",
      "acting",
      (state) =>
        engine.dispatchTo(
          withMount(state, live, { ...live, acknowledged: true, ended: true }),
          live.owner,
          message,
          step
        )
    )
  }
  expectMount(mount: Mount.Any): this {
    const live = findMount(this.state, mount, this.name("expectMount"))
    return this.replace(
      withMount(this.state, live, { ...live, acknowledged: true })
    )
  }

  parts(f: (parts: unknown) => void): this {
    const component = this.state.component as unknown as Partial<
      Component.Headless.Any
    >
    if (component.parts === undefined) {
      throw new Error(
        `${
          this.name("parts")
        }: ${this.state.component.definition.name} is not a headless component`
      )
    }
    f(engine.rootParts(
      component as Component.Headless.Any,
      this.state.model,
      this.state.props,
      this.state
    ))
    return this
  }
  expect(locator: Locator.Locator): object {
    return this.expectation(locator, matchers)
  }
  /** An expectation over `locator`: one method per matcher, each returning the cursor. */
  protected expectation(
    locator: Locator.Locator,
    matchers: { readonly [name: string]: (...args: Array<any>) => Matcher }
  ): object {
    return makeExpectation(this.name("expect"), locator, matchers, (check) => {
      check(this.state.all(locator), this.state.root)
      return this
    })
  }
  expectHandled(): this {
    if (this.state.ack.interaction !== "handled") {
      throw new Error(
        `${this.name("expectHandled")}: ${describeInteraction(this.state)}`
      )
    }
    return this
  }
  expectIgnored(): this {
    if (this.state.ack.interaction !== "ignored") {
      throw new Error(
        `${this.name("expectIgnored")}: ${describeInteraction(this.state)}`
      )
    }
    return this.replace(
      engine.update(this.state, { ack: { ...this.state.ack, ignored: false } })
    )
  }
  expectDefaultPrevented(expected = true): this {
    if (this.state.defaultPrevented !== expected) {
      throw new Error(
        `${this.name("expectDefaultPrevented")}: the default was ${
          this.state.defaultPrevented ? "" : "not "
        }cancelled`
      )
    }
    return this
  }
  expectLazyReused(): this {
    const step = this.name("expectLazyReused")
    if (!dev) {
      throw new Error(`${step}: requires a non-production build of @effect/ui`)
    }
    const store: View.LazyStore = { lazy: undefined }
    const shared = engine.stableRootShared(this.state)
    engine.viewOfFields(this.state, shared, store)
    const lazies = store.lazy as View.Lazies | undefined
    if (lazies === undefined) {
      throw new Error(`${step}: the view didn't call h.lazy`)
    }
    const counts = new Map<string, number>()
    lazies.missed = (entry, fn, args) => {
      const reason = classifyLazyMiss(entry, lazies.round, fn, args)
      counts.set(reason, (counts.get(reason) ?? 0) + 1)
    }
    engine.viewOfFields(this.state, shared, store)
    engine.report(
      step,
      "h.lazy calls missed on a repeat render",
      Array.from(
        counts,
        ([reason, count]) => count === 1 ? reason : `${reason} (${count} calls)`
      )
    )
    return this
  }
}

const fnName = (fn: Function): string => fn.name || "<anonymous>"

const classifyLazyMiss = (
  entry: View.LazyEntry | undefined,
  round: number,
  fn: Function,
  args: ReadonlyArray<unknown>
): string => {
  const name = fnName(fn)
  if (entry === undefined) {
    return args.length === 0
      ? `${name}: no entry (function identity changed or not called on first render)`
      : `${name}: no entry for first argument`
  }
  if (entry.round === round) {
    return `${name}: first argument shared with an earlier call (${
      fnName(entry.fn)
    })`
  }
  if (entry.fn !== fn) return `${name}: function changed`
  const changed: Array<number> = []
  const length = Math.max(entry.args.length, args.length)
  for (let i = 0; i < length; i++) {
    if (
      i >= entry.args.length || i >= args.length || args[i] !== entry.args[i]
    ) {
      changed.push(i)
    }
  }
  return changed.length === 1
    ? `${name}: argument ${changed[0]} changed`
    : `${name}: arguments ${changed.join(", ")} changed`
}

const describeInteraction = (state: engine.State<any, any, any, any>): string =>
  state.ack.interaction === undefined
    ? "the last step wasn't an interaction"
    : state.ack.interaction === "handled"
    ? "the last interaction produced a message"
    : "the last interaction produced no message"

/**
 * What a click sends when nothing says otherwise: the primary button, at the origin, with no modifier.
 *
 * @internal
 */
export const pointer = {
  button: 0,
  x: 0,
  y: 0,
  shift: false,
  ctrl: false,
  alt: false,
  meta: false,
  pointerId: 1,
  pointerType: "mouse" as const
}

/**
 * What a click's `mousedown` and `mouseup` send: `pointer`, without a pointer id, as a browser's mouse events.
 *
 * @internal
 */
export const mouse = { ...pointer, pointerId: -1 }

/**
 * Starts a scene cursor over `component`, or over the stand-in a headless or slotted scene builds from
 * `options`.
 *
 * @internal
 */
export const begin = <S extends SceneCursor>(
  Ctor: new(module: string, state: engine.State<any, any, any, any>) => S,
  module: string,
  component: any,
  props: unknown,
  options?: {
    readonly elements?: View.Vocabulary<any> | undefined
    readonly slots?: ((h: any) => any) | undefined
    readonly view?: ((parts: any, h: any) => View.Content<any, any>) | undefined
    readonly run?: ReadonlyArray<object> | undefined
  }
): S => {
  const made = options?.slots !== undefined
    ? engine.withSlots(component, options.slots, options.elements)
    : options?.view !== undefined
    ? engine.withView(component, options.view, options.elements)
    : component
  const initial = cursor.initial(made, props)
  const state = options?.run === undefined
    ? initial
    : engine.update(initial, {
      run: { components: options.run, models: new Map() }
    })
  const step = `${module}.start`
  // A missing shared value can't be given before the first step.
  return new Ctor(
    module,
    engine.renderSharing(state)
      ? trackMounts(engine.syncRun(state, step), step)
      : state
  )
}
