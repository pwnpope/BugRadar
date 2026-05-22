const state = {
  current: null,
  selectedLine: null,
  hintsUsed: 0,
  totalScore: Number(localStorage.getItem("bugradar-score") || 0),
  solved: new Set(JSON.parse(localStorage.getItem("bugradar-solved") || "[]"))
};

const els = {
  totalScore: document.querySelector("#totalScore"),
  difficulty: document.querySelector("#difficulty"),
  language: document.querySelector("#language"),
  bugClass: document.querySelector("#bugClass"),
  provider: document.querySelector("#provider"),
  answerBugClass: document.querySelector("#answerBugClass"),
  generateBtn: document.querySelector("#generateBtn"),
  providerStatus: document.querySelector("#providerStatus"),
  difficultyBadge: document.querySelector("#difficultyBadge"),
  languageBadge: document.querySelector("#languageBadge"),
  challengeTitle: document.querySelector("#challengeTitle"),
  challengeDescription: document.querySelector("#challengeDescription"),
  fileName: document.querySelector("#fileName"),
  downloadSourceBtn: document.querySelector("#downloadSourceBtn"),
  sourceView: document.querySelector("#sourceView"),
  lineInput: document.querySelector("#lineInput"),
  explanation: document.querySelector("#explanation"),
  submitBtn: document.querySelector("#submitBtn"),
  hintBtn: document.querySelector("#hintBtn"),
  hintBox: document.querySelector("#hintBox"),
  resultBox: document.querySelector("#resultBox"),
  triggerLanguage: document.querySelector("#triggerLanguage"),
  triggerCode: document.querySelector("#triggerCode"),
  validateTriggerBtn: document.querySelector("#validateTriggerBtn"),
  downloadTriggerBtn: document.querySelector("#downloadTriggerBtn"),
  triggerResult: document.querySelector("#triggerResult"),
  radarCanvas: document.querySelector("#radarCanvas")
};

function option(value, label = value) {
  const el = document.createElement("option");
  el.value = value;
  el.textContent = label;
  return el;
}

function setScore(score) {
  state.totalScore = score;
  localStorage.setItem("bugradar-score", String(score));
  els.totalScore.textContent = score.toLocaleString();
}

