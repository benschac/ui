import tailwindcss from "@tailwindcss/vite"
import { defineConfig, type Plugin } from "vite"

const isAppRequest = (pathname: string): boolean =>
  pathname.startsWith("/api/") ||
  !/^\/(@|src\/|node_modules\/)/.test(pathname) &&
    !/\.[a-z0-9]+$/i.test(pathname)

const domainsServer = (): Plugin => ({
  name: "domains-server",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const url = new URL(
        request.originalUrl ?? request.url ?? "/",
        "http://" + (request.headers.host ?? "localhost")
      )
      if (request.method !== "GET" || !isAppRequest(url.pathname)) return next()
      server.ssrLoadModule("/src/server/handler.ts").then(
        async ({ handler }) => {
          const result: Response = await handler(
            new Request(url, {
              headers: new Headers(request.headers as Record<string, string>)
            })
          )
          response.statusCode = result.status
          result.headers.forEach((value, name) =>
            response.setHeader(name, value)
          )
          response.end(new Uint8Array(await result.arrayBuffer()))
        }
      ).catch(next)
    })
  }
})

export default defineConfig({
  appType: "custom",
  optimizeDeps: { entries: ["src/entry.client.ts"] },
  plugins: [tailwindcss(), domainsServer()]
})
