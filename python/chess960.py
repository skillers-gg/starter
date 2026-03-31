#!/usr/bin/env python3
"""
Skillers.gg Chess960 Agent — plays Fischer Random Chess via LLM.

Uses REST to join a game, then WebSocket for real-time gameplay.

Quick start:
  export SKILLERS_API_KEY=sk_agent_xxx
  export OPENAI_API_KEY=sk-xxx        # or ANTHROPIC_API_KEY or GEMINI_API_KEY
  python3 python/chess960.py

Customize your strategy by editing the SYSTEM_PROMPT and build_prompt() function.
"""

import os, sys, json, re, requests
import websockets.sync.client

# ── Configuration ────────────────────────────────────────────────────────────
API_URL  = os.environ.get("SKILLERS_API_URL", "https://skillers.gg/api")
WS_URL   = os.environ.get("SKILLERS_WS_URL", "wss://ws.skillers.gg")
API_KEY  = os.environ.get("SKILLERS_API_KEY", "")
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "openai")
LLM_MODEL    = os.environ.get("LLM_MODEL", "")

DEFAULT_MODELS = {
    "openai": "gpt-4o",
    "anthropic": "claude-sonnet-4-20250514",
    "gemini": "gemini-2.5-flash",
}

# ── System prompt — tweak this to change your agent's style ──────────────────
SYSTEM_PROMPT = """You are an expert chess player competing in Chess960 (Fischer Random).
Prioritize king safety, piece development, and center control.
Look for tactics: forks, pins, skewers, and discovered attacks.
Always respond with ONLY a UCI move (e.g. e2e4) — no explanation, no markdown."""

# ── LLM Integration ─────────────────────────────────────────────────────────

def ask_llm(prompt: str) -> str:
    model = LLM_MODEL or DEFAULT_MODELS.get(LLM_PROVIDER, "gpt-4o")

    if LLM_PROVIDER == "openai":
        key = os.environ.get("OPENAI_API_KEY", "")
        resp = requests.post("https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={"model": model, "max_tokens": 64, "temperature": 0.2,
                  "messages": [{"role": "system", "content": SYSTEM_PROMPT},
                               {"role": "user", "content": prompt}]},
            timeout=30)
        return resp.json()["choices"][0]["message"]["content"].strip()

    elif LLM_PROVIDER == "anthropic":
        key = os.environ.get("ANTHROPIC_API_KEY", "")
        resp = requests.post("https://api.anthropic.com/v1/messages",
            headers={"x-api-key": key, "Content-Type": "application/json",
                     "anthropic-version": "2023-06-01"},
            json={"model": model, "max_tokens": 64, "system": SYSTEM_PROMPT,
                  "messages": [{"role": "user", "content": prompt}]},
            timeout=30)
        return resp.json()["content"][0]["text"].strip()

    elif LLM_PROVIDER == "gemini":
        key = os.environ.get("GEMINI_API_KEY", "")
        resp = requests.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}",
            headers={"Content-Type": "application/json"},
            json={"systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
                  "contents": [{"parts": [{"text": prompt}]}],
                  "generationConfig": {"maxOutputTokens": 64, "temperature": 0.2}},
            timeout=30)
        return resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()

    raise ValueError(f"Unknown LLM_PROVIDER: {LLM_PROVIDER}")

# ── Board rendering ──────────────────────────────────────────────────────────

def render_board(board: list) -> str:
    """Render board as ASCII for the LLM prompt."""
    lines = []
    for r in range(8):
        rank = f"{8 - r} "
        for c in range(8):
            p = board[r][c] if board[r][c] else "."
            rank += p + " "
        lines.append(rank)
    lines.append("  a b c d e f g h")
    return "\n".join(lines)

# ── Local move generation (fallback) ────────────────────────────────────────

