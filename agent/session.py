"""Reusable host-facing session manager for the agent runtime."""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from . import config, logger, tools, workspace
from .agent import Agent
from .api_client import APIClientError, AzureResponsesClient
from .memory import AgentState, Memory

EventCallback = Callable[[Dict[str, Any]], None]


class SessionError(RuntimeError):
    """Raised when a host requests an invalid or unsupported action."""


class AgentSessionManager:
    """Owns the live agent thread plus host-visible workspace operations."""

    def __init__(self, history_cap: int = 400) -> None:
        self._lock = threading.Lock()
        self._agent: Optional[Agent] = None
        self._agent_thread: Optional[threading.Thread] = None

        self._event_callbacks: List[EventCallback] = []
        self._event_lock = threading.Lock()
        self._event_history: List[Dict[str, Any]] = []
        self._history_cap = history_cap

        logger.set_log_file(config.LOG_FILE)
        logger.subscribe(self._handle_logger_event)

    def close(self) -> None:
        logger.unsubscribe(self._handle_logger_event)

    # ------------------------------------------------------------------ #
    # Event fan-out
    # ------------------------------------------------------------------ #

    def _handle_logger_event(self, evt: Dict[str, Any]) -> None:
        self.publish(evt)

    def publish(self, evt: Dict[str, Any]) -> None:
        event = dict(evt)
        event.setdefault("ts", time.time())

        with self._event_lock:
            self._event_history.append(event)
            if len(self._event_history) > self._history_cap:
                overflow = len(self._event_history) - self._history_cap
                del self._event_history[:overflow]
            callbacks = list(self._event_callbacks)

        for callback in callbacks:
            try:
                callback(event)
            except Exception:
                pass

    def subscribe(self, callback: EventCallback) -> None:
        with self._event_lock:
            if callback not in self._event_callbacks:
                self._event_callbacks.append(callback)

    def unsubscribe(self, callback: EventCallback) -> None:
        with self._event_lock:
            if callback in self._event_callbacks:
                self._event_callbacks.remove(callback)

    def recent_events(self, limit: int = 150) -> List[Dict[str, Any]]:
        with self._event_lock:
            return list(self._event_history[-limit:])

    def clear_event_history(self) -> None:
        with self._event_lock:
            self._event_history.clear()

    # ------------------------------------------------------------------ #
    # Agent lifecycle
    # ------------------------------------------------------------------ #

    def is_running(self) -> bool:
        return bool(self._agent_thread and self._agent_thread.is_alive())

    def switch_workspace(self, path: str | Path) -> Path:
        resolved = Path(path).expanduser().resolve()
        with self._lock:
            if self.is_running():
                raise SessionError(
                    "Stop the running agent before switching folders."
                )
            unchanged = resolved == config.WORKSPACE_DIR
            new_path = config.set_workspace(resolved)
            logger.set_log_file(config.LOG_FILE)
            self._agent = None
            self._agent_thread = None

        if not unchanged:
            self.publish({
                "type": "info",
                "message": f"Workspace switched to {new_path}",
            })
        return new_path

    def start(
        self,
        goal: str,
        *,
        resume: bool = False,
        max_iterations: int | None = None,
    ) -> Dict[str, Any]:
        goal = goal.strip()
        if not goal:
            raise SessionError("Field 'goal' is required.")
        self._require_api_config()
        max_iterations = max_iterations or config.MAX_ITERATIONS

        with self._lock:
            if self.is_running():
                raise SessionError("An agent run is already in progress.")

            self.publish({
                "type": "run_started",
                "goal": goal,
                "max_iterations": max_iterations,
            })

            try:
                agent = Agent(goal, resume=resume)
            except Exception as exc:
                self.publish({
                    "type": "error",
                    "message": f"Failed to start agent: {exc}",
                })
                raise SessionError(str(exc)) from exc

            self._agent = agent

            def _runner() -> None:
                try:
                    agent.run(max_iterations=max_iterations)
                except Exception as exc:
                    self.publish({
                        "type": "error",
                        "message": f"Agent crashed: {exc}",
                    })
                finally:
                    self.publish({
                        "type": "run_done",
                        "state": agent.state.to_dict(),
                    })

            self._agent_thread = threading.Thread(
                target=_runner,
                name="agent-runner",
                daemon=True,
            )
            self._agent_thread.start()

        return {"status": "started", "goal": goal, "plan": agent.state.plan}

    def stop(self) -> Dict[str, Any]:
        with self._lock:
            if self._agent and self.is_running():
                self._agent.request_stop()
                return {"status": "stop_requested"}
        return {"status": "not_running"}

    def state(self) -> Dict[str, Any]:
        if self._agent is not None:
            state = self._agent.state.to_dict()
            state["running"] = self.is_running()
            return state

        state = AgentState.load().to_dict()
        state["running"] = False
        return state

    def reset_memory(self) -> Dict[str, Any]:
        with self._lock:
            if self.is_running():
                raise SessionError("Stop the running agent first.")

            for path in (config.STATE_FILE, config.MEMORY_FILE):
                if path.exists():
                    path.unlink()
            self._agent = None
            self._agent_thread = None

        self.clear_event_history()
        self.publish({"type": "info", "message": "Memory and state cleared."})
        return {"status": "cleared"}

    # ------------------------------------------------------------------ #
    # Workspace operations
    # ------------------------------------------------------------------ #

    def files_tree(self) -> Dict[str, Any]:
        items = workspace.list_directory("", recursive=True)
        return {
            "workspace": str(config.WORKSPACE_DIR),
            "runtime_dir": str(config.RUNTIME_DIR),
            "files": [
                {
                    "path": entry.rstrip("/").replace("\\", "/"),
                    "name": Path(entry.rstrip("/")).name,
                    "is_dir": entry.endswith("/"),
                }
                for entry in items
            ],
        }

    def read_file(self, path: str) -> Dict[str, Any]:
        result = tools.read_file(path)
        if not result.ok:
            raise SessionError(result.output)
        return {
            "path": path,
            "content": result.output,
            "bytes": result.meta.get("bytes", 0),
            "lines": result.meta.get("lines", 0),
        }

    def write_file(self, path: str, content: str) -> Dict[str, Any]:
        result = tools.write_file(path, content)
        if not result.ok:
            raise SessionError(result.output)
        return {
            "status": "saved",
            "path": path,
            "bytes": result.meta.get("bytes", 0),
        }

    def history(self, limit: int = 200) -> Dict[str, Any]:
        mem = Memory()
        return {"entries": mem.entries[-limit:]}

    # ------------------------------------------------------------------ #
    # Diagnostics
    # ------------------------------------------------------------------ #

    def health(self) -> Dict[str, Any]:
        config_ready = bool(
            config.AZURE_ENDPOINT and config.AZURE_API_KEY and config.MODEL_NAME
        )
        return {
            "ok": True,
            "model": config.MODEL_NAME,
            "endpoint": config.AZURE_ENDPOINT,
            "key_set": bool(config.AZURE_API_KEY),
            "endpoint_set": bool(config.AZURE_ENDPOINT),
            "model_set": bool(config.MODEL_NAME),
            "config_ready": config_ready,
            "env_file": config.ACTIVE_ENV_FILE,
            "workspace": str(config.WORKSPACE_DIR),
            "runtime_dir": str(config.RUNTIME_DIR),
            "state_file": str(config.STATE_FILE),
            "memory_file": str(config.MEMORY_FILE),
            "log_file": str(config.LOG_FILE),
            "running": self.is_running(),
        }

    def test_connection(self) -> Dict[str, Any]:
        self._require_api_config()

        client = AzureResponsesClient()
        probe = [
            {"role": "system", "content": "Reply with the single word: pong"},
            {"role": "user", "content": "ping"},
        ]
        try:
            text = client.respond(probe, max_output_tokens=16)
        except APIClientError as exc:
            raise SessionError(
                f"{config.MODEL_NAME} via {config.AZURE_ENDPOINT}: {exc}"
            ) from exc

        return {
            "ok": True,
            "endpoint": config.AZURE_ENDPOINT,
            "model": config.MODEL_NAME,
            "reply": text,
        }

    def _require_api_config(self) -> None:
        missing: list[str] = []
        if not config.AZURE_ENDPOINT:
            missing.append("endpoint")
        if not config.MODEL_NAME:
            missing.append("model/deployment")
        if not config.AZURE_API_KEY:
            missing.append("API key")
        if missing:
            raise SessionError(
                "Azure AI Foundry is not fully configured. Set "
                + ", ".join(missing)
                + " in Agent VS before running the agent."
            )
