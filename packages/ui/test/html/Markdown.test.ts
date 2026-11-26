import { Command, UiSchema } from "@effect/ui"
import { Html, HtmlServer, Markdown, MarkdownParser } from "@effect/ui/html"
import { HtmlLocator, HtmlPlay } from "@effect/ui/html/testing"
import { Locator, TestHost } from "@effect/ui/testing"
import { assert, describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Schema } from "effect"
import { vi } from "vitest"

const { parseMarkdown } = MarkdownParser

const lines = (...sourceLines: ReadonlyArray<string>): string =>
  sourceLines.join("\n")

const wireDocument = (): unknown => ({
  blocks: [
    { _tag: "Heading", level: 1, content: [{ _tag: "Text", value: "Title" }] },
    { _tag: "Paragraph", content: [{ _tag: "Text", value: "Prose." }] }
  ]
})

describe("decodeDocument", () => {
  it("memoizes per wire object and bypasses the cache when options are passed", () => {
    const wire = wireDocument()
    const cached = Markdown.decodeDocument(wire)
    const distinct = Markdown.decodeDocument(wireDocument())
    const overridden = Markdown.decodeDocument(wire, {})

    expect(Markdown.decodeDocument(wire)).toBe(cached)
    expect(distinct).not.toBe(cached)
    expect(distinct).toStrictEqual(cached)
    expect(overridden).not.toBe(cached)
    expect(overridden).toStrictEqual(cached)
    expect(Markdown.decodeDocument(wire)).toBe(cached)
  })

  it("rejects invalid wire input without caching failures", () => {
    const wire = { blocks: [{ _tag: "Marquee" }] }

    expect(() => Markdown.decodeDocument(wire)).toThrowError(
      "at [\"blocks\"][0]"
    )
    expect(() => Markdown.decodeDocument(wire)).toThrowError(
      "at [\"blocks\"][0]"
    )
    expect(() => Markdown.decodeDocument("not a document")).toThrowError(
      "Expected object"
    )
  })

  it("rejects link and image URLs outside the allowlist", () => {
    const paragraph = (inline: unknown) => ({
      blocks: [{ _tag: "Paragraph", content: [inline] }]
    })

    expect(() =>
      Markdown.decodeDocument(
        paragraph({
          _tag: "Link",
          url: "javascript:alert(1)",
          title: null,
          content: []
        })
      )
    ).toThrowError(/url/)
    expect(() =>
      Markdown.decodeDocument(
        paragraph({ _tag: "Image", url: "data:x", alt: "", title: null })
      )
    )
      .toThrowError(/url/)
    expect(
      Markdown.decodeDocument(
        paragraph({ _tag: "Link", url: "/posts", title: null, content: [] })
      ).blocks
    ).toHaveLength(1)
  })
})

const spyWarn = Effect.acquireRelease(
  Effect.sync(() =>
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  ),
  (spy) => Effect.sync(() => spy.mockRestore())
)

const withoutMarkers = (html: string): string => html.replace(/<!--.*?-->/g, "")

const render = (
  document: Markdown.Document,
  config?: Markdown.ViewConfig<never>
) =>
  HtmlServer.renderToHtml(
    Html.component({
      name: "Doc",
      model: Schema.Struct({}),
      message: Schema.Never
    })
      .make({
        init: () => ({}),
        update: ($) => $.model,
        view: (h) => Markdown.view(h, document, config)
      }),
    {},
    { budget: 0 }
  ).pipe(Effect.map(({ html }) => withoutMarkers(html)))

