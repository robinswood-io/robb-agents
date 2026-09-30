`guacamole-keyboard-1.5.5.js` is the unmodified Apache Guacamole 1.5.5 keyboard receiver, under the Apache 2.0 license retained in its header.
Source: https://raw.githubusercontent.com/apache/guacamole-client/1.5.5/guacamole-common-js/src/main/webapp/modules/Keyboard.js
SHA256: `5d4a69bb1c5fd85e724de1c734efd40478c9ca410d69b37cba289a04edf8efd8`.

Run the isolated real-Electron keyboard/clipboard recipe from the repository root:
`bun run scripts/verify-browser-remote-input.ts`
It uses a temporary profile and an in-memory browser partition. It does not connect to an RDP server, read the system clipboard, submit a command, or launch the installed Robb Agents application.

The keyboard fixture uses a hidden `data:` document with emulated document focus; clipboard denials use a separate loopback HTTP document. It proves the real Guacamole receiver's Unicode/event handling, not native window focus or Windows/RDP effects. On the real target, focusing the browser window alone may leave the toolbar focused: explicitly click the intended page receiver and inspect document focus before typing.
