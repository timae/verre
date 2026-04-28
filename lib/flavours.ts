export type FlItem = { k: string; l: string; c: string }

export const FL_RED: FlItem[] = [
  { k: 'dark_fruit', l: 'Dark Fruit',  c: '#9C27B0' },
  { k: 'red_fruit',  l: 'Red Fruit',   c: '#C0392B' },
  { k: 'earth',      l: 'Earth',       c: '#795548' },
  { k: 'spice',      l: 'Spice',       c: '#E67E22' },
  { k: 'oak',        l: 'Oak',         c: '#C08858' },
  { k: 'tannin',     l: 'Tannins',     c: '#886048' },
  { k: 'body',       l: 'Body',        c: '#9870C0' },
  { k: 'acid',       l: 'Acidity',     c: '#60A8E0' },
  { k: 'herbal',     l: 'Herbal',      c: '#58B070' },
  { k: 'floral',     l: 'Floral',      c: '#E8809A' },
]

export const FL_WHITE: FlItem[] = [
  { k: 'citrus',   l: 'Citrus',      c: '#E8C040' },
  { k: 'stone',    l: 'Stone Fruit', c: '#E89040' },
  { k: 'tropical', l: 'Tropical',    c: '#58C870' },
  { k: 'floral',   l: 'Floral',      c: '#E8809A' },
  { k: 'herbal',   l: 'Herbal',      c: '#58B070' },
  { k: 'mineral',  l: 'Mineral',     c: '#90A4AE' },
  { k: 'oak',      l: 'Oak',         c: '#C08858' },
  { k: 'body',     l: 'Body',        c: '#9870C0' },
  { k: 'acid',     l: 'Acidity',     c: '#60A8E0' },
  { k: 'sweet',    l: 'Sweet',       c: '#E880B8' },
]

export const FL_SPARK: FlItem[] = [
  { k: 'floral_herb',  l: 'Floral/Herb', c: '#8BC34A' },
  { k: 'citrus',       l: 'Citrus',      c: '#CDDC39' },
  { k: 'tree_fruit',   l: 'Tree Fruit',  c: '#FFC107' },
  { k: 'red_fruit',    l: 'Red Fruit',   c: '#E53935' },
  { k: 'dried_fruit',  l: 'Dried Fruit', c: '#8D6E63' },
  { k: 'earth',        l: 'Earth',       c: '#9E9E9E' },
  { k: 'creamy',       l: 'Creamy',      c: '#D7CCC8' },
  { k: 'oak',          l: 'Oak',         c: '#C08858' },
  { k: 'nutty',        l: 'Nutty/Toast', c: '#D4A017' },
  { k: 'acid',         l: 'Acidity',     c: '#60A8E0' },
]

export const FL_ROSE: FlItem[] = [
  { k: 'red_fruit', l: 'Red Fruit',   c: '#C0392B' },
  { k: 'citrus',    l: 'Citrus',      c: '#E8C040' },
  { k: 'floral',    l: 'Floral',      c: '#E8809A' },
  { k: 'stone',     l: 'Stone Fruit', c: '#E89040' },
  { k: 'herbal',    l: 'Herbal',      c: '#58B070' },
  { k: 'mineral',   l: 'Mineral',     c: '#90A4AE' },
  { k: 'body',      l: 'Body',        c: '#9870C0' },
  { k: 'acid',      l: 'Acidity',     c: '#60A8E0' },
  { k: 'sweet',     l: 'Sweet',       c: '#E880B8' },
  { k: 'tropical',  l: 'Tropical',    c: '#58C870' },
]

// Legacy generic FL (for old ratings & profile aggregation)
export const FL: FlItem[] = [
  { k: 'floral',   l: 'Floral',   c: '#E8809A' },
  { k: 'citrus',   l: 'Citrus',   c: '#E8C040' },
  { k: 'stone',    l: 'Stone',    c: '#E89040' },
  { k: 'tropical', l: 'Tropical', c: '#58C870' },
  { k: 'herbal',   l: 'Herbal',   c: '#58B070' },
  { k: 'oak',      l: 'Oak',      c: '#C08858' },
  { k: 'body',     l: 'Body',     c: '#9870C0' },
  { k: 'tannin',   l: 'Tannins',  c: '#886048' },
  { k: 'acid',     l: 'Acidity',  c: '#60A8E0' },
  { k: 'sweet',    l: 'Sweet',    c: '#E880B8' },
]

export type WineType = 'red' | 'white' | 'spark' | 'rose' | 'nonalc'

export function getFL(type: WineType | string): FlItem[] {
  if (type === 'red')   return FL_RED
  if (type === 'white') return FL_WHITE
  if (type === 'spark') return FL_SPARK
  if (type === 'rose')  return FL_ROSE
  return FL_WHITE
}

export function detectFL(flavors: Record<string, number>): FlItem[] {
  const keys = Object.keys(flavors)
  if (keys.includes('dark_fruit')) return FL_RED
  if (keys.includes('floral_herb') || keys.includes('tree_fruit')) return FL_SPARK
  if (keys.includes('mineral') && keys.includes('stone') && !keys.includes('dark_fruit')) {
    if (keys.includes('red_fruit')) return FL_ROSE
    return FL_WHITE
  }
  return FL
}
