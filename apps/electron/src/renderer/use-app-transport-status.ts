import { useCallback } from 'react';

import { useTransportConnectionState } from '@/hooks/useTransportConnectionState';

import { shouldShowTransportConnectionBanner } from '@/components/app-shell/TransportConnectionBanner';

import { toast } from 'sonner';

interface useAppTransportStatusInput {
  t: import("i18next").TFunction<"translation", undefined>
}

export function useAppTransportStatus({
  t,
}: useAppTransportStatusInput) {
const connectionState = useTransportConnectionState()

const showTransportConnectionBanner = shouldShowTransportConnectionBanner(connectionState)

const handleReconnectTransport = useCallback(() => {
    void window.electronAPI.reconnectTransport().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Unknown error'
      toast.error(t('toast.reconnectFailed'), { description: message })
    })
  }, [t])
return { showTransportConnectionBanner, connectionState, handleReconnectTransport }
}
