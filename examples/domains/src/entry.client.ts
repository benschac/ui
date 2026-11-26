import { Router } from "@effect/ui"
import { BrowserRouter, HtmlHydrate } from "@effect/ui/html"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { App } from "./App.ts"
import { bootstrapConfig } from "./bootstrap.ts"
import { AppRoute } from "./routes.ts"
import { Domains } from "./services/Domains.ts"
import { DevTools } from "@effect/ui-devtools";

const hydrate = Effect.gen(function*() {
  const state = JSON.parse(document.getElementById("state")!.textContent!)
  const root = yield* HtmlHydrate.hydrateEffect(
    App,
    Router.props(AppRoute),
    document.getElementById("app")!,
    state
  )
  yield* root.adopted
  document.dispatchEvent(new Event(bootstrapConfig.readyEvent))
  return yield* Effect.never
})

hydrate.pipe(
  Effect.scoped,
  Effect.provide(Layer.mergeAll(
    BrowserRouter.layer({ routes: AppRoute }),
    Domains.layerHttp.pipe(Layer.provide(FetchHttpClient.layer))
  ).pipe(
    Layer.provideMerge(DevTools.layer())
  )),
  Effect.runFork
)
