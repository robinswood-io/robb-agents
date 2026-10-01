import type { RemoteDeviceInfo } from '@craft-agent/shared/config/server-config'

export function isActiveRemoteDevice(device: RemoteDeviceInfo, now = Date.now()): boolean {
  return !device.revokedAt && Date.parse(device.expiresAt) > now
}

export function getActiveRemoteDevices(
  devices: readonly RemoteDeviceInfo[],
  now = Date.now(),
): RemoteDeviceInfo[] {
  return devices
    .filter((device) => isActiveRemoteDevice(device, now))
    .sort((left, right) => Date.parse(right.pairedAt) - Date.parse(left.pairedAt))
}

export function hasNewActiveRemoteDevice(
  devices: readonly RemoteDeviceInfo[],
  knownDeviceIds: ReadonlySet<string>,
  now = Date.now(),
): boolean {
  return devices.some((device) => (
    !knownDeviceIds.has(device.id) && isActiveRemoteDevice(device, now)
  ))
}
