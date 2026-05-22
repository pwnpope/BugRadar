import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { bugClasses, difficulties, languages, providers } from "./data/options.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const generated = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

const publicChallenge = (challenge) => ({
  id: challenge.id,
  provider: challenge.provider,
  title: challenge.title,
  language: challenge.language,
  difficulty: challenge.difficulty,
  bugClassOptions: bugClasses,
  fileName: challenge.fileName,
  description: challenge.description,
  points: challenge.points,
  source: challenge.source,
  triggerScaffold: challenge.triggerScaffold
});

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function requireProvider(provider) {
  if (!providers.some((entry) => entry.id === provider)) {
    throw new Error("Choose Codex CLI or Claude CLI as the backend.");
  }
}

function challengeSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "title",
      "language",
      "difficulty",
      "bugClass",
      "fileName",
      "description",
      "points",
      "correctLines",
      "solution",
      "hints",
      "source",
      "triggerScaffold"
    ],
    properties: {
      title: { type: "string" },
      language: { type: "string", enum: languages },
      difficulty: { type: "string", enum: difficulties },
      bugClass: { type: "string", enum: bugClasses },
      fileName: { type: "string" },
      description: { type: "string" },
      points: { type: "integer", minimum: 50, maximum: 800 },
      correctLines: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1 },
      solution: { type: "string" },
      hints: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
      source: { type: "string" },
      triggerScaffold: {
        type: "object",
        additionalProperties: false,
        required: ["c", "python"],
        properties: {
          c: { type: "string" },
          python: { type: "string" }
        }
      }
    }
  };
}

function scoreSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["awarded", "percent", "verdict", "feedback", "correctLines", "bugClass", "sourceLocation"],
    properties: {
      awarded: { type: "integer", minimum: 0 },
      percent: { type: "integer", minimum: 0, maximum: 100 },
      verdict: { type: "string", enum: ["solved", "close", "missed"] },
      feedback: { type: "string" },
      correctLines: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1 },
      bugClass: { type: "string" },
      sourceLocation: { type: "string" }
    }
  };
}

function triggerScoreSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["awarded", "percent", "verdict", "feedback"],
    properties: {
      awarded: { type: "integer", minimum: 0, maximum: 100 },
      percent: { type: "integer", minimum: 0, maximum: 100 },
      verdict: { type: "string", enum: ["credible", "partial", "not_credible"] },
      feedback: { type: "string" }
    }
  };
}

function challengePrompt(filters) {
  return `Generate one BugRadar spot-the-bug challenge.

User-selected constraints:
- Language: ${filters.language === "random" ? "choose one from the allowed languages" : filters.language}
- Difficulty: ${filters.difficulty === "random" ? "choose one from easy, medium, hard, extreme" : filters.difficulty}
- Bug class: ${filters.bugClass === "random" ? "choose one from the allowed bug classes" : filters.bugClass}

Hard requirements:
- Source must be complete and runnable or compilable as a single file.
- Include the whole source file, not an excerpt.
- Do not reveal the answer in source comments, variable names, or prose visible to the player.
- correctLines must point to the primary vulnerable line or vulnerability-chain lines in source.
- solution must explain the bug mechanics in enough detail for scoring, but it will be hidden from the player until scoring.
- hints must be three progressive hints that do not directly reveal the exact line on the first hint.
- triggerScaffold must include C and Python starter code for exercising or triggering the bug. It can include TODO markers, but should be plausible and useful.
- For C, C++, Rust, and assembly, prefer realistic memory-safety, race, arithmetic, lifetime, or chained bugs.
- For PHP and Python, cover common web and scripting vulnerability classes when appropriate.
- Return only JSON matching the schema.`;
}