function persistSolved() {
  localStorage.setItem("bugradar-solved", JSON.stringify([...state.solved]));
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function highlightLine(line, language) {
  let html = escapeHtml(line);
  const tokens = new Map();
  const tokenKey = (index) => {
    let n = index;
    let key = "";
    do {
      key = String.fromCharCode(65 + (n % 26)) + key;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return key;
  };
  const stash = (value, className) => {
    const key = tokenKey(tokens.size);
    tokens.set(key, `<span class="${className}">${value}</span>`);
    return `\uE000${key}\uE001`;
  };

  html = html.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, (match) => stash(match, "tok-string"));

  if (["Python", "PHP"].includes(language)) {
    html = html.replace(/#.*/, (match) => stash(match, "tok-comment"));
  } else if (language.startsWith("Assembly")) {
    html = html.replace(/;.*/, (match) => stash(match, "tok-comment"));
  }
  html = html.replace(/\/\/.*/, (match) => stash(match, "tok-comment"));

  const commonKeywords = [
    "if", "else", "for", "while", "return", "break", "continue", "switch", "case", "default",
    "class", "struct", "enum", "typedef", "static", "const", "let", "mut", "unsafe", "fn",
    "public", "private", "function", "new", "delete", "try", "catch", "throw", "import", "from",
    "def", "with", "as", "match", "use", "namespace", "template", "typename", "sizeof"
  ];
  const typeWords = [
    "int", "char", "void", "size_t", "uint64_t", "uint32_t", "bool", "FILE", "String", "Vec",
    "usize", "u8", "i32", "i64", "std", "auto", "long", "short", "unsigned", "signed"
  ];
  const asmWords = ["mov", "sub", "add", "xor", "cmp", "lea", "call", "jmp", "ret", "syscall", "svc", "ldr", "str"];

  html = html.replace(/\b([A-Za-z_][\w:]*)\s*(?=\()/g, (match, name) => `${stash(name, "tok-fn")}${match.slice(name.length)}`);
  html = html.replace(new RegExp(`\\b(${commonKeywords.join("|")})\\b`, "g"), (match) => stash(match, "tok-keyword"));
  html = html.replace(new RegExp(`\\b(${typeWords.join("|")})\\b`, "g"), (match) => stash(match, "tok-type"));
  html = html.replace(new RegExp(`\\b(${asmWords.join("|")})\\b`, "gi"), (match) => stash(match, "tok-keyword"));
  html = html.replace(/\b(0x[0-9a-fA-F]+|\d+)\b/g, (match) => stash(match, "tok-number"));
  html = html.replace(/(\+=|-=|==|!=|<=|>=|=&gt;|-&gt;|::|[+\-*\/%=<>])/g, (match) => stash(match, "tok-op"));

  return html.replace(/\uE000([A-Z]+)\uE001/g, (_, key) => tokens.get(key));
}

function renderSource(source) {
  const lines = source.split("\n");
  els.sourceView.innerHTML = lines
    .map((line, index) => {
      const lineNo = index + 1;
      return `<code class="sourceLine" data-line="${lineNo}"><span class="lineNo">${lineNo}</span><span class="lineCode">${highlightLine(line, state.current?.language || "") || " "}</span></code>`;
    })
    .join("");
}

function selectLine(line) {
  state.selectedLine = line;
  els.lineInput.value = line;
  document.querySelectorAll(".sourceLine.selected").forEach((el) => el.classList.remove("selected"));
  document.querySelector(`.sourceLine[data-line="${line}"]`)?.classList.add("selected");
}

function resetPanels() {
  state.hintsUsed = 0;
  state.selectedLine = null;
  els.lineInput.value = "";
  els.explanation.value = "";
  els.hintBox.hidden = true;
  els.hintBox.textContent = "";
  els.resultBox.hidden = true;
  els.resultBox.className = "resultBox";
  els.resultBox.textContent = "";
  els.triggerResult.hidden = true;
  els.triggerResult.textContent = "";
}

function setBusy(button, busy, label) {
  if (!button.dataset.idleLabel) {
    button.dataset.idleLabel = button.textContent;
  }
  button.disabled = busy;
  button.classList.toggle("isBusy", busy);
  button.textContent = busy ? label : button.dataset.idleLabel;
}

function setTriggerScaffold() {
  if (!state.current) {
    return;
  }
  const language = els.triggerLanguage.value;
  els.triggerCode.value = state.current.triggerScaffold?.[language] || "";
}

function renderChallenge(challenge, providerStatus) {
  state.current = challenge;
  resetPanels();
  els.providerStatus.textContent = providerStatus;
  els.difficultyBadge.textContent = challenge.difficulty;
  els.languageBadge.textContent = challenge.language;
  els.challengeTitle.textContent = challenge.title;
  els.challengeDescription.textContent = challenge.description;
  els.fileName.textContent = challenge.fileName;
  renderSource(challenge.source);
  setTriggerScaffold();
  els.downloadSourceBtn.disabled = false;
  els.submitBtn.disabled = false;
  els.hintBtn.disabled = false;
  els.validateTriggerBtn.disabled = false;
  els.downloadTriggerBtn.disabled = false;
}

async function loadOptions() {
  const res = await fetch("/api/options");
  const options = await res.json();

  els.difficulty.append(option("random", "Random"));
  options.difficulties.forEach((difficulty) => els.difficulty.append(option(difficulty)));

  els.language.append(option("random", "Random"));
  options.languages.forEach((language) => els.language.append(option(language)));

  els.bugClass.append(option("random", "Random"));
  options.bugClasses.forEach((bugClass) => els.bugClass.append(option(bugClass)));
  options.bugClasses.forEach((bugClass) => els.answerBugClass.append(option(bugClass)));

  els.provider.innerHTML = "";
  options.providers.forEach((provider) => els.provider.append(option(provider.id, provider.label)));
}

async function generateChallenge() {
  els.generateBtn.disabled = true;
  els.providerStatus.textContent = "Generating...";
  els.providerStatus.classList.remove("error");
  try {
    const res = await fetch("/api/challenges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        difficulty: els.difficulty.value,
        language: els.language.value,
        bugClass: els.bugClass.value,
        provider: els.provider.value
      })
    });
    const payload = await res.json();
    if (!res.ok) {
      throw new Error(payload.error || "Generation failed");
    }
    renderChallenge(payload.challenge, payload.providerStatus);
  } catch (error) {
    els.providerStatus.textContent = error.message;
    els.providerStatus.classList.add("error");
  } finally {
    els.generateBtn.disabled = false;
  }
}

async function requestHint() {
  if (!state.current) {
    return;
  }
  const res = await fetch(`/api/challenges/${encodeURIComponent(state.current.id)}/hint?level=${state.hintsUsed}`);
  const hint = await res.json();
  state.hintsUsed += 1;
  els.hintBox.hidden = false;
  els.hintBox.textContent = `Hint ${hint.level}: ${hint.hint} (-${hint.penalty} points)`;
}

