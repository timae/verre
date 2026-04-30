export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'

export interface Badge {
  id: string
  name: string
  description: string
  icon: string
  category: string
  rarity: Rarity
  xp_reward: number
}

export interface UserStats {
  totalRatings: number
  totalSessions: number
  sessionsHosted: number
  fiveStarCount: number
  oneStarCount: number
  notesWritten: number         // ratings with notes
  photosAdded: number          // wines with image_url
  bookmarkCount: number
  hofEntries: number
  redCount: number
  whiteCount: number
  sparkCount: number
  roseCount: number
  nonalcCount: number
  uniqueStyles: number         // distinct style values
  uniqueGrapes: number         // distinct grape values
  avgScore: number
  avgFlavorTannin: number
  avgFlavorAcid: number
  avgFlavorOak: number
  avgFlavorFloral: number
  avgFlavorFruit: number       // avg of citrus+stone+tropical+red_fruit+dark_fruit
  avgFlavorEarth: number
  maxNoteLength: number
  sessionParticipants: number  // max participants in a single session
  aiScansUsed: number          // stored in redis, approximated as 0 for now
  daysSinceFirst: number       // days since first rating
  consecutiveMonths: number    // months with at least one rating
}

export const ALL_BADGES: Badge[] = [
  // ── FIRST STEPS ────────────────────────────────────────────
  { id: 'first_pour', name: 'First Pour', description: 'Rate your very first wine. Every legend starts somewhere.', icon: '🍷', category: 'first_steps', rarity: 'common', xp_reward: 25 },
  { id: 'first_session', name: 'Open the Table', description: 'Join your first tasting session.', icon: '🪑', category: 'first_steps', rarity: 'common', xp_reward: 25 },
  { id: 'first_host', name: 'The Host', description: 'Create and host your first tasting session.', icon: '🎩', category: 'first_steps', rarity: 'common', xp_reward: 50 },
  { id: 'first_5star', name: 'Perfect Taste', description: 'Award your first ever 5-star rating.', icon: '⭐', category: 'first_steps', rarity: 'common', xp_reward: 30 },
  { id: 'first_notes', name: 'The Wordsmith', description: 'Write your first tasting note.', icon: '📝', category: 'first_steps', rarity: 'common', xp_reward: 20 },
  { id: 'first_bookmark', name: 'Saved for Later', description: 'Bookmark your first wine.', icon: '🔖', category: 'first_steps', rarity: 'common', xp_reward: 15 },
  { id: 'first_photo', name: 'Shoot the Label', description: 'Add a bottle photo to a wine.', icon: '📷', category: 'first_steps', rarity: 'common', xp_reward: 20 },
  { id: 'first_hof', name: 'Hall Bound', description: 'Get a wine into the Hall of Fame.', icon: '🏛️', category: 'first_steps', rarity: 'uncommon', xp_reward: 75 },

  // ── QUANTITY ────────────────────────────────────────────────
  { id: 'rated_10', name: 'Getting Warmed Up', description: 'Rate 10 wines. The palate is awakening.', icon: '🌡️', category: 'quantity', rarity: 'common', xp_reward: 40 },
  { id: 'rated_25', name: 'Quarter Century', description: 'Rate 25 wines. You\'re developing a serious habit.', icon: '🥈', category: 'quantity', rarity: 'common', xp_reward: 60 },
  { id: 'rated_50', name: 'Half a Hundred', description: 'Rate 50 wines. Your opinion carries weight.', icon: '🎯', category: 'quantity', rarity: 'uncommon', xp_reward: 100 },
  { id: 'rated_100', name: 'The Hundred', description: '100 wines rated. You\'re not messing around.', icon: '💯', category: 'quantity', rarity: 'uncommon', xp_reward: 150 },
  { id: 'rated_250', name: 'Quarter Millennial', description: '250 wines. At this point it\'s a lifestyle.', icon: '🏆', category: 'quantity', rarity: 'rare', xp_reward: 250 },
  { id: 'rated_500', name: 'The Five Hundred', description: '500 ratings. Your cellar journal rivals a sommelier\'s.', icon: '🍾', category: 'quantity', rarity: 'epic', xp_reward: 400 },
  { id: 'rated_1000', name: 'Thousand Oaks', description: '1000 ratings. You are the algorithm.', icon: '🌳', category: 'quantity', rarity: 'legendary', xp_reward: 750 },
  { id: 'sessions_5', name: 'Social Animal', description: 'Participate in 5 tasting sessions.', icon: '🦁', category: 'quantity', rarity: 'common', xp_reward: 50 },
  { id: 'sessions_10', name: 'Table Regular', description: 'Participate in 10 tasting sessions.', icon: '🪑', category: 'quantity', rarity: 'uncommon', xp_reward: 100 },
  { id: 'sessions_25', name: 'The Connoisseur Circuit', description: 'Participate in 25 sessions. The table knows your face.', icon: '🎭', category: 'quantity', rarity: 'rare', xp_reward: 200 },
  { id: 'hosted_5', name: 'Host with the Most', description: 'Host 5 tasting sessions.', icon: '🏠', category: 'quantity', rarity: 'uncommon', xp_reward: 100 },
  { id: 'hosted_10', name: 'Master of Ceremonies', description: 'Host 10 sessions. You set the stage.', icon: '🎙️', category: 'quantity', rarity: 'rare', xp_reward: 200 },
  { id: 'bookmarks_20', name: 'The Collector', description: 'Save 20 wines to your collection.', icon: '📚', category: 'quantity', rarity: 'uncommon', xp_reward: 75 },
  { id: 'bookmarks_50', name: 'Cellar Master', description: 'Save 50 wines. You\'re curating something special.', icon: '🗄️', category: 'quantity', rarity: 'rare', xp_reward: 150 },

  // ── WINE TYPES ──────────────────────────────────────────────
  { id: 'type_red_10', name: 'Red-Handed', description: 'Rate 10 red wines. Tannin is your middle name.', icon: '🍷', category: 'types', rarity: 'common', xp_reward: 40 },
  { id: 'type_white_10', name: 'White Collar', description: 'Rate 10 white wines. Crisp and collected.', icon: '🥂', category: 'types', rarity: 'common', xp_reward: 40 },
  { id: 'type_spark_10', name: 'Bubbles & Troubles', description: 'Rate 10 sparkling wines. Effervescent personality detected.', icon: '🍾', category: 'types', rarity: 'common', xp_reward: 40 },
  { id: 'type_rose_10', name: 'Rosé All Day', description: 'Rate 10 rosés. No shame, only gains.', icon: '🌸', category: 'types', rarity: 'common', xp_reward: 40 },
  { id: 'type_nonalc_5', name: 'Beyond the Vine', description: 'Rate 5 non-alcoholic wines. Palate without prejudice.', icon: '🌿', category: 'types', rarity: 'uncommon', xp_reward: 60 },
  { id: 'type_all', name: 'The Full Spectrum', description: 'Rate at least one of every wine type. No boundaries.', icon: '🌈', category: 'types', rarity: 'uncommon', xp_reward: 100 },
  { id: 'type_red_50', name: 'Red Obsessed', description: '50 red wines. The dark side has you.', icon: '❤️', category: 'types', rarity: 'rare', xp_reward: 150 },
  { id: 'type_spark_25', name: 'Champagne Problems', description: '25 sparkling wines. Celebrations on demand.', icon: '✨', category: 'types', rarity: 'uncommon', xp_reward: 100 },
  { id: 'unique_grapes_10', name: 'Grape Explorer', description: 'Rate wines from 10 different grape varieties.', icon: '🔭', category: 'types', rarity: 'uncommon', xp_reward: 100 },
  { id: 'unique_grapes_25', name: 'Ampelographer', description: '25 distinct grape varieties. You might as well write a textbook.', icon: '🧬', category: 'types', rarity: 'rare', xp_reward: 200 },
  { id: 'unique_styles_8', name: 'Style Icon', description: 'Rate wines across 8 different styles.', icon: '💅', category: 'types', rarity: 'uncommon', xp_reward: 80 },

  // ── SCORING ─────────────────────────────────────────────────
  { id: 'perfect_5', name: 'Five of Them', description: 'Give out 5 perfect 5-star ratings.', icon: '🌟', category: 'scoring', rarity: 'common', xp_reward: 50 },
  { id: 'perfect_20', name: 'Standards Are High', description: '20 five-star ratings. You know what you like.', icon: '⭐', category: 'scoring', rarity: 'uncommon', xp_reward: 100 },
  { id: 'perfect_50', name: 'Generous Soul', description: '50 wines worthy of perfection? Incredible.', icon: '💫', category: 'scoring', rarity: 'rare', xp_reward: 200 },
  { id: 'harsh_critic', name: 'Harsh Critic', description: 'Give a 1-star rating. Not everything deserves love.', icon: '💀', category: 'scoring', rarity: 'common', xp_reward: 20 },
  { id: 'hof_3', name: 'Triple Crown', description: 'Get 3 wines into the Hall of Fame.', icon: '👑', category: 'scoring', rarity: 'rare', xp_reward: 200 },
  { id: 'hof_10', name: 'Hall of Fame Legend', description: '10 wines in the Hall of Fame. You have exceptional taste.', icon: '🏆', category: 'scoring', rarity: 'legendary', xp_reward: 500 },
  { id: 'high_avg', name: 'Glass Half Full', description: 'Maintain an average score above 4.0 across 20+ ratings.', icon: '😊', category: 'scoring', rarity: 'uncommon', xp_reward: 100 },

  // ── FLAVOUR FANATICS ─────────────────────────────────────────
  { id: 'tannic_titan', name: 'Tannic Titan', description: 'Consistently rate tannins above 3 in 15+ red wines. Your gums are iron.', icon: '💪', category: 'flavour', rarity: 'uncommon', xp_reward: 80 },
  { id: 'acid_freak', name: 'Acid Freak', description: 'Consistently score high acidity in 15+ wines. Lemon battery activated.', icon: '⚡', category: 'flavour', rarity: 'uncommon', xp_reward: 80 },
  { id: 'oak_addict', name: 'Oak Addict', description: 'High oak scores across 15+ wines. You smell barrels in your sleep.', icon: '🪵', category: 'flavour', rarity: 'uncommon', xp_reward: 80 },
  { id: 'floral_fanatic', name: 'Floral Fanatic', description: 'High floral notes in 15+ wines. A walking garden.', icon: '🌸', category: 'flavour', rarity: 'uncommon', xp_reward: 80 },
  { id: 'fruit_bomb', name: 'Fruit Bomb Aficionado', description: 'Consistently high fruit scores across 20 wines. Jam jar energy.', icon: '🍓', category: 'flavour', rarity: 'uncommon', xp_reward: 80 },
  { id: 'mineral_hunter', name: 'Mineral Hunter', description: 'Seeking minerals in 10+ whites. Petrichor is your perfume.', icon: '🪨', category: 'flavour', rarity: 'rare', xp_reward: 120 },
  { id: 'earth_mover', name: 'Earth Mover', description: 'High earth scores across 15+ wines. Terroir is everything.', icon: '🌍', category: 'flavour', rarity: 'uncommon', xp_reward: 80 },

  // ── SOCIAL ──────────────────────────────────────────────────
  { id: 'big_table', name: 'The Big Table', description: 'Participate in a session with 5 or more people. The more the merrier.', icon: '🎊', category: 'social', rarity: 'uncommon', xp_reward: 75 },
  { id: 'crowd_pleaser', name: 'Crowd Pleaser', description: 'Host a session with 8+ participants. You\'re running a vineyard now.', icon: '🎪', category: 'social', rarity: 'rare', xp_reward: 150 },
  { id: 'blind_believer', name: 'Blind Believer', description: 'Participate in a blind tasting session. What you don\'t know can\'t hurt you.', icon: '🙈', category: 'social', rarity: 'uncommon', xp_reward: 100 },

  // ── NOTES & CRAFT ────────────────────────────────────────────
  { id: 'notes_10', name: 'Scribbler', description: 'Write tasting notes for 10 wines. Your opinions matter.', icon: '✍️', category: 'craft', rarity: 'common', xp_reward: 50 },
  { id: 'notes_50', name: 'The Chronicler', description: 'Write tasting notes for 50 wines. You could publish a column.', icon: '📰', category: 'craft', rarity: 'uncommon', xp_reward: 100 },
  { id: 'notes_100', name: 'The Novelist', description: '100 tasting notes. Your prose has vintage.', icon: '📖', category: 'craft', rarity: 'rare', xp_reward: 200 },
  { id: 'long_note', name: 'Purple Prose', description: 'Write a tasting note over 200 characters. Hemingway would be jealous.', icon: '🖋️', category: 'craft', rarity: 'uncommon', xp_reward: 60 },
  { id: 'photos_10', name: 'Label Lover', description: 'Add photos to 10 wines. A picture is worth a thousand sips.', icon: '📸', category: 'craft', rarity: 'common', xp_reward: 50 },
  { id: 'photos_30', name: 'Instagram Sommelier', description: 'Photos on 30 wines. Your feed is impeccable.', icon: '🎨', category: 'craft', rarity: 'uncommon', xp_reward: 100 },

  // ── TIME & LOYALTY ────────────────────────────────────────────
  { id: 'veteran_30', name: 'One Month In', description: 'Active member for 30 days. The habit is forming.', icon: '📅', category: 'loyalty', rarity: 'common', xp_reward: 50 },
  { id: 'veteran_90', name: 'Quarter Year', description: 'Active member for 90 days. Verre is part of the routine.', icon: '🗓️', category: 'loyalty', rarity: 'uncommon', xp_reward: 100 },
  { id: 'veteran_365', name: 'The Vintage', description: 'A full year of tasting. One complete rotation around the sun.', icon: '🌞', category: 'loyalty', rarity: 'rare', xp_reward: 300 },
  { id: 'monthly_3', name: 'Three Months Running', description: 'Rated wines in 3 consecutive months. You\'re consistent.', icon: '📊', category: 'loyalty', rarity: 'uncommon', xp_reward: 100 },
  { id: 'monthly_12', name: 'Year-Round Sipper', description: 'Rated wines every month for a year. Absolute dedication.', icon: '🏅', category: 'loyalty', rarity: 'legendary', xp_reward: 500 },
]