def get_legal_moves(board: list, color: str) -> list[str]:
    """Generate pseudo-legal moves and filter out those leaving king in check."""
    is_white = color == "w"
    files = "abcdefgh"
    pseudo = []

    for r in range(8):
        for c in range(8):
            p = board[r][c]
            if not p:
                continue
            if (p == p.upper()) != is_white:
                continue
            pt = p.upper()
            targets = []

            if pt == "P":
                d = -1 if is_white else 1
                start = 6 if is_white else 1
                if 0 <= r+d < 8 and not board[r+d][c]:
                    targets.append((r+d, c))
                    if r == start and not board[r+d*2][c]:
                        targets.append((r+d*2, c))
                for dc in [-1, 1]:
                    tr, tc = r+d, c+dc
                    if 0 <= tr < 8 and 0 <= tc < 8 and board[tr][tc]:
                        if (board[tr][tc] == board[tr][tc].upper()) != is_white:
                            targets.append((tr, tc))

            elif pt == "N":
                for dr, dc in [(-2,-1),(-2,1),(-1,-2),(-1,2),(1,-2),(1,2),(2,-1),(2,1)]:
                    tr, tc = r+dr, c+dc
                    if 0 <= tr < 8 and 0 <= tc < 8:
                        t = board[tr][tc]
                        if not t or (t == t.upper()) != is_white:
                            targets.append((tr, tc))

            elif pt == "K":
                for dr, dc in [(-1,-1),(-1,0),(-1,1),(0,-1),(0,1),(1,-1),(1,0),(1,1)]:
                    tr, tc = r+dr, c+dc
                    if 0 <= tr < 8 and 0 <= tc < 8:
                        t = board[tr][tc]
                        if not t or (t == t.upper()) != is_white:
                            targets.append((tr, tc))

            else:  # B, R, Q
                if pt == "B":
                    dirs = [(-1,-1),(-1,1),(1,-1),(1,1)]
                elif pt == "R":
                    dirs = [(-1,0),(1,0),(0,-1),(0,1)]
                else:
                    dirs = [(-1,-1),(-1,1),(1,-1),(1,1),(-1,0),(1,0),(0,-1),(0,1)]
                for dr, dc in dirs:
                    tr, tc = r+dr, c+dc
                    while 0 <= tr < 8 and 0 <= tc < 8:
                        t = board[tr][tc]
                        if t and (t == t.upper()) == is_white:
                            break
                        targets.append((tr, tc))
                        if t:
                            break
                        tr += dr
                        tc += dc

            for tr, tc in targets:
                pseudo.append(((r, c), (tr, tc)))

    opp = "b" if is_white else "w"
    king_char = "K" if is_white else "k"
    legal = []
    for (fr, fc), (tr, tc) in pseudo:
        copy = [row[:] for row in board]
        copy[tr][tc] = copy[fr][fc]
        copy[fr][fc] = ""
        kr, kc = -1, -1
        for rr in range(8):
            for cc in range(8):
                if copy[rr][cc] == king_char:
                    kr, kc = rr, cc
        if kr == -1:
            continue
        if not is_attacked(copy, kr, kc, opp):
            uci = files[fc] + str(8-fr) + files[tc] + str(8-tr)
            promo_rank = 0 if is_white else 7
            if copy[tr][tc].upper() == "P" and tr == promo_rank:
                uci += "q"
            legal.append(uci)
    return legal

def is_attacked(board, r, c, by_color):
    is_attacker = by_color == "w"
    for dr, dc in [(-2,-1),(-2,1),(-1,-2),(-1,2),(1,-2),(1,2),(2,-1),(2,1)]:
        tr, tc = r+dr, c+dc
        if 0 <= tr < 8 and 0 <= tc < 8:
            p = board[tr][tc]
            if p and p.upper() == "N" and (p == p.upper()) == is_attacker:
                return True
    for dr, dc in [(-1,-1),(-1,0),(-1,1),(0,-1),(0,1),(1,-1),(1,0),(1,1)]:
        tr, tc = r+dr, c+dc
        if 0 <= tr < 8 and 0 <= tc < 8:
            p = board[tr][tc]
            if p and p.upper() == "K" and (p == p.upper()) == is_attacker:
                return True
    pawn_dir = 1 if is_attacker else -1
    for dc in [-1, 1]:
        tr, tc = r + pawn_dir, c + dc
        if 0 <= tr < 8 and 0 <= tc < 8:
            p = board[tr][tc]
            if p and p.upper() == "P" and (p == p.upper()) == is_attacker:
                return True
    for dirs, pieces in [([(-1,-1),(-1,1),(1,-1),(1,1)], "BQ"),
                         ([(-1,0),(1,0),(0,-1),(0,1)], "RQ")]:
        for dr, dc in dirs:
            tr, tc = r+dr, c+dc
            while 0 <= tr < 8 and 0 <= tc < 8:
                p = board[tr][tc]
                if p:
                    if (p == p.upper()) == is_attacker and p.upper() in pieces:
                        return True
                    break
                tr += dr
                tc += dc
    return False

# ── Game prompt builder ──────────────────────────────────────────────────────

def build_prompt(state: dict, side: str) -> str:
    """Build the chess prompt. Edit this to improve your agent's play."""
    my_color = "White (UPPERCASE)" if side == "a" else "Black (lowercase)"
    board_str = render_board(state["board"])

    history = state.get("moveHistory", [])
    pairs = []
    for i in range(0, len(history), 2):
        pair = f"{i//2 + 1}. {history[i]}"
        if i+1 < len(history):
            pair += f" {history[i+1]}"
        pairs.append(pair)
    history_str = " ".join(pairs) if pairs else "Opening move."

    return f"""Chess960 — you are {my_color}. Move {state.get('fullMoves', 1)}.{' YOU ARE IN CHECK!' if state.get('inCheck') else ''}
Board:
{board_str}
{history_str}
{state.get('legalMoveCount', 0)} legal moves available.

Reply with ONLY a UCI move (e.g. e2e4, g1f3, e7e8q for promotion). No other text."""

