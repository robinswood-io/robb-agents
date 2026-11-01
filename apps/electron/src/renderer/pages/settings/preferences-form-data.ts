/** Pure form data; renderer assets are loaded only by the page. */
import { isJsonObject, parseJsonObject } from '@craft-agent/shared/utils/json';

export interface PreferencesFormState {
  name: string
  timezone: string
  city: string
  country: string
  notes: string
}

export const emptyFormState: PreferencesFormState = {
  name: '',
  timezone: '',
  city: '',
  country: '',
  notes: '',
}

export function parsePreferences(json: string): PreferencesFormState {
  try {
    const prefs = parseJsonObject(json)
    const location = isJsonObject(prefs['location']) ? prefs['location'] : {}
    return {
      name: typeof prefs['name'] === 'string' ? prefs['name'] : '',
      timezone: typeof prefs['timezone'] === 'string' ? prefs['timezone'] : '',
      city: typeof location['city'] === 'string' ? location['city'] : '',
      country: typeof location['country'] === 'string' ? location['country'] : '',
      notes: typeof prefs['notes'] === 'string' ? prefs['notes'] : '',
    }
  } catch {
    return emptyFormState
  }
}
