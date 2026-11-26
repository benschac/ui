/**
 * `Scene` with the HTML vocabulary: steps that send what the browser host
 * sends for each user action, and assertions on fields.
 *
 * `HtmlScene.Steps` extends `Scene.Steps`, so every scene step works here.
 * Each payload is typed from the host's own payload types in `Html`, so a
 * test can't send a shape the host never would. `click` sends `pointerdown`,
 * `mousedown`, `mouseup` and `click`, then runs the browser's defaults: it
 * throws on a disabled control, a submit button submits its form with the
 * fields read from the view, a checkbox or radio button fires `input` and
 * `change`, and a `popovertarget` button toggles its popover. The events of
 * one click are one interaction for the acknowledgement rule.
 *
 * **Example** (A weather lookup)
 *
 * ```ts import.meta.vitest
 * import { Command, UiSchema } from "@effect/ui"
 * import { Html } from "@effect/ui/html"
 * import { HtmlLocator, HtmlScene } from "@effect/ui/html/testing"
 * import { Effect, Schema } from "effect"
 *
 * const Message = UiSchema.TaggedEnum({
 *   UpdatedZip: { zip: Schema.String },
 *   SubmittedForm: { zip: Schema.String },
 *   CompletedFetchWeather: { forecast: Schema.String }
 * })
 *
 * class FetchWeather extends Command.Service<FetchWeather>()(
 *   "weather/FetchWeather",
 *   { args: { zip: Schema.String }, success: Message, error: Schema.Never }
 * ) {}
 *
 * const Weather = Html.component({
 *   name: "Weather",
 *   model: Schema.Struct({ zip: Schema.String, forecast: Schema.String }),
 *   message: Message
 * }).make({
 *   init: () => ({ zip: "", forecast: "" }),
 *   update: ($, message) =>
 *     Message.match(message, {
 *       UpdatedZip: ({ zip }) => $.evolve({ zip }),
 *       SubmittedForm: ({ zip }) => $.run(FetchWeather.make({ zip })),
 *       CompletedFetchWeather: ({ forecast }) => $.evolve({ forecast })
 *     }),
 *   view: (h, model) =>
 *     h.div(
 *       h.form.on("submit", ({ fields }) => Message.SubmittedForm({ zip: fields.zip ?? "" })).children(
 *         h.label.attr("for", "zip").children("Zip code"),
 *         h.input.attrs({ id: "zip", name: "zip" }).value(model.zip)
 *           .on("input", ({ value }) => Message.UpdatedZip({ zip: value })),
 *         h.button.children("Get Weather")
 *       ),
 *       h.p.attr("role", "status").children(model.forecast)
 *     )
 * })
 *
 * Effect.gen(function*() {
 *   const s = yield* HtmlScene.make(Weather, {})
 *   s.type(HtmlLocator.label("Zip code"), "90210")
 *     // A submit button submits its form, with the fields read from the view.
 *     .click(HtmlLocator.role("button", { name: "Get Weather" }))
 *     .expectExact(FetchWeather.make({ zip: "90210" }))
 *     .resolve(FetchWeather, Message.CompletedFetchWeather({ forecast: "sun" }))
 *     .expect(HtmlLocator.role("status")).toHaveText("sun")
 * }).pipe(Effect.scoped, Effect.runSync)
 * ```
 *
 * @stability experimental
 * @since 0.1.0
 */
import type * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type * as Component from "../../Component.ts"
import { handle } from "../../internal/handler.ts"
import * as internal from "../../internal/scene.ts"
import * as cursor from "../../internal/steps.ts"
import * as engine from "../../internal/story.ts"
import * as Locator from "../../testing/Locator.ts"
import type * as Scene from "../../testing/Scene.ts"
import type * as View from "../../View.ts"
import type * as Html from "../Html.ts"
import type * as HtmlSubscription from "../HtmlSubscription.ts"
import * as defaults from "../internal/defaults.ts"
import * as fireGlobal from "../internal/fireGlobal.ts"
import * as frames from "../internal/frames.ts"
import * as globalEvents from "../internal/globalEvents.ts"
import * as mediaQueries from "../internal/mediaQueries.ts"
import * as HtmlLocator from "./HtmlLocator.ts"

