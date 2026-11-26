/**
 * The `Router`: the current URL as a route value, its changes, and the
 * navigation Commands.
 *
 * `Router` is a host service. Its Layers are `Router.memory` (tests and
 * `TestHost`), `Router.static` (server rendering) and, in
 * `@effect/ui/html`, `BrowserRouter.layer` and `BrowserRouter.layerHash`.
 * Each provides the `Router` service and the navigation Commands, `Push`,
 * `Replace`, `PatchSearch`, `Back`, `Forward` and `Load`. A component
 * that navigates has them in its requirements, so a missing Router is a
 * compile error at `mount`.
 *
 * **Where the route lives**
 *
 * The root's Model holds the route. Its props carry the initial one: mount it
 * with `Router.props(AppRoute)`, which reads `{ route }` from the Router, or
 * map `Router.currentRoute(AppRoute)` for a root with other props.
 * Later changes arrive as a message from
 * `Router.subscription`, so every route change is in the log. The Router is
 * shaped like a `SubscriptionRef`: `changes` starts with the current
 * location, so a change made before the Subscription starts isn't lost. The
 * Subscription suppresses the first delivery when the root already holds it.
 *
 * Pages are chosen with the union's exhaustive `match` and keyed by their
 * path, `AppRoute.printPath(route)`. A new path mounts a fresh page, and a
 * change to the search alone updates the page in place:
 * `SearchPage(h, { key: AppRoute.printPath(route), props: { route } })`.
 * A page that should start over when a param changes adds the param to its
 * key.
 *
 * **View state in search params**
 *
 * A value such as a search box's text or a page number can live in the
 * search alone, with no copy in any Model. A page that uses its search takes
 * its whole route as props, typed by a one-case subset such as
 * `AppRoute.subset(["Search"])`, and reads `h.props.route.search`. A page
 * with no search can take picked fields, such as `{ id: route.params.id }`.
 * The page writes the search with `Router.patchSearch`, and a query that
 * reads it can wait for typing to stop with its `debounce` option.
 *
 * **Example** (A root that follows the route)
 *
 * ```ts import.meta.vitest
 * import { Effect, Schema } from "effect"
 * import { Command, Component, Route, Router, UiSchema } from "@effect/ui"
 * import { TestHost } from "@effect/ui/testing"
 *
 * const AppRoute = Route.union({
 *   Home: Route.make("/"),
 *   About: Route.make("/about"),
 *   NotFound: Route.make("/*")
 * })
 *
 * const Message = UiSchema.TaggedEnum({
 *   ChangedRoute: { route: AppRoute },
 *   ClickedLink: { route: AppRoute }
 * })
 *
 * const App = Component.define({
 *   name: "App",
 *   props: Schema.Struct({ route: AppRoute }),
 *   model: Schema.Struct({ route: AppRoute }),
 *   message: Message
 * }).make({
 *   init: ($) => ({ route: $.props.route }),
 *   update: ($, message) =>
 *     Message.match(message, {
 *       ChangedRoute: ({ route }) => ({ route }),
 *       // The new route comes back through the subscription: the push itself sends nothing.
 *       ClickedLink: ({ route }) => $.run(Router.push(AppRoute, route).pipe(Command.asNoop))
 *     }),
 *   subscriptions: ({ model }) => [Router.subscription(AppRoute, model.route, (route) => Message.ChangedRoute({ route }))],
 *   view: (h, model) => h.el("p", model.route._tag)
 * })
 *
 * // The initial route comes from the Router, here at "/about".
 * const mount = TestHost.mount(App, Router.props(AppRoute)).pipe(
 *   Effect.provide(Router.memory({ routes: AppRoute, url: "/about" }))
 * )
 * ```
 *
 * @stability experimental
 * @since 0.1.0
 */
import * as Cause from "effect/Cause"
import * as Channel from "effect/Channel"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type * as Types from "effect/Types"
import * as Command from "./Command.ts"
import type * as Component from "./Component.ts"
import * as prefetchWalk from "./internal/prefetch.ts"
import * as queryCore from "./internal/queryCore.ts"
import * as routeRun from "./internal/routeRun.ts"
import * as services from "./internal/services.ts"
import { canonical, pairsWithout, withPairs } from "./internal/url.ts"
import type * as Query from "./Query.ts"
import type * as Route from "./Route.ts"
import * as Subscription from "./Subscription.ts"

/**
 * Where the Router is: the route, its printed URL (path and search, under the
 * base) and its `#hash`, and the navigation that got there.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Location {
  readonly route: { readonly _tag: string }
  readonly url: string
  readonly hash: string
  readonly action: Action
  /** Counts navigations: 0 for the initial location. */
  readonly seq: number
}

/**
 * How a location was reached: the first load, a push, a replace, or a move
 * through history (`pop`), such as the back button.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type Action = "initial" | "push" | "replace" | "pop"

/**
 * Schema for {@link Outcome}.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const Outcome = Schema.Literals(["navigated", "blocked"])

/**
 * What a navigation Command returns: `"blocked"` when a block was held,
 * else `"navigated"`.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type Outcome = typeof Outcome.Type

/**
 * Schema for {@link PatchOutcome}.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const PatchOutcome = Schema.Literals([...Outcome.literals, "stale"])

/**
 * What `patchSearch` returns: `"stale"` when the Router's path no longer
 * matches the held route, `"blocked"` from `Router.static` only, else
 * `"navigated"`.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type PatchOutcome = typeof PatchOutcome.Type

/**
 * The patch `patchSearch` takes for a route value: any of its search fields,
 * where `undefined` removes the param, or resets it to its default.
 *
 * @stability experimental
 * @category utility types
 * @since 0.1.0
 */
export type SearchPatch<R> = [R] extends [{ readonly search: infer Q }] ?
  { readonly [K in keyof Q]?: Q[K] | undefined }
  : never

/**
 * The `Router` service.
 *
 * **Details**
 *
 * `changes` starts with the current location, then emits each route change.
 * A change to the `#hash` alone within the same route isn't a route change.
 * `navigate` takes an href: one the routes parse is pushed (or replaced), and
 * anything else is a full page load. An href to the current route, with the
 * same tag and printed route, isn't a navigation: the URL keeps its
 * undeclared params, only a new `#hash` is written and no sequence is bumped.
 * `changes` emits the current location again, so the root hears that a link
 * to its own page was followed. `push` and `replace` of the current route
 * emit nothing.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Router {
  readonly routes: Route.AnyUnion
  readonly location: () => Location
  readonly changes: Stream.Stream<Location>
  readonly navigate: (
    href: string,
    options?: { readonly replace?: boolean | undefined }
  ) => Effect.Effect<Outcome>
  readonly push: (route: { readonly _tag: string }) => Effect.Effect<Outcome>
  readonly replace: (route: { readonly _tag: string }) => Effect.Effect<Outcome>
  /**
   * Applies `patch` to the current route's search, if the Router's path still
   * matches `route`'s: see `Router.patchSearch`. `history` defaults to
   * `"replace"`.
   */
  readonly patchSearch: (
    route: { readonly _tag: string },
    patch: Readonly<Record<string, unknown>>,
    options?: {
      readonly history?: "push" | "replace" | undefined
      readonly scroll?: boolean | undefined
    } | undefined
  ) => Effect.Effect<PatchOutcome>
  readonly back: Effect.Effect<Outcome>
  readonly forward: Effect.Effect<Outcome>
  readonly load: (href: string) => Effect.Effect<Outcome>
  /** Holds a block under `key` until the Scope closes. */
  readonly block: (key: string) => Effect.Effect<void, never, Scope.Scope>
  /** Whether any block is held. */
  readonly blocked: () => boolean
  /**
   * The user showed intent to follow a link to `href`: each mounted
   * `Router.prefetch` declaration covering its route runs, unless it ran for
   * that route less than 30 seconds ago. An href the routes don't parse, or
   * one for the current route, does nothing. `BrowserRouter` calls it on
   * hover, focus and touch, and a test calls it directly.
   */
  readonly intent: (href: string) => Effect.Effect<void>
}

/**
 * The `Router` service.
 *
 * @stability experimental
 * @category services
 * @since 0.1.0
 */
export const Router: Context.Service<Router, Router> = Context.Service<Router>(
  "@effect/ui/Router"
)

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * A route union, with its route values' type.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type Routes = Route.AnyUnion & {
  readonly Type: { readonly _tag: string }
}

/**
 * A route value of some union: the args Schema of `Push` and `Replace`. The
 * log encodes it structurally.
 */
const RouteValue = Schema.declare(
  (u: unknown): u is { readonly _tag: string } =>
    Predicate.hasProperty(u, "_tag") && typeof u._tag === "string"
)

