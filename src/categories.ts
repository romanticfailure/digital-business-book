// Topics a contact can belong to. People can also type their own topic.
export const UNCATEGORIZED = 'Uncategorized'

export const DEFAULT_CATEGORIES: readonly string[] = [
  'Doors',
  'Windows',
  'Hardware & fittings',
  'Glass & glazing',
  'Shutters & sun protection',
  'Installation & craftsmen',
  'Building materials',
  'Suppliers',
  'Customers',
  'Work',
  'Sport',
  'Finance & legal',
  'IT & marketing',
  'Transport & logistics',
  'Services',
  'Friends & family',
  'Other',
]

// Typed text is matched to an existing topic ignoring upper/lower case,
// so "doors" and "Doors" do not become two different topics.
export function normalizeCategory(input: string, known: readonly string[]): string {
  const cleaned = input.trim().replace(/^\*+/, '').replace(/\s+/g, ' ')

  if (!cleaned) return ''

  const lower = cleaned.toLowerCase()

  if (lower === UNCATEGORIZED.toLowerCase()) return ''

  return known.find(name => name.toLowerCase() === lower) ?? cleaned
}

// Keyword rules used to suggest a topic from the text of a card.
// German and English words. Umlauts are written as unicode escapes on purpose,
// so this file stays plain ASCII and cannot be damaged by a wrong encoding.
// Order matters: when two topics score the same, the earlier one wins.
const RULES: { category: string; pattern: RegExp }[] = [
  {
    category: 'Doors',
    pattern:
      /\b\w*(?:t\u00fcr|tuer)(?:en?)?\b|\bdoors?\b|\bgaragentor\w*|\bsektionaltor\w*|\brolltor\w*/gi,
  },
  {
    category: 'Windows',
    pattern: /\b\w*fenster\w*|\bwindows?\b/gi,
  },
  {
    category: 'Hardware & fittings',
    pattern:
      /\b\w*beschl(?:\u00e4|ae)ge?\b|\b\w*beschlag\w*|\bfittings?\b|\bhardware\b|\bgriff\w*|\bsch(?:\u00f6|oe)sser\b|\bschloss\w*|\bscharnier\w*|\bzylinder\w*|\bsiegenia\b|\broto\b|\bmaco\b|\bwinkhaus\b|\bgretsch\w*|\bassa\s*abloy\b|\bdormakaba\b/gi,
  },
  {
    category: 'Glass & glazing',
    pattern: /\b\w*glas\w*|\bglazing\b|\bglass\b/gi,
  },
  {
    category: 'Shutters & sun protection',
    pattern:
      /\brol{2,3}(?:aden|\u00e4den|aeden)\w*|\braffstore\w*|\bjalousie\w*|\bsonnenschutz\w*|\bmarkise\w*|\binsektenschutz\w*|\bshutters?\b|\bblinds\b/gi,
  },
  {
    category: 'Installation & craftsmen',
    pattern:
      /\bmontage\w*|\bmonteur\w*|\bhandwerk\w*|\binstallateur\w*|\bschreiner\w*|\btischler\w*|\bzimmerei\w*|\bzimmermann\b|\btrockenbau\w*|\bdachdecker\w*|\belektriker\w*|\bsanit(?:\u00e4|ae)r\w*|\bheizung\w*|\binstaller\b|\binstallation\w*|\bcarpent\w*|\bjoiner\w*/gi,
  },
  {
    category: 'Building materials',
    pattern:
      /\bbaustoff\w*|\bbaumarkt\w*|\bholzhandel\w*|\bkunststoffprofil\w*|\baluminium\w*|\bpvc\b|\bbuilding\s+materials?\b|\blumber\b|\btimber\b/gi,
  },
  {
    category: 'Sport',
    pattern:
      /\bsport\w*|\bfitness\w*|\bgym\b|\bfu(?:\u00df|ss)ball\w*|\btennis\b|\bgolf\b|\byoga\b|\bmarathon\w*|\btraining\w*|\btrainer\w*|\bbike\w*|\bschwimm\w*|\bhandball\b|\bbasketball\b|\bvolleyball\b/gi,
  },
  {
    category: 'Finance & legal',
    pattern:
      /\bbank\b|\bsparkasse\w*|\bvolksbank\w*|\bversicherung\w*|\bsteuer\w*|\bbuchhalt\w*|\bfinanz\w*|\brechtsanw\w*|\bkanzlei\w*|\bnotar\w*|\banwalt\w*|\binsurance\b|\baccountan\w*|\btreuhand\w*|\bwirtschaftspr\w*/gi,
  },
  {
    category: 'IT & marketing',
    pattern:
      /\bsoftware\b|\bwebdesign\w*|\bweb\s+design\w*|\bmarketing\w*|\bwerbe\w*|\bwerbung\b|\bagentur\b|\bagency\b|\bseo\b|\bcloud\b|\bdigital\w*|\bprogrammier\w*|\bit-\w+|\bit\s+services?\b/gi,
  },
  {
    category: 'Transport & logistics',
    pattern:
      /\blogistik\w*|\bspedition\w*|\btransport\w*|\bversand\w*|\bfreight\b|\bshipping\b|\bkurier\w*|\bdelivery\b|\bfuhrpark\w*/gi,
  },
]

// Returns the best matching topic for a text, or '' when nothing matches.
export function suggestCategory(text: string): string {
  let best = ''
  let bestScore = 0

  for (const rule of RULES) {
    const score = (text.match(rule.pattern) ?? []).length

    if (score > bestScore) {
      best = rule.category
      bestScore = score
    }
  }

  return best
}
