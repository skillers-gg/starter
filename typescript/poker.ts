#!/usr/bin/env npx tsx
/**
 * Skillers.gg Poker Agent — plays Heads-Up No-Limit Texas Hold'em via LLM.
 *
 * Quick start:
 *   export SKILLERS_API_KEY=sk_agent_xxx
 *   export OPENAI_API_KEY=sk-xxx        # or ANTHROPIC_API_KEY or GEMINI_API_KEY
 *   npx tsx typescript/poker.ts
 *
 * Customize your strategy by editing SYSTEM_PROMPT and buildPrompt().
 */

// ── Configuration ───────────────────────────────────────────────────────────
const API_URL      = process.env.SKILLERS_API_URL || "https://skillers.gg/api";
const API_KEY      = process.env.SKILLERS_API_KEY || "";
const LLM_PROVIDER = process.env.LLM_PROVIDER || "openai";    // "openai", "anthropic", "gemini"
const LLM_MODEL    = process.env.LLM_MODEL || "";
const POLL_MS      = 1000;

const DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-20250514",
  gemini: "gemini-2.5-flash",
};

// ── System prompt — tweak this to change your agent's personality ───────────
const SYSTEM_PROMPT = `You are an expert poker player competing in Heads-Up No-Limit Texas Hold'em.
You play aggressively with strong hands, bluff occasionally, and make mathematically sound decisions.
Consider hand strength, pot odds, position, and opponent tendencies.
Always respond with ONLY a JSON object — no explanation, no markdown.`;

// ── LLM Integration ────────────────────────────────────────────────────────

async function askLLM(prompt: string): Promise<string> {
  const model = LLM_MODEL || DEFAULT_MODELS[LLM_PROVIDER] || "gpt-4o";

  if (LLM_PROVIDER === "openai") {
    const key = process.env.OPENAI_API_KEY || "";
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 256, temperature: 0.3,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }] }),
    });
    const data = await res.json() as any;
    return data.choices[0].message.content.trim();
  }

  if (LLM_PROVIDER === "anthropic") {
    const key = process.env.ANTHROPIC_API_KEY || "";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 256, system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }] }),
    });
    const data = await res.json() as any;
    return data.content[0].text.trim();
  }

  if (LLM_PROVIDER === "gemini") {
    const key = process.env.GEMINI_API_KEY || "";
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 256, temperature: 0.3 } }) });
    const data = await res.json() as any;
    return data.candidates[0].content.parts[0].text.trim();
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

const headers = () => ({ Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" });

async function apiGet(path: string) {
  const r = await fetch(`${API_URL}${path}`, { headers: headers() });
  return r.json() as any;
}

async function apiPost(path: string, body: any) {
  const r = await fetch(`${API_URL}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  if (!r.ok) { const err = await r.json().catch(() => ({})) as any; throw Object.assign(new Error(err.error || r.statusText), { body: err }); }
  return r.json() as any;
}

async function apiPostRaw(path: string, body: any) {
  return fetch(`${API_URL}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
}

// ── Prompt builder ──────────────────────────────────────────────────────────

function buildPrompt(stateData: any): string {
  const s = stateData.state;
  const side = stateData.your_side;
  const myStack  = side === "a" ? s.stackA : s.stackB;
  const oppStack = side === "a" ? s.stackB : s.stackA;
  const myBet    = side === "a" ? (s.currentBetA || 0) : (s.currentBetB || 0);
  const oppBet   = side === "a" ? (s.currentBetB || 0) : (s.currentBetA || 0);
  const toCall   = oppBet - myBet;
  const isDealer = s.dealer === side;

  const history = (s.bettingHistory || []).slice(-8)
    .map((h: any) => `${h.side}:${h.action}${h.amount ? `(${h.amount})` : ""}`)
    .join(" ") || "none";

  return `Heads-Up No-Limit Hold'em — Hand #${s.handNumber || 1}, Stage: ${s.stage || "?"}
Position: ${isDealer ? "Dealer/SB" : "Big Blind"}
Hole cards: ${(s.holeCards || []).join(" ")}
Community:  ${(s.community || []).join(" ") || "(none)"}
Pot: ${s.pot || 0} | Your stack: ${myStack} | Opponent stack: ${oppStack}
To call: ${toCall > 0 ? toCall : "0 (no bet to match)"}
Recent actions: ${history}

Legal actions: ${toCall > 0 ? '"fold", "call", "raise"' : '"check", "raise"'}
For raise, amount is the TOTAL bet size (minimum raise = current bet + big blind).

Respond with ONLY one JSON object:
{"action": "fold"} or {"action": "check"} or {"action": "call"} or {"action": "raise", "amount": <number>}`;
}

// ── Move decision ───────────────────────────────────────────────────────────

async function decideMove(stateData: any): Promise<any> {
  const s = stateData.state;
  const side = stateData.your_side;
  const myBet  = side === "a" ? (s.currentBetA || 0) : (s.currentBetB || 0);
  const oppBet = side === "a" ? (s.currentBetB || 0) : (s.currentBetA || 0);
  const toCall = oppBet - myBet;

  try {
    const prompt = buildPrompt(stateData);
    const response = await askLLM(prompt);
    const move = parseJSON(response);
    if (move?.action) {
      if (move.action === "raise" && move.amount) move.amount = Math.max(1, Math.floor(move.amount));
      return move;
    }
  } catch (e: any) {
    console.log(`  LLM error: ${e.message}`);
  }

  return toCall > 0 ? { action: "call" } : { action: "check" };
}

// ── Game loop ───────────────────────────────────────────────────────────────

async function playGame(gameId: string) {
  let moves = 0;
  while (moves < 500) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const stateData = await apiGet(`/games/${gameId}/state`);

    if (stateData.status !== "active") {
      console.log(`\nGame ended: ${stateData.status}`);
      return;
    }
    if (!stateData.your_turn) { process.stdout.write("."); continue; }

    const move = await decideMove(stateData);
    const s = stateData.state;
    console.log(`\n  Hand ${s.handNumber || "?"} [${s.stage || "?"}] Cards: ${(s.holeCards||[]).join(" ")} Board: ${(s.community||[]).join(" ")} → ${JSON.stringify(move)}`);

    try {
      const result = await apiPost(`/games/${gameId}/move`, move);
      moves++;
      if (result.gameOver) { console.log(`\nGame over after ${moves} moves! Winner: ${result.winner_agent_id || "draw"}`); return; }
    } catch (e: any) {
      console.log(`\n  Move rejected: ${e.body?.error || e.message}`);
      for (const fallback of [{ action: "call" }, { action: "check" }, { action: "fold" }]) {
        try {
          const result = await apiPost(`/games/${gameId}/move`, fallback);
          moves++;
          if (result.gameOver) return;
          break;
        } catch { continue; }
      }
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) { console.log("Set SKILLERS_API_KEY env var. Get one at https://skillers.gg/docs"); process.exit(1); }

  const model = LLM_MODEL || DEFAULT_MODELS[LLM_PROVIDER] || "?";
  console.log(`Skillers Poker Agent — LLM: ${LLM_PROVIDER}/${model}`);

  const join = await apiPost("/games/join", { game_type: "poker", room_amount_cents: 0 });
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
