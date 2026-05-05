"""Central configuration for the autonomous agent."""

import os
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


def _read_dotenv(path: Path) -> dict[str, str]:
    """Read a minimal KEY=value env file without external dependencies."""
    values: dict[str, str] = {}
    if not path.exists():
        return values

    try:
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            if (
                len(value) >= 2
                and value[0] == value[-1]
                and value[0] in ("'", '"')
            ):
                value = value[1:-1]
            if key:
                values[key] = value
    except OSError:
        # A broken env file should not crash startup.
        return {}

    return values


ROOT_DIR = Path(__file__).resolve().parent.parent
AGENT_DIR = Path(__file__).resolve().parent
_PROJECT_ENV = _read_dotenv(ROOT_DIR / ".env")
_WORKSPACE_ENV: dict[str, str] = {}


def _env_value(name: str, default: str = "") -> str:
    if name in os.environ:
        return os.environ[name]
    if name in _WORKSPACE_ENV:
        return _WORKSPACE_ENV[name]
    if name in _PROJECT_ENV:
        return _PROJECT_ENV[name]
    return default


def _env_value_any(names: list[str], default: str = "") -> str:
    for name in names:
        value = _env_value(name)
        if value:
            return value
    return default


def _normalize_azure_endpoint(raw: str) -> str:
    """Accept a resource URL, v1 base URL, or full responses endpoint."""
    value = (raw or "").strip().strip('"').strip("'")
    if not value:
        return ""

    try:
        parts = urlsplit(value)
    except ValueError:
        return value

    if not parts.scheme or not parts.netloc:
        return value

    path = parts.path.rstrip("/")
    lowered = path.lower()

    if lowered.endswith("/openai/v1/responses") or lowered.endswith("/openai/responses"):
        return urlunsplit((parts.scheme, parts.netloc, path, parts.query, ""))

    if lowered.endswith("/openai/v1/chat/completions"):
        new_path = path[: -len("/chat/completions")] + "/responses"
        return urlunsplit((parts.scheme, parts.netloc, new_path, "", ""))

    if lowered.endswith("/models/chat/completions"):
        return urlunsplit(
            (parts.scheme, parts.netloc, "/openai/v1/responses", "", "")
        )

    if lowered.endswith("/openai/v1"):
        return urlunsplit(
            (parts.scheme, parts.netloc, f"{path}/responses", "", "")
        )

    if lowered.endswith("/openai"):
        return urlunsplit(
            (parts.scheme, parts.netloc, f"{path}/v1/responses", "", "")
        )

    if "/openai/" not in lowered and "/models/" not in lowered:
        base_path = path or ""
        return urlunsplit(
            (
                parts.scheme,
                parts.netloc,
                f"{base_path}/openai/v1/responses",
                "",
                "",
            )
        )

    return urlunsplit((parts.scheme, parts.netloc, path, parts.query, ""))


def _runtime_env_candidates(workspace: Path) -> list[Path]:
    configured = os.environ.get("AGENT_ENV_FILE", "").strip()
    candidates: list[Path] = []
    if configured:
        configured_path = Path(configured).expanduser()
        if not configured_path.is_absolute():
            configured_path = workspace / configured_path
        candidates.append(configured_path.resolve())

    candidates.append((workspace / ".agentvs" / "config.env").resolve())
    candidates.append((workspace / ".env").resolve())

    unique: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        unique.append(candidate)
    return unique


def _load_workspace_env(workspace: Path) -> tuple[dict[str, str], str]:
    merged: dict[str, str] = {}
    active_file = ""
    for candidate in _runtime_env_candidates(workspace):
        values = _read_dotenv(candidate)
        if not values:
            continue
        if not active_file:
            active_file = str(candidate)
        for key, value in values.items():
            merged.setdefault(key, value)
    return merged, active_file


def _default_workspace_dir() -> Path:
    raw = os.environ.get("AGENT_WORKSPACE") or _PROJECT_ENV.get("AGENT_WORKSPACE")
    if raw:
        return Path(raw).expanduser().resolve()
    return (ROOT_DIR / "workspace").resolve()


