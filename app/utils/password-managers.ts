// Fields that are no login: the attributes with which the common password managers leave a field
// (or a form) alone. They do not honour `autocomplete="off"`, and a field that asks for a name or an
// e-mail address next to a "Name" field looks to them like a sign-up form, so they offer to fill it.
// 1Password, LastPass, Bitwarden, Dashlane and Proton Pass, each by its own attribute. Bitwarden
// honours `data-bwignore` only for people who switched that on in its settings; it never fills a
// field of `type="search"`, which is what keeps it off a field that searches a list.
export const NOT_FOR_PASSWORD_MANAGERS = {
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
  'data-protonpass-ignore': 'true',
} as const
