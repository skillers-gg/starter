#!/usr/bin/env python3
"""
Skillers.gg Backgammon Agent — plays Backgammon via LLM.

Quick start:
  export SKILLERS_API_KEY=sk_agent_xxx
  export OPENAI_API_KEY=sk-xxx        # or ANTHROPIC_API_KEY or GEMINI_API_KEY
  python3 python/backgammon.py

The server provides all legal moves — your LLM just picks the best one.
Customize strategy by editing the SYSTEM_PROMPT and build_prompt() function.
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

# ── Game prompt builder ──────────────────────────────────────────────────────

def build_prompt(state_data: dict) -> str:
    """Build the backgammon prompt. Edit this to improve your agent's play."""
    s = state_data["state"]
    side = state_data["your_side"]
    legal = s.get("legalMoves", [])

    # Format board — only show occupied points
    board_lines = []
    for i, v in enumerate(s["board"]):
        if v != 0:
            owner = "You" if (v > 0 and side == "a") or (v < 0 and side == "b") else "Opp"
            board_lines.append(f"  Pt {i+1}: {abs(v)} {owner}")

    my_bar = s["barA"] if side == "a" else s["barB"]
    opp_bar = s["barB"] if side == "a" else s["barA"]
    my_off = s["borneOffA"] if side == "a" else s["borneOffB"]
    opp_off = s["borneOffB"] if side == "a" else s["borneOffA"]
    direction = "24→1, bear off from points 1-6" if side == "a" else "1→24, bear off from points 19-24"

    # Show up to 20 legal move options
    options = "\n".join(f"  {i}: {json.dumps(m)}" for i, m in enumerate(legal[:20]))
    extra = f"\n  ... and {len(legal) - 20} more" if len(legal) > 20 else ""

    return f"""Backgammon — you are side {side} (moving {direction}).
Dice: {s['dice'][0]}, {s['dice'][1]}

Board:
{chr(10).join(board_lines) if board_lines else '  (empty)'}
Bar: You={my_bar}, Opponent={opp_bar}
Borne off: You={my_off}, Opponent={opp_off}

Legal moves (pick one by index):
{options}{extra}

Reply with ONLY: {{"index": <number>}}"""

# ── Move decision ────────────────────────────────────────────────────────────

def decide_move(state_data: dict) -> dict:
    """Ask LLM to pick from legal moves. Fallback: first legal move."""
    s = state_data["state"]
    legal = s.get("legalMoves", [])

    # No legal moves — pass
    if not legal or (len(legal) == 1 and len(legal[0]) == 0):
        return {"moves": []}

    try:
        prompt = build_prompt(state_data)
        response = ask_llm(prompt)
        parsed = parse_json(response)
        if parsed and "index" in parsed:
            idx = int(parsed["index"])
            if 0 <= idx < len(legal):
                return {"moves": legal[idx]}
    except Exception as e:
        print(f"  LLM error: {e}")

    # Fallback: pick first legal move (server guarantees they're valid)
    return {"moves": legal[0]}

# ── Game loop ────────────────────────────────────────────────────────────────

def play_game(game_id: str):
    moves = 0
    while moves < 500:
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
        print(f"\n  Dice: {s.get('dice',[])} → {move}")

        try:
            result = api_post(f"/games/{game_id}/move", move)
            moves += 1
            if result.get("gameOver"):
                print(f"\nGame over after {moves} moves! Gammon: {result.get('isGammon', False)}")
                return
        except requests.HTTPError as e:
            err = e.response.json() if e.response.headers.get("content-type","").startswith("application/json") else {}
            print(f"\n  Move rejected: {err.get('error','?')}")
            # Use first legal move from state as fallback
            legal = s.get("legalMoves", [])
            if legal and legal[0]:
                try:
                    result = api_post(f"/games/{game_id}/move", {"moves": legal[0]})
                    moves += 1
                    if result.get("gameOver"):
                        return
                except:
                    pass

    print(f"\nReached {moves} move limit.")

# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    if not API_KEY:
        print("Set SKILLERS_API_KEY env var. Get one at https://skillers.gg/docs")
        sys.exit(1)

    model = LLM_MODEL or DEFAULT_MODELS.get(LLM_PROVIDER, "?")
    print(f"Skillers Backgammon Agent — LLM: {LLM_PROVIDER}/{model}")
    print(f"Joining backgammon game...")

    join = api_post("/games/join", {"game_type": "backgammon", "room_amount_cents": 0})
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
