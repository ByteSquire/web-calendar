import { createError } from 'h3'
import { createIcalProxy, type IcalProxy } from './cache'
import { ALLOW_PRIVATE_ACK_VARIABLE, parseIcalProxyConfig } from './config'
import { IcalFetchError } from './errors'
import { createAddressPolicy, type AddressPolicy } from './ssrf'

// Nitro glue of the iCal proxy: reads the runtime config once and owns the one proxy instance,
// so its cache is shared by all requests. The logic is in the plain modules next to this file.

let runtime: { proxy: IcalProxy; policy: AddressPolicy } | undefined

function getRuntime() {
  if (!runtime) {
    // Read from the environment, not from runtimeConfig: the second switch is a deliberate act
    // of the operator and has no entry in nuxt.config.ts or .env.example.
    const config = parseIcalProxyConfig(useRuntimeConfig().icalProxy, {
      production: process.env.NODE_ENV === 'production',
      allowPrivateAcknowledged: process.env[ALLOW_PRIVATE_ACK_VARIABLE] === 'true',
    })
    if (config.allowPrivate) {
      console.warn(
        '[ical-proxy] WARNING: private addresses are allowed (NUXT_ICAL_PROXY_ALLOW_PRIVATE): ' +
          'the SSRF guard is OFF. For tests only.',
      )
    }
    const policy = createAddressPolicy({ allowPrivate: config.allowPrivate })
    runtime = { proxy: createIcalProxy({ config, policy }), policy }
  }
  return runtime
}

export function getIcalProxy(): IcalProxy {
  return getRuntime().proxy
}

export function getIcalPolicy(): AddressPolicy {
  return getRuntime().policy
}

/** The 502 of the data endpoint: the browser learns why, never the URL. Others pass unchanged. */
export function toGatewayError(error: unknown): unknown {
  if (!(error instanceof IcalFetchError)) return error
  return createError({
    statusCode: 502,
    statusMessage: 'Bad Gateway',
    data: { reason: error.reason },
  })
}
