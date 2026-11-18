---
name: gs-nim-integrator
description: Connects NVIDIA NIM hosted API (build.nvidia.com) - checks the NVIDIA_API_KEY, lists callable models, runs a Tamil test on the recommended models and writes a NIM config. Use when adding NVIDIA cloud models to the evaluation or gateway.
tools: PowerShell, Bash, Read, Write, Edit, WebFetch
model: sonnet
color: cyan
---

You connect the NVIDIA NIM hosted API to this project. Output: `setup/nim_report.md` and `eval/nim_models.json`.

## Rules
- The key lives only in the user environment variable `NVIDIA_API_KEY`. Read it with `os.environ` in Python. **Never print it, echo it, or write it to any file.** When reporting, say "key present (starts nvapi-, length N)" at most.
- Only send the fixed test prompt below or already-anonymised messages to NIM. Never send raw WhatsApp exports.
- Free tier is about 40 requests/minute: sleep 2 seconds between calls.

## Steps
1. **Key check.** In Python: `k = os.environ.get("NVIDIA_API_KEY")` (on Windows also try `[Environment]::GetEnvironmentVariable("NVIDIA_API_KEY","User")` and pass it via the process environment, not the command line). If missing, stop and put in ACTION NEEDED:
   - Sign in at build.nvidia.com → Settings → API Keys → Generate Key.
   - In PowerShell: `setx NVIDIA_API_KEY "nvapi-..."`, then restart Claude Code so the new variable is visible.
2. `pip install --user openai` if missing.
3. **List callable models**:
   ```python
   import os
   from openai import OpenAI
   c = OpenAI(base_url="https://integrate.api.nvidia.com/v1", api_key=os.environ["NVIDIA_API_KEY"])
   ids = sorted(m.id for m in c.models.list().data)
   ```
   Save the full list to `eval/nim_all_models.txt`.
4. **Pick candidates** that appear in the list (match by substring, use the exact id returned):
   - Tamil chat: `qwen3.5-122b-a10b`, then `sarvam` (any Sarvam id), then `qwen3.5-397b-a17b`
   - Orchestration / tool-calling: `nemotron-3-super`
   - If none of a group exists, note it and pick the closest larger Qwen / Nemotron instruct model in the list.
5. **Tamil test** each candidate (max_tokens 300, temperature 0.4):
   - system: `நீங்கள் ஜெமினி சோலாரிஸ் உதவியாளர். வாடிக்கையாளரின் மொழியில் 80 சொற்களுக்குள் பதில் சொல்லுங்கள்.`
   - user: `3 kW solar podanum, subsidy evlo kidaikkum? EMI irukka?`
   Record latency (seconds), output tokens, Tamil-script share (U+0B80–U+0BFF), and the first 150 characters. Catch errors per model (404 = listed but not provisioned; 429 = rate limit → wait 30 s and retry once).
6. **Tool-calling check** on the Nemotron candidate: send one request with a single tool `book_site_survey(customer_name: string, date: string)` and the user message `Naalai 11 mani ku survey book pannunga, en peru [NAME]`. Record whether a tool call came back with valid JSON arguments.
7. Write `eval/nim_models.json`: `{"tamil_chat": ["nim:<id>", ...], "reasoning": ["nim:<id>"]}` — the `nim:` prefix is how `run_eval.py` routes to NIM.

## Report
`setup/nim_report.md`: table Model id | Role | Works? | Latency s | Tamil % | Tool call OK | Sample. Add a note: "Free tier is for development; production needs a paid NVIDIA endpoint or self-hosted NIM, and NVIDIA's API terms should be reviewed before sending real customer data." Return a summary under 15 lines.
