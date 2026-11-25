import { Array, Order, Schema } from "effect"
import {
  type AvailableDomain,
  type Domain,
  domainCandidates,
  type DomainName,
  type DomainRange,
  domainTlds,
  labelOf
} from "./Domain.ts"

export interface DomainListing extends DomainName {
  readonly domain: Domain | undefined
}

export const TldFilter = Schema.String
export type TldFilter = typeof TldFilter.Type

export const AvailabilityFilter = Schema.Literals(["All", "Available"])
export type AvailabilityFilter = typeof AvailabilityFilter.Type

export const SortOrder = Schema.Literals([
  "Relevance",
  "Length",
  "PriceAscending",
  "PriceDescending",
  "Alphabetical"
])
export type SortOrder = typeof SortOrder.Type

export const TOP_RESULT_COUNT = 4
const DOMAIN_PAGE_SIZE = 60

export const topRange: DomainRange = { offset: 0, limit: TOP_RESULT_COUNT }
export const catalogRange: DomainRange = { offset: 0, limit: domainTlds.length }

export const isCompleteCatalogRequired = (
  availability: AvailabilityFilter,
  sort: SortOrder
): boolean =>
  availability === "Available" || sort === "PriceAscending" ||
  sort === "PriceDescending"

export const pageOfTld = (tld: string): number =>
  Math.floor(Math.max(0, domainTlds.indexOf(tld)) / DOMAIN_PAGE_SIZE)

export const rangeOfPage = (page: number): DomainRange => {
  if (page === 0) {
    return {
      offset: TOP_RESULT_COUNT,
      limit: DOMAIN_PAGE_SIZE - TOP_RESULT_COUNT
    }
  }
  const offset = page * DOMAIN_PAGE_SIZE
  return {
    offset,
    limit: Math.min(DOMAIN_PAGE_SIZE, domainTlds.length - offset)
  }
}

export const queryToListings = (
  query: string,
  domains?: ReadonlyMap<string, Domain>
): ReadonlyArray<DomainListing> =>
  domainCandidates(labelOf(query) ?? "").map((candidate) => ({
    ...candidate,
    domain: domains?.get(candidate.name)
  }))

const nameOrder = Order.mapInput(
  Order.String,
  (domain: DomainName) => domain.name
)
const lengthOrder = Order.combine(
  Order.mapInput(Order.Number, (domain: DomainName) => domain.name.length),
  nameOrder
)
const availabilityOrder = Order.mapInput(
  Order.Number,
  ({ domain }: DomainListing) =>
    domain === undefined ? 2 : domain._tag === "Unavailable" ? 1 : 0
)
const priceOrder = Order.mapInput(
  Order.Number,
  ({ domain }: DomainListing) => domain?._tag === "Available" ? domain.price : 0
)

export const filterAndSortListings = (
  listings: ReadonlyArray<DomainListing>,
  tldFilter: TldFilter,
  availability: AvailabilityFilter,
  sort: SortOrder
): ReadonlyArray<DomainListing> => {
  const matching = listings.filter((listing) =>
    (tldFilter === "All" || listing.tld === tldFilter) &&
    (availability === "All" || listing.domain?._tag !== "Unavailable")
  )
  switch (sort) {
    case "Relevance":
      return matching
    case "Length":
      return Array.sort(matching, lengthOrder)
    case "Alphabetical":
      return Array.sort(matching, nameOrder)
    case "PriceAscending":
      return Array.sort(matching, Order.combine(availabilityOrder, priceOrder))
    case "PriceDescending":
      return Array.sort(
        matching,
        Order.combine(availabilityOrder, Order.flip(priceOrder))
      )
  }
}

export const formatPrice = (price: number): string => `$${price.toFixed(2)}`

export const formatRegistrationPrice = (domain: AvailableDomain): string =>
  domain.years === 1
    ? formatPrice(domain.price)
    : `${formatPrice(domain.price)} / ${domain.years} years`

export const formatRenewalPrice = (domain: AvailableDomain): string =>
  `Renews at ${formatPrice(domain.renewalPrice)} for ${
    domain.years === 1 ? "1 year" : `${domain.years} years`
  }`