/**
 * The assertions `expect(locator)` offers in an `HtmlScene`: the scene's,
 * plus checks on fields. The checks on fields want exactly one match.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Expect<S> extends Scene.Expect<S> {
  /** Asserts the field's current value, as `HtmlLocator.value` reads it. */
  toHaveValue(value: string): S
  /** Asserts that the checkbox or radio button is checked, or isn't with `false`. */
  toBeChecked(checked?: boolean): S
  /** Asserts that the element is disabled, or isn't with `false`. */
  toBeDisabled(disabled?: boolean): S
  /** Asserts the element's accessible name, as `HtmlLocator.nameOf` computes it. */
  toHaveAccessibleName(name: string | RegExp): S
}

// The same union as `Scene.ts`'s.
type AnyComponent =
  | Component.Members<any, any, any, any, any, any, any, any, any>
  | Component.Members<any, any, any, never, any, any, any, any, any>
  | Component.Members<any, any, any, any, any, any, any, any, never>
  | Component.Members<any, any, any, never, any, any, any, any, never>

type KeyDetails = Partial<Omit<Html.KeyPayload, "key">>

type EditDetails = Partial<Pick<Html.InputPayload, "composing" | "inputType">>

/**
 * A cursor over one HTML scene: the scene's steps, plus a step per user
 * action the browser host turns into an event. Each one is an interaction.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export interface Steps<C extends AnyComponent, Parts = never>
  extends Scene.Steps<C, Parts>
{
  /**
   * Clicks the one element `target` matches, as a browser does: `pointerdown`,
   * `mousedown`, `mouseup` and `click` go to the innermost element that
   * handles each, then the defaults run. A string means `Locator.text(target)`.
   *
   * **Details**
   *
   * - Each pointer and mouse event carries the mouse's primary button at the
   *   origin with no modifier keys. `fire` sends an event with another payload,
   *   such as a tap's `pointerType`.
   * - Cancelling `pointerdown` skips `mousedown` and `mouseup` but not `click`.
   *   Cancelling `mousedown` or `mouseup` skips nothing. Only a cancelled
   *   `click` skips the defaults, and only `click` and its defaults set
   *   `defaultPrevented`.
   * - A disabled `button`, `input`, `select` or `textarea`, or one inside a
   *   disabled `fieldset`, throws: the browser sends it nothing. If the press
   *   removes or disables the element, the rest of the click isn't sent.
   * - A submit button submits its form: `submit` goes to the form with the
   *   fields read from the view, the button's own name and value included.
   * - A checkbox fires `input` and `change` with `checked` flipped, and an
   *   unchecked radio button with `checked: true`.
   * - A button with `popovertarget` fires `toggle` on the popover with the
   *   state `popovertargetaction` asks for, when that changes it.
   *
   * Each event goes to the view as the event before it left it. The click
   * throws when nothing handles any of them, and is ignored when none
   * produced a message.
   */
  click(target: string | Locator.Locator): this
  /**
   * Sets a field's value as typing does: sends `input` with `value`. An
   * `input` also sends its current `checked`. `details` sets `composing`,
   * `false` otherwise, and `inputType`, `"insertText"` otherwise, so an
   * input method's text or an autofill's `"insertReplacementText"` can be
   * sent too.
   */
  type(locator: Locator.Locator, value: string, details?: EditDetails): this
  /**
   * Sends `change`, as a field does once its edit is committed. A string is
   * the new value; an object also sets `checked` on an `input`, its current
   * `checked` otherwise, `files` on a file input, none otherwise, and
   * `composing` and `inputType`, `false` and `""` otherwise.
   * `change(locator, { files })` chooses files in a file input.
   */
  change(
    locator: Locator.Locator,
    value: string | Partial<Html.InputPayload>
  ): this
  /**
   * Ends an input method's composition: sends `compositionend` with
   * `value`, or the field's current value when it's left out.
   */
  compositionEnd(locator: Locator.Locator, value?: string): this
  /**
   * Presses `key`: sends `keydown` with the modifier keys, `composing`,
   * `repeat` and selection given, each `false` or `null` otherwise. `editable`
   * defaults from the matched element unless given.
   */
  keydown(locator: Locator.Locator, key: string, details?: KeyDetails): this
  /**
   * Submits the form `locator` matches, or the one the matched element is
   * in, as pressing Enter in it would: `submit` goes to the form with the
   * fields read from the view. No button counts as the submitter.
   */
  submit(locator: Locator.Locator): this
  /** Sends `focus` as the keyboard would, with `focusVisible` true. */
  focus(locator: Locator.Locator): this
  /** Sends `blur`. */
  blur(locator: Locator.Locator): this
  /**
   * Drops `payload` on the element `locator` matches, as the browser host
   * would. Missing payload fields default to empty data, no files and a
   * zero box. The drag's types are the keys of `data`, plus `"Files"` when
   * `files` isn't empty.
   *
   * **Details**
   *
   * The drop goes to the innermost element, the matched one or an ancestor,
   * whose `dropTarget` accepts one of those types, compared without case. It
   * throws when no drop target there accepts the types. The browser host
   * always cancels a drop on a target, so the default is cancelled.
   */
  drop(locator: Locator.Locator, payload?: Partial<Html.DropPayload>): this
  /**
   * Sends an event `element` declares, from the element `locator` matches,
   * with `detail` as the element would send it.
   *
   * **Details**
   *
   * The innermost element with a handler for `event`, the matched one or an
   * ancestor, gets it, as a bubbling event does. The handler gets `detail`
   * decoded by the event's Schema, as in the browser host. The step throws
   * when nothing handles `event` there or above, and is ignored when the
   * handler returns `undefined`.
   */
  fireElement<
    E extends { readonly [event: string]: Schema.Decoder<unknown> },
    K extends keyof E & string
  >(
    element: Html.CustomElementBinding<any, any, E>,
    locator: Locator.Locator,
    event: K,
    detail: E[K]["Encoded"]
  ): this
  /**
   * Fires `event` on the document, as the browser host delivers it to the
   * component's `HtmlSubscription.onDocument` listeners. Missing payload
   * fields default as `keydown` and `click` default them, and
   * `defaultPrevented` to `false`.
   *
   * **Details**
   *
   * The capture listener runs first, then the bubble one. Each is read
   * from the `subscriptions` result current as its phase starts, as in a
   * browser, so a bubble listener the capture listener's message added
   * runs, and one it removed doesn't. A listener's `preventDefault`
   * applies to its own message, and the bubble listener sees in
   * `defaultPrevented` what the capture listener cancelled.
   *
   * It throws when nothing listens for `event` on the document, listing
   * the active keys, and is ignored when no listener produced a message.
   */
  fireDocument<K extends keyof HtmlSubscription.DocumentEvents>(
    event: K,
    payload?: Partial<
      HtmlSubscription.GlobalPayload<HtmlSubscription.DocumentEvents[K]>
    >
  ): this
  /**
   * Fires `event` on the window, as `fireDocument` does for
   * `HtmlSubscription.onWindow`'s listeners.
   */
  fireWindow<K extends keyof HtmlSubscription.WindowEvents>(
    event: K,
    payload?: Partial<
      HtmlSubscription.GlobalPayload<HtmlSubscription.WindowEvents[K]>
    >
  ): this
  /**
   * Fires a custom `event` on the document, as `fireDocument` does for
   * `HtmlSubscription.onCustomEvent`'s listeners. `detail` defaults to `null`
   * and `defaultPrevented` to `false`.
   */
  fireCustomEvent(
    event: string,
    payload?: Partial<
      HtmlSubscription.GlobalPayload<HtmlSubscription.CustomEventPayload>
    >
  ): this
  /**
   * Fires an animation frame `delta` ms after the last, `16` by default,
   * as the browser host delivers it to the component's
   * `HtmlSubscription.onAnimationFrame`, and dispatches what its handler
   * returns.
   *
   * It throws when nothing listens for frames, listing the active keys, and
   * is ignored when the handler returns `undefined`.
   */
  frame(delta?: number): this
  /**
   * Sends `matches` to the component's `HtmlSubscription.onMediaQuery` handler
   * for `query`, simulating an initial match or a change.
   *
   * It throws when nothing listens for `query`, listing the active keys, and
   * is ignored when the handler returns `undefined`.
   */
  mediaQuery(query: string, matches: boolean): this

  /** Asserts on the elements `locator` matches in the current view. */
  expect(locator: Locator.Locator): Expect<this>
}

