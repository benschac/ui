// @vitest-environment happy-dom
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { DevTools } from "@effect/ui-devtools"
import * as Mcp from "@effect/ui-devtools/internal/mcp"
import * as Remote from "@effect/ui-devtools/internal/remote"
import * as Server from "@effect/ui-devtools/internal/server"
import { DevToolsServer, DevToolsVite } from "@effect/ui-devtools/node"
import type * as BrowserHost from "@effect/ui/html/BrowserHost"
import { HtmlLocator } from "@effect/ui/html/testing"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema, Stream } from "effect"
import { McpClient, McpProtocol } from "effect/ai"
import { HttpRouter } from "effect/http"
import * as Socket from "effect/socket/Socket"
import { createServer, request } from "node:http"
import { type Capture, play } from "./fixtures/TwoEditors.ts"

const wait = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))
const token = "tok_live_9f2c"

const text = (node: Element | null | undefined) =>
  (node?.textContent ?? "").replace(/\s+/g, " ").trim()
const overlay = () =>
  document.querySelector<HTMLIFrameElement>("iframe[data-effect-ui-devtools]")!
    .contentDocument!.body

// happy-dom's fetch applies CORS, so the origin probes use node:http.
const probeStatus = (
  url: string,
  options: {
    readonly method?: string
    readonly headers: Record<string, string>
  },
  body = ""
) =>
  Effect.promise(
    () =>
      new Promise<number>((resolve, reject) => {
        const req = request(url, options, (res) => {
          res.resume()
          res.on("end", () => resolve(res.statusCode ?? 0))
        })
        req.on("upgrade", (res, socket) => {
          socket.destroy()
          resolve(res.statusCode ?? 0)
        })
        req.on("error", reject)
        req.end(body)
      })
  )

const makeAgent = Effect.fnUntraced(function*(base: string) {
  const transport = yield* McpClient.http({
    url: base + "/mcp",
    protocol: McpProtocol.v2025_11_25
  }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp))
  const client = yield* McpClient.make({ name: "test", version: "0" }).pipe(
    Effect.provideService(McpClient.Transport, transport)
  )
  const tools = yield* client.listTools()
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const results: Array<string> = []
  const invoke = (name: string, args?: Record<string, unknown>) =>
    client.callTool({ tool: byName.get(name)!, arguments: args }).pipe(
      Effect.orDie,
      Effect.tap((result) =>
        Effect.sync(() => results.push(JSON.stringify(result)))
      )
    )
  return {
    tools,
    results,
    call: <A = any>(
      name: string,
      args?: Record<string, unknown>
    ): Effect.Effect<A> =>
      invoke(name, args).pipe(
        Effect.map((result) => {
          if (result.isError === true) {
            throw new Error(
              result.content?.[0]?.type === "text"
                ? result.content[0].text
                : JSON.stringify(result)
            )
          }
          return (result.structuredContent as { readonly result: A }).result
        })
      ),
    fails: (
      name: string,
      args?: Record<string, unknown>
    ): Effect.Effect<string> =>
      invoke(name, args).pipe(
        Effect.map((result) => {
          assert.isTrue(result.isError, name + " should fail")
          return JSON.stringify(result.content ?? result.structuredContent)
        })
      )
  }
})

const serve = Effect.fnUntraced(
  function*(options: DevToolsServer.Options & { readonly port: number }) {
    yield* Layer.build(DevToolsServer.layer(options))
    const url = DevToolsServer.url(options)
    return { url, agent: yield* makeAgent(url) }
  }
)

const open = Effect.fnUntraced(
  function*(url: string, capture: Capture, size?: number) {
    localStorage.clear()
    const services = yield* Layer.build(
      DevTools.layer({ server: url, ...(size === undefined ? {} : { size }) })
    )
    const app = yield* play(capture).pipe(Effect.provide(services))
    yield* wait(150)
    return app
  }
)

