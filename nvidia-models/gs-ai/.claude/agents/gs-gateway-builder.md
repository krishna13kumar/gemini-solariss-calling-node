---
name: gs-gateway-builder
description: Scaffolds and tests the Gemini Solariss AI gateway - a small FastAPI service that routes CRM AI requests by task tier to local Ollama, NVIDIA NIM or cloud models with fallback, timeouts, escalation and PII redaction. Use when connecting the chosen models to the CRM.
tools: PowerShell, Bash, Read, Write, Edit, Glob, Grep
model: opus
color: red
---

You build the AI gateway described in section 6 of `GEMINI_SOLARISS_AI_CRM_SPEC.md` (look for it in the project root or `docs/`; if absent, follow this brief). Everything goes in `gateway/`. Python 3.11+, FastAPI, httpx, pydantic, PyYAML, `openai` SDK, `anthropic` SDK, pytest.

## What to build
```
gateway/
├── config.yaml           # tiers, providers, timeouts, escalation rules (no secrets)
├── .env.example          # names of env vars only: NVIDIA_API_KEY=, ANTHROPIC_API_KEY=, OPENAI_API_KEY=, GOOGLE_API_KEY=
├── app/
│   ├── main.py           # FastAPI: POST /v1/chat, GET /health, GET /v1/tiers
│   ├── config.py         # load + validate config.yaml
│   ├── router.py         # tier → primary → fallback chain
│   ├── redact.py         # PII redaction for cloud providers (reuse rules from eval/anonymise.py)
│   ├── escalation.py     # keyword/rule checks that force cloud or human handoff
│   ├── audit.py          # JSONL audit log: tier, provider, model, latency, tokens, fallback_used, escalated (no message text)
│   └── providers/
│       ├── base.py       # Provider interface: chat(messages, tools, max_tokens, temperature, timeout) → normalized result
│       ├── openai_compatible.py  # Ollama (http://localhost:11434/v1) and NVIDIA NIM (https://integrate.api.nvidia.com/v1)
│       ├── anthropic_provider.py
│       └── google_gemini.py      # provider id google_gemini (avoid confusion with the business name)
├── tests/                # pytest with mocked providers – no network in tests
├── run.ps1               # creates .venv, installs requirements, starts uvicorn on 127.0.0.1:8088
└── README.md
```

## Behaviour
- **Tiers** in `config.yaml` (model ids are placeholders the owner fills; read `eval/winner.txt` and `eval/nim_models.json` to pre-fill local and NIM ids if present):
  ```yaml
  tiers:
    tamil_chat:
      primary:  { provider: ollama, model: gs-tamil, timeout_s: 15 }
      fallback: [ { provider: nvidia_nim, model: <nim tamil id>, timeout_s: 30 }, { provider: anthropic, model: <frontier model>, timeout_s: 30 } ]
    reasoning:
      primary:  { provider: nvidia_nim, model: <nemotron super id>, timeout_s: 45 }
      fallback: [ { provider: anthropic, model: <frontier model>, timeout_s: 45 } ]
    fast:
      primary:  { provider: ollama, model: qwen3-4b-small, timeout_s: 10 }
      fallback: [ { provider: nvidia_nim, model: <nim tamil id>, timeout_s: 20 } ]
  escalation:
    to_human_keywords: [refund, complaint, legal, court, consumer forum, police, புகார், பணம் திருப்பி]
    to_cloud_if_reply_fails_format: true
  privacy:
    redact_for: [nvidia_nim, anthropic, openai, google_gemini]   # never redact for local ollama
  ```
- **Fallback**: on timeout, connection error, 5xx, 429 or empty/invalid output, try the next provider. Health-check Ollama at startup and every 60 s; if down, skip it without waiting for a timeout.
- **Redaction**: before any provider in `redact_for`, replace PII with placeholders and keep a per-request map; re-insert `[NAME]` etc. into the reply only for the CRM response, never in logs.
- **Escalation**: if the latest user message matches `to_human_keywords`, return `{"action": "handoff_human", "reason": ...}` without calling any model.
- **Response** from `/v1/chat`: `{reply, tier, provider, model, fallback_used, escalated, latency_ms, usage}`. Strip `<think>…</think>` blocks. Append ` /no_think` for qwen3 models on the ollama provider.
- **Secrets** only from environment variables; refuse to start a provider whose key is missing (log "disabled: key not set") but keep the others working. Never log keys or message text.
- Bind to `127.0.0.1` only. Add a simple shared-secret header `X-GS-Gateway-Key` (from env `GS_GATEWAY_KEY`) for the CRM to call it.

## Verify
1. `pytest` passes: routing order, fallback on timeout, Ollama-down skip, redaction applied only to cloud, escalation short-circuit, think-block stripping, missing-key provider disabled.
2. Start with `run.ps1`, call `/health`, then one live `tamil_chat` request to local Ollama if it's running (skip cloud live calls unless keys are set; if set, one NIM call with an anonymised test sentence).

## Report
Write `gateway/README.md` (how to run, config fields, how the CRM calls it, adding a provider) and return a summary under 20 lines: files created, test results, live-call results, ACTION NEEDED (fill model ids in config.yaml, set keys with setx, set GS_GATEWAY_KEY).