/**
 * Helper types for `Steps`.
 *
 * @stability experimental
 * @since 0.1.0
 */
export declare namespace Steps {
  /**
   * A cursor over any component, for steps shared across components.
   *
   * @stability experimental
   * @category models
   * @since 0.1.0
   */
  export type Any = Steps<AnyComponent, any>
}

const follow = (
  root: Locator.Node,
  node: Locator.Node,
  state: engine.State<any, any, any, any>
): Locator.Node | undefined =>
  internal.followNode(
    root as View.Node<any, any>,
    node as View.Node<any, any>,
    state.root as View.Node<any, any>
  ) as Locator.Node | undefined

class StepsImpl extends internal.SceneCursor {
  override click(target: string | Locator.Locator): this {
    const locator = typeof target === "string" ? Locator.text(target) : target
    let prevented = false
    let handled = false
    return this.act(
      "click",
      "message",
      (state) => {
        const step = this.name("click")
        const description = locator.description
        let out = state
        let reached = false
        let childOnly: string | undefined
        const send = (
          node: Locator.Node,
          event: string,
          payload: unknown = internal.pointer,
          at = description
        ): boolean => {
          const fired = engine.tryFireNode(out, node, event, payload, step, at)
          if (fired === undefined) return false
          if ("error" in fired) {
            if (childOnly === undefined || event === "click") {
              childOnly = fired.error
            }
          } else {
            reached = true
            handled ||= fired.handled
            out = fired.story
          }
          return fired.prevented
        }
        const pathOf = (node: Locator.Node) =>
          engine.ancestry(out, node) as ReadonlyArray<Locator.Node>
        const enabled = (
          root: Locator.Node,
          node: Locator.Node
        ): Locator.Node | undefined => {
          const now = follow(root, node, out)
          return now === undefined || defaults.isClickDisabled(pathOf(now))
            ? undefined
            : now
        }
        const run = (): void => {
          const found = engine.findOne(state, locator, step)
          if (defaults.isClickDisabled(pathOf(found))) {
            throw new Error(`${step}: ${description} is disabled`)
          }
          const skipMouse = send(found, "pointerdown")
          if (!skipMouse) {
            const held = enabled(state.root, found)
            if (held === undefined) return
            send(held, "mousedown")
          }
          const pressed = enabled(state.root, found)
          if (pressed === undefined) return
          const root = out.root
          const plan = defaults.planClickDefaults(
            root,
            pressed,
            pathOf(pressed),
            description
          )
          if (!skipMouse) send(pressed, "mouseup")
          const released = enabled(root, pressed)
          if (released === undefined) return
          prevented = send(released, "click")
          if (prevented) return
          for (const planned of plan) {
            const now = follow(root, planned.node, out)
            if (now === undefined) continue
            const payload = planned.payload(out.root, (node, description) => {
              const at = follow(root, node, out)
              if (at === undefined) {
                throw new Error(
                  `${step}: ${description} is no longer in the view`
                )
              }
              return at
            })
            if (send(now, planned.event, payload, planned.description)) {
              prevented = true
            }
          }
        }
        run()
        if (!reached) {
          throw new Error(
            childOnly ?? `${step}: nothing handles "click" at ${description}`
          )
        }
        return out
      },
      () => ({
        interaction: handled ? "handled" : "ignored",
        defaultPrevented: prevented
      })
    )
  }
  type(locator: Locator.Locator, value: string, details?: EditDetails): this {
    return this.one(
      "type",
      locator,
      "input",
      (node) => defaults.inputPayload(node, value, details)
    )
  }
  change(
    locator: Locator.Locator,
    value: string | Partial<Html.InputPayload>
  ): this {
    return this.one(
      "change",
      locator,
      "change",
      (node) => defaults.changePayload(node, value)
    )
  }
  compositionEnd(locator: Locator.Locator, value?: string): this {
    return this.one(
      "compositionEnd",
      locator,
      "compositionend",
      (node): Html.CompositionPayload => ({
        value: value ?? HtmlLocator.value(node) ?? ""
      })
    )
  }
  keydown(locator: Locator.Locator, key: string, details?: KeyDetails): this {
    return this.one(
      "keydown",
      locator,
      "keydown",
      (node, state) =>
        defaults.keyPayload(
          key,
          details,
          engine.ancestry(state, node) as ReadonlyArray<Locator.Node>
        )
    )
  }
  submit(locator: Locator.Locator): this {
    return this.interact("submit", (state) => {
      const step = this.name("submit")
      const node = engine.findOne(state, locator, step)
      const form = defaults.formOf(
        engine.ancestry(state, node) as ReadonlyArray<Locator.Node>,
        state.root
      )
      if (form === undefined) {
        throw new Error(`${step}: ${locator.description} isn't in a form`)
      }
      return [{
        node: () => form,
        description: `the form of ${locator.description}`,
        event: "submit",
        payload: () => defaults.formFields(state.root, form, undefined)
      }]
    })
  }
  focus(locator: Locator.Locator): this {
    return this.one("focus", locator, "focus", () => ({ focusVisible: true }))
  }
  blur(locator: Locator.Locator): this {
    return this.one("blur", locator, "blur", () => ({}))
  }
  drop(locator: Locator.Locator, payload?: Partial<Html.DropPayload>): this {
    const drop = defaults.drop(payload)
    return this.interact("drop", (state) => {
      const step = this.name("drop")
      const node = engine.findOne(state, locator, step)
      // Any layer's `dropTarget` makes a target, a part's included. The scene then decides which layers run.
      const target = engine.ancestry(state, node).find((
        at
      ): at is View.Element<any, any> =>
        at._tag === "Element" &&
        [at, ...(at.owned ?? [])].some((layer) =>
          Object.hasOwn(layer.handlers, "drop") &&
          drop.accepts(layer.eventOptions.drop)
        )
      )
      if (target === undefined) throw drop.noTarget(step, locator.description)
      return [{
        node: () => target as unknown as Locator.Node,
        description: `the drop target at ${locator.description}`,
        event: "drop",
        payload: () => drop.payload
      }]
    }).markPrevented()
  }
  /** A drop on a target is always cancelled by the host. */
  private markPrevented(): this {
    return this.replace(engine.update(this.state, { defaultPrevented: true }))
  }
  fireElement(
    _element: unknown,
    locator: Locator.Locator,
    event: string,
    detail: unknown
  ): this {
    return this.one("fireElement", locator, event, () => ({ detail }))
  }
  fireDocument(event: string, payload?: object): this {
    return this.fireGlobal("fireDocument", "document", event, payload)
  }
  fireWindow(event: string, payload?: object): this {
    return this.fireGlobal("fireWindow", "window", event, payload)
  }
  fireCustomEvent(event: string, payload?: object): this {
    return this.fireGlobal(
      "fireCustomEvent",
      "document",
      event,
      fireGlobal.custom(payload)
    )
  }
  private fireGlobal(
    step: string,
    target: "document" | "window",
    event: string,
    given: object | undefined
  ): this {
    let cancelled = false
    let handled = false
    return this.act(
      step,
      "message",
      (state) => {
        let out = state
        let heard = false
        cancelled = fireGlobal.fire(event, given, (capture) => {
          const declared = out.declared().map(globalEvents.listenerOf).find((
            declared
          ) =>
            declared !== undefined && declared.target === target &&
            declared.event === event &&
            declared.capture === capture
          )
          if (declared === undefined) return []
          heard = true
          return [(payload, preventDefault) =>
            globalEvents.run(
              declared,
              payload,
              preventDefault,
              (message, cancel) => {
                cancel()
                handled = true
                out = engine.dispatch(out, message)
              }
            )]
        })
        if (!heard) {
          throw new Error(
            `${this.name(step)}: nothing listens for ${
              JSON.stringify(event)
            } on the ${target}; active keys: ${
              JSON.stringify(state.subscriptions())
            }`
          )
        }
        return out
      },
      () => ({
        interaction: handled ? "handled" : "ignored",
        defaultPrevented: cancelled
      })
    )
  }
  frame(delta = 16): this {
    return this.fireDeclared(
      "frame",
      "animation frames",
      delta,
      frames.handlerOf
    )
  }
  mediaQuery(query: string, matches: boolean): this {
    return this.fireDeclared(
      "mediaQuery",
      `media query ${JSON.stringify(query)}`,
      matches,
      (subscription) => {
        const declared = mediaQueries.listenerOf(subscription)
        return declared?.query === query ? declared.handler : undefined
      }
    )
  }
  private fireDeclared<A>(
    step: string,
    what: string,
    payload: A,
    handlerOf: (subscription: object) => View.Handler<unknown, A> | undefined
  ): this {
    let handled = false
    return this.act(step, "message", (state) => {
      const handler = state.declared().map(handlerOf).find((handler) =>
        handler !== undefined
      )
      if (handler === undefined) {
        throw new Error(
          `${this.name(step)}: nothing listens for ${what}; active keys: ${
            JSON.stringify(state.subscriptions())
          }`
        )
      }
      const message = handle(handler, payload)
      if (message === undefined) return state
      handled = true
      return engine.dispatch(state, message)
    }, () => ({ interaction: handled ? "handled" : "ignored" }))
  }
  override expect(locator: Locator.Locator): object {
    return this.expectation(locator, defaults.matchers)
  }
}

