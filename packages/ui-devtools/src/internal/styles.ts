import type { Mark } from "./read.ts"

const effectMark =
  "M32.579,704.971c10.261,-17.288 32.954,-23.125 50.689,-13.25l413.97,235.225l415.187,-234.383c17.738,-9.884 42.721,-2.905 50.692,13.25c7.537,19.758 4.008,39.483 -13.779,49.387l-431.055,240c-8.996,5.017 -19.254,5.975 -28.508,3.462c-1.138,-0.183 -2.271,-0.42 -3.4,-0.712c-3.067,-0.788 -6.083,-1.987 -8.958,-3.583l-431.042,-239.996c-17.805,-9.917 -24.08,-32.025 -13.796,-49.4Zm961.875,-410.403c0.433,13.963 -5.354,26.383 -18.525,33.721l-129.975,72.362l118.058,66.482c13.321,7.5 20.409,21.667 19.301,35.813c1.029,14.579 -4.551,27.692 -18.017,35.287l-446.267,251.284c-9.316,5.254 -19.937,6.258 -29.512,3.625c-4.392,-0.713 -8.729,-2.2 -12.804,-4.5l-446.249,-251.284c-13.322,-7.5 -20.406,-21.687 -19.294,-35.837c-1.031,-14.575 4.543,-27.667 18.009,-35.263l119.356,-67.204l-128.679,-71.65c-3.83,-2.137 -7.143,-4.791 -9.922,-7.834c-1.203,-1.155 -2.309,-2.396 -3.296,-3.723c-1.025,-1.37 -1.926,-2.816 -2.682,-4.349c-0.367,-0.96 -0.707,-1.921 -1.025,-2.881l-0.685,-1.748l-0.48,-1.403c-0.227,-0.701 -0.427,-1.413 -0.61,-2.136l-0.302,-1.295c-0.648,-2.978 -0.928,-6.043 -0.831,-9.118c-0.437,-13.963 5.352,-26.384 18.522,-33.721l456.405,-254.111c3.829,-2.136 7.875,-3.572 11.983,-4.359c6.109,-1.176 12.346,-0.907 18.204,0.69c4.488,0.734 8.925,2.234 13.092,4.554l456.392,254.11c0.683,0.378 1.346,0.777 1.996,1.198c0.612,0.389 1.212,0.788 1.795,1.198c0.538,0.389 1.067,0.788 1.58,1.198c1.654,1.306 3.175,2.73 4.558,4.251c1.075,1.036 2.063,2.126 2.962,3.281c1.163,1.489 2.171,3.086 3.009,4.78c0.366,0.961 0.7,1.91 1.016,2.871c2.08,4.953 3.088,10.316 2.917,15.711Zm-873.974,206.978l376.758,216.512l376.758,-215.112l-104.208,-59.888l-250.263,139.342c-9.533,5.308 -20.387,6.333 -30.187,3.667c-4.488,-0.734 -8.921,-2.234 -13.092,-4.555l-251.031,-139.77l-104.735,59.804Z"

const svgUrl = (svg: string) =>
  "url(\"data:image/svg+xml," + encodeURIComponent(svg) + "\")"

const logo = svgUrl(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 996 1000'><path d='" +
    effectMark + "'/></svg>"
)

