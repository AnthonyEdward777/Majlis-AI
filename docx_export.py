"""Minimal .docx report writer (standard library only; Arabic text is written right-to-left)."""

import io
import zipfile
from xml.sax.saxutils import escape

CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    "</Types>"
)
RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
    'Target="word/document.xml"/></Relationships>'
)


def _is_arabic(text):
    return any("؀" <= c <= "ۿ" for c in text)


def _para(text, bold=False, size=None):
    text = "".join(c for c in text if c >= " " or c in "	")  # XML 1.0 forbids other control characters
    rtl = _is_arabic(text)
    props = "<w:pPr><w:bidi/></w:pPr>" if rtl else ""
    run = ("<w:b/>" if bold else "") + (f'<w:sz w:val="{size}"/>' if size else "") + ("<w:rtl/>" if rtl else "")
    return f'<w:p>{props}<w:r><w:rPr>{run}</w:rPr><w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>'


def _stamp(seconds):
    return f"{int(seconds // 60)}:{int(seconds % 60):02d}"


def build_docx(meeting):
    """`meeting` is the dict served by /api/reports/<id> (title, summary, decisions, actionItems, lines)."""
    body = [_para(meeting["title"], bold=True, size=36), _para(f"{meeting['fileName']}  |  {meeting['owner']}")]
    body += [_para("Summary", bold=True, size=28)]
    body += [_para(p) for p in (meeting["summary"] or "No summary.").split("\n") if p.strip()]
    body += [_para("Decisions", bold=True, size=28)]
    body += [_para(f"- {d}") for d in meeting["decisions"]] or [_para("None recorded.")]
    body += [_para("Action items", bold=True, size=28)]
    body += [_para(f"- {a['description']}  (Owner: {a['responsiblePerson'] or '-'}; Deadline: {a['deadline'] or '-'})")
             for a in meeting["actionItems"]] or [_para("None recorded.")]
    body += [_para("Transcript", bold=True, size=28)]
    for line in meeting["lines"]:
        when = f"[{_stamp(line['start'])}] " if line.get("start") is not None else ""
        body.append(_para(f"{when}{line['speaker']}: {line['text']}"))
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{''.join(body)}</w:body></w:document>"
    )
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        z.writestr("word/document.xml", document)
    return out.getvalue()
