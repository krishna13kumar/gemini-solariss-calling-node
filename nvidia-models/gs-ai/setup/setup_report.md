# Setup Report

| Check | Result | OK? |
|---|---|---|
| GPU / driver | RTX 3050 (6144 MiB), driver 592.82, CUDA 13.1 | OK |
| VRAM in use | 416 MiB; procs: explorer.exe, OpenCommandCenterBackground.exe (per-process usage N/A under WDDM; none flagged >300 MB) | OK |
| Power | On AC (BatteryStatus=2) | OK |
| Ollama | 0.40.2 at %LOCALAPPDATA%\Programs\Ollama\ollama.exe; running; 7 models listed | OK |
| Ollama env (user) | FLASH_ATTENTION=1, KV_CACHE_TYPE=q8_0, CONTEXT_LENGTH=4096, KEEP_ALIVE=30m, NUM_PARALLEL=1, MAX_LOADED_MODELS=1 (verified) | OK |
| Python | 3.14.5 | OK |
| Git | 2.51.0 | OK |
| pip pkgs | requests, pandas, openai installed (--user) | OK |
| Disk C: | 170 GB free | OK |
| Folders | setup, models, eval/raw_exports, finetune, gateway | OK |

## ACTION NEEDED
- Omen Gaming Hub -> Performance Control -> Performance; if a Graphics Switcher/MUX option exists, set Discrete and restart.
- Windows Settings -> System -> Display -> Graphics -> Add app -> ollama.exe (C:\Users\krish\AppData\Local\Programs\Ollama\ollama.exe) -> Options -> High performance.
