// `/api/external/<id>` and `/api/external/<id>/`: `[...path]` does not match an empty rest. The
// proxy answers both (the path of the target is empty, which it refuses, or just `/`).
export { default } from './[...path]'