/**
 * The Command behind `push`. Use `push`, which types the route value; the
 * class is what a Layer fake or a story's `resolve` step names.
 *
 * @stability experimental
 * @category commands
 * @since 0.1.0
 */
export class Push extends Command.Service<Push>()(
  "@effect/ui/Router/Push",
  {
    args: { route: RouteValue },
    success: Outcome,
    error: Schema.Never
  }
) {
  static readonly layer = this.toLayer(
    Effect.map(Router, (router) => ({ route }) => router.push(route))
  )
}

/**
 * The Command behind `replace`. Use `replace`, which types the route value;
 * the class is what a Layer fake or a story's `resolve` step names.
 *
 * @stability experimental
 * @category commands
 * @since 0.1.0
 */
export class Replace extends Command.Service<Replace>()(
  "@effect/ui/Router/Replace",
  {
    args: { route: RouteValue },
    success: Outcome,
    error: Schema.Never
  }
) {
  static readonly layer = this.toLayer(
    Effect.map(Router, (router) => ({ route }) => router.replace(route))
  )
}

/**
 * Pushes a history entry for a route value of the given union.
 *
 * **Details**
 *
 * The route must be a complete value of `routes`, such as one built with
 * `routes.make`; pass the union given to the Router Layer or one of its
 * subsets. A route equal to the current one does nothing: unlike a link to
 * it, it sends no message. It returns `"blocked"` without navigating while a
 * `Router.blocked` Subscription holds a block. Map the outcome to a message
 * with `Command.map`, or end it with no message with `Command.asNoop`, which
 * also hides a `"blocked"` outcome. The component requires `Push`.
 *
 * @stability experimental
 * @category commands
 * @since 0.1.0
 */
export const push = <U extends Routes>(
  _routes: U,
  route: U["Type"]
): Command.Issued<Outcome, Push, Outcome, "Effect"> => Push.make({ route })

/**
 * Replaces the current history entry with a route value of the given union.
 *
 * **Details**
 *
 * Typed like `push`, and like it does nothing for the current route. A
 * replace that stays on the page, with the same tag and pathname, settles
 * quietly: it isn't announced and leaves focus and scroll alone. A search
 * that a page writes as the user types is better written with `patchSearch`.
 * The component requires `Replace`.
 *
 * @stability experimental
 * @category commands
 * @since 0.1.0
 */
export const replace = <U extends Routes>(
  _routes: U,
  route: U["Type"]
): Command.Issued<Outcome, Replace, Outcome, "Effect"> =>
  Replace.make({ route })

/** A search patch: the args Schema of `PatchSearch`. The log encodes it structurally. */
const SearchPatchValue = Schema.declare(
  (u: unknown): u is Readonly<Record<string, unknown>> =>
    typeof u === "object" && u !== null && !Array.isArray(u)
)

/**
 * The Command behind `patchSearch`. Use `patchSearch`, which types the patch;
 * the class is what a Layer fake or a story's `resolve` step names.
 *
 * @stability experimental
 * @category commands
 * @since 0.1.0
 */
export class PatchSearch extends Command.Service<PatchSearch>()(
  "@effect/ui/Router/PatchSearch",
  {
    args: {
      route: RouteValue,
      patch: SearchPatchValue,
      history: Schema.Literals(["push", "replace"]),
      scroll: Schema.Boolean
    },
    success: PatchOutcome,
    error: Schema.Never
  }
) {
  static readonly layer = this.toLayer(
    Effect.map(
      Router,
      (router) => ({ history, patch, route, scroll }) =>
        router.patchSearch(route, patch, { history, scroll })
    )
  )
}

/**
 * Writes some of the current route's search params, keeping the rest.
 *
 * **When to use**
 *
 * Use to keep view state such as a search box's text, a filter or a page
 * number in the URL, with no copy in the Model.
 *
 * **Details**
 *
 * `route` is the route the page holds, and `patch` is typed by its search
 * fields: `undefined` removes a param, or resets it to its default. When the
 * Command runs, the patch applies to the Router's current search; the held
 * route only names the path, so two patches issued in one round trip both
 * land. If the Router's path no longer matches the held route, the Command
 * does nothing and returns `"stale"`.
 *
 * It replaces the history entry by default; `{ history: "push" }` pushes
 * one. Params the route doesn't declare, such as `utm_source`, are kept,
 * printed after the declared ones in their original order, and so is the
 * `#hash`. A patch that changes nothing doesn't navigate.
 *
 * The navigation is quiet: `Settled.quiet` is `true`, so the browser Router
 * announces nothing and leaves focus alone. It leaves scroll alone too,
 * unless `{ scroll: true }` asks it to scroll to the top. A push still runs
 * the `Router.prefetch` declarations. `Router.blocked` doesn't block it.
 * The component requires `PatchSearch`.
 *
 * **Gotchas**
 *
 * Key the page by `printPath`, not `print`: a page keyed by its search
 * remounts on every patch and loses its Model. If a block held when the patch
 * ran is gone when it settles, `PatchSearchLostBlock` is reported.
 *
 * **Example** (A search box bound to the URL)
 *
 * ```ts
 * import { Command, Route, Router } from "@effect/ui"
 * import { Schema } from "effect"
 *
 * const AppRoute = Route.union({
 *   Search: Route.make("/search", { search: { q: Schema.optional(Schema.String) } }),
 *   NotFound: Route.make("/*")
 * })
 * const SearchRoute = AppRoute.subset(["Search"])
 *
 * const typed = (route: typeof SearchRoute.Type, text: string) =>
 *   Router.patchSearch(AppRoute, route, { q: text || undefined }).pipe(Command.asNoop)
 * ```
 *
 * @see {@link replace} to navigate to a whole route value instead
 * @stability experimental
 * @category commands
 * @since 0.1.0
 */
export const patchSearch = <U extends Routes, R extends U["Type"]>(
  _routes: U,
  route: R,
  patch: NoInfer<SearchPatch<R>>,
  options?: {
    readonly history?: "push" | "replace" | undefined
    readonly scroll?: boolean | undefined
  } | undefined
): Command.Issued<PatchOutcome, PatchSearch, PatchOutcome, "Effect"> =>
  PatchSearch.make({
    route,
    patch: patch as Readonly<Record<string, unknown>>,
    history: options?.history ?? "replace",
    scroll: options?.scroll === true
  })

/**
 * Goes back one history entry.
 *
 * @stability experimental
 * @category commands
 * @since 0.1.0
 */
export class Back extends Command.Service<Back>()(
  "@effect/ui/Router/Back",
  {
    args: {},
    success: Outcome,
    error: Schema.Never
  }
) {
  static readonly layer = this.toLayer(
    Effect.map(Router, (router) => () => router.back)
  )
}

/**
 * Goes forward one history entry.
 *
 * @stability experimental
 * @category commands
 * @since 0.1.0
 */
export class Forward extends Command.Service<Forward>()(
  "@effect/ui/Router/Forward",
  {
    args: {},
    success: Outcome,
    error: Schema.Never
  }
) {
  static readonly layer = this.toLayer(
    Effect.map(Router, (router) => () => router.forward)
  )
}

/**
 * Loads an href with a full page load, such as an external URL.
 *
 * @stability experimental
 * @category commands
 * @since 0.1.0
 */
export class Load extends Command.Service<Load>()(
  "@effect/ui/Router/Load",
  {
    args: { href: Schema.String },
    success: Outcome,
    error: Schema.Never
  }
) {
  static readonly layer = this.toLayer(
    Effect.map(Router, (router) => ({ href }) => router.load(href))
  )
}

/**
 * Blocks navigation under a key while the Subscription runs, such as while a
 * form has unsaved changes.
 *
 * **Details**
 *
 * While any block is held, `Push`, `Replace`, `Back`, `Forward` and `Load`
 * return `"blocked"` and links aren't followed. Back and forward in the
 * browser can't be blocked, only reverted: the Router moves back to the
 * entry it was on, announces nothing and leaves focus alone.
 *
 * Writes within the page aren't blocked: `PatchSearch`, and back and forward
 * between entries of the same page that differ in their search only. So a
 * search box on a page with unsaved changes still types, and the user can
 * go back after `?page=2`. The block is
 * held while `subscriptions` returns it, so the Model says when, and it's
 * released when the instance unmounts. It sends no messages.
 *
 * The Subscription is named `@effect/ui/Router/blocked` and `key` is its
 * dep, so `Router.blocked("form")` has the Subscription key
 * `@effect/ui/Router/blocked:"form"`.
 *
 * **Example** (Blocking navigation while a form is dirty)
 *
 * ```ts
 * import { Router } from "@effect/ui"
 *
 * const subscriptions = ({ model }: { readonly model: { readonly dirty: boolean } }) =>
 *   model.dirty ? [Router.blocked("form")] : []
 * ```
 *
 * @stability experimental
 * @category subscriptions
 * @since 0.1.0
 */