def _default_runtime_dir(workspace: Path) -> Path:
    return workspace / ".agentvs"


def _runtime_dir_for(workspace: Path) -> Path:
    override = _env_value("AGENT_RUNTIME_DIR", "")
    if override:
        return Path(override).expanduser().resolve()
    return _default_runtime_dir(workspace)


WORKSPACE_DIR = _default_workspace_dir()
ACTIVE_ENV_FILE = ""


def refresh_runtime_settings(path: "str | Path | None" = None) -> Path:
    """Refresh workspace-scoped configuration and runtime paths."""
    global WORKSPACE_DIR
    global ACTIVE_ENV_FILE
    global AZURE_ENDPOINT
    global AZURE_API_KEY
    global MODEL_NAME
    global MAX_ITERATIONS
    global RUNTIME_DIR
    global STATE_FILE
    global MEMORY_FILE
    global LOG_FILE
    global _WORKSPACE_ENV

    if path is not None:
        WORKSPACE_DIR = Path(path).expanduser().resolve()

    _WORKSPACE_ENV, ACTIVE_ENV_FILE = _load_workspace_env(WORKSPACE_DIR)

    AZURE_ENDPOINT = _normalize_azure_endpoint(
        _env_value_any(
            ["AZURE_FOUNDRY_ENDPOINT", "AZURE_OPENAI_ENDPOINT"],
            "",
        )
    )
    AZURE_API_KEY = _env_value_any(
        ["AZURE_FOUNDRY_API_KEY", "AZURE_OPENAI_API_KEY"],
        "",
    )
    MODEL_NAME = _env_value_any(
        ["AZURE_FOUNDRY_MODEL", "AZURE_OPENAI_MODEL"],
        "",
    )
    MAX_ITERATIONS = int(_env_value("AGENT_MAX_ITERATIONS", "60"))

    RUNTIME_DIR = _runtime_dir_for(WORKSPACE_DIR)
    STATE_FILE = RUNTIME_DIR / "state.json"
    MEMORY_FILE = RUNTIME_DIR / "memory.json"
    LOG_FILE = RUNTIME_DIR / "agent.log"

    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    return WORKSPACE_DIR


refresh_runtime_settings()


# ---------------------------------------------------------------------------
# HTTP client
# ---------------------------------------------------------------------------
HTTP_TIMEOUT = 120
HTTP_MAX_RETRIES = 5
HTTP_BACKOFF_BASE = 1.7  # seconds, exponential backoff base

# ---------------------------------------------------------------------------
# Agent runtime
# ---------------------------------------------------------------------------
MAX_CONSECUTIVE_FAILURES = 4
TOOL_TIMEOUT_SECONDS = 180


def set_workspace(path: "str | Path") -> Path:
    """Point the agent at a different workspace directory at runtime."""
    return refresh_runtime_settings(path)


# ---------------------------------------------------------------------------
# Safety: commands that are never allowed to run via the terminal tool
# ---------------------------------------------------------------------------
DANGEROUS_COMMAND_PATTERNS = [
    r"\brm\s+-rf\s+/",
    r":\(\)\s*\{.*:\|:&.*\};:",  # fork bomb
    r"\bmkfs\b",
    r"\bdd\s+if=.*of=/dev/",
    r"\bshutdown\b",
    r"\breboot\b",
    r"\bformat\s+[a-zA-Z]:",
    r"\bdel\s+/[fsq]\s+",
    r"\bRemove-Item.*-Recurse.*-Force.*[A-Za-z]:\\",
]

# Files / dirs the agent must never read or overwrite
PROTECTED_PATHS = {".agentvs", ".git", ".env", "id_rsa", "id_ed25519"}

# ---------------------------------------------------------------------------
# Workspace indexing
# ---------------------------------------------------------------------------
INDEXABLE_EXTENSIONS = {
    ".py",
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".json",
    ".md",
    ".txt",
    ".yml",
    ".yaml",
    ".toml",
    ".html",
    ".css",
    ".sql",
    ".sh",
    ".ps1",
    ".java",
    ".go",
    ".rs",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
}
MAX_INDEX_FILE_BYTES = 200_000
MAX_FILES_IN_PROMPT = 12
