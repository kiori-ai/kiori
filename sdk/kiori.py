"""Kiori Python client. Python 3.8+, no dependencies.

Kiori stores no brains and no chats. A brain is a dict you keep (in your database, or on your player's device) and
send with each call; calls that change it give it back.

    from kiori import Kiori
    kiori = Kiori(os.environ["KIORI_API_KEY"])

    # once per character: a brain from its card; keep it, and start each new conversation from a copy of it
    brain = kiori.create(character_card=card)

    # every turn: what the character knows right now, for your prompt (messages OpenAI-style, with your ids; the
    # recent ones are enough)
    recent = messages[-60:]
    context = kiori.recall(brain=brain, messages=recent)
    system_prompt += "\\n\\n" + context["text"]

    # after the reply: the brain learns from the chat; keep the brain that comes back
    brain = kiori.organize(brain=brain, messages=messages[-60:])["brain"]

    # optionally, when context["check_recommended"]: let the auditor check your model's draft
    verdict = kiori.check(brain=brain, messages=recent, draft=reply)

A call is asked again on its own (twice at most) when Kiori or the model provider is briefly unavailable or out of
reach. That's safe: Kiori keeps nothing between calls, so the same brain in gives the same kind of brain out.
"""
import email.utils
import http.client
import json
import random
import socket
import time
import urllib.error
import urllib.parse
import urllib.request

__all__ = ["Kiori", "KioriError"]


