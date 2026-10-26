from __future__ import annotations

import base64, hashlib, html, json, re, time
from email.message import EmailMessage
from email.utils import getaddresses
from pathlib import Path
from urllib import request, parse, error

SENDER = 'thibault@robinswood.io'

GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'

def read(path):
    return json.loads(Path(path).read_text())

def require(condition, message='contract_guard_failed'):
    if not condition:
        raise AssertionError(message)

def plain(payload):
    if payload.get('mimeType') == 'text/plain':
        data = payload.get('body', {}).get('data', '')
        return base64.urlsafe_b64decode(data + '=' * (-len(data) % 4)).decode('utf-8', 'replace')
    for part in payload.get('parts', []):
        found = plain(part)
        if found:
            return found
    if payload.get('mimeType') == 'text/html':
        data = payload.get('body', {}).get('data', '')
        text = base64.urlsafe_b64decode(data + '=' * (-len(data) % 4)).decode('utf-8', 'replace')
        return html.unescape(re.sub('<[^>]+>', ' ', text))
    return ''

def header(m, key):
    return next((h['value'] for h in m.get('payload', {}).get('headers', []) if h['name'].lower() == key.lower()), '').strip()

def addresses(value):
    return sorted(a.lower() for _, a in getaddresses([value]) if a)

def attachments(p):
    return bool(p.get('filename')) or any(attachments(x) for x in p.get('parts', []))

def classify(m):
    # Work on the new response only. Never learn from the quoted invitation.
    text = re.split(r'(?im)^On .{0,200}wrote:|^From:|^_{4,}|^-{4,}.*Original Message|^>', plain(m.get('payload', {})))[0].strip().lower()
    auto = header(m, 'Auto-Submitted').lower()
    if ('auto-replied' in auto or re.search(r'out of (?:the )?office|automatic reply|on annual leave', text)):
        return 'automatic_reply', text[:600]
    if re.search(r'spam|complaint|report(?:ed|ing) you', text):
        return 'complaint', text[:600]
    if re.search(r'unsubscribe|remove me|do not contact|stop emailing|no thanks|not interested|not relevant', text):
        return 'opt_out_or_negative', text[:600]
    if re.search(r'undeliverable|delivery.*fail|5\.1\.1|address.*not found', text):
        return 'delivery_failure', text[:600]
    if re.search(r'\bnot\b|\bno\b|\bdon.t\b|\bwon.t\b', text):
        return 'reply_received', text[:600]
    if re.search(r"\b(?:send|share|see|receive|get|forward)\b.{0,60}\b(?:programme|program|agenda|one.page)\b|\b(?:programme|program|agenda)\b.{0,40}\bplease\b", text):
        return 'programme_requested', text[:600]
    if re.search(r"\b(?:we|our|i)\b", text) and re.search(r"\b(?:[0-9]+(?:\.[0-9]+)?|five|ten|fifteen|twenty|forty)\s*(?:hours?|days?|minutes?)\b", text) and re.search(r"\b(?:invoices?|reconcil\w*|quot\w*|reports?|orders?|approvals?|handoffs?|data entry|follow.?up)\b", text):
        return 'qualified_need', text[:600]
    if re.search(r"\b(?:yes\b|interested|sounds (?:useful|good|interesting)|please (?:send|share)|let.s (?:talk|discuss|arrange)|happy to (?:discuss|talk))", text):
        return 'qualified_interest', text[:600]
    return 'reply_received', text[:600]

class Gateway:
    def __init__(self):
        creds = read('/home/craft/.craft-agent/xdg-config/google-mcp/credentials.json')['installed']
        tokens = read('/home/craft/.craft-agent/xdg-data/google-mcp/tokens.json')
        data = parse.urlencode(dict(client_id=creds['client_id'], client_secret=creds['client_secret'], refresh_token=tokens['refresh_token'], grant_type='refresh_token')).encode()
        with request.urlopen(request.Request(creds['token_uri'], data=data), timeout=25) as r:
            self.token = json.load(r)['access_token']
        require(self.call('/profile')['emailAddress'].lower() == SENDER, 'unexpected_gmail_account')
        self.identity = None

    def call(self, path, data=None):
        headers = {'Authorization': 'Bearer ' + self.token}
        if data is not None:
            headers['Content-Type'] = 'application/json'
        # Only idempotent reads may retry. A Gmail write with an ambiguous
        # outcome remains reserved in SQLite and is reconciled on the next run.
        attempts = 3 if data is None else 1
        for attempt in range(attempts):
            try:
                with request.urlopen(request.Request(GMAIL + path, data=json.dumps(data).encode() if data is not None else None, headers=headers), timeout=25) as r:
                    return json.load(r)
            except error.HTTPError as exc:
                if exc.code not in (500, 502, 503, 504) or attempt + 1 >= attempts:
                    raise
                retry_after = exc.headers.get('Retry-After', '') if exc.headers else ''
                # A long or dated server cooldown is left to the next native tick.
                if retry_after and (not retry_after.isdecimal() or int(retry_after) > 30):
                    raise
                delay = max(2 ** (attempt + 1), int(retry_after or 0))
                exc.close()
                time.sleep(delay)

    def search(self, query):
        return self.call('/messages?' + parse.urlencode({'q': query, 'maxResults': 100})).get('messages', [])

    def get(self, message_id):
        return self.call('/messages/' + message_id + '?format=full')

    def prepare(self, item, draft, operation, parent=None):
        if self.identity is None:
            self.identity = next(x for x in self.call('/settings/sendAs')['sendAs'] if x['sendAsEmail'].lower() == SENDER)
        identity = self.identity
        signature = identity.get('signature', '').strip()
        require(signature and identity.get('verificationStatus') in [None, 'accepted'], 'sender_signature_not_ready')
        sig_text = html.unescape(re.sub('<[^>]+>', ' ', re.sub(r'<br\s*/?>', '\n', signature)))
        expected = draft['body'].strip() + '\n\n' + sig_text.strip() + '\n'
        m = EmailMessage()
        m['From'], m['To'], m['Subject'] = SENDER, item['email'], draft['subject']
        m['Message-ID'] = '<' + operation + '@robinswood.io>'
        m['X-RBW-Campaign'] = 'scotland-executive-conference-october-2026'
        m['X-RBW-Operation'] = operation
        if parent:
            m['In-Reply-To'] = header(parent, 'Message-ID')
            m['References'] = header(parent, 'Message-ID')
        m.set_content(expected)
        m.add_alternative('<div>' + html.escape(draft['body']).replace('\n', '<br>') + '</div><br>' + signature, subtype='html')
        raw = base64.urlsafe_b64encode(m.as_bytes()).decode()
        return raw, expected, hashlib.sha256(signature.encode()).hexdigest()

    def send(self, raw, thread_id=None):
        data = {'raw': raw}
        if thread_id:
            data['threadId'] = thread_id
        from outbound_sender_guard import shared_send
        return shared_send(self, raw, thread_id, lambda: self.call('/messages/send', data))
