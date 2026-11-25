import { Router } from "@effect/ui"
import { HtmlLocator, HtmlPlay } from "@effect/ui/html/testing"
import { Locator, TestHost } from "@effect/ui/testing"
import { assert, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { App } from "./App.ts"
import { AppRoute } from "./routes.ts"
import { Domains } from "./services/Domains.ts"

const AppTest = (url: string) =>
  Layer.mergeAll(
    Router.memory({ routes: AppRoute, url }),
    TestHost.layer(),
    Domains.layerSample
  )

const playApp = HtmlPlay.make(App, Router.props(AppRoute))

const currentUrl = Effect.map(Router.Router, (router) => router.location().url)

const waitForSearch = TestClock.adjust("200 millis")

const searchBox = HtmlLocator.role("searchbox", { name: "Search domains" })
const card = (name: string) => HtmlLocator.role("heading", { name })

it.layer(AppTest("/"), { buildPerTest: true })("App", (it) => {
  it.effect("typing writes the query to the URL and shows sample results", () =>
    Effect.gen(function*() {
      const play = yield* playApp
      yield* play.expect(
        HtmlLocator.role("heading", { name: "Begin your search" })
      ).toExist()
      yield* play.type(searchBox, "effect")
      assert.strictEqual(yield* currentUrl, "/?q=effect")
      yield* waitForSearch
      yield* play.expect(card("effect.com")).toExist()
      yield* play.expect(
        Locator.text("60 of 556 domains checked · Registration prices in USD")
      ).toExist()
      assert.strictEqual(play.root.head().title, "effect | Domains | Foldkit")
    }))
})

it.layer(AppTest("/?q=effect"), { buildPerTest: true })(
  "App at /?q=effect",
  (it) => {
    it.effect("the route wins over the field on Back", () =>
      Effect.gen(function*() {
        const play = yield* playApp
        const router = yield* Router.Router
        yield* play.expect(searchBox).toHaveValue("effect")
        yield* play.expect(card("effect.com")).toExist()
        yield* router.navigate("/")
        yield* play.type(searchBox, "zeta")
        assert.strictEqual(yield* currentUrl, "/?q=zeta")
        yield* router.back
        yield* play.expect(searchBox).toHaveValue("effect")
        yield* play.expect(card("effect.com")).toExist()
        assert.strictEqual(yield* currentUrl, "/?q=effect")
      }))
  }
)
