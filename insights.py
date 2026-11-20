"""Local-LLM step: summary, decisions and action items from a transcript (SRS FR 14-16)."""

import json

import ollama

MODEL = "qwen2.5:7b-instruct"

# Ollama constrains the model's output to this shape, so long transcripts can't produce broken JSON.
OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "decisions": {"type": "array", "items": {"type": "string"}},
        "action_items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "description": {"type": "string"},
                    "responsible_person": {"type": "string"},
                    "deadline": {"type": "string"},
                },
                "required": ["description"],
            },
        },
    },
    "required": ["summary", "decisions", "action_items"],
}

PROMPT = """Read this meeting transcript (Arabic, English or a mix):
{transcript}

Return JSON with:
- summary: a short summary of the meeting, written in the language the transcript is mostly in (an Arabic transcript gets an Arabic summary).
- decisions: things the group agreed or settled (for example postponing a launch, choosing an option, approving a plan), one short sentence each. Empty list only if nothing was agreed.
- action_items: tasks someone took on, each with a description, the responsible_person
  (a name from the transcript, or empty if nobody was named) and the deadline (as spoken, or empty).
Keep names, product words and any quoted sentence in the language the speaker used; do not translate them.
Only include what the transcript says. Do not invent names, decisions or dates."""


def _text(value):
    return value.strip() if isinstance(value, str) else ""


def parse_insights(raw):
    """Turn the model's reply into clean lists; a broken reply degrades to a summary only."""
    try:
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError
    except ValueError:
        return {"summary": _text(raw), "decisions": [], "action_items": []}

    decisions = [_text(d) for d in data.get("decisions") or [] if _text(d)]
    items = []
    for item in data.get("action_items") or []:
        if isinstance(item, dict) and _text(item.get("description")):
            items.append({
                "description": _text(item["description"]),
                "responsible_person": _text(item.get("responsible_person")),
                "deadline": _text(item.get("deadline")),
            })
    return {"summary": _text(data.get("summary")), "decisions": decisions, "action_items": items}


def generate_insights(transcript):
    response = ollama.chat(
        model=MODEL,
        messages=[{"role": "user", "content": PROMPT.format(transcript=transcript)}],
        format=OUTPUT_SCHEMA,
        options={"num_predict": 1536},
        # Unload afterwards: the model holds ~5 GB of RAM that alignment needs next.
        # The cost is a reload on the next meeting.
        keep_alive=0,
    )
    return parse_insights(response["message"]["content"])
