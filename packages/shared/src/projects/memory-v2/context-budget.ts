import { estimateTokensDensityAware } from "../../utils/large-response.ts";

export function fitTextToTokenBudget(text: string, maxTokens: number, marker: string): string {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new Error('maxTokens must be a positive finite number');
  }
  if (estimateTokensDensityAware(text) <= maxTokens) return text;

  const markerTokens = estimateTokensDensityAware(marker);
  if (markerTokens >= maxTokens) {
    return truncateTextToTokenBudget(marker, maxTokens);
  }
  const availableTokens = Math.max(0, maxTokens - markerTokens);
  const estimatedTokens = estimateTokensDensityAware(text);
  let charBudget = Math.floor((text.length / estimatedTokens) * availableTokens);
  let result = `${text.slice(0, charBudget).trimEnd()}${marker}`;
  while (charBudget > 0 && estimateTokensDensityAware(result) > maxTokens) {
    charBudget = Math.max(0, charBudget - Math.max(1, Math.ceil(charBudget * 0.05)));
    result = `${text.slice(0, charBudget).trimEnd()}${marker}`;
  }
  return result;
}

function truncateTextToTokenBudget(text: string, maxTokens: number): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokensDensityAware(text.slice(0, middle)) <= maxTokens) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return text.slice(0, low);
}
