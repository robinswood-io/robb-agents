#!/usr/bin/env python3
"""No Gmail effects: exercise read retries and single-attempt write safety."""
import io, json, unittest
from unittest.mock import patch
from urllib.error import HTTPError
import scotland_executive_conference_october as m

class GmailReadRetries(unittest.TestCase):
    def gateway(self):
        g = object.__new__(m.Gateway)
        g.token = 'offline-fixture'
        return g
    def failure(self, code=503, headers=None):
        return HTTPError('https://gmail.googleapis.com/fixture', code, 'fixture', headers or {}, io.BytesIO(b'{}'))
    def response(self):
        return io.BytesIO(json.dumps({'messages': []}).encode())
    def test_read_recovers_after_two_transient_failures(self):
        with patch.object(m.request, 'urlopen', side_effect=[self.failure(), self.failure(502), self.response()]) as call, patch.object(m.time, 'sleep') as sleep:
            self.assertEqual(self.gateway().search('in:sent'), [])
            self.assertEqual(call.call_count, 3)
            self.assertEqual([x.args[0] for x in sleep.call_args_list], [2, 4])
    def test_write_is_never_retried(self):
        with patch.object(m.request, 'urlopen', side_effect=self.failure()) as call, patch.object(m.time, 'sleep') as sleep:
            with self.assertRaises(HTTPError): self.gateway().call('/messages/send', {'raw': 'fixture'})
            self.assertEqual(call.call_count, 1)
            sleep.assert_not_called()
    def test_retries_are_finite(self):
        with patch.object(m.request, 'urlopen', side_effect=[self.failure() for _ in range(3)]) as call, patch.object(m.time, 'sleep') as sleep:
            with self.assertRaises(HTTPError): self.gateway().search('in:sent')
            self.assertEqual(call.call_count, 3)
            self.assertEqual(sleep.call_count, 2)
    def test_auth_and_quota_errors_are_not_retried(self):
        for code in [400, 401, 403, 429]:
            with self.subTest(code=code), patch.object(m.request, 'urlopen', side_effect=self.failure(code)) as call, patch.object(m.time, 'sleep') as sleep:
                with self.assertRaises(HTTPError): self.gateway().search('in:sent')
                self.assertEqual(call.call_count, 1)
                sleep.assert_not_called()
    def test_server_cooldown_respected_and_long_cooldown_deferred(self):
        with patch.object(m.request, 'urlopen', side_effect=[self.failure(headers={'Retry-After': '7'}), self.response()]), patch.object(m.time, 'sleep') as sleep:
            self.gateway().search('in:sent'); sleep.assert_called_once_with(7)
        for value in ['60', 'Fri, 02 Oct 2026 09:30:00 GMT']:
            with patch.object(m.request, 'urlopen', side_effect=self.failure(headers={'Retry-After': value})) as call, patch.object(m.time, 'sleep') as sleep:
                with self.assertRaises(HTTPError): self.gateway().search('in:sent')
                self.assertEqual(call.call_count, 1); sleep.assert_not_called()

if __name__ == '__main__': unittest.main()
