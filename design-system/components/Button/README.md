# Button

A 52px pill with a lowercase `button` label. `primary` is an `ink` fill with `card` text; `secondary` (the default) a `sunk` fill with `ink` text; `ghost` is text only in `ink-2`; `danger` is `danger` text for destructive actions.

**You provide** the label as children, `onClick`, and optionally `variant`, `block` (full width) and `kbd` (a keyboard hint, hidden on touch-only devices).

- One `primary` per screen at most. It is never ruri.
- Labels are lowercase verbs or past participles: "remembered", "forgot", "delete card".
- `danger` always says what it destroys.
