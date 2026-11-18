# Gemini Solariss — AI Voice Agent

A Tamil-first, multilingual AI outbound calling agent for Gemini Solariss' rooftop solar leads in Tamil Nadu. Calls leads from an Excel sheet, has a natural voice conversation to collect their details, and writes structured results to a separate Excel file — all from one dashboard.

## Architecture

- **Server**: Node.js (ES modules) + Fastify + WebSockets
- **Dialogue**: Google Gemini (swappable for Ollama via `LLM_PROVIDER`)
- **Voice**: Sarvam AI — STT, TTS, voice cloning, diarized batch transcription
- **Telephony**: Exotel Voice Streaming (swappable via `TELEPHONY_PROVIDER`)
- **Leads/Results**: plain `.xlsx` files, read/written with the `xlsx` package
- **Frontend**: a single static dashboard (`public/`) using Tabulator for the Excel-like grids — no build step

```
src/
  server.js          Fastify app: REST APIs + the real-time audio WebSocket bridge
  callSession.js     Per-call conversation engine (VAD -> STT -> streaming LLM -> pipelined TTS)
  knowledgeBase.js    Kavya's persona, verified company facts, qualification script, escalation rules
  leadsStore.js       data/leads_input.xlsx (editable) + data/leads_completed.xlsx (read-only results)
  crmAuditor.js        Post-call structured extraction (Gemini) -> leads_completed.xlsx
  transcription.js     Uploaded call recording -> diarized Telecaller/Lead transcript
  providers/           Plugin registry — swap LLM/telephony/voice providers via .env
public/                 Dashboard (leads grid, custom call, local mic test, results, transcription, voice cloning)
```

### Plugin architecture

Nothing is hardcoded to one vendor. `src/providers/index.js` picks each capability from `.env`:

| Capability | Env Var | Built-in Plugins |
|---|---|---|
| Dialogue model | `LLM_PROVIDER` | `gemini` (default), `ollama` |
| Telephony carrier | `TELEPHONY_PROVIDER` | `exotel` |
| STT/TTS voice | `VOICE_PROVIDER` | `sarvam` |

## Setup

```bash
npm install
cp .env.example .env   # fill in your real keys
npm run seed-leads     # writes a placeholder data/leads_input.xlsx
npm run dev
```

Open `http://localhost:8000`.

### Local testing — no Exotel needed

`ENABLE_EXOTEL_CALLS=false` (the default) makes every outbound-call route a no-op. Instead, use the dashboard's **Local Microphone Test** panel — it runs the exact same conversation pipeline (VAD, STT, streaming LLM, pipelined TTS) through your browser mic and speakers, entirely locally.

### Going live with Exotel

1. Get a live (non-trial), DLT-registered Exotel account — trial accounts can only call your whitelisted test number, and TRAI requires DLT registration for any commercial voice call to an Indian mobile number, regardless of carrier.
2. Fill in `EXOTEL_*` and `APP_PUBLIC_DOMAIN` (a public tunnel like ngrok, or a real deployment) in `.env`.
3. In Exotel's App Bazaar, build a flow with a **Voicebot/AgentStream** applet pointed at `wss://<APP_PUBLIC_DOMAIN>/ws/audio-stream`, and set its App ID as `EXOTEL_APPLET_ID`.
4. Set `ENABLE_EXOTEL_CALLS=true`.

The App Bazaar flow's websocket URL is static and must be manually re-synced every time your tunnel URL changes (e.g. every ngrok restart) — a reserved ngrok domain or a real deployment avoids this.

## Public page and admin login

- `/` is the only public page: a title, a short description and one **Speak with agent** button that opens a voice call in the browser (microphone needed; browsers allow it only on `localhost` or an `https` link). Captions of the conversation appear while it runs, and the call is saved to the results sheet when it ends.
- `/admin` is the dashboard (leads, calls, chat, results, quick answers, settings). It shows a login form until the password typed matches `ADMIN_PASSWORD` from `.env` (checked on the server; a wrong password 5 times locks that address out for 10 minutes). Every dashboard API, the live feed and the chat socket need that login too. With `ADMIN_PASSWORD` empty the dashboard stays locked. The dashboard's files live in `admin/`, not `public/`.
- Cost guards for the public call: `MAX_CONCURRENT_CALLS` (default 10) and `MAX_CALL_MINUTES` (default 15).

