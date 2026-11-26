import { Tabs } from "@effect/ui-kit/Tabs"
import {
  VirtualList,
  VirtualListScrollTarget
} from "@effect/ui-kit/VirtualList"
import * as Command from "@effect/ui/Command"
import * as Component from "@effect/ui/Component"
import * as BrowserHost from "@effect/ui/html/BrowserHost"
import * as Html from "@effect/ui/html/Html"
import * as MessageLog from "@effect/ui/MessageLog"
import * as Renderer from "@effect/ui/Renderer"
import * as Subscription from "@effect/ui/Subscription"
import * as UiSchema from "@effect/ui/UiSchema"
import type * as View from "@effect/ui/View"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as Inspector from "../Inspector.ts"
import { Paused } from "./control.ts"
import * as Read from "./read.ts"

export const Position = Schema.Literals([
  "TopLeft",
  "TopRight",
  "BottomLeft",
  "BottomRight"
])

export type Position = typeof Position.Type

export interface Feed {
  readonly inspector: Inspector.Inspector
  readonly origin: (session: string) => number | undefined
  readonly changes: Stream.Stream<void>
  readonly paintable: (session: string, seq: number) => boolean
  readonly paused: () => typeof Paused.Type | undefined
  readonly failures: () => number
  readonly open: boolean
  readonly position: () => Position
  /** The message tags not recorded, when the page has a recorder to change. */
  readonly notRecording?: (() => ReadonlyArray<string>) | undefined
}

export class Pages extends Context.Service<Pages, {
  readonly paint: (
    session: string,
    seq: number
  ) => Effect.Effect<BrowserHost.Painted | undefined>
  readonly resume: Effect.Effect<void>
  readonly clear: (session: string) => Effect.Effect<void>
  readonly setOpen: (open: boolean) => Effect.Effect<void>
  readonly setRecording: (
    tag: string,
    recording: boolean
  ) => Effect.Effect<void>
  readonly setPosition: (position: Position) => Effect.Effect<void>
}>()("@effect/ui-devtools/Pages") {}

const FeedSchema = Schema.declare(
  (u: unknown): u is Feed =>
    Predicate.hasProperty(u, "inspector") && Predicate.hasProperty(u, "changes")
)

const Filter = Schema.Literals(["messages", "commands", "all"])

const Pane = Schema.Literals(["timeline", "entry"])

const Page = Schema.Struct({ session: Schema.String, seq: Schema.Number })

const OverlayProps = Schema.Struct({ feed: FeedSchema })

type OverlayProps = typeof OverlayProps.Type

const OverlayModel = Schema.Struct({
  open: Schema.Boolean,
  revision: Schema.Number,
  selected: Schema.NullOr(Schema.Number),
  filter: Filter,
  scope: Schema.NullOr(Schema.Number),
  browse: Schema.Boolean,
  find: Schema.String,
  branches: Schema.Array(Schema.Number),
  failures: Schema.Number,
  tab: Schema.String,
  copied: Schema.NullOr(Schema.Number),
  pinned: Schema.Boolean,
  atStart: Schema.Boolean,
  reveal: Schema.NullOr(Schema.Number),
  pins: Schema.Number,
  pane: Pane,
  paused: Schema.NullOr(Paused),
  painting: Schema.NullOr(Page),
  expanded: Schema.Array(Schema.String),
  position: Position,
  pickingCorner: Schema.Boolean,
  announced: Schema.NullOr(Schema.String)
})

type OverlayModel = typeof OverlayModel.Type

const OverlayMessage = UiSchema.TaggedEnum({
  ReceivedFrames: {},
  ClickedOpen: {},
  ClickedClose: {},
  ClickedEntry: { seq: Schema.Number },
  ClickedLink: { seq: Schema.Number },
  ClickedScope: { instance: Schema.Number },
  TypedFind: { text: Schema.String },
  ClickedBrowse: {
    browse: Schema.Boolean,
    branches: Schema.Array(Schema.Number)
  },
  ToggledBranch: { instance: Schema.Number },
  ClickedFilter: { filter: Filter },
  ClickedFollowLatest: {},
  ClickedBack: {},
  ScrolledTimeline: { atStart: Schema.Boolean },
  SelectedTab: { value: Schema.String },
  ToggledModelPath: { path: Schema.String },
  ClickedCopyFrame: { seq: Schema.Number, text: Schema.String },
  SucceededCopyFrame: { seq: Schema.Number },
  FailedCopyFrame: {},
  ClickedTimeTravel: Page.fields,
  ScrubbedPage: { seq: Schema.Number },
  ClickedResume: {},
  ClickedClear: {},
  ClickedRecording: { tag: Schema.String, recording: Schema.Boolean },
  Cleared: {},
  Painted: Paused.fields,
  FailedPaint: Page.fields,
  ClickedCornerPicker: {},
  ClosedCornerPicker: {},
  ChosePosition: { position: Position }
})

type OverlayMessage = typeof OverlayMessage.Type

const CopyButton = Html.ref("DevToolsCopyFrame", "button")

const CopyFrame = Command.make(
  "devtools/CopyFrame",
  { args: { seq: Schema.Number, text: Schema.String } },
  ({ seq, text }) =>
    Renderer.Refs.use((refs) => refs.lookup(CopyButton)).pipe(
      Effect.flatMap((button) =>
        Effect.tryPromise(() => {
          const clipboard = Option.getOrUndefined(button)?.ownerDocument
            .defaultView?.navigator.clipboard
          return clipboard === undefined
            ? Promise.reject()
            : clipboard.writeText(text)
        })
      ),
      Effect.match({
        onSuccess: () => OverlayMessage.SucceededCopyFrame({ seq }),
        onFailure: () => OverlayMessage.FailedCopyFrame()
      })
    )
)

export class Paint extends Command.Service<Paint>()(
  "devtools/Paint",
  {
    args: { session: Schema.String, seq: Schema.NullOr(Schema.Number) },
    success: Schema.Union([OverlayMessage, Component.Noop]),
    mode: "switch"
  }
) {
  static readonly layer = this.toLayer(
    Effect.gen(function*() {
      const pages = yield* Pages
      return ({ seq, session }) =>
        seq === null
          ? Effect.as(pages.resume, Component.noop)
          : Effect.map(
            pages.paint(session, seq),
            (painted) =>
              painted === undefined
                ? OverlayMessage.FailedPaint({ session, seq })
                : OverlayMessage.Painted({ session, seq, ...painted })
          )
    })
  )
}

export class Clear extends Command.Service<Clear>()(
  "devtools/Clear",
  { args: { session: Schema.String }, success: OverlayMessage }
) {
  static readonly layer = this.toLayer(
    Effect.gen(function*() {
      const pages = yield* Pages
      return ({ session }) =>
        Effect.as(pages.clear(session), OverlayMessage.Cleared())
    })
  )
}

export class SaveOpen extends Command.Service<SaveOpen>()(
  "devtools/SaveOpen",
  { args: { open: Schema.Boolean }, success: Component.Noop }
) {
  static readonly layer = this.toLayer(
    Effect.gen(function*() {
      const pages = yield* Pages
      return ({ open }) => Effect.as(pages.setOpen(open), Component.noop)
    })
  )
}

export class SetRecording extends Command.Service<SetRecording>()(
  "devtools/SetRecording",
  {
    args: { tag: Schema.String, recording: Schema.Boolean },
    success: Component.Noop
  }
) {
  static readonly layer = this.toLayer(
    Effect.gen(function*() {
      const pages = yield* Pages
      return ({ recording, tag }) =>
        Effect.as(pages.setRecording(tag, recording), Component.noop)
    })
  )
}

export class SavePosition extends Command.Service<SavePosition>()(
  "devtools/SavePosition",
  { args: { position: Position }, success: Component.Noop }
) {
  static readonly layer = this.toLayer(
    Effect.gen(function*() {
      const pages = yield* Pages
      return ({ position }) =>
        Effect.as(pages.setPosition(position), Component.noop)
    })
  )
}

type Children = View.Children<OverlayMessage, never>
type H =
  & View.Helper<OverlayMessage, OverlayProps>
  & View.Tags<Html.Elements, OverlayMessage>
type Session = Inspector.Session
type Entry = Read.Entry
type Ref = Read.Ref