async function submitAnswer() {
  if (!state.current) {
    return;
  }
  setBusy(els.submitBtn, true, "Scoring...");
  els.resultBox.hidden = false;
  els.resultBox.className = "resultBox pending";
  els.resultBox.textContent = "Scoring with the selected CLI...";
  try {
    const res = await fetch(`/api/challenges/${encodeURIComponent(state.current.id)}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        line: els.lineInput.value,
        bugClass: els.answerBugClass.value,
        explanation: els.explanation.value,
        hintsUsed: state.hintsUsed
      })
    });
    const result = await res.json();
    if (!res.ok) {
      els.resultBox.className = "resultBox missed";
      els.resultBox.textContent = result.error || "Scoring failed";
      return;
    }
    els.resultBox.className = `resultBox ${result.verdict === "missed" ? "missed" : ""}`;
    els.resultBox.innerHTML = `<strong>${result.verdict.toUpperCase()}:</strong> ${result.awarded}/${state.current.points} points<br>
      <strong>Location:</strong> ${escapeHtml(result.sourceLocation)}<br>
      <strong>Class:</strong> ${escapeHtml(result.bugClass)}<br>
      ${escapeHtml(result.feedback)}`;

    if (!state.solved.has(state.current.id) && result.awarded > 0) {
      state.solved.add(state.current.id);
      persistSolved();
      setScore(state.totalScore + result.awarded);
    }
  } finally {
    setBusy(els.submitBtn, false);
  }
}

async function validateTrigger() {
  if (!state.current) {
    return;
  }
  setBusy(els.validateTriggerBtn, true, "Validating...");
  els.triggerResult.hidden = false;
  els.triggerResult.className = "resultBox compact pending";
  els.triggerResult.textContent = "Checking trigger plausibility with the selected CLI...";
  try {
    const res = await fetch(`/api/challenges/${encodeURIComponent(state.current.id)}/trigger-score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: els.triggerLanguage.value,
        code: els.triggerCode.value
      })
    });
    const result = await res.json();
    if (!res.ok) {
      els.triggerResult.className = "resultBox compact missed";
      els.triggerResult.textContent = result.error || "Trigger scoring failed";
      return;
    }
    els.triggerResult.className = `resultBox compact ${result.verdict === "not_credible" ? "missed" : ""}`;
    els.triggerResult.textContent = `Trigger ${result.verdict}: ${result.percent}%. Bonus: ${result.awarded} points. ${result.feedback}`;
    const bonusId = `${state.current.id}:trigger:${els.triggerLanguage.value}`;
    if (!state.solved.has(bonusId) && result.awarded > 0) {
      state.solved.add(bonusId);
      persistSolved();
      setScore(state.totalScore + result.awarded);
    }
  } finally {
    setBusy(els.validateTriggerBtn, false);
  }
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function drawRadar() {
  const canvas = els.radarCanvas;
  const ctx = canvas.getContext("2d");
  let angle = 0;

  function frame() {
    const { width, height } = canvas;
    const cx = width / 2;
    const cy = height / 2;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#151515";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(233, 246, 244, 0.24)";
    ctx.lineWidth = 1;
    for (let radius = 16; radius <= 42; radius += 14) {
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx, 6);
    ctx.lineTo(cx, height - 6);
    ctx.moveTo(6, cy);
    ctx.lineTo(width - 6, cy);
    ctx.stroke();

    const sweep = ctx.createLinearGradient(cx, cy, cx + Math.cos(angle) * 42, cy + Math.sin(angle) * 42);
    sweep.addColorStop(0, "rgba(23, 116, 109, 0.85)");
    sweep.addColorStop(1, "rgba(184, 36, 47, 0)");
    ctx.strokeStyle = sweep;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * 42, cy + Math.sin(angle) * 42);
    ctx.stroke();

    ctx.fillStyle = "#c9861a";
    ctx.beginPath();
    ctx.arc(cx + 18, cy - 12, 3, 0, Math.PI * 2);
    ctx.arc(cx - 24, cy + 16, 2.5, 0, Math.PI * 2);
    ctx.fill();

    angle += 0.025;
    requestAnimationFrame(frame);
  }

  frame();
}

els.sourceView.addEventListener("click", (event) => {
  const line = event.target.closest(".sourceLine")?.dataset.line;
  if (line) {
    selectLine(Number(line));
  }
});

els.lineInput.addEventListener("input", () => {
  const line = Number(els.lineInput.value);
  if (Number.isFinite(line)) {
    selectLine(line);
  }
});

els.generateBtn.addEventListener("click", generateChallenge);
els.hintBtn.addEventListener("click", requestHint);
els.submitBtn.addEventListener("click", submitAnswer);
els.validateTriggerBtn.addEventListener("click", validateTrigger);
els.triggerLanguage.addEventListener("change", setTriggerScaffold);
els.downloadSourceBtn.addEventListener("click", () => {
  if (state.current) {
    downloadText(state.current.fileName, state.current.source);
  }
});
els.downloadTriggerBtn.addEventListener("click", () => {
  const extension = els.triggerLanguage.value === "c" ? "c" : "py";
  downloadText(`trigger.${extension}`, els.triggerCode.value);
});

setScore(state.totalScore);
drawRadar();
loadOptions();
