import { Interface } from '@ethersproject/abi'
import { BigintIsh, Currency, Token } from '@uniswap/sdk-core'
import { abi as IUniswapV3PoolStateABI } from '@uniswap/v3-core/artifacts/contracts/interfaces/pool/IUniswapV3PoolState.sol/IUniswapV3PoolState.json'
import { abi as IUniswapV3FactoryABI } from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Factory.sol/IUniswapV3Factory.json'
// import { computePoolAddress } from '@uniswap/v3-sdk'
import { FeeAmount, Pool } from '@uniswap/v3-sdk'
import { useWeb3React } from '@web3-react/core'
import JSBI from 'jsbi'
import { useMultipleContractSingleData } from 'lib/hooks/multicall'
import { useEffect, useMemo, useState } from 'react'
import { Contract } from '@ethersproject/contracts'
// import { AddressZero } from '@ethersproject/constants'

// // eslint-disable-next-line no-restricted-imports
// import { ethers, BytesLike } from 'ethers'

import { V3_CORE_FACTORY_ADDRESSES } from '../constants/addresses'
import { IUniswapV3PoolStateInterface } from '../types/v3/IUniswapV3PoolState'
import { useContract } from './useContract'

const POOL_STATE_INTERFACE = new Interface(IUniswapV3PoolStateABI) as IUniswapV3PoolStateInterface
// const POOL_INIT_CODE_HASH = '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54'

// @todo
// export function getCreate2Address(sender: string, bytecodeHash: BytesLike, salt: BytesLike, input: BytesLike) {
//   const prefix = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('zksyncCreate2'))
//   const inputHash = ethers.utils.keccak256(input)
//   const addressBytes = ethers.utils
//     .keccak256(ethers.utils.concat([prefix, ethers.utils.zeroPad(sender, 32), salt, bytecodeHash]))
//     .slice(26)
//   return ethers.utils.getAddress(addressBytes)
// }

// Classes are expensive to instantiate, so this caches the recently instantiated pools.
// This avoids re-instantiating pools as the other pools in the same request are loaded.
class PoolCache {
  // Evict after 128 entries. Empirically, a swap uses 64 entries.
  private static MAX_ENTRIES = 128

  // These are FIFOs, using unshift/pop. This makes recent entries faster to find.
  private static pools: Pool[] = []
  private static addresses: { key: string; address: string }[] = []

  static async getPoolAddress(
    v3Factory: Contract,
    factoryAddress: string,
    tokenA: Token,
    tokenB: Token,
    fee: FeeAmount
  ): Promise<string> {
    return new Promise(async (resolve, reject) => {
      if (this.addresses.length > this.MAX_ENTRIES) {
        this.addresses = this.addresses.slice(0, this.MAX_ENTRIES / 2)
      }

      const { address: addressA } = tokenA
      const { address: addressB } = tokenB
      const key = `${factoryAddress}:${addressA}:${addressB}:${fee.toString()}`
      const found = this.addresses.find((address) => address.key === key)
      if (found) {
        resolve(found.address)
        return
      }

      const _poolAddress = await v3Factory?.getPool(tokenA.address, tokenB.address, fee.toString())

      const address = {
        key,
        address: _poolAddress,
        // address: getCreate2Address(
        //   factoryAddress,
        //   ethers.utils.keccak256(
        //     ethers.utils.defaultAbiCoder.encode(['address', 'address', 'uint24'], [token0.address, token1.address, fee])
        //   ),
        //   POOL_INIT_CODE_HASH,
        //   ''
        // ),
        // address: computePoolAddress({
        //   factoryAddress,
        //   tokenA,
        //   tokenB,
        //   fee,
        // }),
      }

      this.addresses.unshift(address)
      resolve(address.address)
    })
  }