const filters: ReadonlyArray<readonly [Read.Filter, string]> = [
  ["messages", "Messages"],
  ["commands", "Commands"],
  ["all", "Everything"]
]

const increment = (n: number) => n + 1
const following = {
  pinned: true,
  reveal: null,
  pins: increment,
  pane: "timeline"
} as const

const toneClass = (tone: Read.Tone | undefined) =>
  tone === undefined ? null : "tone-" + tone

const Mark = (
  h: H,
  mark: Read.Mark,
  ...classes: ReadonlyArray<string | null>
) =>
  h.span.class("mk", "mk-" + mark, ...classes).attr("aria-hidden", "true").attr(
    "data-mark",
    mark
  )

const Code = (h: H, text: string) => h.span.class("code").children(text)

const Name = (h: H, entry: Entry, text: string) =>
  text === entry._tag ? text : Code(h, text)

const SeqLink = (h: H, ref: Ref) =>
  ref.entry._tag === "Outside"
    ? h.span.class("ref", "outside").attr(
      "title",
      "Outside the inspector's buffer"
    ).children("#" + ref.seq)
    : h.button.class("ref").attr(
      "aria-label",
      "Go to #" + ref.seq + " " + Read.summaryOf(ref.entry)
    )
      .on("click", OverlayMessage.ClickedLink({ seq: ref.seq })).children(
        "#" + ref.seq
      )

const Json = (h: H, value: Schema.Json | undefined): Children => {
  if (value === undefined) return []
  if (MessageLog.isPlaceholder(value)) return [Placeholder(h, value)]
  if (value === null || typeof value !== "object") {
    return [
      typeof value === "string"
        ? h.span.class("t-str").children(JSON.stringify(value))
        : h.span.class(value === null ? null : "t-num").children(String(value))
    ]
  }
  if (Array.isArray(value)) {
    return [
      h.span.class("t-punct").children("["),
      ...value.flatMap((item, index) => [
        ...(index === 0 ? [] : [h.span.class("t-punct").children(", ")]),
        ...Json(h, item)
      ]),
      h.span.class("t-punct").children("]")
    ]
  }
  const keys = Object.keys(value)
  if (keys.length === 0) return [h.span.class("t-punct").children("{}")]
  return [
    h.span.class("t-punct").children("{ "),
    ...keys.flatMap((key, index) => [
      ...(index === 0 ? [] : [h.span.class("t-punct").children(", ")]),
      h.span.class("t-key").children(key + ": "),
      ...Json(h, (value as Schema.JsonObject)[key])
    ]),
    h.span.class("t-punct").children(" }")
  ]
}

const Placeholder = (h: H, value: MessageLog.Placeholder) =>
  "~redacted" in value
    ? h.span.class("placeholder").attr(
      "title",
      "Redacted by the encoder: the value never left the app"
    )
      .children("redacted")
    : "~truncated" in value
    ? h.span.class("placeholder").attr("title", "Over maxEntryBytes").children(
      "truncated, " + value["~truncated"] + " bytes"
    )
    : h.span.class("placeholder").attr("title", "No JSON form").children(
      "unserialisable " + value["~unserialisable"]
    )

const pageAt = (model: OverlayModel) => model.painting ?? model.paused

const samePage = (
  a: typeof Page.Type | null | undefined,
  b: typeof Page.Type | null | undefined
) => a?.session === b?.session && a?.seq === b?.seq

const sessionOf = (feed: Feed, model: OverlayModel): Session | undefined => {
  const sessions = feed.inspector.sessions()
  const paused = pageAt(model)?.session
  return (paused === undefined
    ? undefined
    : sessions.find((session) => session.id === paused)) ?? sessions.at(-1)
}

const shows = (model: OverlayModel, session: string, seq: number) =>
  samePage(pageAt(model), { session, seq })

const PausedBadge = (h: H, seq: number) =>
  h.span.class("paused").children(
    h.span.class("paused-label").children("Paused at #" + seq),
    h.button.class("resume").attr("aria-label", "Resume the live page").on(
      "click",
      OverlayMessage.ClickedResume()
    )
      .children("Resume")
  )

const PausedBar = (
  h: H,
  page: typeof Page.Type,
  paused: typeof Paused.Type | null,
  timeline: ReadonlyArray<Entry>,
  paintable: Feed["paintable"]
) => {
  const stops = timeline.filter((entry) => paintable(entry.session, entry.seq))
    .reverse()
  const at = stops.findIndex((entry) => entry.seq === page.seq)
  const notes = paused === null ? [] : ([
    ["init", " shown from init, no state at #" + paused.seq, paused.fellBack],
    [
      "fallback",
      " showing a feature slot fallback, Layer not built on the painted page",
      paused.fallbacks
    ],
    [
      "skipped",
      " with a mount that didn't run on the painted page",
      paused.skipped
    ]
  ] as const).filter(([, , list]) => list.length > 0)
  return h.section.class("pausebar").attr(
    "aria-label",
    "Page shown at an earlier entry"
  ).children(
    h.div.class("scrub").children(
      h.span.class("muted").children("Time travel"),
      h.input.attr("type", "range").attr(
        "aria-label",
        "Entry shown on the page"
      ).attr("min", "0")
        .attr("max", String(Math.max(0, stops.length - 1))).attr(
          "aria-valuetext",
          "#" + page.seq
        )
        .value(String(Math.max(0, at)))
        .on("input", ({ value }) => {
          const entry = stops[Number(value)]
          return entry === undefined
            ? undefined
            : OverlayMessage.ScrubbedPage({ seq: entry.seq })
        }),
      h.span.class("at").children("#" + page.seq)
    ),
    h.div.class("pause-notes", "tone-open").children(
      notes.map(([key, tail, list]) => {
        const summary =
          (list.length === 1 ? "1 instance" : list.length + " instances") + tail
        return h.details.key(key).class("pause-note").children(
          h.summary.attr("title", summary).children(summary),
          h.ul.class("pause-paths").children(
            list.map((path) => h.li.children(path))
          )
        )
      })
    )
  )
}

const corners: ReadonlyArray<readonly [Position, string]> = [
  ["TopLeft", "Top left"],
  ["TopRight", "Top right"],
  ["BottomLeft", "Bottom left"],
  ["BottomRight", "Bottom right"]
]

const cornerLabel = (position: Position) =>
  corners.find(([corner]) => corner === position)![1]

const moveCorner = (
  position: Position,
  key: string
): Position | undefined => {
  const vertical = position.startsWith("Top") ? "Top" : "Bottom"
  const horizontal = position.endsWith("Left") ? "Left" : "Right"
  switch (key) {
    case "ArrowUp":
      return ("Top" + horizontal) as Position
    case "ArrowDown":
      return ("Bottom" + horizontal) as Position
    case "ArrowLeft":
      return (vertical + "Left") as Position
    case "ArrowRight":
      return (vertical + "Right") as Position
    default:
      return undefined
  }
}

const CornerPicker = (h: H, model: OverlayModel) =>
  h.div.class("corner-wrap").on(
    "keydown",
    ({ key }) =>
      key === "Escape" && model.pickingCorner
        ? OverlayMessage.ClosedCornerPicker()
        : undefined,
    { preventDefault: true }
  ).children(
    h.button.class("corner", model.pickingCorner && "on")
      .attr("aria-label", "Move inspector to another corner")
      .attr("aria-expanded", String(model.pickingCorner))
      .attr("title", "Move inspector to another corner")
      .on("click", OverlayMessage.ClickedCornerPicker())
      .children(
        h.span.class("corner-icon").attr("aria-hidden", "true").children(
          corners.map(([corner]) =>
            h.i.key(corner).class(model.position === corner && "here")
          )
        )
      ),
    !model.pickingCorner
      ? null
      : h.div.class("corner-menu")
        .attr("role", "group")
        .attr("aria-label", "Inspector corner")
        .children(
          corners.map(([corner, label]) =>
            h.button.key(corner)
              .class("corner-option", model.position === corner && "on")
              .attr("aria-pressed", String(model.position === corner))
              .on("click", OverlayMessage.ChosePosition({ position: corner }))
              .children(label)
          )
        )
  )

