# Majlis-AI — Shared Task Board

**Single source of truth for who is doing what.** All four of us read and update this file.
Style borrowed from RigRoute: one line per task, edit only your own line, done means ticked on `main`.

## How to use

- Each task is **one line**: `- [ ] M-XX · owner · old commit · what · type`
- Take a task by number or by owner: **M-07**, or "Zein's next task". Do the task named, whoever you are.
- **Phase 1 (M-01 … M-21):** replay of the old repo's 21 commits, **in this exact order**, one new commit per old commit, each by the person who authored the old one.
- **Finish** a task in the same commit as its work: change `[ ]` to `[x]` and append ` · done: YYYY-MM-DD by <Name>`.
- **Type CODE** = recreate the file changes of that old commit exactly (`git show <hash>` in the old repo). **Type NO-OP** = the old commit made no net change to the files (merge, duplicate, empty). The owner makes an **empty commit** (`git commit --allow-empty`) so the sequence still matches the old 21.
- Commit message format: `<old subject> [PoC@<hash>]`,. The `[PoC@<hash>]` marker is how everyone can see a task is on `main`: `git log --grep "PoC@<hash>"`.
- Copy the old commit **faithfully, even the messy parts** (the `.bak` files, the stray file, the hard-coded path). Fixing them is Phase 2, not now. Never copy any secret or token (none were found in the old repo).
- Old repo (READ-ONLY, public): https://github.com/AnthonyEdward777/AI-meeting-intelligence-PoC

---

## Phase 1 — replay of the old 21 commits (strict order)

- [x] M-01 · Anthony · b5fb741 · "Initial commit": adds `.gitattributes` (2 lines). **Also in this commit:** add `docs/TASKS.md` · CODE · done: 2026-11-17 by Anthony (pushed as 5cc48be "Initial commit M-01", without the PoC marker)
- [x] M-02 · Anthony · 35cdf83 · "baseline components": `app.py` (Flask `/analyze`, whisperx + ollama), `templates/index.html`, `templates/script.js`; deletes `.gitattributes` · CODE · done: 2026-11-17 by Anthony (hard-coded Hugging Face token in app.py replaced by `os.environ.get("HF_TOKEN")`)
- [x] M-03 · Zein · b0a3381 · "Initial commit of my independent version": rewrites `app.py` (Cohere Arabic ASR, ollama summary; contains a hard-coded `C:\Users\Zein\...` model path), adds `requirements.txt`, `.gitignore`, `tests/test_app.py` · CODE · done: 2026-11-18 by Zein
- [x] M-04 · Malek · 147890f · "Exclude downloaded model weights": `alignment.py` (new), `app.py` (+318: pyannote diarization, alignment, bilingual transcript), `templates/script.js`, `templates/index.html` (-1), `.gitignore`, plus `app.py.before_alignment.bak` and `templates/script.js.before_alignment.bak` · CODE · done: 2026-11-18 by Malek
- [x] M-05 · Zein · 627c0e5 · "Fix diarization, number alignment, and summary crash": `alignment.py`, `app.py`, `requirements.txt`, `templates/index.html`, `templates/script.js`, `tests/test_app.py` (same diff as 6643946). Do not copy the old trailer line · CODE · done: 2026-11-18 by Zein
- [x] M-06 · Vincent · 77aac93 · "complete frontend UI overhaul, add loading states, logo cleanup, and smart transcript search": `app.py` (10 lines), `static/majlis.logo.jpeg` (binary), `templates/index.html`, `templates/script.js` · CODE · done: 2026-11-19 by Vincent
- [ ] M-07 · Vincent · 2f88fe6 · "Update index.html": one line in `templates/index.html` · CODE
- [ ] M-08 · Anthony · 0bb76ca · "git fix": adds the stray file named `e -i 6643946^` (13 lines) · CODE
- [ ] M-09 · Anthony · 85b4d82 · "Update e -i 6643946^": +3 lines in the same stray file · CODE
- [ ] M-10 · Anthony · 9faf522 · "fix git 2": same stray file, +1/-4 · CODE
- [ ] M-11 · Zein · 6643946 · "Fix diarization, number alignment, and summary crash" (duplicate of M-05, already applied) · NO-OP
- [ ] M-12 · Vincent · b9d40c3 · "Merge pull request #1 from AnthonyEdward777/fix-diarization-and-summary" (merge) · NO-OP
- [ ] M-13 · Vincent · 2721f6d · "complete frontend UI overhaul…" (duplicate of M-06) · NO-OP
- [ ] M-14 · Vincent · f38ca13 · "Merge branch 'fix-diarization-and-summary' into main" (merge) · NO-OP
- [ ] M-15 · Vincent · 45f7a53 · "Update index.html" (duplicate of M-07) · NO-OP
- [ ] M-16 · Anthony · 9fc0544 · "git fix" (duplicate of M-08) · NO-OP
- [ ] M-17 · Anthony · 7a4d3ab · "Update e -i 6643946^" (duplicate of M-09) · NO-OP
- [ ] M-18 · Anthony · b006b2a · "fix git 2" (duplicate of M-10) · NO-OP
- [ ] M-19 · Anthony · 519d10b · "Merge branch 'main' of …AI-meeting-intelligence-PoC" (merge) · NO-OP
- [ ] M-20 · Anthony · dccbb26 · "Delete e -i 6643946^": deletes the stray file · CODE
- [ ] M-21 · Anthony · 8b876b7 · "Force GitHub to refresh contributors" (empty commit) · NO-OP

Check after M-21: the file tree must equal the old `main` tree exactly (`git diff` against a checkout of old `main` is empty).
Authors and dates will show the day each person really did it. The `[PoC@hash]` marker links back to the old commit. That is the honest record.

---

## Phase 2 — after M-21: tasks come only from the team

Only the team adds tasks here. Add lines in this format, with the next free ID:

`- [ ] T-001 · title · status: todo · owner: — · branch: — · deps: —`

- Statuses: `todo` → `in-progress` → `review` → `done` (or `blocked: <reason>`). Only take tasks whose `deps` are done and that nobody else owns.
- **Claim before coding:** set your line to `in-progress`, your name and branch `yourname/T-XXX-short-name`, then `git pull --rebase origin main` and `git push origin main` **before** you start. A claim only counts once pushed.
- Work on your branch. To finish: `git switch main`, `git pull --rebase origin main`, merge your branch with `--no-ff`, run `pytest tests/`, tick the box (`[x]`, date, name), push. Never leave `main` red.
- Found extra work? Add a new line with the next free ID, status `todo`, no owner. Don't silently do it.
