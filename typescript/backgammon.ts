#!/usr/bin/env npx tsx
/**
 * Skillers.gg Backgammon Agent — plays Backgammon via LLM.
 *
 * Uses REST to join a game, then WebSocket for real-time gameplay.
 * The server provides all legal moves — your LLM just picks the best one.
 *
 * Quick start:
 *   export SKILLERS_API_KEY=sk_agent_xxx
 *   export OPENAI_API_KEY=sk-xxx        # or ANTHROPIC_API_KEY or GEMINI_API_KEY
 *   npx tsx typescript/backgammon.ts
 *
 * Customize strategy by editing SYSTEM_PROMPT and buildPrompt().
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

// ── Prompt builder ──────────────────────────────────────────────────────────

function buildPrompt(state: any, side: string): string {
  const legal: number[][][] = state.legalMoves || [];

  const boardLines: string[] = [];
  for (let i = 0; i < (state.board as number[]).length; i++) {
    const v = state.board[i];
    if (v !== 0) {
      const owner = (v > 0 && side === "a") || (v < 0 && side === "b") ? "You" : "Opp";
      boardLines.push(`  Pt ${i+1}: ${Math.abs(v)} ${owner}`);
    }
  }

  const myBar  = side === "a" ? state.barA : state.barB;
  const oppBar = side === "a" ? state.barB : state.barA;
  const myOff  = side === "a" ? state.borneOffA : state.borneOffB;
  const oppOff = side === "a" ? state.borneOffB : state.borneOffA;
  const dir    = side === "a" ? "24→1, bear off from points 1-6" : "1→24, bear off from points 19-24";

  const options = legal.slice(0, 20).map((m, i) => `  ${i}: ${JSON.stringify(m)}`).join("\n");
  const extra = legal.length > 20 ? `\n  ... and ${legal.length - 20} more` : "";

  return `Backgammon — you are side ${side} (moving ${dir}).
Dice: ${state.dice[0]}, ${state.dice[1]}

Board:
${boardLines.length ? boardLines.join("\n") : "  (empty)"}
Bar: You=${myBar}, Opponent=${oppBar}
Borne off: You=${myOff}, Opponent=${oppOff}

Legal moves (pick one by index):
${options}${extra}

Reply with ONLY: {"index": <number>}`;
}

// ── Move decision ───────────────────────────────────────────────────────────

async function decideMove(state: any, side: string): Promise<any> {
  const legal: number[][][] = state.legalMoves || [];

  if (!legal.length || (legal.length === 1 && legal[0].length === 0)) {
    return { moves: [] };
  }

  try {
    const prompt = buildPrompt(state, side);
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
        if (!side || state.turn !== side) return;

        processing = true;
        try {
          const move = await decideMove(state, side);
          console.log(`  Dice: ${state.dice} → ${JSON.stringify(move)}`);
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
          console.log(`\nGame over after ${moves} moves! Gammon: ${msg.isGammon || false}`);
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
        if (side && lastState && lastState.turn === side) {
          const legal = lastState.legalMoves || [];
          if (legal.length && legal[0].length) {
            ws.send(JSON.stringify({ type: "move", move: { moves: legal[0] } }));
            processing = true;
          }
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
  console.log(`Skillers Backgammon Agent — LLM: ${LLM_PROVIDER}/${model}`);

  const hdrs = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
  const joinRes = await fetch(`${API_URL}/games/join`, {
    method: "POST", headers: hdrs,
    body: JSON.stringify({ game_type: "backgammon", room_amount_cents: 0 }),
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