class KioriError(Exception):
    """status is the HTTP status, or 0 when Kiori couldn't be reached (code NETWORK) or didn't answer in time (TIMEOUT);
    retry_after is the seconds Kiori asked to wait (Retry-After), when it did; request_id is the call's id, to quote
    when you write to us about it."""

    def __init__(self, status, message, code=None, retry_after=None, request_id=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.retry_after = retry_after
        self.request_id = request_id


def _seconds_after(value):
    """Retry-After in seconds (it's seconds, or a date); None when there is none."""
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        return max(0.0, email.utils.parsedate_to_datetime(value).timestamp() - time.time())
    except (TypeError, ValueError):
        return None


# Asked again: Kiori or the model provider was busy or briefly down (or a gateway in front of them failed), or Kiori
# was out of reach. Not a timeout (the work may still be going on), not a key or credit problem, not answers that
# stayed unusable after Kiori's own tries (INCOMPLETE), and not when Kiori asks to wait more than 20 seconds. A call
# that isn't safe to repeat (a new key) is asked again only after a 429.
_AGAIN = {408, 429, 502, 503, 520, 521, 522, 523, 530}
_FINAL = {"NEEDS_KEY", "NO_KEY", "BAD_KEY", "CREDITS", "INCOMPLETE"}


def _retry_delay(e, attempt, safe):
    if e.code == "NETWORK":
        again = safe
    else:
        again = e.status in _AGAIN and e.code not in _FINAL and (safe or e.status == 429)
    if not again:
        return None
    if e.retry_after is not None:
        return e.retry_after if e.retry_after <= 20 else None
    return 2 ** attempt * random.uniform(0.75, 1.25)


def _id(value):
    return urllib.parse.quote(str(value), safe="")


def _q(**params):
    pairs = {k: v for k, v in params.items() if v is not None}
    return "?" + urllib.parse.urlencode(pairs) if pairs else ""


class _Project:
    def __init__(self, client):
        self._c = client

    def get(self):
        return self._c.request("GET", "/v1/project")

    def update(self, **body):
        """name=..., llm={"key": ...} (your brain API key: the provider is recognized from it), llm={"model": ...}."""
        return self._c.request("PATCH", "/v1/project", body)

    def models(self):
        """The models your brain API key can use, the suggested one first."""
        return self._c.request("GET", "/v1/project/models")

    def usage(self, days=None):
        return self._c.request("GET", "/v1/usage" + _q(days=days))

    def create_key(self, label=None):
        """A new API key for this project (shown once)."""
        return self._c.request("POST", "/v1/project/keys", {"label": label}, safe=False)

    def revoke_key(self, prefix):
        return self._c.request("DELETE", "/v1/project/keys/" + _id(prefix))


def _brains(brain, brains):
    if (brain is None) == (brains is None):
        raise ValueError("Kiori: send brain= (one) or brains= (a group chat)")
    return {"brain": brain} if brain is not None else {"brains": brains}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # Kiori never redirects: a redirect means base_url leads somewhere else, and following it would send the key (and
    # the brain) there. Turned down, it comes back as the HTTPError of its status.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_open = urllib.request.build_opener(_NoRedirect).open


class Kiori:
    def __init__(self, api_key, base_url="https://api.kiori.io", timeout=150, max_retries=2):
        """timeout: seconds per request before giving up (code TIMEOUT); building a full brain takes about a minute.
        max_retries: how many times a call is asked again when Kiori or the model provider is briefly unavailable
        (after Retry-After, else about 1 s, then 2 s); 0 never."""
        if not api_key:
            raise ValueError("Kiori: api_key is required")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self.project = _Project(self)

    def create(self, **body):
        """A new brain. character_card= takes a Tavern v1/v2/v3 card (dict, or a PNG in base64); or name=,
        description=, lore=. depth="full" (a whole past, about a minute, on your brain API key) or "light" (free)."""
        return self.request("POST", "/v1/brains", body)["brain"]

    def recall(self, brain=None, brains=None, messages=None, **options):
        """What each character knows right now: {"text" (one brain), "characters", "check_recommended"}."""
        return self.request("POST", "/v1/brains/recall", dict(options, messages=messages, **_brains(brain, brains)))

    def organize(self, messages, brain=None, brains=None, **options):
        """The chat moved on: {"brain" (or "brains"), "learned", "rewound", "waiting"}. Send the recent messages as
        they are now, oldest first, with your message ids if you have them, and keep what comes back.
        Options: player=, hold= (newest messages left for later, default 4), every= (learn once this many settled
        messages are new, default 12), now=True."""
        return self.request("POST", "/v1/brains/organize", dict(options, messages=messages, **_brains(brain, brains)))

    def check(self, draft, brain=None, brains=None, messages=None, **options):
        """A draft reply checked against what each character knows: {"ok", "issues", "fixed"}."""
        return self.request("POST", "/v1/brains/check", dict(options, draft=draft, messages=messages, **_brains(brain, brains)))

    def export_obsidian(self, brain):
        """A brain as an Obsidian vault: the zip's bytes."""
        return self.request("POST", "/v1/brains/export", {"brain": brain}, raw=True)

    def personality(self):
        """The 41 personality dimensions and the archetypes."""
        return self.request("GET", "/v1/personality")

    def request(self, method, path, body=None, raw=False, safe=True):
        """safe=False for a call that isn't safe to repeat (see _retry_delay)."""
        data = json.dumps(body).encode("utf-8") if body is not None else None
        attempt = 0
        while True:
            try:
                payload = self._send(method, path, data)
                break
            except KioriError as e:
                wait = _retry_delay(e, attempt, safe) if attempt < self.max_retries else None
                if wait is None:
                    raise
                time.sleep(wait)
                attempt += 1
        if raw:
            return payload
        return json.loads(payload.decode("utf-8")) if payload else None

    def _send(self, method, path, data):
        req = urllib.request.Request(self.base_url + path, data=data, method=method)
        req.add_header("Authorization", "Bearer " + self.api_key)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with _open(req, timeout=self.timeout) as res:
                return res.read()
        except urllib.error.HTTPError as e:
            if 300 <= e.code < 400:
                raise KioriError(e.code, "%s answered with a redirect, and Kiori never redirects: check base_url"
                                 % self.base_url, "REDIRECT") from None
            try:
                err = json.loads(e.read().decode("utf-8")).get("error") or {}
            except Exception:
                err = {}
            if not isinstance(err, dict):
                err = {}
            message = err.get("message") or "HTTP %d" % e.code
            raise KioriError(e.code, message, err.get("code"), _seconds_after(e.headers.get("Retry-After")),
                             err.get("request_id") or e.headers.get("X-Request-Id")) from None
        except (socket.timeout, TimeoutError):
            raise KioriError(0, "Kiori did not answer within %ss" % self.timeout, "TIMEOUT") from None
        except urllib.error.URLError as e:
            if isinstance(e.reason, (socket.timeout, TimeoutError)):
                raise KioriError(0, "Kiori did not answer within %ss" % self.timeout, "TIMEOUT") from None
            raise KioriError(0, "Can't reach Kiori at %s (%s)" % (self.base_url, e.reason), "NETWORK") from None
        except (http.client.HTTPException, OSError) as e:
            # The connection dropped after the request went out, or the answer was cut off halfway
            raise KioriError(0, "Can't reach Kiori at %s (%s)" % (self.base_url, type(e).__name__), "NETWORK") from None
