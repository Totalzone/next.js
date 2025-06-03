import { InvariantError } from '../../shared/lib/invariant-error'
import {
  postponeWithTracking,
  throwToInterruptStaticGeneration,
} from '../app-render/dynamic-rendering'
import {
  workAsyncStorage,
  type WorkStore,
} from '../app-render/work-async-storage.external'
import {
  workUnitAsyncStorage,
  type PrerenderStore,
  type PrerenderStoreLegacy,
  type PrerenderStorePPR,
} from '../app-render/work-unit-async-storage.external'
import { makeHangingPromise } from '../dynamic-rendering-utils'
import type { FallbackRouteParams } from './fallback-params'
import type { Params, ParamValue } from './params'
import {
  describeStringPropertyAccess,
  wellKnownProperties,
} from '../../shared/lib/utils/reflect-utils'

interface CacheLifetime {}
const CachedParams = new WeakMap<CacheLifetime, Promise<Params>>()

export async function getRootParam(name: string): Promise<ParamValue> {
  const rootParams = await rootParamsImpl(`root param getter \`${name}\``)
  return rootParams[name]
}

export async function unstable_rootParams(): Promise<Params> {
  return rootParamsImpl('`unstable_rootParams`')
}

export async function rootParamsImpl(apiName: string): Promise<Params> {
  const workStore = workAsyncStorage.getStore()
  if (!workStore) {
    throw new InvariantError(`Missing workStore in ${apiName}`)
  }

  const workUnitStore = workUnitAsyncStorage.getStore()

  if (!workUnitStore) {
    throw new Error(
      `Route ${workStore.route} used ${apiName} in Pages Router. This API is only available within App Router.`
    )
  }

  switch (workUnitStore.type) {
    case 'unstable-cache':
    case 'cache': {
      throw new Error(
        `Route ${workStore.route} used ${apiName} inside \`"use cache"\` or \`unstable_cache\`. Support for this API inside cache scopes is planned for a future version of Next.js.`
      )
    }
    case 'prerender':
    case 'prerender-client':
    case 'prerender-ppr':
    case 'prerender-legacy':
      return createPrerenderRootParams(
        workUnitStore.rootParams,
        workStore,
        workUnitStore,
        apiName
      )
    default:
      return Promise.resolve(workUnitStore.rootParams)
  }
}

function createPrerenderRootParams(
  underlyingParams: Params,
  workStore: WorkStore,
  prerenderStore: PrerenderStore,
  apiName: string
): Promise<Params> {
  const fallbackParams = workStore.fallbackRouteParams
  if (fallbackParams) {
    let hasSomeFallbackParams = false
    for (const key in underlyingParams) {
      if (fallbackParams.has(key)) {
        hasSomeFallbackParams = true
        break
      }
    }

    if (hasSomeFallbackParams) {
      // params need to be treated as dynamic because we have at least one fallback param
      switch (prerenderStore.type) {
        case 'prerender':
          // We are in a dynamicIO prerender
          const cachedParams = CachedParams.get(underlyingParams)
          if (cachedParams) {
            return cachedParams
          }

          const promise = makeHangingPromise<Params>(
            prerenderStore.renderSignal,
            apiName
          )
          CachedParams.set(underlyingParams, promise)

          return promise
        case 'prerender-client':
          throw new InvariantError(
            `${apiName} must not be used within a client component. Next.js should be preventing ${apiName} from being included in client components statically, but did not in this case.`
          )
        default:
          // remaining cases are prerender-ppr and prerender-legacy
          // We aren't in a dynamicIO prerender but we do have fallback params at this
          // level so we need to make an erroring params object which will postpone
          // if you access the fallback params
          return makeErroringRootParams(
            underlyingParams,
            fallbackParams,
            workStore,
            prerenderStore,
            apiName
          )
      }
    }
  }

  // We don't have any fallback params so we have an entirely static safe params object
  return Promise.resolve(underlyingParams)
}

function makeErroringRootParams(
  underlyingParams: Params,
  fallbackParams: FallbackRouteParams,
  workStore: WorkStore,
  prerenderStore: PrerenderStorePPR | PrerenderStoreLegacy,
  apiName: string
): Promise<Params> {
  const cachedParams = CachedParams.get(underlyingParams)
  if (cachedParams) {
    return cachedParams
  }

  const augmentedUnderlying = { ...underlyingParams }

  // We don't use makeResolvedReactPromise here because params
  // supports copying with spread and we don't want to unnecessarily
  // instrument the promise with spreadable properties of ReactPromise.
  const promise = Promise.resolve(augmentedUnderlying)
  CachedParams.set(underlyingParams, promise)

  Object.keys(underlyingParams).forEach((prop) => {
    if (wellKnownProperties.has(prop)) {
      // These properties cannot be shadowed because they need to be the
      // true underlying value for Promises to work correctly at runtime
    } else {
      if (fallbackParams.has(prop)) {
        Object.defineProperty(augmentedUnderlying, prop, {
          get() {
            // TODO: this probably won't work right for root param getters
            const expression = describeStringPropertyAccess(apiName, prop)
            // In most dynamic APIs we also throw if `dynamic = "error"` however
            // for params is only dynamic when we're generating a fallback shell
            // and even when `dynamic = "error"` we still support generating dynamic
            // fallback shells
            // TODO remove this comment when dynamicIO is the default since there
            // will be no `dynamic = "error"`
            if (prerenderStore.type === 'prerender-ppr') {
              // PPR Prerender (no dynamicIO)
              postponeWithTracking(
                workStore.route,
                expression,
                prerenderStore.dynamicTracking
              )
            } else {
              // Legacy Prerender
              throwToInterruptStaticGeneration(
                expression,
                workStore,
                prerenderStore
              )
            }
          },
          enumerable: true,
        })
      } else {
        ;(promise as any)[prop] = underlyingParams[prop]
      }
    }
  })

  return promise
}