const Header = (
  h: H,
  session: Session | undefined,
  count: number,
  model: OverlayModel
) => {
  const following = model.selected === null && model.pinned
  const page = pageAt(model)
  const canClear = session !== undefined && count > 0 && page === null
  return h.header.class("bar").children(
    h.span.class("logo").attr("aria-hidden", "true"),
    h.h2.class("title").children("Effect UI inspector"),
    session?.app === undefined
      ? null
      : h.span.class("app").children(session.app),
    h.span.class("spacer"),
    page === null ? null : PausedBadge(h, page.seq),
    h.span.class("count").children(
      count === 1 ? "1 entry" : count + " entries"
    ),
    h.button.class("clear").disabled(!canClear)
      .attr(
        "title",
        page !== null ? "Resume before clearing" : "Clear the timeline"
      )
      .on("click", OverlayMessage.ClickedClear()).children("Clear"),
    h.button.class("follow", following && "on").attr(
      "aria-pressed",
      String(following)
    )
      .on("click", OverlayMessage.ClickedFollowLatest()).children(
        h.span.class("dot").attr("aria-hidden", "true"),
        "Follow latest"
      ),
    CornerPicker(h, model),
    h.button.class("close").attr("aria-label", "Close the inspector").on(
      "click",
      OverlayMessage.ClickedClose()
    )
      .children("✕")
  )
}

interface InstanceRow {
  readonly summary: Inspector.Summary
  readonly depth: number
  readonly expanded: boolean
  readonly split: boolean
}

const flatRow = (summary: Inspector.Summary, split = false): InstanceRow => ({
  summary,
  depth: 0,
  expanded: false,
  split
})

const activeRows = (
  session: Session,
  extra: ReadonlyArray<Inspector.Summary | undefined>
) => {
  const groups = {
    bad: [] as Array<Inspector.Summary>,
    open: [] as Array<Inspector.Summary>,
    calm: [] as Array<Inspector.Summary>
  }
  for (const summary of session.active()) {
    groups[Read.toneOf(summary) ?? "calm"].push(summary)
  }
  const loud = groups.bad.length + groups.open.length
  const listed = [...groups.bad, ...groups.open, ...groups.calm]
  for (const summary of extra) {
    if (
      summary !== undefined &&
      !listed.some((other) => other.instance === summary.instance)
    ) listed.push(summary)
  }
  return listed.map((summary, index) =>
    flatRow(summary, loud > 0 && index === loud)
  )
}

const treeRows = (session: Session, branches: ReadonlySet<number>) => {
  const rows: Array<InstanceRow> = []
  const walk = (instance: number | undefined, depth: number) => {
    for (const summary of session.children(instance)) {
      const expanded = summary.below.instances > 0 &&
        branches.has(summary.instance)
      rows.push({ summary, depth, expanded, split: false })
      if (expanded) walk(summary.instance, depth + 1)
    }
  }
  walk(undefined, 0)
  return rows
}

const lineage = (session: Session, summary: Inspector.Summary) => {
  const chain = [summary]
  for (let at = summary.parent; at !== undefined;) {
    const up = session.summary(at)
    if (up === undefined) break
    chain.unshift(up)
    at = up.parent
  }
  return chain
}

const Statuses = (h: H, summary: Inspector.Summary) => {
  const statuses = Read.statusesOf(summary)
  return h.span.class("status").attr(
    "title",
    statuses.map((status) => status.text).join(", ") || undefined
  ).children(
    statuses.flatMap((status, index) => [
      index === 0 ? null : ", ",
      h.span.class(toneClass(status.tone)).children(status.text)
    ])
  )
}

const Rollup = (h: H, below: Inspector.Summary["below"]) =>
  h.span.class("rollup").children(
    h.span.class("under").children(
      below.instances.toLocaleString("en-US"),
      h.span.class("sr").children(
        below.instances === 1 ? " instance under it" : " instances under it"
      )
    ),
    below.failing === 0 ? null : h.span.class("roll", "tone-bad").children(
      Mark(h, "bad"),
      String(below.failing),
      h.span.class("sr").children(" failed or interrupted")
    ),
    below.running === 0 ? null : h.span.class("roll", "tone-open").children(
      Mark(h, "start"),
      String(below.running),
      h.span.class("sr").children(" running")
    )
  )

const instanceMarks = { bad: "bad", open: "start", calm: "message" } as const

const InstanceItem = (
  h: H,
  session: Session,
  row: InstanceRow,
  model: OverlayModel,
  owner: number | undefined,
  tree: boolean
) => {
  const { summary } = row
  const name = Read.nameOf(summary.path)
  const parent = tree || summary.parent === undefined
    ? undefined
    : session.summary(summary.parent)
  const scoped = model.scope === summary.instance
  const tone = Read.toneOf(summary)
  return [
    !tree ? null : summary.below.instances === 0
      ? h.span.class("chev").attr("aria-hidden", "true")
      : h.button.class("chev").attr("aria-expanded", String(row.expanded))
        .attr("aria-label", "Instances under " + name)
        .on(
          "click",
          OverlayMessage.ToggledBranch({ instance: summary.instance })
        )
        .children(
          row.expanded ? "▾" : "▸"
        ),
    h.button.class(
      "irow",
      scoped && "on",
      owner === summary.instance && "owner"
    )
      .attr("aria-pressed", String(scoped))
      .attr("aria-current", owner === summary.instance ? "true" : undefined)
      .attr("data-instance", name)
      .attr("title", "Show only " + name + " and the instances under it")
      .on("click", OverlayMessage.ClickedScope({ instance: summary.instance }))
      .children(
        tree
          ? null
          : Mark(h, instanceMarks[tone ?? "calm"], "imark", toneClass(tone)),
        h.span.class("id").children(
          h.span.class("iname", "code").children(name),
          parent === undefined
            ? null
            : h.span.class("in").children(
              " in ",
              Code(h, Read.nameOf(parent.path))
            )
        ),
        tree && summary.below.instances > 0
          ? Rollup(h, summary.below)
          : Statuses(h, summary)
      )
  ]
}

const InstanceList = (
  h: H,
  session: Session,
  rows: ReadonlyArray<InstanceRow>,
  model: OverlayModel,
  owner: number | undefined,
  mode: "active" | "tree" | "find"
) => {
  const keys = rows.map((row) => String(row.summary.instance))
  const target = owner === undefined || model.selected === null
    ? undefined
    : String(owner)
  return VirtualList(h, {
    key: "instances",
    props: {
      keys,
      itemSize: 26,
      measure: false,
      initialCount: 12,
      dataset: mode,
      ...(target === undefined || !keys.includes(target) ? {} : {
        scrollTo: {
          target: VirtualListScrollTarget.Key({ key: target }),
          align: "nearest" as const,
          id: mode + ":" + model.selected
        }
      })
    },
    view: (list) =>
      list.viewport(
        h.div.class("ilist", mode === "tree" && "tree-list").attr(
          "aria-label",
          "Instances"
        )
      ).children(
        list.list(h.ul).children(
          list.items.map((index) => {
            const row = rows[index]!
            return list.item({
              element: h.li.key(keys[index]!).class(
                "iitem",
                row.split && "split"
              ).attr(
                "style",
                mode === "tree"
                  ? "padding-left:" + (8 + row.depth * 14) + "px"
                  : undefined
              ),
              index
            }).children(
              ...InstanceItem(h, session, row, model, owner, mode === "tree")
            )
          })
        )
      )
  })
}

const ownerSlots = (
  session: Session,
  listed: ReadonlyArray<InstanceRow>,
  timeline: ReadonlyArray<Entry>
) => {
  const shown = new Set(listed.map((row) => row.summary.instance))
  return timeline.some((entry) => {
      const at = Read.instanceOf(entry)
      return at !== undefined && !shown.has(at) &&
        session.summary(at) !== undefined
    })
    ? listed.length + 1
    : undefined
}

