# LongMemEval-S: no plugin / memory / memory + Dream

Each line answers the same questions on the same history with the same model, each in its own fresh headless DSH session:

| Line | Memory |
|---|---|
| A no plugin | The plugin is disabled. |
| B memory | The plugin's auto-extract runs over the verbatim history, oldest session first, one window at a time. The notes are frozen as `checkpoint-before-dream`. |
| C memory + Dream | Starts from that same checkpoint. Dream then runs over the same history until every session has been offered, using the normal evidence check and switch. Changes the check blocks are deferred, not confirmed. The result is frozen as `checkpoint-after-dream`. |

Reference answers, evidence session ids and `has_answer` flags never reach the plugin. Sessions carry only role, text and the dataset's times.

The build tracks distinct fully reviewed source sessions separately from settlement. On this fixed history, the Dream phase stops once every session has been reviewed, including sessions whose drafts were deferred. `build.json` records `uniqueReviewed` and `sourceSessions` so an early stop is visible. Older runs used the settlement backlog as their stopping condition and could repeatedly review deferred sessions.

## Run

Prerequisites:

- `DEEPSEEK_API_KEY` is set.
- `longmemeval_s_cleaned.json` from `huggingface.co/datasets/xiaowu0162/longmemeval-cleaned`, sha256 `d6f21ea9…c3a442`. Point `LME_DATA` at it.
- A headless profile `cc-memory-lme` with the bundles `dsh-base`, `dsh-headless` and `dsh-cc-dream-memory`, linked to this checkout.

```bash
node eval/longmemeval/run-lme.mjs build --concurrency 5
node eval/longmemeval/run-lme.mjs answer --concurrency 3
node eval/longmemeval/run-lme.mjs grade
node eval/longmemeval/run-lme.mjs report
```

Output goes to `LME_RUN` (default `%LOCALAPPDATA%/Temp/lme-runs/run-1`):

- `report.md`
- `hypotheses-{A,B,C}.jsonl`, in the official `{question_id, hypothesis}` format
- per question: `build.json`, `answers.json`, `grades.json` and both checkpoints

Phases resume; `--force` redoes them. `LME_SMOKE_SESSIONS=N` keeps only the latest N sessions and is for wiring checks only.

## Sample

The run uses a fixed diagnostic sample of 30 questions, 10 per group:

- knowledge-update
- multi-session
- abstention: any type whose id ends in `_abs`

Within each group the questions are the first ten by `sha256("longmemeval-s-cleaned:cc-memory-0.25.0:" + question_id)`. The report names every question. A public comparison needs the full 500.

## Deviations from the official setup

- **Judge.** The judge is DeepSeek (`deepseek-flash`) with the official `get_anscheck_prompt` templates, copied verbatim from `src/evaluation/evaluate_qa.py`. The official judge is GPT-4o.
- **Dream child.** Dream's child is the same model driving the plugin's own scoped worker tools and `structured_output`, through the Messages API. In DSH it would be a `standard`-preset host subagent, which adds that preset's persona prompt. The brief, tools, replay, evidence check and switch are the plugin's code.
- **Answering.** Answers come from real headless DSH with `deepseek-flash`. Shell, file, web and subagent tools are off in every line; `todo_write` stays on, because with no tools at all the model writes tool calls as text instead of answering. Every prompt is `Current date: <question_date>`, then the question, then `Answer directly.`
- **Note types.** `userMemory: project` keeps every note in the project layer, so Dream can consolidate the user facts that LongMemEval is mostly about.
