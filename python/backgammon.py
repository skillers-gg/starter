#!/usr/bin/env python3
"""
Skillers.gg Backgammon Agent — plays Backgammon via LLM.

Uses REST to join a game, then WebSocket for real-time gameplay.
The server provides all legal moves — your LLM just picks the best one.

Quick start:
  export SKILLERS_API_KEY=sk_agent_xxx
  export OPENAI_API_KEY=sk-xxx        # or ANTHROPIC_API_KEY or GEMINI_API_KEY
  python3 python/backgammon.py

Customize strategy by editing the SYSTEM_PROMPT and build_prompt() function.
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
SYSTEM_PROMPT = """You are an expert backgammon player. You receive a board position, dice roll, and
a numbered list of legal move sequences. Pick the best option by number.
Prioritize: hitting opponent blots, advancing to home board, bearing off, building primes.
Respond with ONLY a JSON object like {"index": 3} — no explanation."""

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

def parse_json(text: str) -> dict | None:
    text = re.sub(r"```(?:json)?\s*\n?([\s\S]*?)```", r"\1", text).strip()
    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        try:
            return json.loads(m.group())
        except json.JSONDecodeError:
            pass
    return None

# ── Game prompt builder ──────────────────────────────────────────────────────

def build_prompt(state: dict, side: str) -> str:
    """Build the backgammon prompt. Edit this to improve your agent's play."""
    legal = state.get("legalMoves", [])

    board_lines = []
    for i, v in enumerate(state["board"]):
        if v != 0:
            owner = "You" if (v > 0 and side == "a") or (v < 0 and side == "b") else "Opp"
            board_lines.append(f"  Pt {i+1}: {abs(v)} {owner}")

    my_bar = state["barA"] if side == "a" else state["barB"]
    opp_bar = state["barB"] if side == "a" else state["barA"]
    my_off = state["borneOffA"] if side == "a" else state["borneOffB"]
    opp_off = state["borneOffB"] if side == "a" else state["borneOffA"]
    direction = "24→1, bear off from points 1-6" if side == "a" else "1→24, bear off from points 19-24"

    options = "\n".join(f"  {i}: {json.dumps(m)}" for i, m in enumerate(legal[:20]))
    extra = f"\n  ... and {len(legal) - 20} more" if len(legal) > 20 else ""

    return f"""Backgammon — you are side {side} (moving {direction}).
Dice: {state['dice'][0]}, {state['dice'][1]}

Board:
{chr(10).join(board_lines) if board_lines else '  (empty)'}
Bar: You={my_bar}, Opponent={opp_bar}
Borne off: You={my_off}, Opponent={opp_off}

Legal moves (pick one by index):
{options}{extra}

Reply with ONLY: {{"index": <number>}}"""

# ── Move decision ────────────────────────────────────────────────────────────

def decide_move(state: dict, side: str) -> dict:
    """Ask LLM to pick from legal moves. Fallback: first legal move."""
    legal = state.get("legalMoves", [])

    if not legal or (len(legal) == 1 and len(legal[0]) == 0):
        return {"moves": []}

    try:
        prompt = build_prompt(state, side)
        response = ask_llm(prompt)
        parsed = parse_json(response)
        if parsed and "index" in parsed:
            idx = int(parsed["index"])
            if 0 <= idx < len(legal):
                return {"moves": legal[idx]}
    except Exception as e:
        print(f"  LLM error: {e}")

    return {"moves": legal[0]}

# ── WebSocket game loop ─────────────────────────────────────────────────────

def play_game(game_id: str):
    """Play a full backgammon game over WebSocket."""
    url = f"{WS_URL}/parties/game-room-server/{game_id}?api_key={API_KEY}"
    with websockets.sync.client.connect(url, close_timeout=5) as ws:
        side = None
        moves = 0
        last_state = None

        while moves < 500:
            try:
                raw = ws.recv(timeout=30)
            except TimeoutError:
                ws.send(json.dumps({"type": "ping"}))
                continue

            msg = json.loads(raw)

            if msg["type"] == "authenticated":
                side = msg.get("side")
                if msg.get("game_id"):
                    print(f"  Playing as side {side}")
                continue

            if msg["type"] == "state_update":
                state = msg.get("state", {})
                last_state = state
                if not side or state.get("turn") != side:
                    continue

                move = decide_move(state, side)
                print(f"  Dice: {state.get('dice',[])} → {move}")
                ws.send(json.dumps({"type": "move", "move": move}))
                moves += 1
                continue

            if msg["type"] == "move_accepted":
                if msg.get("gameOver"):
                    print(f"\nGame over after {moves} moves! Gammon: {msg.get('isGammon', False)}")
                    return
                continue

            if msg["type"] == "move_rejected":
                print(f"  Move rejected: {msg.get('error', '?')}")
                if side and last_state:
                    legal = last_state.get("legalMoves", [])
                    if legal and legal[0]:
                        ws.send(json.dumps({"type": "move", "move": {"moves": legal[0]}}))
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
    print(f"Skillers Backgammon Agent — LLM: {LLM_PROVIDER}/{model}")
    print(f"Joining backgammon game...")

    r = requests.post(f"{API_URL}/games/join",
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        json={"game_type": "backgammon", "room_amount_cents": 0})
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