export const blocked = (
  key: string
): Subscription.Subscription<never, Router> =>
  Subscription.make(
    "@effect/ui/Router/blocked",
    key,
    (key) =>
      Stream.unwrap(
        Router.use((router) => Effect.as(router.block(key), Stream.never))
      )
  )

/**
 * Everything a Router Layer provides.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type Services =
  | Router
  | Push
  | Replace
  | PatchSearch
  | Back
  | Forward
  | Load

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

const engines = new WeakMap<Router, Engine>()

/** A location's route as a value of `union`: the Router's own route for its union, a parse of the URL for another. */
const routeOf = (
  router: Router,
  union: Route.AnyUnion,
  location: Location
): Option.Option<{ readonly _tag: string }> =>
  router.routes === union
    ? Option.some(location.route)
    : union.parse(location.url)

/**
 * Reads the Router's current route as a value of the given union.
 *
 * **When to use**
 *
 * Use to initialize a routed root's props from its Router rather than stating
 * the initial URL again at the mount site.
 *
 * **Gotchas**
 *
 * Dies if the given union cannot parse the current location. Pass the union
 * used by the Router Layer, or a subset that includes the current route.
 *
 * @stability experimental
 * @category accessors
 * @since 0.1.0
 */
export const currentRoute = <U extends Routes>(
  routes: U
): Effect.Effect<U["Type"], never, Router> =>
  Effect.map(
    Router,
    (router) =>
      Option.getOrThrow(routeOf(router, routes, router.location())) as U["Type"]
  )

/**
 * The props of a root whose only prop is the route: `{ route }`, read from
 * the Router when the root mounts.
 *
 * **When to use**
 *
 * Use as a routed root's props in `BrowserHost.mount`, `TestHost.mount` or
 * `HtmlServer.renderToHtml`, which run it once before `init`. The mount
 * then requires the `Router`. A root with other props maps
 * `Router.currentRoute` to them instead.
 *
 * `init` still receives a plain route, so a Story or a test can start the
 * root on any page by passing `{ route }` with no Router.
 *
 * **Gotchas**
 *
 * Dies if the given union cannot parse the current location, as
 * `currentRoute` does.
 *
 * **Example** (Mounting a routed root)
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Component, Route, Router } from "@effect/ui"
 * import { TestHost } from "@effect/ui/testing"
 *
 * const AppRoute = Route.union({
 *   Home: Route.make("/"),
 *   NotFound: Route.make("/*")
 * })
 *
 * const App = Component.define({
 *   name: "App",
 *   props: Schema.Struct({ route: AppRoute }),
 *   model: AppRoute,
 *   message: Schema.Never
 * }).make({
 *   init: ($) => $.props.route,
 *   update: ($) => $.model,
 *   view: (h, route) => h.el("p", route._tag)
 * })
 *
 * // Requires the Router: the initial route comes from its URL.
 * const mount = TestHost.mount(App, Router.props(AppRoute)).pipe(
 *   Effect.provide(Router.memory({ routes: AppRoute, url: "/" }))
 * )
 * ```
 *
 * @stability experimental
 * @category accessors
 * @since 0.1.0
 */
export const props = <U extends Routes>(
  routes: U
): Effect.Effect<{ readonly route: U["Type"] }, never, Router> =>
  Effect.map(currentRoute(routes), (route) => ({ route }))

/**
 * The Subscription that feeds route changes into a root's `update`.
 *
 * **Details**
 *
 * Pass the route held in the Model. The first location is suppressed when its
 * tag and printed URL match that route. Otherwise it is delivered, and a
 * `RouteMismatch` is reported if the Router has not navigated (sequence 0).
 * Hydrated hash roots skip that report, and so do roots hydrated from a
 * `static: true` render whose route differs from the Router's in its search
 * only, as a page prerendered at `/search` and opened at `/search?q=x`.
 * Later locations are always delivered, and the held route is delivered
 * again when a link to it is followed.
 * The key stays stable as the held route changes. A subset only sees its own
 * routes. On the server the root is checked once without running its Streams,
 * regardless of the navigation sequence.
 *
 * A navigation Command such as `Router.push` runs in the flush its `update`
 * caused, and this Subscription delivers the new route from inside it. The
 * root and its pages render the new route in that flush, so a field whose
 * value is read from the search keeps what the user typed and where the caret
 * is. A navigation issued from `init` while the root mounts runs after it has
 * mounted.
 *
 * Use this helper rather than `Router.changes` directly: the browser Router
 * times scroll, announcements and focus from the flush in which the root
 * received the change.
 *
 * @stability experimental
 * @category subscriptions
 * @since 0.1.0
 */
export const subscription = <U extends Routes, Msg>(
  routes: U,
  held: U["Type"],
  f: (route: U["Type"]) => Msg
): Subscription.Subscription<Msg, Router> => {
  const union: Route.AnyUnion = routes
  const have = union.print(held)
  const same = (route: { readonly _tag: string }) =>
    route._tag === held._tag && union.print(route) === have
  /** Whether the route differs from the held one in its search only. */
  const samePath = (route: { readonly _tag: string }) =>
    route._tag === held._tag && union.printPath(route) === union.printPath(held)
  const mismatch = (route: { readonly _tag: string }) => {
    const router = union.print(route)
    return new RouteMismatch({
      have,
      router,
      message:
        `The component holds "${have}" but the Router is at "${router}". Initialize the root with Router.props or Router.currentRoute.`
    })
  }
  /** The message for a location, if any. `initial`: the first location this Subscription sees. */
  const messageOf = (
    router: Router,
    report: (problem: Query.Problem.Any) => void,
    root: services.RootHandle | undefined,
    location: Location,
    initial: boolean
  ): Option.Option<Msg> => {
    const route = routeOf(router, union, location)
    if (Option.isNone(route)) return Option.none()
    if (initial) {
      if (same(route.value)) return Option.none()
      // A hydrated hash root rendered a shell, and a root hydrated from a static render was prerendered
      // without the search: neither could hold the Router's route.
      const exempt = root?.hydrated === true &&
        (router.routes.base() === "#" || (root.static && samePath(route.value)))
      if (location.seq === 0 && !exempt) {
        try {
          report(mismatch(route.value))
        } catch {
          // A problem sink cannot prevent route delivery.
        }
      }
    }
    return Option.some(f(route.value as U["Type"]))
  }
  const stream = Stream.unwrap(Effect.gen(function*() {
    const router = yield* Router
    const report = yield* queryCore.Problems
    const root = (yield* services.CurrentRoot)()
    let first = true
    return router.changes.pipe(
      Stream.map((location) => {
        const initial = first
        first = false
        return messageOf(router, report, root, location, initial)
      }),
      Stream.filter(Option.isSome),
      Stream.map((message) => message.value)
    )
  }))
  // The runtime attaches to the Router's engine instead of running the Stream, so a navigation is
  // delivered from inside the Router's `set`: in the flush whose Command made it.
  const direct: NonNullable<services.Direct[typeof services.direct]> = (
    context,
    emit,
    fail
  ) => {
    const router = Context.get(context as Context.Context<Router>, Router)
    const engine = engines.get(router)
    if (engine === undefined) return undefined
    const report = Context.get(
      context as Context.Context<any>,
      queryCore.Problems
    )
    // Read at delivery: the root attaches to the Router after its first render.
    const root = Context.get(context, services.CurrentRoot)
    let first = true
    const deliver = (location: Location) => {
      const initial = first
      first = false
      let message: Option.Option<Msg>
      try {
        message = messageOf(router, report, root(), location, initial)
      } catch (error) {
        // The subscriber's mapper: its defect fails the subscriber, not the navigation or the other listeners.
        return fail(Cause.die(error))
      }
      // Once the runtime takes the message, the root has the route as of this flush, which is what the
      // navigation settles from. A message it drops, as the Subscription stops, settles nothing.
      if (Option.isSome(message)) {
        emit(message.value, () => engine.delivered(location.seq))
      }
    }
    return {
      initial: Effect.sync(() => {
        if (first) deliver(router.location())
      }),
      close: engine.listen(deliver)
    }
  }
  return Object.assign(Subscription.make("@effect/ui/Router", stream), {
    [services.direct]: direct,
    [services.onServer]: (
      ctx: Context.Context<never>,
      report: (problem: Query.Problem.Any) => void
    ) => {
      const router = Context.getOption(ctx as Context.Context<Router>, Router)
      if (Option.isNone(router)) return
      const route = routeOf(router.value, union, router.value.location())
      if (Option.isSome(route) && !same(route.value)) {
        report(mismatch(route.value))
      }
    }
  })
}

