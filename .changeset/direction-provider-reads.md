---
"@effect/ui-kit": patch
---

Components under a `DirectionProvider` no longer watch the CSS `direction`, so mounting, focus and class changes cost no direction reads.
