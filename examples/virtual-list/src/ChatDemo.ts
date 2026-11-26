import { Command, Component, UiSchema } from "@effect/ui"
import { VirtualList, VirtualListScrollTarget } from "@effect/ui-kit"
import { Html } from "@effect/ui/html"
import { Duration, Effect, Schema } from "effect"
import { textOf } from "./shared.ts"

const total = 500
const page = 50
const reserve = 2000

const ChatMessage = UiSchema.TaggedEnum({
  ApproachedStart: {},
  LoadedOlder: { before: Schema.Number },
  ClickedSend: {}
})

class LoadOlder extends Command.Service<LoadOlder>()(
  "virtual-list/LoadOlder",
  {
    args: { before: Schema.Number },
    success: ChatMessage,
    error: Schema.Never,
    mode: "switch"
  }
) {
  static readonly layer = this.toLayer(({ before }) =>
    Effect.sleep(Duration.millis(500)).pipe(
      Effect.as(ChatMessage.LoadedOlder({ before }))
    )
  )
}

const ChatModel = Schema.Struct({
  start: Schema.Number,
  sent: Schema.Number,
  loading: Schema.Boolean
})

const ChatDemoNoDeps = Html.component({
  name: "ChatDemo",
  model: ChatModel,
  message: ChatMessage
}).make({
  init: () => ({ start: total - page, sent: 0, loading: false }),
  update: {
    ApproachedStart: ($) =>
      $.model.loading || $.model.start === 0
        ? $.model
        : $.evolve({ loading: true }).run(
          LoadOlder.make({ before: $.model.start })
        ),
    LoadedOlder: ($, { before }) =>
      before === $.model.start
        ? $.evolve({ start: Math.max(0, before - page), loading: false })
        : $.model,
    ClickedSend: ($) => $.evolve({ sent: (sent) => sent + 1 })
  },
  view: (h, model) => {
    const ids = Array.from(
      { length: total - model.start + model.sent },
      (_, i) => "m" + (model.start + i)
    )
    return h.div.class("page").children(
      h.div.class("toolbar").children(
        h.button.attr("id", "send").on("click", ChatMessage.ClickedSend())
          .children(
            "Send a message"
          ),
        h.span.attr("id", "status").attr("data-start", String(model.start))
          .attr(
            "data-loading",
            String(model.loading)
          ).children(
            model.start === 0
              ? "All messages loaded"
              : `Loaded from message ${model.start}`
          )
      ),
      VirtualList(h, {
        props: {
          itemSize: 48,
          keys: ids,
          reserveStart: model.start === 0 ? 0 : reserve,
          contentAlignment: "end",
          followEnd: true,
          scrollTo: { target: VirtualListScrollTarget.End() }
        },
        onEmit: {
          Scrolled: ({ first }) =>
            first < 20 ? ChatMessage.ApproachedStart() : undefined
        },
        view: (virtualList) =>
          virtualList.viewport(
            h.div.class("scroller chat").attr(
              "data-at-start",
              String(virtualList.atStart)
            )
          )
            .children(
              virtualList.list(h.ol.class("messages")).children(
                virtualList.items.map((index) => {
                  const number = model.start + index
                  return virtualList.item({
                    element: h.li.class("message").key(ids[index]!),
                    index
                  }).children(
                    h.strong.children("Message " + number),
                    h.p.children(textOf(number))
                  )
                })
              )
            )
      })
    )
  }
})

export const ChatDemo = ChatDemoNoDeps.pipe(Component.provide(LoadOlder.layer))
