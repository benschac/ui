---
"@effect/ui-kit": patch
---

`Select`, `Menu`, `ContextMenu`, `PreviewCard`, `Combobox` and `Autocomplete` place their positioner before the browser paints, so the popup no longer shows in the top left corner for a frame when it opens.

`Select`, `Menu` and a `Combobox` with its input in the popup move focus into the popup on the frame after they open, so the browser focusing the pressed trigger can't take it back.
