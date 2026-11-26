import { Command, type Component, Query, UiSchema, type View } from "@effect/ui"
import { Html } from "@effect/ui/html"
import { Schema } from "effect"
import type { AsyncResult } from "effect/reactivity"
import { describe, expect, it } from "tstyche"

const User = Schema.Struct({ id: Schema.String, name: Schema.String })

class GetUser extends Query.Service<GetUser>()(
  "typetest/define/GetUser",
  {
    args: { id: Schema.String },
    success: User,
    error: Schema.String,
    staleTime: "1 minute"
  }
) {}

const Message = UiSchema.TaggedEnum({
  Edited: { body: Schema.String },
  SaveClicked: {},
  Saved: {}
})
type Message = typeof Message.Type

const Events = UiSchema.TaggedEnum({ Changed: {} })

class Save extends Command.Service<Save>()(
  "typetest/define/Save",
  { args: {}, success: Message, error: Schema.Never, invalidates: () => [] }
) {}
class Audit extends Command.Service<Audit>()(
  "typetest/define/Audit",
  { args: {}, success: Message, error: Schema.Never, invalidates: () => [] }
) {}

const Model = Schema.Struct({ body: Schema.String, edits: Schema.Number })
type Model = typeof Model.Type

const NoteDef = Html.component({
  name: "Note",
  props: Schema.Struct({ id: Schema.String }),
  model: Model,
  message: Message,
  events: Events,
  queries: { user: { query: GetUser, args: ({ props }) => ({ id: props.id }) } }
})

const save = NoteDef.update(($) => $.run(Save.make()))
const audit = NoteDef.update(($) => $.run(Audit.make()))
const touch = NoteDef.update(($) => ({ ...$.model, edits: $.model.edits + 1 }))

const shared = { Saved: touch, Deleted: touch }

