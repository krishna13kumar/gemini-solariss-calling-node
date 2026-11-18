# Gemini Solariss – Local Tamil AI agents for Claude Code

Eight Claude Code subagents that carry out the Local Tamil AI runbook on your Victus laptop: set up Ollama, test models, evaluate them blind with your staff, fine-tune the winner, and connect it to the CRM through an AI gateway.

## Install
1. Unzip so you have `C:\gs-ai\` containing `CLAUDE.md`, `README.md`, `docs\` and `.claude\agents\`.
2. Open PowerShell in that folder and start Claude Code:
   ```powershell
   cd C:\gs-ai
   claude
   ```
3. Check the agents loaded: ask "which gs- agents are available?". If none show, restart Claude Code.

## Run them in order
Type each line as a message in Claude Code (or use `@` and pick the agent):

| # | Say this | What happens | Your part afterwards |
|---|---|---|---|
| 1 | `Use gs-env-setup` | Checks GPU/driver, installs and tunes Ollama, Python, Git | Do its ACTION NEEDED items (Omen Hub performance mode, Windows Graphics setting) |
| 2 | `Use gs-model-tester` | Pulls 4 models, makes low-memory variants, smoke tests, speed table | — |
| 3 | `Use gs-nim-integrator` | Checks your NVIDIA key, lists models, Tamil + tool-call test | Create the key at build.nvidia.com and `setx NVIDIA_API_KEY` if asked |
| 4 | `Use gs-eval-runner` | Anonymised 100-message test set, system prompt, blind run | First drop WhatsApp exports in `eval\raw_exports\`; fill system prompt placeholders; staff score `to_score.csv` → save as `scored.csv` |
| 5 | `Use gs-eval-analyst` | Unblinds scores, picks the winner | — |
| 6 | `Use gs-finetune-data` | Builds `train.jsonl`, `val.jsonl`, `COLAB_STEPS.md` | Review flagged CSVs, run Colab, download the `.gguf` to `models\finetuned\` |
| 7 | `Use gs-model-packager` | Loads it as `gs-tamil`, smoke tests, round-2 blind test | Staff score round 2, then `Use gs-eval-analyst on eval/round2` |
| 8 | `Use gs-gateway-builder` | Builds and tests the FastAPI AI gateway | Fill model ids in `gateway\config.yaml`, set keys |

Each agent writes a report file and ends with an **ACTION NEEDED** list for the steps only a person can do.

## Good to know
- Agents can't ask you questions mid-task; they stop and tell you what's needed. Answer, then run the agent again.
- Claude Code will ask permission before installs and commands. Read each one before approving.
- API keys stay in Windows environment variables. Agents are told never to print or save them.
- Raw WhatsApp exports never leave the laptop; only anonymised text goes to NVIDIA NIM or Colab.
- The full CRM spec is in `docs\GEMINI_SOLARISS_AI_CRM_SPEC.md`; the gateway agent reads it.
