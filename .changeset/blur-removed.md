---
"@effect/ui": patch
---

`blur` and `focusout` payloads gain `removed`, which is `true` when a render takes the focused element out of the document. Only Chromium sends a `blur` for that.
