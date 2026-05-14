"""
War Room Voice Server for ClaudeClaw.

Three modes, selected by the WARROOM_MODE environment variable:

  realtime           OpenAI Realtime API (speech-to-speech + tool-calling).
                     Lowest-latency option (~500-700 ms end-to-end); used for
                     live customer demos. Pipeline shape is identical to `live`
                     mode — same tools, same persona logic, same speech-timeout
                     stop strategy — just a different LLM service in the slot.

  live               Gemini Live native-audio model + tool-calling.
                     WebSocket → user aggregator → Gemini Live → assistant aggregator → WebSocket.
                     Gemini handles speech-to-speech in real time. For execution work, it
                     calls tools that hand off to sub-agents via mission-cli (async) or run
                     inline (synchronous, fast answers like "what time is it"). Kept as a
                     fast fallback if OpenAI Realtime is unavailable mid-demo:
                     `WARROOM_MODE=live` + dashboard restart and you're back on Gemini.

  legacy             The original stitched STT → router → Claude-bridge → TTS chain.
                     Higher latency, but every utterance goes through the full Claude Code
                     stack with skills/MCP. Kept around so you can toggle back without
                     reverting the file.

Usage:
    python warroom/server.py

Environment variables:
    WARROOM_MODE              "realtime", "live", or "legacy"
    WARROOM_PORT              port to listen on (default: 7860)
    WARROOM_LIVE_MODEL        Gemini Live model id (default: whatever Pipecat ships)
    WARROOM_LIVE_VOICE        Gemini Live voice name (default: "Charon")
    WARROOM_REALTIME_MODEL    OpenAI Realtime model id (default: pipecat's built-in
                              gpt-4o-realtime-preview-2025-06-03)
    WARROOM_REALTIME_VOICE    OpenAI Realtime voice (default: "alloy"; valid: alloy,
                              ash, ballad, coral, echo, fable, onyx, nova, sage,
                              shimmer, verse)
    WARROOM_SPEECH_TIMEOUT    seconds of silence before end-of-turn (default: 0.3)
                              Lower = faster reply; too low cuts off natural pauses.
                              Increase to 0.5-0.6 if Arabic pauses trigger false stops.

    OPENAI_API_KEY       required for realtime mode
    GOOGLE_API_KEY       required for live mode
    DEEPGRAM_API_KEY     required for legacy mode
    CARTESIA_API_KEY     required for legacy mode
"""

import sys

# Check Python version early so the user gets a clear error instead of
# cryptic import failures deep in pipecat.
if sys.version_info < (3, 10):
    print(
        f"Error: Python 3.10+ required, but you have {sys.version}.\n"
        "Install a newer Python: https://www.python.org/downloads/\n"
        "Then recreate the venv: python3 -m venv warroom/.venv",
        file=sys.stderr,
    )
    sys.exit(1)

import asyncio
import datetime
import json
import logging
import os
import shutil
import sqlite3
import subprocess
import time
from pathlib import Path

# Ensure the warroom package is importable when run as a script
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Resolve project root for error messages
_PROJECT_DIR = str(Path(__file__).resolve().parent.parent)

# Check for required dependencies before importing them.
# If pip install failed in setup, the venv won't have pipecat-ai.
try:
    from dotenv import load_dotenv
except ModuleNotFoundError:
    print(
        "Error: python-dotenv not found in the War Room venv.\n"
        "The Python dependencies were not installed successfully.\n"
        "\n"
        "To fix this, run:\n"
        f"  cd {_PROJECT_DIR}\n"
        "  python3 -m venv warroom/.venv\n"
        "  source warroom/.venv/bin/activate\n"
        "  pip install -r warroom/requirements.txt\n",
        file=sys.stderr,
    )
    sys.exit(1)

try:
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.task import PipelineTask, PipelineParams
    from pipecat.transports.network.websocket_server import WebsocketServerTransport, WebsocketServerParams
    from pipecat.serializers.protobuf import ProtobufFrameSerializer
except ModuleNotFoundError as e:
    print(
        f"Error: pipecat-ai dependency not found: {e}\n"
        "The Python dependencies were not installed successfully.\n"
        "\n"
        "To fix this, run:\n"
        f"  cd {_PROJECT_DIR}\n"
        "  source warroom/.venv/bin/activate\n"
        "  pip install -r warroom/requirements.txt\n",
        file=sys.stderr,
    )
    sys.exit(1)

from config import PROJECT_ROOT, AGENT_VOICES, DEFAULT_AGENT


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("warroom.server")


# ─── Shared helpers ────────────────────────────────────────────────────────

def load_env():
    env_path = PROJECT_ROOT / ".env"
    if env_path.exists():
        load_dotenv(env_path)
        logger.info("Loaded env from %s", env_path)
    else:
        logger.warning("No .env found at %s, relying on shell environment", env_path)


def check_required_keys(required: dict):
    missing = []
    for key, description in required.items():
        if not os.environ.get(key):
            missing.append(f"  {key} - {description}")
    if missing:
        print("Missing required API keys:", file=sys.stderr)
        for line in missing:
            print(line, file=sys.stderr)
        print("\nSet these in your project .env or export them in your shell.", file=sys.stderr)
        sys.exit(1)


def make_transport(port: int, audio_in_sr: int = 16000, audio_out_sr: int = 24000) -> WebsocketServerTransport:
    # Input defaults to 16 kHz because that's what the bundled
    # @pipecat-ai/client-js ships audio at for server-side VAD/STT pipelines,
    # AND Gemini Live's native-audio endpoint locks to whatever rate arrives
    # first ("Sample rate changed from previously X to Y, which is not
    # supported"). Output stays at 24 kHz — Gemini Live emits 24 kHz audio
    # and Pipecat passes it through unchanged.
    return WebsocketServerTransport(
        host="0.0.0.0",
        port=port,
        params=WebsocketServerParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=audio_in_sr,
            audio_out_sample_rate=audio_out_sr,
            vad_analyzer=None,
            serializer=ProtobufFrameSerializer(),
        ),
    )