## Dashboard features

- **Leads** — editable Excel-like grid (Tabulator). Upload a `.xlsx`, edit cells inline, add rows, save back to `data/leads_input.xlsx`. "Run Campaign" dials every lead (no-op unless `ENABLE_EXOTEL_CALLS=true`).
- **Call a Number** — dial any single number on demand, or use the Local Microphone Test to talk to the agent yourself.
- **Call Results** — read-only grid of `data/leads_completed.xlsx` (name, property type, roof ownership, EB bill average, address, disposition, escalated/unanswered questions, full transcript), with a one-click Excel download.
- **Transcribe a Call Recording** — upload any Telecaller↔Lead recording; Sarvam's diarized batch STT splits it into labeled turns, auto-detects or lets you pick the language, and can translate/transliterate. Download as `.txt`.
- **Voice Cloning** — upload a 10-30s reference clip of a voice you have the right to clone; Kavya switches to it immediately, no restart.

## Quick Answers (knowledge tiers)

Your Q&A set (dashboard → **⚡ Quick Answers**: editable grid, Excel/CSV import with `question`/`answer` columns, a test box for tuning) feeds Kavya in three tiers, chosen per turn for speed (`src/faqStore.js`, `src/callSession.js`):

1. **Instant** — a close match (embedding similarity ≥ the threshold, default 0.85) plays the answer's pre-generated audio: no LLM, no TTS. Measured: speaking ~0.8s after the customer finishes (incl. STT) vs ~2–3s through the LLM. Afterwards Kavya re-asks the question she had pending.
2. **Grounded** — everything else goes to the LLM with your *whole* Q&A set as approved knowledge, so it answers related or compound questions in its own words (e.g. a 5 kW question from the combined subsidy answer) and still escalates what the knowledge doesn't cover. Measured with the current model: first-token time is flat (~1.0–1.2s) from 0 to 200 entries (31k chars, ~11.7k tokens), so this adds no latency and misses nothing. The LLM request starts immediately, in parallel with the instant-tier lookup.
3. **Retrieval (true RAG)** — only if the set outgrows 30,000 characters does the LLM get just the closest 4 entries (by question embedding) instead. This must wait for the ~500ms embedding lookup, so those turns are ~0.5s slower. The dashboard shows which mode you're in.

Why not retrieve every time: on this data, embedding retrieval picked the right entry first only 4/10 times, and the score gap between "needs the knowledge base" and ordinary answers like "வீடு" was ~0.03 — too thin to decide reliably when to use it — while costing ~500ms before the LLM could even start.

Details:
- Embeddings (`gemini-embedding-001`, 768 dims, stored in `data/faq.json`) are only recomputed for rows whose question changed. Answer audio is cached in `data/faq_audio/` keyed by speaker/pace/language.
- Matching barely tells numbers apart ("3 kW" vs "2 kW"): keep similar questions in **one** row whose answer covers every case.
- **Gemini quota:** the measured key is on Google's free tier — 15 LLM requests/minute and 100 embedding requests/minute. One call at a time fits (about 6–7 turns/minute); simultaneous calls or a campaign will hit 429s and Kavya will go silent mid-call. Enable billing on the Gemini project before running calls in parallel. An instant hit also starts (then abandons) one LLM request, which counts against the cap.
- Starter entries cover only facts already verified in `src/knowledgeBase.js` — replace them with your own.

## Choosing the AI model (Gemini / NVIDIA)

