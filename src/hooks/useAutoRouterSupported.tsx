import { useWeb3React } from '@web3-react/core'
import { SupportedChainId } from 'constants/chains'
import { isSupportedChainId } from 'lib/hooks/routing/clientSideSmartOrderRouter'

export default function useAutoRouterSupported(): boolean {
  const { chainId } = useWeb3React()
  if (!chainId) return false
  if (
    [SupportedChainId.ZKSYNC_ERA, SupportedChainId.ZKSYNC_ERA_SEPOLIA, SupportedChainId.ZKSYNC_ERA_INMEMORY].includes(
      chainId
    )
  )
    return false
  return isSupportedChainId(chainId)
}
