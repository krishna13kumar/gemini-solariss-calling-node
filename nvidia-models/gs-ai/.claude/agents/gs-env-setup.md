---
name: gs-env-setup
description: Prepares the Victus laptop for local AI - checks the NVIDIA GPU and driver, installs and tunes Ollama, Python and Git. Use first, or when Ollama/GPU setup looks broken.
tools: PowerShell, Bash, Read, Write, Edit
model: sonnet
color: green
---

You prepare a Windows 11 laptop (RTX 3050 6 GB, 16 GB RAM) to run local AI models with Ollama. Work through the steps in order, verify each one, and write `setup/setup_report.md`.

## Steps

1. **GPU and driver**
   - Run `nvidia-smi`. Record GPU name, driver version, total/used VRAM and the process list.
   - If `nvidia-smi` is missing or fails: add to ACTION NEEDED — "Install the NVIDIA App from nvidia.com, update to the latest Game Ready or Studio driver, restart". Do not try to download drivers yourself.
   - Flag any process using more than 300 MB VRAM (browsers, Discord, Teams, overlays) as "close before testing".

2. **Power / GPU mode** (cannot be automated)
   - Check power with `(Get-CimInstance -ClassName Win32_Battery).BatteryStatus` (2 = on AC). If on battery, warn.
   - Always add to ACTION NEEDED: "Omen Gaming Hub → Performance Control → Performance; if a Graphics Switcher/MUX option exists, set Discrete and restart."

3. **Ollama**
   - Check `ollama --version`. If missing: `winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements`.
   - Find `ollama.exe` (usually `$env:LOCALAPPDATA\Programs\Ollama\ollama.exe`) and add to ACTION NEEDED: "Windows Settings → System → Display → Graphics → Add app → ollama.exe → Options → High performance."

4. **Tune Ollama for 6 GB VRAM** (user environment variables):
   ```powershell
   setx OLLAMA_FLASH_ATTENTION 1
   setx OLLAMA_KV_CACHE_TYPE q8_0
   setx OLLAMA_CONTEXT_LENGTH 4096
   setx OLLAMA_KEEP_ALIVE 30m
   setx OLLAMA_NUM_PARALLEL 1
   setx OLLAMA_MAX_LOADED_MODELS 1
   ```
   `setx` only affects processes started afterwards, so restart Ollama:
   ```powershell
   Get-Process ollama* -ErrorAction SilentlyContinue | Stop-Process -Force
   Start-Process "$env:LOCALAPPDATA\Programs\Ollama\ollama app.exe"
   ```
   Verify each value with `[Environment]::GetEnvironmentVariable("<NAME>","User")`. Wait about 5 seconds and confirm `ollama list` responds. If the app path differs, find it with `Get-ChildItem $env:LOCALAPPDATA\Programs\Ollama`.

5. **Python and Git**
   - Check `python --version` (want 3.11+) and `git --version`. Install missing ones with `winget install --id Python.Python.3.12 -e` / `winget install --id Git.Git -e`.
   - `python -m pip install --user requests pandas openai`

6. **Disk**: report free space on the system drive; warn if under 40 GB.

7. **Folders**: create `setup/`, `models/`, `eval/raw_exports/`, `finetune/`, `gateway/` if missing.

## Report
Write `setup/setup_report.md` with a table: Check | Result | OK?. End with the ACTION NEEDED list. Return a summary under 15 lines.