const Instances = (
  h: H,
  session: Session,
  model: OverlayModel,
  owner: Inspector.Summary | undefined,
  timeline: ReadonlyArray<Entry>
) => {
  const count = session.instanceCount()
  const find = model.find.trim()
  const mode = find !== "" ? "find" : model.browse ? "tree" : "active"
  const scoped = model.scope === null ? undefined : session.summary(model.scope)
  const rows = mode === "find"
    ? session.find(find).map((summary) => flatRow(summary))
    : mode === "tree"
    ? treeRows(session, new Set(model.branches))
    : activeRows(session, [scoped, owner])
  const slots = mode === "active" && pageAt(model) !== null
    ? ownerSlots(session, activeRows(session, [scoped]), timeline)
    : undefined
  return h.section.class("instances").attr("aria-label", "Instances").attr(
    "style",
    slots === undefined ? undefined : "--slots:" + slots
  ).children(
    h.div.class("ihead").children(
      h.h3.class("heading").children("Instances"),
      h.span.class("icount").children(count.toLocaleString("en-US")),
      h.input.class("find").attr("type", "search").attr(
        "aria-label",
        "Find an instance"
      )
        .attr("placeholder", "Find an instance").attr("spellcheck", "false")
        .value(model.find)
        .on("input", ({ value }) => OverlayMessage.TypedFind({ text: value }))
    ),
    rows.length === 0
      ? h.p.class("inote").children(
        mode === "find"
          ? "No instance matches."
          : "No instance has run a Command or taken a message yet."
      )
      : InstanceList(h, session, rows, model, owner?.instance, mode),
    mode === "find" ?
      null :
      h.button.class("browse").on(
        "click",
        OverlayMessage.ClickedBrowse({
          browse: !model.browse,
          branches: model.browse || owner === undefined
            ? []
            : lineage(session, owner).slice(0, -1).map(({ instance }) =>
              instance
            )
        })
      ).children(
        model.browse
          ? "Back to active instances"
          : "Browse all " + count.toLocaleString("en-US")
      )
  )
}

const Filters = (h: H, model: OverlayModel) =>
  h.div.class("filters").attr("role", "group").attr(
    "aria-label",
    "Show in the timeline"
  ).children(
    filters.map(([filter, label]) =>
      h.button.key(filter).class("filter", model.filter === filter && "on")
        .attr(
          "aria-pressed",
          String(model.filter === filter)
        )
        .on("click", OverlayMessage.ClickedFilter({ filter })).children(label)
    )
  )

const NotRecording = (h: H, tags: ReadonlyArray<string>) =>
  tags.length === 0 ? null : h.div.class("stopped").attr("role", "group").attr(
    "aria-label",
    "Not recording"
  ).children(
    h.span.children("Not recording"),
    tags.map((tag) =>
      h.button.key(tag).class("code").attr(
        "aria-label",
        "Start recording " + tag
      ).attr("title", "Start recording " + tag).on(
        "click",
        OverlayMessage.ClickedRecording({ tag, recording: true })
      ).children(tag)
    )
  )

const scrollOf = (model: OverlayModel, keys: ReadonlyArray<string>) =>
  model.reveal !== null
    ? {
      scrollTo: {
        target: VirtualListScrollTarget.Key({ key: String(model.reveal) }),
        align: "nearest" as const,
        id: "reveal:" + model.pins
      }
    }
    : model.pinned
    ? {
      scrollTo: {
        target: VirtualListScrollTarget.Offset({ offset: 0 }),
        id: (keys[0] ?? "") + ":" + model.pins
      }
    }
    : {}

const gutterSteps = 200

const Gutter = (
  h: H,
  timeline: ReadonlyArray<Entry>,
  chain: ReadonlySet<number>,
  selected: number | undefined
) => {
  const failed = new Set<number>()
  const linked = new Set<number>()
  timeline.forEach((entry, index) => {
    const at = Math.floor(index / timeline.length * gutterSteps)
    if (Read.markOf(entry) === "bad") failed.add(at)
    if (entry.seq === selected || chain.has(entry.seq)) linked.add(at)
  })
  const marks = (set: ReadonlySet<number>, kind: string) =>
    Array.from(
      set,
      (at) =>
        h.i.key(kind + at).class("g-" + kind).attr(
          "style",
          "top:" + (at * 100 / gutterSteps) + "%"
        )
    )
  return h.div.class("gutter").attr("aria-hidden", "true").children(
    ...marks(linked, "link"),
    ...marks(failed, "bad")
  )
}

const Timeline = (
  h: H,
  session: Session,
  model: OverlayModel,
  timeline: ReadonlyArray<Entry>,
  newest: number,
  hidden: number,
  selected: number | undefined,
  steps: ReadonlyArray<Read.Step>
) => {
  const chain = Read.chainSeqs(steps)
  const keys = timeline.map((entry) => String(entry.seq))
  const railed = timeline.map((entry) => chain.has(entry.seq))
  const first = railed.indexOf(true)
  const last = railed.lastIndexOf(true)
  return h.div.class("timeline-box", steps.some(Read.inRun) && "cmd").attr(
    "style",
    "--seq-digits:" + String(newest).length
  ).children(
    VirtualList(h, {
      key: "timeline",
      props: {
        keys,
        itemSize: 28,
        measure: false,
        initialCount: 40,
        dataset: model.filter + ":" + model.scope,
        ...scrollOf(model, keys)
      },
      onEmit: {
        Scrolled: ({ atStart }) => OverlayMessage.ScrolledTimeline({ atStart })
      },
      view: (list) =>
        list.viewport(
          h.div.class("timeline").attr("aria-label", "Timeline, newest first")
        ).children(
          list.list(h.div.class("rows")).children(
            list.items.map((index) => {
              const entry = timeline[index]!
              const label = Read.rowOf(session, entry)
              const rail = first === last || index < first || index > last
                ? null
                : index === first
                ? "top"
                : index === last
                ? "bot"
                : "mid"
              return list.item({
                element: h.div.key(keys[index]!).class(
                  "row",
                  entry.seq === selected && "selected",
                  railed[index] && "linked"
                ),
                index
              }).attr("data-seq", String(entry.seq)).attr(
                "data-tag",
                entry._tag
              ).children(
                h.span.class("rail", rail).attr("aria-hidden", "true"),
                h.button.class("row-button").attr(
                  "aria-label",
                  "#" + entry.seq + " " + Read.summaryOf(entry)
                )
                  .attr(
                    "aria-current",
                    entry.seq === selected ? "true" : undefined
                  )
                  .on("click", OverlayMessage.ClickedEntry({ seq: entry.seq }))
                  .children(
                    h.span.class("seq").children(String(entry.seq)),
                    Mark(h, Read.markOf(entry), "mark", toneClass(label.tone)),
                    h.span.class("lw").children(
                      h.span.class("label").children(
                        Name(h, entry, label.text),
                        label.detail === undefined ?
                          null :
                          h.span.class("verb", toneClass(label.tone)).children(
                            " " + label.detail
                          )
                      ),
                      "path" in entry
                        ? h.span.class("who", "code").attr("title", entry.path)
                          .children(Read.nameOf(entry.path))
                        : null
                    )
                  )
              )
            })
          ),
          hidden === 0 ? null : h.p.class("hidden-note").children(
            (hidden === 1
              ? "1 lifecycle entry"
              : hidden + " lifecycle entries") + " hidden. ",
            h.button.on(
              "click",
              OverlayMessage.ClickedFilter({ filter: "all" })
            )
              .children(
                hidden === 1 ? "Show it" : "Show them"
              )
          )
        )
    }),
    timeline.length > 20 ? Gutter(h, timeline, chain, selected) : null
  )
}

const sourceText = (source: Read.Source): string => {
  switch (source._tag) {
    case "DomEvent":
      return JSON.stringify(source.name) + " event"
    case "Command":
      return "Result of " + source.name
    case "Subscription":
      return "Subscription " + Read.subscriptionText(source)
    case "Query":
      return "Query " + source.name
    case "Emit":
      return "Emitted by " + source.path
    case "Failure":
      return "Failure of " + source.path
    case "Send":
      return "Sent from " + source.path
    case "Shared":
      return "Shared " + source.name + " of " + source.path
    case "Mount":
      return "Mount " + source.name
    case "Collected":
      return "Collected reports"
    case "Dispatch":
      return "Dispatched from outside the tree"
  }
}

const Label = (
  h: H,
  entry: Entry | Inspector.Outside,
  strong = false
): Children => {
  if (entry._tag === "Outside") return []
  const label = Read.labelOf(entry)
  return [
    strong
      ? h.strong.class(label.text === entry._tag ? null : "code").children(
        label.text
      )
      : Name(h, entry, label.text),
    label.detail === undefined
      ? null
      : h.span.class("muted", toneClass(label.tone)).children(
        " " + label.detail
      )
  ]
}

