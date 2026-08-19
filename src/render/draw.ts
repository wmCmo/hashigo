/**
 * Stage 4 — the `<draw>` widget: kanji writing practice on a canvas.
 *
 * The corpus authors it once, in the 漢字 template, verbatim:
 *
 *     <draw height="400px" brushColor="#FF0000" brushRadius="4"/>
 *
 * and once more by hand on card 7U1FyQB6 with `height="200px"`. It is side 2 of
 * four: side 1 is the kanji, side 2 is this canvas, side 3 the reading, side 4
 * the meaning. So it is the same produce-then-verify shape as the audio — he
 * writes the character from memory BEFORE the reading appears — and it is the
 * reason `nodes.ts` emits a bare `<canvas>` and nothing else: a drawing surface
 * has to be sized to `devicePixelRatio` by code that knows the device, or every
 * stroke is drawn at half resolution and blurs.
 *
 * POINTER EVENTS, NOT MOUSE EVENTS. He studies on an Android phone. `mousedown`
 * is synthesised there only after a ~300 ms tap-hold heuristic, and never for a
 * second finger, so a mouse-event canvas drops the beginning of every stroke.
 * `pointerdown`/`pointermove`/`pointerup` are one code path for finger, stylus
 * and mouse. Two things that go with them and are easy to forget:
 *
 *   * `touch-action: none` on the element, or the browser claims the gesture and
 *     SCROLLS THE CARD instead of drawing. Set here, at attach time, because it
 *     is behaviour rather than styling.
 *   * `setPointerCapture`, so a stroke that leaves the canvas keeps arriving
 *     instead of ending mid-character.
 *
 * STROKES ARE NOT PERSISTED, AND THAT IS DELIBERATE. They live in this handle,
 * in memory, and die with the mount — nothing is written to the database, to
 * OPFS or to `localStorage`. Three reasons: he checks the character against the
 * answer side and moves on, so there is no second reader; a stroke history is a
 * record of a failure he never revisits; and every blob in this project is
 * content-addressed and refcounted, so writing one per attempt would grow the
 * store by ~1,660 rows per pass over the 漢字 deck for nothing. What the array
 * IS for is `undo()`, `clear()` and `resize()` — a canvas backing store is
 * cleared by any resize, so the strokes have to be replayable or a rotation
 * erases half a character.
 */

import type { WidgetMount } from "./nodes.js";

// ─── the port ────────────────────────────────────────────────────────────────

/**
 * The 2D context, cut down to the eight members a brush needs.
 *
 * `strokeStyle: string | object` rather than `string` because the platform's is
 * `string | CanvasGradient | CanvasPattern`, and a mutable property has to be
 * wide enough for the real one to satisfy it. `test/japanese-render.test.ts`
 * pins the whole port against the real `CanvasRenderingContext2D` with a
 * type-only assignment, the way `render.test.ts` pins `RenderDocument` against
 * `Document`.
 */
export interface DrawContext {
  lineWidth: number;
  strokeStyle: string | object;
  lineCap: string;
  lineJoin: string;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}

export interface DrawRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A pointer event, cut down. `PointerEvent` satisfies it. */
export interface DrawPointerEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;
  readonly clientX: number;
  readonly clientY: number;
  preventDefault(): void;
}

export interface DrawListenerOptions {
  readonly passive?: boolean;
  readonly capture?: boolean;
}

/** The canvas element, cut down. `HTMLCanvasElement` satisfies it. */
export interface DrawSurface {
  /** The BACKING STORE size, in device pixels. Not the CSS size. */
  width: number;
  height: number;
  readonly style: { touchAction: string; height: string; width: string };
  setAttribute(name: string, value: string): void;
  getContext(id: "2d"): DrawContext | null;
  getBoundingClientRect(): DrawRect;
  addEventListener(
    type: string,
    listener: (event: DrawPointerEvent) => void,
    options?: DrawListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: DrawPointerEvent) => void,
    options?: DrawListenerOptions,
  ): void;
  setPointerCapture(pointerId: number): void;
  releasePointerCapture(pointerId: number): void;
}

// ─── the authored options ────────────────────────────────────────────────────

export interface DrawSettings {
  /** CSS height, as authored: `400px`. */
  readonly height: string;
  readonly brushColor: string;
  /** A RADIUS, so the stroke is twice this wide. */
  readonly brushRadius: number;
}

/**
 * Defaults for a `<draw/>` with no attributes — 0 of the corpus's 1,663 uses, so
 * these are reached only by something authored later. The colour and radius are
 * the ones both real uses carry; the height is the only invented figure here,
 * and it is invented because a canvas with no height is 150 px of nothing.
 */