// ---------------------------------------------------------------------------
// Prefetch
// ---------------------------------------------------------------------------

const PageTypeId = "~@effect/ui/Router/Page" as const

/**
 * A page a `Router.prefetch` handler names: a component and its props.
 * `R` is the services of the component's own queries.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Page<out R = never> {
  readonly [PageTypeId]: { readonly _R: Types.Covariant<R> }
  readonly component: Component.Any
  readonly props: unknown
}

/**
 * The reads a component's own queries name: what `Router.page` adds to the
 * declarer's requirements.
 *
 * @stability experimental
 * @category utility types
 * @since 0.1.0
 */
export type PageRequirements<C> = C extends unknown
  ? Component.QueryServices<Component.Queries<C>>
  : never

// A `Mountable` has its Model erased, and with it the queries `Router.page` adds to the declarer. Checked
// per member, so a union with one erased member is rejected too.
type PageInput<C> = true extends
  (C extends unknown ? IsErased<Component.Model<C>> : never) ? ErasedPage
  : unknown

type IsErased<M> = [M] extends [never] ? true : 0 extends (1 & M) ? true : false

interface ErasedPage {
  readonly "Router.page needs the component's Model to find its queries. Pass the component, not a Mountable":
    unique symbol
}

/**
 * Names a page for a `Router.prefetch` handler: a component and its props.
 *
 * **Details**
 *
 * The props argument is left out when the component takes none, as with
 * a component call's `props`. The page's own queries join the declaring component's
 * requirements, so a query the page provides itself is a compile error at
 * `mount`: provide it at the declarer, or return `[]` for that route.
 *
 * **Gotchas**
 *
 * Accepts a component built with `Component.define`, with or without
 * `Component.provide`. Rejects features and `Component.Mountable` values,
 * whose erased Model hides their queries.
 *
 * @stability experimental
 * @category subscriptions
 * @since 0.1.0
 */
export const page = <C extends Component.Any>(
  component: C & PageInput<C>,
  ...props: {} extends Component.Props<C> ? [props?: Component.Props<C>]
    : [props: Component.Props<C>]
): Page<PageRequirements<C>> => ({
  [PageTypeId]: pageVariance,
  component,
  props: props[0] ?? {}
})

const pageVariance = { _R: (_: never) => _ }

/**
 * The map `Router.prefetch` takes: a handler per route tag, given the route
 * value as `match` gives it, returning the route's pages.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type PrefetchMap<U extends Routes> = {
  readonly [K in U["Type"]["_tag"]]: (
    route: Extract<U["Type"], { readonly _tag: K }>
  ) => ReadonlyArray<Page<any>>
}

/**
 * The queries every page of a `Router.prefetch` map names.
 *
 * @stability experimental
 * @category utility types
 * @since 0.1.0
 */
export type PrefetchRequirements<M> = {
  readonly [K in keyof M]: M[K] extends (route: any) => ReadonlyArray<infer P>
    ? PageRequirement<P>
    : never
}[keyof M]

// Distributes over the pages, so a handler returning `[]` adds nothing.
type PageRequirement<P> = P extends Page<infer R> ? R : never

/**
 * Declares the queries of each route's pages, so they are fetched before the
 * pages mount: on link intent and on navigation.
 *
 * **Details**
 *
 * Return it from a component's `subscriptions`. The map is exhaustive over
 * the routes it is given: pass `AppRoute.subset(...)` to declare a section's
 * routes only, and return `[]` for a route with nothing to fetch. For each
 * page the runtime runs `init` with the page's props, discarding its
 * Commands, prefetches what its queries would watch first, and walks its
 * initial view into its component children. A query that waits on loaded
 * data is skipped, and so is a feature child.
 *
 * The declaration runs in the declaring instance's context, so the queries must
 * be provided at the declarer or above it. A query below the page that the
 * declarer can't see is skipped, and reported as `PrefetchQueryNotProvided`
 * unless a `Component.provide` sits between the page and the component that
 * needs it. A throw from `init`, a query or `view` during the walk stops
 * that page's walk and is reported as `PrefetchThrew`.
 *
 * It runs on `intent(href)`, which `BrowserRouter` calls on hover, focus
 * and touch, at most once per route every 30 seconds per declarer. A push, a
 * link click and a replace that changes the pathname run it as well, before
 * the route changes, and never wait for it. Back, forward, a reload and the
 * first mount run nothing. Once a push settles, each declared page with no
 * mounted instance is reported as `PrefetchPageNotMounted`, and each entry
 * an instance created since the push never watched as
 * `PrefetchEntryNotWatched`.
 *
 * With `staleTime: 0`, the page renders prefetched data immediately but
 * refetches on mount. With `staleTime` between 0 and 30 seconds, the intent
 * guard can suppress a second hover that would refresh stale data, leaving
 * the page to render stale data and refetch on mount.
 *
 * One `Router.prefetch` per instance: a second one throws. Nothing runs on
 * the server.
 *
 * **Example** (Prefetching a detail page)
 *
 * ```ts
 * import { Schema } from "effect"
 * import { Query } from "@effect/ui"
 * import { Component, Route, Router } from "@effect/ui"
 *
 * const AppRoute = Route.union({
 *   Home: Route.make("/"),
 *   Person: Route.make("/people/:id", { params: { id: Schema.Number } })
 * })
 *
 * class GetPerson extends Query.Service<GetPerson>()("GetPerson", {
 *   args: { id: Schema.Number },
 *   success: Schema.String,
 *   error: Schema.Never,
 *   staleTime: "1 minute"
 * }) {}
 *
 * const Person = Component.define({
 *   name: "Person",
 *   props: Schema.Struct({ id: Schema.Number }),
 *   model: Schema.Struct({}),
 *   message: Schema.Never,
 *   queries: { person: { query: GetPerson, args: ({ props }) => ({ id: props.id }) } }
 * }).make({
 *   init: () => ({}),
 *   update: ($) => $.model,
 *   view: (h) => h.el("p", "Person")
 * })
 *
 * const subscriptions = () => [
 *   Router.prefetch(AppRoute, {
 *     Home: () => [],
 *     Person: ({ params }) => [Router.page(Person, { id: params.id })]
 *   })
 * ]
 * ```
 *
 * @stability experimental
 * @category subscriptions
 * @since 0.1.0
 */
export const prefetch = <U extends Routes, const M extends PrefetchMap<U>>(
  routes: U,
  map: M
): Subscription.Subscription<never, Router | PrefetchRequirements<M>> => {
  const declaration: services.Prefetch = {
    routes,
    map: map as services.Prefetch["map"]
  }
  return Object.assign(
    Subscription.make("@effect/ui/Router/prefetch", Stream.never),
    {
      [services.prefetch]: declaration
    }
  ) as Subscription.Subscription<never, Router | PrefetchRequirements<M>>
}

/**
 * A component or view threw while a `Router.prefetch` declaration walked a
 * page. That page's walk stopped. The declarer is unaffected.
 *
 * @stability experimental
 * @category problems
 * @since 0.1.0
 */
export class PrefetchThrew extends Data.TaggedClass("PrefetchThrew")<{
  readonly message: string
  /** The declaring instance's path. */
  readonly path: string
  /** The page's component name. */
  readonly page: string
  /** What `init`, a query or `view` threw. */
  readonly error: unknown
}> {}

/**
 * A query in a `Router.prefetch` walk is missing from the declarer's context,
 * with no `Component.provide` between the page and the component that needs
 * it. That read was skipped.
 *
 * @stability experimental
 * @category problems
 * @since 0.1.0
 */
export class PrefetchQueryNotProvided
  extends Data.TaggedClass("PrefetchQueryNotProvided")<{
    readonly message: string
    /** The declaring instance's path. */
    readonly path: string
    /** The page's component name. */
    readonly page: string
    /** The query's name. */
    readonly query: string
  }>
{}

/**
 * After a push settled, a page its `Router.prefetch` declaration named has
 * no mounted instance.
 *
 * @stability experimental
 * @category problems
 * @since 0.1.0
 */
export class PrefetchPageNotMounted
  extends Data.TaggedClass("PrefetchPageNotMounted")<{
    readonly message: string
    /** The declaring instance's path. */
    readonly path: string
    /** The page's component name. */
    readonly page: string
  }>
{}

/**
 * After a push settled, the page instances created since the push never
 * watched an entry the `Router.prefetch` declaration fetched for them.
 *
 * @stability experimental
 * @category problems
 * @since 0.1.0
 */
export class PrefetchEntryNotWatched
  extends Data.TaggedClass("PrefetchEntryNotWatched")<{
    readonly message: string
    /** The declaring instance's path. */
    readonly path: string
    /** The page's component name. */
    readonly page: string
    /** The query's name. */
    readonly query: string
    /** The entry's log key. */
    readonly logKey: string
  }>
{}

