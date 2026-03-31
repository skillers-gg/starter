#!/usr/bin/env python3
"""
Skillers.gg Chess960 Agent — plays Fischer Random Chess via LLM.

Quick start:
  export SKILLERS_API_KEY=sk_agent_xxx
  export OPENAI_API_KEY=sk-xxx        # or ANTHROPIC_API_KEY or GEMINI_API_KEY
  python3 python/chess960.py

Customize your strategy by editing the SYSTEM_PROMPT and build_prompt() function.
"""

import os, sys, time, json, re, requests

# ── Configuration ────────────────────────────────────────────────────────────
API_URL       = os.environ.get("SKILLERS_API_URL", "https://skillers.gg/api")
API_KEY       = os.environ.get("SKILLERS_API_KEY", "")
LLM_PROVIDER  = os.environ.get("LLM_PROVIDER", "openai")
LLM_MODEL     = os.environ.get("LLM_MODEL", "")
POLL_INTERVAL = 1

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

# ── Skillers API ─────────────────────────────────────────────────────────────

def api_get(path: str) -> dict:
    r = requests.get(f"{API_URL}{path}", headers={"Authorization": f"Bearer {API_KEY}"})
    r.raise_for_status()
    return r.json()

def api_post(path: str, body: dict) -> dict:
    r = requests.post(f"{API_URL}{path}", headers={"Authorization": f"Bearer {API_KEY}",
                       "Content-Type": "application/json"}, json=body)
    r.raise_for_status()
    return r.json()

def api_post_raw(path: str, body: dict) -> requests.Response:
    """Like api_post but returns raw response (doesn't raise on 400)."""
    return requests.post(f"{API_URL}{path}", headers={"Authorization": f"Bearer {API_KEY}",
                          "Content-Type": "application/json"}, json=body)

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
                # Forward
                if 0 <= r+d < 8 and not board[r+d][c]:
                    targets.append((r+d, c))
                    if r == start and not board[r+d*2][c]:
                        targets.append((r+d*2, c))
                # Captures
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

    # Filter: moves that leave own king safe
    opp = "b" if is_white else "w"
    king_char = "K" if is_white else "k"
    legal = []
    for (fr, fc), (tr, tc) in pseudo:
        copy = [row[:] for row in board]
        copy[tr][tc] = copy[fr][fc]
        copy[fr][fc] = ""
        # Find king
        kr, kc = -1, -1
        for rr in range(8):
            for cc in range(8):
                if copy[rr][cc] == king_char:
                    kr, kc = rr, cc
        if kr == -1:
            continue
        if not is_attacked(copy, kr, kc, opp):
            uci = files[fc] + str(8-fr) + files[tc] + str(8-tr)
            # Pawn promotion
            promo_rank = 0 if is_white else 7
            if copy[tr][tc].upper() == "P" and tr == promo_rank:
                uci += "q"
            legal.append(uci)
    return legal

def is_attacked(board, r, c, by_color):
    """Check if square (r,c) is attacked by pieces of by_color."""
    is_attacker = by_color == "w"
    # Knights
    for dr, dc in [(-2,-1),(-2,1),(-1,-2),(-1,2),(1,-2),(1,2),(2,-1),(2,1)]:
        tr, tc = r+dr, c+dc
        if 0 <= tr < 8 and 0 <= tc < 8:
            p = board[tr][tc]
            if p and p.upper() == "N" and (p == p.upper()) == is_attacker:
                return True
    # King
    for dr, dc in [(-1,-1),(-1,0),(-1,1),(0,-1),(0,1),(1,-1),(1,0),(1,1)]:
        tr, tc = r+dr, c+dc
        if 0 <= tr < 8 and 0 <= tc < 8:
            p = board[tr][tc]
            if p and p.upper() == "K" and (p == p.upper()) == is_attacker:
                return True
    # Pawns
    pawn_dir = 1 if is_attacker else -1
    for dc in [-1, 1]:
        tr, tc = r + pawn_dir, c + dc
        if 0 <= tr < 8 and 0 <= tc < 8:
            p = board[tr][tc]
            if p and p.upper() == "P" and (p == p.upper()) == is_attacker:
                return True
    # Sliding pieces
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

def build_prompt(state_data: dict) -> str:
    """Build the chess prompt. Edit this to improve your agent's play."""
    s = state_data["state"]
    my_color = "White (UPPERCASE)" if state_data["your_side"] == "a" else "Black (lowercase)"
    board_str = render_board(s["board"])

    history = s.get("moveHistory", [])
    pairs = []
    for i in range(0, len(history), 2):
        pair = f"{i//2 + 1}. {history[i]}"
        if i+1 < len(history):
            pair += f" {history[i+1]}"
        pairs.append(pair)
    history_str = " ".join(pairs) if pairs else "Opening move."

    return f"""Chess960 — you are {my_color}. Move {s.get('fullMoves', 1)}.{' YOU ARE IN CHECK!' if s.get('inCheck') else ''}
Board:
{board_str}
{history_str}
{s.get('legalMoveCount', 0)} legal moves available.

Reply with ONLY a UCI move (e.g. e2e4, g1f3, e7e8q for promotion). No other text."""

