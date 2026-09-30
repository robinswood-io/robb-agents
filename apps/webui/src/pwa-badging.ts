interface PwaBadgeState {
  unreadCount: number
  offlineItemCount: number
  updateAvailable: boolean
}

const state: PwaBadgeState = {
  unreadCount: 0,
  offlineItemCount: 0,
  updateAvailable: false,
}

type BadgeNavigator = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>
  clearAppBadge?: () => Promise<void>
}

function getBadgeNavigator(): BadgeNavigator | null {
  if (typeof navigator === 'undefined') return null
  return navigator as BadgeNavigator
}

export function supportsAppBadging(): boolean {
  const badgeNavigator = getBadgeNavigator()
  return typeof badgeNavigator?.setAppBadge === 'function'
    && typeof badgeNavigator.clearAppBadge === 'function'
}

export function computePwaBadgeValue(input: PwaBadgeState): number | 'flag' | null {
  const count = Math.max(0, input.unreadCount) + Math.max(0, input.offlineItemCount)
  if (count > 0) return Math.min(99, count)
  return input.updateAvailable ? 'flag' : null
}

export async function applyPwaBadge(value: number | 'flag' | null): Promise<boolean> {
  const badgeNavigator = getBadgeNavigator()
  if (!supportsAppBadging() || !badgeNavigator?.setAppBadge || !badgeNavigator.clearAppBadge) {
    return false
  }

  try {
    if (value === null) await badgeNavigator.clearAppBadge()
    else if (value === 'flag') await badgeNavigator.setAppBadge()
    else await badgeNavigator.setAppBadge(value)
    return true
  } catch {
    return false
  }
}

export function publishPwaBadgeState(patch: Partial<PwaBadgeState>): Promise<boolean> {
  Object.assign(state, patch)
  return applyPwaBadge(computePwaBadgeValue(state))
}
