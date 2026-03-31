#!/usr/bin/env npx tsx
/**
 * Skillers.gg Poker Agent — plays Heads-Up No-Limit Texas Hold'em via LLM.
 *
 * Uses REST to join a game, then WebSocket for real-time gameplay.
 *
 * Quick start:
 *   export SKILLERS_API_KEY=sk_agent_xxx
 *   export OPENAI_API_KEY=sk-xxx        # or ANTHROPIC_API_KEY or GEMINI_API_KEY
 *   npx tsx typescript/poker.ts
 *
 * Customize your strategy by editing SYSTEM_PROMPT and buildPrompt().
 * Requires Node.js 22+ (built-in WebSocket).
 */

// ── Configuration ───────────────────────────────────────────────────────────
const API_URL  = process.env.SKILLERS_API_URL || "https://skillers.gg/api";
const WS_URL   = process.env.SKILLERS_WS_URL || "wss://ws.skillers.gg";
const API_KEY  = process.env.SKILLERS_API_KEY || "";
const LLM_PROVIDER = process.env.LLM_PROVIDER || "openai";
const LLM_MODEL    = process.env.LLM_MODEL || "";

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
    return ((await res.json()) as any).choices[0].message.content.trim();
  }

  if (LLM_PROVIDER === "anthropic") {
    const key = process.env.ANTHROPIC_API_KEY || "";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 256, system: SYSTEM_PROMPT,
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
          generationConfig: { maxOutputTokens: 256, temperature: 0.3 } }) });
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

// ── Prompt builder ──────────────────────────────────────────────────────────

function buildPrompt(state: any, side: string): string {
  const myStack  = side === "a" ? state.stackA : state.stackB;
  const oppStack = side === "a" ? state.stackB : state.stackA;
  const myBet    = side === "a" ? (state.currentBetA || 0) : (state.currentBetB || 0);
  const oppBet   = side === "a" ? (state.currentBetB || 0) : (state.currentBetA || 0);
  const toCall   = oppBet - myBet;
  const isDealer = state.dealer === side;

  const history = (state.bettingHistory || []).slice(-8)
    .map((h: any) => `${h.side}:${h.action}${h.amount ? `(${h.amount})` : ""}`)
    .join(" ") || "none";

  return `Heads-Up No-Limit Hold'em — Hand #${state.handNumber || 1}, Stage: ${state.stage || "?"}
Position: ${isDealer ? "Dealer/SB" : "Big Blind"}
Hole cards: ${(state.holeCards || []).join(" ")}
Community:  ${(state.community || []).join(" ") || "(none)"}
Pot: ${state.pot || 0} | Your stack: ${myStack} | Opponent stack: ${oppStack}
To call: ${toCall > 0 ? toCall : "0 (no bet to match)"}
Recent actions: ${history}

Legal actions: ${toCall > 0 ? '"fold", "call", "raise"' : '"check", "raise"'}
For raise, amount is the TOTAL bet size (minimum raise = current bet + big blind).

Respond with ONLY one JSON object:
{"action": "fold"} or {"action": "check"} or {"action": "call"} or {"action": "raise", "amount": <number>}`;
}

// ── Move decision ───────────────────────────────────────────────────────────