function answerScorePrompt(challenge, body) {
  return `Score this BugRadar answer.

Challenge metadata:
${JSON.stringify({
  title: challenge.title,
  language: challenge.language,
  difficulty: challenge.difficulty,
  fileName: challenge.fileName,
  points: challenge.points,
  bugClass: challenge.bugClass,
  correctLines: challenge.correctLines,
  hiddenSolution: challenge.solution
}, null, 2)}

Full source:
${challenge.source}

Player answer:
${JSON.stringify({
  line: body.line,
  bugClass: body.bugClass,
  explanation: body.explanation,
  hintsUsed: body.hintsUsed
}, null, 2)}

Scoring policy:
- Award 0 to ${challenge.points} points.
- Use the player's selected line, bug class, and explanation.
- Penalize roughly 10 percent per hint used.
- Treat vulnerability chains as source/root-cause/propagation/sink, not as a single magic line.
- A selected sink line, root-cause line, source line, or propagation line can be valid if the explanation ties it to the same vulnerability chain.
- If the player identifies a real secondary vulnerability in the source, award meaningful credit even if it is not the hidden primary finding. State that it is an alternate finding.
- Do not require the exact hidden bug class label when the explanation accurately describes the primitive with equivalent terminology.
- Give partial credit for identifying attacker control, a dangerous sink, or the bug class even when the exploit mechanics are incomplete.
- "solved" means the player identified a real vulnerability or chain and explained the primitive correctly.
- "close" means the player found a relevant source, sink, or bug class but missed an important link in the chain.
- "missed" means the answer does not demonstrate the bug.
- Feedback should be concise and useful.
- Feedback should explicitly distinguish root cause from sink when both are present.
- Return only JSON matching the schema.`;
}

function triggerScorePrompt(challenge, body) {
  return `Score this optional BugRadar trigger attempt.

Challenge metadata:
${JSON.stringify({
  title: challenge.title,
  language: challenge.language,
  fileName: challenge.fileName,
  bugClass: challenge.bugClass,
  correctLines: challenge.correctLines,
  hiddenSolution: challenge.solution
}, null, 2)}

Full vulnerable source:
${challenge.source}

Player trigger language: ${body.language}
Player trigger code:
${body.code}

Scoring policy:
- Award 0 to 100 bonus points.
- This is not expected to be a weaponized exploit. Score whether it credibly reaches, exercises, or demonstrates the bug.
- "credible" means the trigger is technically plausible for the supplied source.
- "partial" means it points in the right direction but misses an important setup condition.
- "not_credible" means it does not interact with the bug.
- Return only JSON matching the schema.`;
}

function extractJson(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    return fenced[1].trim();
  }

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (start === -1) {
      if (char === "{") {
        start = i;
        depth = 1;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(start, i + 1);
      }
    }
  }
  return trimmed;
}

function parseLlmJson(text) {
  return JSON.parse(extractJson(text));
}

function runCli(command, args, input, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: __dirname,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} exited with ${code}: ${(stderr || stdout).slice(0, 600)}`));
    });
    child.stdin.end(input);
  });
}

function buildStructuredPrompt({ schema, system, prompt }) {
  return `${system}

${prompt}

Return only strict JSON. Do not include markdown fences, commentary, or extra keys.

JSON schema:
${JSON.stringify(schema)}`;
}

async function callCodexCli(args) {
  const tempDir = await mkdtemp(join(tmpdir(), "bugradar-codex-"));
  const outputFile = join(tempDir, "response.json");
  const cliArgs = [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--output-last-message",
    outputFile
  ];
  if (process.env.BUGRADAR_CODEX_MODEL || process.env.CODEX_MODEL) {
    cliArgs.push("--model", process.env.BUGRADAR_CODEX_MODEL || process.env.CODEX_MODEL);
  }
  cliArgs.push("-");

  try {
    const fullPrompt = buildStructuredPrompt(args);
    const { stdout } = await runCli(process.env.BUGRADAR_CODEX_BIN || "codex", cliArgs, fullPrompt);
    let text = stdout;
    try {
      text = await readFile(outputFile, "utf8");
    } catch {
      // Codex still prints the final answer to stdout if the output file is unavailable.
    }
    return parseLlmJson(text);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function callClaudeCli(args) {
  const cliArgs = [
    "-p",
    "--output-format",
    "text",
    "--permission-mode",
    "dontAsk"
  ];
  if (process.env.BUGRADAR_CLAUDE_MODEL || process.env.CLAUDE_MODEL) {
    cliArgs.push("--model", process.env.BUGRADAR_CLAUDE_MODEL || process.env.CLAUDE_MODEL);
  }
  cliArgs.push(buildStructuredPrompt(args));
  const { stdout } = await runCli(process.env.BUGRADAR_CLAUDE_BIN || "claude", cliArgs, "");
  return parseLlmJson(stdout);
}

async function callLlm(provider, args) {
  requireProvider(provider);
  if (provider === "codex") {
    return callCodexCli(args);
  }
  return callClaudeCli(args);
}

function normalizeChallenge(challenge, provider) {
  const id = `${provider}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    ...challenge,
    id,
    provider,
    points: Number(challenge.points || 100),
    correctLines: challenge.correctLines.map(Number)
  };
}

