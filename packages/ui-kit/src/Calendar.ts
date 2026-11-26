/**
 * A controlled single-month calendar grid for picking a date. Pass the
 * selected date as `value`, the visible month as `month` and the current day
 * as `today`. Handle `Picked` to update `value` and `RequestedMonth` to
 * update `month`. Your view supplies the markup; the component computes
 * the grid dates and attributes and manages keyboard navigation and focus.
 *
 * **Anatomy**
 *
 * | Part       | Element    |
 * | :--------- | :--------- |
 * | `root`     | any element, around the header and the grid |
 * | `heading`  | any element, showing `calendar.title` |
 * | `previous` | `<button>` |
 * | `next`     | `<button>` |
 * | `grid`     | `<table>` |
 * | `weekday`  | `<th>` inside the grid header |
 * | `cell`     | `<td>` inside the grid body |
 * | `day`      | `<button>` inside each `cell` |
 *
 * `root`, `heading`, `previous`, `next` and `grid` take the consumer's
 * builder and return it. `weekday({ element, index })` takes the column index
 * (`0` to `6`), `cell({ element, date })` takes the cell's date, and
 * `day({ element, date, unavailable? })` takes the day's date and an optional
 * `unavailable` flag. No part adds markup.
 *
 * The parts object also carries `weeks` (`DateTime.Utc[][]`, whole weeks),
 * `weekdays` (short and long names in display order), `month` (normalized
 * first of the shown month) and `title` (localized month and year).
 *
 * Inside a `Field`, apply `field.group` to `root`, `field.member` to each
 * `day`, and pass `disabled: field.disabled`.
 *
 * **Date values**
 *
 * Every date prop accepts any `DateTime` (`DateTime.Utc` or
 * `DateTime.Zoned`) and is normalized with `DateTime.removeTime` to a
 * `DateTime.Utc` at midnight UTC. A `Zoned` value uses its calendar day in
 * its own time zone; a `Utc` value uses its UTC day. Because a UTC "now"
 * gives the UTC day, obtain `today` from `DateTime.nowInCurrentZone` or
 * another zoned `DateTime`. Every date the component emits or exposes in part
 * values is a normalized `DateTime.Utc`, and all localized formatting uses
 * `timeZone: "UTC"` so formatting preserves the normalized day.
 *
 * **Data attributes**
 *
 * Each present with an empty value or absent:
 *
 * - `root`, `heading`, `grid`: `data-disabled`, `data-readonly`
 * - `previous`, `next`: `data-disabled`
 * - `day`: `data-selected`, `data-today`, `data-outside-month`,
 *   `data-unavailable`, `data-disabled`, `data-focused`
 *
 * **Keyboard**
 *
 * When the grid has an enabled day, one day sits in the page's Tab order
 * (`tabindex="0"`); the rest have `tabindex="-1"`.
 *
 * - ArrowLeft / ArrowRight move by one day (swapped in a right-to-left layout)
 * - ArrowUp / ArrowDown move by one week
 * - Home / End move to the start / end of the week
 * - PageUp / PageDown move by one month
 * - Shift + PageUp / Shift + PageDown move by one year
 * - Enter and Space activate the focused day natively
 *
 * Unavailable days stay focusable with `aria-disabled="true"`, are not
 * skipped by arrow keys, and emit nothing when pressed. Days outside `min`
 * and `max` are natively `disabled`, and keyboard navigation clamps to the
 * range. Moves that leave the shown month emit `RequestedMonth`; if the
 * consumer leaves `month` unchanged, focus stays in the shown month. When
 * `month` changes while a day has focus, focus moves through `root` to the
 * new tab stop without leaving the calendar. Keep the same `root` element
 * mounted across month changes; the grid and days can be replaced.
 * If no day in the new month is in range, a visible day from an adjacent
 * month can receive focus.
 *
 * **Usage**
 *
 * The calendar follows the nearest `DirectionProvider` above it or, without
 * one, the root's CSS `direction`. The server formats with its own default
 * locale, which may differ from the browser's; pass `locale` when rendering
 * on a server.
 *
 * **Example** (A controlled calendar whose selected date and month live in the consumer's Model)
 *
 * ```ts import.meta.vitest
 * import { UiSchema } from "@effect/ui"
 * import { Html, HtmlServer } from "@effect/ui/html"
 * import { Calendar } from "@effect/ui-kit"
 * import { DateTime, Effect, Schema } from "effect"
 *
 * const BookingMessage = UiSchema.TaggedEnum({
 *   PickedDate: { date: Schema.DateTimeUtc },
 *   RequestedMonth: { month: Schema.DateTimeUtc }
 * })
 *
 * const Booking = Html.component({
 *   name: "Booking",
 *   model: Schema.Struct({
 *     date: Schema.NullOr(Schema.DateTimeUtc),
 *     month: Schema.DateTimeUtc
 *   }),
 *   message: BookingMessage
 * }).make({
 *   init: () => ({
 *     date: DateTime.makeUnsafe("2026-11-15T00:00:00Z"),
 *     month: DateTime.makeUnsafe("2026-11-01T00:00:00Z")
 *   }),
 *   update: {
 *     PickedDate: ($, { date }) => $.evolve({ date }),
 *     RequestedMonth: ($, { month }) => $.evolve({ month })
 *   },
 *   view: (h, model) =>
 *     Calendar(h, {
 *       props: {
 *         value: model.date,
 *         month: model.month,
 *         today: DateTime.makeUnsafe("2026-11-26T00:00:00Z"),
 *         locale: "en-US"
 *       },
 *       onEmit: {
 *         Picked: ({ date }) => BookingMessage.PickedDate({ date }),
 *         RequestedMonth: ({ month }) => BookingMessage.RequestedMonth({ month })
 *       },
 *       view: (calendar) =>
 *         calendar.root(h.div.class("calendar")).children(
 *           calendar.heading(h.h2).children(calendar.title),
 *           calendar.previous(h.button).children("Prev"),
 *           calendar.next(h.button).children("Next"),
 *           calendar.grid(h.table.class("grid")).children(
 *             h.thead(
 *               h.tr(
 *                 ...calendar.weekdays.map((day, index) =>
 *                   calendar.weekday({ element: h.th, index }).children(day.short)
 *                 )
 *               )
 *             ),
 *             h.tbody(
 *               ...calendar.weeks.map((week) =>
 *                 h.tr(
 *                   ...week.map((date) =>
 *                     calendar.cell({ element: h.td, date }).children(
 *                       calendar.day({ element: h.button, date }).children(
 *                         String(DateTime.getPartUtc(date, "day"))
 *                       )
 *                     )
 *                   )
 *                 )
 *               )
 *             )
 *           )
 *         )
 *     })
 * })
 *
 * const { html } = await Effect.runPromise(HtmlServer.renderToHtml(Booking, {}))
 * if (!/<table class="grid"[^>]* role="grid"/.test(html)) throw new Error("the grid isn't a styled grid")
 * if (!/<td[^>]* role="gridcell"[^>]* aria-selected="true"/.test(html)) throw new Error("no selected cell")
 * ```
 *
 * @stability experimental
 * @since 0.1.0
 */