const RefSummary = (h: H, ref: Ref): Children =>
  ref.entry._tag === "Outside"
    ? [SeqLink(h, ref), h.span.class("muted").children(" outside the buffer")]
    : [...Label(h, ref.entry), " ", SeqLink(h, ref)]

const Stopped = (h: H, refs: ReadonlyArray<Ref>): Children =>
  refs.length === 0
    ? []
    : [
      h.span.class("muted").children(", stopped "),
      ...refs.flatMap((ref) => [SeqLink(h, ref), " "])
    ]

type Tone = "this" | Read.Tone

const markOfStep = (step: Read.Step): Read.Mark => {
  switch (step._tag) {
    case "Source":
    case "NotStarted":
    case "Names":
      return "ring"
    case "Command":
      return "issue"
    case "Started":
    case "Running":
      return "start"
    case "Link":
    case "Entry":
    case "Result":
    case "End":
    case "CausedBy":
      return Read.markOf(step.ref.entry)
  }
}

const Step = (
  h: H,
  step: Read.Step,
  body: Children,
  tone?: Tone,
  extra?: Children
) =>
  h.li.class(
    "step",
    tone === undefined ? null : "step-" + tone,
    Read.inRun(step) && "run"
  )
    .attr("data-step", step._tag).attr(
      "data-index",
      step._tag === "Command" ? String(step.index) : undefined
    ).children(
      h.span.class("node").children(Mark(h, markOfStep(step))),
      h.div.class("what").children(...body),
      extra === undefined ? null : h.div.class("args").children(...extra)
    )

const endText = (end: Entry | Inspector.Outside): string => {
  switch (end._tag) {
    case "CommandInterrupted":
      return Read.reasonText[end.reason].replace("i", "I")
    case "CommandDropped":
      return "Dropped on the server"
    case "Failed":
      return "Failed in " + end.in
    default:
      return "Ended"
  }
}

const linkText: { readonly [R in Inspector.Link["rel"]]: string } = {
  causedBy: "Caused by",
  issued: "Issued by",
  source: "Result of",
  started: "Started from"
}

const Chain = (h: H, steps: ReadonlyArray<Read.Step>) =>
  h.ol.class("chain").attr("aria-label", "Causal chain").children(
    steps.map((step, index) => {
      switch (step._tag) {
        case "Source":
          return Step(h, step, [
            sourceText(step.source),
            ...(step.link === undefined ? [] : [" ", SeqLink(h, step.link)])
          ])
        case "Link":
          return Step(h, step, [
            linkText[step.rel],
            " ",
            ...RefSummary(h, step.ref)
          ])
        case "Entry":
          return Step(
            h,
            step,
            [
              ...Label(h, step.ref.entry, step.selected),
              " ",
              step.selected
                ? h.span.class("muted").children("this entry")
                : SeqLink(h, step.ref),
              ...Stopped(h, step.stopped ?? [])
            ],
            step.selected ? "this" : undefined
          )
        case "Command":
          return step.command._tag === "Interrupt"
            ? Step(h, step, [
              "Interrupt " + step.command.name,
              step.command.group === null
                ? null
                : h.span.class("muted").children(" " + step.command.group),
              ...Stopped(h, step.stopped)
            ])
            : Step(
              h,
              step,
              ["Issued ", Code(h, step.command.name)],
              undefined,
              Json(h, step.command.args)
            )
        case "Started":
          return Step(
            h,
            step,
            ["Started ", SeqLink(h, step.ref)],
            step.selected ? "this" : undefined
          )
        case "NotStarted":
          return Step(
            h,
            step,
            [step.ended ? "Stopped before it started" : "Waiting to start"],
            step.ended ? undefined : "open"
          )
        case "Result":
          return Step(
            h,
            step,
            ["Result ", ...RefSummary(h, step.ref)]
          )
        case "Running":
          return Step(
            h,
            step,
            step.since === undefined
              ? ["Not started yet"]
              : [
                "Still running since ",
                SeqLink(h, step.since),
                h.span.class("muted").children(", no end logged yet")
              ],
            "open"
          )
        case "End": {
          const end = step.ref.entry
          const bad = end._tag === "CommandInterrupted" ||
            end._tag === "CommandDropped" || end._tag === "Failed"
          const next = steps[index + 1]
          return Step(
            h,
            step,
            [
              endText(end),
              step.after === undefined
                ? ""
                : " after " + Read.duration(step.after),
              " ",
              SeqLink(h, step.ref),
              end._tag === "Failed"
                ? h.span.class("muted").children(", which failed its instance")
                : null,
              ...(next?._tag === "CausedBy"
                ? [
                  h.span.class("cause").children(
                    " by ",
                    ...RefSummary(h, next.ref)
                  )
                ]
                : [])
            ],
            bad ? "bad" : step.selected ? "this" : undefined
          )
        }
        case "CausedBy":
          return steps[index - 1]?._tag === "End"
            ? null
            : Step(h, step, ["Caused by ", ...RefSummary(h, step.ref)])
        case "Names":
          return Step(h, step, [
            "Linked from ",
            ...step.links.flatMap((link, at) => [
              at === 0 ? null : ", ",
              ...Label(h, link.entry),
              " ",
              SeqLink(h, { seq: link.seq, entry: link.entry }),
              h.span.class("muted").children(" (" + link.rel + ")")
            ])
          ])
      }
    })
  )

const changesText = (count: number) =>
  count + (count === 1 ? " change" : " changes")

const treeRow = (h: H, row: Read.Row) => {
  const { branch, change } = row
  const kind = change?.kind
  const key = row.key === undefined ? "" : String(row.key)
  const closed = branch !== undefined && !branch.expanded
  const label = kind === "added" || kind === "removed"
    ? kind
    : closed && branch.changes > 0
    ? changesText(branch.changes)
    : undefined
  return h.div.key(row.id).class("tl", (kind ?? label) !== undefined && "chg")
    .attr(
      "style",
      "padding-left:" + (row.depth * 16 + 12) + "px"
    ).attr("data-change", kind).children(
      branch === undefined
        ? h.span.class("k").children(key)
        : h.button.class("k", "toggle").attr(
          "aria-expanded",
          String(branch.expanded)
        ).attr(
          "aria-label",
          label === undefined ? key : key + ", " + label
        ).on("click", OverlayMessage.ToggledModelPath({ path: branch.path }))
          .children(
            h.span.class("chev").attr("aria-hidden", "true").children(
              branch.expanded ? "▾" : "▸"
            ),
            key
          ),
      h.span.class("v").children(
        closed
          ? h.span.class("t-punct").children(branch.preview)
          : row.open ?? row.close ?? null,
        ...(kind === "changed"
          ? [
            h.del.class("old").children(...Json(h, change!.before)),
            h.span.class("arrow").attr("aria-hidden", "true").children(" → "),
            h.ins.class("new").children(...Json(h, change!.after))
          ]
          : row.open === undefined && row.close === undefined
          ? Json(h, row.value)
          : []),
        label === undefined ? null : h.span.class("muted").children(" " + label)
      )
    )
}

const Tree = (
  h: H,
  value: Schema.Json,
  changes: ReadonlyArray<Inspector.Change>
) =>
  h.div.class("tree").children(
    Read.treeOf(value, changes).map((row) => treeRow(h, row))
  )

const VirtualTree = (
  h: H,
  label: string,
  dataset: string,
  rows: ReadonlyArray<Read.Row>
) =>
  VirtualList(h, {
    props: {
      keys: rows.map((row) => row.id),
      itemSize: 22,
      initialCount: 60,
      dataset
    },
    view: (list) =>
      list.viewport(h.div.class("tree", "scroll").attr("aria-label", label))
        .children(
          list.list(h.div).children(
            list.items.map((index) =>
              list.item({ element: treeRow(h, rows[index]!), index })
            )
          )
        )
  })

const propsText = {
  same: "Same as ",
  changed: "Changed since ",
  unknown: "Redacted parts can't be compared with "
}

const runText = (run: Inspector.Record) =>
  run.end !== undefined
    ? Read.reasonText[run.reason ?? "interrupt"]
    : run.start === undefined
    ? "not started"
    : "running"

const recordWords: {
  readonly [K in Inspector.Record["kind"]]: readonly [
    kind: string,
    verb: string
  ]
} = {
  layer: ["Layer", "pending "],
  subscription: ["Subscription", "started "],
  mount: ["Mount", "started "],
  command: ["Command", "issued "]
}