export const DRAW_DEFAULTS: DrawSettings = {
  height: "300px",
  brushColor: "#FF0000",
  brushRadius: 4,
};

/**
 * Read `WidgetMount.attributes` — the SANITISED, authored spelling
 * (`brushColor`, not `brushcolor`) — into settings.
 *
 * The sanitiser has already refused anything that is not a length, a colour
 * keyword/hex or a 1-3 digit number (`isValidWidgetValue`), and dropped it with
 * an `attribute-dropped` diagnostic, so an absent key here means "refused or
 * never authored" and the default is the right answer either way.
 */
export function drawSettings(attributes: Readonly<Record<string, string>> = {}): DrawSettings {
  const height = attributes["height"];
  const brushColor = attributes["brushColor"] ?? attributes["brushcolor"];
  const radius = Number.parseInt(attributes["brushRadius"] ?? attributes["brushradius"] ?? "", 10);
  return {
    height: height === undefined || height === "" ? DRAW_DEFAULTS.height : cssLength(height),
    brushColor:
      brushColor === undefined || brushColor === "" ? DRAW_DEFAULTS.brushColor : brushColor,
    brushRadius: Number.isFinite(radius) && radius > 0 ? radius : DRAW_DEFAULTS.brushRadius,
  };
}

/** `400` -> `400px`; `400px`, `50%`, `30vh` pass through. */
function cssLength(value: string): string {
  return /^\d+$/.test(value) ? `${value}px` : value;
}

// ─── strokes ─────────────────────────────────────────────────────────────────

export interface DrawPoint {
  readonly x: number;
  readonly y: number;
}

export interface DrawStroke {
  readonly pointerType: string;
  readonly points: readonly DrawPoint[];
}

export interface DrawOptions {
  /** `WidgetMount.attributes`, or a hand-built equivalent. */
  readonly attributes?: Readonly<Record<string, string>>;
  /** Device pixel ratio. Defaults to the platform's, or 1 off the main thread. */
  readonly devicePixelRatio?: number;
  /** Called after every completed stroke, and after `undo`/`clear`. */
  readonly onChange?: (strokes: readonly DrawStroke[]) => void;
}

export interface DrawHandle {
  readonly settings: DrawSettings;
  /** Completed strokes plus the one in progress, oldest first. */
  readonly strokes: readonly DrawStroke[];
  /** True between `pointerdown` and `pointerup`/`pointercancel`. */
  readonly drawing: boolean;
  /** Re-measure the element, re-size the backing store, replay every stroke. */
  resize(): void;
  /** Drop the last stroke and repaint. */
  undo(): boolean;
  clear(): void;
  /** Remove every listener. The strokes are dropped with the handle. */
  detach(): void;
}

/** Attributes this module owns, for CSS and for tests. */
export const DRAW_DATA = {
  /** Number of completed strokes. Updated as he draws. */
  strokes: "data-strokes",
} as const;

/**
 * Make a rendered `<canvas>` drawable.
 *
 * `mount` is a `WidgetMount` from the render result (`name === "draw"`);
 * `surface` is the same element, which the caller narrows — the renderer's
 * element type is the DOM port's, and `getContext` is not part of that port on
 * purpose. In a browser: `attachDraw(mount, mount.element as HTMLCanvasElement)`.
 */