async function generateChallenge(filters) {
  const provider = filters.provider || "codex";
  const challenge = normalizeChallenge(await callLlm(provider, {
    name: "bugradar_challenge",
    schema: challengeSchema(),
    system: "You generate technically accurate secure-code-review challenges for interview prep. Return JSON only.",
    prompt: challengePrompt(filters),
    maxOutputTokens: 5200
  }), provider);
  generated.set(challenge.id, challenge);
  return challenge;
}

async function scoreAnswer(challenge, body) {
  const result = await callLlm(challenge.provider, {
    name: "bugradar_answer_score",
    schema: scoreSchema(),
    system: "You are a strict but fair secure-code-review interviewer. Score only from the supplied hidden solution and source.",
    prompt: answerScorePrompt(challenge, body),
    maxOutputTokens: 1200
  });
  return {
    ...result,
    awarded: Math.max(0, Math.min(challenge.points, Number(result.awarded || 0))),
    percent: Math.max(0, Math.min(100, Number(result.percent || 0)))
  };
}

async function scoreTrigger(challenge, body) {
  const result = await callLlm(challenge.provider, {
    name: "bugradar_trigger_score",
    schema: triggerScoreSchema(),
    system: "You are evaluating whether a trigger program credibly exercises a vulnerability in a training challenge.",
    prompt: triggerScorePrompt(challenge, body),
    maxOutputTokens: 1000
  });
  return {
    ...result,
    awarded: Math.max(0, Math.min(100, Number(result.awarded || 0))),
    percent: Math.max(0, Math.min(100, Number(result.percent || 0)))
  };
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/options") {
    json(res, 200, { languages, difficulties, bugClasses, providers });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/challenges") {
    const body = await readJson(req);
    try {
      const challenge = await generateChallenge(body);
      json(res, 200, { challenge: publicChallenge(challenge), providerStatus: `Generated by ${challenge.provider}` });
    } catch (error) {
      json(res, 503, { error: error.message });
    }
    return;
  }

  const match = url.pathname.match(/^\/api\/challenges\/([^/]+)\/(score|hint|source|trigger-score)$/);
  if (!match) {
    json(res, 404, { error: "unknown API route" });
    return;
  }

  const challenge = generated.get(decodeURIComponent(match[1]));
  if (!challenge) {
    json(res, 404, { error: "challenge not found or server was restarted" });
    return;
  }

  const action = match[2];
  if (req.method === "POST" && action === "score") {
    try {
      json(res, 200, await scoreAnswer(challenge, await readJson(req)));
    } catch (error) {
      json(res, 503, { error: error.message });
    }
    return;
  }
  if (req.method === "POST" && action === "trigger-score") {
    try {
      json(res, 200, await scoreTrigger(challenge, await readJson(req)));
    } catch (error) {
      json(res, 503, { error: error.message });
    }
    return;
  }
  if (req.method === "GET" && action === "hint") {
    const index = Math.max(0, Math.min(challenge.hints.length - 1, Number(url.searchParams.get("level") || 0)));
    json(res, 200, { level: index + 1, hint: challenge.hints[index], penalty: 10 });
    return;
  }
  if (req.method === "GET" && action === "source") {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${challenge.fileName}"`
    });
    res.end(challenge.source);
    return;
  }

  json(res, 405, { error: "method not allowed" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url.pathname);
    }
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`BugRadar listening on http://${host}:${port}`);
});
