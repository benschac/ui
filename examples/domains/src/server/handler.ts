import { layerHttp } from "@effect/ui/html/HtmlServerHttp"
import { Layer } from "effect"
import { HttpRouter } from "effect/http"
import { App } from "../App.ts"
import { AppRoute } from "../routes.ts"
import { Domains } from "../services/Domains.ts"
import { document } from "./document.ts"
import { DomainsApiLive } from "./DomainsApiLive.ts"

const Pages = layerHttp(App, {
  routes: AppRoute,
  budget: "300 millis",
  document
})

export const { handler } = HttpRouter.toWebHandler(
  Layer.mergeAll(DomainsApiLive, Pages).pipe(Layer.provide(Domains.layerSample))
)
