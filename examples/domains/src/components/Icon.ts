import type { Html } from "@effect/ui/html"

type Shape = readonly [
  tag: "circle" | "path" | "rect",
  attributes: Readonly<Record<string, string>>
]

const icons = {
  cart: [
    ["path", {
      d: "m2.05 2.05 1.099-.028a1 1 0 0 1 1.008.815l2.69 14.347A1 1 0 0 0 7.83 18H18"
    }],
    ["path", {
      d: "M4.563 5h16.435a1 1 0 0 1 .981 1.204l-1.026 6.226A2 2 0 0 1 18.962 14H6.25"
    }],
    ["circle", { cx: "18", cy: "20", r: "2" }],
    ["circle", { cx: "8", cy: "20", r: "2" }]
  ],
  search: [["path", { d: "m21 21-4.34-4.34" }], ["circle", {
    cx: "11",
    cy: "11",
    r: "8"
  }]],
  close: [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]],
  filter: [["path", { d: "M4 7h16" }], ["path", { d: "M7 12h10" }], ["path", {
    d: "M10 17h4"
  }]],
  check: [["path", { d: "M20 6 9 17l-5-5" }]],
  "arrow-up-right": [["path", { d: "M7 7h10v10" }], ["path", {
    d: "M7 17 17 7"
  }]],
  "chevron-down": [["path", { d: "m6 9 6 6 6-6" }]]
} satisfies Record<string, ReadonlyArray<Shape>>

const logo: ReadonlyArray<Shape> = [
  ["rect", { width: "92.3077", height: "200" }],
  ["rect", { x: "107.692", width: "92.3077", height: "38.4615" }],
  ["rect", { x: "107.692", y: "53.8461", width: "92.3077", height: "38.4615" }]
]

const Svg = <M>(
  h: Html.H<M>,
  attributes: Readonly<Record<string, string>>,
  shapes: ReadonlyArray<Shape>
) =>
  h.el("svg").attrs({ "aria-hidden": "true", ...attributes }).children(
    shapes.map(([tag, shape]) => h.el(tag).attrs(shape))
  )

export const Logo = <M>(h: Html.H<M>) =>
  Svg(h, {
    class: "logo",
    width: "20",
    height: "20",
    viewBox: "0 0 200 200",
    fill: "currentColor"
  }, logo)

export const Icon = <M>(h: Html.H<M>, name: keyof typeof icons) =>
  Svg(h, {
    class: "icon",
    width: "24",
    height: "24",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round"
  }, icons[name])
