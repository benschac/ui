import { Domain, DomainSearch, SearchUnavailable } from "#domain/Domain"
import { Schema } from "effect"
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema
} from "effect/http-api"

export class DomainsApi extends HttpApi.make("domains").add(
  HttpApiGroup.make("domains").add(
    HttpApiEndpoint.get("search", "/api/domains", {
      query: DomainSearch.fields,
      success: Schema.Array(Domain),
      error: SearchUnavailable.pipe(HttpApiSchema.status(503))
    })
  )
) {}
