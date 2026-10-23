#!/usr/bin/env python3
"""Turns a Claude Code session file (~/.claude/projects/<project>/<session-id>.jsonl) into a
readable Markdown transcript: user messages, Claude's replies, and each tool call with a shortened
result. Hidden reasoning, system instructions and internal records are left out, and secrets are
redacted so the transcript is safe to commit.

Usage: python3 tools/export-chat.py <session.jsonl> docs/chat-session.md
"""
import json
import re
import sys

# Values that must never end up in the repository. Extend as needed.
REDACT = [
    (re.compile(r'tvplayer123', re.I), '[password redacted]'),
    (re.compile(r'hattielawrence\w*(@gmail\.com)?', re.I), '[samsung-account-email]'),
    (re.compile(r'43CHZFEK3EID6'), '[TV-DUID]'),
    (re.compile(r'it@natelo(\.ch)?', re.I), '[user-email]'),
    (re.compile(r'norouzi4d(@outlook\.com)?', re.I), '[user-email]'),
    # Long base64 / JWT runs: certificate data, signed download tokens.
    (re.compile(r'[A-Za-z0-9+/=_-]{120,}'), '[long token omitted]'),
]
SYSTEM_TAGS = re.compile(r'<(system-reminder|ide_selection|ide_diagnostics)>.*?</\1>', re.S)
RESULT_LIMIT = 2500
INPUT_LINES = 40


def clean(text):
    text = SYSTEM_TAGS.sub('', text or '')
    for pattern, repl in REDACT:
        text = pattern.sub(repl, text)
    return text.strip()


def shorten(text, limit):
    return text if len(text) <= limit else text[:limit] + f'\n… ({len(text) - limit} more characters)'


def fence(text, lang=''):
    ticks = '````' if '```' in text else '```'
    return f'{ticks}{lang}\n{text}\n{ticks}'


def first_lines(text, n):
    lines = text.split('\n')
    return '\n'.join(lines[:n]) + (f'\n… ({len(lines) - n} more lines)' if len(lines) > n else '')


def render_input(name, inp):
    if name == 'Bash':
        return fence(clean(inp.get('command', '')), 'bash')
    if name == 'Write':
        content = inp.get('content', '')
        return f"`{clean(inp.get('file_path', ''))}` ({content.count(chr(10)) + 1} lines; the file is in the repository)"
    if name == 'Edit':
        return (f"`{clean(inp.get('file_path', ''))}`\n\nReplaced:\n" + fence(first_lines(clean(inp.get('old_string', '')), INPUT_LINES))
                + "\nWith:\n" + fence(first_lines(clean(inp.get('new_string', '')), INPUT_LINES)))
    if name == 'Read':
        return f"`{clean(inp.get('file_path', ''))}`"
    if name == 'WebSearch':
        return f"Query: {clean(inp.get('query', ''))}"
    if name == 'WebFetch':
        return f"{clean(inp.get('url', ''))}\n\nPrompt: {clean(inp.get('prompt', ''))}"
    return fence(shorten(clean(json.dumps(inp, ensure_ascii=False, indent=1)), 1500), 'json')


def result_text(content):
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if block.get('type') == 'text':
            parts.append(block.get('text', ''))
        elif block.get('type') == 'image':
            parts.append('[image]')
    return '\n'.join(parts)


def main(src, dst):
    out = ['# Claude Code session: Samsung TV / Pardeh',
           '',
           'Exported from the Claude Code session that set up the TV and built the app (23 October 2026).',
           'It shows user messages, Claude\'s replies, and every tool call with a shortened result. Hidden',
           'reasoning, system instructions and internal records are omitted. Secrets (certificate password,',
           'account emails, the TV\'s DUID, long tokens) are redacted. File contents that were written are',
           'not repeated here because the files are in this repository.',
           '']
    pending = {}   # tool_use_id -> rendered header
    order = []

    def flush_tool(tid, result):
        header = pending.pop(tid, None)
        if header is None:
            return
        body = clean(result_text(result))
        out.append(header + ('\n\n**Result:**\n\n' + fence(shorten(body, RESULT_LIMIT)) if body else '') + '\n\n</details>\n')

    for line in open(src, encoding='utf-8'):
        try:
            r = json.loads(line)
        except ValueError:
            continue
        kind = r.get('type')
        stamp = (r.get('timestamp') or '')[11:16]

        if kind == 'attachment' and (r.get('attachment') or {}).get('type') == 'queued_command':
            text = clean(result_text(r['attachment'].get('prompt')))
            if text:
                out.append(f'### User (sent while Claude was working) {stamp}\n\n{text}\n')
            continue

        msg = r.get('message')
        if not isinstance(msg, dict):
            continue
        content = msg.get('content')

        if kind == 'user':
            if isinstance(content, str):
                continue   # background-task notifications
            texts = []
            for block in content:
                if block.get('type') == 'tool_result':
                    flush_tool(block.get('tool_use_id'), block.get('content'))
                elif block.get('type') == 'text':
                    t = clean(block.get('text'))
                    if t and not t.startswith('[SYSTEM NOTIFICATION'):
                        texts.append(t)
            if texts:
                out.append(f'---\n\n## User {stamp}\n\n' + '\n\n'.join(texts) + '\n')

        elif kind == 'assistant':
            for block in content or []:
                if block.get('type') == 'text':
                    t = clean(block.get('text'))
                    if t:
                        out.append(f'**Claude:** {t}\n')
                elif block.get('type') == 'tool_use':
                    name = block.get('name', 'tool')
                    desc = clean((block.get('input') or {}).get('description', ''))
                    summary = f'{name}' + (f': {desc}' if desc else '')
                    pending[block.get('id')] = (f'<details>\n<summary>🔧 {summary}</summary>\n\n'
                                                + render_input(name, block.get('input') or {}))
                    order.append(block.get('id'))

    for tid in order:   # calls whose result never arrived
        flush_tool(tid, '')
    with open(dst, 'w', encoding='utf-8') as f:
        f.write('\n'.join(out) + '\n')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
