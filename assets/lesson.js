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
      r.appendChild(el("b", "", "Remember: "));
      r.appendChild(document.createTextNode(step.remember));
      cardEl.appendChild(r);
    }
    (step.intro || []).forEach(function (t) { cardEl.appendChild(el("p", "", t)); });

    if (step.table) {
      var t = el("table", "idx"), tr = el("tr");
      step.table.headers.forEach(function (h) { tr.appendChild(el("th", "", h)); });
      t.appendChild(tr);
      step.table.rows.forEach(function (row) {
        var r2 = el("tr");
        row.forEach(function (c) { r2.appendChild(el("td", "", c)); });
        t.appendChild(r2);
      });
      cardEl.appendChild(t);
    }
    if (step.readonly) cardEl.appendChild(el("pre", "show", step.readonly));

    (step.questions || []).forEach(function (q) {
      var box = el("div", "q");
      box.appendChild(el("span", "qlabel", q.label));
      box.appendChild(el("span", "qprompt", q.prompt));
      if (q.code) box.appendChild(el("pre", "show", q.code));
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
      if (state.locked[q.id]) box.appendChild(el("p", "locknote", "Locked when Run was pressed."));
      cardEl.appendChild(box);
    });

    if (step.kind === "code" && step.expected == null && step.turtle) {
      cardEl.appendChild(el("p", "", "This step draws a picture. There is no text output to check."));
    }
    if (step.predict_first) {
      var pn = el("p", "predict-note", "");
      pn.id = "predict-note";
      cardEl.appendChild(pn);
    }
    if (step.hint) {
      var d = el("details", "hint");
      d.appendChild(el("summary", "", "Hint"));
      d.appendChild(el("p", "", step.hint));
      if (st(i).hint) d.open = true;
      d.addEventListener("toggle", function () {
        if (d.open && !st(i).hint) { st(i).hint = true; save(); }
      });
      cardEl.appendChild(d);
    }
    cardEl.scrollTop = 0;
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
      pn.textContent = blocked ? "Run is switched off until " + (q ? q.label : "the prediction") + " has an answer." : "";
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
      matchEl.textContent = s.matched ? "Matches the expected output"
                                      : "Does not match the expected output";
    } else if (s.error) {
      matchEl.className = "no";
      matchEl.textContent = "Stopped with an error";
    }
  }

  /* The expected output stays hidden until the step has been run once, so it is
     never on screen before the student has attempted the step. */
  function showExpected(i) {
    var step = L.steps[i], s = state.steps[String(i)] || {}, box = $("expected");
    if (step.expected == null) { box.textContent = ""; return; }
    box.textContent = s.ran ? step.expected : "Shown after you run the code once.";
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
      $("reset").textContent = "Reset this step";
    }
    renderCard(i);
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
      b.textContent = "Tap again to reset";
      resetTimer = setTimeout(function () { resetArmed = false; b.textContent = "Reset this step"; }, 3000);
      return;
    }
    clearTimeout(resetTimer);
    resetArmed = false;
    b.textContent = "Reset this step";
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
    return c.toDataURL("image/jpeg", 0.85);
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
        pta.readOnly = true;
        pta.classList.add("locked");
        pta.parentNode.appendChild(el("p", "locknote", "Locked when Run was pressed."));
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
        if (step.turtle) s.drawing = snapshot();
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

    var codeSteps = 0, matched = 0, hints = 0, qTotal = 0, qDone = 0;
    L.steps.forEach(function (step, i) {
      var s = state.steps[String(i)] || {};
      if (step.kind === "code" && step.expected != null) { codeSteps++; if (s.matched) matched++; }
      if (s.hint) hints++;
      (step.questions || []).forEach(function (q) { qTotal++; if (answered(q)) qDone++; });
    });

    doc.setTextColor(31, 111, 107);
    text("Epsom College Malaysia  |  KS3 Computer Science", 9, "bold");
    doc.setTextColor(34, 41, 43);
    text(L.year + ": " + L.title, 16, "bold");
    gap(1);
    text("Name: " + name, 11, "bold");
    text("Handed in: " + when, 10);
    text("Lesson page: " + location.origin + location.pathname, 9);
    gap(2);
    text("Steps with the expected output: " + matched + " of " + codeSteps +
         "     Questions answered: " + qDone + " of " + qTotal +
         "     Hints opened: " + hints, 10, "bold");
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
        if (step.turtle && s.drawing) {
          var iw = 110, ih = iw * 5 / 7;
          gap(1.5); need(ih + 8);
          text("Drawing", 9, "bold");
          try { doc.addImage(s.drawing, "JPEG", M + 4, y, iw, ih); doc.setDrawColor(200); doc.rect(M + 4, y, iw, ih); }
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
      msgEl.textContent = "The PDF tool did not load. Reload the page and try again.";
      return;
    }
    save();
    var doc = buildPdf(), f = fileName();
    doc.save(f);
    msgEl.textContent = "Saved as \"" + f + "\". Upload it to this lesson's Google Classroom assignment.";
  });

  /* Hooks for the automated browser test only. */
  window.__lesson = { state: function () { return state; }, go: go, run: run, buildPdf: buildPdf,
                      isRunning: function () { return running; } };

  go(state.current);
  window.__lessonReady = true;
})();