export function attachDraw(
  mount: Pick<WidgetMount, "attributes"> | null,
  surface: DrawSurface,
  options: DrawOptions = {},
): DrawHandle {
  const settings = drawSettings(options.attributes ?? mount?.attributes ?? {});
  const context = surface.getContext("2d");
  const strokes: DrawStroke[] = [];
  let current: DrawPoint[] | null = null;
  let currentType = "";
  let activePointer: number | null = null;
  let ratio = pixelRatio(options.devicePixelRatio);

  // Behaviour, not styling: without `touch-action: none` the browser treats the
  // first finger movement as a scroll and the stroke never arrives.
  surface.style.touchAction = "none";
  surface.style.height = settings.height;
  surface.style.width = "100%";

  function pointOf(event: DrawPointerEvent): DrawPoint {
    const rect = surface.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function paint(points: readonly DrawPoint[], from: number): void {
    if (context === null) return;
    const start = points[from];
    if (start === undefined) return;
    context.beginPath();
    context.moveTo(start.x, start.y);
    if (points.length === 1) {
      // A tap is a dot — 点 exists as a stroke, and a round cap makes it round.
      context.lineTo(start.x, start.y);
    } else {
      for (let at = from + 1; at < points.length; at += 1) {
        const point = points[at];
        if (point !== undefined) context.lineTo(point.x, point.y);
      }
    }
    context.stroke();
  }

  function repaint(): void {
    if (context === null) return;
    context.clearRect(0, 0, surface.width / ratio, surface.height / ratio);
    for (const stroke of strokes) paint(stroke.points, 0);
    if (current !== null) paint(current, 0);
  }

  function brush(): void {
    if (context === null) return;
    // `brushRadius` names a radius, so the stroke is twice as wide. Round cap and
    // join, or a change of direction inside a character shows a chipped corner.
    context.lineWidth = settings.brushRadius * 2;
    context.strokeStyle = settings.brushColor;
    context.lineCap = "round";
    context.lineJoin = "round";
  }

  /**
   * Measure, size the backing store, restore the brush, replay.
   *
   * `getBoundingClientRect` is the BORDER box. Measured in Chrome: a canvas with
   * `height: 400px` and a 1 px border reports 402, so the backing store comes out
   * 402 device pixels tall for 400 px of content — a 0.5% vertical stretch of
   * every stroke. Give the canvas no border and no padding (draw the frame on a
   * wrapper instead) and the two agree exactly. Not corrected here on purpose:
   * `clientHeight` would round to whole pixels and lose sub-pixel accuracy on the
   * far more common bare canvas, which is the worse trade.
   */
  function resize(): void {
    ratio = pixelRatio(options.devicePixelRatio);
    const rect = surface.getBoundingClientRect();
    surface.width = Math.max(1, Math.round(rect.width * ratio));
    surface.height = Math.max(1, Math.round(rect.height * ratio));
    if (context !== null) {
      // One unit of drawing = one CSS pixel, on any display. Everything above
      // this line works in CSS pixels and never has to know the ratio.
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      brush();
    }
    repaint();
  }

  function countStrokes(): void {
    surface.setAttribute(DRAW_DATA.strokes, String(strokes.length));
    options.onChange?.(strokes);
  }

  /**
   * Pointer capture, defensively. Chrome throws `NotFoundError` when the id is
   * no longer active — which happens for real on `pointercancel`, and losing the
   * stroke to an exception would be worse than losing the capture.
   */
  function capture(claim: boolean, pointerId: number): void {
    try {
      if (claim) surface.setPointerCapture(pointerId);
      else surface.releasePointerCapture(pointerId);
    } catch {
      /* the pointer is already gone; nothing to hold */
    }
  }

  const onDown = (event: DrawPointerEvent): void => {
    // A second finger during a stroke is a palm or a pinch, never a brush.
    if (activePointer !== null || event.isPrimary === false) return;
    event.preventDefault();
    activePointer = event.pointerId;
    currentType = event.pointerType;
    current = [pointOf(event)];
    capture(true, event.pointerId);
    brush();
    paint(current, 0);
  };

  const onMove = (event: DrawPointerEvent): void => {
    if (current === null || event.pointerId !== activePointer) return;
    event.preventDefault();
    const from = current.length - 1;
    current.push(pointOf(event));
    paint(current, from);
  };

  const onUp = (event: DrawPointerEvent): void => {
    if (current === null || event.pointerId !== activePointer) return;
    strokes.push({ pointerType: currentType, points: current });
    current = null;
    activePointer = null;
    capture(false, event.pointerId);
    countStrokes();
  };

  // `{ passive: false }` explicitly: a passive listener may not call
  // preventDefault, and Chrome defaults touch listeners to passive.
  const listeners: readonly [string, (event: DrawPointerEvent) => void][] = [
    ["pointerdown", onDown],
    ["pointermove", onMove],
    ["pointerup", onUp],
    ["pointercancel", onUp],
  ];
  for (const [type, listener] of listeners) {
    surface.addEventListener(type, listener, { passive: false });
  }

  resize();
  countStrokes();

  return {
    settings,
    get strokes(): readonly DrawStroke[] {
      return current === null ? strokes : [...strokes, { pointerType: currentType, points: current }];
    },
    get drawing(): boolean {
      return current !== null;
    },
    resize,
    undo(): boolean {
      if (strokes.pop() === undefined) return false;
      repaint();
      countStrokes();
      return true;
    },
    clear(): void {
      strokes.length = 0;
      current = null;
      activePointer = null;
      repaint();
      countStrokes();
    },
    detach(): void {
      for (const [type, listener] of listeners) {
        surface.removeEventListener(type, listener, { passive: false });
      }
      strokes.length = 0;
      current = null;
    },
  };
}

/**
 * The device pixel ratio, clamped.
 *
 * Read lazily and through `globalThis` so that importing this module under Node
 * — which `scripts/verify-dist.mjs` does to every emitted file — touches no DOM.
 * Clamped to 3 because a 4x backing store on a 400 px canvas is 1.9 MB of
 * pixels, and battery is problem #1 in CLAUDE.md.
 */
function pixelRatio(override?: number): number {
  const raw = override ?? (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1;
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(raw, 3);
}
