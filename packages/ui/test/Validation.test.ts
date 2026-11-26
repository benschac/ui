import { Command, Component, Query, UiSchema, Validation } from "@effect/ui"
import { Story } from "@effect/ui/testing"
import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Option, Redacted, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"

const Rule = Validation.Rule

describe("Validation", () => {
  it("derives each field from its value, its rules and the other values", () => {
    const Signup = Validation.make({
      email: { required: "Email is required", rules: [Rule.email()] },
      password: {
        required: "Password is required",
        rules: [Rule.minLength(8), [
          (password) => /\d/.test(password),
          "Include a number"
        ]]
      },
      confirm: {
        required: "Confirm your password",
        rules: [[
          (confirm, values) => confirm === values.password,
          "Passwords must match"
        ]]
      },
      account: { value: Schema.Literals(["Personal", "Business"]) },
      company: {
        required: (values) =>
          values.account === "Business" && "Required for business accounts"
      },
      birthday: {
        value: Schema.NullOr(Schema.String),
        isEmpty: (birthday) => birthday === null,
        // A rule never sees an empty value, but its type still includes one.
        rules: [[
          (birthday) =>
            birthday !== null && /^\d{4}-\d{2}-\d{2}$/.test(birthday),
          (birthday) => `${birthday} isn't a date`
        ]]
      }
    })
    const state = Signup.submit(Signup.init({
      email: "ada@x",
      password: "short",
      confirm: "short",
      account: "Business",
      company: "",
      birthday: "soon"
    }))
    const { fields, value, invalid } = Signup.validate(state)
    assert.deepStrictEqual(fields, {
      email: {
        _tag: "Invalid",
        value: "ada@x",
        empty: false,
        required: true,
        errors: ["Invalid email address"]
      },
      password: {
        _tag: "Invalid",
        value: "short",
        empty: false,
        required: true,
        errors: ["Must be at least 8 characters"]
      },
      // A rule over two fields runs whether or not the other field passes.
      confirm: { _tag: "Valid", value: "short", empty: false, required: true },
      account: {
        _tag: "Valid",
        value: "Business",
        empty: false,
        required: false
      },
      company: {
        _tag: "Invalid",
        value: "",
        empty: true,
        required: true,
        errors: ["Required for business accounts"]
      },
      birthday: {
        _tag: "Invalid",
        value: "soon",
        empty: false,
        required: false,
        errors: ["soon isn't a date"]
      }
    })
    assert.isTrue(invalid)
    assert.isTrue(Option.isNone(value))

    const changed = Signup.change(
      Signup.change(state, "password", "longenough"),
      "account",
      "Personal"
    )
    const { company, confirm, password } = Signup.validate(changed).fields
    assert.deepStrictEqual(password, {
      _tag: "Invalid",
      value: "longenough",
      empty: false,
      required: true,
      errors: ["Include a number"]
    })
    assert.deepStrictEqual(confirm, {
      _tag: "Invalid",
      value: "short",
      empty: false,
      required: true,
      errors: ["Passwords must match"]
    })
    // Optional and empty: acceptable, and nothing to show.
    assert.deepStrictEqual(company, {
      _tag: "NotValidated",
      value: "",
      empty: true,
      required: false
    })
    assert.deepStrictEqual(
      Signup.validate(Signup.change(changed, "birthday", null)).fields.birthday,
      {
        _tag: "NotValidated",
        value: null,
        empty: true,
        required: false
      }
    )

    const All = Validation.make({
      password: { rules: [Rule.minLength(8), Rule.includes("1")] }
    }, { errors: "all" })
    const all = All.submit(All.init({ password: "abc" }))
    assert.deepStrictEqual(All.validate(all).fields.password, {
      _tag: "Invalid",
      value: "abc",
      empty: false,
      required: false,
      errors: ["Must be at least 8 characters", "Must contain 1"]
    })
  })

  it("treats an empty Redacted value as empty for required and skips its rules", () => {
    let called = 0
    const Login = Validation.make({
      password: {
        value: Schema.Redacted(Schema.String),
        required: "Password is required",
        rules: [[(password) => {
          called += 1
          return Redacted.value(password).length >= 8
        }, "Must be at least 8 characters"]]
      }
    })
    const result = Login.validate(
      Login.submit(Login.init({ password: Redacted.make("") }))
    )
    assert.strictEqual(called, 0)
    const { password } = result.fields
    assert.strictEqual(password._tag, "Invalid")
    if (password._tag === "Invalid") {
      assert.deepStrictEqual(password.errors, ["Password is required"])
      assert.isTrue(password.required)
    }
    assert.strictEqual(Redacted.value(password.value), "")
    assert.isTrue(Option.isNone(result.value))
  })

  it("lists every rule of a field as met or unmet, before the field shows", () => {
    const Form = Validation.make({
      password: {
        rules: [
          Rule.minLength(8, "At least 8 characters"),
          [
            (password) => !password.includes(" "),
            (password) => `No spaces in "${password}"`
          ]
        ]
      }
    })
    const at = (password: string) =>
      Form.checklist(Form.init({ password }), "password")
    assert.deepStrictEqual(at("hunter 2"), [
      { message: "At least 8 characters", met: true },
      { message: `No spaces in "hunter 2"`, met: false }
    ])
    // An empty value meets no rule, even one its predicate would pass.
    assert.deepStrictEqual(at(""), [
      { message: "At least 8 characters", met: false },
      { message: `No spaces in ""`, met: false }
    ])
    assert.strictEqual(
      Form.validate(Form.init({ password: "hunter 2" })).fields.password._tag,
      "NotValidated"
    )
  })

  it("shows a field by its mode, and every field after a submit", () => {
    const shown = (mode: Validation.Mode) => {
      const Form = Validation.make({
        a: { required: "A" },
        b: { required: "B" },
        c: { required: "C" }
      }, { mode })
      const state = Form.blur(
        Form.change(Form.init({ a: "", b: "", c: "" }), "a", ""),
        "b"
      )
      const tags = (s: typeof state) =>
        Object.values(Form.validate(s).fields).map((field) => field._tag)
      // The value is held back by fields that aren't showing yet.
      assert.isTrue(Option.isNone(Form.validate(state).value))
      return [tags(state), tags(Form.submit(state))]
    }
    const all = ["Invalid", "Invalid", "Invalid"]
    assert.deepStrictEqual(shown("onChange"), [[
      "Invalid",
      "NotValidated",
      "NotValidated"
    ], all])
    assert.deepStrictEqual(shown("onBlur"), [[
      "NotValidated",
      "Invalid",
      "NotValidated"
    ], all])
    assert.deepStrictEqual(shown("onSubmit"), [[
      "NotValidated",
      "NotValidated",
      "NotValidated"
    ], all])
  })

  it("shows a server error at once and holds the value back until its field changes", () => {
    const Login = Validation.make({
      email: { required: "Email is required" },
      password: {}
    })
    const filled = Login.init({ email: "ada@example.com", password: "secret" })
    const rejected = Login.reject({ password: ["Invalid credentials"] })(filled)
    assert.deepStrictEqual(Login.validate(rejected), {
      fields: {
        email: {
          _tag: "NotValidated",
          value: "ada@example.com",
          empty: false,
          required: true
        },
        password: {
          _tag: "Invalid",
          value: "secret",
          empty: false,
          required: false,
          errors: ["Invalid credentials"]
        }
      },
      value: Option.none(),
      invalid: true,
      validating: false
    })
    assert.isTrue(
      Login.validate(Login.change("email", "ada@example.org")(rejected)).invalid
    )
    assert.deepStrictEqual(
      Login.validate(Login.change("password", "secret2")(rejected)).value,
      Option.some({
        email: "ada@example.com",
        password: "secret2"
      })
    )
    assert.isFalse(
      Login.validate(Login.reject(rejected, { password: [] })).invalid
    )
  })

  it("reads a check once its field passes, and holds the value back until it answers", () => {
    const Account = Validation.make({
      username: { required: "Pick a username", rules: [Rule.minLength(3)] }
    }, {
      mode: "onChange"
    })
    const at = (username: string) =>
      Account.change(Account.init({ username: "" }), "username", username)
    const derive = (
      username: string,
      check: AsyncResult.AsyncResult<ReadonlyArray<string>, never>
    ) => {
      const { fields, value, validating } = Account.validate(at(username), {
        username: check
      })
      return [fields.username._tag, Option.isSome(value), validating]
    }
    assert.isFalse(Account.passes(at("ab"), "username"))
    assert.isTrue(Account.passes(at("ada"), "username"))
    // The rules fail first, so the check isn't read.
    assert.deepStrictEqual(derive("ab", AsyncResult.initial(true)), [
      "Invalid",
      false,
      false
    ])
    assert.deepStrictEqual(derive("ada", AsyncResult.initial(true)), [
      "Validating",
      false,
      true
    ])
    assert.deepStrictEqual(
      derive("ada", AsyncResult.success([], { waiting: true })),
      ["Validating", false, true]
    )
    assert.deepStrictEqual(
      derive("ada", AsyncResult.failure(Cause.die("down"))),
      ["Validating", false, true]
    )
    assert.deepStrictEqual(derive("ada", AsyncResult.success(["Taken"])), [
      "Invalid",
      false,
      false
    ])
    assert.deepStrictEqual(derive("ada", AsyncResult.success([])), [
      "Valid",
      true,
      false
    ])
  })

  it("gives the same answer each time, and keeps a regex's flags", () => {
    const Form = Validation.make({
      code: { rules: [Rule.pattern(/^a$/g)] },
      sticky: { rules: [Rule.pattern(/a/y)] }
    })
    const state = Form.submit(Form.init({ code: "a", sticky: "ba" }))
    const first = Form.validate(state)
    assert.deepStrictEqual(Form.validate(state), first)
    assert.deepStrictEqual(first.fields, {
      code: { _tag: "Valid", value: "a", empty: false, required: false },
      // A sticky pattern matches from the start only.
      sticky: {
        _tag: "Invalid",
        value: "ba",
        empty: false,
        required: false,
        errors: ["Invalid format"]
      }
    })
  })

  it("keeps its State as JSON for any field name, including ones on Object.prototype", () => {
    const fields = JSON.parse(
      `{ "constructor": {}, "__proto__": { "required": "Required" } }`
    ) as {
      readonly constructor: {}
      readonly ["__proto__"]: { readonly required: string }
    }
    const Form = Validation.make(fields)
    const values = JSON.parse(`{ "constructor": "", "__proto__": "x" }`)
    const state = Form.reject(
      Form.blur(
        Form.change(Form.init(values), "constructor", "c"),
        "constructor"
      ),
      JSON.parse(`{ "__proto__": ["Taken"] }`)
    )
    const json = JSON.parse(
      JSON.stringify(Schema.encodeSync(Form.State)(state))
    )
    const decoded = Schema.decodeUnknownSync(Form.State)(json)
    assert.deepStrictEqual(decoded, state)
    const { fields: derived } = Form.validate(decoded)
    assert.deepStrictEqual(Object.keys(derived), ["constructor", "__proto__"])
    assert.deepStrictEqual(
      Object.getOwnPropertyDescriptor(derived, "__proto__")?.value,
      {
        _tag: "Invalid",
        value: "x",
        empty: false,
        required: true,
        errors: ["Taken"]
      }
    )
    assert.deepStrictEqual(
      Object.getOwnPropertyDescriptor(decoded.values, "__proto__")?.value,
      "x"
    )
  })

  describe("in a component", () => {
    class IsUsernameTaken extends Query.Service<IsUsernameTaken>()(
      "accounts/IsUsernameTaken",
      {
        args: { username: Schema.String },
        success: Schema.Boolean,
        error: Schema.Never,
        staleTime: "30 seconds"
      }
    ) {}
    const Message = UiSchema.TaggedEnum({
      UpdatedUsername: { value: Schema.String },
      ClickedSubmit: {},
      CreatedAccount: {}
    })
    class CreateAccount extends Command.Service<CreateAccount>()(
      "accounts/CreateAccount",
      {
        args: { username: Schema.String },
        success: Message,
        error: Schema.Never
      }
    ) {}
    const Account = Validation.make({
      username: { required: "Pick a username", rules: [Rule.minLength(3)] }
    }, {
      mode: "onChange"
    })
    const taken = (result: AsyncResult.AsyncResult<boolean>) =>
      AsyncResult.map(
        result,
        (taken) => taken ? ["That username is taken"] : []
      )
    const SignupPage = Component.define({
      name: "SignupPage",
      model: Schema.Struct({ form: Account.State }),
      message: Message,
      queries: {
        taken: {
          query: IsUsernameTaken,
          debounce: "300 millis",
          args: ({ model }) =>
            Account.passes(model.form, "username")
              ? { username: model.form.values.username }
              : undefined
        }
      }
    }).make({
      init: () => ({ form: Account.init({ username: "" }) }),
      update: {
        UpdatedUsername: ($, { value }) => ({
          form: Account.change($.model.form, "username", value)
        }),
        ClickedSubmit: ($) => {
          const form = Account.submit($.model.form)
          return Option.match(
            Account.validate(form, { username: taken($.queries.taken) }).value,
            {
              onNone: () => ({ form }),
              onSome: ({ username }) =>
                $.set({ form }).run(CreateAccount.make({ username }))
            }
          )
        },
        CreatedAccount: ($) => $.model
      },
      view: (h, model) => h.el("p", model.form.values.username)
    })

    it.effect("drops a stale answer and submits once the check passes", () =>
      Effect.gen(function*() {
        const story = yield* Story.make(SignupPage, {})
        const username = () =>
          Account.validate(story.model.form, {
            username: taken(story.queries.taken)
          })
            .fields.username
        story.send(Message.UpdatedUsername({ value: "ada" }))
        assert.strictEqual(username()._tag, "Validating")
        story.loaded("taken", true)
        assert.deepStrictEqual(username(), {
          _tag: "Invalid",
          value: "ada",
          empty: false,
          required: true,
          errors: ["That username is taken"]
        })
        // The answer for "ada" isn't shown for "grace".
        story.send(Message.UpdatedUsername({ value: "grace" }))
        assert.strictEqual(username()._tag, "Validating")
        // A submit while the check is out issues nothing.
        story.keepPending("taken").send(Message.ClickedSubmit())
        story.loaded("taken", false)
        assert.strictEqual(username()._tag, "Valid")
        story.send(Message.ClickedSubmit())
          .expectExact(CreateAccount.make({ username: "grace" }))
          .resolve(CreateAccount, Message.CreatedAccount())
      }))
  })
})
