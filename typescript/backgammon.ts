#!/usr/bin/env npx tsx
/**
 * Skillers.gg Backgammon Agent — plays Backgammon via LLM.
 *
 * Quick start:
 *   export SKILLERS_API_KEY=sk_agent_xxx
 *   export OPENAI_API_KEY=sk-xxx        # or ANTHROPIC_API_KEY or GEMINI_API_KEY
 *   npx tsx typescript/backgammon.ts
 *
 * The server provides all legal moves — your LLM just picks the best one.
 * Customize strategy by editing SYSTEM_PROMPT and buildPrompt().
 */

// ── Configuration ───────────────────────────────────────────────────────────
const API_URL      = process.env.SKILLERS_API_URL || "https://skillers.gg/api";
const API_KEY      = process.env.SKILLERS_API_KEY || "";
const LLM_PROVIDER = process.env.LLM_PROVIDER || "openai";
const LLM_MODEL    = process.env.LLM_MODEL || "";
const POLL_MS      = 1000;

const DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-20250514",
  gemini: "gemini-2.5-flash",
};

const SYSTEM_PROMPT = `You are an expert backgammon player. You receive a board position, dice roll, and
a numbered list of legal move sequences. Pick the best option by number.
Prioritize: hitting opponent blots, advancing to home board, bearing off, building primes.
Respond with ONLY a JSON object like {"index": 3} — no explanation.`;

// ── LLM Integration ────────────────────────────────────────────────────────

async function askLLM(prompt: string): Promise<string> {
  const model = LLM_MODEL || DEFAULT_MODELS[LLM_PROVIDER] || "gpt-4o";

  if (LLM_PROVIDER === "openai") {
    const key = process.env.OPENAI_API_KEY || "";
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 64, temperature: 0.2,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }] }),
    });
    return ((await res.json()) as any).choices[0].message.content.trim();
  }

  if (LLM_PROVIDER === "anthropic") {
    const key = process.env.ANTHROPIC_API_KEY || "";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 64, system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }] }),
    });
    return ((await res.json()) as any).content[0].text.trim();
  }

  if (LLM_PROVIDER === "gemini") {
    const key = process.env.GEMINI_API_KEY || "";
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 64, temperature: 0.2 } }) });
    return ((await res.json()) as any).candidates[0].content.parts[0].text.trim();
  }

  throw new Error(`Unknown LLM_PROVIDER: ${LLM_PROVIDER}`);
}

function parseJSON(text: string): any | null {
  text = text.replace(/```(?:json)?\s*\n?([\s\S]*?)```/g, "$1").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch {}
  return null;
}

// ── Skillers API ────────────────────────────────────────────────────────────

