import type { WidgetMount } from "./nodes.js";

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

export interface DrawSurface {
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
  hasPointerCapture?(pointerId: number): boolean;
}

export interface DrawSettings {
  readonly height: string;
  readonly brushColor: string;
  readonly brushRadius: number;
}

export const DRAW_DEFAULTS: DrawSettings = {
  height: "300px",
  brushColor: "#FF0000",
  brushRadius: 4,
};

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

function cssLength(value: string): string {
  return /^\d+$/.test(value) ? `${value}px` : value;
}

export interface DrawPoint {
  readonly x: number;
  readonly y: number;
}

export interface DrawStroke {
  readonly pointerType: string;
  readonly points: readonly DrawPoint[];
}

export interface DrawOptions {
  readonly attributes?: Readonly<Record<string, string>>;
  readonly devicePixelRatio?: number;
  readonly onChange?: (strokes: readonly DrawStroke[]) => void;
}

export interface DrawHandle {
  readonly settings: DrawSettings;
  readonly strokes: readonly DrawStroke[];
  readonly drawing: boolean;
  resize(): void;
  undo(): boolean;
  clear(): void;
  detach(): void;
}

export const DRAW_DATA = {
  strokes: "data-strokes",
} as const;

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
      context.lineTo(start.x, start.y);
    } else {
      for (let at = from + 1; at < points.length; at += 1) {
        const point = points[at];
        if (point !== undefined) context.lineTo(point.x, point.y);
      }
    }
    context.stroke();
  }

  function prime(): void {
    if (context === null) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    brush();
  }

  function repaint(): void {
    if (context === null) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, surface.width, surface.height);
    prime();
    for (const stroke of strokes) paint(stroke.points, 0);
    if (current !== null) paint(current, 0);
  }

  function brush(): void {
    if (context === null) return;
    context.lineWidth = settings.brushRadius * 2;
    context.strokeStyle = settings.brushColor;
    context.lineCap = "round";
    context.lineJoin = "round";
  }

  function resize(): void {
    ratio = pixelRatio(options.devicePixelRatio);
    const rect = surface.getBoundingClientRect();
    surface.width = Math.max(1, Math.round(rect.width * ratio));
    surface.height = Math.max(1, Math.round(rect.height * ratio));
    repaint();
  }

  function countStrokes(): void {
    surface.setAttribute(DRAW_DATA.strokes, String(strokes.length));
    options.onChange?.(strokes);
  }

  function capture(claim: boolean, pointerId: number): void {
    try {
      if (claim) surface.setPointerCapture(pointerId);
      else surface.releasePointerCapture(pointerId);
    } catch {
    }
  }

  function strokeIsStale(): boolean {
    if (activePointer === null) return false;
    try {
      return surface.hasPointerCapture?.(activePointer) !== true;
    } catch {
      return true;
    }
  }

  const onDown = (event: DrawPointerEvent): void => {
    if (event.isPrimary === false) return;
    if (activePointer !== null) {
      if (!strokeIsStale()) return;
      if (current !== null) {
        strokes.push({ pointerType: currentType, points: current });
        current = null;
        countStrokes();
      }
      activePointer = null;
    }
    remeasure();
    event.preventDefault();
    activePointer = event.pointerId;
    currentType = event.pointerType;
    current = [pointOf(event)];
    capture(true, event.pointerId);
    prime();
    paint(current, 0);
  };

  const onMove = (event: DrawPointerEvent): void => {
    if (current === null || event.pointerId !== activePointer) return;
    event.preventDefault();
    const from = current.length - 1;
    current.push(pointOf(event));
    prime();
    paint(current, from);
  };

  const onUp = (event: DrawPointerEvent): void => {
    if (event.pointerId !== activePointer) return;
    if (current !== null) {
      strokes.push({ pointerType: currentType, points: current });
      current = null;
      countStrokes();
    }
    activePointer = null;
    capture(false, event.pointerId);
  };

  const onLostCapture = (event: DrawPointerEvent): void => {
    if (event.pointerId !== activePointer) return;
    onUp(event);
  };

  const listeners: readonly [string, (event: DrawPointerEvent) => void][] = [
    ["pointerdown", onDown],
    ["pointermove", onMove],
    ["pointerup", onUp],
    ["pointercancel", onUp],
    ["lostpointercapture", onLostCapture],
    ["contextrestored", () => repaint()],
  ];
  for (const [type, listener] of listeners) {
    surface.addEventListener(type, listener, { passive: false });
  }

  let observer: { observe(target: unknown): void; disconnect(): void } | null = null;
  const Observe = (
    globalThis as {
      ResizeObserver?: new (run: () => void) => { observe(target: unknown): void; disconnect(): void };
    }
  ).ResizeObserver;

  let builtFor = { width: -1, height: -1 };

  function remeasure(): void {
    const rect = surface.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    if (rect.width === builtFor.width && rect.height === builtFor.height) return;
    builtFor = { width: rect.width, height: rect.height };
    resize();
  }

  resize();
  builtFor = (() => {
    const rect = surface.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0
      ? { width: rect.width, height: rect.height }
      : { width: -1, height: -1 };
  })();

  if (Observe !== undefined) {
    observer = new Observe(() => {
      remeasure();
    });
    observer.observe(surface);
  }
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
      observer?.disconnect();
      observer = null;
      for (const [type, listener] of listeners) {
        surface.removeEventListener(type, listener, { passive: false });
      }
      strokes.length = 0;
      current = null;
    },
  };
}

function pixelRatio(override?: number): number {
  const raw = override ?? (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1;
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(raw, 3);
}
