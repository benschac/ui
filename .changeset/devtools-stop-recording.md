---
"@effect/ui": minor
"@effect/ui-devtools": minor
---

DevTools can stop and start recording a message `_tag` while the app runs, from the overlay or the new `set_recording` MCP tool, so a burst of noisy updates can't evict the entries around it. The choice lasts for the tab and wins over `exclude`. Excluded updates now carry `excluded: true` on their `MessageLog` entry and Wire frame, so the DevTools server coalesces them the same way the overlay does.
