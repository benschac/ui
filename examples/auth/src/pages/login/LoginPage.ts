import { Session } from "#domain/Session"
import { Command, Component, UiSchema, Validation } from "@effect/ui"
import { Button, Field, fieldValidationProps, Input } from "@effect/ui-kit"
import { Html } from "@effect/ui/html"
import { Duration, Effect, Option, Redacted, Schema } from "effect"
import { AppRoute, LoggedOutRoute } from "../../routes.ts"

const Rule = Validation.Rule

export const LoginValidation = Validation.make({
  email: {
    required: "Email is required",
    rules: [Rule.email("Please enter a valid email")]
  },
  password: {
    value: Schema.Redacted(Schema.String),
    required: "Password is required"
  }
}, { mode: "onChange" })

export const LoginPageMessage = UiSchema.TaggedEnum({
  ChangedEmail: { value: Schema.String },
  ChangedPassword: { value: Schema.Redacted(Schema.String) },
  SubmittedForm: {},
  SucceededSimulateAuthRequest: { session: Session },
  FailedSimulateAuthRequest: { error: Schema.String }
})
export type LoginPageMessage = typeof LoginPageMessage.Type

export const LoginPageEvents = UiSchema.TaggedEnum({
  SignedIn: { session: Session }
})

export class SimulateAuthRequest extends Command.Service<SimulateAuthRequest>()(
  "auth/SimulateAuthRequest",
  {
    args: { email: Schema.String, password: Schema.Redacted(Schema.String) },
    success: LoginPageMessage,
    error: Schema.Never
  }
) {
  static readonly layer = this.toLayer(
    Effect.fn("auth/SimulateAuthRequest")(function*({ email, password }) {
      yield* Effect.sleep(Duration.seconds(1))
      if (Redacted.value(password) !== "password") {
        return LoginPageMessage.FailedSimulateAuthRequest({
          error: "Invalid credentials"
        })
      }
      const [name] = email.split("@")
      return LoginPageMessage.SucceededSimulateAuthRequest({
        session: { userId: "1", email, name: name === "" ? email : name }
      })
    })
  )
}

const FormField = <M>(h: Html.H<M>, options: {
  readonly key: string
  readonly label: string
  readonly type: "email" | "password"
  readonly placeholder: string
  readonly state: Validation.Field<unknown>
  readonly value: string
  readonly disabled: boolean
  readonly onUpdate: (value: string) => M
}) => {
  const { state } = options
  return Field(h, {
    key: options.key,
    props: { ...fieldValidationProps(state), disabled: options.disabled },
    view: (field) =>
      field.root(h.div).children(
        h.div.class("flex items-center gap-2 mb-1").children(
          field.label(h.label).class("block text-sm font-medium text-gray-700")
            .children(options.label),
          state._tag === "Valid" &&
            h.span.class("text-green-600 text-sm").children("✓")
        ),
        Input(h, {
          element: field.control(h.input),
          props: { value: options.value },
          onUpdate: ({ value }) => options.onUpdate(value)
        })
          .attr("type", options.type)
          .attr("placeholder", options.placeholder)
          .class(
            "w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500",
            "disabled:bg-gray-100 data-valid:border-green-500 data-invalid:border-red-500"
          ),
        state._tag === "Invalid" &&
          field.error(h.div)?.class("text-red-600 text-sm mt-1").children(
            state.errors[0]
          )
      )
  })
}

export const LoginPageNoDeps = Html.component({
  name: "LoginPage",

  model: Schema.Struct({
    form: LoginValidation.State,
    submitting: Schema.Boolean
  }),

  message: LoginPageMessage,
  events: LoginPageEvents,
  restore: false
}).make({
  init: () => ({
    form: LoginValidation.init({ email: "", password: Redacted.make("") }),
    submitting: false
  }),

  update: {
    ChangedEmail: ($, { value }) =>
      $.evolve({
        form: (form) => LoginValidation.change(form, "email", value)
      }),

    ChangedPassword: ($, { value }) =>
      $.evolve({
        form: (form) => LoginValidation.change(form, "password", value)
      }),

    SubmittedForm: ($) => {
      if ($.model.submitting) return $.model
      const form = LoginValidation.submit($.model.form)
      return Option.match(LoginValidation.validate(form).value, {
        onNone: () => $.evolve({ form }),
        onSome: ({ email, password }) =>
          $.evolve({ form, submitting: true }).run(
            SimulateAuthRequest.make({ email, password })
          )
      })
    },

    SucceededSimulateAuthRequest: ($, { session }) =>
      $.emit(LoginPageEvents.SignedIn({ session })),

    FailedSimulateAuthRequest: ($, { error }) =>
      $.evolve({
        submitting: false,
        form: (form) => LoginValidation.reject(form, { password: [error] })
      })
  },

  view: (h, model) => {
    const validated = LoginValidation.validate(model.form)
    const canSubmit = Option.isSome(validated.value) && !model.submitting
    return h.div.class("max-w-md mx-auto px-4").children(
      h.div.class("bg-white rounded-xl shadow-lg p-8").children(
        h.h1.class("text-3xl font-bold text-gray-800 text-center mb-8")
          .children("Sign In"),
        h.div.class("mb-6 p-3 bg-blue-50 border border-blue-200 rounded-lg")
          .children(
            h.p.class("text-sm text-blue-700").children(
              "Hint: Use any email with password \"password\""
            )
          ),
        h.form.attr("aria-label", "Sign in").attr("novalidate", "").class(
          "space-y-6"
        )
          .on("submit", LoginPageMessage.SubmittedForm()).children(
            FormField(h, {
              key: "email",
              label: "Email",
              type: "email",
              placeholder: "you@example.com",
              state: validated.fields.email,
              value: validated.fields.email.value,
              disabled: model.submitting,
              onUpdate: (value) => LoginPageMessage.ChangedEmail({ value })
            }),
            FormField(h, {
              key: "password",
              label: "Password",
              type: "password",
              placeholder: "Enter your password",
              state: validated.fields.password,
              value: Redacted.value(validated.fields.password.value),
              disabled: model.submitting,
              onUpdate: (value) =>
                LoginPageMessage.ChangedPassword({
                  value: Redacted.make(value)
                })
            }),
            Button(h, { props: { type: "submit", disabled: !canSubmit } })
              .class(
                "w-full py-3 font-medium rounded-lg transition bg-blue-500 text-white cursor-pointer",
                "enabled:hover:bg-blue-600 disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed"
              )
              .children(model.submitting ? "Signing in..." : "Sign In")
          ),
        h.div.class("mt-6 text-center").children(
          h.span.class("text-gray-600").children("Back to "),
          h.a.attr("href", AppRoute.print(LoggedOutRoute.Home())).class(
            "text-blue-500 hover:underline"
          ).children(
            "Home"
          )
        )
      )
    )
  }
})

export const LoginPage = LoginPageNoDeps.pipe(
  Component.provide(SimulateAuthRequest.layer)
)
