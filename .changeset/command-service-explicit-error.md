---
"@effect/ui": minor
---

`Command.Service` now requires `error`: add `error: Schema.Never` where it was omitted. A Service body may return `Component.noop` whatever its `success` is, so `success` can be the component's Message Schema with no `Schema.Union([Message, Component.Noop])`.