  static getPool(
    tokenA: Token,
    tokenB: Token,
    fee: FeeAmount,
    sqrtPriceX96: BigintIsh,
    liquidity: BigintIsh,
    tick: number
  ): Pool {
    if (this.pools.length > this.MAX_ENTRIES) {
      this.pools = this.pools.slice(0, this.MAX_ENTRIES / 2)
    }

    const found = this.pools.find(
      (pool) =>
        pool.token0 === tokenA &&
        pool.token1 === tokenB &&
        pool.fee === fee &&
        JSBI.EQ(pool.sqrtRatioX96, sqrtPriceX96) &&
        JSBI.EQ(pool.liquidity, liquidity) &&
        pool.tickCurrent === tick
    )
    if (found) return found

    const pool = new Pool(tokenA, tokenB, fee, sqrtPriceX96, liquidity, tick)
    this.pools.unshift(pool)
    return pool
  }
}

export enum PoolState {
  LOADING,
  NOT_EXISTS,
  EXISTS,
  INVALID,
}

export function usePools(
  poolKeys: [Currency | undefined, Currency | undefined, FeeAmount | undefined][]
): [PoolState, Pool | null][] {
  const { chainId } = useWeb3React()
  const v3CoreFactoryAddress = chainId ? V3_CORE_FACTORY_ADDRESSES[chainId] : undefined
  const v3Factory = useContract(v3CoreFactoryAddress, IUniswapV3FactoryABI)

  const poolTokens: ([Token, Token, FeeAmount] | undefined)[] = useMemo(() => {
    if (!chainId) return new Array(poolKeys.length)

    return poolKeys.map(([currencyA, currencyB, feeAmount]) => {
      if (currencyA && currencyB && feeAmount) {
        const tokenA = currencyA.wrapped
        const tokenB = currencyB.wrapped
        if (tokenA.equals(tokenB)) return undefined

        return tokenA.sortsBefore(tokenB) ? [tokenA, tokenB, feeAmount] : [tokenB, tokenA, feeAmount]
      }
      return undefined
    })
  }, [chainId, poolKeys])

  const [poolAddresses, setPoolAddresses] = useState<(string | undefined)[]>([])
  useEffect(() => {
    if (!v3CoreFactoryAddress || !v3Factory) {
      setPoolAddresses(new Array(poolTokens.length))
      return
    }
    Promise.all(
      poolTokens.map((value) => value && PoolCache.getPoolAddress(v3Factory, v3CoreFactoryAddress, ...value))
    ).then((res) => {
      setPoolAddresses(res)
    })
  }, [chainId, poolTokens])

  const slot0s = useMultipleContractSingleData(poolAddresses, POOL_STATE_INTERFACE, 'slot0')
  const liquidities = useMultipleContractSingleData(poolAddresses, POOL_STATE_INTERFACE, 'liquidity')

  return useMemo(() => {
    return poolKeys.map((_key, index) => {
      const tokens = poolTokens[index]
      if (!tokens) return [PoolState.INVALID, null]
      const [token0, token1, fee] = tokens

      if (!slot0s[index]) return [PoolState.INVALID, null]
      const { result: slot0, loading: slot0Loading, valid: slot0Valid } = slot0s[index]

      if (!liquidities[index]) return [PoolState.INVALID, null]
      const { result: liquidity, loading: liquidityLoading, valid: liquidityValid } = liquidities[index]

      if (!tokens || !slot0Valid || !liquidityValid) return [PoolState.INVALID, null]
      if (slot0Loading || liquidityLoading) return [PoolState.LOADING, null]
      if (!slot0 || !liquidity) return [PoolState.NOT_EXISTS, null]
      if (!slot0.sqrtPriceX96 || slot0.sqrtPriceX96.eq(0)) return [PoolState.NOT_EXISTS, null]

      try {
        const pool = PoolCache.getPool(token0, token1, fee, slot0.sqrtPriceX96, liquidity[0], slot0.tick)
        return [PoolState.EXISTS, pool]
      } catch (error) {
        console.error('Error when constructing the pool', error)
        return [PoolState.NOT_EXISTS, null]
      }
    })
  }, [liquidities, poolKeys, slot0s, poolTokens])
}

export function usePool(
  currencyA: Currency | undefined,
  currencyB: Currency | undefined,
  feeAmount: FeeAmount | undefined
): [PoolState, Pool | null] {
  const poolKeys: [Currency | undefined, Currency | undefined, FeeAmount | undefined][] = useMemo(
    () => [[currencyA, currencyB, feeAmount]],
    [currencyA, currencyB, feeAmount]
  )

  return usePools(poolKeys)[0]
}