Both are available at once. Everything is configurable from the dashboard's **⚙️ AI & Speech Settings** card: the active provider, the model name for each (with suggestions from each service and a **Test** button that checks a model actually answers), the fallback switch, and the speech-to-text engine (Sarvam / Cactus + its URL and model). Changes apply to the next reply and are saved in `data/settings.json`, which overrides `.env` on every start (delete that file to go back to `.env`). The header's **🧠 AI model** dropdown is a quick switch for the same setting. `LLM_PROVIDER` in `.env` is only the first-run default; the providers offered are those whose key is present (`GEMINI_API_KEY`, `NVIDIA_API_KEY`). The choice drives the replies **and** the results-sheet extraction. With `LLM_FALLBACK=true` (default), if the chosen one errors before saying anything (429/503/timeout), the other answers that turn; it never switches mid-reply. Quick-answer embeddings are separate (`EMBEDDING_PROVIDER=nvidia|gemini`) because changing them re-indexes your Q&A. Ollama is only used when it is the explicit `LLM_PROVIDER`.

## Chat & training

The dashboard's **💬 Chat with Kavya** runs the same engine as a call (`CallSession` with `textOnly`), minus STT/TTS — the quickest way to tune behaviour. On any reply, **👍 Teach** keeps it and **✏️ Fix** lets you type what she *should* have said; these go to `data/training.json` and the newest 15 are added to the system prompt as example replies (`src/trainingStore.js` → `buildSystemPrompt`), so chat and voice calls both change immediately, no restart.

Chats are recorded to the results sheet after 15s of quiet and when closed. If `leads_completed.xlsx` is open in Excel (Windows locks it), new rows are parked in `leads_completed_pending.xlsx`, shown in the dashboard anyway, and merged back automatically once Excel is closed.

## Conversation design

- **Language**: Tamil by default, but the agent matches whatever language the customer actually speaks back (English, Hindi, Tanglish) — checked every turn, no language ever announced or apologized for.
- **Qualification flow** (one question at a time, natural phrasing, never scripted verbatim): name → residential/commercial → individual/shared roof → last 3 EB bills & average → full address → site visit booking.
- **Zero-hallucination escalation**: the agent only states facts in `knowledgeBase.js` (subsidy amounts, verified office locations, contact details). Anything else — pricing, financing, warranty, brand/specs — gets restated back to the customer and escalated ("a technical agent will be connected / call you back ASAP"), and is logged to the `Unanswered_Questions` column in the results sheet instead of being silently dropped.
- **Declines gracefully**: if the customer doesn't want to answer, the agent backs off, offers a callback time, and the call is recorded with disposition `DECLINED_TO_ANSWER` rather than vanishing.

## Latency — what's real and what isn't

There is no literal zero-latency path with cloud STT/LLM/TTS — every turn pays real network time. Measured live against this build:

| Stage | Old (batch REST TTS) | Now (streaming TTS) |
|---|---|---|
| STT (Sarvam) | ~600ms | ~600ms |
| LLM time-to-first-sentence (Gemini) | ~1.1-1.4s | ~1.1-1.4s |
| TTS time-to-first-audio-chunk | ~3.3s+ | ~300-700ms |
| **Time to first audio heard** | **~5s** | **~1.6-2.2s** |

The fix: Sarvam's TTS has a separate streaming WebSocket endpoint built for voice agents (sub-second first-byte), completely different from the batch REST endpoint (`/text-to-speech`) which waits for the entire reply to synthesize before returning anything. `src/providers/voice/sarvam.js` opens one persistent streaming socket per call (`createStreamingSocket`) and reuses it across every turn; `callSession.js` streams each sentence's audio chunks to playback as they arrive rather than waiting for a full buffer. Cloned voices (`VOICE_SPEAKER=svc-...`) don't support the streaming endpoint yet, so they automatically fall back to the slower batch REST path — use a preset voice (`kavya`, etc.) if call latency matters more than a custom voice.

With TTS no longer the bottleneck, **LLM generation time is now the largest remaining cost**. `callSession.js` logs time-to-first-audio per turn so you can see exactly where time is going on your own network/account. A further upgrade path (not implemented) is Sarvam's streaming STT with partial transcripts, which would shave the ~600ms STT stage down further.

