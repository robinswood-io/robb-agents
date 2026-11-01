"""No Gmail effects: exercise read retries and single-attempt write safety."""
import io
import json
import socket
import unittest
from email.message import Message
from http.client import HTTPResponse
from unittest.mock import patch
from urllib.error import HTTPError

import evergreen_offline_test_guard as offline_guard
import scotland_conference_transport as m


def tearDownModule() -> None:
    offline_guard.assert_no_external_attempts()


class GmailReadRetries(unittest.TestCase):
    def gateway(self) -> m.Gateway:
        g = object.__new__(m.Gateway)
        g.token = 'offline-fixture'
        return g
    def failure(self, code: int = 503, headers: dict[str, str] | None = None) -> HTTPError:
        message = Message()
        for key, value in (headers or {}).items():
            message[key] = value
        failure = HTTPError('https://gmail.googleapis.com/fixture', code, 'fixture', message, io.BytesIO(b'{}'))
        self.addCleanup(failure.close)
        return failure
    def response(self) -> HTTPResponse:
        payload = json.dumps({'messages': []}).encode()
        frame = b'HTTP/1.1 200 OK\r\nContent-Length: ' + str(len(payload)).encode() + b'\r\n\r\n' + payload
        reader, writer = socket.socketpair()
        with reader, writer:
            writer.sendall(frame)
            response = HTTPResponse(reader)
            response.begin()
            self.addCleanup(response.close)
            return response
    def test_read_recovers_after_two_transient_failures(self) -> None:
        with patch('scotland_conference_transport.request.urlopen', side_effect=[self.failure(), self.failure(502), self.response()]) as call, patch('scotland_conference_transport.time.sleep') as sleep:
            self.assertEqual(self.gateway().search('in:sent'), [])
            self.assertEqual(call.call_count, 3)
            self.assertEqual([x.args[0] for x in sleep.call_args_list], [2, 4])
    def test_write_is_never_retried(self) -> None:
        with patch('scotland_conference_transport.request.urlopen', side_effect=self.failure()) as call, patch('scotland_conference_transport.time.sleep') as sleep:
            with self.assertRaises(HTTPError): _ = self.gateway().call('/messages/send', {'raw': 'fixture'})
            self.assertEqual(call.call_count, 1)
            sleep.assert_not_called()
    def test_retries_are_finite(self) -> None:
        with patch('scotland_conference_transport.request.urlopen', side_effect=[self.failure() for _ in range(3)]) as call, patch('scotland_conference_transport.time.sleep') as sleep:
            with self.assertRaises(HTTPError): _ = self.gateway().search('in:sent')
            self.assertEqual(call.call_count, 3)
            self.assertEqual(sleep.call_count, 2)
    def test_auth_and_quota_errors_are_not_retried(self) -> None:
        for code in [400, 401, 403, 429]:
            with self.subTest(code=code), patch('scotland_conference_transport.request.urlopen', side_effect=self.failure(code)) as call, patch('scotland_conference_transport.time.sleep') as sleep:
                with self.assertRaises(HTTPError): _ = self.gateway().search('in:sent')
                self.assertEqual(call.call_count, 1)
                sleep.assert_not_called()
    def test_server_cooldown_respected_and_long_cooldown_deferred(self) -> None:
        with patch('scotland_conference_transport.request.urlopen', side_effect=[self.failure(headers={'Retry-After': '7'}), self.response()]), patch('scotland_conference_transport.time.sleep') as sleep:
            _ = self.gateway().search('in:sent'); sleep.assert_called_once_with(7)
        for value in ['60', 'Fri, 02 Oct 2026 09:30:00 GMT']:
            with patch('scotland_conference_transport.request.urlopen', side_effect=self.failure(headers={'Retry-After': value})) as call, patch('scotland_conference_transport.time.sleep') as sleep:
                with self.assertRaises(HTTPError): _ = self.gateway().search('in:sent')
                self.assertEqual(call.call_count, 1); sleep.assert_not_called()

if __name__ == '__main__':
    _ = unittest.main()
