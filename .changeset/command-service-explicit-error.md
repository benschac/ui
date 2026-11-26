---
"@effect/ui": minor
---

`Command.Service` now requires `error` (add `error: Schema.Never` where it was omitted), and a `success: Component.Noop` Service's body may return any result, so it no longer needs `Effect.as(Component.noop)`.
