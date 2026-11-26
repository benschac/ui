---
"@effect/ui-kit": patch
---

Components under a `DirectionProvider` no longer read or watch the CSS `direction`, so the provider's answer costs no style reads on mount, focus or class changes.