// ---------------------------------------------------------------------------
// History and the engine
// ---------------------------------------------------------------------------

/**
 * A history a Router runs on: `Router.memory` keeps one in memory, and the
 * browser Router wraps `window.history`.
 *
 * **Details**
 *
 * `go` moves through the entries and, synchronously or later, reports the
 * entry it landed on to the listener given to `listen`, as the browser's
 * `popstate` does. `state` is opaque to the history; the Router stores the
 * entry's index and its history-restore snapshot in it.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface History {
  readonly current: () => { readonly url: string; readonly state: unknown }
  readonly push: (url: string, state: unknown) => void
  readonly replace: (url: string, state: unknown) => void
  readonly go: (delta: number) => void
  readonly load: (href: string) => void
  readonly listen: (popped: (url: string, state: unknown) => void) => () => void
}

/**
 * A navigation the Router has finished: the first flush, from the one in
 * which the root received it, in which no provided Layer build begun since is
 * still pending.
 * The browser Router scrolls, announces and moves focus then.
 *
 * **Details**
 *
 * Every navigation settles. A quiet one stays on the page, and the host
 * neither announces it nor moves focus. These are quiet:
 *
 * - a `patchSearch`, replace or push;
 * - a replace to the same page: the same tag and pathname;
 * - back and forward between entries of the same page.
 *
 * A push to the same page, such as a `?page=2` link or a GET form, is loud.
 * A quiet navigation that supersedes a loud one before it settles is
 * settled loud, with it.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Settled {
  readonly location: Location
  /** The pathname before the navigation. */
  readonly from: string
  /** The history entry's index. */
  readonly index: number
  /** The root's container. */
  readonly container: unknown
  /** The title of the head folded in the flush, which the navigation announcement reads. */
  readonly title: string | undefined
  /** Whether the navigation stayed on the page, so it isn't announced and focus stays. */
  readonly quiet: boolean
  /**
   * Whether the host scrolls: always for a loud navigation and for back and
   * forward, and for a quiet push or replace only when `patchSearch` was given
   * `{ scroll: true }`.
   */
  readonly scroll: boolean
}

/**
 * The options of `make`.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly routes: Route.AnyUnion
  readonly history: History
  /** Called once per navigation, when it settles. */
  readonly onSettled?: ((settled: Settled) => void) | undefined
  /**
   * Called for a change to the `#hash` alone within the same route, with the
   * index of the history entry it moved to. `onLeave` was called for the entry
   * it left, so a pop can restore that entry's scroll position.
   */
  readonly onHash?:
    | ((hash: string, action: "push" | "pop", index: number) => void)
    | undefined
  /** Called before the Router leaves the history entry at `index`. */
  readonly onLeave?: ((index: number) => void) | undefined
  /**
   * Throttles the replaces that stay on the page, such as a `patchSearch` per
   * keystroke, to stay under the browser's rate limit on history calls. The
   * first is written at once, and then the latest one at the end of each
   * `interval`. The Router's location changes at once either way.
   * `flushOn` is given the function that writes a pending replace now, as on
   * `pagehide`, and returns its cleanup.
   */
  readonly throttle?: {
    readonly interval: Duration.Input
    readonly flushOn?: ((flush: () => void) => () => void) | undefined
  } | undefined
}

/**
 * Reports that an initial held route differs from the Router location.
 *
 * @stability experimental
 * @category problems
 * @since 0.1.0
 */
export class RouteMismatch extends Data.TaggedClass("RouteMismatch")<{
  readonly message: string
  readonly have: string
  readonly router: string
}> {}

/**
 * Reports that a block held when `patchSearch` ran was gone when the
 * navigation settled, as when a page keyed by its search remounts on the
 * patch and loses its Model. It can also fire when the Model releases the
 * block in response to the new route.
 *
 * @stability experimental
 * @category problems
 * @since 0.1.0
 */
export class PatchSearchLostBlock
  extends Data.TaggedClass("PatchSearchLostBlock")<{
    readonly message: string
    /** The keys of the blocks that were released. */
    readonly keys: ReadonlyArray<string>
  }>
{}

interface Engine {
  readonly delivered: (seq: number) => void
  /** Calls `f` with each location `set` moves to, synchronously. */
  readonly listen: (f: (location: Location) => void) => () => void
}

interface EntryState {
  readonly index: number
  readonly snapshot?: Record<string, unknown> | undefined
}

/**
 * Reports that the history threw on a replace, as a browser does past its
 * rate limit on history calls. The Router's location changed anyway, so the
 * address bar shows an older URL until the next write.
 *
 * @stability experimental
 * @category problems
 * @since 0.1.0
 */
export class HistoryWriteFailed extends Data.TaggedClass("HistoryWriteFailed")<{
  readonly message: string
  /** The URL the Router tried to write. */
  readonly url: string
  /** What the history threw. */
  readonly error: unknown
}> {}

const stateKey = "@effect/ui"

const readState = (state: unknown): EntryState | undefined => {
  if (typeof state !== "object" || state === null) return undefined
  const value = (state as Record<string, unknown>)[stateKey]
  return typeof value === "object" && value !== null &&
      typeof (value as EntryState).index === "number"
    ? value as EntryState
    : undefined
}

const writeState = (entry: EntryState): unknown => ({ [stateKey]: entry })

/**
 * Writing the instances' saved state (each Model, plus its query results) into
 * `history.state` threw, as a browser does when the state is too large. The
 * history entry was written with its index only, so the saved state survives
 * in memory and not across a reload.
 *
 * @stability experimental
 * @category problems
 * @since 0.1.0
 */
export class SnapshotWriteFailed
  extends Data.TaggedClass("SnapshotWriteFailed")<{
    readonly message: string
    /** What the history threw. */
    readonly error: unknown
  }>
{}

const splitHash = (href: string): readonly [string, string] => {
  const at = href.indexOf("#", 1)
  return at < 0 ? [href, ""] : [href.slice(0, at), href.slice(at)]
}

const pathnameOf = (url: string): string => {
  const at = url.indexOf("?")
  return at < 0 ? url : url.slice(0, at)
}

/** What a Router's routes are: a `Route.union`, with its definitions and `make`. */
interface UnionInternals {
  readonly routes: Readonly<Record<string, Route.Any>>
  readonly make: (input: unknown) => { readonly _tag: string }
}

/** What the runtime's prefetch walk reports with. */
const prefetchProblems: prefetchWalk.Problems = {
  PrefetchThrew,
  PrefetchQueryNotProvided,
  PrefetchPageNotMounted,
  PrefetchEntryNotWatched
}

const commandLayers = Layer.mergeAll(
  Push.layer,
  Replace.layer,
  PatchSearch.layer,
  Back.layer,
  Forward.layer,
  Load.layer
)

