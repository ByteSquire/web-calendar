-- App tokens remember which hash key hashed them (L7, FR-31), so NUXT_TOKEN_HASH_KEYS can hold
-- several keys and the key can be rotated without invalidating the tokens that exist. Every token
-- made before this column was hashed with NUXT_TOKEN_HASH_KEY, which is key version 1.

ALTER TABLE app_tokens ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version > 0);
