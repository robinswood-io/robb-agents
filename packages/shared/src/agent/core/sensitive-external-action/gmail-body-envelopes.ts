
/** Parse complete body envelopes in one pass, rejecting nested or unclosed markers. */
export function gmailBodyEnvelopeSpans(text: string): Array<{ body: string; start: number; end: number }> | null {
  const spans: Array<{ body: string; start: number; end: number }> = [];
  let start: number | undefined;
  for (const marker of text.matchAll(/^[ \t]*BODY_(BEGIN|END)[ \t]*\r?$/gimu)) {
    if (marker[1]!.toUpperCase() === 'BEGIN') {
      if (start !== undefined) return null;
      start = marker.index + marker[0].length + 1;
      if (text[start - 1] !== '\n') return null;
    } else {
      if (start === undefined || marker.index <= start) return null;
      const end = marker.index - (text[marker.index - 2] === '\r' ? 2 : 1);
      spans.push({ body: text.slice(start, end), start, end });
      start = undefined;
    }
  }
  return start === undefined ? spans : null;
}
