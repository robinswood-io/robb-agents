import { isProvablyReadOnlyShellCommand } from "../registered-observation.ts";
import { isSignedResumeSegment, objectiveSegmentPositivelyMentionsAny, resolveBoundedRemotePath } from './signed-resume-targets.ts';

export function resumedRemoteReadCommandMatchesObjective(
  command: string,
  cwd: string,
  segment: string,
): boolean {
  if (!isSignedResumeSegment(segment)) return false;

  const bunTest = /^bun run (test:[A-Za-z0-9:_-]{1,160})$/u.exec(command);
  if (bunTest) return objectiveSegmentPositivelyMentionsAny(segment, [`\`${command}\``]);

  const curl = /^curl --fail-with-body --silent --show-error --max-time ([1-9]\d{0,2}) (https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(\/[A-Za-z0-9_./-]{1,1024}))$/u.exec(command);
  if (curl) {
    const project = cwd.slice('/srv/workspace/'.length).split('/')[0];
    return cwd.startsWith('/srv/workspace/')
      && !!project
      && [...segment.matchAll(/https:\/\/([a-z0-9.-]+)(?=[:\/\s`])/gu)].some(match => (
        match[1] === curl[3]
        && objectiveSegmentPositivelyMentionsAny(segment, [match[0]])
      ))
      && objectiveSegmentPositivelyMentionsAny(segment, [
        `GET ${curl[4]}`,
        `\`${curl[4]}\``,
      ]);
  }

  const readlink = /^readlink -f ((?:\.\/)?[A-Za-z0-9_@%+=,./()\-]{1,1900}\.(?:c?js|mjs|ts|tsx|json|sql|ya?ml|toml|ini|conf|md|service))$/u.exec(command);
  if (readlink) return resolveBoundedRemotePath(cwd, readlink[1]!) !== undefined;

  const compose = /^docker compose -f ((?:\.\/)?[A-Za-z0-9_@%+=,./()\-]{1,1900}\.ya?ml) ps$/iu.exec(command);
  if (compose) return resolveBoundedRemotePath(cwd, compose[1]!) !== undefined;

  const envNames = /^docker inspect --format '\{\{range \.Config\.Env\}\}\{\{println \.\}\}\{\{end\}\}' ([a-z0-9][a-z0-9_.-]{0,127}) \| sed 's\/=\.\*\/\/' \| sort$/u.exec(command);
  if (envNames) {
    const project = cwd.slice('/srv/workspace/'.length).split('/')[0];
    return cwd.startsWith('/srv/workspace/') && !!project
      && (envNames[1] === project || envNames[1]!.startsWith(`${project}-`));
  }

  const hardenedGitPrefix = 'git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager ';
  if (command === `${hardenedGitPrefix}log -1 --format='%H %cI %s'`) return true;
  return command.startsWith(hardenedGitPrefix)
    && !command.includes(' -C ')
    && isProvablyReadOnlyShellCommand(command);
}
