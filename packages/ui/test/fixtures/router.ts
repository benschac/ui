/**
 * A two-page app on the Router: a root that holds the route, a home page, a
 * person page that reads its name through a query, counts its visits (a
 * Command) and counts clicks, and a slow page whose provided Layer takes a
 * second to build.
 */
import {
  Command,
  Component,
  Head,
  Query,
  Route,
  Router,
  UiSchema
} from "@effect/ui"
import { Html, HtmlHead } from "@effect/ui/html"
import { Context, Effect, Layer, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"

export const AppRoute = Route.union(
  {
    Home: Route.make("/"),
    Person: Route.make("/people/:id", { params: { id: Schema.Number } }),
    Slow: Route.make("/slow"),
    NotFound: Route.make("/*")
  },
  Route.redirect(
    "/old/:id",
    (params) => ({
      _tag: "Person",
      params: { id: Number(params.id) },
      search: {}
    })
  )
)
export type AppRoute = typeof AppRoute.Type

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export const Home = Html.component({
  name: "Home",
  model: Schema.Struct({}),
  message: Schema.Never
}).make({
  init: () => ({}),
  update: ($) => $.model,
  head: () => [
    Head.title("Home"),
    HtmlHead.meta({ name: "description", content: "The home page" })
  ],
  view: (h) => h.el("h1", "Home")
})

/**
 * Counts every fetch, so a test can see when a restore refetches. A fetch
 * sleeps `delay` millis first, and fails when `fail` is set.
 */
export const personFetches = { count: 0, delay: 0, fail: false }

export class GetPerson extends Query.Service<GetPerson>()(
  "GetPerson",
  {
    args: { id: Schema.Number },
    success: Schema.String,
    error: Schema.String,
    staleTime: "30 seconds"
  }
) {
  static readonly layer = this.toLayer(({ id }) =>
    Effect.suspend(() => {
      personFetches.count++
      const result = personFetches.fail
        ? Effect.fail(`No person ${id}`)
        : Effect.succeed(`Person ${id}`)
      return personFetches.delay > 0
        ? Effect.andThen(Effect.sleep(personFetches.delay), result)
        : result
    })
  )
}

/** Renames optimistically, and never finishes: the patch stays live. */
export class RenamePerson
  extends Command.Service<RenamePerson>()("RenamePerson", {
    args: { id: Schema.Number },
    success: Schema.Never,
    error: Schema.Never,
    invalidates: () => [],
    optimistic: ({ id }) => [GetPerson.patch({ id }, () => "Renamed")]
  })
{
  static readonly layer = this.toLayer(() => Effect.never)
}

export const PersonMessage = UiSchema.TaggedEnum({
  Loaded: { name: Schema.String },
  Visited: {},
  Bump: {},
  Rename: {},
  Renamed: {}
})

export const CountVisit = Command.make(
  "CountVisit",
  { args: {} },
  () => Effect.succeed(PersonMessage.Visited())
)

export const Person = Html.component({
  name: "Person",
  props: Schema.Struct({ id: Schema.Number }),
  model: Schema.Struct({
    id: Schema.Number,
    name: Schema.String,
    count: Schema.Number,
    visits: Schema.Number
  }),
  message: PersonMessage,
  queries: {
    person: {
      query: GetPerson,
      args: ({ props }) => ({ id: props.id }),
      onChange: (result) =>
        PersonMessage.Loaded({
          name: AsyncResult.isSuccess(result) ? result.value : "Loading"
        })
    }
  }
}).make({
  init: ($) =>
    $.set({ id: $.props.id, name: "Loading", count: 0, visits: 0 }).run(
      CountVisit.make()
    ),
  update: ($, message) =>
    PersonMessage.match(message, {
      Loaded: ({ name }) => ({ ...$.model, name }),
      Rename: () =>
        $.run(
          RenamePerson.make({ id: $.model.id }).pipe(
            Command.map(() => PersonMessage.Renamed())
          )
        ),
      Renamed: () => $.model,
      Visited: () => ({ ...$.model, visits: $.model.visits + 1 }),
      Bump: () => ({ ...$.model, count: $.model.count + 1 })
    }),
  head: (
    { model }
  ) => [
    Head.title(model.name),
    HtmlHead.meta({ name: "description", content: `About ${model.name}` })
  ],
  view: (h, model) =>
    h.el(
      "div",
      h.el("h1", model.name),
      h.queries.person.waiting ? h.el("p", "Refreshing") : null,
      h.el("button").on("click", PersonMessage.Bump()).children(
        `count ${model.count}`
      ),
      h.el("button").on("click", PersonMessage.Rename()).children("Rename")
    )
}).pipe(Component.provide(Layer.merge(GetPerson.layer, RenamePerson.layer)))

export class SlowData
  extends Context.Service<SlowData, { readonly text: string }>()(
    "test/SlowData"
  )
{}

export const Slow = Html.component({
  name: "Slow",
  model: Schema.Struct({}),
  message: Schema.Never
}).make({
  init: () => ({}),
  update: ($) => $.model,
  head: () => [Head.title("Slow")],
  view: (h) => h.el("h1", "Slow")
}).pipe(
  Component.provide(
    Layer.effect(
      SlowData,
      Effect.as(Effect.sleep("1 second"), { text: "ready" })
    )
  )
)

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export const AppMessage = UiSchema.TaggedEnum({
  ChangedRoute: { route: AppRoute },
  Go: { route: AppRoute },
  Back: {},
  Block: {},
  Unblock: {},
  Navigated: { outcome: Schema.Literals(["navigated", "blocked"]) }
})

const navigated = (outcome: Router.Outcome) => AppMessage.Navigated({ outcome })

export const App = Html.component({
  name: "App",
  props: Schema.Struct({ route: AppRoute }),
  model: Schema.Struct({
    route: AppRoute,
    outcomes: Schema.Array(Schema.String),
    blocked: Schema.Boolean
  }),
  message: AppMessage
}).make({
  init: ($) => ({ route: $.props.route, outcomes: [], blocked: false }),
  update: ($, message) =>
    AppMessage.match(message, {
      ChangedRoute: ({ route }) => ({ ...$.model, route }),
      Go: ({ route }) =>
        $.run(Router.push(AppRoute, route).pipe(Command.map(navigated))),
      Back: () => $.run(Router.Back.make().pipe(Command.map(navigated))),
      Block: () => ({ ...$.model, blocked: true }),
      Unblock: () => ({ ...$.model, blocked: false }),
      Navigated: ({ outcome }) => ({
        ...$.model,
        outcomes: [...$.model.outcomes, outcome]
      })
    }),
  subscriptions: ({ model }) => [
    Router.subscription(
      AppRoute,
      model.route,
      (route) => AppMessage.ChangedRoute({ route })
    ),
    model.blocked && Router.blocked("editing")
  ],
  head: () => [
    Head.titleTemplate((title) => `${title} · App`),
    HtmlHead.lang("en")
  ],
  view: (h, model) => {
    const go = (label: string, route: AppRoute) =>
      h.el("button").on("click", AppMessage.Go({ route })).children(label)
    return h.el(
      "div",
      h.el(
        "nav",
        go("Home", AppRoute.Home()),
        go("Person 1", AppRoute.Person({ params: { id: 1 } })),
        go("Person 2", AppRoute.Person({ params: { id: 2 } })),
        go("Slow", AppRoute.Slow()),
        h.el("button").on("click", AppMessage.Back()).children("Back"),
        h.el("button").on("click", AppMessage.Block()).children("Block"),
        h.el("button").on("click", AppMessage.Unblock()).children("Unblock")
      ),
      AppRoute.match(model.route, {
        Home: (route) => Home(h, { key: AppRoute.print(route), props: {} }),
        Person: (route) =>
          Person(h, {
            key: AppRoute.print(route),
            props: { id: route.params.id }
          }),
        Slow: (route) => Slow(h, { key: AppRoute.print(route), props: {} }),
        NotFound: () => h.el("h1", "Not found")
      })
    )
  }
})
