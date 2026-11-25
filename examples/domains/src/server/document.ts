import { normalizeLabel } from "#domain/Domain"
import { HtmlServer } from "@effect/ui/html"
import { bootstrapConfig, bootstrapSearch } from "../bootstrap.ts"

export const document = (page: HtmlServer.Rendered<unknown>): string =>
  `<!doctype html>
<html ${page.htmlAttributes}>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${page.head}
    <link rel="icon" href="data:,">
    <link rel="stylesheet" href="/src/styles.css">
  </head>
  <body ${page.bodyAttributes}>
    <div id="app">${page.html}</div>
    <script type="application/json" id="state">${
    HtmlServer.serializeState(page.state)
  }</script>
    <script>(${bootstrapSearch.toString()})(${
    JSON.stringify(bootstrapConfig)
  }, ${normalizeLabel.toString()})</script>
    <script type="module" src="/src/entry.client.ts"></script>
  </body>
</html>`
