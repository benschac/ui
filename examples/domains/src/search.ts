import { type Domain, labelOf, type SearchUnavailable } from "#domain/Domain"
import { mergeDomainsByName } from "#domain/Listing"
import { AsyncResult } from "effect/reactivity"

export type DomainsResult = AsyncResult.AsyncResult<
  ReadonlyArray<Domain>,
  SearchUnavailable
>

export type SearchState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Invalid" }
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failed" }
  | {
    readonly _tag: "Ready"
    readonly domains: ReadonlyArray<Domain>
    readonly loading: boolean
    readonly failed: boolean
  }

export const invalidQueryMessage =
  "Enter a domain name using letters, numbers, and hyphens (up to 63 characters)."
export const failedSearchMessage =
  "Could not load sample domains. Please try again."

export const searchState = (
  query: string,
  top: DomainsResult,
  ranges: ReadonlyArray<{ readonly result: DomainsResult }>
): SearchState => {
  if (query === "") return { _tag: "Idle" }
  if (labelOf(query) === undefined) return { _tag: "Invalid" }
  const results = [top, ...ranges.map((entry) => entry.result)]
  const settled = results.filter(AsyncResult.isSuccess)
  if (settled.length === 0) {
    return AsyncResult.isFailure(top) && !top.waiting
      ? { _tag: "Failed" }
      : { _tag: "Loading" }
  }
  return {
    _tag: "Ready",
    domains: settled.reduce<ReadonlyArray<Domain>>(
      (domains, result) => mergeDomainsByName(domains, result.value),
      []
    ),
    loading: results.some((result) =>
      result.waiting || AsyncResult.isInitial(result)
    ),
    failed: results.some((result) =>
      AsyncResult.isFailure(result) && !result.waiting
    )
  }
}