const hdrs = () => ({ Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" });

async function apiGet(path: string) {
  const r = await fetch(`${API_URL}${path}`, { headers: hdrs() });
  return r.json() as any;
}

async function apiPost(path: string, body: any) {
  const r = await fetch(`${API_URL}${path}`, { method: "POST", headers: hdrs(), body: JSON.stringify(body) });
  if (!r.ok) { const err = await r.json().catch(() => ({})) as any; throw Object.assign(new Error(err.error || r.statusText), { body: err }); }
  return r.json() as any;
}

// ── Prompt builder ──────────────────────────────────────────────────────────

function buildPrompt(stateData: any): string {
  const s = stateData.state;
  const side = stateData.your_side;
  const legal: number[][][] = s.legalMoves || [];

  const boardLines: string[] = [];
  for (let i = 0; i < (s.board as number[]).length; i++) {
    const v = s.board[i];
    if (v !== 0) {
      const owner = (v > 0 && side === "a") || (v < 0 && side === "b") ? "You" : "Opp";
      boardLines.push(`  Pt ${i+1}: ${Math.abs(v)} ${owner}`);
    }
  }

  const myBar  = side === "a" ? s.barA : s.barB;
  const oppBar = side === "a" ? s.barB : s.barA;
  const myOff  = side === "a" ? s.borneOffA : s.borneOffB;
  const oppOff = side === "a" ? s.borneOffB : s.borneOffA;
  const dir    = side === "a" ? "24→1, bear off from points 1-6" : "1→24, bear off from points 19-24";

  const options = legal.slice(0, 20).map((m, i) => `  ${i}: ${JSON.stringify(m)}`).join("\n");
  const extra = legal.length > 20 ? `\n  ... and ${legal.length - 20} more` : "";

  return `Backgammon — you are side ${side} (moving ${dir}).
Dice: ${s.dice[0]}, ${s.dice[1]}

Board:
${boardLines.length ? boardLines.join("\n") : "  (empty)"}
Bar: You=${myBar}, Opponent=${oppBar}
Borne off: You=${myOff}, Opponent=${oppOff}

Legal moves (pick one by index):
${options}${extra}

Reply with ONLY: {"index": <number>}`;
}

// ── Move decision ───────────────────────────────────────────────────────────

async function decideMove(stateData: any): Promise<any> {
  const legal: number[][][] = stateData.state.legalMoves || [];

  if (!legal.length || (legal.length === 1 && legal[0].length === 0)) {
    return { moves: [] };
  }

  try {
    const prompt = buildPrompt(stateData);
    const response = await askLLM(prompt);
    const parsed = parseJSON(response);
    if (parsed?.index !== undefined) {
      const idx = parseInt(parsed.index);
      if (idx >= 0 && idx < legal.length) return { moves: legal[idx] };
    }
  } catch (e: any) {
    console.log(`  LLM error: ${e.message}`);
  }

  return { moves: legal[0] };
}

// ── Game loop ───────────────────────────────────────────────────────────────

async function playGame(gameId: string) {
  let moves = 0;
  while (moves < 500) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const stateData = await apiGet(`/games/${gameId}/state`);

    if (stateData.status !== "active") { console.log(`\nGame ended: ${stateData.status}`); return; }
    if (!stateData.your_turn) { process.stdout.write("."); continue; }

    const move = await decideMove(stateData);
    console.log(`\n  Dice: ${stateData.state.dice} → ${JSON.stringify(move)}`);

    try {
      const result = await apiPost(`/games/${gameId}/move`, move);
      moves++;
      if (result.gameOver) { console.log(`\nGame over after ${moves} moves! Gammon: ${result.isGammon || false}`); return; }
    } catch (e: any) {
      console.log(`\n  Move rejected: ${e.body?.error || e.message}`);
      const legal = stateData.state.legalMoves || [];
      if (legal.length && legal[0].length) {
        try { const r = await apiPost(`/games/${gameId}/move`, { moves: legal[0] }); moves++; if (r.gameOver) return; } catch {}
      }
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) { console.log("Set SKILLERS_API_KEY env var. Get one at https://skillers.gg/docs"); process.exit(1); }

  const model = LLM_MODEL || DEFAULT_MODELS[LLM_PROVIDER] || "?";
  console.log(`Skillers Backgammon Agent — LLM: ${LLM_PROVIDER}/${model}`);

  const join = await apiPost("/games/join", { game_type: "backgammon", room_amount_cents: 0 });
  console.log(`Game: ${join.game_id} (${join.status})`);

  if (join.status === "waiting") {
    console.log("Waiting for opponent...");
    while (true) {
      await new Promise(r => setTimeout(r, 2000));
      const s = await apiGet(`/games/${join.game_id}/state`);
      if (s.status === "active") { console.log("Matched!"); break; }
      if (s.status && s.status !== "waiting") { console.log(`Game cancelled: ${s.status}`); return; }
    }
  }

  await playGame(join.game_id);

  const game = await (await fetch(`${API_URL}/games/${join.game_id}`)).json() as any;
  console.log(`Result: ${game.status} | Winner: ${game.winner_agent_id || "none"}`);
}

main().catch(console.error);
