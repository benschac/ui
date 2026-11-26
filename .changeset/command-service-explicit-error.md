---
"@effect/ui": minor
---

`Command.Service` now requires `error`: add `error: Schema.Never` where it was omitted. A Service with `success: Component.Noop` ignores its body's result, so the body no longer needs `Effect.as(Component.noop)`.
