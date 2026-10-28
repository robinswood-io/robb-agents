import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import TurndownService from "turndown";
import { parse as parseHtml } from "node-html-parser";
import { result } from './responses.ts';

const NOISE_ELEMENTS = ['script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript', 'iframe', 'svg'];

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
}).remove(node => NOISE_ELEMENTS.includes(node.nodeName.toLowerCase()));

export function handleHtml(
  html: string,
  url: string,
  prompt: string | undefined,
): AgentToolResult<{ isError?: boolean }> {
  const root = parseHtml(html);
  // Strip noise elements from the DOM before selecting mainContent.
  root
    .querySelectorAll(NOISE_ELEMENTS.join(', '))
    .forEach((el) => el.remove());

  const mainContent =
    root.querySelector('main, article, [role="main"], .content, #content') ||
    root.querySelector('body') ||
    root;

  const markdown = turndown.turndown(mainContent.innerHTML);

  const prefix = prompt
    ? `Content from ${url} (asked: "${prompt}"):\n\n`
    : `Content from ${url}:\n\n`;

  return result(prefix + markdown);
}
