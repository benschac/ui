import { Effect, Layer } from "effect"
import { HttpServer } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { DomainsApi } from "../api/DomainsApi.ts"
import { Domains } from "../services/Domains.ts"

const DomainsHandlers = HttpApiBuilder.group(
  DomainsApi,
  "domains",
  Effect.fn(function*(handlers) {
    const domains = yield* Domains
    return handlers.handle("search", ({ query }) => domains.search(query))
  })
)

export const DomainsApiLive = HttpApiBuilder.layer(DomainsApi).pipe(
  Layer.provide([DomainsHandlers, HttpServer.layerServices])
)
