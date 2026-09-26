/* Epsom KS3 lesson page runtime.

   One page per lesson. The lesson itself arrives as window.LESSON, written into
   the page by build_site.py. This file does four jobs:

     1. shows one step at a time, with the step's own code in the editor
     2. runs Python in the browser with Skulpt, the engine epsom_turtle.html uses
     3. keeps every answer and every step's code in this browser (localStorage),
        so a refresh or a closed tab loses nothing
     4. HAND IN: builds one PDF of everything - answers, code, output, whether the
        output matched, which hints were opened, the drawing - for the student to
        upload to Google Classroom. Nothing is ever sent anywhere by the page.

   The editor, symbol bar, input() handling and Skulpt settings are carried over
   from epsom_turtle.html unchanged, because each of those is a BYOD decision
   that was tested on iPads and Chromebooks. */
(function () {
  "use strict";
  var L = window.LESSON;
  /* Expected outputs are shipped base64-encoded so they are not sitting in plain
     text in the page source. This stops a casual look, not a determined one. */
  L.steps.forEach(function (s) {
    if (s.expected_b64 != null) {
      try { s.expected = decodeURIComponent(escape(window.atob(s.expected_b64))); }
      catch (e) { s.expected = window.atob(s.expected_b64); }
    }
  });
  /* The version is part of the key. Bump it whenever a lesson's steps are
     renumbered, or work saved under the old numbering lands on the wrong steps.
     v2: arrays gained a separate prediction step, 19 Sep 2026. */
  var KEY = "epsom-lesson:" + L.id + ":v" + (L.version || 1);

  /* SIMPLE ENGLISH. A lesson with "simple": true (the Year 7 (i) pages) gets
     these words instead of the page's usual ones. They are short, they use words
     the class has been taught, and the symbols carry the meaning where no taught
     word fits. The hand-in PDF is not affected: it is for the teacher and keeps
     the full wording. With "simple" absent, every string below is the one the
     page has always shown, so the Year 8 to 10 pages do not change. */
  var SIMPLE = !!L.simple;
  var TX = SIMPLE ? {
    remember: "Look: ", hint: "?", drawOnly: "", drill: "Say it: ",
    predictOff: function (label) { return "First: " + label; },
    locked: "\uD83D\uDD12",
    yes: "\u2713 Same", no: "\u2717 Different", err: "\u2717 Stop. Look at the line.",
    ok: "\u2713", waiting: "\u25B6",
    reset: "\u21BA Again", resetArm: "Again?",
    noPdf: "\u2717", saved: function (f) { return "\u2713 " + f; }
  } : {
    remember: "Remember: ", hint: "Hint", drill: "Say it together",
    drawOnly: "This step draws a picture. There is no text output to check.",
    predictOff: function (label) { return "Run is switched off until " + label + " has an answer."; },
    locked: "Locked when Run was pressed.",
    yes: "Matches the expected output", no: "Does not match the expected output",
    err: "Stopped with an error", ok: "", waiting: "Shown after you run the code once.",
    reset: "Reset this step", resetArm: "Tap again to reset",
    noPdf: "The PDF tool did not load. Reload the page and try again.",
    saved: function (f) { return "Saved as \"" + f + "\". Upload it to this lesson's Google Classroom assignment."; }
  };
  var NAMEKEY = "epsom:name";

  var $ = function (id) { return document.getElementById(id); };
  var mainEl = $("main"), cardEl = $("card"), codeEl = $("code"), consoleEl = $("console");
  var navEl = $("steps"), nameEl = $("student-name"), statusEl = $("status");
  var runBtn = $("run"), matchEl = $("match"), msgEl = $("handin-msg");
  var askRow = $("askrow"), askInput = $("askinput");

  /* ------------------------------------------------ line numbers and colours
     The plain textarea stays the thing students type into: on an iPad it is the
     only editor that behaves with the on-screen keyboard and keeps autocorrect
     off. Its text is made transparent, and a coloured copy of the same code is
     drawn in a <pre> exactly underneath it, with a line-number gutter beside.
     Both layers use identical font, size, line height, padding and tab size, and
     scroll together, so every character of the copy sits under the character
     typed. test_in_browser.py checks that alignment pixel by pixel. */
  var codeWrap = el("div"), gutter = el("div"), codeArea = el("div"), hl = el("pre");
  codeWrap.id = "codewrap"; gutter.id = "gutter"; codeArea.id = "codearea"; hl.id = "hl";
  gutter.setAttribute("aria-hidden", "true");
  hl.setAttribute("aria-hidden", "true");
  codeEl.parentNode.insertBefore(codeWrap, codeEl);
  codeWrap.appendChild(gutter);
  codeWrap.appendChild(codeArea);
  codeArea.appendChild(hl);
  codeArea.appendChild(codeEl);

  /* ------------------------------------------------ the card / editor divider
     A bar on the top edge of the editor. Dragging it up shrinks the card (which
     then scrolls) and gives the editor the room; dragging down does the reverse.
     Pointer events, so mouse, pen and touch (iPad, Chromebook) all work.
     Double-tap (or Enter) swaps between the normal split and the editor at full
     height. Arrow keys move it too. The position is kept per student in this
     browser under SPLITKEY, as a share of the window height, so it carries from
     page to page and survives a window resize.
     Only the card's height is set. #hl and #code both fill #codearea exactly,
     so they are resized together and stay aligned. */
  var SPLITKEY = "epsom:split";
  var CARD_MIN = 64;        // the step label and title stay in view
  var EDITOR_MIN = 150;     // toolbar and about four lines of code
  var NARROW_MIN = 320;     // editor height on narrow screens, as in lesson.css
  var splitter = el("div");
  splitter.id = "splitter";
  splitter.setAttribute("role", "separator");
  splitter.setAttribute("aria-orientation", "horizontal");
  splitter.setAttribute("aria-label", "Drag to make the code editor bigger or smaller");
  splitter.tabIndex = 0;
  var editorBlock = $("editor-block");
  editorBlock.parentNode.insertBefore(splitter, editorBlock);
  var split = null;         // null: normal split; "full": editor at full height; else a share
  try {
    var saved = localStorage.getItem(SPLITKEY);
    if (saved === "full") split = "full";
    else if (saved && isFinite(parseFloat(saved))) split = parseFloat(saved);
  } catch (e) {}
  function saveSplit() {
    try {
      if (split === null) localStorage.removeItem(SPLITKEY);
      else localStorage.setItem(SPLITKEY, String(split));
    } catch (e) {}
  }
  function isNarrow() { return window.matchMedia("(max-width: 860px)").matches; }
  function applySplit() {
    cardEl.style.height = ""; cardEl.style.maxHeight = ""; codeWrap.style.height = "";
    mainEl.classList.toggle("split-set", split !== null);
    if (split === null || mainEl.classList.contains("cardonly")) { syncScroll(); return; }
    cardEl.style.maxHeight = "none";
    var natural = cardEl.offsetHeight;         // the card at full length, no scrolling
    var want = split === "full" ? 0 : split * window.innerHeight;
    var h;
    if (isNarrow()) {
      h = Math.max(Math.min(CARD_MIN, natural), Math.min(want, natural));
      /* The page scrolls here, so the editor takes what the card gave up. */
      var grow = Math.max(0, natural - h);
      codeWrap.style.height = Math.round(Math.min(NARROW_MIN + grow,
        Math.max(NARROW_MIN, window.innerHeight * 0.75))) + "px";
    } else {
      var room = cardEl.parentNode.clientHeight - splitter.offsetHeight - EDITOR_MIN;
      h = Math.max(Math.min(CARD_MIN, natural), Math.min(want, natural, room));
    }
    cardEl.style.height = Math.round(h) + "px";
    syncScroll();
  }
  function setSplitPx(px) {
    split = Math.max(0, px) / window.innerHeight;
    applySplit();
  }
  /* The drag, the double-tap and the keys are the same on every splitter, so
     they live here once. get() reads the current height above the bar, set(px)
     moves it, end() saves, toggle() switches between the normal split and the
     one-sided view. Pointer events cover mouse, pen and touch. */
  function dragBar(bar, opts) {
    var drag = null, lastTap = 0;
    bar.addEventListener("pointerdown", function (e) {
      if (e.button !== undefined && e.button > 0) return;
      e.preventDefault();
      drag = { y: e.clientY, h: opts.get(), moved: false, id: e.pointerId };
      try { bar.setPointerCapture(e.pointerId); } catch (x) {}
      bar.classList.add("dragging");
    });
    bar.addEventListener("pointermove", function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var dy = e.clientY - drag.y;
      if (Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) opts.set(drag.h + dy);
    });
    function endDrag(e) {
      if (!drag || e.pointerId !== drag.id) return;
      var moved = drag.moved;
      drag = null;
      bar.classList.remove("dragging");
      if (moved) { opts.end(); lastTap = 0; return; }
      var now = Date.now();
      if (now - lastTap < 400) { lastTap = 0; opts.toggle(); }
      else lastTap = now;
    }
    bar.addEventListener("pointerup", endDrag);
    bar.addEventListener("pointercancel", endDrag);
    bar.addEventListener("keydown", function (e) {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        opts.set(opts.get() + (e.key === "ArrowUp" ? -30 : 30));
        opts.end();
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        opts.toggle();
      }
    });
  }

  function toggleFull() {
    split = split === "full" ? null : "full";
    applySplit();
    saveSplit();
  }
  dragBar(splitter, { get: function () { return cardEl.offsetHeight; },
                      set: setSplitPx, end: saveSplit, toggle: toggleFull });

  window.addEventListener("resize", applySplit);
  /* Typing in an answer box can change the card's length. */
  cardEl.addEventListener("input", function () { if (split !== null && isNarrow()) applySplit(); });

  /* ------------------------------------------- the right pane's own divider
     On a turtle step it sits between the drawing and the output. On a step with
     an expected output and no drawing it sits between Expected output and Your
     output. It looks and behaves exactly like the left one, and it is kept per
     student in this browser under its own key, one for each of the two places.
     Only the box above the bar is given a height. The drawing is never redrawn
     or cropped: #turtle-canvas keeps its 7:5 shape and sizeStage() gives it the
     largest width that fits the room it has, so both canvases scale inside it.
     Hidden below 861px, where the page scrolls instead (see lesson.css). */
  var RKEYS = { draw: "epsom:rsplit-draw", exp: "epsom:rsplit-exp" };
  var DRAW_MIN = 120, EXP_MIN = 60, OUT_MIN = 90;
  var rsplitter = el("div");
  rsplitter.id = "rsplitter";
  rsplitter.setAttribute("role", "separator");
  rsplitter.setAttribute("aria-orientation", "horizontal");
  rsplitter.setAttribute("aria-label", "Drag to make the drawing or the output bigger or smaller");
  rsplitter.tabIndex = 0;
  var outHead = $("output-head"), drawBlock = $("drawing-block"), expBlock = $("expected-block");
  outHead.parentNode.insertBefore(rsplitter, outHead);
  var rsplit = { draw: null, exp: null };
  Object.keys(RKEYS).forEach(function (m) {
    try {
      var v = localStorage.getItem(RKEYS[m]);
      if (v === "full") rsplit[m] = "full";
      else if (v && isFinite(parseFloat(v))) rsplit[m] = parseFloat(v);
    } catch (e) {}
  });
  function rmode() {
    if (mainEl.classList.contains("cardonly")) return null;
    if (!drawBlock.hidden) return "draw";
    if (!expBlock.hidden) return "exp";
    return null;
  }
  function saveRSplit() {
    var m = rmode();
    if (!m) return;
    try {
      if (rsplit[m] === null) localStorage.removeItem(RKEYS[m]);
      else localStorage.setItem(RKEYS[m], String(rsplit[m]));
    } catch (e) {}
  }
  /* The drawing box: as wide as fits, never wider than 700, and never taller
     than the room above the bar. The canvases inside are pinned to it. */
  function sizeStage() {
    var stage = $("stage");
    if (!stage || drawBlock.hidden) return;
    var w = stage.clientWidth - 16, h = stage.clientHeight - 16;
    var box = $("turtle-canvas");
    if (w > 0 && h > 0) box.style.width = Math.max(60, Math.min(700, w, h * 1.4)) + "px";
  }
  function applyRSplit() {
    drawBlock.style.height = ""; expBlock.style.height = ""; expBlock.style.maxHeight = "";
    var m = rmode();
    rsplitter.hidden = !m;
    mainEl.classList.toggle("rsplit-set", !!m && rsplit[m] !== null && !isNarrow());
    if (!m || isNarrow() || rsplit[m] === null) { sizeStage(); return; }
    var target = m === "draw" ? drawBlock : expBlock;
    var pane = target.parentNode;
    var room = pane.clientHeight - rsplitter.offsetHeight - outHead.offsetHeight - OUT_MIN;
    if (askRow && askRow.style.display !== "none") room -= askRow.offsetHeight;
    var want = rsplit[m] === "full" ? 1e6 : rsplit[m] * window.innerHeight;
    var least = m === "draw" ? DRAW_MIN : EXP_MIN;
    var h = Math.max(least, Math.min(want, Math.max(least, room)));
    target.style.height = Math.round(h) + "px";
    if (m === "exp") target.style.maxHeight = "none";
    sizeStage();
  }
  function setRSplitPx(px) {
    var m = rmode();
    if (!m) return;
    rsplit[m] = Math.max(0, px) / window.innerHeight;
    applyRSplit();
  }
  function toggleRFull() {
    var m = rmode();
    if (!m) return;
    rsplit[m] = rsplit[m] === "full" ? null : "full";
    applyRSplit();
    saveRSplit();
  }
  dragBar(rsplitter, {
    get: function () { var m = rmode(); return m === "exp" ? expBlock.offsetHeight : drawBlock.offsetHeight; },
    set: setRSplitPx, end: saveRSplit, toggle: toggleRFull });
  window.addEventListener("resize", applyRSplit);

  /* ------------------------------------------------ looking at the drawing
     Fit crops to what the student drew and fills the box with it, the same
     rectangle the hand-in PDF uses. Pinch, a trackpad pinch or the wheel zoom,
     one finger or the mouse drags, and Whole canvas (or a double-tap) puts the
     plain view back. Nothing is redrawn: the box is moved and scaled with a CSS
     transform and #stage clips what falls outside, so every pixel the program
     drew is still there and the PDF is unaffected. */
  var view = { k: 1, tx: 0, ty: 0 };
  function applyView() {
    var box = $("turtle-canvas");
    box.style.transform = view.k === 1 && !view.tx && !view.ty
      ? "" : "translate(" + view.tx + "px," + view.ty + "px) scale(" + view.k + ")";
    var plainBtn = $("plain");
    if (plainBtn) plainBtn.disabled = (view.k === 1 && !view.tx && !view.ty);
  }
  function plainView() { view = { k: 1, tx: 0, ty: 0 }; applyView(); }
  /* The smallest rectangle holding everything that was drawn, in canvas pixels. */
  /* The turtle sprite sits on the top canvas. Fit measures what was DRAWN, so
     that layer is left out: otherwise a program that draws nothing yet would
     zoom the arrow to fill the box. */
  function drawnOnly() {
    var cs = $("turtle-canvas").querySelectorAll("canvas");
    if (!cs.length) return null;
    var list = [];
    for (var k = 0; k < cs.length; k++) list.push(cs[k]);
    if (list.length > 1) {
      list.sort(function (a, b) {
        return (parseInt(a.style.zIndex || 0, 10)) - (parseInt(b.style.zIndex || 0, 10));
      });
      list.pop();
    }
    var c = document.createElement("canvas");
    c.width = cs[0].width; c.height = cs[0].height;
    var g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    for (var j = 0; j < list.length; j++) { try { g.drawImage(list[j], 0, 0, c.width, c.height); } catch (e) {} }
    return c;
  }
  function inkBox() {
    var c = drawnOnly();
    if (!c) return null;
    var w = c.width, h = c.height, d;
    try { d = c.getContext("2d").getImageData(0, 0, w, h).data; } catch (e) { return null; }
    var x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4;
        if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    return { x0: x0, y0: y0, x1: x1 + 1, y1: y1 + 1, w: w, h: h };
  }
  function fitView() {
    var stage = $("stage"), box = $("turtle-canvas");
    var ink = inkBox();
    if (!ink || drawBlock.hidden) return false;
    plainView();
    var b = box.getBoundingClientRect(), st = stage.getBoundingClientRect();
    var sx = b.width / ink.w, sy = b.height / ink.h;          // canvas pixel to screen
    var iw = (ink.x1 - ink.x0) * sx, ih = (ink.y1 - ink.y0) * sy;
    var pad = 16;
    var k = Math.min((st.width - pad * 2) / Math.max(1, iw), (st.height - pad * 2) / Math.max(1, ih));
    k = Math.max(1, Math.min(6, k));
    var cx = (ink.x0 * sx + iw / 2), cy = (ink.y0 * sy + ih / 2);   // ink centre in the box
    view.k = k;
    view.tx = st.left - b.left + st.width / 2 - k * cx;
    view.ty = st.top - b.top + st.height / 2 - k * cy;
    applyView();
    return true;
  }
  function zoomAt(clientX, clientY, factor) {
    var box = $("turtle-canvas").getBoundingClientRect();
    var k2 = Math.max(0.5, Math.min(8, view.k * factor));
    /* keep the point under the fingers where it is */
    var px = (clientX - box.left) / view.k, py = (clientY - box.top) / view.k;
    view.tx += (view.k - k2) * px;
    view.ty += (view.k - k2) * py;
    view.k = k2;
    applyView();
  }
  var fitBtn = $("fit"), plainBtn = $("plain");
  if (fitBtn) fitBtn.addEventListener("click", function () { fitView(); });
  if (plainBtn) plainBtn.addEventListener("click", plainView);
  (function () {
    var stage = $("stage");
    if (!stage) return;
    var points = {}, last = null, pinch = null, tapAt = 0, moved = false;
    stage.addEventListener("pointerdown", function (e) {
      points[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(points);
      moved = false;
      if (ids.length === 1) { last = { x: e.clientX, y: e.clientY }; }
      else if (ids.length === 2) {
        var a = points[ids[0]], b = points[ids[1]];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
      }
      try { stage.setPointerCapture(e.pointerId); } catch (x) {}
    });
    stage.addEventListener("pointermove", function (e) {
      if (!points[e.pointerId]) return;
      points[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(points);
      if (ids.length >= 2 && pinch) {
        var a = points[ids[0]], b = points[ids[1]];
        var d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch.d > 0 && Math.abs(d - pinch.d) > 1) {
          zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch.d);
          moved = true;
        }
        pinch.d = d;
      } else if (ids.length === 1 && last) {
        var dx = e.clientX - last.x, dy = e.clientY - last.y;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
        if (moved) { view.tx += dx; view.ty += dy; applyView(); }
        last = { x: e.clientX, y: e.clientY };
      }
    });
    function up(e) {
      delete points[e.pointerId];
      if (!Object.keys(points).length) { pinch = null; last = null; }
      if (moved) { tapAt = 0; return; }
      var now = Date.now();
      if (now - tapAt < 400) { tapAt = 0; plainView(); }
      else tapAt = now;
    }
    stage.addEventListener("pointerup", up);
    stage.addEventListener("pointercancel", up);
    stage.addEventListener("dblclick", plainView);
    stage.addEventListener("wheel", function (e) {
      if (drawBlock.hidden) return;
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });
  })();

  var KEYWORDS = {};
  ("False None True and as break continue def elif else for from if import in is " +
   "not or pass return while with").split(" ").forEach(function (k) { KEYWORDS[k] = 1; });
  var BUILTINS = {};
  ("print input int float str len range list round abs min max sum").split(" ")
    .forEach(function (k) { BUILTINS[k] = 1; });

  function esc(t) { return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  /* One pass per line: comments, strings, numbers, names. KS3 code never uses
     triple-quoted strings, so nothing needs to carry from one line to the next.
     A run of three or more underscores is a GAP and is marked in amber. */
  var TOKEN = /(#.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)/g;
  function highlightLine(line) {
    var out = "", last = 0, m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(line)) !== null) {
      if (m.index === TOKEN.lastIndex) TOKEN.lastIndex++;   // never loop on an empty match
      out += esc(line.slice(last, m.index));
      var t = m[0], cls = "";
      if (m[1]) cls = "tk-com";
      else if (m[2]) cls = "tk-str";
      else if (m[3]) cls = "tk-num";
      else if (/^_{3,}$/.test(t)) cls = "tk-gap";
      else if (KEYWORDS[t]) cls = "tk-key";
      else if (BUILTINS[t]) cls = "tk-fn";
      out += cls ? '<span class="' + cls + '">' + esc(t) + "</span>" : esc(t);
      last = m.index + t.length;
    }
    return out + esc(line.slice(last));
  }

  function syncScroll() {
    hl.scrollTop = codeEl.scrollTop;
    hl.scrollLeft = codeEl.scrollLeft;
    gutter.scrollTop = codeEl.scrollTop;
  }
  function syncEditor() {
    var lines = codeEl.value.split("\n");
    /* The extra line keeps the copy as tall as the textarea, which always lets
       the caret sit on one more line than the text has. */
    hl.innerHTML = lines.map(highlightLine).join("\n") + "\n ";
    var nums = [];
    for (var n = 1; n <= lines.length; n++) nums.push(n);
    gutter.textContent = nums.join("\n") + "\n ";
    syncScroll();
  }
  codeEl.addEventListener("scroll", syncScroll);
  codeEl.addEventListener("input", syncEditor);

  /* ------------------------------------------------------------------ state */
  function blank() { return { answers: {}, steps: {}, current: 0, locked: {} }; }
  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY));
      if (s && s.steps && s.answers) return s;
    } catch (e) {}
    return blank();
  }
  var state = load();
  if (!(state.current >= 0 && state.current < L.steps.length)) state.current = 0;
  if (!state.locked) state.locked = {};

  function flag(text) {
    statusEl.innerHTML = '<span class="saved">' + (text || "saved") + "</span>";
    clearTimeout(flag.t);
    flag.t = setTimeout(function () { statusEl.textContent = ""; }, 1200);
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); flag(); }
    catch (e) {
      /* Storage full. Keep the work, drop the pictures: the PDF can still be made
         from what is on screen, and code matters more than a snapshot. */
      try {
        var lean = JSON.parse(JSON.stringify(state));
        Object.keys(lean.steps).forEach(function (k) { delete lean.steps[k].drawing; });
        localStorage.setItem(KEY, JSON.stringify(lean));
      } catch (e2) {}
    }
  }
  var saveTimer = null;
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 500); }

  function st(i) {
    var k = String(i);
    if (!state.steps[k]) state.steps[k] = { code: L.steps[i].code || "", hint: false };
    return state.steps[k];
  }

  try { nameEl.value = localStorage.getItem(NAMEKEY) || ""; } catch (e) {}
  nameEl.addEventListener("input", function () {
    try { localStorage.setItem(NAMEKEY, nameEl.value); } catch (e) {}
    msgEl.textContent = "";
  });

  /* ------------------------------------------------------------ small helpers */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function norm(s) {
    return String(s || "").replace(/\r/g, "").split("\n")
      .map(function (l) { return l.replace(/\s+$/, ""); }).join("\n")
      .replace(/^\n+/, "").replace(/\n+$/, "");
  }
  function answered(q) { return !!(state.answers[q.id] || "").trim(); }

  function isDone(i) {
    var step = L.steps[i], s = state.steps[String(i)] || {};
    var qs = (step.questions || []).every(answered);
    if (step.kind === "convert") return qs && convDone(i);
    if (step.kind === "questions") return qs;
    var codeOk = step.expected != null ? !!s.matched : (!!s.ran && !s.error);
    return qs && codeOk;
  }

  function predictBlocked(i) {
    var step = L.steps[i];
    return !!step.predict_first && !(state.answers[step.predict_first] || "").trim();
  }

  /* ---------------------------------------------------------------- the nav */
  function renderNav() {
    navEl.innerHTML = "";
    L.steps.forEach(function (step, i) {
      var b = el("button", "", step.nav);
      b.title = step.label + ": " + step.title;
      if (i === state.current) b.classList.add("current");
      if (isDone(i)) b.classList.add("done");
      b.addEventListener("click", function () { go(i); });
      navEl.appendChild(b);
    });
  }

  /* --------------------------------------------------------------- the card */
  function renderCard(i) {
    var step = L.steps[i];
    cardEl.innerHTML = "";
    cardEl.appendChild(el("div", "steplabel", step.label));
    cardEl.appendChild(el("h2", "", step.title));

    if (step.remember) {
      var r = el("div", "remember");
      r.appendChild(el("b", "", TX.remember));
      r.appendChild(document.createTextNode(step.remember));
      cardEl.appendChild(r);
    }
    /* WORD LIST: "wordlist": [["loop", "do it again and again."], ...]. Larger
       type, each new word in bold, one per line. Shown before the intro. */
    if (step.wordlist) {
      var wl = el("ul", "wordlist");
      step.wordlist.forEach(function (w) {
        var li = el("li");
        li.appendChild(el("b", "", w[0]));
        li.appendChild(document.createTextNode(": " + w[1]));
        wl.appendChild(li);
      });
      cardEl.appendChild(wl);
    }
    (step.intro || []).forEach(function (t) { cardEl.appendChild(el("p", "", t)); });
    if (step.images) cardEl.appendChild(pics(step.images));

    if (step.table) {
      /* Column alignment. Digits read best centred and words read best from the
         left, so each column is measured: a column whose longest body cell is
         more than four characters is left-aligned, the rest stay centred. The
         first column keeps its own left-aligned rule either way. */
      var LONG = 4, wide = [];
      step.table.rows.forEach(function (row) {
        row.forEach(function (c, ci) {
          if (String(c == null ? "" : c).length > LONG) wide[ci] = true;
        });
      });
      var t = el("table", "idx"), tr = el("tr");
      step.table.headers.forEach(function (h, ci) {
        tr.appendChild(el("th", wide[ci] ? "lft" : "", h));
      });
      t.appendChild(tr);
      step.table.rows.forEach(function (row) {
        var r2 = el("tr");
        row.forEach(function (c, ci) { r2.appendChild(el("td", wide[ci] ? "lft" : "", c)); });
        t.appendChild(r2);
      });
      cardEl.appendChild(t);
    }
    if (step.readonly) cardEl.appendChild(el("pre", "show", step.readonly));
    if (step.kind === "convert") cardEl.appendChild(convertEl(step, i));

    (step.questions || []).forEach(function (q) {
      var box = el("div", "q");
      box.appendChild(el("span", "qlabel", q.label));
      box.appendChild(el("span", "qprompt", q.prompt));
      if (q.code) box.appendChild(el("pre", "show", q.code));
      if (q.image) box.appendChild(pics([{ src: q.image }]));
      if (q.images) box.appendChild(pics(q.images));
      if (q.pick) {
        box.appendChild(pickEl(q));
        if (state.locked[q.id]) box.appendChild(el("p", "locknote", TX.locked));
        cardEl.appendChild(box);
        return;
      }
      var ta = el("textarea");
      ta.id = "q-" + q.id;
      ta.rows = 2;
      /* Answers are often code (scores[0] = 5). iOS must not capitalise them. */
      ["autocapitalize", "autocorrect"].forEach(function (a) { ta.setAttribute(a, "off"); });
      ta.spellcheck = false;
      ta.value = state.answers[q.id] || "";
      if (state.locked[q.id]) {
        ta.readOnly = true;
        ta.classList.add("locked");
      }
      ta.addEventListener("input", function () {
        if (ta.readOnly) return;
        state.answers[q.id] = ta.value;
        saveSoon();
        updateRunGate();
        renderNavSoon();
      });
      box.appendChild(ta);
      if (state.locked[q.id]) box.appendChild(el("p", "locknote", TX.locked));
      cardEl.appendChild(box);
    });

    /* DRILL: "drill": "A while loop needs ...". The key sentence of the lesson,
       said aloud together (choral drill). Last thing on the card. */
    if (step.drill) {
      var dr = el("div", "drill");
      dr.appendChild(el("div", "drill-head", TX.drill));
      dr.appendChild(el("p", "", step.drill));
      cardEl.appendChild(dr);
    }
    if (step.kind === "code" && step.expected == null && step.turtle && TX.drawOnly) {
      cardEl.appendChild(el("p", "", TX.drawOnly));
    }
    if (step.predict_first) {
      var pn = el("p", "predict-note", "");
      pn.id = "predict-note";
      cardEl.appendChild(pn);
    }
    if (step.hint) {
      var d = el("details", "hint");
      d.appendChild(el("summary", "", TX.hint));
      d.appendChild(el("p", "", step.hint));
      if (st(i).hint) d.open = true;
      d.addEventListener("toggle", function () {
        if (d.open && !st(i).hint) { st(i).hint = true; save(); }
      });
      cardEl.appendChild(d);
    }
    cardEl.scrollTop = 0;
  }

  /* PICTURES. A row of images with an optional word under each. The src is
     written into the page by build_site.py: a file beside the page when hosted,
     a data: address in the offline single-file page. */
  function pics(list) {
    var row = el("div", "pics");
    list.forEach(function (p) {
      var f = el("figure");
      var im = el("img");
      im.src = p.src;
      im.alt = p.label || "";
      im.loading = "eager";
      f.appendChild(im);
      if (p.label) f.appendChild(el("figcaption", "", p.label));
      row.appendChild(f);
    });
    return row;
  }

  /* CONVERT. Self-correcting binary conversions (added 19 Sep 2026).
     A step with "kind": "convert" has "bits" (4, 8 or 16), "direction"
     ("to_denary" or "to_binary") and "items" (the denary numbers). The column
     headings sit above every question. The answer box turns green the moment
     the answer is right, and amber when a complete answer is wrong, so the
     student corrects it there and then. Every attempt is saved: what is in the
     box, whether it is right, and how many complete wrong answers came first. */
  function toBin(n, bits) {
    var b = n.toString(2);
    while (b.length < bits) b = "0" + b;
    return b;
  }
  function convAnswer(step, j) {
    var n = step.items[j];
    return step.direction === "to_denary" ? String(n) : toBin(n, step.bits);
  }
  function convDone(i) {
    var step = L.steps[i], s = state.steps[String(i)] || {}, c = s.conv || {};
    return step.items.every(function (n, j) { return c[j] === convAnswer(step, j); });
  }
  function convertEl(step, i) {
    var s = st(i);
    if (!s.conv) s.conv = {};
    if (!s.tries) s.tries = {};
    var heads = [];
    for (var k = step.bits - 1; k >= 0; k--) heads.push(Math.pow(2, k));
    var wrap = el("div", "conv conv-" + step.bits);
    var tally = el("p", "conv-tally");
    function recount() {
      var right = step.items.filter(function (n, j) { return s.conv[j] === convAnswer(step, j); }).length;
      tally.textContent = right + " of " + step.items.length + " correct";
      tally.classList.toggle("all", right === step.items.length);
    }
    function mark(box, j, value, complete) {
      var ok = value === convAnswer(step, j);
      /* conv-ok / conv-bad, not "right" / "wrong": main.cardonly .right is the
         hidden output pane, so a class called "right" would hide the answer. */
      var wasWrong = box.classList.contains("conv-bad");
      box.classList.toggle("conv-ok", ok);
      box.classList.toggle("conv-bad", !ok && complete);
      if (!ok && complete && !wasWrong) s.tries[j] = (s.tries[j] || 0) + 1;
      s.conv[j] = value;
      recount();
      saveSoon();
      renderNavSoon();
    }
    function headRow(grid) {
      heads.forEach(function (h, k) {
        grid.appendChild(el("div", "conv-h" + (k && k % 4 === 0 ? " nb" : ""), String(h)));
      });
    }
    step.items.forEach(function (n, j) {
      var row = el("div", "conv-q");
      row.id = "conv-" + i + "-" + j;
      row.appendChild(el("span", "qlabel", (j + 1) + "."));
      var grid = el("div", "conv-grid");
      grid.style.gridTemplateColumns = "repeat(" + step.bits + ", minmax(0, 1fr))";
      headRow(grid);
      var saved = s.conv[j] || "";
      if (step.direction === "to_denary") {
        toBin(n, step.bits).split("").forEach(function (c, k) {
          grid.appendChild(el("div", "conv-b" + (k && k % 4 === 0 ? " nb" : ""), c));
        });
        row.appendChild(grid);
        var line = el("div", "conv-ans");
        line.appendChild(el("span", "", "Denary:"));
        var inp = el("input", "conv-in");
        inp.type = "text";
        inp.setAttribute("inputmode", "numeric");
        ["autocapitalize", "autocorrect", "autocomplete"].forEach(function (a) { inp.setAttribute(a, "off"); });
        inp.spellcheck = false;
        inp.value = saved;
        inp.addEventListener("input", function () {
          inp.value = inp.value.replace(/[^0-9]/g, "");
          mark(inp, j, inp.value, inp.value.length >= String(n).length);
        });
        line.appendChild(inp);
        row.appendChild(line);
        if (saved) mark(inp, j, saved, saved.length >= String(n).length);
      } else {
        row.insertBefore(el("span", "conv-n", String(n)), null);
        var cells = [];
        for (var k2 = 0; k2 < step.bits; k2++) {
          var c = el("input", "conv-cell" + (k2 && k2 % 4 === 0 ? " nb" : ""));
          c.type = "text";
          c.maxLength = 1;
          c.setAttribute("inputmode", "numeric");
          c.setAttribute("aria-label", "column " + heads[k2]);
          ["autocapitalize", "autocorrect", "autocomplete"].forEach(function (a) { c.setAttribute(a, "off"); });
          c.value = saved.charAt(k2) === "0" || saved.charAt(k2) === "1" ? saved.charAt(k2) : "";
          cells.push(c);
          grid.appendChild(c);
        }
        var readCells = function () {
          return cells.map(function (x) { return x.value || " "; }).join("").replace(/\s+$/, "");
        };
        cells.forEach(function (c, k3) {
          c.addEventListener("input", function () {
            c.value = c.value.replace(/[^01]/g, "").slice(-1);
            if (c.value && k3 + 1 < cells.length) cells[k3 + 1].focus();
            var v = readCells();
            mark(grid, j, v, cells.every(function (x) { return x.value; }));
          });
          c.addEventListener("keydown", function (e) {
            if (e.key === "Backspace" && !c.value && k3 > 0) cells[k3 - 1].focus();
          });
        });
        row.appendChild(grid);
        if (saved) mark(grid, j, readCells(), cells.every(function (x) { return x.value; }));
      }
      wrap.appendChild(row);
    });
    recount();
    wrap.appendChild(tally);
    return wrap;
  }

  /* PICK ONE. Tap a word or a picture instead of typing. The choice is saved as
     the answer like any typed answer, so the nav tick, the lock on a prediction
     and the hand-in PDF all work unchanged. The box carries readOnly like a
     textarea does, so one test works for both. */
  function pickEl(q) {
    var box = el("div", "pick");
    box.id = "q-" + q.id;
    q.pick.forEach(function (o) {
      var b = el("button", "opt");
      b.type = "button";
      b.setAttribute("data-v", o.v);
      if (o.img) { var im = el("img"); im.src = o.img; im.alt = o.label || o.v; b.appendChild(im); }
      var cap = o.label != null ? o.label : (o.img ? "" : o.v);
      if (cap) b.appendChild(el("span", "", cap));
      if (state.answers[q.id] === o.v) b.classList.add("sel");
      b.addEventListener("click", function () {
        if (box.readOnly) return;
        state.answers[q.id] = o.v;
        Array.prototype.forEach.call(box.children, function (c) {
          c.classList.toggle("sel", c.getAttribute("data-v") === o.v);
        });
        saveSoon();
        updateRunGate();
        renderNavSoon();
      });
      box.appendChild(b);
    });
    if (state.locked[q.id]) lockEl(box);
    return box;
  }

  function lockEl(e) {
    e.readOnly = true;
    e.classList.add("locked");
    if (e.tagName !== "TEXTAREA") {
      Array.prototype.forEach.call(e.querySelectorAll("button"), function (b) { b.disabled = true; });
    }
  }

  var navTimer = null;
  function renderNavSoon() { clearTimeout(navTimer); navTimer = setTimeout(renderNav, 250); }

  function updateRunGate() {
    var i = state.current, step = L.steps[i];
    if (step.kind !== "code") return;
    var blocked = predictBlocked(i);
    runBtn.disabled = blocked;
    var pn = $("predict-note");
    if (pn) {
      var q = (step.questions || []).filter(function (x) { return x.id === step.predict_first; })[0];
      pn.textContent = blocked ? TX.predictOff(q ? q.label : "the prediction") : "";
    }
  }

  /* ---------------------------------------------------------------- output */
  function out(text, cls) {
    var span = el("span", cls || "", text);
    consoleEl.appendChild(span);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }
  function clearConsole() { consoleEl.textContent = ""; }

  function showMatch(i) {
    var step = L.steps[i], s = state.steps[String(i)] || {};
    matchEl.className = "";
    matchEl.textContent = "";
    if (step.kind !== "code" || !s.ran) return;
    if (step.expected != null) {
      matchEl.className = s.matched ? "yes" : "no";
      matchEl.textContent = s.matched ? TX.yes : TX.no;
    } else if (s.error) {
      matchEl.className = "no";
      matchEl.textContent = TX.err;
    } else if (TX.ok) {
      matchEl.className = "yes";
      matchEl.textContent = TX.ok;
    }
  }

  /* The expected output stays hidden until the step has been run once, so it is
     never on screen before the student has attempted the step. */
  function showExpected(i) {
    var step = L.steps[i], s = state.steps[String(i)] || {}, box = $("expected");
    if (step.expected == null) { box.textContent = ""; return; }
    box.textContent = s.ran ? step.expected : TX.waiting;
    box.classList.toggle("waiting", !s.ran);
  }

  /* Show a step's last result again when the student comes back to it. */
  function replay(i) {
    clearConsole();
    var s = state.steps[String(i)] || {};
    if (s.output) {
      var text = s.output;
      if (s.error && s.errmsg) {
        var cut = text.lastIndexOf(s.errmsg);
        if (cut >= 0) { out(text.slice(0, cut)); out(s.errmsg, "err"); }
        else out(text);
      } else out(text);
    }
    var host = $("turtle-canvas");
    host.innerHTML = "";
    if (L.steps[i].turtle && s.drawing) {
      var img = el("img");
      img.src = s.drawing;
      img.alt = "Your last drawing for this step";
      img.style.maxWidth = "100%";
      host.appendChild(img);
    }
    showMatch(i);
  }

  /* ------------------------------------------------------------ navigation */
  var runToken = 0;
  function go(i) {
    killed = true;           // stop anything still running on the old step
    runToken++;
    askRow.style.display = "none";
    state.current = i;
    save();
    var step = L.steps[i];
    mainEl.classList.toggle("cardonly", step.kind !== "code");
    mainEl.classList.toggle("has-drawing", !!step.turtle);
    $("drawing-block").hidden = !step.turtle;
    $("expected-block").hidden = !(step.kind === "code" && step.expected != null);
    showExpected(i);
    if (step.kind === "code") {
      codeEl.value = st(i).code;
      codeEl.scrollTop = 0; codeEl.scrollLeft = 0;
      syncEditor();
      $("reset").textContent = TX.reset;
    }
    renderCard(i);
    applySplit();
    applyRSplit();
    plainView();
    renderNav();
    updateRunGate();
    replay(i);
  }

  codeEl.addEventListener("input", function () {
    st(state.current).code = codeEl.value;
    saveSoon();
  });
  codeEl.addEventListener("keydown", function (e) {
    if (e.key === "Tab") { e.preventDefault(); insert("    "); }
  });
  function insert(text, caretBack) {
    var s = codeEl.selectionStart, en = codeEl.selectionEnd, v = codeEl.value;
    codeEl.value = v.slice(0, s) + text + v.slice(en);
    syncEditor();
    var pos = s + text.length - (caretBack || 0);
    codeEl.selectionStart = codeEl.selectionEnd = pos;
    codeEl.focus();
    st(state.current).code = codeEl.value;
    saveSoon();
  }

  /* Reset needs two taps, so one stray tap cannot wipe a student's work. */
  var resetArmed = false, resetTimer = null;
  $("reset").addEventListener("click", function () {
    var b = $("reset");
    if (!resetArmed) {
      resetArmed = true;
      b.textContent = TX.resetArm;
      resetTimer = setTimeout(function () { resetArmed = false; b.textContent = TX.reset; }, 3000);
      return;
    }
    clearTimeout(resetTimer);
    resetArmed = false;
    b.textContent = TX.reset;
    var i = state.current;
    state.steps[String(i)] = { code: L.steps[i].code || "", hint: st(i).hint };
    codeEl.value = L.steps[i].code || "";
    syncEditor();
    save();
    replay(i);
    renderNav();
  });

  /* ------------------------------------------------------------ symbol bar */
  var SYMBOLS = [
    ["(", "()", 1], [")", ")", 0], ["[", "[]", 1], ["]", "]", 0], ['"', '""', 1],
    [":", ":", 0], ["=", " = ", 0], [",", ", ", 0], ["_", "_", 0], ["+", " + ", 0],
    ["#", "# ", 0], ["    ", "    ", 0]
  ];
  var bar = $("symbols");
  SYMBOLS.forEach(function (s) {
    var b = el("button", "", s[0] === "    " ? "tab" : s[0]);
    b.addEventListener("click", function (e) { e.preventDefault(); insert(s[1], s[2]); });
    bar.appendChild(b);
  });

  /* ------------------------------------------------------------ Skulpt */
  function builtinRead(x) {
    if (Sk.builtinFiles === undefined || Sk.builtinFiles["files"][x] === undefined) {
      throw "File not found: '" + x + "'";
    }
    return Sk.builtinFiles["files"][x];
  }
  function inputFun(promptText) {
    out(promptText || "", "ask");
    askRow.style.display = "flex";
    askInput.value = "";
    askInput.focus();
    return new Promise(function (resolve) {
      var sendBtn = $("asksend");
      function done() {
        var v = askInput.value;
        askRow.style.display = "none";
        askInput.removeEventListener("keydown", onKey);
        sendBtn.removeEventListener("click", done);
        out(v + "\n");
        resolve(v);
      }
      function onKey(e) { if (e.key === "Enter") { e.preventDefault(); done(); } }
      askInput.addEventListener("keydown", onKey);
      sendBtn.addEventListener("click", done);
    });
  }

  function resetCanvas() {
    $("turtle-canvas").innerHTML = "";
    plainView();                       // a new drawing always starts on the plain view
    if (window.Sk && Sk.TurtleGraphics && Sk.TurtleGraphics.reset) {
      try { Sk.TurtleGraphics.reset(); } catch (e) {}
    }
  }

  /* Flatten Skulpt's stacked turtle canvases into one white-backed image. JPEG
     keeps it small enough to live in localStorage beside the code. */
  function snapshot() {
    var cs = $("turtle-canvas").querySelectorAll("canvas");
    if (!cs.length) return null;
    var w = cs[0].width, h = cs[0].height;
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    var g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
    for (var k = 0; k < cs.length; k++) { try { g.drawImage(cs[k], 0, 0, w, h); } catch (e) {} }
    return c;
  }

  /* The whole canvas, for showing the drawing again when a student comes back
     to the step. */
  function fullImage(c) { return c ? c.toDataURL("image/jpeg", 0.85) : null; }

  /* The drawing cut down to what the student actually drew, for the PDF. A small
     shape in the middle of a 700 x 500 canvas would otherwise print as a dot in
     a big empty box. Ink is any pixel that is not near-white. */
  function croppedImage(c) {
    if (!c) return null;
    var w = c.width, h = c.height, d;
    try { d = c.getContext("2d").getImageData(0, 0, w, h).data; } catch (e) { return null; }
    var x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4;
        if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;                        // nothing drawn
    var pad = 24, minSide = 160;
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    var cw = x1 - x0, ch = y1 - y0;
    if (cw < minSide) { x0 -= (minSide - cw) / 2; cw = minSide; }
    if (ch < minSide) { y0 -= (minSide - ch) / 2; ch = minSide; }
    x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
    cw = Math.min(w - x0, Math.round(cw)); ch = Math.min(h - y0, Math.round(ch));
    var out = document.createElement("canvas");
    out.width = cw; out.height = ch;
    var g = out.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, cw, ch);
    g.drawImage(c, x0, y0, cw, ch, 0, 0, cw, ch);
    return {src: out.toDataURL("image/jpeg", 0.9), w: cw, h: ch};
  }

  var running = false, killed = false;

  function run() {
    var i = state.current, step = L.steps[i];
    if (running || step.kind !== "code" || predictBlocked(i)) return;
    running = true; killed = false;
    var token = ++runToken;
    clearConsole(); resetCanvas();
    matchEl.className = ""; matchEl.textContent = "";
    var buf = "";

    Sk.configure({
      output: function (t) { buf += t; out(t); },
      read: builtinRead,
      inputfun: inputFun,
      inputfunTakesPrompt: true,
      __future__: Sk.python3,
      execLimit: null,
      yieldLimit: 100
    });
    Sk.TurtleGraphics = Sk.TurtleGraphics || {};
    Sk.TurtleGraphics.target = "turtle-canvas";
    Sk.TurtleGraphics.width = 700;
    Sk.TurtleGraphics.height = 500;
    Sk.TurtleGraphics.animate = true;

    var code = codeEl.value;
    st(i).code = code;
    if (step.predict_first && !state.locked[step.predict_first]) {
      state.locked[step.predict_first] = true;
      var pta = $("q-" + step.predict_first);
      if (pta) {
        lockEl(pta);
        pta.parentNode.appendChild(el("p", "locknote", TX.locked));
      }
      save();
    }

    function finish(errMsg) {
      running = false;
      if (token !== runToken) return;          // the student moved to another step
      var s = st(i);
      s.ran = true;
      s.error = !!errMsg;
      s.errmsg = errMsg || "";
      s.output = buf + (errMsg ? (buf && !/\n$/.test(buf) ? "\n" : "") + errMsg : "");
      s.matched = step.expected != null ? (!errMsg && norm(buf) === norm(step.expected)) : null;
      showMatch(i);
      showExpected(i);
      var after = function () {
        if (step.turtle) {
          var snap = snapshot();
          s.drawing = fullImage(snap);
          s.crop = croppedImage(snap);
        }
        save();
        renderNav();
      };
      /* Let the last turtle frame paint before the picture is taken. */
      requestAnimationFrame(function () { requestAnimationFrame(function () { setTimeout(after, 120); }); });
    }

    Sk.misceval.asyncToPromise(
      function () { return Sk.importMainWithBody("<stdin>", false, code, true); },
      { "*": function () { if (killed) throw new Sk.builtin.SystemExit("stopped"); } }
    ).then(
      function () { finish(""); },
      function (err) {
        var msg = (err && err.toString) ? err.toString() : String(err);
        if (killed) msg = "-- stopped --";
        out((buf && !/\n$/.test(buf) ? "\n" : "") + msg + "\n", "err");
        finish(msg);
      }
    );
  }

  runBtn.addEventListener("click", run);
  $("stop").addEventListener("click", function () { killed = true; askRow.style.display = "none"; });
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); run(); }
  });

  /* ------------------------------------------------------------- HAND IN */
  /* jsPDF's built-in fonts only cover Latin-1. Anything outside it would print
     as rubbish, so it is swapped for the nearest plain character first. */
  function clean(s) {
    return String(s == null ? "" : s)
      .replace(/←/g, "<-").replace(/→/g, "->")
      .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
      .replace(/[–—]/g, "-").replace(/…/g, "...")
      .replace(/\t/g, "    ").replace(/\r/g, "")
      .replace(/[^\x00-\xFF]/g, "?");
  }

  function buildPdf() {
    var name = nameEl.value.trim();
    var doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4" });
    var M = 15, W = 210 - 2 * M, BOTTOM = 297 - 16, y = M;
    var PT = 0.3528;

    function need(h) { if (y + h > BOTTOM) { doc.addPage(); y = M; } }
    function text(s, size, style, font, indent) {
      font = font || "helvetica"; indent = indent || 0;
      doc.setFont(font, style || "normal");
      doc.setFontSize(size);
      var lh = size * PT * 1.3;
      var lines = [];
      clean(s).split("\n").forEach(function (raw) {
        if (font === "courier") {
          /* Code is wrapped by character count, never by word, so indentation
             survives. 9pt Courier fits 94 characters in 180mm. */
          var per = Math.floor((W - indent) / (size * PT * 0.6));
          if (raw.length === 0) lines.push("");
          for (var k = 0; k < raw.length; k += per) lines.push(raw.slice(k, k + per));
        } else {
          var parts = doc.splitTextToSize(raw, W - indent);
          if (!parts.length) parts = [""];
          lines = lines.concat(parts);
        }
      });
      lines.forEach(function (ln) { need(lh); doc.text(ln, M + indent, y + size * PT); y += lh; });
    }
    function gap(h) { y += h; }
    function rule() { need(3); doc.setDrawColor(200); doc.line(M, y, M + W, y); y += 3; }

    var now = new Date();
    var when = now.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) +
               ", " + now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

    var codeSteps = 0, matched = 0, hints = 0, qTotal = 0, qDone = 0, cvTotal = 0, cvRight = 0;
    L.steps.forEach(function (step, i) {
      var s = state.steps[String(i)] || {};
      if (step.kind === "convert") step.items.forEach(function (n, j) {
        cvTotal++; if ((s.conv || {})[j] === convAnswer(step, j)) cvRight++;
      });
      if (step.kind === "code" && step.expected != null) { codeSteps++; if (s.matched) matched++; }
      if (s.hint) hints++;
      (step.questions || []).forEach(function (q) { qTotal++; if (answered(q)) qDone++; });
    });

    doc.setTextColor(31, 111, 107);
    text("Epsom College Malaysia  |  Computer Science", 9, "bold");
    doc.setTextColor(34, 41, 43);
    text(L.year + ": " + L.title, 16, "bold");
    gap(1);
    text("Name: " + name, 11, "bold");
    text("Handed in: " + when, 10);
    text("Lesson page: " + location.origin + location.pathname, 9);
    gap(2);
    text("Steps with the expected output: " + matched + " of " + codeSteps +
         "     Questions answered: " + qDone + " of " + qTotal +
         "     Hints opened: " + hints +
         (cvTotal ? "     Conversions correct: " + cvRight + " of " + cvTotal : ""), 10, "bold");
    gap(2); rule();

    L.steps.forEach(function (step, i) {
      var s = state.steps[String(i)] || {};
      need(14);
      text(step.label === step.title ? step.title : step.label + ": " + step.title, 12, "bold");
      if (step.kind === "code") {
        var result;
        if (!s.ran) result = "Not run";
        else if (step.expected != null) result = s.matched ? "Output matched the expected output"
                                                           : "Output did not match the expected output";
        else result = s.error ? "Stopped with an error" : "Ran without an error";
        text("Result: " + result + (step.hint ? "     Hint opened: " + (s.hint ? "yes" : "no") : ""), 10);
      }
      if (step.kind === "convert") {
        var cv = s.conv || {}, tr = s.tries || {};
        step.items.forEach(function (n, j) {
          var shown = step.direction === "to_denary" ? toBin(n, step.bits) : String(n);
          var got = (cv[j] || "").trim(), ok = got === convAnswer(step, j);
          var how = ok ? (tr[j] ? "correct after " + tr[j] + " wrong " + (tr[j] === 1 ? "try" : "tries")
                                : "correct first time")
                       : (got ? "not correct" : "not answered");
          text((j + 1) + ".  " + shown + "  ->  " + (got || "(blank)") + "     " + how,
               10, "normal", "courier", 4);
        });
      }
      (step.questions || []).forEach(function (q) {
        gap(1);
        text(q.label + "  " + q.prompt, 10, "bold");
        if (q.code) text(q.code, 9, "normal", "courier", 4);
        var a = (state.answers[q.id] || "").trim();
        var tagged = state.locked[q.id] ? "  (prediction, locked before the code was run)" : "";
        text("Answer: " + (a || "(blank)") + tagged, 10, "normal", "helvetica", 4);
      });
      if (step.kind === "code") {
        gap(1.5);
        text("Code", 9, "bold");
        text(s.code != null ? s.code.replace(/\n+$/, "") : step.code, 9, "normal", "courier", 4);
        if (s.ran && norm(s.output || "")) {
          gap(1);
          text("Output", 9, "bold");
          var lines = norm(s.output || "").split("\n");
          var cut = lines.length > 60;
          text((cut ? lines.slice(0, 60) : lines).join("\n") + (cut ? "\n(output cut to 60 lines)" : ""),
               9, "normal", "courier", 4);
        }
        if (step.turtle && (s.crop || s.drawing)) {
          /* The student's own drawing, cut to what they drew and as large as fits
             in a 120 x 90 mm box. Older saves have only the full canvas. */
          var src = s.crop ? s.crop.src : s.drawing;
          var pw = s.crop ? s.crop.w : 700, ph = s.crop ? s.crop.h : 500;
          var scale = Math.min(120 / pw, 90 / ph);
          var iw = pw * scale, ih = ph * scale;
          gap(1.5); need(ih + 8);
          text("Drawing", 9, "bold");
          try { doc.addImage(src, "JPEG", M + 4, y, iw, ih); doc.setDrawColor(200); doc.rect(M + 4, y, iw, ih); }
          catch (e) {}
          y += ih + 2;
        }
      }
      gap(2); rule();
    });

    var n = doc.getNumberOfPages();
    for (var p = 1; p <= n; p++) {
      doc.setPage(p);
      doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(110);
      doc.text(clean(name + "  |  " + L.year + " " + L.short + "  |  page " + p + " of " + n), M, 297 - 8);
    }
    return doc;
  }

  function fileName() {
    var n = nameEl.value.trim().replace(/[^A-Za-z0-9 _-]/g, "").replace(/\s+/g, " ").trim() || "student";
    return L.year + " " + L.short + " - " + n + ".pdf";
  }

  $("handin").addEventListener("click", function () {
    if (!nameEl.value.trim()) {
      msgEl.textContent = "Type your name first.";
      nameEl.focus();
      return;
    }
    if (!window.jspdf || !window.jspdf.jsPDF) {
      msgEl.textContent = TX.noPdf;
      return;
    }
    save();
    var doc = buildPdf(), f = fileName();
    doc.save(f);
    msgEl.textContent = TX.saved(f);
  });

  /* Hooks for the automated browser test only. */
  window.__lesson = { state: function () { return state; }, go: go, run: run, buildPdf: buildPdf,
    applySplit: applySplit,
    applyRSplit: applyRSplit, sizeStage: sizeStage,
    fitView: fitView, plainView: plainView, view: function () { return view; },
                      isRunning: function () { return running; } };

  go(state.current);
  window.__lessonReady = true;
})();
