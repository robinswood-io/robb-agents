export type RobbAppChannel = 'development' | 'production'

export const PRODUCTION_APP_NAME = 'Robb Agents'
export const DEVELOPMENT_APP_NAME = 'Robb Agents Dev'
export const PRODUCTION_APP_ID = 'io.robinswood.robbagents'
export const DEVELOPMENT_APP_ID = 'io.robinswood.robbagents.dev'
export const PRODUCTION_DEEPLINK_SCHEME = 'craftagents'
export const DEVELOPMENT_DEEPLINK_SCHEME = 'robbagentsdev'

export function resolveAppChannel(
  isPackaged: boolean,
  declaredChannel: string | undefined = process.env.ROBB_BUILD_CHANNEL,
): RobbAppChannel {
  if (declaredChannel === 'development') return 'development'
  return isPackaged ? 'production' : 'development'
}

export function getDefaultAppName(channel: RobbAppChannel): string {
  return channel === 'development' ? DEVELOPMENT_APP_NAME : PRODUCTION_APP_NAME
}

export function getDefaultAppId(channel: RobbAppChannel): string {
  return channel === 'development' ? DEVELOPMENT_APP_ID : PRODUCTION_APP_ID
}

export function getDefaultDeepLinkScheme(channel: RobbAppChannel): string {
  return channel === 'development' ? DEVELOPMENT_DEEPLINK_SCHEME : PRODUCTION_DEEPLINK_SCHEME
}

export function canUseStableUpdater(isPackaged: boolean, channel: RobbAppChannel): boolean {
  return isPackaged && channel === 'production'
}

export function isStableReleaseVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version)
}

export function isDeveloperIdApplicationSignature(details: string): boolean {
  const hasDeveloperIdAuthority = /^Authority=Developer ID Application: .+$/m.test(details)
  const hasAppleTeamIdentifier = /^TeamIdentifier=[A-Z0-9]{10}$/m.test(details)
  return hasDeveloperIdAuthority && hasAppleTeamIdentifier
}
