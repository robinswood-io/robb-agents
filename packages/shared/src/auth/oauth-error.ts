import { parseJsonObject } from '../utils/json.ts';

/** OAuth error fields are untrusted; retain only the strings the UI can display. */
export function parseOAuthError(text: string): { error?: string; error_description?: string } {
  const value = parseJsonObject(text);
  const error = value['error'];
  const description = value['error_description'];
  return {
    ...(typeof error === 'string' ? { error } : {}),
    ...(typeof description === 'string' ? { error_description: description } : {}),
  };
}
