import { Domain, DomainSearch, SearchUnavailable } from "#domain/Domain"
import { Query } from "@effect/ui"
import { Schema } from "effect"
import { Domains } from "../services/Domains.ts"

export class SearchDomains extends Query.Service<SearchDomains>()(
  "domains/SearchDomains",
  {
    args: DomainSearch.fields,
    success: Schema.Array(Domain),
    error: SearchUnavailable,
    staleTime: "5 minutes"
  }
) {
  static readonly layer = this.toLayer(
    Domains.useSync((domains) => domains.search)
  )
}
