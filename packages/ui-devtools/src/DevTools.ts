/**
 * A read-only inspector overlay for an `@effect/ui` app in the browser.
 *
 * `layer` takes the app's `MessageLog` slot. It feeds the app's log entries,
 * as Wire frames, to an `Inspector`, and mounts the overlay in an iframe at
 * a corner of the page. The overlay shows the timeline, the instances with
 * the state of their Command runs, the causal chain of the selected entry,
 * its Model with what changed, its message, Commands and raw frame, and the
 * Layer builds, Subscriptions, mounts and Command runs of its instance.
 *
 * Time travel, on the selected entry, opens a slider and paints the page as
 * it was at that entry, beside the live tree, which keeps running hidden
 * until Resume. See `layer`.
 *
 * The overlay is an Effect UI component tree in its own document, mounted
 * with `MessageLog.noop`: it never records its own updates, the page's
 * styles don't reach it, and its input never reaches the app's
 * `HtmlSubscription.onDocument` or `onWindow` listeners. It shows Wire
 * frames only, so a `Schema.Redacted` value reaches it, and a copied frame,
 * as the encoder's placeholder. It keeps frames, and the raw entries it
 * paints the page from, in memory only.
 *
 * **Example** (Adding the overlay in development)
 *
 * ```ts
 * import { BrowserHost, Html } from "@effect/ui/html"
 * import { DevTools } from "@effect/ui-devtools"
 * import { Effect, Layer, Schema } from "effect"
 *
 * const App = Html.component({
 *   name: "App",
 *   model: Schema.Struct({}),
 *   message: Schema.Never
 * }).make({
 *   init: () => ({}),
 *   update: (model) => model,
 *   view: (_, h) => h.h1("Hello")
 * })
 *
 * const Main = BrowserHost.mount(App, {}, document.getElementById("app")!).pipe(
 *   Layer.provide(import.meta.env.DEV ? DevTools.layer({ position: "BottomRight" }) : Layer.empty)
 * )
 *
 * Effect.runFork(Layer.launch(Main))
 * ```
 *
 * @stability experimental
 * @since 0.1.0
 */
import type * as Layer from "effect/Layer"
import * as internal from "./internal/layer.ts"

/**
 * The corner of the page the overlay sits in.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type Position = internal.Position

/**
 * Options for WebMCP tool registration in `layer`.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type WebMcpOptions = internal.WebMcpOptions

/**
 * Provides the `MessageLog` with a log that feeds the inspector overlay, and
 * mounts the overlay for as long as the Layer is built.
 *
 * **Details**
 *
 * The overlay starts closed, as a button at `position` (`"BottomRight"` by
 * default) that can be dragged or moved with arrow keys or the corner picker
 * to any corner, and remembers its corner, open state and size in
 * `localStorage`. It's mounted in an iframe added to the end of
 * `document.body` and removed when the Layer closes, so the app's DOM is
 * left as it is. The iframe takes the size and shape of the launcher or the
 * open panel, so the page around them still gets its clicks, and its theme
 * follows `prefers-color-scheme`.
 *
 * Entries are queued by `record` and encoded off the app's update path by
 * `MessageLog.makeEncoded`. The inspector keeps the last `size` shown entries
 * of each session (1,000 by default). To send entries to another sink as
 * well, combine both with `MessageLog.fanout`.
 *
 * `exclude` lists message `_tag` values, matched across every component, to
 * keep noisy updates such as pointer moves out of the timeline. An excluded
 * `Update` gets no row and replaces the instance's earlier excluded entry
 * when no shown entry sits between them, so a burst takes one slot per
 * instance and does not evict shown entries while still keeping Model diffs
 * and Time travel accurate. `exclude` is not a way to hide sensitive data:
 * later entries still carry whatever an excluded message changed in the
 * Model. Use `Schema.Redacted` for sensitive values.
 *
 * `exclude` is only where recording starts. Stop recording on a selected
 * update, or the `set_recording` tool, stops recording its `_tag` from the
 * next update, and the Not recording strip starts a stopped tag again. These
 * choices win over `exclude` and are kept in `sessionStorage`, so they last
 * through reloads until the tab closes. The page marks each excluded update's
 * Wire frame, so a DevTools server coalesces the same entries.
 *
 * Clear empties the timeline while keeping mounted instances and each
 * instance's pre-clear state for the next entry's diff and Time travel. Clear
 * is disabled while the page is paused.
 *
 * The Layer also provides `BrowserHost.Controllables`, so each root mounted
 * with `BrowserHost.mount`, `mountEffect` or `HtmlHydrate.hydrate` under it
 * can be paused. Time
 * travel, on a selected entry, hides the root's container and paints an
 * `inert` copy from each instance's state at that entry, folded from the
 * raw entries the overlay keeps beside the frames. Resume removes it. While
 * the copy is shown, the overlay's iframe is in the top layer, so the
 * copy's dialogs and popovers never cover it.
 *
 * `server` is the URL of a DevTools server (see `DevToolsServer` in
 * `@effect/ui-devtools/node`), which agents read and control the app
 * through over MCP. The Layer then also sends the frames there with
 * `MessageLog.socket`, and opens a second connection the server sends
 * requests on: paint the page at an entry, resume, and, when the server
 * allows it, dispatch a message to an instance. An agent's paint is the
 * same pause as Time travel, so the overlay shows it as paused and either
 * one can resume it. With `DevToolsVite.plugin`, the page carries the URL
 * and the plugin's `size`, so neither option is needed.
 *
 * When the browser exposes WebMCP (`document.modelContext`), the Layer also
 * registers the DevTools tools directly in the page under the `effect_ui_`
 * prefix with `annotations.debugging: true`, and unregisters them when the
 * Layer closes. The tools read Wire frames only, so `Schema.Redacted` values
 * remain placeholders. `effect_ui_dispatch` is off by default and requires
 * `webMcp: { dispatch: true }`. Pass `webMcp: false` to disable WebMCP
 * registration.
 *
 * Browser only: building the Layer needs `document`.
 *
 * @stability experimental
 * @category layers
 * @since 0.1.0
 */
export const layer = (options?: {
  readonly position?: Position | undefined
  readonly size?: number | undefined
  readonly exclude?: ReadonlyArray<string> | undefined
  readonly server?: string | undefined
  readonly webMcp?: boolean | WebMcpOptions | undefined
}): Layer.Layer<never> => internal.make(options ?? {})

/** @internal */
// oxlint-disable-next-line effect/no-unused-internal
export const attach: (options?: internal.Options) => () => void =
  internal.attach