def print_ready(port: int, mode: str):
    connection_info = {
        "ws_url": f"ws://localhost:{port}",
        "status": "ready",
        "transport": "websocket",
        "mode": mode,
    }
    print(json.dumps(connection_info), flush=True)


# ─── Tool handlers (live mode) ─────────────────────────────────────────────

# Paths to the Node-side CLIs. The voice bridge already deals with path
# traversal / argument validation, so the Python tool handlers stay thin
# and only pass validated arguments through. NODE_BIN resolves via PATH
# (honouring NODE_BIN env override) so this works across Apple Silicon
# Homebrew, Intel Homebrew, nvm/volta, and Linux installs, rather than
# dying with FileNotFoundError when Node isn't at /opt/homebrew/bin/node.
NODE_BIN = os.environ.get("NODE_BIN") or shutil.which("node") or "node"
MISSION_CLI = PROJECT_ROOT / "dist" / "mission-cli.js"
VOICE_BRIDGE = PROJECT_ROOT / "dist" / "agent-voice-bridge.js"
# Load agent roster dynamically from the file Node writes on startup.
# Falls back to the default 5 if the file doesn't exist.
def _load_agent_roster():
    roster_path = Path("/tmp/warroom-agents.json")
    try:
        if roster_path.exists():
            agents = json.loads(roster_path.read_text())
            return {a["id"] for a in agents}
    except Exception as exc:
        logger.warning("Could not read agent roster from %s: %s", roster_path, exc)
    return {"main", "research", "comms", "content", "ops"}

VALID_AGENTS = _load_agent_roster()

# Chat id used for agent-voice-bridge session persistence. The warroom is
# a single shared meeting, not per-chat, so we use a fixed id unless the
# environment provides an override (e.g. for running two warroom instances
# side by side during testing).
WARROOM_CHAT_ID = os.environ.get("WARROOM_CHAT_ID", "warroom")

# Timeout for synchronous answer_as_agent invocations. Voice UX expects
# answers back within a few seconds. 25s is the hard ceiling — past that
# we fail the tool call and let Gemini recover conversationally.
ANSWER_TIMEOUT_SEC = float(os.environ.get("WARROOM_ANSWER_TIMEOUT", "25"))


async def _run_subprocess(cmd: list[str], timeout: float = 20.0) -> tuple[int, str, str]:
    """Run a subprocess with timeout. Returns (exit_code, stdout, stderr)."""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=str(PROJECT_ROOT),
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        try:
            proc.kill()
            await proc.wait()
        except Exception:
            pass
        return -1, "", "timeout"
    return proc.returncode or 0, stdout.decode(errors="replace").strip(), stderr.decode(errors="replace").strip()


async def delegate_to_agent_handler(params):
    """Tool: delegate a unit of work to one of the sub-agents via mission-cli.

    The sub-agent picks up the mission within ~60s via its own launchd polling
    loop and runs it through the full Claude Code stack (skills, MCP, file
    access). On completion the sub-agent fires a Telegram notification on its
    own bot token, so the user sees results in Telegram without Gemini Live
    needing to wait for execution.

    CRITICAL: we pass run_llm=False on the result so Pipecat does NOT trigger
    a follow-up Gemini inference after the tool returns. Without this flag
    Gemini generates a second audio turn about the tool result, producing the
    "Kicked it over to comms... kicked it over to comms" duplicate-speech bug.
    Gemini already verbally acknowledged the delegation in the same turn it
    called the tool, so we just let that stand.
    """
    from pipecat.frames.frames import FunctionCallResultProperties

    # Shared flag: suppress follow-up LLM turn so Gemini does not duplicate
    # the verbal acknowledgment it already gave during the same conversation
    # turn it called the tool in.
    silent = FunctionCallResultProperties(run_llm=False)

    args = params.arguments or {}
    agent = args.get("agent")
    title = args.get("title") or "voice-delegated task"
    prompt = args.get("prompt")
    priority = int(args.get("priority", 5))

    if agent not in VALID_AGENTS or not prompt:
        # Validation failures DO want a follow-up turn so Gemini can
        # verbally report the error to the user. Leave run_llm default.
        await params.result_callback({
            "ok": False,
            "error": f"invalid args: agent must be one of {sorted(VALID_AGENTS)} and prompt is required",
        })
        return

    if not MISSION_CLI.exists():
        await params.result_callback({
            "ok": False,
            "error": "mission-cli not built; run `npm run build` from the project root",
        })
        return

    cmd = [
        NODE_BIN, str(MISSION_CLI), "create",
        "--agent", agent,
        "--title", str(title),
        "--priority", str(priority),
        str(prompt),
    ]
    logger.info("delegate_to_agent: spawning mission-cli: agent=%s title=%r", agent, title)
    code, out, err = await _run_subprocess(cmd, timeout=15.0)
    if code != 0:
        logger.error("delegate_to_agent failed: code=%d stderr=%s", code, err)
        # Error path: let Gemini speak the error so the user hears it.
        await params.result_callback({"ok": False, "error": err or "mission-cli failed"})
        return

    # Happy path: queued successfully. Suppress the follow-up turn.
    await params.result_callback({"ok": True, "agent": agent}, properties=silent)


async def get_time_handler(params):
    """Tool: get the current wall clock time (user's local timezone)."""
    now = datetime.datetime.now().astimezone()
    await params.result_callback({
        "ok": True,
        "iso": now.isoformat(timespec="seconds"),
        "human": now.strftime("%A %B %-d, %-I:%M %p %Z"),
    })


