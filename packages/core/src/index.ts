// @verre/core — framework-neutral domain logic shared by the Verre web app
// and native clients. No node:*, no next/*, no @prisma/client, no React, no
// DOM. Server-only carve-outs (genCode, sessionPath/joinPath, validateFlavors,
// displayName.server) deliberately stay in lib/.

export {
  ALPHABET,
  VALID_LENGTHS,
  CANONICAL_LENGTH,
  normalizeCode,
  validateCodeInput,
  formatCode,
  formatCodeInput,
  type CodeValidationResult,
} from './sessionCode'

export { validateScore } from './checkinValidation'
export { formatScore } from './formatScore'
export { decimalToNumber } from './decimal'
export {
  validateDisplayName,
  stripDisambiguationEmoji,
} from './displayName'