const until = (check: () => boolean) =>
  Effect.suspend(function loop(): Effect.Effect<void> {
    return check()
      ? Effect.void
      : Effect.andThen(wait(10), Effect.suspend(loop))
  }).pipe(Effect.timeout("2 seconds"))

const serveFast = Effect.fnUntraced(function*(port: number, timeout: number) {
  const { routes, server } = Server.make({
    size: 100,
    dispatch: true,
    keep: 5,
    timeout
  })
  yield* Layer.build(
    HttpRouter.serve(Layer.mergeAll(routes, Mcp.layer(server)), {
      disableLogger: true,
      disableListenLog: true
    }).pipe(
      Layer.provide(
        NodeHttpServer.layer(createServer, { port, host: "127.0.0.1" })
      )
    )
  )
  const url = "http://127.0.0.1:" + port
  return { url, agent: yield* makeAgent(url) }
})

const connectSocket = (url: string) =>
  Effect.callback<WebSocket>((resume) => {
    const socket = new WebSocket(url)
    socket.addEventListener("open", () => resume(Effect.succeed(socket)))
  })

const at = { session: "s", at: 0, path: "/App", instance: 1, component: "App" }
const propsAt = (seq: number) =>
  JSON.stringify({ _tag: "PropsChanged", ...at, seq, props: { seq } })

const fakePage = Effect.fnUntraced(function*(
  url: string,
  dispatch: (log: WebSocket, message: unknown) => Effect.Effect<
    BrowserHost.Dispatched
  >
) {
  const log = yield* connectSocket(url.replace("http", "ws") + "/log")
  yield* Effect.addFinalizer(() => Effect.sync(() => log.close()))
  log.send(JSON.stringify({ _tag: "Hello", version: 1, host: "test" }))
  log.send(
    JSON.stringify({ _tag: "SessionStarted", ...at, seq: 0, app: "App" })
  )
  log.send(propsAt(1))
  const found = {
    instance: 1,
    path: "/App",
    component: "App",
    message: Schema.Struct({ _tag: Schema.Literal("Go"), n: Schema.Number }),
    dispatch: (message: unknown) => dispatch(log, message)
  }
  const root = { instance: (n: number) => n === 1 ? found : undefined }
  yield* Remote.connect(url.replace("http", "ws") + "/control", {
    roots: new Map([["s", root as unknown as BrowserHost.Controllable]]),
    size: 100,
    paused: () => undefined,
    paint: () => Effect.succeed(undefined),
    resume: Effect.void,
    changes: Stream.never
  }).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal))
  yield* wait(100)
  return log
})

const go = (count: number) =>
  Array.from({ length: count }, (_, n) => ({ _tag: "Go", n }))