async def get_recent_activity_handler(params):
    """Tool: return a structured digest of what's happened on the box recently.

    Used when the user asks about state, status, recent activity, what's
    running, what changed, or any 'do you know what we did' question. The
    handler queries hive_mind, mission_tasks, recent commits, and kill
    switches. Returns a single text block the bot reads back conversationally.
    """
    args = getattr(params, "arguments", None) or {}
    try:
        hours = int(args.get("hours", 6))
    except (TypeError, ValueError):
        hours = 6
    hours = max(1, min(hours, 72))  # clamp 1-72h
    cutoff = int(time.time()) - hours * 3600

    db = str(PROJECT_ROOT / "store" / "claudeclaw.db")
    hive_rows: list = []
    mission_rows: list = []
    try:
        conn = sqlite3.connect(db)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(
            "SELECT created_at, agent_id, action, summary "
            "FROM hive_mind WHERE created_at >= ? ORDER BY created_at DESC LIMIT 15",
            (cutoff,),
        )
        hive_rows = cur.fetchall()
        cur.execute(
            "SELECT created_at, COALESCE(completed_at, 0) AS completed_at, "
            "assigned_agent, status, substr(title, 1, 80) AS title "
            "FROM mission_tasks WHERE created_at >= ? OR status IN ('running','queued') "
            "ORDER BY created_at DESC LIMIT 12",
            (cutoff,),
        )
        mission_rows = cur.fetchall()
        conn.close()
    except Exception as e:
        logging.warning("get_recent_activity: db query failed: %s", e)

    # Recent commits on main (last 5)
    try:
        code, stdout, _stderr = await _run_subprocess(
            ["git", "log", "--oneline", "-5"], timeout=5.0,
        )
        commits = stdout if code == 0 else "(git log failed)"
    except Exception:
        commits = "(git log failed)"

    # Active kill switches / feature flags from .env
    env_lines: list = []
    try:
        with open(PROJECT_ROOT / ".env") as f:
            for ln in f:
                ln = ln.strip()
                if not ln or ln.startswith("#"):
                    continue
                if any(k in ln for k in ("ENABLED=", "HARD_GATE=", "_HARD_GATE", "SCORING_ENABLED")):
                    env_lines.append(ln.split("#", 1)[0].strip())
    except Exception:
        pass

    # Format as a single readable digest the bot can paraphrase
    out = [f"=== Activity in last {hours}h ==="]
    if hive_rows:
        out.append("\nRecent agent actions (hive_mind):")
        for r in hive_rows:
            ts = time.strftime("%H:%M", time.localtime(r["created_at"]))
            out.append(f"  [{ts}] {r['agent_id']}: {r['action']} — {(r['summary'] or '')[:120]}")
    else:
        out.append("\nNo hive_mind events in the window.")

    if mission_rows:
        out.append("\nMissions (running/queued/recent):")
        for r in mission_rows:
            ts = time.strftime("%H:%M", time.localtime(r["created_at"]))
            done = ""
            if r["completed_at"]:
                done = f" → done {time.strftime('%H:%M', time.localtime(r['completed_at']))}"
            out.append(f"  [{ts}] {r['assigned_agent']} {r['status']}: {r['title']}{done}")
    else:
        out.append("\nNo mission activity.")

    out.append("\nRecent commits on main:")
    out.append(commits if commits else "  (none)")

    if env_lines:
        out.append("\nActive feature flags / kill switches:")
        for ln in env_lines:
            out.append(f"  {ln}")

    digest = "\n".join(out)
    await params.result_callback({"ok": True, "digest": digest})


async def list_agents_handler(params):
    """Tool: list the sub-agents Gemini can delegate to, with one-line descriptions."""
    # Build roster from the dynamic agent list + hardcoded descriptions for known agents
    _known_descriptions = {
        "main": "The Hand of the King. General ops, triage, defaults if unsure.",
        "research": "Grand Maester. Web research, academic sources, competitive intel.",
        "comms": "Master of Whisperers. Email, Slack, Telegram, customer comms.",
        "content": "The Royal Bard. Writing, scripts, LinkedIn, YouTube, blog posts.",
        "ops": "Master of War. Calendar, scheduling, internal tools, automations.",
    }
    roster = {}
    # Start with dynamic roster from /tmp/warroom-agents.json
    try:
        agents = json.loads(Path("/tmp/warroom-agents.json").read_text())
        for a in agents:
            aid = a["id"]
            roster[aid] = _known_descriptions.get(aid, a.get("description", "Specialist agent"))
    except Exception:
        roster = dict(_known_descriptions)
    await params.result_callback({"ok": True, "agents": roster})