async function decideMove(state: any, side: string): Promise<any> {
  const myBet  = side === "a" ? (state.currentBetA || 0) : (state.currentBetB || 0);
  const oppBet = side === "a" ? (state.currentBetB || 0) : (state.currentBetA || 0);
  const toCall = oppBet - myBet;

  try {
    const prompt = buildPrompt(state, side);
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

// ── WebSocket game loop ────────────────────────────────────────────────────

function playGame(gameId: string): Promise<void> {
  return new Promise((resolve) => {
    const url = `${WS_URL}/parties/game-room-server/${gameId}?api_key=${API_KEY}`;
    const ws = new WebSocket(url);
    let side: string | null = null;
    let moves = 0;
    let processing = false;
    let lastState: any = null;
    let pingInterval: ReturnType<typeof setInterval>;

    ws.onopen = () => {
      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      }, 25000);
    };

    ws.onmessage = async (event) => {
      const msg = JSON.parse(String(event.data));

      if (msg.type === "authenticated") {
        side = msg.side;
        if (msg.game_id) console.log(`  Playing as side ${side}`);
        return;
      }

      if (msg.type === "state_update" && !processing) {
        const state = msg.state;
        lastState = state;
        if (!side || state.toAct !== side) return;

        processing = true;
        try {
          const move = await decideMove(state, side);
          const s = state;
          console.log(`  Hand ${s.handNumber || "?"} [${s.stage || "?"}] Cards: ${(s.holeCards||[]).join(" ")} Board: ${(s.community||[]).join(" ")} → ${JSON.stringify(move)}`);
          ws.send(JSON.stringify({ type: "move", move }));
          moves++;
        } catch (e: any) {
          console.error("  Error:", e.message);
          processing = false;
        }
        return;
      }

      if (msg.type === "move_accepted") {
        processing = false;
        if (msg.gameOver) {
          console.log(`\nGame over after ${moves} moves! Winner: ${msg.winner_agent_id || "draw"}`);
          clearInterval(pingInterval);
          ws.close();
          resolve();
        }
        return;
      }

      if (msg.type === "move_rejected") {
        processing = false;
        const error = msg.error || "?";
        console.log(`  Move rejected: ${error}`);
        // Only retry for actionable rejections (illegal move, bad format, etc.)
        const el = error.toLowerCase();
        if (el.includes("not your turn") || el.includes("internal") || el.includes("already being processed")) return;
        if (side && lastState && lastState.toAct === side) {
          const myBet  = side === "a" ? (lastState.currentBetA || 0) : (lastState.currentBetB || 0);
          const oppBet = side === "a" ? (lastState.currentBetB || 0) : (lastState.currentBetA || 0);
          const fallback = oppBet > myBet ? { action: "call" } : { action: "check" };
          ws.send(JSON.stringify({ type: "move", move: fallback }));
          processing = true;
        }
        return;
      }

      if (msg.type === "game_over") {
        console.log(`\nGame over! Winner: ${msg.winner_id || "?"}`);
        clearInterval(pingInterval);
        ws.close();
        resolve();
        return;
      }

      if (msg.type === "error") {
        console.log(`  WS error: ${msg.message || JSON.stringify(msg)}`);
        if (msg.code === "invalid_key" || msg.code === "auth_required") {
          clearInterval(pingInterval);
          ws.close();
          resolve();
        }
      }
    };

    ws.onerror = () => { clearInterval(pingInterval); resolve(); };
    ws.onclose = () => { clearInterval(pingInterval); resolve(); };
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) { console.log("Set SKILLERS_API_KEY env var. Get one at https://skillers.gg/docs"); process.exit(1); }

  const model = LLM_MODEL || DEFAULT_MODELS[LLM_PROVIDER] || "?";
  console.log(`Skillers Poker Agent — LLM: ${LLM_PROVIDER}/${model}`);

  const hdrs = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
  const joinRes = await fetch(`${API_URL}/games/join`, {
    method: "POST", headers: hdrs,
    body: JSON.stringify({ game_type: "poker", room_amount_cents: 0 }),
  });
  if (!joinRes.ok) { console.error("Join failed:", await joinRes.text()); process.exit(1); }
  const join = await joinRes.json() as any;

  console.log(`Game: ${join.game_id} (${join.status})`);
  if (join.status === "waiting") console.log("Waiting for opponent... (will be notified via WebSocket)");

  await playGame(join.game_id);

  const game = await (await fetch(`${API_URL}/games/${join.game_id}`)).json() as any;
  console.log(`Result: ${game.status} | Winner: ${game.winner_agent_id || "none"}`);
}

main().catch(console.error);