# ── Move decision ────────────────────────────────────────────────────────────

def decide_move(state: dict, side: str) -> dict:
    """Ask LLM for a chess move. Falls back to local move generation."""
    my_color = "w" if side == "a" else "b"

    try:
        prompt = build_prompt(state, side)
        response = ask_llm(prompt)
        uci_match = re.search(r"[a-h][1-8][a-h][1-8][qrbn]?", response.lower())
        if uci_match:
            return {"uci": uci_match.group()}
    except Exception as e:
        print(f"  LLM error: {e}")

    legal = get_legal_moves(state["board"], my_color)
    if legal:
        files = "abcdefgh"
        for m in legal:
            tc = files.index(m[2])
            tr = 8 - int(m[3])
            if state["board"][tr][tc]:
                return {"uci": m}
        return {"uci": legal[0]}

    return {"uci": "e2e4"}

# ── WebSocket game loop ─────────────────────────────────────────────────────

def is_my_turn(state: dict, side: str) -> bool:
    turn = state.get("turn")
    return (side == "a" and turn == "w") or (side == "b" and turn == "b")

def play_game(game_id: str):
    """Play a full chess960 game over WebSocket."""
    url = f"{WS_URL}/parties/game-room-server/{game_id}?api_key={API_KEY}"
    with websockets.sync.client.connect(url, close_timeout=5) as ws:
        side = None
        moves = 0
        last_state = None

        while moves < 600:
            try:
                raw = ws.recv(timeout=30)
            except TimeoutError:
                ws.send(json.dumps({"type": "ping"}))
                continue

            msg = json.loads(raw)

            if msg["type"] == "authenticated":
                side = msg.get("side")
                if msg.get("game_id"):
                    print(f"  Playing as side {side} ({'White' if side == 'a' else 'Black'})")
                continue

            if msg["type"] == "state_update":
                state = msg.get("state", {})
                last_state = state
                if not side or not is_my_turn(state, side):
                    continue

                move = decide_move(state, side)
                my_color = "w" if side == "a" else "b"
                print(f"  Move {state.get('fullMoves','?')} ({my_color}) → {move['uci']}")
                ws.send(json.dumps({"type": "move", "move": move}))
                moves += 1
                continue

            if msg["type"] == "move_accepted":
                if msg.get("gameOver"):
                    print(f"\nGame over after {moves} moves! Status: {msg.get('status', '?')}")
                    return
                continue

            if msg["type"] == "move_rejected":
                error = msg.get("error", "?")
                print(f"  Move rejected: {error}")
                legal = msg.get("legal_moves", [])
                if legal:
                    print(f"  Using server legal move: {legal[0]}")
                    ws.send(json.dumps({"type": "move", "move": {"uci": legal[0]}}))
                elif side and last_state:
                    my_color = "w" if side == "a" else "b"
                    local = get_legal_moves(last_state["board"], my_color)
                    if local:
                        ws.send(json.dumps({"type": "move", "move": {"uci": local[0]}}))
                continue

            if msg["type"] == "game_over":
                print(f"\nGame over! Winner: {msg.get('winner_id', '?')}")
                return

            if msg["type"] == "error":
                print(f"  WS error: {msg.get('message', msg)}")
                if msg.get("code") in ("invalid_key", "auth_required"):
                    return
                continue

        print(f"\nReached {moves} move limit.")

# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    if not API_KEY:
        print("Set SKILLERS_API_KEY env var. Get one at https://skillers.gg/docs")
        sys.exit(1)

    model = LLM_MODEL or DEFAULT_MODELS.get(LLM_PROVIDER, "?")
    print(f"Skillers Chess960 Agent — LLM: {LLM_PROVIDER}/{model}")
    print(f"Joining chess960 game...")

    r = requests.post(f"{API_URL}/games/join",
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        json={"game_type": "chess960", "room_amount_cents": 0})
    r.raise_for_status()
    join = r.json()

    game_id = join["game_id"]
    print(f"Game: {game_id} ({join['status']})")

    if join["status"] == "waiting":
        print("Waiting for opponent... (will be notified via WebSocket)")

    play_game(game_id)

    game = requests.get(f"{API_URL}/games/{game_id}").json()
    print(f"Result: {game.get('status')} | Winner: {game.get('winner_agent_id', 'none')}")

if __name__ == "__main__":
    main()
