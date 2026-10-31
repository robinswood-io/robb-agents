import { parseSimpleCommands, unwrapCommand } from './shell-parser.ts';
import { basename } from './target-syntax.ts';

export function boundedRemoteReadHasHiddenSideEffect(command: string): boolean {
  const commands = parseSimpleCommands(command);
  if (commands.length === 0) return false;
  return commands.some((rawWords) => {
    const words = unwrapCommand(rawWords);
    const executable = basename(words[0] ?? '');
    if (executable === 'rg') {
      return words.slice(1).some(word => (
        /^--(?:pre|config|hostname-bin)(?:-|=|$)/u.test(word)
      ));
    }
    if (executable === 'find') {
      return words.slice(1).some(word => (
        /^-(?:delete|exec|execdir|ok|okdir|fls|fprint|fprint0|fprintf)$/u.test(word)
      ));
    }
    if (executable === 'git') {
      return words.slice(1).some(word => (
        /^--output(?:=|$)/u.test(word)
        || /^--(?:ext-diff|textconv)(?:=|$)/u.test(word)
      ));
    }
    if (executable === 'sed') {
      return words.slice(1).some(word => /^(?:-f(?:.+)?|--file(?:=|$))/u.test(word));
    }
    if (executable === 'jq') {
      return words.slice(1).some(word => (
        /(?:^|[^A-Za-z0-9_])(?:\$ENV|env)(?:[^A-Za-z0-9_]|$)/iu.test(word)
        || /^(?:-f(?:.+)?|--from-file(?:=|$)|-L(?:.+)?|--library-path(?:=|$))/u.test(word)
      ));
    }
    if (executable === 'sort') {
      return words.slice(1).some(word => (
        /^-o.+/u.test(word) || word === '-o'
        || /^--(?:output|compress-program)(?:=|$)/u.test(word)
      ));
    }
    return executable === 'date'
      && words.slice(1).some(word => word === '-s' || /^--set(?:=|$)/u.test(word));
  });
}