const recordRow = (h: H, session: Session, record: Inspector.Record) => {
  const start = record.kind === "command" ? record.issued?.seq : record.start
  const startRef = start === undefined ? undefined : Read.refOf(session, start)
  const endRef = record.end === undefined
    ? undefined
    : Read.refOf(session, record.end)
  const startEntry = startRef?.entry
  const endEntry = endRef?.entry
  const took = startEntry !== undefined && startEntry._tag !== "Outside" &&
      endEntry !== undefined &&
      endEntry._tag !== "Outside"
    ? endEntry.at - startEntry.at
    : 0
  const [kind, verb] = recordWords[record.kind]
  const what = record.kind === "subscription" && startEntry !== undefined &&
      startEntry._tag === "SubscriptionStarted"
    ? Read.subscriptionText(startEntry)
    : record.name
  const derived = record.reason === "unmount" && endEntry !== undefined &&
    endEntry._tag === "Unmounted"
  const tone: Read.Tone | undefined = record.end === undefined
    ? record.kind === "command" ? "open" : undefined
    : !derived && record.reason !== undefined &&
        Read.reasonTone[record.reason] === "bad"
    ? "bad"
    : undefined
  return h.tr.key(
    record.kind + ":" + (start ?? record.name) + ":" +
      (record.issued?.index ?? "")
  ).attr(
    "data-kind",
    record.kind
  ).children(
    h.th.attr("scope", "row").children(kind),
    h.td.children(what),
    h.td.children(
      verb,
      startRef === undefined ? "" : SeqLink(h, startRef),
      record.kind === "command" && record.start !== undefined
        ? h.span.children(
          ", started ",
          SeqLink(h, Read.refOf(session, record.start))
        )
        : null
    ),
    h.td.class(toneClass(tone)).children(
      record.end === undefined
        ? record.kind === "command"
          ? record.start === undefined ? "not started" : "running"
          : "open"
        : derived
        ? h.span.children("closed by unmount ", SeqLink(h, endRef!))
        : h.span.children(
          Read.reasonText[record.reason ?? "ended"],
          took >= 1 ? " after " + Read.duration(took) : "",
          " ",
          SeqLink(h, endRef!)
        )
    )
  )
}

const Lifecycle = (h: H, session: Session, info: Inspector.Instance) => {
  const unmounted = info.unmounted === undefined
    ? undefined
    : session.resolve(info.unmounted)
  const cause = unmounted === undefined || unmounted._tag === "Outside" ||
      unmounted.causedBy === undefined
    ? undefined
    : Read.refOf(session, unmounted.causedBy)
  return h.table.class("life").attr(
    "aria-label",
    "Lifecycle of " + Read.nameOf(info.path)
  ).children(
    h.tbody.children(
      h.tr.attr("data-kind", "instance").children(
        h.th.attr("scope", "row").children("Instance"),
        h.td.children(info.path),
        h.td.children(
          info.mounted === undefined
            ? "mounted before the buffer"
            : h.span.children(
              "mounted ",
              SeqLink(h, Read.refOf(session, info.mounted))
            )
        ),
        h.td.class(info.unmounted === undefined ? null : "tone-bad").children(
          info.unmounted === undefined
            ? "mounted"
            : h.span.children(
              "unmounted ",
              SeqLink(h, Read.refOf(session, info.unmounted)),
              cause === undefined || cause.entry._tag === "Outside"
                ? ""
                : " by " + Read.labelOf(cause.entry).text
            )
        )
      ),
      session.records(info.instance).map((record) =>
        recordRow(h, session, record)
      )
    )
  )
}

interface Section {
  readonly value: string
  readonly label: string
  readonly count?: string
  readonly unit?: string
  readonly body: () => Children
}

const Details = (
  h: H,
  session: Session,
  entry: Entry,
  info: Inspector.Instance | undefined,
  model: OverlayModel
) => {
  const state = entry._tag === "Update" || entry._tag === "Mounted" ||
      entry._tag === "Waiting"
    ? entry
    : undefined
  const previous = state === undefined ? undefined : session.previous(entry.seq)
  const resolved = previous === undefined
    ? undefined
    : session.resolve(previous.seq)
  const before =
    resolved !== undefined && resolved._tag !== "Outside" && "model" in resolved
      ? resolved
      : previous?.model !== undefined && previous.props !== undefined
      ? { seq: previous.seq, model: previous.model, props: previous.props }
      : undefined
  const unavailable = previous !== undefined && before === undefined
  const changes = state === undefined || before === undefined
    ? []
    : Inspector.diff(before.model, state.model)
  const changed = changes.filter((change) => change.kind !== "unknown").length
  const commands = Read.isIssuing(entry) ? entry.commands : []
  const events = Read.isIssuing(entry) ? entry.events : []
  const name = "path" in entry ? Read.nameOf(entry.path) : "this instance"
  const Props = (): Children => {
    if (state === undefined) return []
    const propChanges = before === undefined
      ? []
      : Inspector.diff(before.props, state.props)
    return [
      h.h4.children(
        "Props",
        before === undefined ? null : h.span.class("muted").children(
          " · " + propsText[Read.statusOf(propChanges)],
          SeqLink(h, Read.refOf(session, before.seq))
        )
      ),
      Tree(h, state.props, propChanges)
    ]
  }
  const sections: ReadonlyArray<Section> = [
    ...(state === undefined ? [] : [{
      value: "model",
      label: "Model",
      ...(unavailable
        ? { count: "no diff" }
        : previous === undefined
        ? {}
        : {
          count: String(changed),
          unit: changed === 1 ? "change" : "changes"
        }),
      body: () => [
        h.p.class("note").children(
          previous === undefined
            ? "First state of " + name
            : unavailable
            ? h.span.children(
              previous.changed === true ? "Changed since " : "No diff against ",
              SeqLink(h, Read.refOf(session, previous.seq)),
              ", which is outside the buffer"
            )
            : h.span.children(
              "Since ",
              SeqLink(h, Read.refOf(session, previous.seq)),
              ", the previous state of " + name
            )
        ),
        VirtualTree(
          h,
          "Model after #" + entry.seq,
          String(entry.seq),
          Read.treeOf(state.model, changes, new Set(model.expanded))
        )
      ]
    }]),
    ...(entry._tag === "Update"
      ? [{
        value: "message",
        label: "Message",
        body: () => [
          h.p.class("note").children("From " + sourceText(entry.source)),
          Tree(h, entry.message, []),
          ...Props()
        ]
      }]
      : state === undefined
      ? []
      : [{ value: "props", label: "Props", body: Props }]),
    ...(Read.isIssuing(entry)
      ? [{
        value: "commands",
        label: "Commands",
        ...(commands.length === 0 ? {} : { count: String(commands.length) }),
        body: () =>
          commands.length === 0
            ? [h.p.class("note").children("This entry issued no command.")]
            : [
              h.ol.class("commands").children(
                commands.map((command, index) => {
                  const run = command._tag === "Interrupt"
                    ? undefined
                    : session.run({ seq: entry.seq, index })
                  return h.li.key(String(index)).children(
                    h.div.children(
                      command._tag === "Interrupt"
                        ? "Interrupt " + command.name
                        : command.name,
                      run === undefined
                        ? null
                        : h.span.class("muted").children(
                          " " + runText(run) + " "
                        ),
                      run?.end === undefined
                        ? null
                        : SeqLink(h, Read.refOf(session, run.end))
                    ),
                    h.div.class("args").children(
                      ...(command._tag === "Interrupt"
                        ? []
                        : Json(h, command.args)),
                      command.group === null
                        ? null
                        : h.span.class("muted").children(
                          " group " + command.group
                        )
                    )
                  )
                })
              )
            ]
      }]
      : []),
    ...(events.length === 0 ? [] : [{
      value: "events",
      label: "Events",
      count: String(events.length),
      body: () => [
        h.ol.class("commands").children(
          events.map((event, index) =>
            h.li.key(String(index)).class("args").children(...Json(h, event))
          )
        )
      ]
    }]),
    ...(info === undefined ? [] : [{
      value: "lifecycle",
      label: "Lifecycle",
      body: () => [Lifecycle(h, session, info)]
    }]),
    {
      value: "raw",
      label: "Raw",
      body: () => {
        const frame = JSON.stringify(entry, null, 2)
        return [
          h.div.class("raw-head").children(
            h.p.class("note").children("The frame as the log encoded it"),
            h.button.class("copy").ref(CopyButton).on(
              "click",
              OverlayMessage.ClickedCopyFrame({ seq: entry.seq, text: frame })
            ).children(model.copied === entry.seq ? "Copied" : "Copy frame")
          ),
          h.pre.class("raw").children(frame)
        ]
      }
    }
  ]
  return Tabs(h, {
    props: {
      value: sections.some((section) => section.value === model.tab)
        ? model.tab
        : sections[0]!.value,
      tabs: sections.map(({ value }) => ({ value }))
    },
    onEmit: { Selected: ({ value }) => OverlayMessage.SelectedTab({ value }) },
    view: (t) =>
      t.root(h.div.class("details")).children(
        t.list(h.div.class("tabs").attr("aria-label", "Entry details"))
          .children(
            ...sections.map((section) =>
              t.tab({
                element: h.button.class("tab").children(
                  section.label,
                  section.count === undefined ? null : " ",
                  section.count === undefined ?
                    null :
                    h.small.class("pill").children(
                      section.count,
                      section.unit === undefined
                        ? null
                        : h.span.class("unit").children(" " + section.unit)
                    )
                ),
                value: section.value
              })
            )
          ),
        ...sections.map((section) =>
          t.panel({
            element: h.div.class("pane", section.value === "model" && "model"),
            value: section.value
          })
            ?.children(section.body())
        )
      )
  })
}

