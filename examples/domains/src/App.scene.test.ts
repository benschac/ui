import { searchSample, SearchUnavailable } from "#domain/Domain"
import { catalogRange, rangeOfPage, topRange } from "#domain/Listing"
import { Component, Router } from "@effect/ui"
import { HtmlCommand } from "@effect/ui/html"
import { HtmlLocator, HtmlScene } from "@effect/ui/html/testing"
import { Locator } from "@effect/ui/testing"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { AppNoDeps, RetrySearch } from "./App.ts"
import { AppRoute } from "./routes.ts"

const search = (q?: string) =>
  AppRoute.Search({ search: q === undefined ? {} : { q } })
const firstPage = (label: string) => ({ label, ...rangeOfPage(0) })
const searchBox = HtmlLocator.role("searchbox", { name: "Search domains" })
const results = HtmlLocator.role("list", { name: "All domain results" })
const tryAgain = HtmlLocator.role("button", { name: "Try again" })

describe("App", () => {
  it.effect("the landing page asks for nothing, and an edit shows before the route patch lands", () =>
    Effect.gen(function*() {
      const route = search()
      const scene = yield* HtmlScene.make(AppNoDeps, { route })
      assert.deepStrictEqual(scene.queryInfo.map((info) => info.args), [
        undefined,
        []
      ])
      scene.expect(Locator.attr("data-search-layout", "Landing")).toExist()
        .type(searchBox, "effect")
        .expect(searchBox).toHaveValue("effect")
        .expect(Locator.attr("data-search-layout", "Search")).toExist()
        .expectExact(Router.patchSearch(AppRoute, route, { q: "effect" }))
        .resolve(Router.PatchSearch, "navigated")
    }))

  it.effect("rows report their place in the whole list while later batches load", () =>
    Effect.gen(function*() {
      const scene = yield* HtmlScene.make(AppNoDeps, {
        route: search("effect")
      })
      scene.expect(HtmlLocator.role("status", { name: "Searching domains" }))
        .toExist()
        .loaded("top", searchSample({ label: "effect", ...topRange }))
        .expect(
          Locator.text("4 of 556 domains checked · Registration prices in USD")
        ).toExist()
        .expect(HtmlLocator.role("heading", { name: "effect.com" })).toExist()
        .loaded(
          "ranges",
          firstPage("effect"),
          searchSample(firstPage("effect"))
        )
        .expect(
          Locator.text("60 of 556 domains checked · Registration prices in USD")
        ).toExist()
        .expect(Locator.inside(results, Locator.attr("aria-setsize", "556")))
        .toHaveCount(36)
        .expect(Locator.inside(results, Locator.attr("aria-posinset", "1")))
        .toHaveText(/^effect\.com/)
    }))

  it.effect("an invalid query asks for nothing, and trying again returns to the field", () =>
    Effect.gen(function*() {
      const scene = yield* HtmlScene.make(AppNoDeps, {
        route: search("not a domain!")
      })
      assert.deepStrictEqual(scene.queryInfo.map((info) => info.args), [
        undefined,
        []
      ])
      scene.expect(HtmlLocator.role("alert")).toHaveText(
        /Enter a domain name using letters, numbers, and hyphens/
      )
        .click(tryAgain)
        .expectExact(HtmlCommand.Focus)
        .resolve(HtmlCommand.Focus, { found: true })
    }))

  it.effect("trying again after a failed search fetches again", () =>
    Effect.gen(function*() {
      const scene = yield* HtmlScene.make(AppNoDeps, {
        route: search("effect")
      })
      scene.loadFailed("top", new SearchUnavailable())
        .expect(HtmlLocator.role("alert")).toHaveText(
          /Could not load sample domains\. Please try again\./
        )
        .click(tryAgain)
        .expectExact(RetrySearch, HtmlCommand.Focus)
        .resolve(RetrySearch, Component.noop)
        .resolve(HtmlCommand.Focus, { found: true })
    }))

  it.effect("filters that match nothing say so", () =>
    Effect.gen(function*() {
      const scene = yield* HtmlScene.make(AppNoDeps, {
        route: search("github")
      })
      scene.given((model) => ({
        ...model,
        tldFilter: "com",
        availability: "Available",
        catalog: true
      }))
        .loaded("top", searchSample({ label: "github", ...topRange }))
        .loaded(
          "ranges",
          { label: "github", ...catalogRange },
          searchSample({ label: "github", ...catalogRange })
        )
        .expect(
          Locator.text(
            "No domains match your filters. Try another extension or show all domains."
          )
        ).toExist()
    }))

  it.effect("an unknown path renders the 404 page", () =>
    Effect.gen(function*() {
      const scene = yield* HtmlScene.make(AppNoDeps, {
        route: AppRoute.NotFound({ params: { "*": "nope" } })
      })
      scene.expect(
        HtmlLocator.role("heading", { name: "404 — Page Not Found" })
      ).toExist()
        .expect(HtmlLocator.role("link", { name: "← Back to Domains" }))
        .toExist()
    }))
})
