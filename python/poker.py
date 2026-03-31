#!/usr/bin/env python3
"""
Skillers.gg Poker Agent — plays Heads-Up No-Limit Texas Hold'em via LLM.

Quick start:
  export SKILLERS_API_KEY=sk_agent_xxx
  export OPENAI_API_KEY=sk-xxx        # or ANTHROPIC_API_KEY or GEMINI_API_KEY
  python3 python/poker.py

Customize your strategy by editing the SYSTEM_PROMPT and build_prompt() function.
"""

import os, sys, time, json, re, requests

# ── Configuration ────────────────────────────────────────────────────────────
API_URL       = os.environ.get("SKILLERS_API_URL", "https://skillers.gg/api")
API_KEY       = os.environ.get("SKILLERS_API_KEY", "")
LLM_PROVIDER  = os.environ.get("LLM_PROVIDER", "openai")     # "openai", "anthropic", or "gemini"
LLM_MODEL     = os.environ.get("LLM_MODEL", "")               # defaults per provider below
POLL_INTERVAL = 1  # seconds between state polls

# Default models per provider
DEFAULT_MODELS = {
    "openai": "gpt-4o",
    "anthropic": "claude-sonnet-4-20250514",
    "gemini": "gemini-2.5-flash",
}

# ── System prompt — tweak this to change your agent's personality ────────────
SYSTEM_PROMPT = """You are an expert poker player competing in Heads-Up No-Limit Texas Hold'em.
You play aggressively with strong hands, bluff occasionally, and make mathematically sound decisions.
Consider hand strength, pot odds, position, and opponent tendencies.
Always respond with ONLY a JSON object — no explanation, no markdown."""

# ── LLM Integration ─────────────────────────────────────────────────────────

def ask_llm(prompt: str) -> str:
    """Send a prompt to the configured LLM and return the response text."""
    model = LLM_MODEL or DEFAULT_MODELS.get(LLM_PROVIDER, "gpt-4o")

    if LLM_PROVIDER == "openai":
        key = os.environ.get("OPENAI_API_KEY", "")
        resp = requests.post("https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={"model": model, "max_tokens": 256, "temperature": 0.3,
                  "messages": [{"role": "system", "content": SYSTEM_PROMPT},
                               {"role": "user", "content": prompt}]},
            timeout=30)
        return resp.json()["choices"][0]["message"]["content"].strip()

    elif LLM_PROVIDER == "anthropic":
        key = os.environ.get("ANTHROPIC_API_KEY", "")
        resp = requests.post("https://api.anthropic.com/v1/messages",
            headers={"x-api-key": key, "Content-Type": "application/json",
                     "anthropic-version": "2023-06-01"},
            json={"model": model, "max_tokens": 256, "system": SYSTEM_PROMPT,
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
                  "generationConfig": {"maxOutputTokens": 256, "temperature": 0.3}},
            timeout=30)
        return resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()

    else:
        raise ValueError(f"Unknown LLM_PROVIDER: {LLM_PROVIDER}")

def parse_json(text: str) -> dict | None:
    """Extract JSON from LLM response, handling markdown code blocks."""
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

# ── Game-specific prompt builder ─────────────────────────────────────────────

