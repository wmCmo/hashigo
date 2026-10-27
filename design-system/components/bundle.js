/* @ds-bundle: {"format":4,"namespace":"Hashigo","components":[{"name":"FlashCard"},{"name":"Example"},{"name":"Cloze"},{"name":"PlayButton"},{"name":"Counter"},{"name":"WordRail"},{"name":"MenuButton"},{"name":"Button"},{"name":"GradeBar"},{"name":"Chip"}]} */
(function () {
  var React = window.React;
  var h = React.createElement;

  function cx() {
    var out = [];
    for (var i = 0; i < arguments.length; i++) if (arguments[i]) out.push(arguments[i]);
    return out.join(" ");
  }
  function omit(props, keys) {
    var out = {};
    for (var k in props) if (Object.prototype.hasOwnProperty.call(props, k) && keys.indexOf(k) < 0) out[k] = props[k];
    return out;
  }
  function headSize(text) {
    var n = Array.from(String(text == null ? "" : text)).length;
    return n <= 2 ? "lg" : n <= 4 ? "md" : "sm";
  }

  /* The card: one headword, its gloss, then whatever the side carries. */
  function FlashCard(props) {
    var size = props.headSize || headSize(props.head);
    return h("article", Object.assign(omit(props, ["head", "headSize", "gloss", "reading", "pos", "action", "children", "className"]), { className: cx("hs-card", props.className) }),
      props.head != null && h("div", { className: "hs-card-head", "data-size": size, lang: "ja" }, props.head),
      (props.gloss || props.reading || props.pos) && h("div", { className: "hs-card-meta" },
        props.gloss && h("p", { className: "hs-card-gloss" }, props.gloss),
        props.reading && h("p", { className: "hs-card-reading", lang: "ja" }, props.reading),
        props.pos && h("p", { className: "hs-card-pos" }, props.pos)),
      props.children && h("div", { className: "hs-card-body" }, props.children),
      props.action && h("div", { className: "hs-card-action" }, props.action));
  }

  function Example(props) {
    return h("div", { className: cx("hs-example", props.className) },
      h("p", { className: "hs-example-jp", lang: "ja" }, props.jp != null ? props.jp : props.children),
      props.en && h("p", { className: "hs-example-en" }, props.en));
  }

  function Cloze(props) {
    var hidden = !props.revealed;
    return h("span", {
      className: "hs-cloze",
      "data-hidden": hidden ? "" : undefined,
      "aria-label": hidden ? (props.label || "hidden") : undefined,
      role: hidden ? "img" : undefined
    }, props.children);
  }

  function PlayButton(props) {
    var state = props.state || "idle";
    var label = props.label || (state === "missing" ? "No audio for this clip" : state === "playing" ? "Playing — tap to replay" : "Play audio");
    return h("button", Object.assign(omit(props, ["state", "size", "label", "className"]), {
      type: "button",
      className: cx("hs-play", props.className),
      "data-state": state,
      "data-size": props.size || "lg",
      "aria-label": label,
      "aria-disabled": state === "missing" ? "true" : undefined,
      onClick: state === "missing" ? undefined : props.onClick
    }), h("span", { className: "hs-play-disc", "aria-hidden": "true" },
      state === "playing" && (props.size || "lg") === "lg" && h("span", { className: "hs-play-bars" }, h("i"), h("i"), h("i"))));
  }

  function Counter(props) {
    var total = props.total;
    var label = props.value + (total != null ? " of " + total : "") + " cards left";
    return h("div", { className: cx("hs-counter", props.className), role: "status", "aria-label": label },
      h("div", { className: "hs-counter-row", "aria-hidden": "true" },
        h("span", { className: "hs-dot", "data-idle": props.idle ? "" : undefined }),
        h("span", { className: "hs-counter-value" }, props.value)),
      total != null && h("span", { className: "hs-counter-total", "aria-hidden": "true" }, "/" + total));
  }

  /* Words before and after the current card; the current one sits centred. */
  function WordRail(props) {
    var words = props.words || [];
    var current = props.current || 0;
    var rail = React.useRef(null);
    var track = React.useRef(null);
    var shift = React.useState(0);
    React.useLayoutEffect(function () {
      var r = rail.current, t = track.current;
      if (!r || !t) return;
      var el = t.children[current];
      if (!el) return;
      shift[1](r.clientWidth / 2 - (el.offsetLeft + el.offsetWidth / 2));
    }, [current, words.length]);
    return h("nav", { className: cx("hs-rail", props.className), ref: rail, "aria-label": props.label || "Cards in this session" },
      h("ol", { className: "hs-rail-track", ref: track, style: { transform: "translateX(" + shift[0] + "px)" } },
        words.map(function (w, i) {
          return h("li", { key: i },
            h("button", {
              type: "button", className: "hs-rail-item", lang: "ja",
              "aria-current": i === current ? "true" : undefined,
              tabIndex: props.onSelect ? 0 : -1,
              onClick: props.onSelect ? function () { props.onSelect(i); } : undefined
            }, w));
        })));
  }

  function MenuButton(props) {
    return h("button", Object.assign(omit(props, ["label", "className"]), { type: "button", className: cx("hs-icon-btn", props.className), "aria-label": props.label || "Menu" }),
      h("svg", { width: 26, height: 14, viewBox: "0 0 26 14", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", "aria-hidden": "true" },
        h("path", { d: "M1 1h24M1 7h24M1 13h11" })));
  }

  function Button(props) {
    var variant = props.variant || "secondary";
    return h("button", Object.assign(omit(props, ["variant", "block", "kbd", "className", "children"]), {
      type: props.type || "button",
      className: cx("hs-btn", "hs-btn-" + variant, props.className),
      "data-block": props.block ? "" : undefined
    }), props.children, props.kbd && h("span", { className: "hs-kbd", "aria-hidden": "true" }, props.kbd));
  }

  /* Left is always forgot; right is always "go on" — next while sides remain, remembered at the end. */
  function GradeBar(props) {
    var left = props.remaining || 0;
    return h("div", { className: cx("hs-grade", props.className), role: "group", "aria-label": "Grade this card" },
      h(Button, { variant: "secondary", block: true, kbd: props.keys ? "f" : null, onClick: props.onForgot }, "forgot"),
      left > 0
        ? h(Button, { variant: "secondary", block: true, kbd: props.keys ? "space" : null, onClick: props.onNext }, "next · " + left + " more")
        : h(Button, { variant: "primary", block: true, kbd: props.keys ? "j" : null, onClick: props.onRemembered }, "remembered"));
  }

  function Chip(props) {
    return h("span", { className: cx("hs-chip", "hs-chip-" + (props.tone || "neutral"), props.className), lang: props.lang }, props.children);
  }

  window.Hashigo = Object.assign(window.Hashigo || {}, {
    FlashCard: FlashCard, Example: Example, Cloze: Cloze, PlayButton: PlayButton, Counter: Counter,
    WordRail: WordRail, MenuButton: MenuButton, Button: Button, GradeBar: GradeBar, Chip: Chip
  });
})();
