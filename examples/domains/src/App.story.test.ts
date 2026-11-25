import { searchSample } from "#domain/Domain"
import { catalogRange, rangeOfPage, topRange } from "#domain/Listing"
import { Router } from "@effect/ui"
import { Story } from "@effect/ui/testing"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { AppMessage, AppNoDeps } from "./App.ts"
import { AppRoute } from "./routes.ts"

const search = (q?: string) =>
  AppRoute.Search({ search: q === undefined ? {} : { q } })
const top = (label: string) => searchSample({ label, ...topRange })
const firstPage = (label: string) => ({ label, ...rangeOfPage(0) })

const loadFirstPage = <S extends Story.Steps<typeof AppNoDeps>>(
  story: S,
  label: string
): S =>
  story.loaded("top", top(label)).loaded(
    "ranges",
    firstPage(label),
    searchSample(firstPage(label))
  )

describe("App", () => {
  describe("search", () => {
    it.effect("Escape clears the field and the query", () =>
      Effect.gen(function*() {
        const route = search("effect")
        const story = yield* Story.make(AppNoDeps, { route })
        story.keepPending("top")
          .send(AppMessage.PressedEscape())
          .expectExact(
            Router.patchSearch(AppRoute, route, { q: undefined }, {
              scroll: true
            })
          )
          .resolve(Router.PatchSearch, "navigated")
        assert.strictEqual(story.model.query, "")
      }))
  })

  describe("paging", () => {
    it.effect("scrolling asks for the pages around the visible rows", () =>
      Effect.gen(function*() {
        const story = yield* Story.make(AppNoDeps, { route: search("effect") })
        loadFirstPage(story, "effect")
          .send(AppMessage.ScrolledResults({ first: 300, last: 330 }))
          .keepPending("ranges")
        assert.deepStrictEqual(story.model.pages, [0, 4, 5])
      }))

    it.effect("sorting by price asks for the whole catalog", () =>
      Effect.gen(function*() {
        const story = yield* Story.make(AppNoDeps, { route: search("effect") })
        loadFirstPage(story, "effect")
          .send(AppMessage.PickedSortOrder({ value: "PriceAscending" }))
          .keepPending("ranges")
        assert.isTrue(story.model.catalog)
        assert.deepStrictEqual(story.queryInfo[1]!.args, [{
          label: "effect",
          ...catalogRange
        }])
      }))
  })

  describe("cart", () => {
    it.effect("adds a domain once and removes it", () =>
      Effect.gen(function*() {
        const story = yield* Story.make(AppNoDeps, { route: search("effect") })
        const domain = top("effect")[0]!
        assert.strictEqual(domain._tag, "Available")
        if (domain._tag !== "Available") return
        story.keepPending("top")
          .send(AppMessage.ClickedAddDomain({ domain }))
          .send(AppMessage.ClickedAddDomain({ domain }))
        assert.deepStrictEqual(story.model.cart.map((item) => item.name), [
          "effect.com"
        ])
        story.send(AppMessage.ClickedRemoveDomain({ name: "effect.com" }))
        assert.deepStrictEqual(story.model.cart, [])
      }))
  })
})