async def answer_as_agent_handler(params):
    """Tool: synchronously invoke a sub-agent and return its text response.

    Used by auto/hand-raise mode. Unlike delegate_to_agent (which queues
    an async mission task and returns immediately), this one blocks until
    the agent produces a response, then returns the text verbatim so
    Gemini Live can read it out loud as-is.

    Also pushes an RTVIServerMessageFrame before the subprocess spawn so
    the browser's onServerMessage callback can trigger a hand-up animation
    on the chosen agent's sidebar card while the user waits for audio.
    PipelineTask enables RTVI by default, so the auto-attached RTVIObserver
    converts our frame into a wire-format "server-message" that the
    Pipecat JS client delivers to onServerMessage.

    CRITICAL: like delegate_to_agent, we pass run_llm=False on the result
    so Pipecat does NOT trigger a follow-up Gemini inference. Without this,
    Gemini speaks the delegation acknowledgment twice.
    """
    from pipecat.frames.frames import FunctionCallResultProperties
    silent = FunctionCallResultProperties(run_llm=False)
    from pipecat.processors.frameworks.rtvi import RTVIServerMessageFrame
    from pipecat.processors.frame_processor import FrameDirection

    args = params.arguments or {}
    agent = args.get("agent")
    question = args.get("question")

    if agent not in VALID_AGENTS or not isinstance(question, str) or not question.strip():
        await params.result_callback({
            "ok": False,
            "error": f"invalid args: agent must be one of {sorted(VALID_AGENTS)} and question is required",
        }, properties=silent)
        return

    if not VOICE_BRIDGE.exists():
        await params.result_callback({
            "ok": False,
            "error": "agent-voice-bridge not built; run `npm run build` from the project root",
        }, properties=silent)
        return

    # Fire the hand-up signal to the browser BEFORE the expensive
    # subprocess call. The RTVIObserver in the pipeline picks this up
    # and wraps it into an RTVI "server-message" envelope that the JS
    # client surfaces via onServerMessage. This is how the user sees
    # "research has their hand up" a beat before hearing the answer.
    try:
        hand_up_frame = RTVIServerMessageFrame(
            data={"event": "agent_selected", "agent": agent},
        )
        await params.llm.push_frame(hand_up_frame, FrameDirection.DOWNSTREAM)
    except Exception as exc:
        # Non-fatal: the browser just won't show the animation. Log
        # and continue to the actual answer.
        logger.warning("answer_as_agent: push hand-up frame failed: %s", exc)

    logger.info("answer_as_agent: agent=%s question=%r", agent, question[:80])

    cmd = [
        NODE_BIN, str(VOICE_BRIDGE),
        "--quick",
        "--agent", agent,
        "--chat-id", WARROOM_CHAT_ID,
        "--message", question,
    ]
    code, out, err = await _run_subprocess(cmd, timeout=ANSWER_TIMEOUT_SEC)

    if code != 0:
        logger.error("answer_as_agent failed: code=%d stderr=%s", code, err[:200])
        await params.result_callback({
            "ok": False,
            "agent": agent,
            "error": err[:200] or "voice bridge failed",
        }, properties=silent)
        return

    # The voice bridge prints a single JSON line to stdout:
    #   {"response": "...", "usage": {...}, "error": null}
    try:
        payload = json.loads(out)
    except json.JSONDecodeError:
        logger.error("answer_as_agent: invalid JSON from bridge: %r", out[:200])
        await params.result_callback({
            "ok": False,
            "agent": agent,
            "error": "invalid bridge output",
        }, properties=silent)
        return

    response_text = payload.get("response")
    if payload.get("error") or not response_text:
        await params.result_callback({
            "ok": False,
            "agent": agent,
            "error": payload.get("error") or "empty response",
        }, properties=silent)
        return

    await params.result_callback({
        "ok": True,
        "agent": agent,
        "text": response_text,
    }, properties=silent)


# ─── Mode 1: Gemini Live (speech-to-speech + tools) ────────────────────────

# Shared with the dashboard — any HTTP POST to /api/warroom/pin writes here.
PIN_PATH = Path("/tmp/warroom-pin.json")

VALID_MODES = {"direct", "auto"}


def read_pin_state() -> tuple[str, str]:
    """Return (agent, mode) tuple from the pin file.

    Defaults to ("main", "direct") if the file is missing or malformed.
    The Pipecat server reads this on startup to decide which agent's
    voice, persona, and tool set to load. Changing either field requires
    a respawn (handled by the dashboard's /api/warroom/pin endpoint).
    """
    if not PIN_PATH.exists():
        return "main", "direct"
    try:
        with open(PIN_PATH, "r") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return "main", "direct"
        agent = data.get("agent")
        if not isinstance(agent, str) or agent not in VALID_AGENTS:
            agent = "main"
        mode = data.get("mode")
        if not isinstance(mode, str) or mode not in VALID_MODES:
            mode = "direct"
        return agent, mode
    except (OSError, json.JSONDecodeError, ValueError):
        return "main", "direct"


def read_pinned_agent() -> str:
    """Back-compat wrapper: return just the agent id."""
    agent, _ = read_pin_state()
    return agent