/**
 * Builds a Router Layer on a `History`, for hosts that bring their own.
 *
 * **Details**
 *
 * The Router resolves every href through `routes`: redirects and a trailing
 * slash are replaced with the canonical URL, and an href the routes don't
 * parse is a full page load. It implements blocking, history restore and the
 * settle timing; a host adds scroll, announcements and focus in `onSettled`.
 *
 * History restore: before leaving an entry, the Router saves the encoded
 * state of every mounted instance by path: its Model and query results. It can't save only the page's
 * subtree, because which instances the navigation unmounts is only known
 * after it. On back and forward, an instance created for the entry adopts its
 * saved state, so only the re-keyed subtree is restored, and an instance that
 * stayed mounted keeps its own. As with hydration, `init` is replayed and
 * every one of its Commands runs. A component's `restore` option in
 * `Component.define` keeps it out of the snapshot, or saves another Model in
 * place of its own. An owner of shared state whose `shares` has `collects`
 * also saves the message its readers' reports last sent, and a restored owner
 * compares their reports with it.
 *
 * A restored query result seeds the cache when its entry is cold, as after a
 * reload: the entry is stored stale, so the first frame shows the data with
 * `waiting: true` and one refetch runs. If the refetch fails, the data stays
 * as the Failure's previous Success. A warm entry is used as it is. A result
 * taken under an optimistic patch is never a seed: it is dropped from the
 * restored state and starts from loading.
 *
 * Saved state is decoded with the component's current Schemas, as one value.
 * State that doesn't decode, such as state an older build wrote before its
 * Model or state format changed, is dropped whole: the instance runs `init`
 * as if nothing was saved, its saved Model is lost too, and its queries
 * fetch afresh.
 *
 * The snapshot is kept in memory per entry. When a push leaves an entry, it's
 * also written into that entry's `state`, so it survives a reload. When that
 * write throws, the entry is written with its index only and
 * `SnapshotWriteFailed` is reported. When back or forward leaves an entry,
 * the host has already moved to the other entry, so the snapshot stays in
 * memory only. After a reload, each root's first mount restores its part of
 * the snapshot written when a push last left the entry, or starts fresh. Once
 * that mount settles, the rest of its part is dropped, so a later remount
 * starts from `init`. An instance that hydrates server-rendered HTML starts
 * from the server's state instead.
 *
 * The snapshot holds server-rendered state only of components the client has
 * built, since only a built component's `restore` option is known. One built
 * but still waiting for its Layer or for its state to decode has the server's
 * state saved through its `restore` option. One not built yet, such as a
 * component below a waiting one, or a keep-alive child the server kept but the
 * client hasn't drawn, has none of its server state saved, even after
 * hydration has settled: after Back or forward it starts from `init`.
 *
 * A state whose Schema encodes asynchronously, as `Schema.File` does, joins
 * the snapshot in memory once it is encoded, after the push has written the
 * entry. Back and forward restore it, and after a reload it starts fresh,
 * with a warning logged the first time. A state that doesn't encode is left
 * out, with a warning logged once per component. An instance whose state holds
 * a `Schema.Redacted` anywhere is left out of the snapshot too, with no
 * warning. A state whose Schema decodes asynchronously shows nothing until it
 * is decoded, then starts from it.
 *
 * With `throttle`, a replace that stays on the page is written at once, and
 * then at most once per interval, with the latest URL. A pending one is
 * written before a push, a change to the hash, back, forward, a full page
 * load, the host's `flushOn` and the Layer's Scope closing. It is dropped
 * when the host moves to another entry by itself, as with the back button,
 * since that entry is no longer current. A replace the history throws on is
 * reported as `HistoryWriteFailed`, whether it was written at once or later.
 *
 * Every navigation the Router makes closes the cache's fetch-free window
 * after hydration, if adoption hasn't closed it yet.
 *
 * @stability experimental
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options): Layer.Layer<Services> =>
  Layer.provideMerge(
    commandLayers,
    Layer.effectContext(Effect.suspend(() => build(options)))
  )

const build = (
  options: Options
): Effect.Effect<Context.Context<Router>, never, Scope.Scope> =>
  Effect.gen(function*() {
    const { history, routes } = options
    // With the `#` base the URL is the fragment, so there's no in-page hash.
    const split = (href: string): readonly [string, string] =>
      routes.base() === "#" ? [href, ""] : splitHash(href)
    const start = history.current()
    const [startUrl, startHash] = split(start.url)
    const resolved = routes.resolve(startUrl)
    if (Option.isNone(resolved)) {
      return yield* Effect.die(
        new Error(
          `The Router's routes don't parse the initial URL "${start.url}"`
        )
      )
    }
    // The problems sink of the first mounted root, or the one where the Router is built.
    const fallbackReport = yield* queryCore.Problems
    let index = readState(start.state)?.index ?? 0
    const initialUrl = canonical(routes, resolved.value, startUrl)
    if (
      resolved.value.redirected || readState(start.state) === undefined ||
      initialUrl !== startUrl
    ) {
      history.replace(initialUrl + startHash, writeState({ index }))
    }
    let current: Location = {
      route: resolved.value.route,
      url: initialUrl,
      hash: startHash,
      action: "initial",
      seq: 0
    }
    const blocks = new Map<string, number>()
    const snapshots = new Map<number, Record<string, unknown>>()
    const roots = new Set<services.RootHandle>()
    let restoring: Record<string, unknown> | undefined = readState(start.state)
      ?.snapshot
    restoring &&= { ...restoring }
    const forgetRestoring = (root: services.RootHandle) => {
      if (pending !== undefined) return
      root.restored()
      if (restoring === undefined) return
      for (const path in restoring) {
        if (
          path === root.path || path.startsWith(root.path + "/") ||
          path === "~kept" + root.path
        ) {
          delete restoring[path]
        }
      }
      if (Object.keys(restoring).every((key) => key === "~reported")) {
        restoring = undefined
      }
    }
    let pending: {
      readonly location: Location
      readonly from: string
      readonly index: number
      readonly quiet: boolean
      readonly scroll: boolean
      since: number | undefined
      /** The checks of the declarations the navigation ran, run when it settles. */
      readonly checks: ReadonlyArray<services.PrefetchCheck>
      /** The blocks held when a `patchSearch` ran, checked when it settles. */
      readonly blocks: ReadonlyArray<string>
    } | undefined
    let reverting = 0
    /** The replace queued on the entry a blocked pop left, written once the revert is back on it. */
    let reverted: {
      readonly index: number
      readonly url: string
      readonly state: unknown
    } | undefined

    const primary = (): services.RootHandle | undefined =>
      roots.values().next().value
    const snapshot = (): Record<string, unknown> => {
      const out: Record<string, unknown> = {}
      for (const root of roots) root.snapshot(out)
      return out
    }
    const leave = () => {
      options.onLeave?.(index)
      snapshots.set(index, snapshot())
    }
    const report = (
      problem: SnapshotWriteFailed | PatchSearchLostBlock | HistoryWriteFailed
    ) => {
      const root = primary()
      try {
        if (root !== undefined) root.report(problem)
        else fallbackReport(problem)
      } catch {
        // A sink can't change what the Router does.
      }
    }
    /** The latest same-page replace made while `cooling`, written when it ends. */
    let queued: { readonly url: string; readonly state: unknown } | undefined
    /**
     * Replaces the current entry, which supersedes a queued replace. A throw is reported instead of
     * failing the navigation.
     */
    const replaceNow = (url: string, state: unknown) => {
      queued = undefined
      try {
        history.replace(url, state)
      } catch (error) {
        report(
          new HistoryWriteFailed({
            url,
            error,
            message:
              `[@effect/ui] the Router couldn't write "${url}" into the history. The route changed anyway, so the address bar shows an older URL until the next write.`
          })
        )
      }
    }
    // --- throttled replaces --------------------------------------------------
    const context = yield* Effect.context<never>()
    const interval = options.throttle === undefined
      ? undefined
      : Duration.fromInputUnsafe(options.throttle.interval)
    /** The interval after a throttled write, on the Effect `Clock`. */
    let cooling: Fiber.Fiber<void> | undefined
    /** Writes the queued replace now, before the Router leaves or rewrites the entry. */
    const flush = () => {
      if (queued !== undefined) replaceNow(queued.url, queued.state)
    }
    const cool = (interval: Duration.Duration) => {
      cooling = Effect.runForkWith(context)(Effect.andThen(
        Effect.sleep(interval),
        Effect.sync(() => {
          cooling = undefined
          if (queued === undefined) return
          flush()
          cool(interval)
        })
      ))
    }
    /** A replace that stays on the page: written at once, or as the latest one when the interval ends. */
    const replaceQuiet = (url: string, state: unknown) => {
      if (interval === undefined) return replaceNow(url, state)
      if (cooling !== undefined) {
        queued = { url, state }
        return
      }
      replaceNow(url, state)
      cool(interval)
    }
    const unflush = options.throttle?.flushOn?.(flush)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unflush?.()
        cooling?.interruptUnsafe()
        cooling = undefined
        flush()
      })
    )
    /** Writes the entry being left with its snapshot, so it survives a reload. A throw keeps the index only. */
    const writeSnapshot = (url: string, entry: EntryState) => {
      // The current URL with the entry's snapshot: it supersedes a queued replace.
      queued = undefined
      try {
        history.replace(url, writeState(entry))
      } catch (error) {
        replaceNow(url, writeState({ index: entry.index }))
        report(
          new SnapshotWriteFailed({
            error,
            message:
              "[@effect/ui] the Router couldn't write the saved state into history.state. It is kept in memory only, so a reload starts the entry fresh."
          })
        )
      }
    }
    // The mounted `Router.prefetch` declarations.
    const declarers = new Set<services.Declarer>()
    /** Runs every declaration covering the location's route, and returns a navigation's checks. */
    const runDeclarations = (
      location: {
        readonly route: { readonly _tag: string }
        readonly url: string
      },
      intent: boolean
    ): Array<services.PrefetchCheck> => {
      const checks: Array<services.PrefetchCheck> = []
      for (const declarer of Array.from(declarers)) {
        const union = declarer.routes()
        const route = union === routes
          ? Option.some(location.route)
          : union.parse(location.url)
        if (Option.isNone(route)) continue
        const check = declarer.run(route.value, intent)
        if (check !== undefined) checks.push(check)
      }
      return checks
    }
    /** Ends the checks of a navigation that won't settle: superseded, or the Router closed. */
    const dropChecks = () => {
      if (pending === undefined) return
      for (const check of pending.checks) check.dropped()
    }
    const listeners = new Set<(location: Location) => void>()
    const wakes: Array<() => void> = []
    const publishQueue: Array<{
      readonly location: Location
      readonly targets: ReadonlyArray<(location: Location) => void>
    }> = []
    let publishing = false
    const publish = (next: Location) => {
      publishQueue.push({ location: next, targets: Array.from(listeners) })
      if (publishing) return
      publishing = true
      try {
        while (publishQueue.length > 0) {
          const { location, targets } = publishQueue.shift()!
          for (const listener of targets) {
            if (listeners.has(listener)) listener(location)
          }
          while (wakes.length > 0) {
            const batch = wakes.splice(0)
            for (const wake of batch) wake()
          }
        }
      } finally {
        publishing = false
      }
    }
    const changes: Stream.Stream<Location> = Stream.fromChannel(
      Channel.fromTransform((_, scope) =>
        Effect.uninterruptible(
          Effect.suspend(() => {
            const pending: Array<Location> = [current]
            let resume:
              | ((
                effect: Effect.Effect<readonly [Location, ...Array<Location>]>
              ) => void)
              | undefined
            const wake = () => {
              if (resume === undefined || pending.length === 0) return
              const r = resume
              resume = undefined
              r(
                Effect.succeed(
                  pending.splice(0) as [Location, ...Array<Location>]
                )
              )
            }
            const listener = (next: Location) => {
              pending.push(next)
              if (resume !== undefined) wakes.push(wake)
            }
            listeners.add(listener)
            const pull = Effect.callback<
              readonly [Location, ...Array<Location>]
            >((r) => {
              if (pending.length > 0) {
                r(
                  Effect.succeed(
                    pending.splice(0) as [Location, ...Array<Location>]
                  )
                )
                return
              }
              resume = r
              return Effect.sync(() => {
                if (resume === r) resume = undefined
              })
            })
            return Effect.as(
              Scope.addFinalizer(
                scope,
                Effect.sync(() => {
                  listeners.delete(listener)
                })
              ),
              pull
            )
          })
        )
      )
    )
    /** Whether a route at `url` is on the current page: the same tag and pathname. */
    const samePage = (route: { readonly _tag: string }, url: string) =>
      route._tag === current.route._tag &&
      pathnameOf(url) === pathnameOf(current.url)
    /**
     * Moves to `next`, which settles later. A push, a link click or a loud replace runs the
     * destination's declarations, after the hydration window closes and before the route changes.
     * `saved`: the Models a pop restores. Set before the route is delivered, which can render at once.
     */
    const set = (
      next: Location,
      mode: {
        readonly quiet: boolean
        readonly scroll: boolean
        readonly blocks?: ReadonlyArray<string> | undefined
      },
      saved?: Record<string, unknown> | undefined
    ) => {
      restoring = saved && { ...saved }
      // First, so whatever the navigation starts sees the cache with the hydration window closed.
      for (const root of roots) root.navigated()
      const runs = next.action === "push" ||
        (next.action === "replace" && !mode.quiet)
      const checks = runs ? runDeclarations(next, false) : []
      const from = pathnameOf(current.url)
      current = next
      const previous = pending
      const blocked = [...(previous?.blocks ?? []), ...(mode.blocks ?? [])]
      if (previous !== undefined && !previous.quiet && mode.quiet) {
        // A quiet navigation before a loud one settled stays on the loud one's page: they settle together, loud.
        pending = {
          ...previous,
          location: next,
          index,
          since: undefined,
          checks: [...previous.checks, ...checks],
          blocks: blocked
        }
      } else {
        dropChecks()
        pending = {
          location: next,
          from,
          index,
          quiet: mode.quiet,
          scroll: mode.scroll,
          since: undefined,
          checks,
          blocks: blocked
        }
      }
      publish(next)
    }

    /** Writes `url` as a new or the current entry, and moves to it. */
    const go = (
      location: Omit<Location, "action" | "seq">,
      replace: boolean,
      mode: {
        readonly quiet: boolean
        readonly scroll: boolean
        readonly blocks?: ReadonlyArray<string> | undefined
      }
    ) => {
      const seq = current.seq + 1
      const href = location.url + location.hash
      if (replace) {
        snapshots.delete(index)
        // A quiet replace stays on the page, so its path is the current one.
        if (mode.quiet) replaceQuiet(href, writeState({ index }))
        else replaceNow(href, writeState({ index }))
      } else {
        leave()
        // The Model snapshot also goes into the entry itself, so it survives a reload. A copy: the one in
        // memory gains the states that encode later, and a history that keeps its state by reference would too.
        writeSnapshot(current.url + current.hash, {
          index,
          snapshot: { ...snapshots.get(index) }
        })
        index++
        for (const key of snapshots.keys()) {
          if (key >= index) snapshots.delete(key)
        }
        history.push(href, writeState({ index }))
      }
      set({ ...location, action: replace ? "replace" : "push", seq }, mode)
    }

    const navigate = (
      href: string,
      replace: boolean,
      source: "href" | "route"
    ): Outcome => {
      if (blocks.size > 0) return "blocked"
      const [url, hash] = split(href)
      const found = routes.resolve(url)
      if (Option.isNone(found)) {
        flush()
        history.load(href)
        return "navigated"
      }
      const route = found.value.route
      const printed = canonical(routes, found.value, url)
      // A route equal to the current one, by tag and printed route, keeps the URL with its undeclared
      // params and isn't a navigation. Only the hash can change.
      if (
        printed === current.url ||
        (route._tag === current.route._tag &&
          routes.print(route) === routes.print(current.route))
      ) {
        if (hash !== current.hash) {
          // A change to the hash alone: a new entry, and no route change.
          if (replace) replaceNow(current.url + hash, writeState({ index }))
          else {
            flush()
            leave()
            index++
            history.push(current.url + hash, writeState({ index }))
          }
          current = { ...current, hash }
          options.onHash?.(hash, "push", index)
        }
        // A followed href delivers the location again, with the same sequence: a navigation that is
        // still settling is left as it is.
        if (source === "href") publish(current)
        return "navigated"
      }
      // A replace that stays on the page is quiet; a push, such as a `?page=2` link, is loud.
      const quiet = replace && samePage(route, printed)
      go({ route, url: printed, hash }, replace, { quiet, scroll: !quiet })
      return "navigated"
    }

    const patch = (
      held: { readonly _tag: string },
      patch: Readonly<Record<string, unknown>>,
      replace: boolean,
      scroll: boolean
    ): PatchOutcome => {
      const at = current.route as {
        readonly _tag: string
        readonly params?: unknown
        readonly search?: unknown
      }
      if (
        at._tag !== held._tag || routes.printPath(at) !== routes.printPath(held)
      ) return "stale"
      const union = routes as Route.AnyUnion & UnionInternals
      const declared = new Set(Object.keys(union.routes[at._tag]?.search ?? {}))
      const search: Record<string, unknown> = {
        ...(at.search as Record<string, unknown> | undefined)
      }
      for (const [key, value] of Object.entries(patch)) {
        if (!declared.has(key)) continue
        if (value === undefined) delete search[key]
        else search[key] = value
      }
      // `make` fills in the default of a param the patch removed.
      const route = union.make({ _tag: at._tag, params: at.params, search })
      // Params the route doesn't declare follow the declared ones, as written.
      const url = withPairs(
        routes.print(route),
        pairsWithout(current.url, declared)
      )
      if (url === current.url) return "navigated"
      go({ route, url, hash: current.hash }, replace, {
        quiet: true,
        scroll,
        blocks: Array.from(blocks.keys())
      })
      return "navigated"
    }

    const popped = (href: string, state: unknown) => {
      // The host has already moved to another entry, which a queued replace would overwrite.
      const left = queued
      queued = undefined
      const entry = readState(state)
      const target = entry?.index ?? 0
      if (reverting > 0) {
        reverting--
        index = target
        if (reverting === 0 && reverted !== undefined) {
          const write = reverted
          reverted = undefined
          if (write.index === target) replaceQuiet(write.url, write.state)
        }
        return
      }
      const [url, hash] = split(href)
      const found = routes.resolve(url)
      const printed = Option.isSome(found)
        ? canonical(routes, found.value, url)
        : undefined
      const quiet = Option.isSome(found) &&
        samePage(found.value.route, printed!)
      // Back and forward can't be blocked, only reverted. Within the page they aren't.
      if (blocks.size > 0 && !quiet) {
        if (target !== index) {
          // Kept before the move back, which a synchronous history reports at once.
          if (left !== undefined) reverted = { index, ...left }
          reverting++
          history.go(index - target)
        }
        return
      }
      if (Option.isNone(found) || printed === undefined) return
      if (printed === current.url) {
        if (hash === current.hash) {
          index = target
          return
        }
        options.onLeave?.(index)
        index = target
        current = { ...current, hash }
        options.onHash?.(hash, "pop", target)
        return
      }
      leave()
      index = target
      const saved = snapshots.get(target) ?? entry?.snapshot
      set({
        route: found.value.route,
        url: printed,
        hash,
        action: "pop",
        seq: current.seq + 1
      }, {
        quiet,
        scroll: true
      }, saved)
    }
    const unlisten = history.listen(popped)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unlisten()
        dropChecks()
        pending = undefined
      })
    )

    const declare = (declarer: services.Declarer) => {
      declarers.add(declarer)
      return () => {
        declarers.delete(declarer)
      }
    }
    const hooks: services.RootHooks = {
      attach: (root) => {
        roots.add(root)
        return () => {
          roots.delete(root)
          forgetRestoring(root)
        }
      },
      restore: (path) => {
        const found = restoring?.[path]
        if (found === undefined) return undefined
        delete restoring![path]
        return {
          state: found,
          reported:
            (restoring!["~reported"] as Record<string, unknown> | undefined)
              ?.[path]
        }
      },
      entry: () => restoring,
      prefetch: (runtime, inst, declared) =>
        prefetchWalk.declare(
          declare,
          prefetchProblems,
          runtime,
          inst,
          declared
        ),
      kernel: routeRun.make,
      afterFlush: (root, info) => {
        if (info.buildsPendingSince(0) === 0) forgetRestoring(root)
        if (
          pending === undefined || pending.since === undefined ||
          root !== primary()
        ) return
        if (
          info.flush < pending.since ||
          info.buildsPendingSince(pending.since) > 0
        ) return
        const done = pending
        pending = undefined
        restoring = undefined
        for (const each of roots) each.restored()
        for (const check of done.checks) check.settled()
        const lost = Array.from(new Set(done.blocks)).filter((key) =>
          !blocks.has(key)
        )
        if (lost.length > 0) {
          report(
            new PatchSearchLostBlock({
              keys: lost,
              message:
                `[@effect/ui] a block held when Router.patchSearch ran is gone now it has settled: ${
                  lost.join(", ")
                }. A page keyed by its search remounts on every patch; key it by printPath instead.`
            })
          )
        }
        options.onSettled?.({
          location: done.location,
          from: done.from,
          index: done.index,
          container: root.container,
          title: info.title,
          quiet: done.quiet,
          scroll: done.scroll
        })
      }
    }

    const router: Router = {
      routes,
      location: () => current,
      changes,
      navigate: (href, navigateOptions) =>
        Effect.sync(() =>
          navigate(href, navigateOptions?.replace === true, "href")
        ),
      push: (route) =>
        Effect.sync(() =>
          navigate(routes.print(route) as string, false, "route")
        ),
      replace: (route) =>
        Effect.sync(() =>
          navigate(routes.print(route) as string, true, "route")
        ),
      patchSearch: (route, search, patchOptions) =>
        Effect.sync(() =>
          patch(
            route,
            search,
            patchOptions?.history !== "push",
            patchOptions?.scroll === true
          )
        ),
      back: Effect.sync(() => {
        if (blocks.size > 0) return "blocked"
        flush()
        history.go(-1)
        return "navigated"
      }),
      forward: Effect.sync(() => {
        if (blocks.size > 0) return "blocked"
        flush()
        history.go(1)
        return "navigated"
      }),
      load: (href) =>
        Effect.sync(() => {
          if (blocks.size > 0) return "blocked"
          flush()
          history.load(href)
          return "navigated"
        }),
      block: (key) =>
        Effect.flatMap(Effect.scope, (scope) => {
          blocks.set(key, (blocks.get(key) ?? 0) + 1)
          return Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              const held = blocks.get(key)! - 1
              if (held === 0) blocks.delete(key)
              else blocks.set(key, held)
            })
          )
        }),
      blocked: () => blocks.size > 0,
      intent: (href) =>
        Effect.sync(() => {
          const [url] = split(href)
          const found = routes.resolve(url)
          if (Option.isNone(found)) return
          // Identity is the printed route: a redirect prefetches its target, and two spellings of one route
          // value are one route. The current route is already mounted.
          const printed = routes.print(found.value.route)
          if (printed === routes.print(current.route)) return
          runDeclarations({ route: found.value.route, url: printed }, true)
        })
    }
    engines.set(router, {
      delivered: (seq) => {
        const root = primary()
        if (
          pending !== undefined && pending.location.seq === seq &&
          pending.since === undefined && root !== undefined
        ) {
          // Delivered inside a flush, the root renders it in that flush; otherwise in the next.
          pending.since = root.since()
        }
      },
      listen: (f) => {
        listeners.add(f)
        return () => {
          listeners.delete(f)
        }
      }
    })
    return Context.make(Router, router).pipe(
      Context.add(services.RootHooks, hooks)
    ) as Context.Context<Router>
  })