import * as Command from "@effect/ui/Command"
import type * as Component from "@effect/ui/Component"
import * as Html from "@effect/ui/html/Html"
import * as HtmlCommand from "@effect/ui/html/HtmlCommand"
import * as Mount from "@effect/ui/Mount"
import * as Renderer from "@effect/ui/Renderer"
import * as Subscription from "@effect/ui/Subscription"
import * as UiSchema from "@effect/ui/UiSchema"
import * as View from "@effect/ui/View"
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { DirectionProvider } from "./DirectionProvider.ts"
import { fallbackLabel, flag, type Keyed } from "./internal/attributes.ts"
import {
  CalendarDate,
  CalendarDayRef,
  CalendarGridKey,
  CalendarGridModel,
  CalendarGridPropsFields,
  type CalendarWeekdayName,
  canStepMonth,
  dateKey,
  firstDayOfWeek,
  focusDay,
  formatMonthTitle,
  fullDateFormatter,
  gridKeyOf,
  isOutOfRange,
  moveDate,
  normalizeOptional,
  sameDay,
  sameMonth,
  startOfMonth,
  syncMonthPhase,
  tabStopOf,
  toDay,
  weekdayNames,
  weeksOfMonth
} from "./internal/calendar.ts"
import { rightToLeft, TrackDirection } from "./internal/direction.ts"

