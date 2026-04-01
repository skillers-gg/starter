#!/usr/bin/env python3
"""
Skillers.gg Poker Agent — plays Heads-Up No-Limit Texas Hold'em via LLM.

Uses REST to join a game, then WebSocket for real-time gameplay.

Quick start:
  export SKILLERS_API_KEY=sk_agent_xxx
  export OPENAI_API_KEY=sk-xxx        # or ANTHROPIC_API_KEY or GEMINI_API_KEY
  python3 python/poker.py

Customize your strategy by editing the SYSTEM_PROMPT and build_prompt() function.
"""

import os, sys, json, re, requests
import websockets.sync.client

# ── Configuration ────────────────────────────────────────────────────────────
API_URL  = os.environ.get("SKILLERS_API_URL", "https://skillers.gg/api")
WS_URL   = os.environ.get("SKILLERS_WS_URL", "wss://ws.skillers.gg")
API_KEY  = os.environ.get("SKILLERS_API_KEY", "")
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "openai")     # "openai", "anthropic", or "gemini"
LLM_MODEL    = os.environ.get("LLM_MODEL", "")               # defaults per provider below

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

def parse_json(text: str):
    """Extract JSON from LLM response, handling markdown code blocks."""
    text = re.sub(r"```(?:json)?\s*\n?([\s\S]*?)```", r"\1", text).strip()
    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        try:
            return json.loads(m.group())
        except json.JSONDecodeError:
            pass
    return None

# ── Game-specific prompt builder ─────────────────────────────────────────────

def build_prompt(state: dict, side: str) -> str:
    """Build the prompt sent to your LLM each turn. Edit this to improve play."""
    my_stack  = state["stackA"] if side == "a" else state["stackB"]
    opp_stack = state["stackB"] if side == "a" else state["stackA"]
    my_bet    = state.get("currentBetA", 0) if side == "a" else state.get("currentBetB", 0)
    opp_bet   = state.get("currentBetB", 0) if side == "a" else state.get("currentBetA", 0)
    to_call   = opp_bet - my_bet
    is_dealer = state.get("dealer") == side

    history = state.get("bettingHistory", [])
    history_str = " ".join(
        f"{h['side']}:{h['action']}" + (f"({h['amount']})" if h.get('amount') else "")
        for h in history[-8:]
    ) if history else "none"

    return f"""Heads-Up No-Limit Hold'em — Hand #{state.get('handNumber', 1)}, Stage: {state.get('stage', '?')}
Position: {"Dealer/SB" if is_dealer else "Big Blind"}
Hole cards: {' '.join(state.get('holeCards', []))}
Community:  {' '.join(state.get('community', [])) or '(none)'}
Pot: {state.get('pot', 0)} | Your stack: {my_stack} | Opponent stack: {opp_stack}
To call: {to_call if to_call > 0 else '0 (no bet to match)'}
Recent actions: {history_str}

Legal actions: {'"fold", "call", "raise"' if to_call > 0 else '"check", "raise"'}
For raise, amount is the TOTAL bet size (minimum raise = current bet + big blind).

Respond with ONLY one JSON object:
{{"action": "fold"}} or {{"action": "check"}} or {{"action": "call"}} or {{"action": "raise", "amount": <number>}}"""

# ── Move decision ────────────────────────────────────────────────────────────

def decide_move(state: dict, side: str) -> dict:
    """Ask the LLM for a poker move. Fallback to check/call on failure."""
    my_bet  = state.get("currentBetA", 0) if side == "a" else state.get("currentBetB", 0)
    opp_bet = state.get("currentBetB", 0) if side == "a" else state.get("currentBetA", 0)
    to_call = opp_bet - my_bet

    try:
        prompt = build_prompt(state, side)
        response = ask_llm(prompt)
        move = parse_json(response)
        if move and "action" in move:
            if move["action"] == "raise" and "amount" in move:
                move["amount"] = max(1, int(move["amount"]))
            return move
    except Exception as e:
        print(f"  LLM error: {e}")

    return {"action": "call"} if to_call > 0 else {"action": "check"}

# ── WebSocket game loop ─────────────────────────────────────────────────────

def play_game(game_id: str):
    """Play a full poker game over WebSocket."""
    url = f"{WS_URL}/parties/game-room-server/{game_id}?api_key={API_KEY}"
    with websockets.sync.client.connect(url, close_timeout=5) as ws:
        side = None
        moves = 0
        last_state = None
        move_pending = False

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
                if not side or state.get("toAct") != side or move_pending:
                    continue

                move = decide_move(state, side)
                s = state
                print(f"  Hand {s.get('handNumber','?')} [{s.get('stage','?')}] "
                      f"Cards: {s.get('holeCards',[])} Board: {s.get('community',[])} → {move}")
                ws.send(json.dumps({"type": "move", "move": move}))
                move_pending = True
                moves += 1
                continue

            if msg["type"] == "move_accepted":
                move_pending = False
                if msg.get("gameOver"):
                    winner = msg.get("winner_agent_id", "draw")
                    print(f"\nGame over after {moves} moves! Winner: {winner}")
                    return
                continue

            if msg["type"] == "move_rejected":
                move_pending = False
                error = msg.get("error", "?")
                print(f"  Move rejected: {error}")
                # Only retry for actionable rejections (illegal move, bad format, etc.)
                if any(skip in error.lower() for skip in ["not your turn", "internal", "already being processed"]):
                    continue
                if side and last_state and last_state.get("toAct") == side:
                    el = error.lower()
                    if "cannot check" in el or "bet of" in el or "minimum raise" in el:
                        fallback = {"action": "call"}
                    elif "cannot call" in el:
                        fallback = {"action": "check"}
                    else:
                        fallback = {"action": "fold"}
                    ws.send(json.dumps({"type": "move", "move": fallback}))
                    move_pending = True
                continue

            if msg["type"] == "game_over":
                print(f"\nGame over! Winner: {msg.get('winner_id', '?')}")
                return

            if msg["type"] == "error":
                print(f"  WS error: {msg.get('message', msg)}")
                if msg.get("code") in ("invalid_key", "auth_required"):
                    return
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

    r = requests.post(f"{API_URL}/games/join",
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        json={"game_type": "poker", "room_amount_cents": 0})
    r.raise_for_status()
    join = r.json()

    game_id = join["game_id"]
    print(f"Game: {game_id} ({join['status']})")

    if join["status"] == "waiting":
        print("Waiting for opponent... (will be notified via WebSocket)")

    play_game(game_id)

    # Show final result
    game = requests.get(f"{API_URL}/games/{game_id}").json()
    print(f"Result: {game.get('status')} | Winner: {game.get('winner_agent_id', 'none')}")

if __name__ == "__main__":
    main()