describe("DevToolsServer", { concurrent: false }, () => {
  it.live(
    "answers why a save never finished from the server's copy of the log",
    () =>
      Effect.gen(function*() {
        const { agent, url } = yield* serve({ port: 47741 })
        yield* open(url, "interrupted")

        assert.deepStrictEqual(agent.tools.map((tool) => tool.name), [
          "list_sessions",
          "list_instances",
          "list_entries",
          "count_entries",
          "get_entry",
          "get_chain",
          "get_state",
          "diff_state",
          "show_entry",
          "resume",
          "set_recording",
          "get_message_schema",
          "dispatch",
          "wait"
        ])
        assert.isTrue(
          agent.tools.find((tool) => tool.name === "dispatch")?.annotations
            ?.destructiveHint
        )
        assert.isTrue(
          agent.tools.find((tool) => tool.name === "get_state")?.annotations
            ?.readOnlyHint
        )

        const [session] = yield* agent.call("list_sessions")
        assert.strictEqual(session.app, "Workspace")
        assert.strictEqual(session.host, "browser")
        assert.isTrue(session.connected)
        assert.isTrue(session.controllable)

        const instances: ReadonlyArray<any> = yield* agent.call(
          "list_instances"
        )
        const n2 = instances.find((instance) =>
          instance.path === "/Workspace/Editor[n2]"
        )
        assert.match(n2.status, /interrupted/)
        assert.isDefined(n2.unmounted)

        const { rows } = yield* agent.call("list_entries", {
          instance: n2.instance,
          filter: "commands"
        })
        const interrupted = rows.find((row: any) =>
          row.tag === "CommandInterrupted"
        )
        const save = rows.find((row: any) => row.label === "ClickedSave")
        assert.isDefined(interrupted)

        const chain: ReadonlyArray<any> = yield* agent.call("get_chain", {
          seq: interrupted.seq
        })
        const steps = JSON.stringify(chain)
        assert.include(steps, "ClickedSave")
        assert.include(steps, "PressedEscape")
        assert.include(steps, "notes/SaveNote")

        const diff = yield* agent.call("diff_state", { seq: save.seq })
        assert.deepInclude(diff.changes, {
          path: ["status"],
          kind: "changed",
          before: "Dirty",
          after: "Saving"
        })

        const state = yield* agent.call("get_state", {
          instance: n2.instance,
          at: save.seq
        })
        assert.strictEqual(state.model.status, "Saving")
        assert.deepStrictEqual(state.props.token, { "~redacted": true })
        const now = yield* agent.call("get_state", { instance: n2.instance })
        assert.match(now.unmounted, /^unmounted at #\d+$/)

        const counts = yield* agent.call("count_entries")
        assert.strictEqual(counts.messages.ClickedSave, 2)

        const entry = yield* agent.call("get_entry", {
          seq: save.seq,
          path: ["message"]
        })
        assert.deepStrictEqual(entry, { _tag: "ClickedSave" })
        assert.notInclude(agent.results.join("\n"), token)
      }).pipe(Effect.scoped),
    30_000
  )

  it.live(
    "keeps the page's choice of what to record, so a burst of drafts can't evict the saves",
    () =>
      Effect.gen(function*() {
        const { agent, url } = yield* serve({ port: 47755, size: 40 })
        localStorage.clear()
        sessionStorage.clear()
        const services = yield* Layer.build(
          DevTools.layer({ server: url, size: 40, exclude: ["UpdatedDraft"] })
        )
        const app = yield* play("open").pipe(Effect.provide(services))
        yield* wait(150)
        const body = HtmlLocator.getByRole(app, "textbox", { name: "Body n1" })
        const type = Effect.fnUntraced(function*(count: number) {
          for (let n = 0; n < count; n++) {
            HtmlLocator.type(body, "draft " + n)
            yield* wait(5)
          }
          yield* wait(100)
        })
        const labels = Effect.map(
          agent.call("list_entries", { filter: "messages", limit: 100 }),
          ({ rows }) => rows.map((row: any) => row.label) as Array<string>
        )
        const saves = (labels: ReadonlyArray<string>) =>
          labels.filter((label) => label === "ClickedSave").length

        assert.notInclude(yield* labels, "UpdatedDraft")
        const [session] = yield* agent.call("list_sessions")
        assert.deepStrictEqual(session.notRecording, ["UpdatedDraft"])

        assert.deepStrictEqual(
          yield* agent.call("set_recording", {
            tag: "UpdatedDraft",
            recording: true
          }),
          []
        )
        yield* type(1)
        assert.include(yield* labels, "UpdatedDraft")

        assert.deepStrictEqual(
          yield* agent.call("set_recording", {
            tag: "UpdatedDraft",
            recording: false
          }),
          ["UpdatedDraft"]
        )
        yield* type(50)
        assert.strictEqual(saves(yield* labels), 2)
      }).pipe(Effect.scoped),
    30_000
  )

  it.live(
    "keeps the state of an instance whose entries the ring dropped",
    () =>
      Effect.gen(function*() {
        const { agent, url } = yield* serve({ port: 47742, size: 12 })
        yield* open(url, "open", 12)
        const instances: ReadonlyArray<any> = yield* agent.call(
          "list_instances"
        )
        const workspace = instances.find((instance) =>
          instance.path === "/Workspace"
        )
        const state = yield* agent.call("get_state", {
          instance: workspace.instance
        })
        assert.deepStrictEqual(state.model, { open: ["n1", "n2"] })
        const message = yield* agent.fails("get_state", {
          instance: workspace.instance,
          at: 0
        })
        assert.include(message, "older than the last 12 entries")
      }).pipe(Effect.scoped),
    30_000
  )

  it.live(
    "refuses browser origins on /mcp and foreign origins on the WebSocket routes",
    () =>
      Effect.gen(function*() {
        const { agent, url } = yield* serve({ port: 47743 })
        const mcpStatus = yield* probeStatus(
          url + "/mcp",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              origin: "http://evil.example"
            }
          },
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
        )
        assert.strictEqual(mcpStatus, 403)
        for (const path of ["/log", "/control"]) {
          const probe = (origin: string) =>
            probeStatus(url + path, {
              headers: {
                connection: "Upgrade",
                upgrade: "websocket",
                "sec-websocket-version": "13",
                "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
                origin
              }
            })
          assert.strictEqual(yield* probe("http://evil.example"), 403, path)
          assert.strictEqual(yield* probe("http://localhost:5173"), 101, path)
        }
        const message = yield* agent.fails("list_instances")
        assert.include(message, "No session has connected yet")
      }).pipe(Effect.scoped),
    30_000
  )

  it.live(
    "shares one pause between an agent and the overlay",
    () =>
      Effect.gen(function*() {
        const { agent, url } = yield* serve({ port: 47744 })
        const app = yield* open(url, "open")
        const root = overlay()
        const { rows } = yield* agent.call("list_entries", {
          tag: "ClickedSave"
        })
        const seq = rows[0].seq

        const shown = yield* agent.call("show_entry", { seq })
        assert.deepStrictEqual(shown, {
          paused: seq,
          fellBack: [],
          fallbacks: [],
          skipped: ["/Workspace/Editor[n1]", "/Workspace/Editor[n2]"]
        })
        assert.strictEqual(app.style.display, "none")
        yield* until(() =>
          text(root.querySelector(".paused-label")) === "Paused at #" + seq
        )
        const [paused] = yield* agent.call("list_sessions")
        assert.strictEqual(paused.paused, seq)

        yield* agent.call("resume")
        assert.notStrictEqual(app.style.display, "none")
        yield* until(() => root.querySelector(".paused") === null)

        HtmlLocator.click(
          HtmlLocator.getByRole(root, "button", {
            name: "Open the Effect UI inspector"
          })
        )
        yield* wait(20)
        const saves = HtmlLocator.queryAllByRole(root, "button", {
          name: /Update ClickedSave$/
        })
          .filter((node) => node.classList.contains("row-button"))
        HtmlLocator.click(saves.at(-1)!)
        yield* wait(20)
        HtmlLocator.click(
          HtmlLocator.getByRole(root, "button", { name: "Time travel" })
        )
        yield* wait(50)
        const [human] = yield* agent.call("list_sessions")
        assert.strictEqual(
          "Paused at #" + human.paused,
          text(root.querySelector(".paused-label"))
        )
        yield* agent.call("resume")
        yield* until(() => root.querySelector(".paused") === null)

        const both: ReadonlyArray<number> = rows.map((row: any) => row.seq)
        yield* Effect.all(
          both.map((seq) => agent.call("show_entry", { seq })),
          { concurrency: "unbounded" }
        )
        const [raced] = yield* agent.call("list_sessions")
        assert.include(both, raced.paused)
        yield* until(() =>
          text(root.querySelector(".paused-label")) ===
            "Paused at #" + raced.paused
        )
        assert.strictEqual(document.querySelectorAll("[inert]").length, 1)
        yield* agent.call("resume")
        yield* until(() => root.querySelector(".paused") === null)
        assert.strictEqual(document.querySelectorAll("[inert]").length, 0)

        const outside = yield* agent.fails("show_entry", { seq: 10_000 })
        assert.include(outside, "not in the session's buffer")
        const off = yield* agent.fails("dispatch", {
          instance: 1,
          messages: [{ _tag: "ClickedSave" }]
        })
        assert.include(off, "Dispatch is off")
      }).pipe(Effect.scoped),
    30_000
  )

  it.live(
    "dispatches decoded messages to an instance and waits for their Commands",
    () =>
      Effect.gen(function*() {
        const { agent, url } = yield* serve({ port: 47745, dispatch: true })
        const app = yield* open(url, "open")
        const instances: ReadonlyArray<any> = yield* agent.call(
          "list_instances"
        )
        const n1 = instances.find((instance) =>
          instance.path === "/Workspace/Editor[n1]"
        ).instance

        const schema = yield* agent.call("get_message_schema", {
          instance: n1,
          tag: "UpdatedDraft"
        })
        assert.include(JSON.stringify(schema), "text")
        const unknownTag = yield* agent.fails("get_message_schema", {
          instance: n1,
          tag: "Nope"
        })
        assert.include(unknownTag, "ClickedSave")

        const bad = yield* agent.fails("dispatch", {
          instance: n1,
          messages: [{ _tag: "UpdatedDraft", text: "ok" }, {
            _tag: "UpdatedDraft",
            text: 1
          }]
        })
        assert.include(bad, "Message 1 does not decode")
        const { last } = yield* agent.call("wait", { timeout: 0, instance: n1 })

        const sent = yield* agent.call("dispatch", {
          instance: n1,
          messages: [{ _tag: "UpdatedDraft", text: "From the agent" }, {
            _tag: "ClickedSave"
          }]
        })
        assert.strictEqual(sent.applied, 2)
        assert.deepStrictEqual(
          sent.outcomes.map((outcome: any) =>
            outcome._tag
          ),
          ["Updated", "Updated"]
        )
        const update = yield* agent.call("get_entry", {
          seq: sent.outcomes[0].seq
        })
        assert.deepStrictEqual(update.source, { _tag: "Dispatch" })
        assert.strictEqual(
          (HtmlLocator.getByRole(app, "textbox", {
            name: "Body n1"
          }) as HTMLTextAreaElement).value,
          "From the agent"
        )

        const settled = yield* agent.call("wait", {
          since: last,
          instance: n1,
          timeout: 2_000
        })
        assert.isTrue(settled.settled)
        const state = yield* agent.call("get_state", { instance: n1 })
        assert.strictEqual(state.model.status, "Saved")

        const pending = yield* agent.call("wait", { timeout: 50 })
        assert.isFalse(pending.settled)
        assert.strictEqual(pending.open.length, 1)
      }).pipe(Effect.scoped),
    30_000
  )

  it.live(
    "keeps a closed session readable but not controllable",
    () =>
      Effect.gen(function*() {
        const { agent, url } = yield* serve({ port: 47746, keep: 1 })
        yield* open(url, "open").pipe(Effect.scoped)
        yield* wait(100)
        const [closed] = yield* agent.call("list_sessions")
        assert.isFalse(closed.connected)
        assert.isFalse(closed.controllable)
        const instances: ReadonlyArray<any> = yield* agent.call(
          "list_instances"
        )
        assert.isAbove(instances.length, 0)
        const message = yield* agent.fails("show_entry", {
          seq: closed.last
        })
        assert.include(message, "can't be controlled")

        yield* open(url, "open").pipe(Effect.scoped)
        yield* open(url, "open").pipe(Effect.scoped)
        yield* wait(100)
        const sessions: ReadonlyArray<any> = yield* agent.call("list_sessions")
        assert.strictEqual(sessions.length, 1)
        assert.notStrictEqual(sessions[0].session, closed.session)
      }).pipe(Effect.scoped),
    30_000
  )

  it.live(
    "keeps a truncated query map opaque when a query changes",
    () =>
      Effect.gen(function*() {
        const { agent, url } = yield* serve({ port: 47747, size: 3 })
        const socket = new WebSocket(url.replace("http", "ws") + "/log")
        yield* Effect.callback<void>((resume) =>
          socket.addEventListener("open", () => resume(Effect.void))
        )
        const base = { session: "s", at: 0 }
        const at = { ...base, path: "/App", instance: 1, component: "App" }
        const frames = [
          { _tag: "Hello", version: 1, host: "test" },
          { _tag: "SessionStarted", ...base, seq: 0, app: "App" },
          {
            _tag: "Mounted",
            ...at,
            seq: 1,
            props: {},
            model: 0,
            queries: { "~truncated": 9000 },
            commands: [],
            events: [],
            adopted: false
          },
          { _tag: "QueryChanged", ...at, seq: 2, name: "todos", result: [1] },
          { _tag: "PropsChanged", ...at, seq: 3, props: { a: 1 } },
          { _tag: "PropsChanged", ...at, seq: 4, props: { a: 2 } },
          { _tag: "PropsChanged", ...at, seq: 5, props: { a: 3 } }
        ]
        for (const frame of frames) socket.send(JSON.stringify(frame))
        yield* wait(100)
        const state = yield* agent.call("get_state", {
          session: "s",
          instance: 1
        })
        assert.deepStrictEqual(state.queries, { "~truncated": 9000 })
        assert.deepStrictEqual(state.props, { a: 3 })
        socket.close()
      }).pipe(Effect.scoped),
    30_000
  )

  it.live(
    "scrubs the root an agent paused when the page has two",
    () =>
      Effect.gen(function*() {
        const { agent, url } = yield* serve({ port: 47748 })
        localStorage.clear()
        const services = yield* Layer.build(DevTools.layer({ server: url }))
        const older = yield* play("open").pipe(Effect.provide(services))
        const newer = yield* play("open").pipe(Effect.provide(services))
        yield* wait(150)
        const [first] = yield* agent.call("list_sessions")
        const { rows } = yield* agent.call("list_entries", {
          session: first.session,
          tag: "ClickedSave"
        })
        yield* agent.call("show_entry", {
          session: first.session,
          seq: rows[0].seq
        })
        assert.strictEqual(older.style.display, "none")

        const root = overlay()
        HtmlLocator.click(
          HtmlLocator.getByRole(root, "button", {
            name: "Open the Effect UI inspector"
          })
        )
        yield* wait(20)
        const slider = root.querySelector<HTMLInputElement>(
          "input[type=range]"
        )!
        assert.strictEqual(
          slider.getAttribute("aria-valuetext"),
          "#" + rows[0].seq
        )
        slider.value = "0"
        slider.dispatchEvent(new Event("input", { bubbles: true }))
        yield* wait(50)
        const sessions: ReadonlyArray<any> = yield* agent.call("list_sessions")
        const paused = sessions.find((session) =>
          session.session === first.session
        ).paused
        assert.isBelow(paused, rows[0].seq)
        assert.strictEqual(older.style.display, "none")
        assert.notStrictEqual(newer.style.display, "none")
        assert.strictEqual(document.querySelectorAll("[inert]").length, 1)
      }).pipe(Effect.scoped),
    30_000
  )

  it.live(
    "adds no meta tag when the plugin's port is taken, and injects overlay and hot modules unless disabled",
    () =>
      Effect.gen(function*() {
        yield* serve({ port: 47749 })
        const start = (options: DevToolsVite.Options) => {
          let close = () => {}
          const warnings: Array<string> = []
          const plugin = DevToolsVite.plugin(options)
          plugin.configureServer({
            config: {
              logger: {
                info: () => {},
                warn: (message) => warnings.push(message)
              }
            },
            httpServer: { once: (_, listener) => close = listener }
          })
          return { plugin, warnings, close: () => close() }
        }
        const taken = start({ port: 47749, overlay: { position: "TopLeft" } })
        const takenTags = yield* Effect.promise(() =>
          taken.plugin.transformIndexHtml()
        )
        assert.deepStrictEqual(takenTags, [
          {
            tag: "script",
            attrs: { type: "module", src: "/@effect-ui/devtools" },
            injectTo: "head-prepend"
          },
          {
            tag: "script",
            attrs: { type: "module", src: "/@effect-ui/hot" },
            injectTo: "head"
          }
        ])
        const resolvedHot = taken.plugin.resolveId("/@effect-ui/hot")
        assert.isDefined(resolvedHot)
        assert.include(
          taken.plugin.load(resolvedHot!)!,
          "vite:beforeFullReload"
        )
        const resolvedDevTools = taken.plugin.resolveId("/@effect-ui/devtools")
        assert.isDefined(resolvedDevTools)
        assert.include(
          taken.plugin.load(resolvedDevTools!)!,
          "DevTools.attach({\"position\":\"TopLeft\"})"
        )
        assert.match(
          taken.warnings[0]!,
          /could not start on http:\/\/127\.0\.0\.1:47749/
        )
        const off = start({ port: 47749, hot: false, overlay: false })
        assert.deepStrictEqual(
          yield* Effect.promise(() => off.plugin.transformIndexHtml()),
          []
        )
        assert.isUndefined(off.plugin.resolveId("/@effect-ui/hot"))
        assert.isUndefined(off.plugin.resolveId("/@effect-ui/devtools"))
        const free = start({ port: 47750 })
        const tags = yield* Effect.promise(() =>
          free.plugin.transformIndexHtml()
        )
        assert.strictEqual(
          JSON.parse(tags[0]!.attrs.content!).url,
          "http://127.0.0.1:47750"
        )
        assert.strictEqual(tags[1]!.attrs.src, "/@effect-ui/devtools")
        assert.strictEqual(tags[2]!.attrs.src, "/@effect-ui/hot")
        free.close()
      }).pipe(Effect.scoped),
    30_000
  )

  it.live(
    "auto-attached DevTools captures initial mount before iframe load and yields to explicit DevTools.layer",
    () =>
      Effect.gen(function*() {
        localStorage.clear()
        const dispose = DevTools.attach()
        yield* Effect.addFinalizer(() => Effect.sync(dispose))
        yield* play("open")
        yield* until(() =>
          document.querySelectorAll("iframe[data-effect-ui-devtools]")
              .length === 1 &&
          overlay().querySelector("button") !== null
        )
        const root = overlay()
        HtmlLocator.click(
          HtmlLocator.getByRole(root, "button", {
            name: "Open the Effect UI inspector"
          })
        )
        yield* until(() => text(root).includes("Workspace"))
        assert.strictEqual(
          document.querySelectorAll("iframe[data-effect-ui-devtools]").length,
          1
        )
        yield* Layer.build(DevTools.layer())
        yield* wait(20)
        assert.strictEqual(
          document.querySelectorAll("iframe[data-effect-ui-devtools]").length,
          1
        )
      }).pipe(Effect.scoped),
    30_000
  )

  it.live(
    "returns the outcomes of a batch that ran out of time, and what it didn't send",
    () =>
      Effect.gen(function*() {
        const { agent, url } = yield* serveFast(47751, 1_000)
        const applied: Array<number> = []
        yield* fakePage(url, (log, message) =>
          Effect.gen(function*() {
            const n = (message as { n: number }).n
            yield* Effect.sleep("300 millis")
            applied.push(n)
            log.send(propsAt(n + 2))
            return { _tag: "Updated", seq: n + 2 } as const
          }))
        const sent = yield* agent.call("dispatch", {
          session: "s",
          instance: 1,
          messages: go(5)
        })
        assert.deepStrictEqual(sent.outcomes, [
          { _tag: "Updated", seq: 2 },
          { _tag: "Updated", seq: 3 },
          { _tag: "Unknown" }
        ])
        assert.strictEqual(sent.applied, 2)
        assert.deepStrictEqual(sent.notSent, [3, 4])
        assert.include(sent.note, "Message 2 was sent but did not finish")
        assert.include(
          sent.note,
          "Messages 3, 4 were not sent, because message 2's outcome is unknown."
        )
        assert.isUndefined(sent.unseen)
        yield* wait(500)
        assert.deepStrictEqual(applied, [0, 1])
      }).pipe(Effect.scoped),
    30_000
  )

  it.live(
    "tells the agent any message may have applied when the page's reply is lost",
    () =>
      Effect.gen(function*() {
        const { agent, url } = yield* serveFast(47752, 300)
        const log = yield* connectSocket(url.replace("http", "ws") + "/log")
        log.send(JSON.stringify({ _tag: "Hello", version: 1, host: "test" }))
        log.send(
          JSON.stringify({ _tag: "SessionStarted", ...at, seq: 0, app: "App" })
        )
        log.send(propsAt(1))
        const control = yield* connectSocket(
          url.replace("http", "ws") + "/control"
        )
        control.send(
          JSON.stringify({
            _tag: "State",
            sessions: ["s"],
            paused: null
          })
        )
        yield* wait(100)
        const message = yield* agent.fails("dispatch", {
          session: "s",
          instance: 1,
          messages: go(2)
        })
        assert.include(message, "did not answer within 300ms")
        assert.include(
          message,
          "Any of the messages may have been applied, or none"
        )
        assert.include(message, "after #1")
        log.close()
        control.close()
      }).pipe(Effect.scoped),
    30_000
  )

  it.live(
    "accepts a pause from a page that reports no skipped mounts",
    () =>
      Effect.gen(function*() {
        const { agent, url } = yield* serveFast(47754, 300)
        const log = yield* connectSocket(url.replace("http", "ws") + "/log")
        log.send(JSON.stringify({ _tag: "Hello", version: 1, host: "test" }))
        log.send(
          JSON.stringify({ _tag: "SessionStarted", ...at, seq: 0, app: "App" })
        )
        const control = yield* connectSocket(
          url.replace("http", "ws") + "/control"
        )
        control.send(
          JSON.stringify({
            _tag: "State",
            sessions: ["s"],
            paused: { session: "s", seq: 0, fellBack: [], fallbacks: [] }
          })
        )
        yield* wait(100)
        const [session] = yield* agent.call("list_sessions")
        assert.strictEqual(session.paused, 0)
        log.close()
        control.close()
      }).pipe(Effect.scoped),
    30_000
  )

  it.live(
    "reports a dispatched entry the server will never hold when a later frame arrives",
    () =>
      Effect.gen(function*() {
        const { agent, url } = yield* serveFast(47753, 1_000)
        yield* fakePage(url, (log) =>
          Effect.sync(() => {
            log.send(propsAt(3))
            return { _tag: "Updated", seq: 2 } as const
          }))
        const sent = yield* agent.call("dispatch", {
          session: "s",
          instance: 1,
          messages: go(1)
        })
        assert.deepStrictEqual(sent.outcomes, [{ _tag: "Updated", seq: 2 }])
        assert.deepStrictEqual(sent.unavailable, [{
          seq: 2,
          reason: "skipped"
        }])
        assert.isUndefined(sent.unseen)
        assert.include(
          sent.note,
          "#2 were logged by the page, but the server can't show them"
        )
        yield* agent.fails("get_entry", { session: "s", seq: 2 })
        const shown = yield* agent.call("get_entry", { session: "s", seq: 3 })
        assert.strictEqual(shown._tag, "PropsChanged")
      }).pipe(Effect.scoped),
    30_000
  )
})