/**
 * Short and long localized names for a day of the week in `Calendar`.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type CalendarWeekday = CalendarWeekdayName

/**
 * Props for a `Calendar`.
 *
 * **Details**
 *
 * - `value`: the selected date, or `null` for none. Normalized with
 *   `DateTime.removeTime`.
 * - `month`: any date in the month to display. Controlled so consumers can
 *   jump to a month and load its availability.
 * - `today`: the current day, passed as a prop so `init` stays pure and
 *   server HTML matches the client. Prefer `DateTime.nowInCurrentZone` or
 *   another zoned `DateTime`.
 * - `min` and `max`: optional inclusive date bounds. Days outside the range
 *   are natively `disabled` and keyboard focus clamps to the bounds.
 * - `firstDayOfWeek`: `0` (Sunday) to `6` (Saturday). Defaults to the
 *   locale's first day via `Intl.Locale#getWeekInfo` (including a `-u-fw-`
 *   extension), or Monday (`1`) when unavailable.
 * - `locale`: BCP 47 locale tag or tags for month titles, weekday names and
 *   day labels, which always use the Gregorian calendar of the grid. Defaults
 *   to the runtime's default locale.
 * - `disabled`: disables every button and suppresses all interaction.
 * - `readOnly`: allows focus, keyboard navigation and month requests while
 *   suppressing `Picked`.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const CalendarProps = Schema.Struct({
  value: Schema.NullOr(CalendarDate),
  ...CalendarGridPropsFields
})

/**
 * The props of a `Calendar`.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type CalendarProps = typeof CalendarProps.Type

/**
 * Events emitted by `Calendar`.
 *
 * **Details**
 *
 * - `Picked`: emitted when the user presses an enabled, available day while
 *   not `readOnly`. Carries the normalized midnight-UTC `date`.
 * - `RequestedMonth`: emitted when the user presses `previous` or `next` or
 *   navigates with the keyboard outside the shown month. Carries the
 *   normalized first day of the requested `month`.
 *
 * @stability experimental
 * @category schemas
 * @since 0.1.0
 */
export const CalendarEvents = UiSchema.TaggedEnum({
  Picked: { date: Schema.DateTimeUtc },
  RequestedMonth: { month: Schema.DateTimeUtc }
})

/**
 * What a `Calendar` emits.
 *
 * @stability experimental
 * @category models
 * @since 0.1.0
 */
export type CalendarEvents = typeof CalendarEvents.Type

const CalendarMessage = UiSchema.TaggedEnum({
  ClickedDay: { date: Schema.DateTimeUtc, unavailable: Schema.Boolean },
  ClickedStep: { months: Schema.Literals([-1, 1]) },
  FocusedDay: { date: Schema.DateTimeUtc },
  BlurredDay: {},
  PressedKey: { date: Schema.DateTimeUtc, move: CalendarGridKey },
  SyncedMonth: {},
  ParkedFocus: { date: Schema.DateTimeUtc },
  FoundDirection: { rtl: Schema.Boolean }
})

type CalendarMessage = typeof CalendarMessage.Type

type CalendarUpdate = Component.Update<
  CalendarGridModel,
  CalendarMessage,
  CalendarEvents,
  CalendarProps
>

const disabledWhileFocused = Subscription.make(
  "disabledWhileFocused",
  Stream.make(CalendarMessage.BlurredDay())
)

const CalendarRootRef = Renderer.ref("CalendarRoot")