it.layer(TestHost.layer())("view", (it) => {
  it.effect("renders default semantic block, inline, heading, and list elements", () =>
    Effect.gen(function*() {
      const html = yield* render(
        parseMarkdown(
          lines(
            "# 1",
            "## 2",
            "### 3",
            "#### 4",
            "##### 5",
            "###### 6",
            "",
            "Some *emphasis*, `code`, and a [link](https://example.com \"Ex\").",
            "",
            "- one",
            "- two",
            "",
            "3. three",
            "4. four",
            "",
            "---"
          )
        )
      )

      assert.strictEqual(
        html,
        "<div><h1>1</h1><h2>2</h2><h3>3</h3><h4>4</h4><h5>5</h5><h6>6</h6>" +
          "<p>Some <em>emphasis</em>, <code>code</code>, and a <a href=\"https://example.com\" title=\"Ex\">link</a>.</p>" +
          "<ul><li><p>one</p></li><li><p>two</p></li></ul>" +
          "<ol start=\"3\"><li><p>three</p></li><li><p>four</p></li></ol>" +
          "<hr></div>"
      )
    }))

  it.effect("renders table header and body cells with alignment styles", () =>
    Effect.gen(function*() {
      const html = yield* render(
        parseMarkdown(
          lines("| Stock | Speed |", "| :--- | ---: |", "| Portra | 400 |")
        )
      )

      assert.strictEqual(
        html,
        "<div><table><thead><tr><th style=\"text-align:left\">Stock</th><th style=\"text-align:right\">Speed</th></tr></thead>" +
          "<tbody><tr><td style=\"text-align:left\">Portra</td><td style=\"text-align:right\">400</td></tr></tbody></table></div>"
      )
    }))

  it.effect("passes each code block its occurrence index in document order", () =>
    Effect.gen(function*() {
      const received: Array<number> = []
      yield* render(
        parseMarkdown(
          lines(
            "```ts",
            "const first = 1",
            "```",
            "",
            "```ts",
            "const second = 2",
            "```"
          )
        ),
        {
          views: {
            CodeBlock: (h, _codeBlock, occurrenceIndex) => {
              received.push(occurrenceIndex)
              return h.pre
            }
          }
        }
      )

      assert.deepStrictEqual(received, [0, 1])
    }))

  it.effect("renders registered islands with attributes, nested content, and per-name occurrence indices", () =>
    Effect.gen(function*() {
      const received: Array<number> = []
      const html = yield* render(
        parseMarkdown(
          lines(
            ":::Note{tone=\"calm\"}",
            "Inside.",
            ":::",
            "",
            "::Other",
            "",
            ":::Note",
            "Second.",
            ":::"
          )
        ),
        {
          islands: {
            Note: (h, attributes, content, occurrenceIndex) => {
              received.push(occurrenceIndex)
              return h.aside.class(`note-${attributes.tone ?? "plain"}`)
                .children(content)
            },
            Other: (h) => h.hr
          }
        }
      )

      assert.strictEqual(
        html,
        "<div><aside class=\"note-calm\"><p>Inside.</p></aside><hr><aside class=\"note-plain\"><p>Second.</p></aside></div>"
      )
      assert.deepStrictEqual(received, [0, 1])
    }))

  it.effect("warns once and renders nothing for unregistered islands, including inherited object properties", () =>
    Effect.gen(function*() {
      const warn = yield* spyWarn
      const document = parseMarkdown(
        lines("::Missing", "", "::Missing", "", "::constructor")
      )
      const html = yield* render(document, { islands: {} })
      yield* render(document, { islands: {} })

      assert.strictEqual(html, "<div></div>")
      expect(warn).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("No island view registered for \"Missing\"")
      )
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("No island view registered for \"constructor\"")
      )
    }))

  it.effect("applies view overrides and exposes defaultViews for reuse", () =>
    Effect.gen(function*() {
      const html = yield* render(
        parseMarkdown(lines("# Title", "", "A paragraph.")),
        {
          views: {
            Heading: (h, heading, content) =>
              Markdown.defaultViews.Heading(h, heading, content),
            Paragraph: (h, _paragraph, content) =>
              h.p.class("leading-relaxed").children(content)
          }
        }
      )

      assert.strictEqual(
        html,
        "<div><h1>Title</h1><p class=\"leading-relaxed\">A paragraph.</p></div>"
      )
    }))

  it.effect("islandsFor warns and renders nothing when attributes fail the schema", () =>
    Effect.gen(function*() {
      const warn = yield* spyWarn
      const html = yield* render(parseMarkdown("::Gauge"), {
        islands: Markdown.islandsFor(
          { Gauge: Schema.Struct({ level: Schema.String }) },
          { Gauge: (h, { level }) => h.span.children(level) }
        )
      })

      assert.strictEqual(html, "<div></div>")
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Invalid attributes for island \"Gauge\"")
      )
    }))

  it.effect("viewBlocks renders the blocks without a container", () =>
    Effect.gen(function*() {
      const document = parseMarkdown(lines("# Title", "", "Prose."))
      const html = yield* HtmlServer.renderToHtml(
        Html.component({
          name: "Blocks",
          model: Schema.Struct({}),
          message: Schema.Never
        }).make({
          init: () => ({}),
          update: ($) => $.model,
          view: (h) => h.article.children(Markdown.viewBlocks(h, document))
        }),
        {},
        { budget: 0 }
      )

      assert.strictEqual(
        withoutMarkers(html.html),
        "<article><h1>Title</h1><p>Prose.</p></article>"
      )
    }))
})

const CounterMessage = UiSchema.TaggedEnum({ Incremented: {} })

const Counter = Html.component({
  name: "Counter",
  props: Schema.Struct({ step: Schema.Number }),
  model: Schema.Struct({ count: Schema.Number }),
  message: CounterMessage
}).make({
  init: () => ({ count: 0 }),
  update: { Incremented: ($) => ({ count: $.model.count + $.props.step }) },
  view: (h, model) =>
    h.div.children(
      h.span.attr("role", "status").children(String(model.count)),
      h.button.on("click", CounterMessage.Incremented()).children("Increment")
    )
})

const islandAttributes = {
  Counter: Schema.Struct({
    label: Schema.String,
    step: Schema.optionalKey(Schema.NumberFromString)
  }),
  Note: Schema.Struct({})
}