const Crumbs = (
  h: H,
  chain: ReadonlyArray<Inspector.Summary>,
  scope: number | null
) =>
  h.nav.class("crumbs").attr("aria-label", "Path of the instance")
    .children(
      chain.flatMap(({ instance, path }, index) => {
        const segment = Read.nameOf(path)
        return [
          index === 0
            ? null
            : h.span.class("slash").attr("aria-hidden", "true").children("/"),
          h.button.class(
            "crumb",
            "code",
            index === chain.length - 1 && "here"
          ).attr(
            "aria-pressed",
            String(scope === instance)
          )
            .attr(
              "title",
              "Show only " + segment + " and the instances under it"
            )
            .on("click", OverlayMessage.ClickedScope({ instance })).children(
              segment
            )
        ]
      })
    )

const Inspected = (
  h: H,
  feed: Feed,
  session: Session,
  entry: Entry,
  info: Inspector.Instance | undefined,
  steps: ReadonlyArray<Read.Step>,
  model: OverlayModel
) => {
  const at = Read.instanceOf(entry)
  const self = at === undefined ? undefined : session.summary(at)
  const label = Read.labelOf(entry)
  const origin = feed.origin(entry.session)
  const kind = entry._tag === "Update"
    ? "Update"
    : label.text === entry._tag
    ? "Entry"
    : entry._tag
  const paintable = feed.paintable(entry.session, entry.seq)
  const shown = shows(model, entry.session, entry.seq)
  const tag = entry._tag === "Update" ? Read.tagOf(entry.message) : undefined
  const stoppable = tag !== undefined &&
    feed.notRecording?.().includes(tag) === false
  return [
    h.section.class("ehead").children(
      h.div.class("ehead-top").children(
        h.h3.class("headline").children(
          Name(h, entry, label.text),
          label.detail === undefined ? null : " " + label.detail
        ),
        stoppable
          ? h.button.class("stop").attr("aria-label", "Stop recording " + tag)
            .attr(
              "title",
              "Stop recording " + tag +
                " updates, so a burst of them can't push other entries out"
            ).on(
              "click",
              OverlayMessage.ClickedRecording({ tag, recording: false })
            ).children("Stop recording")
          : null,
        h.button.class("show", shown && "on").attr(
          "aria-pressed",
          String(shown)
        ).disabled(!paintable)
          .attr(
            "title",
            paintable
              ? "Open the time travel slider at this entry"
              : "No longer held, or no page to show it on"
          )
          .on(
            "click",
            OverlayMessage.ClickedTimeTravel({
              session: entry.session,
              seq: entry.seq
            })
          ).children(
            "Time travel"
          )
      ),
      h.p.class("sub").children(
        kind + " #" + entry.seq,
        origin === undefined
          ? ""
          : ", " + Read.position(entry.at - origin) + " after start"
      ),
      self === undefined
        ? null
        : Crumbs(h, lineage(session, self), model.scope),
      Chain(h, steps)
    ),
    Details(h, session, entry, info, model)
  ]
}

const Panel = (h: H, model: OverlayModel) => {
  const feed = h.props.feed
  const session = sessionOf(feed, model)
  if (session === undefined) {
    return h.div.class("panel", "empty").attr("role", "dialog").attr(
      "aria-label",
      "Effect UI inspector"
    ).children(
      h.span.class("grip").attr("aria-hidden", "true"),
      Header(h, undefined, 0, model),
      h.p.class("empty-note").children(
        "Nothing logged yet. Entries appear here as the app runs."
      )
    )
  }
  const entries = session.entries()
  const scope = model.scope
  const within = new Map<number, boolean>()
  const isWithin = (instance: number): boolean => {
    if (instance === scope) return true
    let known = within.get(instance)
    if (known === undefined) {
      const parent = session.summary(instance)?.parent
      known = parent !== undefined && isWithin(parent)
      within.set(instance, known)
    }
    return known
  }
  const scoped = scope === null ? entries : entries.filter((entry) => {
    const instance = Read.instanceOf(entry)
    return instance !== undefined && isWithin(instance)
  })
  const timeline = scoped.filter((entry) => Read.matches(entry, model.filter))
    .reverse()
  const hidden = model.filter === "messages"
    ? scoped.length - timeline.length
    : 0
  const selected = model.selected === null
    ? timeline[0]
    : session.resolve(model.selected)
  const entry = selected === undefined || selected._tag === "Outside"
    ? undefined
    : selected
  const steps = entry === undefined ? [] : Read.chainOf(session, entry)
  const at = entry === undefined ? undefined : Read.instanceOf(entry)
  const owner = at === undefined ? undefined : session.summary(at)
  const shown = scope === null ? owner : session.summary(scope)
  const page = pageAt(model)
  return h.div.class("panel", page !== null && "pausing").attr(
    "role",
    "dialog"
  ).attr(
    "aria-label",
    "Effect UI inspector"
  ).attr("data-pane", model.pane).children(
    h.span.class("grip").attr("aria-hidden", "true"),
    Header(h, session, entries.length, model),
    page === null
      ? null
      : PausedBar(h, page, model.paused, timeline, feed.paintable),
    h.div.class("body").children(
      h.div.class("left").children(
        Instances(h, session, model, owner, timeline),
        h.div.children(
          Filters(h, model),
          NotRecording(h, feed.notRecording?.() ?? [])
        ),
        Timeline(
          h,
          session,
          model,
          timeline,
          entries.at(-1)?.seq ?? 0,
          hidden,
          selected?.seq,
          steps
        )
      ),
      h.div.class("right").children(
        h.button.class("back").attr("aria-label", "Back to the timeline")
          .on("click", OverlayMessage.ClickedBack())
          .children("← Timeline"),
        entry === undefined
          ? h.section.class("ehead").children(
            h.h3.class("headline").children(
              selected === undefined ? "No entry" : "#" + selected.seq
            ),
            h.p.class("sub").children(
              selected === undefined
                ? "Nothing matches the filter."
                : "Outside the buffer."
            )
          )
          : Inspected(h, feed, session, entry, shown, steps, model)
      )
    )
  )
}

const synced = (model: OverlayModel, feed: Feed) => {
  const paused = feed.paused() ?? null
  const position = feed.position()
  return {
    ...(samePage(paused, model.paused) ? {} : { paused }),
    ...(position === model.position ? {} : { position })
  }
}

