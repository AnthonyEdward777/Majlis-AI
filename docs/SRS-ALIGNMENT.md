# Alignment with the SRS presentation

How the project maps to `SRS_Presentation.pptx` (Majlis AI, supervisor Dr. Hazem Abdelazim).

## Roles and permissions (slides 11, 14, 15, 16)
| SRS | Implementation |
|---|---|
| Admin (role 1): create Normal User and Executive accounts, manage accounts and roles, create teams, assign users to Executives | Admin page: create account, role switch, team picker per user, Teams list |
| Executive (role 2): upload and process, personal history, view team members' history | History & Team page (filter: mine / team) |
| Normal User (role 3): upload and process, personal history | Dashboard, New Analysis, History |
| Admins do not upload or read meetings | `/analyze` and `/api/reports*` return 403 for Admins; the Admin sidebar has no meeting pages |
| Team = Executive plus the Normal Users whose `executive_id` points at them | Validated server-side: only an active Executive can lead, only a Normal User can join |
| An Executive can view, not change, a team member's meeting | Edit, rename, regenerate and delete are owner-only |

## Functional requirements
| FR | Status |
|---|---|
| 1-4 Accounts and roles, login/out, role-based dashboards | Done (first-run setup creates the first Admin) |
| 5-6 Team management | Done |
| 7-10 Upload, validate, preprocess | Done: unreadable or empty files are rejected with a 400; audio is converted to mono 16 kHz before the models |
| 11-13 Transcription with speakers and timestamps | Done (Cohere ASR, EAGLE-Diar speaker diarization with enrolled voice samples, word alignment). See the language note below |
| 14-16 Summary, decisions, action items | Done: local Qwen via Ollama, schema-constrained JSON; shown on the report page |
| 17-19 Separate histories, Executive sees team | Done |
| 20 Download reports | PDF (browser print), DOCX, JSON |
| 21-22 Edit transcript text and speaker names | Done (owner only) |
| 23 Delete meetings | Done (single and clear-all) |
| 24 Search and filter history | Done (text, date range, mine/team) |
| Regenerate (activity diagram) | Done: re-runs the LLM on the corrected transcript |

## Non-functional requirements
| NFR | Status |
|---|---|
| 1 No external AI API | Yes: all models run locally |
| 2 Hashed passwords | Yes (werkzeug) |
| 3-4 Authorization, confidentiality | Server-side checks on every route; tests cover each role pair |
| 5 Secure sessions | Signed cookies, SameSite=Lax, Origin check; set `SESSION_COOKIE_SECURE=True` behind HTTPS |
| 6-7 Performance, adapts to hardware | Uses CUDA when PyTorch can see a GPU, otherwise CPU; long audio is processed in windows |

## Data model (slide 16)
`roles`, `users` (with `email`, `role_id`, `executive_id`), `meetings` (`title`, `upload_date`, `audio_file`, `summary`), `speakers`,
`transcripts`, `decisions`, `action_items`: see `docs/DATABASE.md`.

## Benchmark (slide 10)
The project uses **EAGLE-Diar** (the best entry in the benchmark). Pyannote was removed; speakers are enrolled with a short voice sample each.
Nemotron, WhisperX, Sortformer and pyannote are benchmark entries only and are not part of the application.

## Known gaps against the slides
- **Arabic + English in one meeting.** The transcription model is an Arabic-specific Cohere checkpoint run with `language="ar"`. English words inside Arabic speech are model-dependent; a fully English meeting is not supported until the model choice changes. `TRANSCRIPTION_LANGUAGE` (env var, default `ar`) is the only switch; it is untested on English audio.
- **Separate voice-activity detection.** There is no standalone VAD step; EAGLE-Diar already separates speech from silence.
- **Offline front end.** Fixed: icons, animation and fonts are served from `static/vendor/` (a test fails if the page links to any external URL).