/**
 * A history kept in memory, starting at `url`.
 *
 * **Details**
 *
 * `go` reports the entry it lands on synchronously, and does nothing past
 * either end. `load` records the href in `loaded` instead of leaving the page.
 *
 * @stability experimental
 * @category constructors
 * @since 0.1.0
 */
export const memoryHistory = (url: string = "/"): History & {
  readonly entries: () => ReadonlyArray<string>
  readonly index: () => number
  readonly loaded: () => ReadonlyArray<string>
} => {
  const entries: Array<{ url: string; state: unknown }> = [{
    url,
    state: undefined
  }]
  const loaded: Array<string> = []
  const listeners = new Set<(url: string, state: unknown) => void>()
  let index = 0
  return {
    entries: () => entries.map((entry) => entry.url),
    index: () => index,
    loaded: () => loaded,
    current: () => entries[index]!,
    push: (url, state) => {
      entries.splice(index + 1)
      entries.push({ url, state })
      index++
    },
    replace: (url, state) => {
      entries[index] = { url, state }
    },
    go: (delta) => {
      const target = index + delta
      if (delta === 0 || target < 0 || target >= entries.length) return
      index = target
      const entry = entries[index]!
      for (const listener of listeners) listener(entry.url, entry.state)
    },
    load: (href) => {
      loaded.push(href)
    },
    listen: (popped) => {
      listeners.add(popped)
      return () => {
        listeners.delete(popped)
      }
    }
  }
}

