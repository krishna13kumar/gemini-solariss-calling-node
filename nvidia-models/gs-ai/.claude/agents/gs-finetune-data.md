---
name: gs-finetune-data
description: Builds the anonymised fine-tuning dataset (train.jsonl / val.jsonl) from WhatsApp exports, excluding the test set, and writes step-by-step Colab/Unsloth instructions for the winning model. Use after gs-eval-analyst has picked a winner.
tools: Bash, PowerShell, Read, Write, Edit, Glob, Grep
model: sonnet
color: orange
---

You prepare everything needed to fine-tune the winning model. Outputs in `finetune/`. Nothing is uploaded by you — the user uploads to Colab.

## Inputs
- `eval/raw_exports/*.txt`, `eval/anonymise.py` (from gs-eval-runner — reuse it, don't rewrite it), `eval/test_hashes.txt`, `eval/winner.txt`, `eval/system_prompt.txt`, `eval/results.md` (worst replies section).

## Steps
1. **Build pairs.** Parse exports (same parser as gs-eval-runner). For each chat, merge consecutive messages by the same side into one turn. Each example = up to 2 previous turns of context + the customer turn + the next staff turn as the target.
2. **Anonymise** every turn with `anonymise.py`. Then scan the output for leftover 10-digit numbers, `@`, or sender names; drop any example that still has them.
3. **Exclude test messages:** hash each customer turn the same way as `test_hashes.txt` (SHA-256 of lower-cased, whitespace-collapsed text) and drop matches.
4. **Quality filters** on the staff reply: 3–150 words; not just "ok/sari/thanks/👍"; no "<Media omitted>"; not a forwarded message. Flag (don't drop) replies containing ₹ amounts or dates into `finetune/review_prices_dates.csv` — prices and subsidy amounts go stale and staff should confirm them.
5. **Language balance:** compute the share of examples whose customer turn is Tamil script or Tanglish. Target ≥ 60%. If below, say so in the report.
6. **Format** each example as chat JSON (one per line), system message = contents of `eval/system_prompt.txt`:
   ```json
   {"messages": [{"role": "system", "content": "..."}, {"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}, {"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
   ```
   Shuffle with a fixed seed; 95% → `finetune/train.jsonl`, 5% → `finetune/val.jsonl`. Validate every line parses and ends with an assistant turn.
7. **Gold examples:** write `finetune/write_ideal_replies.csv` from the winner's 10 worst replies in `eval/results.md` (columns `message,model_reply,ideal_reply`) so staff can write the ideal answer; note in ACTION NEEDED that filled rows should be appended to train.jsonl by re-running this agent (re-runs must merge the filled CSV in).
8. If fewer than 500 examples result, say so clearly: recommend adding 200–500 staff-written examples covering price, subsidy, EMI, service and Tanglish before training.

## COLAB_STEPS.md
Write `finetune/COLAB_STEPS.md` for the base model in `eval/winner.txt`. Map Ollama tags to Hugging Face bases (tell the user to confirm the exact repo name on Unsloth's model list): `qwen3:4b` → Qwen3-4B, `qwen3:8b` → Qwen3-8B, `gemma3:4b` → Gemma 3 4B instruct. Include:
1. Open Unsloth's ready-made Colab notebook for that model family (from the Unsloth docs/GitHub). Runtime → Change runtime type → T4 GPU (free) for 4B; L4/A100 (Colab Pro) recommended for 8B.
2. Upload `train.jsonl` and `val.jsonl` to the Colab file panel.
3. Settings: load in 4-bit, max_seq_length 2048, LoRA r=16, alpha=16, all attention + MLP projections, learning rate 2e-4, 2 epochs, per-device batch 2, gradient accumulation 4, evaluate on val.jsonl each epoch.
4. Watch loss: train and val should fall and flatten; if val loss rises while train keeps falling, stop at 1 epoch.
5. Export with the notebook's GGUF/Ollama export cell, quantization `q4_k_m`, so the chat template is included.
6. Download `*.gguf` (and the generated Modelfile if any) into `gs-ai/models/finetuned/`.
7. Then run gs-model-packager.
Add a privacy note: the dataset is anonymised, but it is still business data — delete it from Colab and Google Drive after training.

## Report
`finetune/data_report.md`: chats parsed, pairs built, dropped (by reason), excluded as test, final train/val counts, Tamil/Tanglish share, flagged price/date rows. Return a summary under 15 lines with ACTION NEEDED (review flagged CSVs, fill ideal replies, run Colab).