const post = parseMarkdown(
  lines(
    "# Making this blog",
    "",
    "::Counter{label=\"First\"}",
    "",
    "```ts",
    "const a = 1",
    "```",
    "",
    "::Counter{label=\"Second\" step=\"2\"}",
    "",
    ":::Note",
    "*Islands wrap markdown too.*",
    ":::"
  ),
  { islands: islandAttributes }
)

const PostMessage = UiSchema.TaggedEnum({ ClickedRefresh: {} })

const Post = Html.component({
  name: "Post",
  model: Schema.Struct({ renders: Schema.Number }),
  message: PostMessage
}).make({
  init: () => ({ renders: 0 }),
  update: { ClickedRefresh: ($) => ({ renders: $.model.renders + 1 }) },
  view: (h, model) =>
    h.article.children(
      h.button.on("click", PostMessage.ClickedRefresh()).children(
        `Refresh ${model.renders}`
      ),
      Markdown.view(h, post, {
        islands: Markdown.islandsFor(islandAttributes, {
          Counter: (h, { label, step }, _content, index) =>
            h.div.attr("role", "group").attr("aria-label", label).children(
              Counter(h, {
                key: `counter-${index}`,
                props: { step: step ?? 1 }
              })
            ),
          Note: (h, _attributes, content) => h.aside.children(content)
        })
      }).class("prose")
    )
})

const countOf = (label: string) =>
  Locator.inside(
    HtmlLocator.role("group", { name: label }),
    HtmlLocator.role("status")
  )
const increment = (label: string) =>
  Locator.inside(
    HtmlLocator.role("group", { name: label }),
    HtmlLocator.role("button", { name: "Increment" })
  )

class Greeter extends Context.Service<
  Greeter,
  { readonly greet: (name: string) => string }
>()("test/MarkdownGreeter") {}

class Greet extends Command.Service<Greet>()(
  "test/MarkdownGreet",
  {
    args: { name: Schema.String },
    success: Schema.String,
    error: Schema.Never,
    invalidates: () => []
  }
) {
  static readonly layer = this.toLayer(
    Effect.gen(function*() {
      const greeter = yield* Greeter
      return ({ name }) => Effect.succeed(greeter.greet(name))
    })
  )
}

const Greeting = Html.component({
  name: "Greeting",
  props: Schema.Struct({ name: Schema.String }),
  model: Schema.String,
  message: Schema.String
}).make({
  init: ($) => $.set("...").run(Greet.make({ name: $.props.name })),
  update: (_$, message) => message,
  view: (h, text) => h.p.attr("role", "status").children(text)
})

const greetingAttributes = { Greeting: Schema.Struct({ name: Schema.String }) }

const greetingPost = parseMarkdown(
  lines("Before.", "", "::Greeting{name=\"world\"}"),
  { islands: greetingAttributes }
)

const GreetingPost = Html.component({
  name: "GreetingPost",
  model: Schema.Struct({}),
  message: Schema.Never
}).make({
  init: () => ({}),
  update: ($) => $.model,
  view: (h) =>
    Markdown.view(h, greetingPost, {
      islands: Markdown.islandsFor(greetingAttributes, {
        Greeting: (h, { name }) =>
          Greeting(h, { key: "greeting", props: { name } })
      })
    })
})

const greetLayer = Greet.layer.pipe(
  Layer.provide(
    Layer.succeed(Greeter, { greet: (name: string) => `hello ${name}` })
  )
)

it.layer(TestHost.layer())("islands", (it) => {
  it.effect("each island occurrence keeps its own child state across parent renders", () =>
    Effect.gen(function*() {
      const play = yield* HtmlPlay.make(Post, {})
      yield* play.click(increment("First"))
      yield* play.click(increment("First"))
      yield* play.click(increment("Second"))
      yield* play.click(HtmlLocator.role("button", { name: "Refresh 0" }))
      yield* play.expect(HtmlLocator.role("button", { name: /Refresh/ }))
        .toHaveText("Refresh 1")
      yield* play.expect(countOf("First")).toHaveText("2")
      yield* play.expect(countOf("Second")).toHaveText("2")
    }))

  it.effect("renders islands on the server", () =>
    Effect.gen(function*() {
      const { html } = yield* HtmlServer.renderToHtml(Post, {}, { budget: 0 })
      const text = withoutMarkers(html)

      expect(text).toContain("<h1>Making this blog</h1>")
      expect(text).toContain(
        "<div role=\"group\" aria-label=\"First\"><div><span role=\"status\">0</span>"
      )
      expect(text).toContain("<pre><code>const a = 1</code></pre>")
      expect(text).toContain(
        "<aside><p><em>Islands wrap markdown too.</em></p></aside>"
      )
    }))

  it.effect("an island's child gets the services it requires", () =>
    Effect.gen(function*() {
      const play = yield* HtmlPlay.make(GreetingPost, {})
      yield* play.expect(HtmlLocator.role("status")).toHaveText("hello world")
    }).pipe(Effect.provide(greetLayer)))
})