const monthOf = (props: CalendarProps) => startOfMonth(props.month)

const contextOf = (props: CalendarProps, monthStart = monthOf(props)) => ({
  monthStart,
  weekStartsOn: props.firstDayOfWeek ?? firstDayOfWeek(props.locale),
  preferred: normalizeOptional(props.value),
  today: toDay(props.today),
  min: normalizeOptional(props.min),
  max: normalizeOptional(props.max)
})

const settled = ($: CalendarUpdate) =>
  $.model.pendingFocus === null ? $.model : $.evolve({ pendingFocus: null })

const navigate = (
  $: CalendarUpdate,
  date: DateTime.Utc,
  move: CalendarGridKey
) => {
  if ($.props.disabled === true) return $.model
  const context = contextOf($.props)
  const target = moveDate(
    date,
    move,
    context.weekStartsOn,
    context.min,
    context.max
  )
  if (sameDay(target, date)) return settled($)
  if (sameMonth(target, context.monthStart)) {
    return $.evolve({
      focusedDay: target,
      pendingFocus: null
    }).run(focusDay(target))
  }
  return $.evolve({ pendingFocus: target }).emit(
    CalendarEvents.RequestedMonth({ month: startOfMonth(target) })
  )
}

/**
 * A headless calendar grid. Call it with the consumer's `h`, the `props`,
 * `onEmit`, and a `view` closure that draws `root`, `heading`, `previous`,
 * `next`, `grid`, `weekday`, `cell` and `day`.
 *
 * **Details**
 *
 * The parts object also exposes `weeks`, `weekdays`, `month` and `title`.
 *
 * Each part's owned attributes win over values the consumer set on the
 * builder before applying the part, including attributes a state leaves
 * absent:
 *
 * - `root`: `tabindex="-1"`, `data-disabled` and `data-readonly`
 * - `heading`: `id`, `aria-live="polite"`, `data-disabled` and `data-readonly`
 * - `previous`, `next`: `type="button"`, `disabled`, `aria-disabled` and
 *   `data-disabled` (plus a fallback `aria-label` when the button has no
 *   accessible name)
 * - `grid`: `role="grid"`, `aria-labelledby` (appending the heading's id),
 *   `aria-disabled`, `aria-readonly`, `data-disabled` and `data-readonly`
 * - `weekday`: `scope="col"` and `abbr`
 * - `cell`: `role="gridcell"` and `aria-selected`
 * - `day`: `type="button"`, `tabindex`, `disabled`, `aria-label`,
 *   `aria-disabled`, `aria-current`, `data-selected`, `data-today`,
 *   `data-outside-month`, `data-unavailable`, `data-disabled` and
 *   `data-focused`
 *
 * `weekday` throws when `index` is not an integer between `0` and `6`.
 *
 * History restore saves nothing of the calendar's transient focus state:
 * after Back, forward or a reload it starts from `init`.
 *
 * @stability experimental
 * @category components
 * @since 0.1.0
 */
