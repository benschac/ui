import { Command, Component, UiSchema } from "@effect/ui"
import { Story } from "@effect/ui/testing"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

const Message = UiSchema.TaggedEnum({ Step: {}, Logged: { n: Schema.Number } })
const Events = UiSchema.TaggedEnum({ Stepped: { n: Schema.Number } })

class Log extends Command.Service<Log>()(
  "test/define/Log",
  {
    args: { n: Schema.Number },
    success: Message,
    error: Schema.Never,
    invalidates: () => []
  }
) {}

const CounterDef = Component.define({
  name: "Counter",
  props: Schema.Struct({ by: Schema.Number }),
  model: Schema.Struct({ n: Schema.Number, seen: Schema.Array(Schema.String) }),
  message: Message,
  events: Events
})

// Changes the Model, runs a Command and emits, all from the Model it is given.
const bump = CounterDef.update(($, msg) => {
  const n = $.model.n + $.props.by
  return $.set({ n, seen: [...$.model.seen, msg._tag] })
    .run(Log.make({ n }))
    .emit(Events.Stepped({ n }))
})

const Counter = CounterDef.make({
  init: () => ({ n: 0, seen: [] }),
  update: {
    Step: ($) => $.combine(bump, bump),
    Logged: ($, msg) => ({
      ...$.model,
      seen: [...$.model.seen, `logged ${msg.n}`]
    })
  },
  view: (h, model) => h.el("p", String(model.n))
})

const counterUpdate = CounterDef.update({
  Step: ($) => $.combine(bump, bump),
  Logged: ($, msg) => ({
    ...$.model,
    seen: [...$.model.seen, `logged ${msg.n}`]
  })
})

const ExtractedCounter = CounterDef.make({
  init: () => ({ n: 0, seen: [] }),
  update: counterUpdate,
  view: (h, model) => h.el("p", String(model.n))
})

// `$.combine` in a slice runs `bump` with the message the slice was given.
const onLogged = CounterDef.update("Logged", ($) => $.combine(bump))

// Calls the slice by hand with a message other than the one it received.
const ByHand = CounterDef.make({
  init: () => ({ n: 0, seen: [] }),
  update: ($, msg) =>
    msg._tag === "Step" ? onLogged($, { _tag: "Logged", n: 0 }) : $.model,
  view: (h, model) => h.el("p", String(model.n))
})

describe("Component.define", () => {
  it.effect("$.combine folds the Model and keeps every Command and event in call order", () =>
    Effect.gen(function*() {
      const story = yield* Story.make(Counter, { by: 2 })
      story.send(Message.Step())
      assert.deepStrictEqual(story.model, { n: 4, seen: ["Step", "Step"] })
      story.expectExact(Log.make({ n: 2 }), Log.make({ n: 4 }))
        .emitted(Events.Stepped({ n: 2 }), Events.Stepped({ n: 4 }))
        .resolve(Log.make({ n: 2 }), Message.Logged({ n: 2 }))
        .resolve(Log.make({ n: 4 }), Message.Logged({ n: 4 }))
    }))

  it.effect("a record update dispatches by _tag", () =>
    Effect.gen(function*() {
      const story = yield* Story.make(Counter, { by: 1 })
      story.send(Message.Step())
        .emitted(Events.Stepped({ n: 1 }), Events.Stepped({ n: 2 }))
        .resolve(Log.make({ n: 1 }), Message.Logged({ n: 1 }))
        .resolve(Log.make({ n: 2 }), Message.Logged({ n: 2 }))
      assert.deepStrictEqual(story.model.seen, [
        "Step",
        "Step",
        "logged 1",
        "logged 2"
      ])
    }))

  it.effect("a slice called by hand binds $ to the message it is given", () =>
    Effect.gen(function*() {
      const story = yield* Story.make(ByHand, { by: 1 })
      story.send(Message.Step())
      assert.deepStrictEqual(story.model.seen, ["Logged"])
      story.emitted(Events.Stepped({ n: 1 }))
        .resolve(Log.make({ n: 1 }), Message.Logged({ n: 1 }))
    }))

  it.effect("an extracted record update dispatches identically to an inline record", () =>
    Effect.gen(function*() {
      const inlineStory = yield* Story.make(Counter, { by: 2 })
      const extractedStory = yield* Story.make(ExtractedCounter, { by: 2 })
      for (const story of [inlineStory, extractedStory]) {
        story.send(Message.Step())
          .expectExact(Log.make({ n: 2 }), Log.make({ n: 4 }))
          .emitted(Events.Stepped({ n: 2 }), Events.Stepped({ n: 4 }))
          .resolve(Log.make({ n: 2 }), Message.Logged({ n: 2 }))
          .resolve(Log.make({ n: 4 }), Message.Logged({ n: 4 }))
        assert.deepStrictEqual(story.model, {
          n: 4,
          seen: ["Step", "Step", "logged 2", "logged 4"]
        })
      }
    }))
})
