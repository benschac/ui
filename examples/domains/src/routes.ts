import { labelOf } from "#domain/Domain"
import { Route } from "@effect/ui"
import { Schema } from "effect"

export const AppRoute = Route.union({
  Search: Route.make("/", { search: { q: Schema.optional(Schema.String) } }),
  NotFound: Route.make("/*")
})
export type AppRoute = typeof AppRoute.Type

export const homeUrl = AppRoute.print(AppRoute.Search({ search: {} }))

export const queryOf = (route: AppRoute): string =>
  route._tag === "Search" ? route.search.q ?? "" : ""

export const labelOfRoute = (route: AppRoute): string | undefined =>
  labelOf(queryOf(route))