const lockup = svgUrl(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 500.62 242'>" +
    "<path fill-rule='evenodd' d='M239.994 71.242C240.1 74.6071 238.703 77.6004 235.524 79.3688L204.157 96.8082L232.648 112.83C235.863 114.638 237.574 118.052 237.306 121.461C237.554 124.975 236.208 128.135 232.958 129.965L125.078 190.314C122.829 191.58 120.311 192.134 118 191.499C116.966 191.215 116.03 190.868 115.047 190.314L7.35187 129.755C4.13704 127.947 2.42741 124.528 2.69564 121.118C2.44694 117.605 3.79199 114.45 7.04198 112.62L35.8466 96.4233L4.79199 79.1555C3.86751 78.6406 3.06803 78.0009 2.39746 77.2675C2.1071 76.9893 1.84017 76.6902 1.60189 76.3703C1.35449 76.0401 1.13705 75.6916 0.954756 75.3223C0.866215 75.0909 0.784184 74.8594 0.707361 74.628L0.541997 74.2067L0.426112 73.8686C0.371425 73.6996 0.323248 73.5279 0.278977 73.3537L0.20606 73.0416C0.0498109 72.3239 -0.0178972 71.5853 0.00554019 70.8441C-0.0999283 67.479 1.2972 64.4858 4.47558 62.7174L114.621 1.47673C115.546 0.961814 117.009 0.441033 118 0.251192C119.474 -0.0322693 120.594 -0.131535 122 0.251193C123.071 0.542756 124.06 1.13085 125.066 1.68997L235.208 62.9306C235.373 63.0216 235.534 63.1179 235.69 63.2193C235.838 63.3129 235.983 63.4091 236.123 63.5079C236.254 63.6016 236.381 63.6978 236.505 63.7966C236.903 64.1113 237.271 64.4545 237.605 64.8212C237.864 65.0709 238.103 65.3335 238.32 65.6118C238.6 65.9707 238.843 66.3556 239.045 66.7639C239.134 66.9953 239.215 67.2242 239.291 67.4556C239.793 68.6493 240.036 69.9417 239.994 71.242ZM29.0758 121.123L120 173.304L210.924 121.461L185.776 107.028L125 140.499C122.699 141.779 121 142.499 118.5 141.999C117.417 141.822 116.007 141.058 115 140.499L54.3517 106.711L29.0758 121.123Z'/>" +
    "<path d='M7.86229 170.149C10.3388 165.983 15.8154 164.576 20.0953 166.956L120 223.645L220.199 167.159C224.479 164.776 230.509 166.459 232.432 170.352C234.251 175.114 233.399 179.867 229.106 182.255L125 239.999C122.828 241.208 120.733 242.105 118.5 241.499C118.384 241.468 117.621 241.241 117 240.999C116.685 240.876 115.694 240.384 115 239.999L11.1917 182.055C6.89484 179.665 5.38053 174.336 7.86229 170.149Z'/>" +
    "<path fill-rule='evenodd' d='M332.134 44.500H470.896A29.721 29.721 0 0 1 500.616 74.221V170.779A29.721 29.721 0 0 1 470.896 200.500H332.134A29.721 29.721 0 0 1 302.413 170.779V74.221A29.721 29.721 0 0 1 332.134 44.500ZM332.134 60.103H470.896A14.117 14.117 0 0 1 485.013 74.221V170.779A14.117 14.117 0 0 1 470.896 184.897H332.134A14.117 14.117 0 0 1 318.017 170.779V74.221A14.117 14.117 0 0 1 332.134 60.103Z'/>" +
    "<path d='M349.223 82.460H367.947V130.508A15.124 15.124 0 0 0 398.196 130.508V82.460H416.920V130.508A33.848 33.848 0 0 1 349.223 130.508Z'/>" +
    "<path d='M435.083 82.460H453.807V162.540H435.083Z'/>" +
    "</svg>"
)

const glyph = (body: string) =>
  svgUrl(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'>" +
      body + "</svg>"
  )

const marks: {
  readonly [M in Mark]: readonly [color: string, body: string]
} = {
  message: [
    "var(--ink)",
    "<circle cx='6' cy='6' r='2.6' fill='black' stroke='none'/>"
  ],
  issue: ["var(--cmd)", "<path d='M6 1.6 10.4 6 6 10.4 1.6 6z'/>"],
  start: ["var(--cmd)", "<path d='M3.5 2.5 9.5 6l-6 3.5z'/>"],
  end: ["var(--cmd)", "<path d='M2.5 6.4 5 8.8l4.6-5.4'/>"],
  bad: ["var(--bad)", "<path d='M3 3l6 6M9 3l-6 6'/>"],
  mount: ["var(--faint)", "<path d='M6 2.5v7M2.5 6h7'/>"],
  unmount: ["var(--faint)", "<path d='M2.5 6h7'/>"],
  ring: ["var(--faint)", "<circle cx='6' cy='6' r='3.2'/>"]
}

