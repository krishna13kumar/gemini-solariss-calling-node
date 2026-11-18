# Gemini Solariss – Local Tamil AI project

This folder sets up, evaluates, fine-tunes and connects a Tamil-capable AI model for the Gemini Solariss solar CRM.

## Machine
- HP Victus laptop, Windows 11, AMD Ryzen 5 8645HS, 16 GB RAM
- NVIDIA GeForce RTX 3050 **6 GB** Laptop GPU (+ Radeon 760M iGPU — never use it for AI)
- Prefer the **PowerShell** tool for Windows commands (winget, setx, nvidia-smi, ollama). Use Bash only for portable scripts.

## Folder layout (create if missing)
```
gs-ai/
├── CLAUDE.md
├── .claude/agents/        # subagents (this project)
├── setup/                 # setup_report.md
├── models/                # Modelfiles, downloaded .gguf files, speed_table.md
├── eval/
│   ├── raw_exports/       # WhatsApp "Export chat" .txt files (user drops them here)
│   ├── test_set.csv       # 100 anonymised messages: id,category,message
│   ├── system_prompt.txt
│   ├── run_eval.py
│   ├── to_score.csv       # blind replies for staff
│   ├── answer_key.json    # NEVER show to scorers
│   └── results.md
├── finetune/
│   ├── train.jsonl
│   └── COLAB_STEPS.md
└── gateway/               # AI gateway service for the CRM
```

## Workflow (run agents in this order)
1. `gs-env-setup` – drivers check, Ollama install and tuning
2. `gs-model-tester` – pull models, smoke test, fix out-of-memory, speed table
3. `gs-nim-integrator` – NVIDIA NIM hosted API key check, model list, Tamil test
4. `gs-eval-runner` – build test set from WhatsApp exports, run blind evaluation
5. *(humans score `to_score.csv`)*
6. `gs-eval-analyst` – unblind scores, pick the winner
7. `gs-finetune-data` – build `train.jsonl` + Colab instructions
8. *(user runs Colab, downloads the .gguf into `models/`)*
9. `gs-model-packager` – load the fine-tuned GGUF into Ollama as `gs-tamil`, re-test
10. `gs-gateway-builder` – scaffold the CRM AI gateway with local + NIM + cloud fallback

## Rules for every agent
- **Secrets:** read API keys only from environment variables (`NVIDIA_API_KEY`, `ANTHROPIC_API_KEY`, …). Never print, log, commit or write a key into a file.
- **Privacy:** customer data must be anonymised (names → `[NAME]`, phones → `[PHONE]`, addresses → `[ADDRESS]`, consumer numbers → `[CONSUMER_NO]`, Aadhaar/PAN/bank numbers → `[ID]`) **before** it is written to `test_set.csv`/`train.jsonl` or sent to any cloud API (NVIDIA NIM, Claude, etc.). Raw exports never leave the laptop.
- **6 GB VRAM limits:** default `num_ctx` 2048–4096, `num_batch` 256. 8B models only at Q4. Never try models ≥ 12B locally.
- **Manual steps:** subagents cannot ask the user questions. When something needs a human (installing a driver from a website, toggling Omen Gaming Hub, exporting WhatsApp chats, scoring replies, running Colab), finish what you can and end your report with an `ACTION NEEDED` list of exact steps.
- **Don't over-install:** check whether a tool exists before installing it. Use `winget` for system tools and `pip install --user` for Python packages.
- **Keep reports short:** each agent writes its results to a file in the folder above and returns a summary under 20 lines.
