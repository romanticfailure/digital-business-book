import { UNCATEGORIZED } from './categories'

// The extra fields are optional on purpose: until the one-time database update
// (supabase/contact-extras.sql) is run, rows come back without them.
export type Contact = {
  id: string
  user_id: string
  full_name: string
  company: string | null
  job_title: string | null
  phone: string | null
  email: string | null
  address: string | null
  notes: string | null
  image_url: string | null
  created_at: string
  category?: string | null
  is_favorite?: boolean | null
  phone_secondary?: string | null
  met_at?: string | null
  follow_up_date?: string | null
}

export type ContactForm = {
  full_name: string
  company: string
  job_title: string
  phone: string
  email: string
  address: string
  notes: string
  category: string
  phone_secondary: string
  met_at: string
  follow_up_date: string
}

export const emptyForm: ContactForm = {
  full_name: '',
  company: '',
  job_title: '',
  phone: '',
  email: '',
  address: '',
  notes: '',
  category: '',
  phone_secondary: '',
  met_at: '',
  follow_up_date: '',
}

// Columns that only exist after the database update.
export const EXTRA_COLUMNS = [
  'category',
  'is_favorite',
  'phone_secondary',
  'met_at',
  'follow_up_date',
] as const

export type SortMode = 'newest' | 'oldest' | 'name' | 'company'

export const SORT_LABELS: Record<SortMode, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  name: 'Name A-Z',
  company: 'Company A-Z',
}

export function isSortMode(value: unknown): value is SortMode {
  return typeof value === 'string' && value in SORT_LABELS
}

export function categoryOf(contact: Contact): string {
  return contact.category?.trim() || UNCATEGORIZED
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

// Favorites always stay on top, then the chosen order applies.
export function sortContacts(list: Contact[], mode: SortMode): Contact[] {
  const copy = [...list]

  copy.sort((a, b) => {
    const favorite = Number(!!b.is_favorite) - Number(!!a.is_favorite)

    if (favorite !== 0) return favorite

    switch (mode) {
      case 'oldest':
        return a.created_at.localeCompare(b.created_at)
      case 'name':
        return collator.compare(a.full_name, b.full_name)
      case 'company': {
        // Contacts without a company go last
        if (!a.company !== !b.company) return a.company ? -1 : 1

        return (
          collator.compare(a.company || '', b.company || '') ||
          collator.compare(a.full_name, b.full_name)
        )
      }
      default:
        return b.created_at.localeCompare(a.created_at)
    }
  })

  return copy
}

export type ContactGroup = { name: string; items: Contact[] }

// Groups by topic, biggest-first order is not used: names A-Z, uncategorized last.
export function groupByCategory(list: Contact[]): ContactGroup[] {
  const map = new Map<string, Contact[]>()

  for (const contact of list) {
    const name = categoryOf(contact)

    map.set(name, [...(map.get(name) ?? []), contact])
  }

  return [...map.entries()]
    .sort(([a], [b]) => {
      if (a === UNCATEGORIZED) return 1
      if (b === UNCATEGORIZED) return -1

      return collator.compare(a, b)
    })
    .map(([name, items]) => ({ name, items }))
}

export function countByCategory(list: Contact[]): { name: string; count: number }[] {
  return groupByCategory(list).map(group => ({
    name: group.name,
    count: group.items.length,
  }))
}

export type FollowUpState = 'overdue' | 'today' | 'soon' | 'later'

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

// date is "YYYY-MM-DD" as stored by a date column.
export function followUpState(date: string | null | undefined, now = new Date()): FollowUpState | null {
  if (!date) return null

  const [y, m, d] = date.split('-').map(Number)

  if (!y || !m || !d) return null

  const days = Math.round((new Date(y, m - 1, d).getTime() - startOfDay(now)) / 86400000)

  if (days < 0) return 'overdue'
  if (days === 0) return 'today'
  if (days <= 7) return 'soon'

  return 'later'
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return ''

  // A bare date is read as local time, so it never shifts by a day
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const date = parts ? new Date(+parts[1], +parts[2] - 1, +parts[3]) : new Date(value)

  if (Number.isNaN(date.getTime())) return ''

  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function digits(value: string | null | undefined): string {
  return (value || '').replace(/\D/g, '')
}

// Finds an existing contact that looks like the same person.
export function findDuplicate(
  contacts: Contact[],
  form: ContactForm,
  ignoreId: string | null
): Contact | undefined {
  const email = form.email.trim().toLowerCase()
  const phone = digits(form.phone)
  const name = form.full_name.trim().toLowerCase()
  const company = form.company.trim().toLowerCase()

  return contacts.find(contact => {
    if (contact.id === ignoreId) return false

    if (email && contact.email?.trim().toLowerCase() === email) return true
    if (phone.length >= 6 && digits(contact.phone) === phone) return true

    return (
      !!name &&
      contact.full_name.trim().toLowerCase() === name &&
      (contact.company || '').trim().toLowerCase() === company
    )
  })
}

// Text used to guess a topic for a saved contact.
export function contactText(contact: Contact): string {
  return [
    contact.full_name,
    contact.company,
    contact.job_title,
    contact.email,
    contact.address,
    contact.notes,
  ]
    .filter(Boolean)
    .join('\n')
}
