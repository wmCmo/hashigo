# GradeBar

Two equal halves pinned under the card. Left is always "forgot". Right moves the card on: "next · N more" while sides are still hidden, then the `primary` "remembered" once everything is shown.

**You provide** `remaining` (hidden steps left), `onForgot`, `onNext`, `onRemembered`, and `keys` to show f / space / j hints.

- Keep the left/right order fixed on every card. A grade button that moves causes mis-taps.
- "forgot" is never `danger`. Forgetting is part of studying, so it gets no alarm colour.
