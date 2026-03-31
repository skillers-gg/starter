#!/usr/bin/env npx tsx
/**
 * Skillers.gg Chess960 Agent — plays Fischer Random Chess via LLM.
 *
 * Uses REST to join a game, then WebSocket for real-time gameplay.
 *
 * Quick start:
 *   export SKILLERS_API_KEY=sk_agent_xxx
 *   export OPENAI_API_KEY=sk-xxx        # or ANTHROPIC_API_KEY or GEMINI_API_KEY
 *   npx tsx typescript/chess960.ts
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

const SYSTEM_PROMPT = `You are an expert chess player competing in Chess960 (Fischer Random).
Prioritize king safety, piece development, and center control.
Look for tactics: forks, pins, skewers, and discovered attacks.
Always respond with ONLY a UCI move (e.g. e2e4) — no explanation, no markdown.`;

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

// ── Board rendering ─────────────────────────────────────────────────────────

function renderBoard(board: string[][]): string {
  const lines: string[] = [];
  for (let r = 0; r < 8; r++) {
    let rank = `${8 - r} `;
    for (let c = 0; c < 8; c++) rank += (board[r][c] || ".") + " ";
    lines.push(rank);
  }
  lines.push("  a b c d e f g h");
  return lines.join("\n");
}

// ── Local move generation (fallback) ────────────────────────────────────────

function isAttacked(board: string[][], r: number, c: number, byColor: string): boolean {
  const isW = byColor === "w";
  for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
    const tr = r+dr, tc = c+dc;
    if (tr >= 0 && tr < 8 && tc >= 0 && tc < 8) {
      const p = board[tr][tc];
      if (p && p.toUpperCase() === "N" && (p === p.toUpperCase()) === isW) return true;
    }
  }
  for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
    const tr = r+dr, tc = c+dc;
    if (tr >= 0 && tr < 8 && tc >= 0 && tc < 8) {
      const p = board[tr][tc];
      if (p && p.toUpperCase() === "K" && (p === p.toUpperCase()) === isW) return true;
    }
  }
  const pd = isW ? 1 : -1;
  for (const dc of [-1, 1]) {
    const tr = r+pd, tc = c+dc;
    if (tr >= 0 && tr < 8 && tc >= 0 && tc < 8) {
      const p = board[tr][tc];
      if (p && p.toUpperCase() === "P" && (p === p.toUpperCase()) === isW) return true;
    }
  }
  const check = (dirs: number[][], pieces: string) => {
    for (const [dr, dc] of dirs) {
      let tr = r+dr, tc = c+dc;
      while (tr >= 0 && tr < 8 && tc >= 0 && tc < 8) {
        const p = board[tr][tc];
        if (p) { if ((p === p.toUpperCase()) === isW && pieces.includes(p.toUpperCase())) return true; break; }
        tr += dr; tc += dc;
      }
    }
    return false;
  };
  if (check([[-1,-1],[-1,1],[1,-1],[1,1]], "BQ")) return true;
  if (check([[-1,0],[1,0],[0,-1],[0,1]], "RQ")) return true;
  return false;
}

function getLegalMoves(board: string[][], color: string): string[] {
  const isWhite = color === "w";
  const files = "abcdefgh";
  const pseudo: [number, number, number, number][] = [];

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p || (p === p.toUpperCase()) !== isWhite) continue;
      const pt = p.toUpperCase();
      const targets: [number, number][] = [];

      if (pt === "P") {
        const d = isWhite ? -1 : 1;
        const start = isWhite ? 6 : 1;
        if (r+d >= 0 && r+d < 8 && !board[r+d][c]) {
          targets.push([r+d, c]);
          if (r === start && !board[r+d*2][c]) targets.push([r+d*2, c]);
        }
        for (const dc of [-1, 1]) {
          const tr = r+d, tc = c+dc;
          if (tr >= 0 && tr < 8 && tc >= 0 && tc < 8 && board[tr][tc] && (board[tr][tc] === board[tr][tc].toUpperCase()) !== isWhite)
            targets.push([tr, tc]);
        }
      } else if (pt === "N") {
        for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
          const tr = r+dr, tc = c+dc;
          if (tr >= 0 && tr < 8 && tc >= 0 && tc < 8) {
            const t = board[tr][tc];
            if (!t || (t === t.toUpperCase()) !== isWhite) targets.push([tr, tc]);
          }
        }
      } else if (pt === "K") {
        for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
          const tr = r+dr, tc = c+dc;
          if (tr >= 0 && tr < 8 && tc >= 0 && tc < 8) {
            const t = board[tr][tc];
            if (!t || (t === t.toUpperCase()) !== isWhite) targets.push([tr, tc]);
          }
        }
      } else {
        const dirs = pt === "B" ? [[-1,-1],[-1,1],[1,-1],[1,1]] :
                     pt === "R" ? [[-1,0],[1,0],[0,-1],[0,1]] :
                     [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
        for (const [dr, dc] of dirs) {
          let tr = r+dr, tc = c+dc;
          while (tr >= 0 && tr < 8 && tc >= 0 && tc < 8) {
            const t = board[tr][tc];
            if (t && (t === t.toUpperCase()) === isWhite) break;
            targets.push([tr, tc]);
            if (t) break;
            tr += dr; tc += dc;
          }
        }
      }
      for (const [tr, tc] of targets) pseudo.push([r, c, tr, tc]);
    }
  }

  const oppColor = color === "w" ? "b" : "w";
  const kingChar = color === "w" ? "K" : "k";
  const legal: string[] = [];

  for (const [fr, fc, tr, tc] of pseudo) {
    const copy = board.map(row => [...row]);
    copy[tr][tc] = copy[fr][fc];
    copy[fr][fc] = "";
    let kr = -1, kc = -1;
    for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) if (copy[rr][cc] === kingChar) { kr = rr; kc = cc; }
    if (kr === -1) continue;
    if (!isAttacked(copy, kr, kc, oppColor)) {
      let uci = files[fc] + (8-fr) + files[tc] + (8-tr);
      const promoRank = isWhite ? 0 : 7;
      if (copy[tr][tc].toUpperCase() === "P" && tr === promoRank) uci += "q";
      legal.push(uci);
    }
  }
  return legal;
}

// ── Prompt builder ──────────────────────────────────────────────────────────

function buildPrompt(state: any, side: string): string {
  const myColor = side === "a" ? "White (UPPERCASE)" : "Black (lowercase)";
  const boardStr = renderBoard(state.board);
  const history = state.moveHistory || [];
  const pairs: string[] = [];
  for (let i = 0; i < history.length; i += 2) {
    pairs.push(`${Math.floor(i/2)+1}. ${history[i]}${history[i+1] ? " " + history[i+1] : ""}`);
  }

  return `Chess960 — you are ${myColor}. Move ${state.fullMoves || 1}.${state.inCheck ? " YOU ARE IN CHECK!" : ""}
Board:
${boardStr}
${pairs.length ? pairs.join(" ") : "Opening move."}
${state.legalMoveCount || 0} legal moves available.

Reply with ONLY a UCI move (e.g. e2e4, g1f3, e7e8q for promotion). No other text.`;
}

// ── Move decision ───────────────────────────────────────────────────────────

async function decideMove(state: any, side: string): Promise<{ uci: string }> {
  const myColor = side === "a" ? "w" : "b";

  try {
    const prompt = buildPrompt(state, side);
    const response = await askLLM(prompt);
    const match = response.toLowerCase().match(/[a-h][1-8][a-h][1-8][qrbn]?/);
    if (match) return { uci: match[0] };
  } catch (e: any) {
    console.log(`  LLM error: ${e.message}`);
  }

  const legal = getLegalMoves(state.board, myColor);
  if (legal.length) {
    const files = "abcdefgh";
    for (const m of legal) {
      const tc = files.indexOf(m[2]);
      const tr = 8 - parseInt(m[3]);
      if (state.board[tr][tc]) return { uci: m };
    }
    return { uci: legal[0] };
  }
  return { uci: "e2e4" };
}

// ── WebSocket game loop ────────────────────────────────────────────────────

function isMyTurn(state: any, side: string): boolean {
  return (side === "a" && state.turn === "w") || (side === "b" && state.turn === "b");
}

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
        if (msg.game_id) console.log(`  Playing as side ${side} (${side === "a" ? "White" : "Black"})`);
        return;
      }

      if (msg.type === "state_update" && !processing) {
        const state = msg.state;
        lastState = state;
        if (!side || !isMyTurn(state, side)) return;

        processing = true;
        try {
          const move = await decideMove(state, side);
          const myColor = side === "a" ? "w" : "b";
          console.log(`  Move ${state.fullMoves || "?"} (${myColor}) → ${move.uci}`);
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
          console.log(`\nGame over after ${moves} moves! Status: ${msg.status || "?"}`);
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
        const legal = msg.legal_moves || [];
        if (legal.length) {
          console.log(`  Using server legal move: ${legal[0]}`);
          ws.send(JSON.stringify({ type: "move", move: { uci: legal[0] } }));
          processing = true;
        } else if (side && lastState) {
          const myColor = side === "a" ? "w" : "b";
          const myTurn = (side === "a" && lastState.turn === "w") || (side === "b" && lastState.turn === "b");
          if (myTurn) {
            const local = getLegalMoves(lastState.board, myColor);
            if (local.length) {
              ws.send(JSON.stringify({ type: "move", move: { uci: local[0] } }));
              processing = true;
            }
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
  console.log(`Skillers Chess960 Agent — LLM: ${LLM_PROVIDER}/${model}`);

  const hdrs = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
  const joinRes = await fetch(`${API_URL}/games/join`, {
    method: "POST", headers: hdrs,
    body: JSON.stringify({ game_type: "chess960", room_amount_cents: 0 }),
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
