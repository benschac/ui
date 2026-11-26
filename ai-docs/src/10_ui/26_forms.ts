/**
 * @title Validating forms
 *
 * Validate a sign-up form with `Validation`: rules on each field, a rule
 * that reads another field, a username check run by a debounced query, and
 * an error from the server. A story and a scene read each field's state.
 */
import { Command, Query, UiSchema, Validation } from "@effect/ui"
import { Html } from "@effect/ui/html"
import { HtmlLocator, HtmlScene } from "@effect/ui/html/testing"
import { Story } from "@effect/ui/testing"
import { Context, Effect, Equal, Option, Redacted, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"

// ---------------------------------------------------------------------------
// The service the form calls
// ---------------------------------------------------------------------------

export class SignupRejected
  extends Schema.TaggedError<SignupRejected>()("SignupRejected", {
    field: Schema.Literals(["username", "email"]),
    message: Schema.String
  })
{}

export interface NewAccount {
  readonly username: string
  readonly email: string
  readonly password: Redacted.Redacted<string>
}

// The app's own API. Its Layer calls the server and is provided where the
// form is mounted, as `Notes.layerHttp` is for the notes app.
export class Accounts extends Context.Service<Accounts, {
  isTaken(username: string): Effect.Effect<boolean>
  create(account: NewAccount): Effect.Effect<void, SignupRejected>
}>()("app/Accounts") {}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

// Each field lists its rules. A field holds a string unless it names
// another Schema in `value`, such as `{ value: Schema.Boolean }` for a
// checkbox. An empty field shows its `required` message, or passes when it
// has none, and its rules only see a value that isn't empty. A rule is a
// predicate and a message, and `Validation.Rule` has the common ones.
//
// The mode decides when a field starts showing its result: here once it was
// edited. Every field shows once a submit was tried. By default each field
// stops at its first failing rule; `errors: "all"` collects every failing
// rule.
const Rule = Validation.Rule

export const SignupValidation = Validation.make({
  username: {
    required: "Pick a username",
    rules: [
      Rule.minLength(3),
      Rule.pattern(/^[a-z0-9_]+$/, "Use lowercase letters, digits and _")
    ]
  },
  email: {
    required: "Email is required",
    rules: [Rule.email("Please enter a valid email address")]
  },
  // A secret is `Schema.Redacted(Schema.String)`. That keeps this
  // component's whole state out of `history.state` and the server's page
  // state, so no field of the form restores or hydrates: keep such a form a
  // leaf component. To keep a secret out of history only, use a plain string
  // and clear it in the component's `restore`. `required` still sees an
  // empty one, and a rule unwraps it with `Redacted.value`.
  password: {
    value: Schema.Redacted(Schema.String),
    required: "Password is required",
    rules: [[
      (password) => Redacted.value(password).length >= 8,
      "Must be at least 8 characters"
    ]]
  },
  // A predicate also gets every value, so it can compare two fields. It
  // runs whether or not the password passes its own rules. Two `Redacted`
  // compare by what they hold, so nothing is unwrapped.
  confirm: {
    value: Schema.Redacted(Schema.String),
    required: "Confirm your password",
    rules: [[
      (confirm, values) => Equal.equals(confirm, values.password),
      "Passwords must match"
    ]]
  }
}, { mode: "onChange", errors: "all" })

// ---------------------------------------------------------------------------
// The username check and the submit
// ---------------------------------------------------------------------------

// "Is this username taken" is a read, so it is a query. A check passed to
// `validate` can't fail. A request that fails here would be a defect, and
// the server checks the username again when the account is created.
export class IsUsernameTaken extends Query.Service<IsUsernameTaken>()(
  "accounts/IsUsernameTaken",
  {
    args: { username: Schema.String },
    success: Schema.Boolean,
    error: Schema.Never,
    staleTime: "30 seconds"
  }
) {
  static readonly layer = this.toLayer(
    Effect.gen(function*() {
      const accounts = yield* Accounts
      return ({ username }) => accounts.isTaken(username)
    })
  )
}

const TextFieldName = Schema.Literals(["username", "email"])
const SecretFieldName = Schema.Literals(["password", "confirm"])

// Secret inputs carry `Schema.Redacted(Schema.String)` in their message and
// Command args too, so a devtools message log never receives a password in
// plain text.
export const SignupFormMessage = UiSchema.TaggedEnum({
  UpdatedField: { name: TextFieldName, value: Schema.String },
  UpdatedSecret: {
    name: SecretFieldName,
    value: Schema.Redacted(Schema.String)
  },
  SubmittedForm: {},
  SucceededCreateAccount: {},
  FailedCreateAccount: {
    field: SignupRejected.fields.field,
    message: Schema.String
  }
})

export const SignupFormEvents = UiSchema.TaggedEnum({
  SignedUp: { username: Schema.String }
})

export class CreateAccount extends Command.Service<CreateAccount>()(
  "accounts/CreateAccount",
  {
    args: {
      username: Schema.String,
      email: Schema.String,
      password: Schema.Redacted(Schema.String)
    },
    success: SignupFormMessage,
    error: Schema.Never
  }
) {
  static readonly layer = this.toLayer(
    Effect.gen(function*() {
      const accounts = yield* Accounts
      return (account) =>
        accounts.create(account).pipe(
          Effect.match({
            onSuccess: () => SignupFormMessage.SucceededCreateAccount(),
            onFailure: ({ field, message }) =>
              SignupFormMessage.FailedCreateAccount({ field, message })
          })
        )
    })
  )
}

// The form's fields, derived. The view, `update` and the tests all call it,
// so they agree on what the form shows. The query's answer becomes the
// username's errors. While it is loading, the username is `Validating` and
// `value` is `None`, so a submit waits for it. A query keeps its result per
// args, so an answer about an earlier username is never shown for this one.
export const validateSignup = (
  form: typeof SignupValidation.State.Type,
  usernameTaken: AsyncResult.AsyncResult<boolean>
) =>
  SignupValidation.validate(form, {
    username: AsyncResult.map(usernameTaken, (isTaken) =>
      isTaken ? ["That username is taken"] : [])
  })

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

// The Model holds `SignupValidation.State`: the values as typed, which
// fields were edited, whether a submit was tried and the server's errors.
// It never holds an error the rules produce. Those are derived each time.
export const SignupForm = Html.component({
  name: "SignupForm",

  model: Schema.Struct({
    form: SignupValidation.State,
    submitting: Schema.Boolean
  }),

  message: SignupFormMessage,
  events: SignupFormEvents,

  queries: {
    usernameTaken: {
      query: IsUsernameTaken,
      debounce: "300 millis",
      // Ask only about a username that passes its own rules. `undefined`
      // disables the query, so "ad" is never sent to the server.
      args: ({ model }) =>
        SignupValidation.passes(model.form, "username")
          ? { username: model.form.values.username }
          : undefined
    }
  }
}).make({
  init: () => ({
    form: SignupValidation.init({
      username: "",
      email: "",
      password: Redacted.make(""),
      confirm: Redacted.make("")
    }),
    submitting: false
  }),
  update: {
    // `change` sets the value, marks the field edited and drops the
    // server's error for it.
    // While the account is being created the inputs are disabled, and an
    // edit that still arrives is dropped, so the result always belongs to
    // the values that were sent.
    UpdatedField: ($, { name, value }) =>
      $.model.submitting
        ? $.model
        : $.evolve({
          form: (form) => SignupValidation.change(form, name, value)
        }),
    UpdatedSecret: ($, { name, value }) =>
      $.model.submitting
        ? $.model
        : $.evolve({
          form: (form) => SignupValidation.change(form, name, value)
        }),
    // A tried submit shows every field. `value` is `Some` only when every
    // field passes, so it gates the Command.
    SubmittedForm: ($) => {
      const form = SignupValidation.submit($.model.form)
      return Option.match(validateSignup(form, $.queries.usernameTaken).value, {
        onNone: () => $.evolve({ form }),
        onSome: ({ confirm: _, ...account }) =>
          $.model.submitting
            ? $.model
            : $.set({ form, submitting: true }).run(CreateAccount.make(account))
      })
    },
    SucceededCreateAccount: ($) =>
      $.evolve({ submitting: false }).emit(
        SignupFormEvents.SignedUp({ username: $.model.form.values.username })
      ),
    // The server's error sits on its field until that field changes.
    FailedCreateAccount: ($, { field, message }) => ({
      submitting: false,
      form: SignupValidation.reject(
        $.model.form,
        field === "email" ? { email: [message] } : { username: [message] }
      )
    })
  },
  view: (h, model) => {
    const { fields } = validateSignup(model.form, h.queries.usernameTaken)

    // One field's markup, by its derived state. With ui-kit's `Field`,
    // spread `fieldValidationProps(field)` into `props` for `invalid` and
    // `filled`.
    const row = (
      field: Validation.Field<unknown>,
      label: string,
      type: string,
      value: string,
      onInput: (value: string) => typeof SignupFormMessage.Type
    ) =>
      h.div.children(
        h.label.children(
          label,
          h.input.attrs({
            type,
            "aria-invalid": field._tag === "Invalid" ? "true" : undefined,
            "aria-required": field.required ? "true" : undefined
          })
            .value(value)
            .disabled(model.submitting)
            .on("input", ({ value }) => onInput(value))
        ),
        field._tag === "Validating" ? h.span.children("Checking…") : null,
        field._tag === "Invalid"
          ? h.ul.attr("role", "alert").children(
            field.errors.map((error) => h.li.children(error))
          )
          : null
      )

    const text = (
      name: typeof TextFieldName.Type,
      label: string,
      type: string
    ) =>
      row(
        fields[name],
        label,
        type,
        fields[name].value,
        (value) => SignupFormMessage.UpdatedField({ name, value })
      )

    // A secret is unwrapped only for the input, and what was typed is
    // wrapped again before it leaves the view.
    const secret = (name: typeof SecretFieldName.Type, label: string) =>
      row(
        fields[name],
        label,
        "password",
        Redacted.value(fields[name].value),
        (value) =>
          SignupFormMessage.UpdatedSecret({ name, value: Redacted.make(value) })
      )

    // `novalidate` turns the browser's own checks off. The rules above are
    // the only ones, and they run the same in a test and on the server.
    return h.form.attr("novalidate", "").on(
      "submit",
      SignupFormMessage.SubmittedForm()
    ).children(
      text("username", "Username", "text"),
      text("email", "Email", "email"),
      secret("password", "Password"),
      secret("confirm", "Confirm password"),
      h.button.attr("type", "submit").disabled(model.submitting)
        .children(model.submitting ? "Creating account…" : "Create account")
    )
  }
})

// ---------------------------------------------------------------------------
// A story reads each field's state
// ---------------------------------------------------------------------------

// The errors aren't in the Model, so a story reads them through
// `validateSignup`, with the query's result from `s.queries`.
export const checkedUsername = Effect.gen(function*() {
  const s = yield* Story.make(SignupForm, {})
  const username = () =>
    validateSignup(s.model.form, s.queries.usernameTaken).fields.username

  s.send(SignupFormMessage.UpdatedField({ name: "username", value: "ad" }))
  // { _tag: "Invalid", errors: ["Must be at least 3 characters"], ... }, and the query is disabled.
  s.send(SignupFormMessage.UpdatedField({ name: "username", value: "ada" }))
  // "Validating" until the query answers.
  s.loaded("usernameTaken", true)
  // { _tag: "Invalid", errors: ["That username is taken"], ... }
  s.send(SignupFormMessage.UpdatedField({ name: "username", value: "ada_l" }))
  // "Validating" again: the answer for "ada" isn't shown for "ada_l".
  s.loaded("usernameTaken", false)
  return username()._tag // "Valid"
})

// The server's error lands on its field, and editing the field clears it.
export const rejectedEmail = Effect.gen(function*() {
  const s = yield* Story.make(SignupForm, {})
  const account = {
    username: "ada_l",
    email: "ada@example.com",
    password: Redacted.make("correct horse")
  }
  s.send(
    SignupFormMessage.UpdatedField({
      name: "username",
      value: account.username
    })
  )
    .loaded("usernameTaken", false)
    .send(
      SignupFormMessage.UpdatedField({ name: "email", value: account.email })
    )
    .send(
      SignupFormMessage.UpdatedSecret({
        name: "password",
        value: account.password
      })
    )
    .send(
      SignupFormMessage.UpdatedSecret({
        name: "confirm",
        value: account.password
      })
    )
    .send(SignupFormMessage.SubmittedForm())
    .expectExact(CreateAccount)
    // An edit that arrives while the account is being created is dropped.
    .keepPending(CreateAccount)
    .send(
      SignupFormMessage.UpdatedField({
        name: "email",
        value: "grace@example.com"
      })
    )
    .resolve(
      CreateAccount,
      SignupFormMessage.FailedCreateAccount({
        field: "email",
        message: "That email already has an account"
      })
    )
  const before =
    validateSignup(s.model.form, s.queries.usernameTaken).fields.email
  s.send(
    SignupFormMessage.UpdatedField({ name: "email", value: "ada@example.org" })
  )
  const after =
    validateSignup(s.model.form, s.queries.usernameTaken).fields.email
  return [before._tag, after._tag] // ["Invalid", "Valid"]
})

// ---------------------------------------------------------------------------
// A scene types into the inputs
// ---------------------------------------------------------------------------

// A password input has no role, so the scene finds it by its label.
export const typedConfirm = Effect.gen(function*() {
  const confirm = HtmlLocator.label("Confirm password")
  const s = yield* HtmlScene.make(SignupForm, {})
  s.type(HtmlLocator.label("Password", { exact: true }), "correct horse")
    .type(confirm, "correct hors")
    .expect(HtmlLocator.role("alert")).toHaveText("Passwords must match")
    .type(confirm, "correct horse")
    .expect(HtmlLocator.role("alert")).toBeAbsent()
})
