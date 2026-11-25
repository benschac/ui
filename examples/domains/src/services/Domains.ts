import {
  type Domain,
  type DomainSearch,
  searchSample,
  SearchUnavailable
} from "#domain/Domain"
import { Context, Effect, Layer } from "effect"
import { HttpApiClient } from "effect/http-api"
import { DomainsApi } from "../api/DomainsApi.ts"

export class Domains extends Context.Service<Domains, {
  search(
    search: DomainSearch
  ): Effect.Effect<ReadonlyArray<Domain>, SearchUnavailable>
}>()("domains/Domains") {
  static readonly layerHttp = Layer.effect(
    Domains,
    Effect.gen(function*() {
      const client = yield* HttpApiClient.make(DomainsApi)
      return Domains.of({
        search: Effect.fn("Domains.search")(
          (query) => client.domains.search({ query }),
          Effect.mapError(() => new SearchUnavailable())
        )
      })
    })
  )

  static readonly layerSample = Layer.succeed(Domains)(
    Domains.of({ search: (search) => Effect.sync(() => searchSample(search)) })
  )
}