/**
 * Starts an HTML scene: `init` with `props`, as a cursor in a scope. It
 * takes what `Scene.make` takes, and runs the same end check when the scope
 * closes.
 *
 * @stability experimental
 * @category constructors
 * @since 0.1.0
 */
export const make: {
  <C extends AnyComponent>(
    component: C,
    props: Component.Props<C>
  ): Effect.Effect<Steps<C>, never, Scope.Scope>
  <C extends AnyComponent, V extends View.Elements = never>(
    component: C,
    props: Component.Props<C>,
    options: {
      readonly elements?: View.Vocabulary<V> | undefined
      readonly slots: (
        h:
          & View.Helper<never, unknown>
          & View.Tags<[V] extends [never] ? VocabularyOf<C> : V, never>
      ) => { readonly [K in Component.Slots<C>]?: View.Input<never, any> }
    }
  ): Effect.Effect<Steps<C>, never, Scope.Scope>
  <Props, Events, Parts, R, Rcv, V extends View.Elements = never>(
    component: Component.Headless<Props, Events, Parts, R, Rcv>,
    props: Props,
    options: {
      readonly elements?: View.Vocabulary<V> | undefined
      readonly view: (
        parts: Parts,
        h: View.Helper<never, Props> & View.Tags<V, never>
      ) => View.Content<never, any>
    }
  ): Effect.Effect<
    Steps<Component.Component<string, Props, any, any, Events, R, V>, Parts>,
    never,
    Scope.Scope
  >
} = (component: any, props: any, options?: any): any =>
  cursor.scoped(
    make,
    () => internal.begin(StepsImpl, "HtmlScene", component, props, options)
  )

/**
 * The cursor after `init`. Its steps follow the acknowledgement rule, but
 * nothing checks what's pending or unacknowledged at the end.
 *
 * @stability experimental
 * @category constructors
 * @since 0.1.0
 */
export const start: {
  <C extends AnyComponent>(component: C, props: Component.Props<C>): Steps<C>
  <Props, Events, Parts, R, Rcv, V extends View.Elements = never>(
    component: Component.Headless<Props, Events, Parts, R, Rcv>,
    props: Props,
    options: {
      readonly elements?: View.Vocabulary<V> | undefined
      readonly view: (
        parts: Parts,
        h: View.Helper<never, Props> & View.Tags<V, never>
      ) => View.Content<never, any>
    }
  ): Steps<Component.Component<string, Props, any, any, Events, R, V>, Parts>
} = (component: any, props: any, options?: any): any =>
  internal.begin(StepsImpl, "HtmlScene", component, props, options)

/** The vocabulary a component's view builds from. */
type VocabularyOf<C> = C extends { readonly "~V"?: infer V } ? V : never
