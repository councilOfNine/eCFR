import { useQuery } from '@tanstack/react-query'
import { Wifi, WifiOff } from 'lucide-react'
import { cn } from '@/lib/utils'

function ConnectionStatus() {
  const { isSuccess, isError, isLoading } = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const res = await fetch('/api/health')
      if (!res.ok) throw new Error('Backend unreachable')
      return res.json()
    },
    refetchInterval: 10000,
    retry: 1,
    staleTime: 5000,
  })

  const connected = isSuccess
  const disconnected = isError

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <div
        className={cn(
          'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm shadow-md transition-colors',
          connected && 'border-green-500/30 bg-green-50 text-green-700 dark:bg-green-950/50 dark:text-green-400',
          disconnected && 'border-red-500/30 bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-400',
          isLoading && 'border-border bg-muted text-muted-foreground'
        )}
      >
        {connected && (
          <>
            <Wifi className="h-4 w-4" />
            <span>Connected</span>
          </>
        )}
        {disconnected && (
          <>
            <WifiOff className="h-4 w-4" />
            <span>Server unavailable</span>
          </>
        )}
        {isLoading && (
          <>
            <Wifi className="h-4 w-4 animate-pulse" />
            <span>Connecting…</span>
          </>
        )}
      </div>
    </div>
  )
}

export default ConnectionStatus