// ── XP & LEVELS ──────────────────────────────────────────────
export const LEVELS = [
  { name: 'Novice',       minXP: 0,    icon: '🌱' },
  { name: 'Enthusiast',   minXP: 150,  icon: '🍇' },
  { name: 'Connoisseur',  minXP: 400,  icon: '🥃' },
  { name: 'Sommelier',    minXP: 800,  icon: '🍷' },
  { name: 'Master',       minXP: 1500, icon: '🏆' },
  { name: 'Grand Master', minXP: 3000, icon: '👑' },
  { name: 'Legend',       minXP: 6000, icon: '⚜️' },
]

export function getLevel(xp: number) {
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (xp >= LEVELS[i].minXP) return { ...LEVELS[i], nextXP: LEVELS[i + 1]?.minXP ?? null, index: i }
  }
  return { ...LEVELS[0], nextXP: LEVELS[1].minXP, index: 0 }
}

export const XP_REWARDS = {
  RATE_WINE: 10,
  WRITE_NOTE: 5,
  HOST_SESSION: 25,
  JOIN_SESSION: 10,
  GIVE_5_STAR: 5,
  ADD_PHOTO: 3,
  BOOKMARK: 2,
}

// ── BADGE EVALUATION ──────────────────────────────────────────
export function evaluateBadges(stats: UserStats, alreadyEarned: Set<string>): string[] {
  const earned: string[] = []
  const check = (id: string, condition: boolean) => {
    if (condition && !alreadyEarned.has(id)) earned.push(id)
  }

  // First steps
  check('first_pour',     stats.totalRatings >= 1)
  check('first_session',  stats.totalSessions >= 1)
  check('first_host',     stats.sessionsHosted >= 1)
  check('first_5star',    stats.fiveStarCount >= 1)
  check('first_notes',    stats.notesWritten >= 1)
  check('first_bookmark', stats.bookmarkCount >= 1)
  check('first_photo',    stats.photosAdded >= 1)
  check('first_hof',      stats.hofEntries >= 1)

  // Quantity
  check('rated_10',    stats.totalRatings >= 10)
  check('rated_25',    stats.totalRatings >= 25)
  check('rated_50',    stats.totalRatings >= 50)
  check('rated_100',   stats.totalRatings >= 100)
  check('rated_250',   stats.totalRatings >= 250)
  check('rated_500',   stats.totalRatings >= 500)
  check('rated_1000',  stats.totalRatings >= 1000)
  check('sessions_5',  stats.totalSessions >= 5)
  check('sessions_10', stats.totalSessions >= 10)
  check('sessions_25', stats.totalSessions >= 25)
  check('hosted_5',    stats.sessionsHosted >= 5)
  check('hosted_10',   stats.sessionsHosted >= 10)
  check('bookmarks_20', stats.bookmarkCount >= 20)
  check('bookmarks_50', stats.bookmarkCount >= 50)

  // Types
  check('type_red_10',   stats.redCount >= 10)
  check('type_white_10', stats.whiteCount >= 10)
  check('type_spark_10', stats.sparkCount >= 10)
  check('type_rose_10',  stats.roseCount >= 10)
  check('type_nonalc_5', stats.nonalcCount >= 5)
  check('type_all',      stats.redCount >= 1 && stats.whiteCount >= 1 && stats.sparkCount >= 1 && stats.roseCount >= 1 && stats.nonalcCount >= 1)
  check('type_red_50',   stats.redCount >= 50)
  check('type_spark_25', stats.sparkCount >= 25)
  check('unique_grapes_10', stats.uniqueGrapes >= 10)
  check('unique_grapes_25', stats.uniqueGrapes >= 25)
  check('unique_styles_8', stats.uniqueStyles >= 8)

  // Scoring
  check('perfect_5',   stats.fiveStarCount >= 5)
  check('perfect_20',  stats.fiveStarCount >= 20)
  check('perfect_50',  stats.fiveStarCount >= 50)
  check('harsh_critic', stats.oneStarCount >= 1)
  check('hof_3',       stats.hofEntries >= 3)
  check('hof_10',      stats.hofEntries >= 10)
  check('high_avg',    stats.totalRatings >= 20 && stats.avgScore >= 4.0)

  // Flavour
  check('tannic_titan',    stats.avgFlavorTannin >= 3.0 && stats.redCount >= 15)
  check('acid_freak',      stats.avgFlavorAcid >= 3.0 && stats.totalRatings >= 15)
  check('oak_addict',      stats.avgFlavorOak >= 3.0 && stats.totalRatings >= 15)
  check('floral_fanatic',  stats.avgFlavorFloral >= 3.0 && stats.totalRatings >= 15)
  check('fruit_bomb',      stats.avgFlavorFruit >= 3.0 && stats.totalRatings >= 20)
  check('mineral_hunter',  stats.uniqueStyles >= 5 && stats.whiteCount >= 10)
  check('earth_mover',     stats.avgFlavorEarth >= 2.5 && stats.totalRatings >= 15)

  // Social
  check('big_table',    stats.sessionParticipants >= 5)
  check('crowd_pleaser', stats.sessionParticipants >= 8)
  check('blind_believer', false) // requires blind session flag — future

  // Craft
  check('notes_10',   stats.notesWritten >= 10)
  check('notes_50',   stats.notesWritten >= 50)
  check('notes_100',  stats.notesWritten >= 100)
  check('long_note',  stats.maxNoteLength >= 200)
  check('photos_10',  stats.photosAdded >= 10)
  check('photos_30',  stats.photosAdded >= 30)

  // Loyalty
  check('veteran_30',  stats.daysSinceFirst >= 30)
  check('veteran_90',  stats.daysSinceFirst >= 90)
  check('veteran_365', stats.daysSinceFirst >= 365)
  check('monthly_3',   stats.consecutiveMonths >= 3)
  check('monthly_12',  stats.consecutiveMonths >= 12)

  return earned
}

export const BADGE_MAP = Object.fromEntries(ALL_BADGES.map(b => [b.id, b]))
export const RARITY_ORDER: Rarity[] = ['common','uncommon','rare','epic','legendary']
export const RARITY_COLOR: Record<Rarity, string> = {
  common:    '#8A8A7A',
  uncommon:  '#4B9B4B',
  rare:      '#4A6FBF',
  epic:      '#9B4BBF',
  legendary: '#C8963C',
}
