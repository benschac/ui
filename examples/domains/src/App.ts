import {
  AvailableDomain,
  type Domain,
  type DomainName,
  domainTlds
} from "#domain/Domain"
import {
  AvailabilityFilter,
  catalogRange,
  type DomainListing,
  filterAndSortListings,
  formatPrice,
  formatRegistrationPrice,
  formatRenewalPrice,
  isCompleteCatalogRequired,
  pageOfTld,
  queryToListings,
  rangeOfPage,
  SortOrder,
  TldFilter,
  TOP_RESULT_COUNT,
  topRange
} from "#domain/Listing"
import { SearchDomains } from "#queries/SearchDomains"
import {
  Command,
  Component,
  Head,
  Router,
  UiSchema,
  UiStruct
} from "@effect/ui"
import { Dialog, Select, type SelectItem, VirtualList } from "@effect/ui-kit"
import { Html, HtmlCommand, HtmlHead } from "@effect/ui/html"
import { Array, Effect, Order, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { bootstrapConfig } from "./bootstrap.ts"
import { Icon, Logo } from "./components/Icon.ts"
import { NotFoundPage } from "./pages/NotFoundPage.ts"
import { AppRoute, homeUrl, labelOfRoute, queryOf } from "./routes.ts"
import {
  failedSearchMessage,
  invalidQueryMessage,
  searchState
} from "./search.ts"

const PREVIEW_RESULT_COUNT = 36
const VISIBLE_MARGIN = 12
const TOUCH_MEDIA_QUERY = "(hover: none) and (pointer: coarse)"

const SearchLayout = Schema.Literals(["Landing", "Search"])

const Visible = Schema.Struct({ first: Schema.Number, last: Schema.Number })

const Popup = Schema.Literals([
  "Cart",
  "Filters",
  "TldDialog",
  "TldListbox",
  "AvailabilityListbox",
  "SortListbox"
])
type Popup = typeof Popup.Type

export const AppMessage = UiSchema.TaggedEnum({
  ChangedRoute: { route: AppRoute },
  UpdatedSearch: { value: Schema.String },
  SubmittedSearch: {},
  PressedEscape: {},
  ClickedClearSearch: {},
  ClickedDomainsHome: {},
  ScrolledResults: Visible.fields,
  RequestedOpenPopup: { popup: Popup },
  RequestedClosePopup: { popup: Popup },
  PickedTldFilter: { value: TldFilter },
  PickedAvailabilityFilter: { value: AvailabilityFilter },
  PickedSortOrder: { value: SortOrder },
  UpdatedTldSearch: { value: Schema.String },
  ClickedAddDomain: { domain: AvailableDomain },
  ClickedRemoveDomain: { name: Schema.String },
  ClickedRemoveCartDomain: { name: Schema.String },
  ClickedRetrySearch: {}
})
export type AppMessage = typeof AppMessage.Type

export const AppModel = Schema.Struct({
  route: AppRoute,
  query: Schema.String,
  layout: SearchLayout,
  visible: Visible,
  pages: Schema.Array(Schema.Number),
  catalog: Schema.Boolean,
  tldFilter: TldFilter,
  availability: AvailabilityFilter,
  sort: SortOrder,
  popup: Schema.NullOr(Popup),
  cart: Schema.Array(AvailableDomain),
  tldSearch: Schema.String
})
export type AppModel = typeof AppModel.Type

const SearchInput = Html.ref("SearchInput", "input")
const CartCloseButton = Html.ref("CartCloseButton", "button")

export const RetrySearch = Command.make(
  "domains/RetrySearch",
  { args: {} },
  () => Effect.as(SearchDomains.invalidate(), Component.noop)
)

const DismissSearchKeyboard = Command.make(
  "domains/DismissSearchKeyboard",
  { args: {} },
  () =>
    Effect.sync(() => {
      const active = document.activeElement
      if (
        window.matchMedia(TOUCH_MEDIA_QUERY).matches &&
        active instanceof HTMLInputElement
      ) active.blur()
      return Component.noop
    })
)

const noPages = {
  visible: { first: 0, last: PREVIEW_RESULT_COUNT - 1 },
  pages: [],
  catalog: false
}

const withVisiblePages = (model: AppModel): AppModel => {
  if (labelOfRoute(model.route) === undefined) return model
  if (isCompleteCatalogRequired(model.availability, model.sort)) {
    return model.catalog ? model : UiStruct.evolve(model, { catalog: true })
  }
  const listings = filterAndSortListings(
    queryToListings(queryOf(model.route)),
    model.tldFilter,
    "All",
    model.sort
  )
  const pages = new Set(model.pages)
  const last = Math.min(
    listings.length - 1,
    model.visible.last + VISIBLE_MARGIN
  )
  for (
    let index = Math.max(0, model.visible.first - VISIBLE_MARGIN);
    index <= last;
    index++
  ) {
    pages.add(pageOfTld(listings[index]!.tld))
  }
  return pages.size === model.pages.length
    ? model
    : UiStruct.evolve(model, { pages: Array.sort(pages, Order.Number) })
}

const withRoute = (model: AppModel, route: AppRoute): AppModel => {
  const query = queryOf(route)
  const next = UiStruct.evolve(model, {
    route,
    query,
    layout: (layout) => query === "" ? layout : "Search"
  })
  return labelOfRoute(route) === labelOfRoute(model.route)
    ? next
    : withVisiblePages(UiStruct.evolve(next, noPages))
}

const availabilityLabels: Readonly<Record<AvailabilityFilter, string>> = {
  All: "Show All",
  Available: "Available"
}

const sortLabels: Readonly<Record<SortOrder, string>> = {
  Relevance: "Relevance",
  Length: "Length",
  Alphabetical: "Alphabetical",
  PriceAscending: "Price: Low to High",
  PriceDescending: "Price: High to Low"
}

const mobileSortOrders: ReadonlyArray<SortOrder> = [
  "Relevance",
  "Length",
  "PriceAscending",
  "Alphabetical"
]

const tldFilterLabel = (value: TldFilter): string =>
  value === "All" ? "All TLDs" : "." + value

const tldFilters: ReadonlyArray<TldFilter> = [
  "All",
  ...Array.sort(domainTlds, Order.String)
]

const visibleTldFilters = (search: string): ReadonlyArray<TldFilter> => {
  const needle = search.trim().toLowerCase().replace(/^\./, "")
  return tldFilters.filter((value) =>
    tldFilterLabel(value).toLowerCase().includes(needle)
  )
}

const itemsOf = <A extends string>(
  values: ReadonlyArray<A>,
  label: (value: A) => string
) => values.map((value) => ({ value, label: label(value) }))

const availabilityItems = itemsOf(
  AvailabilityFilter.literals,
  (value) => availabilityLabels[value]
)
const sortItems = itemsOf(SortOrder.literals, (value) => sortLabels[value])
const tldItems = itemsOf(tldFilters, tldFilterLabel)

const titleOf = (route: AppRoute): string => {
  if (route._tag === "NotFound") return "Not Found | Domains | Foldkit"
  const query = queryOf(route)
  return query === "" ? "Domains | Foldkit" : query + " | Domains | Foldkit"
}

const AppDef = Html.component({
  name: "App",
  props: Schema.Struct({ route: AppRoute }),
  model: AppModel,
  message: AppMessage,
  queries: {
    top: {
      query: SearchDomains,
      args: ({ model }) => {
        const label = labelOfRoute(model.route)
        return label === undefined ? undefined : { label, ...topRange }
      },
      debounce: "150 millis"
    },
    ranges: {
      queryMany: SearchDomains,
      args: ({ model, queries }) => {
        const label = labelOfRoute(model.route)
        if (label === undefined || !AsyncResult.isSuccess(queries.top)) {
          return []
        }
        if (model.catalog) return [{ label, ...catalogRange }]
        return model.pages.map((page) => ({ label, ...rangeOfPage(page) }))
      }
    }
  }
})

const SearchForm = AppDef.fragment((h, model: AppModel) => {
  const invalid = queryOf(model.route) !== "" &&
    labelOfRoute(model.route) === undefined
  return h.form.class("search").attr("role", "search").on(
    "submit",
    AppMessage.SubmittedSearch()
  ).children(
    Icon(h, "search"),
    h.input.ref(SearchInput).attrs({
      id: bootstrapConfig.inputId,
      type: "search",
      name: "q",
      "aria-label": "Search domains",
      "aria-invalid": String(invalid),
      placeholder: "Search for a domain",
      autocomplete: "off",
      autocapitalize: "none",
      enterkeyhint: "search",
      spellcheck: "false"
    })
      .attr("aria-describedby", invalid ? "search-error" : undefined)
      .value(model.query)
      .on("input", ({ value }) => AppMessage.UpdatedSearch({ value }))
      .on("keydown", ({ composing, key }) =>
        key === "Escape" && !composing
          ? AppMessage.PressedEscape()
          : undefined, { preventDefault: true }),
    h.button.attrs({
      type: "button",
      "aria-label": "Clear search, Esc",
      "aria-keyshortcuts": "Escape"
    })
      .class("clear-search")
      .on("click", AppMessage.ClickedClearSearch())
      .children(
        h.kbd.attr("aria-hidden", "true").children("Esc"),
        Icon(h, "close")
      )
  )
})

const CartDialog = AppDef.fragment((h, model: AppModel) => {
  const total = model.cart.reduce((sum, domain) => sum + domain.price, 0)
  return Dialog(h, {
    key: "cart",
    props: { open: model.popup === "Cart" },
    onEmit: {
      RequestedOpen: () => AppMessage.RequestedOpenPopup({ popup: "Cart" }),
      RequestedClose: () => AppMessage.RequestedClosePopup({ popup: "Cart" }),
      Settled: () => undefined
    },
    view: (dialog) =>
      h.div.class("ml-auto flex items-center gap-2 max-[700px]:gap-1.5")
        .children(
          dialog.trigger(
            h.button.attrs({
              id: "cart-button",
              "aria-label": "Cart, " + model.cart.length + " domains"
            })
              .class("button cart-button")
          ).children(
            Icon(h, "cart"),
            h.span("Cart"),
            model.cart.length > 0 &&
              h.span.class("cart-count").children(String(model.cart.length))
          ),
          dialog.portal(h.dialog.class("dialog-overlay"))?.children(
            dialog.backdrop(h.div.class("dialog-backdrop")),
            dialog.popup(h.div.class("cart-panel")).children(
              h.div.class("cart-heading").children(
                dialog.title(h.h2).children("Your cart"),
                dialog.close(
                  dialog.initialFocus(
                    h.button.ref(CartCloseButton).attrs({
                      id: "cart-close-button",
                      "aria-label": "Close cart panel"
                    })
                      .class("icon-button")
                  )
                ).children(Icon(h, "close"))
              ),
              model.cart.length === 0
                ? h.p.class("empty-cart").children(
                  "Your next idea starts with a name. Search for a domain to add it here."
                )
                : h.ul.class("cart-items").children(
                  model.cart.map((domain) =>
                    h.li.key(domain.name).children(
                      h.div(
                        h.strong(domain.name),
                        h.span(formatRegistrationPrice(domain)),
                        h.span.class("mt-1 block text-xs text-gray-400")
                          .children(formatRenewalPrice(domain))
                      ),
                      h.button.attrs({
                        type: "button",
                        "aria-label": "Remove " + domain.name
                      })
                        .class("icon-button")
                        .on(
                          "click",
                          AppMessage.ClickedRemoveCartDomain({
                            name: domain.name
                          })
                        )
                        .children(Icon(h, "close"))
                    )
                  )
                ),
              h.div.class("cart-total").children(
                h.span("Registration total"),
                h.strong(formatPrice(total))
              ),
              dialog.description(h.p.class("demo-note")).children(
                "Demo cart with sample prices and availability. No domains are reserved. No purchases are made."
              )
            )
          )
        )
  })
})

const Header = AppDef.fragment((h, model: AppModel) =>
  h.header.class("header").children(
    h.a.attrs({ href: homeUrl, "aria-label": "Domains home" })
      .class("brand")
      .on("click", AppMessage.ClickedDomainsHome())
      .children(
        Logo(h),
        h.span.class("brand-divider").children("/"),
        h.span("Domains")
      ),
    h.span.class("demo-label").children("Unofficial demo"),
    CartDialog(h, model),
    h.p.attrs({
      id: "cart-announcement",
      "aria-live": "polite",
      "aria-atomic": "true"
    }).class("sr-only").children(
      model.cart.length === 0
        ? "Your cart is empty."
        : model.cart.length + " " +
          (model.cart.length === 1 ? "domain" : "domains") + " in your cart."
    )
  )
)

const Hero = AppDef.fragment((h, model: AppModel) =>
  h.section.class("hero").attr("aria-label", "Find your domain").children(
    h.h1("Find a domain for", h.br, h.span("the next viral idea.")),
    h.p(
      "Sample data. ",
      h.a.attr("href", "https://vercel.com/domains/pricing").children(
        "Vercel pricing"
      )
    ),
    SearchForm(h, model),
    h.div.class("hero-search-space")
  )
)

const DomainNameText = AppDef.fragment((h, domain: DomainName) => [
  h.span.attr("data-domain-label", "").children(
    domain.name.slice(0, -(domain.tld.length + 1))
  ),
  "." + domain.tld
])

const DomainAction = AppDef.fragment(
  (h, model: AppModel, domain: Domain | undefined) => {
    if (domain === undefined) {
      return h.div.class("domain-action").attr("aria-hidden", "true").children(
        h.span.class("skeleton skeleton-price"),
        h.span.class("skeleton skeleton-action")
      )
    }
    if (domain._tag === "Unavailable") {
      return h.div.class("domain-action").children(
        h.span.class("unavailable").attr(
          "title",
          "This sample domain is marked unavailable in the demo data."
        )
          .children("Not available")
      )
    }
    const inCart = model.cart.some((item) => item.name === domain.name)
    const premium = domain.isPremium ? "Premium domain. " : ""
    return h.div.class("domain-action").children(
      h.span.class("price").attr("title", premium + formatRenewalPrice(domain))
        .children(formatRegistrationPrice(domain)),
      h.button.attrs({
        type: "button",
        "aria-label": inCart
          ? "Remove " + domain.name + " from cart"
          : "Add " + domain.name + " to cart",
        "aria-description": formatRegistrationPrice(domain) + ". " + premium +
          formatRenewalPrice(domain)
      })
        .class("icon-button", inCart && "is-added")
        .on(
          "click",
          inCart
            ? AppMessage.ClickedRemoveDomain({ name: domain.name })
            : AppMessage.ClickedAddDomain({ domain })
        )
        .children(Icon(h, inCart ? "check" : "cart"))
    )
  }
)

interface FilterSelectOptions {
  readonly popup: Popup
  readonly label: string
  readonly value: string
  readonly items: ReadonlyArray<SelectItem>
  readonly picked: (value: string) => AppMessage | undefined
}

const FilterSelect = AppDef.fragment(
  (h, model: AppModel, options: FilterSelectOptions) => {
    const open = model.popup === options.popup
    return Select(h, {
      key: options.popup,
      props: {
        open,
        value: options.value,
        items: options.items,
        alignItemWithTrigger: false,
        side: "bottom",
        align: "end",
        sideOffset: 6,
        collisionPadding: 8
      },
      onEmit: {
        RequestedOpen: () =>
          AppMessage.RequestedOpenPopup({ popup: options.popup }),
        RequestedClose: () =>
          AppMessage.RequestedClosePopup({ popup: options.popup }),
        Picked: ({ value }) => options.picked(String(value)),
        Settled: () => undefined
      },
      view: (select) =>
        h.div.class("filter-listbox").children(
          select.trigger(
            h.button.class("filter-trigger").attr(
              "aria-label",
              options.label + ": " +
                (options.items.find((item) => item.value === options.value)
                  ?.label ?? "")
            )
          ).children(
            h.span.class("filter-trigger-content").children(
              select.value(h.span.class("filter-trigger-label")),
              Icon(h, "chevron-down")
            )
          ),
          select.positioner(h.div.class("filter-positioner")).children(
            select.popup(h.div.class("filter-options")).children(
              open && options.items.map((item) =>
                select.item({
                  element: h.div.class("filter-option"),
                  value: item.value
                }).children(
                  h.div.class("filter-option-content").children(
                    h.span.class("filter-option-check").children(
                      Icon(h, "check")
                    ),
                    select.itemText(h.div).children(item.label)
                  )
                )
              )
            )
          )
        )
    })
  }
)

const isAvailabilityFilter = Schema.is(AvailabilityFilter)
const isSortOrder = Schema.is(SortOrder)

const FilterChoice = AppDef.fragment((
  h,
  label: string,
  selected: boolean,
  message: AppMessage
) =>
  h.button.key(label).attrs({
    type: "button",
    "aria-pressed": String(selected)
  })
    .class("filter-choice")
    .on("click", message)
    .children(
      h.span(label),
      h.span.class("filter-choice-check").attr("aria-hidden", "true").children(
        Icon(h, "check")
      )
    )
)

const TldDialog = AppDef.fragment((h, model: AppModel) =>
  Dialog(h, {
    key: "tld",
    props: { open: model.popup === "TldDialog" },
    onEmit: {
      RequestedOpen: () =>
        AppMessage.RequestedOpenPopup({ popup: "TldDialog" }),
      RequestedClose: () =>
        AppMessage.RequestedClosePopup({ popup: "TldDialog" }),
      Settled: () => undefined
    },
    view: (dialog) => {
      const values = visibleTldFilters(model.tldSearch)
      return h.div.class("contents").children(
        dialog.trigger(
          h.button.attrs({
            id: "mobile-tld-filter",
            "aria-label": "Filter by TLD: " + tldFilterLabel(model.tldFilter)
          }).class("filter-trigger mobile-tld-filter")
        ).children(
          h.span.class("filter-trigger-content").children(
            h.span.class("filter-trigger-label").children(
              tldFilterLabel(model.tldFilter)
            ),
            Icon(h, "chevron-down")
          )
        ),
        dialog.portal(h.dialog.class("dialog-overlay"))?.children(
          dialog.backdrop(h.div.class("dialog-backdrop filters-backdrop")),
          dialog.popup(h.div.class("filters-panel tld-panel")).children(
            dialog.title(h.h2.class("sr-only")).children("Filter by TLD"),
            h.div.class("tld-search").children(
              Icon(h, "search"),
              dialog.initialFocus(
                h.input.attrs({
                  type: "search",
                  "aria-label": "Search TLDs",
                  placeholder: "Search TLDs...",
                  autocomplete: "off"
                })
              ).value(model.tldSearch).on(
                "input",
                ({ value }) => AppMessage.UpdatedTldSearch({ value })
              )
            ),
            h.div.class("tld-options").children(
              values.length === 0
                ? h.p.class("tld-no-results").attr("role", "status").children(
                  "No TLDs found."
                )
                : values.map((value) =>
                  FilterChoice(
                    h,
                    tldFilterLabel(value),
                    value === model.tldFilter,
                    AppMessage.PickedTldFilter({ value })
                  )
                )
            ),
            dialog.close(
              h.button.class("filters-close").attr(
                "aria-label",
                "Close TLD filter"
              )
            ).children(
              Icon(h, "close")
            )
          )
        )
      )
    }
  })
)

const FiltersDialog = AppDef.fragment((h, model: AppModel) =>
  Dialog(h, {
    key: "filters",
    props: { open: model.popup === "Filters" },
    onEmit: {
      RequestedOpen: () => AppMessage.RequestedOpenPopup({ popup: "Filters" }),
      RequestedClose: () =>
        AppMessage.RequestedClosePopup({ popup: "Filters" }),
      Settled: () => undefined
    },
    view: (dialog) =>
      h.div.class("contents").children(
        dialog.trigger(
          h.button.attrs({
            id: "filters-button",
            "aria-label": "Filters and sort"
          })
            .class(
              "filters-button",
              (model.availability !== "All" || model.sort !== "Relevance") &&
                "has-active-filters"
            )
        ).children(Icon(h, "filter")),
        dialog.portal(h.dialog.class("dialog-overlay"))?.children(
          dialog.backdrop(h.div.class("dialog-backdrop filters-backdrop")),
          dialog.popup(h.div.class("filters-panel")).children(
            dialog.title(h.h2.class("sr-only")).children("Filters and sort"),
            h.div.attrs({
              role: "group",
              "aria-labelledby": "availability-filter-heading"
            }).children(
              h.h3.attr("id", "availability-filter-heading").class(
                "filter-group-label"
              ).children("Filter by"),
              AvailabilityFilter.literals.map((value) => {
                const choice = FilterChoice(
                  h,
                  availabilityLabels[value],
                  value === model.availability,
                  AppMessage.PickedAvailabilityFilter({ value })
                )
                return value === model.availability
                  ? dialog.initialFocus(choice)
                  : choice
              })
            ),
            h.hr.class("filter-group-divider"),
            h.div.attrs({
              role: "group",
              "aria-labelledby": "sort-order-heading"
            }).children(
              h.h3.attr("id", "sort-order-heading").class("filter-group-label")
                .children("Sort by"),
              mobileSortOrders.map((value) =>
                FilterChoice(
                  h,
                  value === "PriceAscending" ? "Price" : sortLabels[value],
                  value === model.sort ||
                    (value === "PriceAscending" &&
                      model.sort === "PriceDescending"),
                  AppMessage.PickedSortOrder({ value })
                )
              )
            ),
            dialog.close(
              h.button.class("filters-close").attr(
                "aria-label",
                "Close filters and sort"
              )
            ).children(
              Icon(h, "close")
            )
          )
        )
      )
  })
)

const Filters = AppDef.fragment((h, model: AppModel) =>
  h.div.class("filters").children(
    h.div.class("desktop-tld-filter").children(
      FilterSelect(h, model, {
        popup: "TldListbox",
        label: "Filter by TLD",
        value: model.tldFilter,
        items: tldItems,
        picked: (value) => AppMessage.PickedTldFilter({ value })
      })
    ),
    TldDialog(h, model),
    h.div.class("desktop-filters").children(
      FilterSelect(h, model, {
        popup: "AvailabilityListbox",
        label: "Filter availability",
        value: model.availability,
        items: availabilityItems,
        picked: (value) =>
          isAvailabilityFilter(value)
            ? AppMessage.PickedAvailabilityFilter({ value })
            : undefined
      }),
      FilterSelect(h, model, {
        popup: "SortListbox",
        label: "Sort results",
        value: model.sort,
        items: sortItems,
        picked: (value) =>
          isSortOrder(value) ? AppMessage.PickedSortOrder({ value }) : undefined
      })
    ),
    FiltersDialog(h, model)
  )
)

const ResultsList = AppDef.fragment((
  h,
  model: AppModel,
  results: ReadonlyArray<DomainListing>
) =>
  h.div.class("all-results").children(
    queryOf(model.route) !== "" && VirtualList(h, {
      props: {
        itemSize: 57,
        keys: results.map((listing) => listing.name),
        overscan: 2,
        initialCount: PREVIEW_RESULT_COUNT,
        dataset: labelOfRoute(model.route) ?? ""
      },
      onEmit: {
        Scrolled: ({ first, last }) =>
          AppMessage.ScrolledResults({ first, last })
      },
      view: (virtualList) =>
        virtualList.list(
          h.ul.attrs({
            id: "domain-results",
            "aria-label": "All domain results",
            "aria-description": results.length +
              " domains. Use arrow keys, Page Up, Page Down, Home, and End to scroll the page.",
            tabindex: "0"
          }).class(
            "results-viewport",
            results.length === 1 && "is-single-result"
          )
        ).children(
          virtualList.items.map((index) => {
            const listing = results[index]!
            return virtualList.item({
              element: h.li.key(listing.name).class(
                "domain-row",
                listing.domain?._tag === "Unavailable" && "is-unavailable"
              ),
              index
            }).children(
              h.span.class("domain-name").children(DomainNameText(h, listing)),
              DomainAction(h, model, listing.domain)
            )
          })
        )
    }),
    h.ul.class("results-preview").attr("aria-hidden", "true").children(
      results.slice(0, PREVIEW_RESULT_COUNT).map((listing) =>
        h.li.key(listing.name).class("domain-row").children(
          h.span.class("domain-name").children(DomainNameText(h, listing)),
          DomainAction(h, model, undefined)
        )
      )
    )
  )
)

const Results = AppDef.fragment((h, model: AppModel) => {
  const query = queryOf(model.route)
  const search = searchState(query, h.queries.top, h.queries.ranges)
  if (search._tag === "Invalid" || search._tag === "Failed") {
    return h.section.class("results").attr("aria-label", "Domain results")
      .children(
        h.div.class("search-error").attr("role", "alert").children(
          h.h2("Let’s try that again"),
          h.p.attr("id", "search-error").children(
            search._tag === "Invalid"
              ? invalidQueryMessage
              : failedSearchMessage
          ),
          h.button.attr("type", "button").class("button").on(
            "click",
            AppMessage.ClickedRetrySearch()
          ).children("Try again")
        )
      )
  }
  const allListings = queryToListings(
    query,
    search._tag === "Ready" ? search.domains : undefined
  )
  const listings = filterAndSortListings(
    allListings,
    model.tldFilter,
    model.availability,
    model.sort
  )
  const loading = search._tag === "Loading" ||
    (search._tag === "Ready" && search.loading)
  return h.section.class("results").attr("aria-label", "Domain results")
    .children(
      h.div.class("results-content").attr("aria-busy", String(loading))
        .children(
          h.div.class("top-results-heading").children(
            h.h2("Top Results"),
            h.span.class("sample-data-label").children("Sample data")
          ),
          h.div.class("top-results").children(
            allListings.slice(0, TOP_RESULT_COUNT).map((listing) =>
              h.article.key(listing.name).class(
                "domain-card",
                listing.domain?._tag === "Unavailable" && "is-unavailable"
              ).children(
                h.h3(...DomainNameText(h, listing)),
                DomainAction(h, model, listing.domain)
              )
            )
          ),
          h.div.class("results-heading").children(
            h.h2("All Results"),
            Filters(h, model)
          ),
          listings.length === 0
            ? h.p.class("empty-results").attr("role", "status").children(
              "No domains match your filters. Try another extension or show all domains."
            )
            : ResultsList(h, model, listings)
        ),
      search._tag === "Ready" && search.failed && !search.loading &&
        h.div.attr("role", "alert").class(
          "sticky bottom-4 z-10 mt-4 flex items-center justify-between gap-4 rounded-md border border-gray-800 bg-gray-950 p-4 text-sm text-gray-300"
        ).children(
          h.p(failedSearchMessage),
          h.button.attr("type", "button").class("button").on(
            "click",
            AppMessage.ClickedRetrySearch()
          ).children("Try again")
        ),
      search._tag === "Ready"
        ? h.p.attrs({ role: "status", "aria-atomic": "true" }).class(
          "result-count"
        ).children(
          search.domains.size < domainTlds.length
            ? search.domains.size + " of " + domainTlds.length +
              " domains checked · Registration prices in USD"
            : listings.length + " domains · Registration prices in USD"
        )
        : h.p.attrs({
          role: "status",
          "aria-atomic": "true",
          "aria-label": "Searching domains"
        }).class("result-count")
          .children("Checking availability and prices…")
    )
})

const SearchPage = AppDef.fragment((h, model: AppModel) =>
  h.div.attrs({
    id: bootstrapConfig.appId,
    "data-search-layout": model.layout,
    "data-search": queryOf(model.route) === "" ? "idle" : "active"
  }).class("app").children(
    h.a.attr("href", "#main").class("skip-link").children(
      "Skip to main content"
    ),
    Header(h, model),
    h.main.attrs({ id: "main", tabindex: "-1" }).class(
      "flex-1 scroll-mt-20 focus:outline-none"
    ).children(
      h.h1.class("search-page-heading").children("Domain search"),
      Hero(h, model),
      h.section.class("begin-search").attr("aria-label", "Begin your search")
        .children(
          h.div.class("begin-search-copy").children(
            h.div.class("begin-search-icon").children(Icon(h, "search")),
            h.h2("Begin your search"),
            h.p(
              "Enter a domain name to explore sample prices and availability."
            )
          )
        ),
      Results(h, model)
    ),
    h.footer.class("footer").children(
      h.span(
        "A Foldkit Domains port to Effect UI · Not affiliated with Vercel"
      ),
      h.span("Sample data · Demo cart"),
      h.a.attr(
        "href",
        "https://github.com/Effect-TS/ui/tree/main/examples/domains"
      ).children(
        "View source",
        Icon(h, "arrow-up-right")
      )
    )
  )
)

const focusSearchInput = HtmlCommand.focus(SearchInput, () => Component.noop, {
  preventScroll: true
})

const clearSearch = (model: AppModel) =>
  model.route._tag === "Search"
    ? Router.patchSearch(AppRoute, model.route, { q: undefined }, {
      scroll: true
    }).pipe(Command.asNoop)
    : undefined

export const AppNoDeps = AppDef.make({
  init: ($) => {
    const query = queryOf($.props.route)
    return withVisiblePages({
      route: $.props.route,
      query,
      layout: query === "" ? "Landing" : "Search",
      ...noPages,
      tldFilter: "All",
      availability: "All",
      sort: "Relevance",
      popup: null,
      cart: [],
      tldSearch: ""
    })
  },
  update: {
    ChangedRoute: ($, { route }) => withRoute($.model, route),

    UpdatedSearch: ($, { value }) =>
      $.model.route._tag === "Search"
        ? $.evolve({
          query: value,
          layout: (layout) => value === "" ? layout : "Search"
        }).run(
          Router.patchSearch(AppRoute, $.model.route, {
            q: value === "" ? undefined : value
          }).pipe(Command.asNoop)
        )
        : $.model,

    SubmittedSearch: ($) => $.run(DismissSearchKeyboard.make({})),

    PressedEscape: ($) => {
      const clear = clearSearch($.model)
      return clear === undefined ? $.model : $.evolve({ query: "" }).run(clear)
    },

    ClickedClearSearch: ($) => {
      const clear = clearSearch($.model)
      return clear === undefined
        ? $.run(focusSearchInput)
        : $.evolve({ query: "" }).run(clear, focusSearchInput)
    },

    ClickedDomainsHome: ($) => $.run(focusSearchInput),

    ScrolledResults: ($, visible) =>
      withVisiblePages(UiStruct.evolve($.model, { visible })),

    RequestedOpenPopup: ($, { popup }) =>
      $.evolve({
        popup,
        tldSearch: (tldSearch) => popup === "TldDialog" ? "" : tldSearch
      }),

    RequestedClosePopup: ($, { popup }) =>
      $.evolve({ popup: (open) => open === popup ? null : open }),

    PickedTldFilter: ($, { value }) =>
      withVisiblePages(
        UiStruct.evolve($.model, { tldFilter: value, popup: null })
      ),

    PickedAvailabilityFilter: ($, { value }) =>
      withVisiblePages(
        UiStruct.evolve($.model, { availability: value, popup: null })
      ),

    PickedSortOrder: ($, { value }) =>
      withVisiblePages(UiStruct.evolve($.model, { sort: value, popup: null })),

    UpdatedTldSearch: ($, { value }) => $.evolve({ tldSearch: value }),

    ClickedAddDomain: ($, { domain }) =>
      $.evolve({
        cart: (cart) =>
          cart.some((item) => item.name === domain.name)
            ? cart
            : [...cart, domain]
      }),

    ClickedRemoveDomain: ($, { name }) =>
      $.evolve({ cart: (cart) => cart.filter((item) => item.name !== name) }),

    ClickedRemoveCartDomain: ($, { name }) =>
      $.evolve({ cart: (cart) => cart.filter((item) => item.name !== name) })
        .run(
          HtmlCommand.focus(CartCloseButton, () => Component.noop, {
            preventScroll: true
          })
        ),

    ClickedRetrySearch: ($) =>
      labelOfRoute($.model.route) === undefined
        ? $.run(focusSearchInput)
        : $.run(RetrySearch.make({}), focusSearchInput)
  },
  subscriptions: ({ model }) => [
    Router.subscription(
      AppRoute,
      model.route,
      (route) => AppMessage.ChangedRoute({ route })
    )
  ],
  head: ({ model }) => [
    Head.title(titleOf(model.route)),
    HtmlHead.lang("en"),
    HtmlHead.meta({ name: "color-scheme", content: "dark" }),
    HtmlHead.meta({ name: "theme-color", content: "#09090b" }),
    HtmlHead.meta({
      name: "description",
      content:
        "Search sample domain names, compare prices and availability, and build a demo cart."
    })
  ],
  view: (h, model) =>
    model.route._tag === "NotFound"
      ? NotFoundPage(h, AppRoute.printPath(model.route))
      : SearchPage(h, model)
})

export const App = AppNoDeps.pipe(Component.provide(SearchDomains.layer))