async def run_live_mode():
    """Gemini Live native-audio pipeline with tool calling."""
    from pipecat.services.google.gemini_live.llm import GeminiLiveLLMService
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
    from pipecat.turns.user_turn_strategies import UserTurnStrategies
    from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import SpeechTimeoutUserTurnStopStrategy
    from pipecat.adapters.schemas.function_schema import FunctionSchema
    from pipecat.adapters.schemas.tools_schema import ToolsSchema
    from pipecat.frames.frames import LLMContextFrame
    from personas import get_persona

    from pipecat.frames.frames import (
        MetricsFrame, UserStoppedSpeakingFrame, BotStartedSpeakingFrame
    )
    from pipecat.metrics.metrics import TTFBMetricsData, ProcessingMetricsData
    from pipecat.processors.frame_processor import FrameProcessor, FrameDirection

    class LatencyLogger(FrameProcessor):
        """Intercepts timing frames to surface per-turn latency breakdowns.

        Tracks two independent clocks:
          • user_stopped_at  — set when UserStoppedSpeakingFrame passes through
            (i.e. the moment the speech-timeout strategy fires and declares
            end-of-turn; Gemini receives the turn-complete signal immediately
            after this).
          • bot_started_at   — set when BotStartedSpeakingFrame arrives
            (i.e. Gemini's first audio frame has reached the pipeline).

        The delta between the two is the *true* E2E latency from end-of-speech
        to first audio out. It includes:
            speech_timeout wait  +  Gemini network RTT  +  Gemini processing
        TTFB from MetricsFrame covers only the last two legs (starts after the
        timeout fires), so:
            E2E ≈ speech_timeout + TTFB
        """

        def __init__(self):
            super().__init__()
            self._user_stopped_at: float | None = None

        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)

            if isinstance(frame, UserStoppedSpeakingFrame):
                self._user_stopped_at = time.monotonic()
                logger.info("⏱  VAD end-of-speech detected — waiting for Gemini")

            elif isinstance(frame, BotStartedSpeakingFrame):
                if self._user_stopped_at is not None:
                    e2e_ms = (time.monotonic() - self._user_stopped_at) * 1000
                    logger.info("⏱  E2E latency (EOSpeech → first audio): %.0f ms", e2e_ms)
                    self._user_stopped_at = None

            elif isinstance(frame, MetricsFrame):
                for m in frame.data:
                    if isinstance(m, TTFBMetricsData):
                        logger.info(
                            "⏱  TTFB [%s/%s]: %.0f ms",
                            m.processor, m.model or "?", m.value * 1000,
                        )
                    elif isinstance(m, ProcessingMetricsData):
                        logger.info(
                            "⏱  Processing [%s/%s]: %.0f ms",
                            m.processor, m.model or "?", m.value * 1000,
                        )

            await self.push_frame(frame, direction)

    check_required_keys({"GOOGLE_API_KEY": "Google AI (Gemini Live native audio)"})

    port = int(os.environ.get("WARROOM_PORT", "7860"))
    model = os.environ.get("WARROOM_LIVE_MODEL")  # None = use Pipecat's default
    # Silence duration (seconds) before end-of-turn fires. Lower = faster
    # replies; too low cuts natural pauses. Default 0.3 s (was 0.6 s).
    speech_timeout = float(os.environ.get("WARROOM_SPEECH_TIMEOUT", "0.3"))

    # Determine which agent + mode is active. Defaults: ("main", "direct").
    # If the user has clicked an agent card or a mode button on the
    # dashboard, /api/warroom/pin wrote both fields here and then killed
    # the warroom subprocess so this fresh process picks up the new pin.
    active_agent, active_mode = read_pin_state()
    logger.info("Active agent=%s mode=%s", active_agent, active_mode)

    # In auto mode, voice comes from main (Gemini is the front desk,
    # agents answer through it verbatim so they all sound the same
    # until v2 session pooling lands).
    voice_agent = "main" if active_mode == "auto" else active_agent
    active_entry = AGENT_VOICES.get(voice_agent) or AGENT_VOICES.get("main", {})
    configured_voice = active_entry.get("gemini_voice") or "Charon"
    voice = os.environ.get("WARROOM_LIVE_VOICE", configured_voice)
    system_prompt = get_persona(active_agent, mode=active_mode)

    transport = make_transport(port)

    # Define the toolset Gemini can call ----------------------------------
    delegate_schema = FunctionSchema(
        name="delegate_to_agent",
        description=(
            "Delegate a unit of work to one of the user's sub-agents. The sub-agent "
            "runs the task asynchronously through its full Claude Code environment "
            "and pings the user on Telegram when finished. Use this for anything that "
            "requires real execution: research, drafting messages, file operations, "
            "scheduling, running code. After calling this, tell the user verbally that "
            "you've queued it and they'll be notified when done. DO NOT wait."
        ),
        properties={
            "agent": {
                "type": "string",
                "enum": sorted(VALID_AGENTS),
                "description": "Which sub-agent should handle this work.",
            },
            "title": {
                "type": "string",
                "description": "Short 3-8 word label for the task (for the Telegram notification).",
            },
            "prompt": {
                "type": "string",
                "description": "Full instructions for the sub-agent. Be specific about what the user wants.",
            },
            "priority": {
                "type": "integer",
                "description": "Task priority 0-10 (default 5). Use 8+ only for truly urgent work.",
            },
        },
        required=["agent", "title", "prompt"],
    )

    get_time_schema = FunctionSchema(
        name="get_time",
        description="Get the current wall clock time in the user's local timezone. Use when they ask what time it is.",
        properties={},
        required=[],
    )

    list_agents_schema = FunctionSchema(
        name="list_agents",
        description="List the user's sub-agents with their one-line role descriptions. Use when they ask 'who's on my team' or 'who can I delegate to'.",
        properties={},
        required=[],
    )

    recent_activity_schema = FunctionSchema(
        name="get_recent_activity",
        description=(
            "Get a digest of what's actually happening on this box right now: "
            "recent agent actions from hive_mind, currently running and recently "
            "completed missions, the last few git commits on main, and which "
            "feature flags/kill switches are active. Call this BEFORE answering "
            "any question about state, status, what's running, what changed, "
            "what we shipped, recent errors, or any 'do you know what's going on' "
            "question. Do not guess or bluff — read the digest first."
        ),
        properties={
            "hours": {
                "type": "integer",
                "description": "How many hours back to look (1-72, default 6).",
            },
        },
        required=[],
    )

    # answer_as_agent is only registered in auto mode. In direct mode,
    # Gemini should not be routing calls away from the pinned agent —
    # the pinned agent IS the one answering, via its own persona.
    standard_tools = [delegate_schema, get_time_schema, list_agents_schema, recent_activity_schema]
    if active_mode == "auto":
        answer_schema = FunctionSchema(
            name="answer_as_agent",
            description=(
                "Route the user's question to the best-fit specialist and return their "
                "answer verbatim. Use this for EVERY substantive question in auto mode. "
                "Pick the agent whose role matches the question. Speak a one-word "
                "acknowledgment BEFORE calling this tool, then when it returns, read "
                "the 'text' field verbatim with no commentary."
            ),
            properties={
                "agent": {
                    "type": "string",
                    "enum": sorted(VALID_AGENTS),
                    "description": "Which specialist should answer.",
                },
                "question": {
                    "type": "string",
                    "description": "The user's full question, cleaned up grammatically if needed.",
                },
            },
            required=["agent", "question"],
        )
        standard_tools.append(answer_schema)

    tools = ToolsSchema(standard_tools=standard_tools)

    # Seed the LLM context with an empty message list + tools. Gemini Live
    # uses the tools from the context, not from the service constructor.
    context = LLMContext(messages=[], tools=tools)

    # Build the service -----------------------------------------------------
    live_kwargs = dict(
        api_key=os.environ["GOOGLE_API_KEY"],
        system_instruction=system_prompt,
        # inference_on_context_initialization=False prevents Gemini from
        # proactively speaking when the session opens; wait for the user to
        # say something first.
        inference_on_context_initialization=False,
    )
    if model:
        live_kwargs["model"] = model
    # Always pass voice_id so the configured agent voice takes effect,
    # even for main (Charon). Pipecat only warns about deprecation, not
    # actively breaks.
    live_kwargs["voice_id"] = voice

    llm = GeminiLiveLLMService(**live_kwargs)

    # Register the tool handlers. register_function binds a Python async
    # callable to a named function on the LLM side; when Gemini emits a
    # tool_call Pipecat calls our handler with FunctionCallParams.
    llm.register_function("delegate_to_agent", delegate_to_agent_handler)
    llm.register_function("get_time", get_time_handler)
    llm.register_function("list_agents", list_agents_handler)
    llm.register_function("get_recent_activity", get_recent_activity_handler)
    if active_mode == "auto":
        llm.register_function("answer_as_agent", answer_as_agent_handler)

    # Context aggregator pair. This is the piece that was missing before —
    # it routes user speech / Gemini responses into the LLMContext and
    # triggers `set_context()` on the service so `_ready_for_realtime_input`
    # flips True and audio actually flows.
    # Disable Smart Turn (LocalSmartTurnAnalyzerV3) — fragments Arabic speech
    # into 4+ false stops per utterance. Replace with timeout-based stop that
    # uses Gemini Live final-transcription signals.
    # speech_timeout = env WARROOM_SPEECH_TIMEOUT (default 0.3 s, was 0.6 s).
    # Lower value → faster reply; raise to 0.5–0.6 if false stops appear.
    aggregators = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            user_turn_strategies=UserTurnStrategies(
                stop=[SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=speech_timeout)],
            ),
        ),
    )

    latency_logger = LatencyLogger()

    pipeline = Pipeline([
        transport.input(),
        aggregators.user(),
        llm,
        latency_logger,
        aggregators.assistant(),
        transport.output(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=True,
        ),
        # CRITICAL: disable the default 5-minute idle timeout. Without this,
        # Pipecat cancels the pipeline after 5 min of no BotSpeaking/UserSpeaking
        # frames, which triggers main's respawn logic and leaves the subprocess
        # mid-init for ~5s. That's what caused "first click always fails" after
        # being away from the warroom page. Main still owns the subprocess
        # lifecycle via launchd + the exit handler in src/index.ts, so we don't
        # need Pipecat second-guessing it.
        idle_timeout_secs=None,
        cancel_on_idle_timeout=False,
    )

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected; keeping pipeline alive for next meeting")

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Client connected (live mode); resetting context and pushing LLMContextFrame")
        # Clear stale messages from previous meeting sessions. The context
        # object is created once on server startup and reused across clients
        # because the pipeline stays alive. Without this, Gemini's context
        # accumulates conversation history across meetings.
        context.messages.clear()
        # CRITICAL: Gemini Live won't accept any incoming audio until the
        # service has seen an LLMContextFrame (the service uses this to
        # install its tools + system prompt and flip _ready_for_realtime_input
        # to True). Without VAD on the transport, the user aggregator never
        # fires an end-of-turn, so nothing would ever push a context frame
        # into the pipeline. We seed it manually here, on every new client.
        await task.queue_frame(LLMContextFrame(context=context))

    print_ready(port, "live")
    runner = PipelineRunner(handle_sigterm=True)
    logger.info(
        "War Room LIVE mode on ws://0.0.0.0:%d (agent=%s mode=%s voice=%s model=%s tools=%d speech_timeout=%.2fs)",
        port, active_agent, active_mode, voice, model or "pipecat-default", len(standard_tools), speech_timeout,
    )
    await runner.run(task)
    logger.info("War Room session ended.")


# ─── Mode 1b: OpenAI Realtime (speech-to-speech + tools) ───────────────────

async def run_realtime_mode():
    """OpenAI Realtime API pipeline with tool calling.

    Architecturally identical to run_live_mode():
        WebSocket → user aggregator → OpenAI Realtime → latency_logger
                  → assistant aggregator → WebSocket
    Same tool schemas, same persona logic, same speech-timeout stop strategy,
    same LLMContextFrame seeding on connect. Only the LLM service changes.

    Sample rates: OpenAI Realtime is 24 kHz in both directions (Gemini Live
    was 16 kHz in / 24 kHz out). We override audio_in_sample_rate on the
    transport via make_transport(audio_in_sr=24000).

    Voice: WARROOM_REALTIME_VOICE env var, default "alloy". Valid OpenAI
    voices: alloy, ash, ballad, coral, echo, fable, onyx, nova, sage,
    shimmer, verse.

    Model: WARROOM_REALTIME_MODEL env var; if unset, pipecat 0.0.108's
    built-in default (gpt-4o-realtime-preview-2025-06-03) is used.
    """
    from pipecat.services.openai_realtime_beta import OpenAIRealtimeBetaLLMService
    from pipecat.services.openai_realtime_beta.events import SessionProperties
    from pipecat.processors.aggregators.openai_llm_context import (
        OpenAILLMContext,
        OpenAILLMContextFrame,
    )
    # OpenAI Realtime's create_context_aggregator() expects the OpenAI-flavor
    # LLMUserAggregatorParams (with aggregation_timeout), NOT the universal one
    # (with user_turn_strategies). Using the universal class crashes the
    # aggregator on the first frame with AttributeError.
    from pipecat.processors.aggregators.llm_response import LLMUserAggregatorParams
    from pipecat.adapters.schemas.function_schema import FunctionSchema
    from pipecat.adapters.schemas.tools_schema import ToolsSchema
    from personas import get_persona

    from pipecat.frames.frames import (
        MetricsFrame, UserStoppedSpeakingFrame, BotStartedSpeakingFrame
    )
    from pipecat.metrics.metrics import TTFBMetricsData, ProcessingMetricsData
    from pipecat.processors.frame_processor import FrameProcessor, FrameDirection

    class LatencyLogger(FrameProcessor):
        """Same latency probe as live mode — see run_live_mode for details."""

        def __init__(self):
            super().__init__()
            self._user_stopped_at: float | None = None

        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)

            if isinstance(frame, UserStoppedSpeakingFrame):
                self._user_stopped_at = time.monotonic()
                logger.info("⏱  VAD end-of-speech detected — waiting for OpenAI Realtime")

            elif isinstance(frame, BotStartedSpeakingFrame):
                if self._user_stopped_at is not None:
                    e2e_ms = (time.monotonic() - self._user_stopped_at) * 1000
                    logger.info("⏱  E2E latency (EOSpeech → first audio): %.0f ms", e2e_ms)
                    self._user_stopped_at = None

            elif isinstance(frame, MetricsFrame):
                for m in frame.data:
                    if isinstance(m, TTFBMetricsData):
                        logger.info(
                            "⏱  TTFB [%s/%s]: %.0f ms",
                            m.processor, m.model or "?", m.value * 1000,
                        )
                    elif isinstance(m, ProcessingMetricsData):
                        logger.info(
                            "⏱  Processing [%s/%s]: %.0f ms",
                            m.processor, m.model or "?", m.value * 1000,
                        )

            await self.push_frame(frame, direction)

    check_required_keys({"OPENAI_API_KEY": "OpenAI (Realtime API)"})

    port = int(os.environ.get("WARROOM_PORT", "7860"))
    model = os.environ.get("WARROOM_REALTIME_MODEL")  # None → pipecat default
    speech_timeout = float(os.environ.get("WARROOM_SPEECH_TIMEOUT", "0.3"))

    active_agent, active_mode = read_pin_state()
    logger.info("Active agent=%s mode=%s", active_agent, active_mode)

    voice = os.environ.get("WARROOM_REALTIME_VOICE", "alloy")
    system_prompt = get_persona(active_agent, mode=active_mode)

    # OpenAI Realtime expects 24 kHz both in and out.
    transport = make_transport(port, audio_in_sr=24000, audio_out_sr=24000)

    # Same tool schemas as live mode. Pipecat's OpenAI adapter converts
    # ToolsSchema → OpenAI tool format inside _send_session_update.
    delegate_schema = FunctionSchema(
        name="delegate_to_agent",
        description=(
            "Delegate a unit of work to one of the user's sub-agents. The sub-agent "
            "runs the task asynchronously through its full Claude Code environment "
            "and pings the user on Telegram when finished. Use this for anything that "
            "requires real execution: research, drafting messages, file operations, "
            "scheduling, running code. After calling this, tell the user verbally that "
            "you've queued it and they'll be notified when done. DO NOT wait."
        ),
        properties={
            "agent": {
                "type": "string",
                "enum": sorted(VALID_AGENTS),
                "description": "Which sub-agent should handle this work.",
            },
            "title": {
                "type": "string",
                "description": "Short 3-8 word label for the task (for the Telegram notification).",
            },
            "prompt": {
                "type": "string",
                "description": "Full instructions for the sub-agent. Be specific about what the user wants.",
            },
            "priority": {
                "type": "integer",
                "description": "Task priority 0-10 (default 5). Use 8+ only for truly urgent work.",
            },
        },
        required=["agent", "title", "prompt"],
    )

    get_time_schema = FunctionSchema(
        name="get_time",
        description="Get the current wall clock time in the user's local timezone. Use when they ask what time it is.",
        properties={},
        required=[],
    )

    list_agents_schema = FunctionSchema(
        name="list_agents",
        description="List the user's sub-agents with their one-line role descriptions. Use when they ask 'who's on my team' or 'who can I delegate to'.",
        properties={},
        required=[],
    )

    recent_activity_schema = FunctionSchema(
        name="get_recent_activity",
        description=(
            "Get a digest of what's actually happening on this box right now: "
            "recent agent actions from hive_mind, currently running and recently "
            "completed missions, the last few git commits on main, and which "
            "feature flags/kill switches are active. Call this BEFORE answering "
            "any question about state, status, what's running, what changed, "
            "what we shipped, recent errors, or any 'do you know what's going on' "
            "question. Do not guess or bluff — read the digest first."
        ),
        properties={
            "hours": {
                "type": "integer",
                "description": "How many hours back to look (1-72, default 6).",
            },
        },
        required=[],
    )

    standard_tools = [delegate_schema, get_time_schema, list_agents_schema, recent_activity_schema]
    if active_mode == "auto":
        answer_schema = FunctionSchema(
            name="answer_as_agent",
            description=(
                "Route the user's question to the best-fit specialist and return their "
                "answer verbatim. Use this for EVERY substantive question in auto mode. "
                "Pick the agent whose role matches the question. Speak a one-word "
                "acknowledgment BEFORE calling this tool, then when it returns, read "
                "the 'text' field verbatim with no commentary."
            ),
            properties={
                "agent": {
                    "type": "string",
                    "enum": sorted(VALID_AGENTS),
                    "description": "Which specialist should answer.",
                },
                "question": {
                    "type": "string",
                    "description": "The user's full question, cleaned up grammatically if needed.",
                },
            },
            required=["agent", "question"],
        )
        standard_tools.append(answer_schema)

    tools = ToolsSchema(standard_tools=standard_tools)

    # OpenAI Realtime requires its own context type (universal LLMContext is
    # not yet supported by OpenAIRealtimeBetaLLMService — it raises
    # NotImplementedError on LLMContextFrame). The system prompt goes in as
    # the first "system" message so pipecat extracts it as session
    # instructions during _send_session_update.
    context = OpenAILLMContext(
        messages=[{"role": "system", "content": system_prompt}],
        tools=tools,
    )

    # Session properties: voice + server-side audio format. Turn detection
    # is left at the pipecat default — we drive end-of-turn via the
    # SpeechTimeoutUserTurnStopStrategy on the user aggregator below, matching
    # live mode so the UX (interruption, false-stop behavior) is consistent.
    session_properties = SessionProperties(voice=voice)

    llm_kwargs = dict(
        api_key=os.environ["OPENAI_API_KEY"],
        session_properties=session_properties,
    )
    if model:
        llm_kwargs["model"] = model

    llm = OpenAIRealtimeBetaLLMService(**llm_kwargs)

    llm.register_function("delegate_to_agent", delegate_to_agent_handler)
    llm.register_function("get_time", get_time_handler)
    llm.register_function("list_agents", list_agents_handler)
    llm.register_function("get_recent_activity", get_recent_activity_handler)
    if active_mode == "auto":
        llm.register_function("answer_as_agent", answer_as_agent_handler)

    # OpenAI Realtime does its own server-side VAD (configured via the
    # session — see session_properties on the LLM service). The local
    # aggregator's aggregation_timeout is the buffer used to group streamed
    # transcripts before flushing to context, not the end-of-turn detector.
    # Match it to WARROOM_SPEECH_TIMEOUT for a similar-feeling cadence.
    aggregators = llm.create_context_aggregator(
        context,
        user_params=LLMUserAggregatorParams(aggregation_timeout=speech_timeout),
    )

    latency_logger = LatencyLogger()

    pipeline = Pipeline([
        transport.input(),
        aggregators.user(),
        llm,
        latency_logger,
        aggregators.assistant(),
        transport.output(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=True,
        ),
        # Same rationale as live mode — dashboard owns subprocess lifecycle,
        # don't let pipecat second-guess it after 5 min of silence.
        idle_timeout_secs=None,
        cancel_on_idle_timeout=False,
    )

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected; keeping pipeline alive for next meeting")

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Client connected (realtime mode); resetting context and pushing OpenAILLMContextFrame")
        # Drop accumulated history from prior meetings, keep the system
        # prompt so the persona survives.
        context.messages.clear()
        context.add_message({"role": "system", "content": system_prompt})
        # Seed the OpenAI context frame so the service installs tools +
        # instructions on the realtime session before audio starts flowing.
        await task.queue_frame(OpenAILLMContextFrame(context=context))

    print_ready(port, "realtime")
    runner = PipelineRunner(handle_sigterm=True)
    logger.info(
        "War Room REALTIME mode on ws://0.0.0.0:%d (agent=%s mode=%s voice=%s model=%s tools=%d speech_timeout=%.2fs)",
        port, active_agent, active_mode, voice, model or "pipecat-default", len(standard_tools), speech_timeout,
    )
    await runner.run(task)
    logger.info("War Room session ended.")


# ─── Mode 2: Legacy stitched pipeline ──────────────────────────────────────

async def run_legacy_mode():
    """Original Deepgram → router → Claude bridge → Cartesia pipeline."""
    from pipecat.services.cartesia.tts import CartesiaTTSService
    from pipecat.services.deepgram.stt import DeepgramSTTService
    from router import AgentRouter
    from agent_bridge import ClaudeAgentBridge

    check_required_keys({
        "DEEPGRAM_API_KEY": "Deepgram (speech-to-text)",
        "CARTESIA_API_KEY": "Cartesia (text-to-speech)",
    })

    port = int(os.environ.get("WARROOM_PORT", "7860"))

    default_voice = AGENT_VOICES.get(DEFAULT_AGENT, {})
    default_voice_id = default_voice.get("voice_id", "a0e99841-438c-4a64-b679-ae501e7d6091")

    transport = make_transport(port)

    stt = DeepgramSTTService(api_key=os.environ["DEEPGRAM_API_KEY"])
    tts = CartesiaTTSService(api_key=os.environ["CARTESIA_API_KEY"], voice_id=default_voice_id)

    router = AgentRouter()
    bridge = ClaudeAgentBridge()

    pipeline = Pipeline([
        transport.input(),
        stt,
        router,
        bridge,
        tts,
        transport.output(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=True,
        ),
    )

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected; keeping pipeline alive for next meeting")

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Client connected (legacy mode)")

    print_ready(port, "legacy")
    runner = PipelineRunner(handle_sigterm=True)
    logger.info("War Room LEGACY mode on ws://0.0.0.0:%d", port)
    await runner.run(task)
    logger.info("War Room session ended.")


# ─── Entry point ───────────────────────────────────────────────────────────

async def run_warroom():
    load_env()
    mode = os.environ.get("WARROOM_MODE", "live").strip().lower()
    if mode == "legacy":
        await run_legacy_mode()
    elif mode == "live":
        await run_live_mode()
    elif mode == "realtime":
        await run_realtime_mode()
    else:
        logger.error(
            "Unknown WARROOM_MODE=%r. Expected 'realtime', 'live', or 'legacy'. Defaulting to 'live'.",
            mode,
        )
        await run_live_mode()


def main():
    try:
        asyncio.run(run_warroom())
    except KeyboardInterrupt:
        logger.info("War Room shut down by user.")
    except Exception as exc:
        logger.error("War Room crashed: %s", exc, exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
