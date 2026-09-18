/** Process-wide state shared between the two servers. */

export type TunnelStatus = 'starting' | 'ready' | 'error';

export const appState = {
  tunnelStatus: 'starting' as TunnelStatus,
  tunnelUrl: null as string | null,
  tunnelError: null as string | null,
  pcName: process.env.COMPUTERNAME || process.env.HOSTNAME || 'this PC',
  /** Restarts the tunnel after a failure. Set by the CLI. */
  retryTunnel: null as (() => void) | null,
};
