# NIM report

Key present (starts nvapi-, length 70). 80 models listed in eval/nim_all_models.txt. No qwen3.5-*, no Sarvam on the hosted list; closest larger models tried instead.

| Model id | Role | Works? | Latency s | Tamil % | Tool call OK | Sample |
|---|---|---|---|---|---|---|
| qwen3.5-122b-a10b / sarvam / qwen3.5-397b-a17b | Tamil chat | not listed | - | - | - | - |
| nvidia/nemotron-3-ultra-550b-a55b | Tamil chat | yes | 17.4 | 58 | not tested | 3 kW வைதியம்:~₹1.8-2.2 லட்சம். மத்திய உதவி: ₹78,000 (PM Surya Ghar). மாநில உதவி (TN)... (some figures look invented; verify) |
| nvidia/nemotron-3-super-120b-a12b | Orchestration | yes | 2.5 | 0 at 300 tok (reasoning eats budget); Tamil OK when thinking off | yes, only with chat_template_kwargs enable_thinking=false: book_site_survey(customer_name=[NAME], date="tomorrow") | (empty at max_tokens 300) |
| z-ai/glm-5.3 | Tamil chat | responds but empty | 81.3 | 0 | - | reasoning model, empty content at 300 tok; too slow |
| mistralai/mistral-large-2-instruct | Tamil chat | no (404 not provisioned) | - | - | - | - |
| moonshotai/kimi-k2.6 | Tamil chat | no (404 not provisioned) | - | - | - | - |
| google/gemma-4-31b-it | Tamil chat | no (timeout 90 s) | - | - | - | - |
| deepseek-ai/deepseek-v4.1-flash | Tamil chat | no (timeout 90 s) | - | - | - | - |

Notes: super's tool call needed extra_body={'chat_template_kwargs':{'enable_thinking':False}}; the model also returns a date of 'tomorrow' rather than a resolved date, so the app must resolve it.

Free tier is for development; production needs a paid NVIDIA endpoint or self-hosted NIM, and NVIDIA's API terms should be reviewed before sending real customer data.