const markRules = Object.entries(marks).map(([name, [color, body]]) =>
  ".mk-" + name + " { color: " + color + "; -webkit-mask-image: " +
  glyph(body) + "; mask-image: " + glyph(body) + "; }"
).join("\n")

export const styles = `
:root {
  --bg: #ffffff; --ink: #1f1f23; --muted: #5f5f67; --faint: #67676e; --line: #ececef; --sel: #ededf0;
  --bad: #b8352a; --open: #8c5806; --cmd: #6f42c1; --focus: #4b6bfb;
  --sunk: #f7f7f8; --str: #0a3069; --num: #005cc5;
  --sans: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1c1c1f; --ink: #ededef; --muted: #a1a1aa; --faint: #92929b; --line: #2b2b30; --sel: #28282d;
    --bad: #f2766b; --open: #e0b04f; --cmd: #b392f0; --focus: #8ea2ff;
    --sunk: #17171a; --str: #9ecbff; --num: #79b8ff;
  }
}
*, *::before, *::after { box-sizing: border-box; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; margin: 0; cursor: pointer; text-align: inherit; }
button:focus-visible, summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; border-radius: 4px; }
h2, h3, h4, p, ol, ul { margin: 0; padding: 0; font-size: inherit; font-weight: inherit; }
ol, ul { list-style: none; }
html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
#root { width: max-content; }
.overlay { font: 13px/20px var(--sans); color: var(--ink); -webkit-font-smoothing: antialiased; }
.muted { color: var(--muted); }
.code { font-family: var(--mono); font-size: .94em; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.mk { display: inline-block; flex: none; width: 12px; height: 12px; background: currentColor; -webkit-mask-size: contain; mask-size: contain; -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat; }
${markRules}
.t-str { color: var(--str); }
.t-num { color: var(--num); }
.tone-bad { color: var(--bad); }
.tone-open { color: var(--open); }
.launch { display: flex; align-items: center; border: 1px solid var(--line); border-radius: 999px; background: var(--bg); }
.launcher { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-radius: 999px; font-weight: 500; touch-action: none; }
[data-dragging] .launcher { cursor: grabbing; user-select: none; }
.launch .paused { padding: 0 4px 0 10px; border-left: 1px solid var(--line); }
.lockup { flex: none; width: 37.25px; height: 18px; background: currentColor; -webkit-mask: ${lockup} center / contain no-repeat; mask: ${lockup} center / contain no-repeat; }
@media (forced-colors: active) { .lockup { forced-color-adjust: none; background: ButtonText; } }
.alert { display: flex; align-items: center; gap: 5px; align-self: stretch; padding: 0 12px 0 10px; border-left: 1px solid var(--line); color: var(--bad); font-weight: 500; font-variant-numeric: tabular-nums; }
.launcher-count { color: var(--muted); font-variant-numeric: tabular-nums; line-height: 1; text-box: trim-both cap alphabetic; }
.panel { position: relative; width: min(var(--panel-w, 920px), calc(var(--vw, 100vw) - 24px)); height: min(var(--panel-h, 560px), calc(var(--vh, 100vh) - 24px)); display: grid; grid-template-rows: 44px minmax(0, 1fr); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: var(--bg); container: panel / inline-size; }
.panel.empty { grid-template-rows: 44px 1fr; }
.panel.pausing { grid-template-rows: 44px auto minmax(0, 1fr); }
.paused { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.paused-label { color: var(--open); font-weight: 500; font-variant-numeric: tabular-nums; }
.paused-label::before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: currentColor; vertical-align: 1px; }
.resume { padding: 2px 10px; border-radius: 999px; background: var(--ink); color: var(--bg); font-weight: 500; }
.pausebar { display: grid; gap: 2px; padding: 8px 20px; border-bottom: 1px solid var(--line); background: var(--sel); }
.scrub { display: flex; align-items: center; gap: 12px; }
.scrub input { flex: 1; min-width: 0; margin: 0; accent-color: var(--ink); }
.scrub .at { min-width: 48px; text-align: right; font-variant-numeric: tabular-nums; }
.pause-notes { display: grid; gap: 4px; min-height: 18px; font-size: 12px; line-height: 18px; }
.pause-note { min-width: 0; }
.pause-note summary { cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pause-paths { margin-top: 4px; padding: 4px 8px; max-height: 96px; overflow: auto; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink); font-family: var(--mono); overflow-wrap: anywhere; }
.empty-note { padding: 20px; color: var(--muted); }
.grip { position: absolute; width: 16px; height: 16px; z-index: 1; cursor: nwse-resize; touch-action: none; }
.grip::before { content: ""; position: absolute; inset: 4px; border: 0 solid var(--faint); border-radius: 2px; }
[data-position=BottomRight] .grip { top: 0; left: 0; }
[data-position=BottomRight] .grip::before { border-top-width: 1.5px; border-left-width: 1.5px; }
[data-position=BottomLeft] .grip { top: 0; right: 0; cursor: nesw-resize; }
[data-position=BottomLeft] .grip::before { border-top-width: 1.5px; border-right-width: 1.5px; }
[data-position=TopRight] .grip { bottom: 0; left: 0; cursor: nesw-resize; }
[data-position=TopRight] .grip::before { border-bottom-width: 1.5px; border-left-width: 1.5px; }
[data-position=TopLeft] .grip { bottom: 0; right: 0; }
[data-position=TopLeft] .grip::before { border-bottom-width: 1.5px; border-right-width: 1.5px; }
.bar { display: flex; align-items: center; gap: 12px; padding: 0 12px 0 20px; border-bottom: 1px solid var(--line); min-width: 0; }
.logo { flex: none; width: 14px; height: 14px; margin-right: -4px; background: currentColor; -webkit-mask: ${logo} center / contain no-repeat; mask: ${logo} center / contain no-repeat; }
.title { font-weight: 600; white-space: nowrap; }
.app { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.spacer { flex: 1; }
.count { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.follow, .clear { padding: 3px 10px; border-radius: 6px; color: var(--muted); white-space: nowrap; }
.follow { display: flex; align-items: center; gap: 6px; }
.follow .dot { width: 7px; height: 7px; border-radius: 50%; border: 1.5px solid currentColor; }
.follow.on .dot { background: currentColor; }
.follow:hover, .follow.on, .clear:hover:not(:disabled), .close:hover, .back:hover { background: var(--sel); color: var(--ink); }
.clear:disabled { opacity: .5; cursor: default; }
.close { width: 28px; height: 28px; border-radius: 6px; color: var(--muted); text-align: center; }
.corner-wrap { position: relative; flex: none; }
.corner { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 6px; color: var(--muted); }
.corner:hover, .corner.on { background: var(--sel); color: var(--ink); }
.corner-icon { display: grid; grid-template-columns: repeat(2, 4px); gap: 3px; }
.corner-icon i { display: block; width: 4px; height: 4px; border-radius: 1px; background: currentColor; opacity: .32; }
.corner-icon i.here { opacity: 1; background: var(--ink); }
.corner-menu { position: absolute; top: calc(100% + 4px); right: 0; z-index: 2; display: grid; grid-template-columns: repeat(2, max-content); gap: 4px; padding: 6px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); box-shadow: 0 6px 18px light-dark(rgb(0 0 0 / .12), rgb(0 0 0 / .45)); }
.corner-option { padding: 4px 8px; border-radius: 5px; font-size: 12px; color: var(--muted); white-space: nowrap; }
.corner-option:hover, .corner-option.on { background: var(--sel); color: var(--ink); }
.corner-option.on { font-weight: 600; }
.body { display: grid; grid-template-columns: minmax(280px, 340px) minmax(0, 1fr); min-height: 0; }
.left { background: var(--sunk); border-right: 1px solid var(--line); display: grid; grid-template-rows: auto auto minmax(0, 1fr); min-height: 0; }
.instances { padding: 10px 0 6px; border-bottom: 1px solid var(--line); min-width: 0; }
.ihead { display: flex; align-items: center; gap: 8px; padding: 0 20px 6px; }
.heading { font-size: 12px; color: var(--muted); }
.icount { font-size: 12px; color: var(--faint); font-variant-numeric: tabular-nums; }
.find { flex: 1; min-width: 0; height: 24px; margin-left: 6px; padding: 0 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink); font: 12px var(--sans); }
.find::placeholder { color: var(--faint); }
.find:focus-visible { outline: 2px solid var(--focus); outline-offset: 0; }
.ilist { --cap: calc(var(--vh, 100vh) * .25); max-height: var(--cap); min-height: min(var(--slots, 0) * 26px, var(--cap)); overflow: auto; overscroll-behavior: contain; }
.iitem { display: flex; align-items: center; height: 26px; }
.iitem.split { border-top: 1px solid var(--line); }
.irow { display: flex; align-items: center; flex: 1; min-width: 0; height: 26px; padding: 0 20px 0 14px; white-space: nowrap; }
.irow .imark { margin-right: 6px; }
.tree-list .irow { padding-left: 2px; }
.irow:hover, .irow.on { background: var(--sel); }
.irow.on { box-shadow: inset 2px 0 0 var(--ink); }
.irow.owner .iname { font-weight: 600; }
.irow .id { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.irow .in { color: var(--faint); font-size: 12px; margin-left: 2px; }
.iitem .chev { width: 14px; height: 26px; font-size: 10px; text-align: center; }
.status { flex: 0 1 auto; min-width: 0; max-width: 62%; color: var(--muted); white-space: nowrap; font-size: 12px; padding-left: 10px; overflow: hidden; text-overflow: ellipsis; }
.rollup { flex: none; display: flex; align-items: center; gap: 10px; padding-left: 10px; font-size: 12px; font-variant-numeric: tabular-nums; }
.rollup .under { color: var(--faint); }
.roll { display: flex; align-items: center; gap: 3px; }
.roll .mk { width: 10px; height: 10px; }
.inote { padding: 2px 20px 4px; color: var(--muted); font-size: 12px; }
.browse { display: block; margin: 2px 0 0; padding: 2px 20px 2px 32px; font-size: 12px; color: var(--muted); text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 3px; }
.browse:hover { color: var(--ink); text-decoration-color: currentColor; }
.filters { display: flex; gap: 18px; padding: 0 20px; border-bottom: 1px solid var(--line); }
.filter, .tab { padding: 8px 0 7px; color: var(--muted); border-bottom: 2px solid transparent; margin-bottom: -1px; }
.filter:hover, .tab:hover { color: var(--ink); }
.filter.on, .tab[data-active] { color: var(--ink); border-bottom-color: var(--ink); }
.stopped { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; padding: 6px 20px; border-bottom: 1px solid var(--line); color: var(--faint); font-size: 12px; }
.stopped button { padding: 0 6px; border: 1px solid var(--line); border-radius: 6px; color: var(--muted); }
.stopped button:hover { color: var(--ink); border-color: currentColor; }
.timeline-box { --chain: var(--ink); display: grid; grid-template-columns: minmax(0, 1fr) auto; min-height: 0; }
.timeline-box.cmd { --chain: var(--cmd); }
.gutter { position: relative; width: 8px; border-left: 1px solid var(--line); pointer-events: none; }
.gutter i { position: absolute; left: 1px; right: 1px; height: 3px; border-radius: 1px; }
.gutter .g-bad { background: var(--bad); }
.gutter .g-link { left: 2px; right: 2px; background: var(--chain); }
.timeline { overflow: auto; min-height: 0; }
.row { display: grid; grid-template-columns: 14px minmax(0, 1fr); height: 28px; white-space: nowrap; }
.row-button { display: grid; grid-template-columns: calc(var(--seq-digits, 3) * 1ch + 10px) 22px minmax(0, 1fr); align-items: center; padding: 0 12px 0 0; height: 28px; }
.lw { display: flex; min-width: 0; }
.lw .label { flex: 0 1 auto; min-width: 0; }
.lw .who { flex: 1 1 0; min-width: 0; text-align: right; overflow: hidden; text-overflow: ellipsis; }
.row:hover { background: var(--sel); }
.row.selected { background: var(--bg); box-shadow: 0 1px 0 var(--line), 0 -1px 0 var(--line); }
.row .seq { color: var(--faint); font-size: 12px; text-align: right; padding-right: 2px; font-variant-numeric: tabular-nums; }
.row.linked .seq { color: var(--ink); }
.row .mark { justify-self: center; }
.row .label { overflow: hidden; text-overflow: ellipsis; }
.row .verb { color: var(--muted); }
.row .verb.tone-bad { color: var(--bad); }
.row .verb.tone-open { color: var(--open); }
.row.selected .label { font-weight: 600; }
.row .who { color: var(--muted); font-size: 12px; padding-left: 12px; }
.rail { position: relative; }
.rail.top::before, .rail.mid::before, .rail.bot::before { content: ""; position: absolute; left: 8px; width: 2px; background: var(--chain); }
.rail.top::before { top: 6px; bottom: 0; }
.rail.mid::before { top: 0; bottom: 0; }
.rail.bot::before { top: 0; bottom: 6px; }
.hidden-note { margin: 0; padding: 8px 20px 12px 62px; color: var(--faint); }
.hidden-note button { color: var(--muted); text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 3px; }
.right { overflow: auto; min-height: 0; min-width: 0; display: flex; flex-direction: column; container: detail / inline-size; }
.ehead { padding: 16px 24px 4px; }
.ehead-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.stop { flex: none; margin: 1px 0 0 auto; padding: 2px 10px; color: var(--muted); white-space: nowrap; }
.stop:hover { color: var(--ink); }
.show { flex: none; margin-top: 1px; padding: 2px 10px; border: 1px solid var(--line); border-radius: 6px; color: var(--muted); white-space: nowrap; }
.show:hover { color: var(--ink); }
.show.on { background: var(--ink); border-color: var(--ink); color: var(--bg); }
.show:disabled { opacity: .5; cursor: default; }
.headline { font-size: 17px; line-height: 24px; font-weight: 600; overflow-wrap: anywhere; }
.headline .code { font-size: 16px; letter-spacing: -.02em; }
.sub { color: var(--muted); margin-top: 2px; }
.crumbs { display: flex; flex-wrap: wrap; align-items: baseline; margin-top: 2px; color: var(--muted); }
.crumb { text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 3px; overflow-wrap: anywhere; }
.crumb:hover { color: var(--ink); text-decoration-color: currentColor; }
.crumb.here { color: var(--ink); }
.crumb[aria-pressed=true] { text-decoration-color: var(--ink); text-decoration-thickness: 2px; }
.crumbs .slash { color: var(--faint); padding: 0 5px; }
.chain { margin: 14px 0 4px; }
.step { position: relative; padding: 0 0 8px 24px; }
.step::before { content: ""; position: absolute; left: 5px; top: 18px; bottom: -2px; width: 2px; border-radius: 1px; background: var(--line); }
.step.run::before { background: var(--cmd); opacity: .55; }
.step:last-child::before { display: none; }
.node { position: absolute; left: 0; top: 4px; display: grid; place-items: center; width: 12px; height: 12px; }
.step-this > .what { font-weight: 600; }
.step-bad > .what { color: var(--bad); }
.step-bad .cause { color: var(--muted); }
.step-open .node .mk { color: var(--open); }
.step-open > .what { color: var(--open); }
.what strong { font-weight: 600; }
.args { font: 12px/18px var(--mono); color: var(--muted); overflow-wrap: anywhere; }
.ref { color: inherit; opacity: .8; text-decoration: underline; text-decoration-color: var(--faint); text-underline-offset: 3px; font-variant-numeric: tabular-nums; }
.ref:hover { opacity: 1; text-decoration-color: currentColor; }
.ref.outside { text-decoration-style: dotted; color: var(--faint); }
.details { display: grid; grid-template-rows: auto minmax(0, 1fr); min-height: 240px; flex: 1; }
.tabs { display: flex; gap: 18px; padding: 0 24px; border-bottom: 1px solid var(--line); margin-top: 8px; }
.tab { white-space: nowrap; }
.tab .pill { display: inline-block; min-width: 18px; padding: 0 6px; border-radius: 999px; background: var(--sel); color: var(--muted); font-size: 11px; line-height: 16px; text-align: center; font-variant-numeric: tabular-nums; }
.pane { padding: 12px 24px 20px; min-width: 0; overflow: auto; }
.pane.model { display: grid; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; padding-bottom: 0; }
.pane h4 { margin: 14px 0 6px; }
.note { color: var(--muted); margin-bottom: 8px; }
.tree { font: 12.5px/22px var(--mono); }
.tree.scroll { overflow: auto; min-height: 0; padding-bottom: 12px; }
.tl { display: grid; grid-template-columns: minmax(80px, 150px) minmax(0, 1fr); gap: 12px; padding-right: 8px; border-left: 2px solid transparent; }
.tl .k { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tl .v { overflow-wrap: anywhere; }
.tl.chg { border-left-color: var(--ink); background: var(--sel); }
.tl .toggle { display: flex; gap: 2px; min-width: 0; margin-left: -12px; }
.chev { flex: none; width: 10px; color: var(--faint); }
.old { color: var(--faint); text-decoration-thickness: 1px; }
.new { text-decoration: none; }
.arrow { color: var(--faint); font-family: var(--sans); }
.placeholder { font: 11px var(--sans); color: var(--muted); border: 1px dashed var(--faint); border-radius: 4px; padding: 0 4px; }
.t-punct, .t-key { color: var(--muted); }
.commands { display: grid; gap: 10px; }
.raw-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.copy { padding: 3px 10px; border-radius: 6px; background: var(--sel); white-space: nowrap; }
.raw { font: 12px/18px var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
.life { width: 100%; border-collapse: collapse; table-layout: fixed; }
.life th, .life td { padding: 7px 16px 7px 0; border-bottom: 1px solid var(--line); vertical-align: top; text-align: left; font-weight: 400; }
.life th { color: var(--muted); white-space: nowrap; width: 104px; }
.life td { overflow-wrap: anywhere; }
.life td:nth-child(3) { width: 22%; }
.life td:nth-child(4) { width: 28%; }
.life td:last-child { padding-right: 0; }
.life tr:last-child > * { border-bottom: 0; }
@container detail (max-width: 499px) {
  .tabs { column-gap: 12px; flex-wrap: wrap; }
  .tab { flex: none; }
  .tab .unit { display: none; }
  .life, .life tbody { display: block; }
  .life tr { display: grid; grid-template-columns: 88px minmax(0, 1fr) minmax(0, 1fr); column-gap: 12px; row-gap: 2px; padding: 7px 0; border-bottom: 1px solid var(--line); }
  .life tr:last-child { border-bottom: 0; }
  .life th, .life td { padding: 0; border-bottom: 0; }
  .life th { width: auto; grid-row: span 2; }
  .life td:nth-child(2) { grid-column: span 2; }
  .life td:nth-child(3), .life td:nth-child(4) { width: auto; }
}
.back { display: none; align-self: flex-start; margin: 10px 0 0 10px; padding: 3px 10px; border-radius: 6px; color: var(--muted); white-space: nowrap; }
@container panel (max-width: 719px) {
  .bar { gap: 8px; padding-left: 16px; }
  .logo { margin-right: 0; }
  .title { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .count { display: none; }
  .follow, .clear { padding: 3px 8px; }
  .body { grid-template-columns: minmax(0, 1fr); }
  .left { border-right: 0; }
  [data-pane=timeline] > .body > .right, [data-pane=entry] > .body > .left { display: none; }
  .back { display: block; }
  .ilist { --cap: calc(var(--vh, 100vh) * .2); }
  .ehead { padding: 8px 16px 4px; }
  .tabs { column-gap: 12px; flex-wrap: wrap; padding: 0 16px; }
  .tab { flex: none; }
  .tab .unit { display: none; }
  .pane { padding: 12px 16px 16px; }
  .tl { grid-template-columns: minmax(64px, 112px) minmax(0, 1fr); gap: 10px; }
}
`