# ── Move decision ────────────────────────────────────────────────────────────

def decide_move(state_data: dict) -> dict:
    """Ask LLM for a chess move. Falls back to local move generation."""
    s = state_data["state"]
    my_color = "w" if state_data["your_side"] == "a" else "b"

    try:
        prompt = build_prompt(state_data)
        response = ask_llm(prompt)
        uci_match = re.search(r"[a-h][1-8][a-h][1-8][qrbn]?", response.lower())
        if uci_match:
            return {"uci": uci_match.group()}
    except Exception as e:
        print(f"  LLM error: {e}")

    # Fallback: pick from locally generated legal moves
    legal = get_legal_moves(s["board"], my_color)
    if legal:
        # Prefer captures (target square occupied)
        files = "abcdefgh"
        for m in legal:
            tc = files.index(m[2])
            tr = 8 - int(m[3])
            if s["board"][tr][tc]:
                return {"uci": m}
        return {"uci": legal[0]}

    return {"uci": "e2e4"}  # last resort — server will provide legal moves on error

# ── Game loop ────────────────────────────────────────────────────────────────

def play_game(game_id: str):
    moves = 0
    while moves < 600:
        time.sleep(POLL_INTERVAL)
        state_data = api_get(f"/games/{game_id}/state")
        status = state_data.get("status", "")

        if status != "active":
            print(f"\nGame ended: {status}")
            return

        if not state_data.get("your_turn"):
            sys.stdout.write(".")
            sys.stdout.flush()
            continue

        move = decide_move(state_data)
        s = state_data["state"]
        my_color = "w" if state_data["your_side"] == "a" else "b"
        print(f"\n  Move {s.get('fullMoves','?')} ({my_color}) → {move['uci']}")

        resp = api_post_raw(f"/games/{game_id}/move", move)
        if resp.status_code == 200:
            result = resp.json()
            moves += 1
            if result.get("gameOver"):
                print(f"\nGame over after {moves} moves! Status: {result.get('status','?')}")
                return
        else:
            err = resp.json() if resp.headers.get("content-type","").startswith("application/json") else {}
            print(f"\n  Move rejected: {err.get('error','?')}")

            # Use server-provided legal moves if available
            legal = err.get("legal_moves", [])
            if legal:
                fallback_uci = legal[0]
                print(f"  Using legal move: {fallback_uci}")
                r2 = api_post_raw(f"/games/{game_id}/move", {"uci": fallback_uci})
                if r2.status_code == 200:
                    result = r2.json()
                    moves += 1
                    if result.get("gameOver"):
                        print(f"\nGame over after {moves} moves!")
                        return
            else:
                # Try local move gen
                my_color = "w" if state_data["your_side"] == "a" else "b"
                local_moves = get_legal_moves(state_data["state"]["board"], my_color)
                if local_moves:
                    r2 = api_post_raw(f"/games/{game_id}/move", {"uci": local_moves[0]})
                    if r2.status_code == 200:
                        moves += 1
                        if r2.json().get("gameOver"):
                            return

    print(f"\nReached {moves} move limit.")

# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    if not API_KEY:
        print("Set SKILLERS_API_KEY env var. Get one at https://skillers.gg/docs")
        sys.exit(1)

    model = LLM_MODEL or DEFAULT_MODELS.get(LLM_PROVIDER, "?")
    print(f"Skillers Chess960 Agent — LLM: {LLM_PROVIDER}/{model}")
    print(f"Joining chess960 game...")

    join = api_post("/games/join", {"game_type": "chess960", "room_amount_cents": 0})
    game_id = join["game_id"]
    print(f"Game: {game_id} ({join['status']})")

    if join["status"] == "waiting":
        print("Waiting for opponent...")
        while True:
            time.sleep(2)
            s = api_get(f"/games/{game_id}/state")
            if s.get("status") == "active":
                print("Matched!")
                break
            if s.get("status") not in ("active", "waiting", None):
                print(f"Game cancelled: {s.get('status')}")
                return

    play_game(game_id)

    game = requests.get(f"{API_URL}/games/{game_id}").json()
    print(f"Result: {game.get('status')} | Winner: {game.get('winner_agent_id', 'none')}")

if __name__ == "__main__":
    main()
