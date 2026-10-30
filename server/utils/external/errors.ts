import { ApiError, type FieldError } from '../api/errors'

// The 400 answers of the external-account API that carry a machine-readable `data.code` next to the
// usual `data.fields`, so the form can tell "fix this field" from "this server cannot do that".
// (`limit_reached` and `duplicate` are 409s: `conflict()` in server/utils/api/errors.ts.)

export type ExternalErrorCode =
  'logins_disabled' | 'credential_required' | 'host_not_allowed' | 'invalid_url'

export function externalError(
  code: ExternalErrorCode,
  message: string,
  fields: FieldError[] = [],
): ApiError {
  return new ApiError(400, message, { code, fields })
}

/** No NUXT_EXTERNAL_SEAL_KEY: accounts with a login cannot be sealed. */
export function loginsDisabled(): ApiError {
  return externalError(
    'logins_disabled',
    'Accounts with a login are not available: the administrator has not set up the key for them',
  )
}

/** A change that voids the old seal came without the password for a new one. */
export function credentialRequired(): ApiError {
  return externalError('credential_required', 'The password is needed for this change', [
    { field: 'password', message: 'is required for this change' },
  ])
}