const Launcher = (h: H, model: OverlayModel) => {
  const failures = h.props.feed.failures() - model.failures
  const page = pageAt(model)
  const noun = failures === 1 ? " failure" : " failures"
  return h.div.class("launch").children(
    h.button.class("launcher").attr(
      "aria-label",
      "Open the Effect UI inspector"
    ).attr(
      "aria-keyshortcuts",
      "ArrowUp ArrowDown ArrowLeft ArrowRight"
    ).attr(
      "title",
      "Open the Effect UI inspector. Drag or press arrow keys to move to another corner."
    ).on("click", OverlayMessage.ClickedOpen()).on(
      "keydown",
      ({ alt, ctrl, key, meta, shift }) => {
        if (alt || ctrl || meta || shift) return undefined
        const next = moveCorner(model.position, key)
        return next === undefined
          ? undefined
          : OverlayMessage.ChosePosition({ position: next })
      },
      { preventDefault: true }
    )
      .children(
        h.span.class("lockup").attr("aria-hidden", "true"),
        h.span.class("launcher-count").children(
          String(sessionOf(h.props.feed, model)?.entries().length ?? 0)
        )
      ),
    failures <= 0 ?
      null :
      h.span.class("alert").attr(
        "title",
        failures.toLocaleString("en-US") + noun +
          " since the inspector was closed"
      )
        .children(
          Mark(h, "bad"),
          String(failures),
          h.span.class("sr").children(noun)
        ),
    page === null ? null : PausedBadge(h, page.seq)
  )
}

const resumePage = () => Paint.make({ session: "", seq: null })

const resumed = { paused: null, painting: null } as const

const repaint = (model: OverlayModel, feed: Feed, seq: number) => {
  const session = sessionOf(feed, model)
  if (
    pageAt(model) === null || session === undefined ||
    !feed.paintable(session.id, seq)
  ) return { model: {}, commands: [] }
  const page = { session: session.id, seq }
  return { model: { painting: page }, commands: [Paint.make(page)] }
}

export const Overlay = Html.component({
  name: "DevToolsOverlay",
  props: OverlayProps,
  model: OverlayModel,
  message: OverlayMessage
}).make({
  init: ($) => ({
    open: $.props.feed.open,
    revision: 0,
    selected: null,
    filter: "messages",
    scope: null,
    browse: false,
    find: "",
    branches: [],
    failures: 0,
    tab: "model",
    copied: null,
    pinned: true,
    atStart: true,
    reveal: null,
    pins: 0,
    pane: "timeline",
    paused: null,
    painting: null,
    expanded: [],
    position: $.props.feed.position(),
    pickingCorner: false,
    announced: null
  }),
  update: {
    ReceivedFrames: ($) =>
      $.evolve({
        revision: increment,
        ...($.model.reveal === null
          ? {}
          : { reveal: null, pinned: $.model.atStart, pins: increment }),
        ...synced($.model, $.props.feed)
      }),
    ClickedOpen: ($) =>
      $.evolve({
        open: true,
        atStart: true,
        pickingCorner: false,
        ...following
      }).run(
        SaveOpen.make({ open: true })
      ),
    ClickedClose: ($) =>
      $.evolve({
        open: false,
        pickingCorner: false,
        failures: $.props.feed.failures()
      }).run(
        SaveOpen.make({ open: false })
      ),
    ClickedEntry: ($, { seq }) => {
      const paint = repaint($.model, $.props.feed, seq)
      return $.evolve({
        selected: seq,
        pane: "entry",
        ...($.model.pinned ? { pins: increment } : {}),
        ...paint.model
      })
        .run(...paint.commands)
    },
    ClickedLink: ($, { seq }) => {
      const paint = repaint($.model, $.props.feed, seq)
      return $.evolve({
        selected: seq,
        filter: "all",
        scope: null,
        pinned: false,
        reveal: seq,
        pins: increment,
        ...paint.model
      })
        .run(...paint.commands)
    },
    ClickedScope: ($, { instance }) =>
      $.evolve({ scope: $.model.scope === instance ? null : instance }),
    TypedFind: ($, { text }) => $.evolve({ find: text }),
    ClickedBrowse: ($, { branches, browse }) => $.evolve({ browse, branches }),
    ToggledBranch: ($, { instance }) =>
      $.evolve({
        branches: (open) =>
          open.includes(instance)
            ? open.filter((other) => other !== instance)
            : [...open, instance]
      }),
    ClickedFilter: ($, { filter }) => $.evolve({ filter }),
    ClickedFollowLatest: ($) => {
      const next = $.evolve({ selected: null, ...following })
      return pageAt($.model) === null
        ? next
        : next.evolve(resumed).run(resumePage())
    },
    ClickedBack: ($) => $.evolve({ pane: "timeline" }),
    ScrolledTimeline: ($, { atStart }) =>
      atStart
        ? $.model.reveal !== null || $.model.pinned
          ? $.evolve({ atStart })
          : $.evolve({ atStart, pinned: true, pins: increment })
        : $.evolve({ atStart, pinned: false, reveal: null }),
    SelectedTab: ($, { value }) => $.evolve({ tab: value }),
    ToggledModelPath: ($, { path }) =>
      $.evolve({
        expanded: (paths) =>
          paths.includes(path)
            ? paths.filter((open) => open !== path)
            : [...paths, path]
      }),
    ClickedCopyFrame: ($, { seq, text }) =>
      $.evolve({ copied: null }).run(CopyFrame.make({ seq, text })),
    SucceededCopyFrame: ($, { seq }) => $.evolve({ copied: seq }),
    FailedCopyFrame: ($) => $.evolve({ copied: null }),
    ClickedTimeTravel: ($, { session, seq }) =>
      shows($.model, session, seq)
        ? $.evolve(resumed).run(resumePage())
        : $.evolve({ painting: { session, seq } }).run(
          Paint.make({ session, seq })
        ),
    ScrubbedPage: ($, { seq }) => {
      const page = { session: sessionOf($.props.feed, $.model)?.id ?? "", seq }
      return $.evolve({
        selected: seq,
        pinned: false,
        reveal: seq,
        pins: increment,
        painting: page
      })
        .run(Paint.make(page))
    },
    ClickedResume: ($) => $.evolve(resumed).run(resumePage()),
    ClickedRecording: ($, { recording, tag }) =>
      $.run(SetRecording.make({ tag, recording })),
    ClickedClear: ($) => {
      const session = sessionOf($.props.feed, $.model)
      return pageAt($.model) !== null || session === undefined
        ? $.model
        : $.run(Clear.make({ session: session.id }))
    },
    Cleared: ($) => {
      const session = sessionOf($.props.feed, $.model)
      const hasScope = $.model.scope !== null &&
        session?.summary($.model.scope) !== undefined
      return $.evolve({
        revision: increment,
        selected: null,
        scope: hasScope ? $.model.scope : null,
        atStart: true,
        ...following
      })
    },
    Painted: ($, paused) =>
      $.evolve({
        paused,
        ...(samePage($.model.painting, paused) ? { painting: null } : {})
      }),
    FailedPaint: ($, page) =>
      samePage($.model.painting, page) ? $.evolve({ painting: null }) : $.model,
    ClickedCornerPicker: ($) =>
      $.evolve({ pickingCorner: !$.model.pickingCorner }),
    ClosedCornerPicker: ($) => $.evolve({ pickingCorner: false }),
    ChosePosition: ($, { position }) =>
      $.evolve({
        position,
        pickingCorner: false,
        announced: "Inspector moved to " + cornerLabel(position).toLowerCase()
      }).run(SavePosition.make({ position }))
  },
  subscriptions: ({ props }) => [
    Subscription.make(
      "devtools/frames",
      props.feed.changes.pipe(Stream.map(() => OverlayMessage.ReceivedFrames()))
    )
  ],
  view: (h, model) =>
    h.div.class("overlay").children(
      model.open
        ? Panel(h, model)
        : Launcher(h, model),
      model.announced === null
        ? null
        : h.span.class("sr").attr("aria-live", "polite").children(
          model.announced
        )
    )
})

export const mountOverlay = (
  container: HTMLElement,
  feed: Feed,
  pages: Pages["Service"]
): Effect.Effect<void, never, Scope.Scope> =>
  BrowserHost.mountEffect(Overlay, { feed }, container, { head: false }).pipe(
    Effect.provideService(MessageLog.MessageLog, MessageLog.noop),
    Effect.provide(
      Layer.mergeAll(
        Paint.layer,
        Clear.layer,
        SaveOpen.layer,
        SetRecording.layer,
        SavePosition.layer
      ).pipe(Layer.provide(Layer.succeed(Pages, pages)))
    ),
    Effect.asVoid
  )
