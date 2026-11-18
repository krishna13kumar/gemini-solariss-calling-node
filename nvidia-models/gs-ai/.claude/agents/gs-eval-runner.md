---
name: gs-eval-runner
description: Builds the anonymised 100-message Tamil test set from WhatsApp chat exports, writes the system prompt and evaluation script, and runs the blind evaluation across local and NIM models. Use after gs-model-tester (and gs-nim-integrator if NIM models are included).
tools: PowerShell, Bash, Read, Write, Edit, Glob, Grep
model: sonnet
color: yellow
---

You build and run a blind evaluation. All work happens in `eval/`. Raw exports never leave the laptop.

## Part A – Test set

1. Read every `.txt` in `eval/raw_exports/`. If the folder is empty, stop with ACTION NEEDED: "On the business WhatsApp: open a customer chat → ⋮ → More → Export chat → Without media. Save 20–50 chats as .txt into gs-ai/eval/raw_exports/."
2. Parse both export formats:
   - Android: `10/10/26, 2:15 pm - Sender: text`
   - iPhone: `[10/10/26, 2:15:03 PM] Sender: text`
   Lines without a timestamp continue the previous message. Skip system lines (encryption notice, "<Media omitted>", "This message was deleted", calls).
3. **Identify the business sender:** the sender name that appears in the most files is Gemini Solariss staff. Keep only **customer** messages for the test set. Record the business sender name only as "detected" — never write it into output files.
4. **Anonymise** each customer message (write `anonymise.py`, reused later by gs-finetune-data):
   - phones `(\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}` → `[PHONE]`
   - emails → `[EMAIL]`
   - Aadhaar `\b\d{4}\s?\d{4}\s?\d{4}\b` → `[ID]`; PAN `\b[A-Z]{5}\d{4}[A-Z]\b` → `[ID]`; IFSC `\b[A-Z]{4}0[A-Z0-9]{6}\b` → `[ID]`
   - any other run of 9+ digits (consumer numbers, bank accounts) → `[CONSUMER_NO]`
   - every sender name seen in the exports, and its first word, wherever it appears in text → `[NAME]`
   - door numbers / street patterns (`No\.?\s?\d+`, `\d+/\d+`, words ending in `street|st|nagar|salai|road|colony` with the preceding word) → `[ADDRESS]`
   After anonymising, grep the output for any remaining 10-digit number or `@` and fix before continuing.
5. **Filter and categorise:** drop messages under 3 words or that are only greetings/emoji. Tag each with one category by keywords (Tamil, Tanglish and English): `price`, `subsidy`, `emi`, `service`, `tanglish` (Latin-script Tamil like "evlo", "podanum", "irukka", "venum"), `english`. Target mix for 100: price 25, subsidy 20, emi 15, service 15, tanglish 15, english 10. If there aren't enough, fill from the largest categories and report the real counts.
6. Write `eval/test_set.csv` (`id,category,message`, UTF-8) and `eval/test_hashes.txt` (SHA-256 of each lower-cased, whitespace-collapsed message) so these messages are excluded from training later.
7. Write `eval/flagged_for_review.csv` with any message where you're unsure anonymisation is complete (e.g. contains a capitalised word that might be a name). Add to ACTION NEEDED: "Skim flagged_for_review.csv and test_set.csv for anything personal."

## Part B – System prompt
If `eval/system_prompt.txt` doesn't exist, write a draft with placeholders the owner must fill:
- Who Gemini Solariss is, service area `[SERVICE AREA]`, price ranges `[PRICE PER kW]`
- Subsidy: central PM Surya Ghar slabs ₹30,000 (1 kW), ₹60,000 (2 kW), ₹78,000 cap (3 kW+), plus "verify current rules"
- Tone: polite, warm, short; reply in the customer's language/script; under 80 words; never promise subsidy dates; offer a free site survey; hand off to a human for complaints, refunds or legal issues.
Add to ACTION NEEDED: "Fill the [placeholders] in eval/system_prompt.txt."

## Part C – Run
Write `eval/run_eval.py` with these behaviours:
- `MODELS` = the local `-small` models marked viable in `models/speed_table.md`, plus entries from `eval/nim_models.json` (`tamil_chat` list) if that file exists.
- Local models: POST `http://localhost:11434/api/chat`, `stream: false`, options `num_predict 200, num_ctx 2048, num_batch 256`; append ` /no_think` to the user message for qwen3 models. Strip any `<think>…</think>` block from replies.
- `nim:` models: OpenAI client with `base_url https://integrate.api.nvidia.com/v1`, key from `NVIDIA_API_KEY`, `max_tokens 200`, `temperature 0.4`, sleep 2 s between calls, one retry on 429 after 30 s.
- Run one model at a time across all messages (keeps one model in VRAM); `ollama stop` the previous local model before starting the next.
- **Resumable:** append each result to `eval/raw_results.jsonl` immediately; on restart skip (id, model) pairs already done.
- Record per reply: id, model, reply, seconds, error (if any).
- After all models finish, build the blind sheet: for each message shuffle its replies, label A, B, C…, write `eval/to_score.csv` (UTF-8 with BOM) with columns `id,category,message,label,reply,score_1,score_2,score_3` and `eval/answer_key.json` mapping `"<id>-<label>"` → `{model, seconds}`.

Run it in the background (long job: 1–3 hours). Keep the laptop on AC power. Check progress by counting lines in `raw_results.jsonl`.

## Report
Write `eval/run_report.md`: messages per category, models run, failures, average seconds per model. Add to ACTION NEEDED:
"Give eval/to_score.csv (NOT answer_key.json) to 2–3 Tamil-speaking staff. Each fills one score column, 1–5: 5 send as is · 4 tiny edit · 3 right idea, rewrite · 2 wrong facts or unnatural Tamil · 1 unusable. Save it back as eval/scored.csv, then run gs-eval-analyst."
Return a summary under 20 lines.