def build_prompt(state_data: dict) -> str:
    """Build the prompt sent to your LLM each turn. Edit this to improve play."""
    s = state_data["state"]
    side = state_data["your_side"]
    my_stack  = s["stackA"] if side == "a" else s["stackB"]
    opp_stack = s["stackB"] if side == "a" else s["stackA"]
    my_bet    = s.get("currentBetA", 0) if side == "a" else s.get("currentBetB", 0)
    opp_bet   = s.get("currentBetB", 0) if side == "a" else s.get("currentBetA", 0)
    to_call   = opp_bet - my_bet
    is_dealer = s.get("dealer") == side

    history = s.get("bettingHistory", [])
    history_str = " ".join(
        f"{h['side']}:{h['action']}" + (f"({h['amount']})" if h.get('amount') else "")
        for h in history[-8:]
    ) if history else "none"

    return f"""Heads-Up No-Limit Hold'em — Hand #{s.get('handNumber', 1)}, Stage: {s.get('stage', '?')}
Position: {"Dealer/SB" if is_dealer else "Big Blind"}
Hole cards: {' '.join(s.get('holeCards', []))}
Community:  {' '.join(s.get('community', [])) or '(none)'}
Pot: {s.get('pot', 0)} | Your stack: {my_stack} | Opponent stack: {opp_stack}
To call: {to_call if to_call > 0 else '0 (no bet to match)'}
Recent actions: {history_str}

Legal actions: {'"fold", "call", "raise"' if to_call > 0 else '"check", "raise"'}
For raise, amount is the TOTAL bet size (minimum raise = current bet + big blind).

Respond with ONLY one JSON object:
{{"action": "fold"}} or {{"action": "check"}} or {{"action": "call"}} or {{"action": "raise", "amount": <number>}}"""

# ── Move decision ────────────────────────────────────────────────────────────

def decide_move(state_data: dict) -> dict:
    """Ask the LLM for a poker move. Fallback to check/call on failure."""
    s = state_data["state"]
    side = state_data["your_side"]
    my_bet  = s.get("currentBetA", 0) if side == "a" else s.get("currentBetB", 0)
    opp_bet = s.get("currentBetB", 0) if side == "a" else s.get("currentBetA", 0)
    to_call = opp_bet - my_bet

    try:
        prompt = build_prompt(state_data)
        response = ask_llm(prompt)
        move = parse_json(response)
        if move and "action" in move:
            if move["action"] == "raise" and "amount" in move:
                move["amount"] = max(1, int(move["amount"]))
            return move
    except Exception as e:
        print(f"  LLM error: {e}")

    # Fallback: call if there's a bet, otherwise check
    return {"action": "call"} if to_call > 0 else {"action": "check"}

# ── Game loop ────────────────────────────────────────────────────────────────

def play_game(game_id: str):
    """Play a full poker game by polling state and submitting moves."""
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
        print(f"\n  Hand {s.get('handNumber','?')} [{s.get('stage','?')}] "
              f"Cards: {s.get('holeCards',[])} Board: {s.get('community',[])} → {move}")

        try:
            result = api_post(f"/games/{game_id}/move", move)
            moves += 1
            if result.get("gameOver"):
                winner = result.get("winner_agent_id", "draw")
                print(f"\nGame over after {moves} moves! Winner: {winner}")
                return
        except requests.HTTPError as e:
            err = e.response.json() if e.response.headers.get("content-type","").startswith("application/json") else {}
            print(f"\n  Move rejected: {err.get('error', e.response.text)}")
            # Fallback: try call, then check, then fold
            for fallback in [{"action": "call"}, {"action": "check"}, {"action": "fold"}]:
                try:
                    result = api_post(f"/games/{game_id}/move", fallback)
                    moves += 1
                    if result.get("gameOver"):
                        print(f"\nGame over after {moves} moves!")
                        return
                    break
                except:
                    continue

    print(f"\nReached {moves} moves limit.")

# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    if not API_KEY:
        print("Set SKILLERS_API_KEY env var. Get one at https://skillers.gg/docs")
        sys.exit(1)

    model = LLM_MODEL or DEFAULT_MODELS.get(LLM_PROVIDER, "?")
    print(f"Skillers Poker Agent — LLM: {LLM_PROVIDER}/{model}")
    print(f"Joining poker game...")

    join = api_post("/games/join", {"game_type": "poker", "room_amount_cents": 0})
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

    # Show final result
    game = requests.get(f"{API_URL}/games/{game_id}").json()
    print(f"Result: {game.get('status')} | Winner: {game.get('winner_agent_id', 'none')}")

if __name__ == "__main__":
    main()
