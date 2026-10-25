import { type PermissionManagerLike } from "../../pre-tool-use.ts";



export const whitelistedPermissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => true,
  isDangerousCommand: () => false,
  getBaseCommand: (command) => command.split(/\s+/)[0] ?? command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => true,
};

export const nonWhitelistedPermissionManager: PermissionManagerLike = {
  ...whitelistedPermissionManager,
  isCommandWhitelisted: () => false,
  isDomainWhitelisted: () => false,
};


export function gmailRecipientBinding(
  digestCharacter = 'a',
  issuedAtSeconds = Math.floor(Date.now() / 1000),
): string {
  return `v1.${issuedAtSeconds}.${digestCharacter.repeat(64)}`;
}
