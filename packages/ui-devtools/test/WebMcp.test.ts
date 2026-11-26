// @vitest-environment happy-dom
import { DevTools } from "@effect/ui-devtools"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Scope } from "effect"
import { play } from "./fixtures/TwoEditors.ts"

const wait = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))
const token = "tok_live_9f2c"

interface FakeTool {
  readonly name: string
  readonly inputSchema?: object | undefined
  readonly annotations?: {
    readonly readOnlyHint?: boolean | undefined
    readonly consequentialHint?: boolean | undefined
    readonly debugging?: boolean | undefined
  } | undefined
  readonly execute: (
    input: unknown,
    client?: { readonly signal?: AbortSignal | undefined }
  ) => Promise<unknown>
}

const installModelContext = () => {
  const tools = new Map<string, FakeTool>()
  const waited: Array<Promise<unknown>> = []
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: {
      registerTool: (
        tool: FakeTool,
        options?: { readonly signal?: AbortSignal | undefined }
      ) => {
        if (options?.signal?.aborted) return Promise.resolve()
        tools.set(tool.name, tool)
        options?.signal?.addEventListener("abort", () => {
          if (tools.get(tool.name) === tool) tools.delete(tool.name)
        }, { once: true })
        return Promise.resolve()
      },
      waitForToolsUntil: (promise: Promise<unknown>) => {
        waited.push(promise)
      }
    }
  })
  const call = <A = any>(
    name: string,
    input?: unknown,
    client?: { readonly signal?: AbortSignal | undefined }
  ): Effect.Effect<A> =>
    Effect.promise(() => tools.get(name)!.execute(input, client) as Promise<A>)
  return { tools, waited, call }
}

describe("DevTools WebMCP", { concurrent: false }, () => {
  afterEach(() => {
    delete (document as { modelContext?: unknown }).modelContext
    localStorage.clear()
  })

  it.live(
    "registers page tools, redacts historical state, controls the page, and unregisters on close",
    () =>
      Effect.gen(function*() {
        const mc = installModelContext()
        const scope = yield* Scope.make()
        const services = yield* Layer.build(DevTools.layer()).pipe(
          Scope.provide(scope)
        )
        const app = yield* play("open").pipe(
          Effect.provide(services),
          Scope.provide(scope)
        )
        yield* wait(20)

        assert.strictEqual(mc.waited.length, 1)
        yield* Effect.promise(() => mc.waited[0]!)
        assert.deepStrictEqual(Array.from(mc.tools.keys()), [
          "effect_ui_list_sessions",
          "effect_ui_list_instances",
          "effect_ui_list_entries",
          "effect_ui_count_entries",
          "effect_ui_get_entry",
          "effect_ui_get_chain",
          "effect_ui_get_state",
          "effect_ui_diff_state",
          "effect_ui_show_entry",
          "effect_ui_resume",
          "effect_ui_set_recording",
          "effect_ui_get_message_schema",
          "effect_ui_wait"
        ])
        for (const tool of mc.tools.values()) {
          assert.isTrue(tool.annotations?.debugging, tool.name)
          assert.isFalse(tool.annotations?.consequentialHint, tool.name)
          assert.isDefined(tool.inputSchema, tool.name)
        }
        assert.isTrue(
          mc.tools.get("effect_ui_get_state")?.annotations?.readOnlyHint
        )
        assert.isFalse(
          mc.tools.get("effect_ui_show_entry")?.annotations?.readOnlyHint
        )

        const instances: ReadonlyArray<any> = yield* mc.call(
          "effect_ui_list_instances"
        )
        const n2 = instances.find((instance) =>
          instance.path === "/Workspace/Editor[n2]"
        )
        const { rows } = yield* mc.call("effect_ui_list_entries", {
          instance: n2.instance,
          filter: "messages"
        })
        const save = rows.find((row: any) => row.label === "ClickedSave")

        const historical = yield* mc.call("effect_ui_get_state", {
          instance: n2.instance,
          at: save.seq
        })
        assert.strictEqual(historical.model.status, "Saving")
        assert.deepStrictEqual(historical.props.token, { "~redacted": true })
        assert.notInclude(JSON.stringify(historical), token)

        yield* mc.call("effect_ui_show_entry", { seq: save.seq })
        assert.strictEqual(app.style.display, "none")
        yield* mc.call("effect_ui_resume")
        assert.notStrictEqual(app.style.display, "none")

        const bad = yield* mc.call("effect_ui_get_entry", { seq: "bad" })
        assert.isTrue(bad.isError)
        assert.isString(bad.error)

        yield* Scope.close(scope, Exit.void)
        assert.strictEqual(mc.tools.size, 0)
      })
  )

  it.live(
    "gates dispatch, settles excluded dispatches immediately, cancels wait, and respects webMcp: false",
    () =>
      Effect.gen(function*() {
        const mc = installModelContext()
        yield* Effect.scoped(
          Effect.andThen(
            Layer.build(DevTools.layer({ webMcp: false })),
            Effect.sync(() => assert.strictEqual(mc.tools.size, 0))
          )
        )

        yield* Effect.scoped(Effect.gen(function*() {
          const services = yield* Layer.build(
            DevTools.layer({
              exclude: ["UpdatedDraft"],
              webMcp: { dispatch: true }
            })
          )
          yield* play("open").pipe(Effect.provide(services))
          yield* wait(20)

          assert.strictEqual(mc.tools.size, 14)
          assert.isTrue(
            mc.tools.get("effect_ui_dispatch")?.annotations?.consequentialHint
          )
          const instances: ReadonlyArray<any> = yield* mc.call(
            "effect_ui_list_instances"
          )
          const n1 = instances.find((instance) =>
            instance.path === "/Workspace/Editor[n1]"
          )

          const startedAt = Date.now()
          const excluded = yield* mc.call("effect_ui_dispatch", {
            instance: n1.instance,
            messages: [
              { _tag: "UpdatedDraft", text: "a" },
              { _tag: "UpdatedDraft", text: "b" }
            ]
          })
          assert.isBelow(Date.now() - startedAt, 1_000)
          assert.deepStrictEqual(excluded.unavailable, [{
            seq: excluded.outcomes[0].seq,
            reason: "excluded"
          }])
          const state = yield* mc.call("effect_ui_get_state", {
            instance: n1.instance,
            at: excluded.outcomes[1].seq
          })
          assert.strictEqual(state.model.draft, "b")
          assert.deepStrictEqual(state.props.token, { "~redacted": true })

          const abort = new AbortController()
          const pending = mc.tools.get("effect_ui_wait")!.execute(
            { timeout: 10_000 },
            { signal: abort.signal }
          )
          yield* wait(20)
          const cancelAt = Date.now()
          abort.abort()
          const error = yield* Effect.promise(() =>
            pending.then(() => undefined, (err) => err)
          )
          assert.strictEqual(
            (error as DOMException | undefined)?.name,
            "AbortError"
          )
          assert.isBelow(Date.now() - cancelAt, 1_000)
        }))
        assert.strictEqual(mc.tools.size, 0)
      })
  )
})