export const Calendar = Html.component({
  name: "Calendar",
  props: CalendarProps,
  model: CalendarGridModel,
  message: CalendarMessage,
  events: CalendarEvents,
  reads: {
    provider: { owner: DirectionProvider, optional: true }
  },
  restore: false
}).make({
  init: ({ props }) => ({
    focusedDay: null,
    focused: false,
    shownMonth: monthOf(props),
    pendingFocus: null,
    rtl: false
  }),
  update: {
    ClickedDay: ($, { date, unavailable }) => {
      const { max, min } = contextOf($.props)
      if ($.props.disabled === true || isOutOfRange(date, min, max)) {
        return $.model
      }
      if (unavailable || $.props.readOnly === true) return settled($)
      return $.evolve({ focusedDay: date, pendingFocus: null }).emit(
        CalendarEvents.Picked({ date })
      )
    },
    ClickedStep: ($, { months }) => {
      const { max, min, monthStart } = contextOf($.props)
      if (
        $.props.disabled === true ||
        !canStepMonth(monthStart, months, min, max)
      ) {
        return $.model
      }
      return $.evolve({ pendingFocus: null }).emit(
        CalendarEvents.RequestedMonth({
          month: DateTime.add(monthStart, { months })
        })
      )
    },
    FocusedDay: ($, { date }) => {
      const { max, min } = contextOf($.props)
      if ($.props.disabled === true || isOutOfRange(date, min, max)) {
        return $.model
      }
      return $.evolve({ focusedDay: date, focused: true, pendingFocus: null })
    },
    BlurredDay: ($) =>
      $.model.focused || $.model.pendingFocus !== null
        ? $.evolve({ focused: false, pendingFocus: null })
        : $.model,
    PressedKey: ($, { date, move }) => navigate($, date, move),
    SyncedMonth: ($) => {
      const context = contextOf($.props)
      const { shouldFocus, ...phase } = syncMonthPhase(
        $.model,
        context,
        weeksOfMonth(context.monthStart, context.weekStartsOn)
      )
      const date = phase.focusedDay
      if (!shouldFocus || date === null) {
        return $.evolve({ ...phase, shownMonth: context.monthStart })
      }
      // Focus the stable root before replacing the day to avoid focus
      // falling to `<body>` and marking an enclosing Field touched.
      return $.run(
        HtmlCommand.Focus.make({
          ref: CalendarRootRef,
          options: { preventScroll: true }
        }).pipe(Command.map(() => CalendarMessage.ParkedFocus({ date })))
      )
    },
    ParkedFocus: ($, { date }) =>
      $.evolve({
        focusedDay: date,
        pendingFocus: null,
        shownMonth: monthOf($.props)
      }).run(focusDay(date)),
    FoundDirection: ($, { rtl }) => $.evolve({ rtl })
  },
  subscriptions: ({ model, props }) => {
    const monthStart = monthOf(props)
    return [
      !sameMonth(monthStart, model.shownMonth) &&
      Subscription.make(
        "syncedMonth",
        [dateKey(monthStart)],
        () => Stream.make(CalendarMessage.SyncedMonth())
      ),
      model.focused && props.disabled === true && disabledWhileFocused
    ]
  },
  parts: (p, model) => {
    const props = p.props
    const disabled = props.disabled === true
    const readOnly = props.readOnly === true
    const rtl = rightToLeft(p.reads.provider, model.rtl)
    // Keep the focused day mounted until focus moves to the root.
    const context = contextOf(
      props,
      model.focused ? model.shownMonth : monthOf(props)
    )
    const { max, min, monthStart, preferred: value, today, weekStartsOn } =
      context
    const weeks = weeksOfMonth(monthStart, weekStartsOn)
    const weekdays = weekdayNames(props.locale, weekStartsOn)
    const title = formatMonthTitle(monthStart, props.locale)
    const phase = syncMonthPhase(model, context, weeks)
    const tabStop = tabStopOf(phase.focusedDay, context, weeks)
    const fullDate = fullDateFormatter(props.locale)
    const headingId = p.id("heading")
    const isSelected = (date: DateTime.Utc) =>
      value !== null && sameDay(date, value)
    const state = {
      "data-disabled": flag(disabled),
      "data-readonly": flag(readOnly)
    }

    const step = (months: -1 | 1, label: string) => {
      const stepDisabled = disabled ||
        !canStepMonth(monthStart, months, min, max)
      return p.part("button", (b) =>
        b
          .attrs({
            type: "button",
            "aria-disabled": undefined,
            "data-disabled": flag(stepDisabled)
          })
          .disabled(stepDisabled)
          .on("click", CalendarMessage.ClickedStep({ months }))
          .forward(fallbackLabel(label)))
    }

    const weekdayPart = p.part("th", (b, index: number) => {
      const weekday = Number.isInteger(index) ? weekdays[index] : undefined
      if (weekday === undefined) {
        throw new Error(
          "Calendar: weekday index must be an integer between 0 and 6, got " +
            String(index)
        )
      }
      return b.attrs({
        scope: "col",
        abbr: weekday.long
      })
    })

    const cellPart = p.part("td", (b, date: DateTime.Utc) =>
      b.attrs({
        role: "gridcell",
        "aria-selected": String(isSelected(date))
      }))

    const dayPart = p.part(
      "button",
      (b, date: DateTime.Utc, key: string, unavailable: boolean) => {
        const dayDisabled = disabled || isOutOfRange(date, min, max)
        const isToday = sameDay(date, today)
        const isFocused = !dayDisabled &&
          phase.focused &&
          phase.focusedDay !== null &&
          sameDay(date, phase.focusedDay)
        const isTabStop = !dayDisabled &&
          tabStop !== null &&
          sameDay(date, tabStop)
        return b
          .attrs({
            type: "button",
            tabindex: isTabStop ? "0" : "-1",
            "aria-label": DateTime.formatIntl(date, fullDate),
            "aria-disabled": !dayDisabled && unavailable ? "true" : undefined,
            "aria-current": isToday ? "date" : undefined,
            "data-selected": flag(isSelected(date)),
            "data-today": flag(isToday),
            "data-outside-month": flag(!sameMonth(date, monthStart)),
            "data-unavailable": flag(unavailable),
            "data-disabled": flag(dayDisabled),
            "data-focused": flag(isFocused)
          })
          .disabled(dayDisabled)
          .ref(CalendarDayRef.at(key))
          .on(
            "click",
            CalendarMessage.ClickedDay({ date, unavailable }),
            unavailable ? { preventDefault: "always" } : undefined
          )
          .on("focus", CalendarMessage.FocusedDay({ date }))
          .on("blur", CalendarMessage.BlurredDay())
          .on(
            "keydown",
            ({ alt, ctrl, key: pressed, meta, shift }) => {
              if (disabled || alt || ctrl || meta) return undefined
              const move = gridKeyOf(pressed, shift, rtl)
              return move === undefined
                ? undefined
                : CalendarMessage.PressedKey({ date, move })
            },
            { preventDefault: true }
          )
      }
    )

    return {
      weeks,
      weekdays,
      month: monthStart,
      title,
      root: p.part((b) =>
        b
          .attrs({ tabindex: "-1", ...state })
          .ref(CalendarRootRef)
          .onMount(
            TrackDirection({ css: p.reads.provider === undefined }).pipe(
              Mount.map((rtl) => CalendarMessage.FoundDirection({ rtl }))
            )
          )
      ),
      heading: p.part((b) =>
        b.attrs({
          id: headingId,
          "aria-live": "polite",
          ...state
        })
      ),
      previous: step(-1, "Previous month"),
      next: step(1, "Next month"),
      grid: p.part("table", (b) =>
        b.attrs({
          role: "grid",
          "aria-labelledby": headingId,
          "aria-disabled": disabled ? "true" : undefined,
          "aria-readonly": readOnly ? "true" : undefined,
          ...state
        })),
      weekday: View.wrapPart(
        weekdayPart,
        <B extends Keyed<"th">>(
          { element, index }: { readonly element: B; readonly index: number }
        ): ReturnType<B["attr"]> =>
          weekdayPart(element.key(String(index)), index)
      ),
      cell: View.wrapPart(
        cellPart,
        <B extends Keyed<"td">>(
          { date, element }: {
            readonly element: B
            readonly date: DateTime.DateTime
          }
        ): ReturnType<B["attr"]> => {
          const day = toDay(date)
          return cellPart(element.key(dateKey(day)), day)
        }
      ),
      day: View.wrapPart(
        dayPart,
        <B extends Keyed<"button">>(
          { date, element, unavailable }: {
            readonly element: B
            readonly date: DateTime.DateTime
            readonly unavailable?: boolean | undefined
          }
        ): ReturnType<B["attr"]> => {
          const day = toDay(date)
          const key = dateKey(day)
          return dayPart(element.key(key), day, key, unavailable === true)
        }
      )
    }
  }
})