### Speech quality & speed settings (measured, not guessed)

- **STT** — `saaras:v4` with `mode=codemix` plus a `keyterms` list (`STT_KEYTERMS` in `sarvam.js`). On a Tamil test set this turned "Gemming Solaris" / "பிஎம் சூர்யா" into the exact "Gemini Solariss" / "PM Surya Ghar", at ~220ms. Tried and rejected (no gain): 16kHz upsampling, gain normalization, `language=unknown`, saaras:v3, verbatim mode.
- **Speculative STT** — once the customer has been quiet for 2 frames (~256ms) the audio is transcribed immediately, in parallel with the rest of the end-of-turn wait. If they're done, the transcript is already there (STT time ≈ 0ms in the dashboard trace); if they resume, the result is dropped.
- **TTS** — local playback now runs at 24kHz (`?rate=24000`, separate playback `AudioContext`); phone calls stay 8kHz. Sarvam's first-audio time is identical (~290ms) at 8k/16k/24k, so this is free quality. Downsampling now averages instead of interpolating (no aliasing "tinny" artefacts).
- **Instant fixed lines** — the greeting and the two retry lines are pre-generated at startup and played from cache (first audio ~10-40ms instead of 0.3-0.7s+). The streaming TTS socket is opened at connect, not at the first reply.
- **No pacing on the browser path** — sentences are sent as soon as they're synthesized and the page schedules them on its own clock, so multi-sentence replies are gapless and the next sentence's synthesis overlaps the previous one's playback (a 2-sentence reply went from ~7.5s to ~2.2s end to end). Echo gating still knows when playback really ends.
- What's left is the LLM: ~1.1-1.5s to first token on `gemini-3.5-flash-lite` (thinking-budget settings made no difference). Tuning knobs: `VAD_SILENCE_FRAMES` (end-of-turn wait; lower = faster but risks cutting people off), `VOICE_PACE`, `VOICE_TEMPERATURE`.

### Listening behaviour (local mic)

- The mic is ignored only while Kavya's audio is really playing. The page reports the instant its playback queue drains (`playback_idle`), so a quick answer such as "ஆமா" right after the question is no longer swallowed by a guessed safety margin; frames in the last ~150ms are kept as pre-roll rather than dropped.
- If what was "heard" is just Kavya's own sentence coming back through the speakers, it is ignored (trace shows **ECHO**) instead of being answered, which is what made her repeat the same question. Headphones remove it entirely.
- **Wait after you stop talking** (dashboard settings, or `VAD_SILENCE_FRAMES`): ≈0.4s / 0.5s / 0.65s (default) / 0.9s. Lower is faster (about 0.4s quicker per step pair) but can cut off pauses; raise it for slow speakers or when reading out numbers.
- The Q&A embedding lookup no longer holds a reply the LLM can already start.
- Each captured turn is saved as a WAV in `data/debug_turns/` (last 20, local mic only; `DEBUG_SAVE_TURNS=false` to disable) so a misheard answer can be inspected.

### Self-hosted STT (Cactus + Whisper)

`STT_PROVIDER=cactus` swaps only the hearing step to a Whisper model served by [Cactus](https://github.com/cactus-compute/cactus) (`cactus serve`); Sarvam still does TTS, and any Cactus failure/timeout falls back to Sarvam STT for that utterance. The flow is unchanged: STT → quick-answer lookup + LLM with the Q&A knowledge → Sarvam TTS → browser (local) or Exotel (calls). Setup is in `.env.example`; `npm run compare-stt -- clip.wav` prints Sarvam's and Cactus's transcript and latency side by side for your own recordings.

## Compliance

TRAI restricts outbound telemarketing calls to 09:00–20:30 IST (`NODE_ENV=production` enforces this; development bypasses it for testing), and promotional calls to Indian mobile numbers require DLT registration regardless of telephony vendor.
