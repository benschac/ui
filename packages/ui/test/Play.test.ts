import { Command, Component, UiSchema } from "@effect/ui"
import { Locator, Play, TestHost } from "@effect/ui/testing"
import { assert, it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import { TestClock } from "effect/testing"

const SaverMessage = UiSchema.TaggedEnum({ ClickedSave: {}, SucceededSave: {} })
const SaverEvents = UiSchema.TaggedEnum({ Saved: {} })

class Save extends Command.Service<Save>()(
  "Saver/Save",
  { args: {}, success: SaverMessage, error: Schema.Never }
) {
  static readonly layer = this.toLayer(() =>
    Effect.as(Effect.sleep("1 second"), SaverMessage.SucceededSave())
  )
}

const Saver = Component.define({
  name: "Saver",
  model: Schema.Null,
  message: SaverMessage,
  events: SaverEvents
}).make({
  init: () => null,
  update: ($, message) =>
    SaverMessage.match(message, {
      ClickedSave: () => $.run(Save.make({})),
      SucceededSave: () => $.emit(SaverEvents.Saved())
    }),
  view: (h) =>
    h.el("button").on("click", SaverMessage.ClickedSave()).children("Save")
})

const Page = Component.define({
  name: "Page",
  model: Schema.Number,
  message: Schema.Literals(["Saved", "Ignored"])
}).make({
  init: () => 0,
  update: ($, message) => message === "Saved" ? $.model + 1 : $.model,
  view: (h, saves) =>
    h.el("div").children(
      Saver(h, { props: {}, onEmit: () => "Saved" }),
      h.el("button").on("click", () => undefined).children("Nothing"),
      h.el("p").children(`saves: ${saves}`)
    )
}).pipe(Component.provide(Save.layer))

const saves = Locator.tag("p")

const failureOf = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "succeeded"

it.layer(TestHost.layer(), { buildPerTest: true })("Play", (it) => {
  it.effect("runs a child's real Command, and picks up the clock at the next step", () =>
    Effect.gen(function*() {
      const play = yield* Play.make(Page, {})
      yield* play.click("Save")
      yield* play.expect(saves).toHaveText("saves: 0")
      yield* TestClock.adjust("1 second")
      yield* play.expect(saves).toHaveText("saves: 1")
      assert.strictEqual(play.root.model(), 1)
    }))

  it.effect("an interaction that produced no message must be acknowledged before the next and at the end", () =>
    Effect.gen(function*() {
      const play = yield* Play.make(Page, {})
      yield* play.click("Nothing")
      assert.match(
        failureOf(yield* Effect.exit(play.click("Save"))),
        /Play\.click: the click before it produced no message: acknowledge it with expectIgnored\(\)/
      )
      yield* play.expectIgnored()
      yield* play.click("Save")
      assert.match(
        failureOf(yield* Effect.exit(play.expectIgnored())),
        /the last interaction produced a message/
      )

      const unacknowledged = yield* Effect.exit(Effect.scoped(Effect.andThen(
        Play.make(Page, {}),
        (play) => play.click("Nothing")
      )))
      assert.match(
        failureOf(unacknowledged),
        /Play\.make: the last click produced no message/
      )
    }))

  it.effect("a failed expectation lists the tree's elements", () =>
    Effect.gen(function*() {
      const play = yield* Play.make(Page, {})
      yield* play.expect(saves).toHaveAttribute("data-missing", false)
      assert.match(
        failureOf(
          yield* Effect.exit(play.expect(saves).toHaveText("saves: 9"))
        ),
        /Play\.expect\(<p>\)\.toHaveText\("saves: 9"\): its text is "saves: 0"; elements:\n  <div>/
      )
    }))
})
