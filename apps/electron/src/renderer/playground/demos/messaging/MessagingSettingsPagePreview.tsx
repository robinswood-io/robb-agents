/**
 * Thin playground wrapper around the production mobile-access settings page.
 * The Electron playground uses its isolated remote-enabled profile, so the
 * real QR-code and one-time-link flow can be exercised here.
 */

import MessagingSettingsPage from '../../../pages/settings/MessagingSettingsPage'

export function MessagingSettingsPagePreview() {
  return <MessagingSettingsPage />
}
