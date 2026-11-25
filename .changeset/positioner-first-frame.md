---
"@effect/ui-kit": patch
---

`Select`, `Menu`, `ContextMenu`, `PreviewCard`, `Combobox` and `Autocomplete` place their positioner before the browser paints, so the popup no longer shows in the top left corner for a frame when it opens.

`Select`, `Menu` and a `Combobox` with its input in the popup take focus back from the trigger on the next frame when the press that opened them focuses it.
