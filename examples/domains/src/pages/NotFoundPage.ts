import type { Html } from "@effect/ui/html"
import { homeUrl } from "../routes.ts"

export const NotFoundPage = <M>(h: Html.H<M>, path: string) =>
  h.main.class(
    "mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-6 px-6"
  ).children(
    h.h1.class("text-4xl font-semibold tracking-tight").children(
      "404 — Page Not Found"
    ),
    h.p.class("text-gray-300").children(`The path "${path}" was not found.`),
    h.a.attr("href", homeUrl).class("w-fit underline underline-offset-4")
      .children("← Back to Domains")
  )
