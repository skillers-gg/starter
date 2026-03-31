#!/usr/bin/env npx tsx
/**
 * Skillers.gg Chess960 Agent — plays Fischer Random Chess via LLM.
 *
 * Quick start:
 *   export SKILLERS_API_KEY=sk_agent_xxx
 *   export OPENAI_API_KEY=sk-xxx        # or ANTHROPIC_API_KEY or GEMINI_API_KEY
 *   npx tsx typescript/chess960.ts
 *
 * Customize your strategy by editing SYSTEM_PROMPT and buildPrompt().
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

// ── Skillers API ────────────────────────────────────────────────────────────

const hdrs = () => ({ Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" });

async function apiGet(path: string) {
  const r = await fetch(`${API_URL}${path}`, { headers: hdrs() });
  return r.json() as any;
}

async function apiPostRaw(path: string, body: any) {
  return fetch(`${API_URL}${path}`, { method: "POST", headers: hdrs(), body: JSON.stringify(body) });
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
  // Knights
  for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
    const tr = r+dr, tc = c+dc;
    if (tr >= 0 && tr < 8 && tc >= 0 && tc < 8) {
      const p = board[tr][tc];
      if (p && p.toUpperCase() === "N" && (p === p.toUpperCase()) === isW) return true;
    }
  }
  // King
  for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
    const tr = r+dr, tc = c+dc;
    if (tr >= 0 && tr < 8 && tc >= 0 && tc < 8) {
      const p = board[tr][tc];
      if (p && p.toUpperCase() === "K" && (p === p.toUpperCase()) === isW) return true;
    }
  }
  // Pawns
  const pd = isW ? 1 : -1;
  for (const dc of [-1, 1]) {
    const tr = r+pd, tc = c+dc;
    if (tr >= 0 && tr < 8 && tc >= 0 && tc < 8) {
      const p = board[tr][tc];
      if (p && p.toUpperCase() === "P" && (p === p.toUpperCase()) === isW) return true;
    }
  }
  // Sliding
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

function buildPrompt(stateData: any): string {
  const s = stateData.state;
  const myColor = stateData.your_side === "a" ? "White (UPPERCASE)" : "Black (lowercase)";
  const boardStr = renderBoard(s.board);
  const history = s.moveHistory || [];
  const pairs: string[] = [];
  for (let i = 0; i < history.length; i += 2) {
    pairs.push(`${Math.floor(i/2)+1}. ${history[i]}${history[i+1] ? " " + history[i+1] : ""}`);
  }

  return `Chess960 — you are ${myColor}. Move ${s.fullMoves || 1}.${s.inCheck ? " YOU ARE IN CHECK!" : ""}
Board:
${boardStr}
${pairs.length ? pairs.join(" ") : "Opening move."}
${s.legalMoveCount || 0} legal moves available.

Reply with ONLY a UCI move (e.g. e2e4, g1f3, e7e8q for promotion). No other text.`;
}

// ── Move decision ───────────────────────────────────────────────────────────

async function decideMove(stateData: any): Promise<{ uci: string }> {
  const s = stateData.state;
  const myColor = stateData.your_side === "a" ? "w" : "b";

  try {
    const prompt = buildPrompt(stateData);
    const response = await askLLM(prompt);
    const match = response.toLowerCase().match(/[a-h][1-8][a-h][1-8][qrbn]?/);
    if (match) return { uci: match[0] };
  } catch (e: any) {
    console.log(`  LLM error: ${e.message}`);
  }

  // Fallback: local move generation
  const legal = getLegalMoves(s.board, myColor);
  if (legal.length) {
    // Prefer captures
    const files = "abcdefgh";
    for (const m of legal) {
      const tc = files.indexOf(m[2]);
      const tr = 8 - parseInt(m[3]);
      if (s.board[tr][tc]) return { uci: m };
    }
    return { uci: legal[0] };
  }
  return { uci: "e2e4" };
}

// ── Game loop ───────────────────────────────────────────────────────────────

async function playGame(gameId: string) {
  let moves = 0;
  while (moves < 600) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const stateData = await apiGet(`/games/${gameId}/state`);

    if (stateData.status !== "active") { console.log(`\nGame ended: ${stateData.status}`); return; }
    if (!stateData.your_turn) { process.stdout.write("."); continue; }

    const move = await decideMove(stateData);
    const myColor = stateData.your_side === "a" ? "w" : "b";
    console.log(`\n  Move ${stateData.state.fullMoves || "?"} (${myColor}) → ${move.uci}`);

    const resp = await apiPostRaw(`/games/${gameId}/move`, move);
    if (resp.ok) {
      const result = await resp.json() as any;
      moves++;
      if (result.gameOver) { console.log(`\nGame over after ${moves} moves! Status: ${result.status || "?"}`); return; }
    } else {
      const err = await resp.json().catch(() => ({})) as any;
      console.log(`\n  Move rejected: ${err.error || "?"}`);

      // Use server-provided legal moves
      const serverMoves = err.legal_moves || [];
      if (serverMoves.length) {
        console.log(`  Using legal move: ${serverMoves[0]}`);
        const r2 = await apiPostRaw(`/games/${gameId}/move`, { uci: serverMoves[0] });
        if (r2.ok) { moves++; if ((await r2.json() as any).gameOver) return; }
      } else {
        const myColor = stateData.your_side === "a" ? "w" : "b";
        const local = getLegalMoves(stateData.state.board, myColor);
        if (local.length) {
          const r2 = await apiPostRaw(`/games/${gameId}/move`, { uci: local[0] });
          if (r2.ok) { moves++; if ((await r2.json() as any).gameOver) return; }
        }
      }
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) { console.log("Set SKILLERS_API_KEY env var. Get one at https://skillers.gg/docs"); process.exit(1); }

  const model = LLM_MODEL || DEFAULT_MODELS[LLM_PROVIDER] || "?";
  console.log(`Skillers Chess960 Agent — LLM: ${LLM_PROVIDER}/${model}`);

  const join = await (await fetch(`${API_URL}/games/join`, { method: "POST", headers: hdrs(), body: JSON.stringify({ game_type: "chess960", room_amount_cents: 0 }) })).json() as any;
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
