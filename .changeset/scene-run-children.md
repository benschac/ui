---
"@effect/ui": minor
---

Add a `run` option to `Scene.make`, `Scene.start`, `HtmlScene.make` and `HtmlScene.start`: the child components it names run in the scene instead of being leaves. `HtmlScene.make(Page, props, { run: [Counter] })` shows Counter's view against its own Model, sends a click on it to Counter's `update`, lists its mounts with the scene's so `mounted` and `expectMount` name them (and `mounted` sends the result to Counter's `update`), and delivers its events to Page through `onEmit`. A run child starts with its `init` when the view places it, and starts again after the view stops placing it. A run child reads the owners above it, and its sends are acknowledged with `sent`, since a scene doesn't run an owner's `update`. Its Subscriptions don't run. A run child that starts a Command, loads more of a query, reads queries or is passed slots fails the step. Without `run`, a child is a leaf as before.
