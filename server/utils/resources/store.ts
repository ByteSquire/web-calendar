// The one block store of the process. The integration calls `setBlockStore` at startup with the
// store that acts as `_resources`; until then blocks are only logged.
import { createLoggingBlockStore, type BlockStore } from './block'

let current: BlockStore | undefined

export function setBlockStore(store: BlockStore | undefined): void {
  current = store
}

export function getBlockStore(): BlockStore {
  return (current ??= createLoggingBlockStore())
}