describe("Component.define", () => {
  it("View.HelperBase and View.WithTags support pure views", () => {
    expect<View.WithTags<Message, unknown, Html.Elements>>().type.toBe<
      View.Helper<Message, unknown> & View.Tags<Html.Elements, Message>
    >()
    expect<View.Helper<Message, unknown>["text"]>().type.toBe<
      (text: string) => View.Text
    >()
    expect<View.HelperBase<Message, unknown>>().type.not.toHaveProperty("text")
    const Row = <Msg>(h: View.HelperBase<Msg, unknown>, label: string) =>
      h.el("li", label)
    NoteDef.view((h, model) => h.ul(Row(h, model.body)))
  })

  it("types an untagged update over the whole message, from the definition", () => {
    NoteDef.update(($, msg) => {
      expect($.model).type.toBe<Model>()
      expect(msg).type.toBe<Message>()
      expect($.props).type.toBe<{ readonly id: string }>()
      expect($.queries.user).type.toBe<
        AsyncResult.AsyncResult<typeof User.Type, string>
      >()
      return $.model
    })
    expect<ReturnType<typeof save>>().type.toBe<
      Component.Step<
        Model,
        Message,
        typeof Events.Type,
        Save,
        { readonly user: Component.QueryOne<typeof GetUser> }
      >
    >()
  })

  it("narrows the message of a slice by tag", () => {
    NoteDef.update("Edited", ($, msg) => {
      expect(msg).type.toBe<
        { readonly _tag: "Edited"; readonly body: string }
      >()
      return { ...$.model, body: msg.body }
    })
  })

  it("rejects an unknown tag", () => {
    expect(NoteDef.update).type.not.toBeCallableWith(
      "Deleted",
      ($: { readonly model: Model }) => $.model
    )
  })

  it("types h from the definition, with its queries and elements", () => {
    NoteDef.view((h, model) => {
      expect(model).type.toBe<Model>()
      expect(h.props).type.toBe<{ readonly id: string }>()
      expect(h.queries.user).type.toBe<
        AsyncResult.AsyncResult<typeof User.Type, string>
      >()
      return h.p(model.body)
    })
  })

  it("unions the requirements of the functions $.combine runs", () => {
    const both = NoteDef.update(($) => $.combine(touch, save, audit))
    const Note = NoteDef.make({
      init: () => ({ body: "", edits: 0 }),
      update: both,
      view: (h) => h.p()
    })
    expect<Component.Requirements<typeof Note>>().type.toBe<
      GetUser | Save | Audit
    >()
  })

  it("narrows $ in a slice, and $.combine there takes same-tag slices, whole-message and inline functions", () => {
    const validate = NoteDef.update("SaveClicked", ($) => $.model)
    const handle = NoteDef.update("SaveClicked", ($) => {
      expect($).type.toBe<
        Component.Update<
          Model,
          Message,
          typeof Events.Type,
          { readonly id: string },
          { readonly user: Component.QueryOne<typeof GetUser> },
          { readonly _tag: "SaveClicked" }
        >
      >()
      return $.combine(validate, touch, save, ($, msg) => {
        expect(msg).type.toBe<{ readonly _tag: "SaveClicked" }>()
        return $.run(Audit.make())
      })
    })
    const Note = NoteDef.make({
      init: () => ({ body: "", edits: 0 }),
      update: { Edited: touch, SaveClicked: handle, Saved: touch },
      view: (h) => h.p()
    })
    expect<Component.Requirements<typeof Note>>().type.toBe<
      GetUser | Save | Audit
    >()
  })

  it("rejects another tag's slice in $.combine in a slice", () => {
    const edited = NoteDef.update(
      "Edited",
      ($, msg) => ({ ...$.model, body: msg.body })
    )
    NoteDef.update("SaveClicked", ($) => {
      expect($.combine).type.not.toBeCallableWith(edited)
      return $.model
    })
  })

  it("calls a slice by hand from an update over the whole message", () => {
    const edited = NoteDef.update(
      "Edited",
      ($, msg) => $.combine(() => ({ ...$.model, body: msg.body }), save)
    )
    const Note = NoteDef.make({
      init: () => ({ body: "", edits: 0 }),
      update: ($, msg) => msg._tag === "Edited" ? edited($, msg) : $.model,
      view: (h) => h.p()
    })
    expect<Component.Requirements<typeof Note>>().type.toBe<GetUser | Save>()
  })

  it("rejects a tagged slice in $.combine", () => {
    const edited = NoteDef.update(
      "Edited",
      ($, msg) => ({ ...$.model, body: msg.body })
    )
    NoteDef.update(($) => {
      expect($.combine).type.not.toBeCallableWith(edited)
      return $.combine(touch)
    })
  })

  it("takes a record of slices, with inline handlers narrowed", () => {
    const Note = NoteDef.make({
      init: () => ({ body: "", edits: 0 }),
      update: {
        Edited: ($, msg) => {
          expect(msg).type.toBe<
            { readonly _tag: "Edited"; readonly body: string }
          >()
          expect($.combine).type.not.toBeCallableWith(
            touch as (
              $: Parameters<typeof touch>[0],
              msg: { readonly _tag: "Saved" }
            ) => Model
          )
          return { ...$.model, body: msg.body }
        },
        SaveClicked: NoteDef.update(
          "SaveClicked",
          ($) => $.combine(touch, save)
        ),
        Saved: touch
      },
      view: (h) => h.p()
    })
    expect<Component.Requirements<typeof Note>>().type.toBe<GetUser | Save>()
  })

  it("infers headless requirements from an inline update handler", () => {
    const Note = NoteDef.make({
      init: () => ({ body: "", edits: 0 }),
      update: {
        Edited: touch,
        SaveClicked: ($) => $.run(Save.make()),
        Saved: shared.Saved
      },
      parts: (_, model) => ({ body: model.body })
    })
    expect<Component.Headless.Requirements<typeof Note>>().type.toBe<
      GetUser | Save
    >()
  })

  it("rejects the diagnostic string as a stale record entry", () => {
    const init = () => ({ body: "", edits: 0 })
    const update = {
      Edited: touch,
      SaveClicked: touch,
      Saved: touch,
      Deleted: "'Deleted' is not a tag of this component's message" as const
    }
    expect(NoteDef.make).type.not.toBeCallableWith({
      init,
      update,
      view: (h: Component.Helper<typeof NoteDef>) => h.p()
    })
  })

  it("rejects a record with a missing tag", () => {
    expect(NoteDef.make).type.not.toBeCallableWith({
      init: () => ({ body: "", edits: 0 }),
      update: { Edited: touch, SaveClicked: touch },
      view: (h: Component.Helper<typeof NoteDef>) => h.p()
    })
  })

  it("rejects a record key that is no tag, and names it", () => {
    NoteDef.make({
      init: () => ({ body: "", edits: 0 }),
      update: {
        Edited: touch,
        SaveClicked: touch,
        Saved: touch,
        // @ts-expect-error 'Deleted' is not a tag of this component's message
        Deleted: touch
      },
      view: (h: Component.Helper<typeof NoteDef>) => h.p()
    })
  })

  it("rejects stale handlers in a spread and in a record variable", () => {
    const init = () => ({ body: "", edits: 0 })
    const view = (h: Component.Helper<typeof NoteDef>) => h.p()
    const record = { ...shared, Edited: touch, SaveClicked: touch }
    expect(NoteDef.make).type.not.toBeCallableWith({
      init,
      update: { ...shared, Edited: touch, SaveClicked: touch },
      view
    })
    expect(NoteDef.make).type.not.toBeCallableWith({
      init,
      update: record,
      parts: (_: unknown, model: Model) => ({ body: model.body })
    })
  })

  it("extracts a record update with narrowed handlers and infers its requirements", () => {
    const update = NoteDef.update({
      Edited: ($, msg) => {
        expect(msg).type.toBe<
          { readonly _tag: "Edited"; readonly body: string }
        >()
        expect($.combine).type.not.toBeCallableWith(
          touch as (
            $: Parameters<typeof touch>[0],
            msg: { readonly _tag: "Saved" }
          ) => Model
        )
        return { ...$.model, body: msg.body }
      },
      SaveClicked: NoteDef.update(
        "SaveClicked",
        ($) => $.combine(touch, save)
      ),
      Saved: touch
    })
    const Note = NoteDef.make({
      init: () => ({ body: "", edits: 0 }),
      update,
      view: (h) => h.p()
    })
    expect<Component.Requirements<typeof Note>>().type.toBe<GetUser | Save>()

    const Combined = NoteDef.make({
      init: () => ({ body: "", edits: 0 }),
      update: ($) => $.combine(update, audit),
      view: (h) => h.p()
    })
    expect<Component.Requirements<typeof Combined>>().type.toBe<
      GetUser | Save | Audit
    >()

    // @ts-expect-error is missing the following properties
    const narrow: typeof touch = NoteDef.update({
      Edited: save,
      SaveClicked: save,
      Saved: save
    })
    void narrow
  })

  it("enforces exhaustiveness and rejects unknown keys on an extracted record update", () => {
    expect(NoteDef.update).type.not.toBeCallableWith({
      Edited: touch,
      SaveClicked: touch
    })

    const u = touch
    // @ts-expect-error 'Deleted' is not a tag of this component's message
    NoteDef.update({ Edited: u, SaveClicked: u, Saved: u, Deleted: u })

    const record = { ...shared, Edited: touch, SaveClicked: touch }
    expect(NoteDef.update).type.not.toBeCallableWith(record)

    expect(NoteDef.update).type.not.toBeCallableWith("Edited", {
      Edited: touch,
      SaveClicked: touch,
      Saved: touch
    })
  })

  it("treats callables with handler properties as functions only", () => {
    const callableWithHandlers = Object.assign(save, {
      Edited: audit,
      SaveClicked: touch,
      Saved: touch
    })
    const Note = NoteDef.make({
      init: () => ({ body: "", edits: 0 }),
      update: NoteDef.update(callableWithHandlers),
      view: (h) => h.p()
    })
    expect<Component.Requirements<typeof Note>>().type.toBe<GetUser | Save>()

    const invalidCallable = Object.assign(() => 123, {
      Edited: touch,
      SaveClicked: touch,
      Saved: touch
    })
    expect(NoteDef.update).type.not.toBeCallableWith(invalidCallable)
  })

  it("rejects record updates when a message union lacks finite known tags", () => {
    const MixedDef = Html.component({
      name: "Mixed",
      model: Schema.Number,
      message: Schema.Union([
        Schema.Literal("Reset"),
        Schema.Struct({ _tag: Schema.Literal("Inc") })
      ])
    })
    MixedDef.update(($, msg) => (msg === "Reset" ? 0 : $.model + 1))
    expect(MixedDef.update).type.not.toBeCallableWith({ Inc: () => 1 })

    const WideTagDef = Html.component({
      name: "WideTag",
      model: Schema.Number,
      message: Schema.Struct({ _tag: Schema.String })
    })
    WideTagDef.update(($) => $.model + 1)
    expect(WideTagDef.update).type.not.toBeCallableWith({})

    const TemplateTagDef = Html.component({
      name: "TemplateTag",
      model: Schema.Number,
      message: Schema.Struct({
        _tag: Schema.TemplateLiteral(["evt_", Schema.String])
      })
    })
    TemplateTagDef.update(($) => $.model + 1)
    expect(TemplateTagDef.update).type.not.toBeCallableWith({})

    const UnionTagStructDef = Html.component({
      name: "UnionTagStruct",
      model: Schema.Number,
      message: Schema.Struct({
        _tag: Schema.Literals(["Inc", "Dec"])
      })
    })
    UnionTagStructDef.make({
      init: () => 0,
      update: UnionTagStructDef.update({ Inc: () => 1, Dec: () => -1 }),
      view: (h) => h.p()
    })
  })

  it("fragment types h from the definition, with its queries and elements, and infers the other arguments", () => {
    const row = NoteDef.fragment((h, label: string, count: number) => {
      expect(h).type.toBe<Component.Helper<typeof NoteDef>>()
      expect(h.props).type.toBe<{ readonly id: string }>()
      expect(h.queries.user).type.toBe<
        AsyncResult.AsyncResult<typeof User.Type, string>
      >()
      return h.li(`${label} ${count}`)
    })
    expect<Parameters<typeof row>>().type.toBe<
      [h: Component.Helper<typeof NoteDef>, label: string, count: number]
    >()
    NoteDef.view((h, model) => {
      expect(row).type.not.toBeCallableWith(h, model.body)
      return h.ul(row(h, model.body, model.edits))
    })
  })

  it("Helper types a view fragment that takes more than the Model", () => {
    const row = (h: Component.Helper<typeof NoteDef>, label: string) => {
      expect(h.queries.user).type.toBe<
        AsyncResult.AsyncResult<typeof User.Type, string>
      >()
      return h.li(label)
    }
    NoteDef.view((h, model) => h.ul(row(h, model.body)))
  })
})
