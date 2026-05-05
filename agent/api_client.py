"""Thin REST wrapper around the Azure OpenAI Responses API.

This module deliberately uses ``requests`` only — no ``openai`` /
``AzureOpenAI`` SDK is imported anywhere in the project.

Endpoint:
    https://<resource>.cognitiveservices.azure.com/openai/responses
        ?api-version=2025-04-01-preview

Wire format used here is the *Responses* shape:

    POST /openai/responses?api-version=...
    {
        "model": "gpt-5.4",
        "input": [
            {"role": "system",   "content": "..."},
            {"role": "user",     "content": "..."},
            {"role": "assistant","content": "..."}
        ]
    }

Response shape (Azure Responses API):

    {
        "id": "...",
        "output": [
            {
                "type": "message",
                "role": "assistant",
                "content": [
                    {"type": "output_text", "text": "..."}
                ]
            }
        ],
        "output_text": "..."   # convenience field, sometimes present
    }
"""

from __future__ import annotations

import json
import random
import time
from typing import Any, Dict, List, Optional

import requests

from . import config, logger


class APIClientError(RuntimeError):
    """Raised when the model API cannot be reached or returns a fatal error."""


class AzureResponsesClient:
    """Reusable, retry-aware REST client for the Azure Responses endpoint."""

    def __init__(
        self,
        endpoint: Optional[str] = None,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
    ) -> None:
        self.endpoint = endpoint or config.AZURE_ENDPOINT
        self.api_key = api_key or config.AZURE_API_KEY
        self.model = model or config.MODEL_NAME

        if not self.endpoint:
            logger.warn(
                "Azure AI Foundry endpoint not set - configure the extension "
                "before running the agent."
            )

        if not self.api_key:
            logger.warn(
                "Azure AI Foundry API key not set - the agent will fail on "
                "the first model call."
            )

        if not self.model:
            logger.warn(
                "Azure AI Foundry model/deployment not set - the agent will "
                "fail on the first model call."
            )

        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        if self.api_key:
            self.session.headers["api-key"] = self.api_key

    # ------------------------------------------------------------------ #
    # Public helpers
    # ------------------------------------------------------------------ #

    def respond(
        self,
        messages: List[Dict[str, str]],
        *,
        temperature: Optional[float] = None,
        max_output_tokens: Optional[int] = None,
        text_format: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Send a chat-style conversation and return the assistant text.

        ``messages`` is a list of ``{"role": ..., "content": ...}`` dicts.
        Roles ``system``, ``user`` and ``assistant`` are supported.

        ``text_format`` maps to the Responses API's ``text.format`` field
        (e.g. ``{"type": "json_object"}``). The legacy ``response_format``
        parameter was removed in the 2025-04 Responses API.
        """
        payload: Dict[str, Any] = {
            "model": self.model,
            "input": messages,
        }
        if temperature is not None:
            payload["temperature"] = temperature
        if max_output_tokens is not None:
            payload["max_output_tokens"] = max_output_tokens
        if text_format is not None:
            payload["text"] = {"format": text_format}

        raw = self._post_with_retry(payload)
        return self._extract_text(raw)

    def respond_json(
        self,
        messages: List[Dict[str, str]],
        *,
        temperature: Optional[float] = 0.2,
        max_output_tokens: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Like :meth:`respond` but parses the assistant text as JSON.

        The model is instructed (via the system prompt) to return strict
        JSON; this helper additionally tolerates fenced ```json blocks
        and stray prose by extracting the first balanced ``{...}`` chunk.
        """
        text = self.respond(
            messages,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
            text_format={"type": "json_object"},
        )
        return _safe_json_loads(text)

    # ------------------------------------------------------------------ #
    # Internal
    # ------------------------------------------------------------------ #

    def _post_with_retry(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self.endpoint:
            raise APIClientError("No Azure AI Foundry endpoint is configured.")
        if not self.api_key:
            raise APIClientError("No Azure AI Foundry API key is configured.")
        if not self.model:
            raise APIClientError(
                "No Azure AI Foundry model or deployment name is configured."
            )

        last_err: Optional[Exception] = None
        for attempt in range(1, config.HTTP_MAX_RETRIES + 1):
            try:
                logger.debug("POST /openai/responses",
                             attempt=attempt, model=payload.get("model"))
                resp = self.session.post(
                    self.endpoint,
                    data=json.dumps(payload),
                    timeout=config.HTTP_TIMEOUT,
                )
            except requests.RequestException as exc:
                last_err = exc
                self._sleep_backoff(attempt, reason=f"network: {exc}")
                continue

            if resp.status_code == 200:
                try:
                    return resp.json()
                except ValueError as exc:
                    raise APIClientError(
                        f"Non-JSON 200 response: {resp.text[:400]}"
                    ) from exc

            # Retry on transient classes
            if resp.status_code in (408, 409, 425, 429, 500, 502, 503, 504):
                last_err = APIClientError(
                    f"HTTP {resp.status_code}: {resp.text[:300]}"
                )
                retry_after = resp.headers.get("Retry-After")
                self._sleep_backoff(
                    attempt,
                    reason=f"status {resp.status_code}",
                    retry_after=retry_after,
                )
                continue

            # Non-retryable
            raise APIClientError(
                f"Azure responded {resp.status_code}: {resp.text[:600]}"
            )

        raise APIClientError(
            f"Exhausted {config.HTTP_MAX_RETRIES} retries: {last_err}"
        )

    @staticmethod
    def _sleep_backoff(
        attempt: int,
        *,
        reason: str,
        retry_after: Optional[str] = None,
    ) -> None:
        if retry_after:
            try:
                delay = float(retry_after)
            except ValueError:
                delay = config.HTTP_BACKOFF_BASE ** attempt
        else:
            delay = config.HTTP_BACKOFF_BASE ** attempt
        delay += random.uniform(0, 0.4)  # jitter
        logger.warn(
            "API call failed, backing off",
            reason=reason, attempt=attempt, sleep_s=round(delay, 2),
        )
        time.sleep(delay)

    @staticmethod
    def _extract_text(raw: Dict[str, Any]) -> str:
        """Pull the assistant text out of a Responses API payload.

        We tolerate several known shapes so the agent keeps running even
        if Azure tweaks the response envelope.
        """
        # 1. Convenience field
        if isinstance(raw.get("output_text"), str) and raw["output_text"]:
            return raw["output_text"]

        # 2. Standard `output` array of message blocks
        out = raw.get("output")
        if isinstance(out, list):
            chunks: List[str] = []
            for item in out:
                if not isinstance(item, dict):
                    continue
                if item.get("type") not in (None, "message"):
                    continue
                content = item.get("content")
                if isinstance(content, str):
                    chunks.append(content)
                elif isinstance(content, list):
                    for c in content:
                        if not isinstance(c, dict):
                            continue
                        if c.get("type") in ("output_text", "text", None):
                            txt = c.get("text") or c.get("value") or ""
                            if isinstance(txt, str):
                                chunks.append(txt)
            if chunks:
                return "\n".join(chunks).strip()

        # 3. Legacy chat.completions shape (defensive)
        choices = raw.get("choices")
        if isinstance(choices, list) and choices:
            msg = choices[0].get("message", {})
            if isinstance(msg, dict) and isinstance(msg.get("content"), str):
                return msg["content"]

        raise APIClientError(
            f"Could not locate assistant text in response: "
            f"{json.dumps(raw)[:500]}"
        )


# ---------------------------------------------------------------------------
# JSON parsing helpers
# ---------------------------------------------------------------------------


def _safe_json_loads(text: str) -> Dict[str, Any]:
    """Parse JSON from a model reply, tolerating fences and surrounding prose."""
    text = (text or "").strip()
    if not text:
        raise APIClientError("Model returned empty content where JSON expected")

    # Strip ```json fences if the model added them despite response_format
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Fallback: find first balanced {...} block
    start = text.find("{")
    if start == -1:
        raise APIClientError(f"No JSON object found in model reply: {text[:300]}")

    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                snippet = text[start:i + 1]
                try:
                    return json.loads(snippet)
                except json.JSONDecodeError as exc:
                    raise APIClientError(
                        f"Malformed JSON in model reply: {exc}: {snippet[:300]}"
                    ) from exc

    raise APIClientError(f"Unterminated JSON object in model reply: {text[:300]}")
