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
export {
  WHEEL_MAX,
  HUB_FRACTION,
  GAP_DEG,
  RADIUS_FRACTION,
  LABEL_OFFSET,
  STAR_PATH,
  MIN_BAND_THICKNESS,
  AVG_ARC_FRACTION,
  wheelEase,
  wheelRadius,
  flavourWheelGeometry,
  comparisonWheelGeometry,
  radarOverlayGeometry,
  radarSeriesPoints,
  starFills,
  type WheelWedge,
  type WheelLabel,
  type WheelLabelAnchor,
  type WheelGeometry,
  type ComparisonWedge,
  type ComparisonWheelGeometry,
  type RadarSpoke,
  type RadarOverlayGeometry,
} from './scoringGeometry'
export {
  SCORE_MAX,
  SCORE_STEP,
  FLAVOUR_MAX,
  FLAVOUR_CLEAR_FRACTION,
  snapScore,
  scoreFromFraction,
  stepScore,
  flavourLevelFromFraction,
  toggleFlavourLevel,
} from './scoringInput'
export { formatScore } from './formatScore'
export { decimalToNumber } from './decimal'
export {
  validateDisplayName,
  stripDisambiguationEmoji,
} from './displayName'
export {
  COUNTRIES,
  COUNTRY_CODES,
  countryName,
  type Country,
} from './countries'
export {
  resolveAxes,
  perRatingAxes,
  fillFlavourZeros,
  type StructureAxis,
  type WineStyle,
} from './structureAxes'
export {
  aggregateFlavourAxes,
  consensusFromRatings,
  groupScoreAverage,
  type AxisAggregate,
  type FlavourAggregate,
  type ConsensusKey,
} from './compareAggregate'
export {
  AROMA_MODIFIERS,
  AROMA_FAMILIES,
  AROMA_SELECTION_CAP,
  getAromaModifier,
  getAromaLeaf,
  getAromaNode,
  aromaTierPath,
  aromaAllowedModifiers,
  aromaModifierDisplay,
  isValidAromaSelection,
  gateAromaSelections,
  type AromaModifier,
  type AromaLeaf,
  type AromaSubfamily,
  type AromaFamily,
  type AromaSelection,
  type AromaNode,
  type AromaTierPath,
} from './aroma/taxonomy'