/**
 * A Router on an in-memory history, for tests and `TestHost`.
 *
 * **Details**
 *
 * It needs no DOM. Pass your own `memoryHistory` as `history` to inspect the
 * entries, or to move through them as the back button would. A full page
 * load is recorded by the history instead of leaving the page.
 *
 * @stability experimental
 * @category layers
 * @since 0.1.0
 */
export const memory = (options: {
  readonly routes: Route.AnyUnion
  readonly url?: string | undefined
  readonly history?: History | undefined
}): Layer.Layer<Services> =>
  Layer.unwrap(
    Effect.sync(() =>
      make({
        routes: options.routes,
        history: options.history ?? memoryHistory(options.url ?? "/")
      })
    )
  )

const static_ = (
  options: { readonly routes: Route.AnyUnion; readonly url: string }
): Layer.Layer<Services> =>
  Layer.provideMerge(
    commandLayers,
    Layer.effect(
      Router,
      Effect.suspend(() => {
        const [url, hash] = splitHash(options.url)
        const found = options.routes.parse(url)
        if (Option.isNone(found)) {
          return Effect.die(
            new Error(`The Router's routes don't parse "${options.url}"`)
          )
        }
        const location: Location = {
          route: found.value,
          url: options.routes.print(found.value),
          hash,
          action: "initial",
          seq: 0
        }
        const blocked = Effect.succeed<Outcome>("blocked")
        return Effect.succeed<Router>({
          routes: options.routes,
          location: () => location,
          changes: Stream.succeed(location),
          navigate: () => blocked,
          push: () => blocked,
          replace: () => blocked,
          patchSearch: () => blocked,
          back: blocked,
          forward: blocked,
          load: () => blocked,
          block: () => Effect.void,
          blocked: () => false,
          intent: () => Effect.void
        })
      })
    )
  )

export {
  /**
   * A Router fixed at one URL, for server rendering.
   *
   * **Details**
   *
   * Navigation Commands return `"blocked"` and change nothing. The server
   * resolves the URL itself first, to answer a `notFound` route with a 404
   * and a redirect with a 301. `HtmlServerHttp.layerHttp` does both. For a prerendered hash-routing shell, first call
   * `routes.setBase("#")` and render at `"#/"`, so links and keys agree with
   * `BrowserRouter.layerHash` during hydration.
   *
   * @stability experimental
   * @category layers
   * @since 0.1.0
   */
  static_ as static
}
