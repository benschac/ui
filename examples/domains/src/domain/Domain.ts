import { Array, Schema } from "effect"
import { supportedTlds } from "./tld.ts"

export const DomainName = Schema.Struct({
  name: Schema.String,
  tld: Schema.String
})
export type DomainName = typeof DomainName.Type

const Price = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

export const Domain = Schema.TaggedUnion({
  Available: {
    ...DomainName.fields,
    price: Price,
    renewalPrice: Price,
    years: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
    isPremium: Schema.Boolean
  },
  Unavailable: DomainName.fields
})
export type Domain = typeof Domain.Type

export const AvailableDomain = Domain.cases.Available
export type AvailableDomain = typeof AvailableDomain.Type

const samplePrices: Readonly<Record<string, number>> = {
  com: 12,
  dev: 12,
  app: 9.99,
  io: 34.99,
  ai: 80,
  xyz: 2.99,
  org: 9.99,
  me: 13.99,
  net: 13.5,
  tech: 7.99,
  space: 1.99,
  cloud: 7.99,
  studio: 21.99,
  sh: 33,
  design: 39.99,
  co: 25.99,
  site: 1.99,
  online: 3.99,
  store: 4.99,
  agency: 5.99,
  world: 3.99,
  run: 19.99,
  page: 9.99,
  tools: 24.99
}

const featuredTlds = Object.keys(samplePrices)

export const domainTlds: ReadonlyArray<string> = Array.union(
  featuredTlds,
  supportedTlds
)

export const DomainLabel = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
)

export const normalizeLabel = (query: string): string =>
  query.trim().toLowerCase().replace(/^https?:\/\//, "").split(/[./]/)[0] ?? ""

export const labelOf = (query: string): string | undefined => {
  const label = normalizeLabel(query)
  return Schema.is(DomainLabel)(label) ? label : undefined
}

export const domainCandidates = (label: string): ReadonlyArray<DomainName> =>
  domainTlds.map((tld) => ({ name: `${label}.${tld}`, tld }))

const takenLabels: ReadonlyArray<string> = [
  "vercel",
  "google",
  "github",
  "foldkit"
]
const takenTlds: ReadonlyArray<string> = ["com", "dev"]

export const DomainRange = Schema.Struct({
  offset: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: domainTlds.length - 1 })
  ),
  limit: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: domainTlds.length })
  )
})
export type DomainRange = typeof DomainRange.Type

export const DomainSearch = Schema.Struct({
  label: DomainLabel,
  ...DomainRange.fields
})
export type DomainSearch = typeof DomainSearch.Type

export const searchSample = (
  { label, limit, offset }: DomainSearch
): ReadonlyArray<Domain> =>
  domainCandidates(label).slice(offset, offset + limit).map((domain) => {
    if (takenLabels.includes(label) && takenTlds.includes(domain.tld)) {
      return Domain.cases.Unavailable.make(domain)
    }
    const price = samplePrices[domain.tld] ?? 19.99
    return Domain.cases.Available.make({
      ...domain,
      price,
      renewalPrice: price,
      years: 1,
      isPremium: false
    })
  })

export class SearchUnavailable
  extends Schema.TaggedError<SearchUnavailable>()("SearchUnavailable", {})
{}
