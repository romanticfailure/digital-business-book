import type { Contact } from './contacts'
import { categoryOf } from './contacts'

function download(filename: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const link = document.createElement('a')

  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()

  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// A cell starting with = + - @ would run as a formula in Excel: neutralize it.
function csvCell(value: string | null | undefined): string {
  let text = (value ?? '').replace(/\r?\n/g, ' ')

  // Phone numbers like +49 170 123 are plain text, not formulas
  if (/^[=+\-@]/.test(text) && !/^\+[\d\s()/.-]+$/.test(text)) text = `'${text}`

  return `"${text.replace(/"/g, '""')}"`
}

export function contactsToCsv(contacts: Contact[]): string {
  const header = [
    'Name', 'Company', 'Job title', 'Topic', 'Phone', 'Second phone', 'Email',
    'Address', 'Met at', 'Follow-up date', 'Favorite', 'Notes', 'Added',
  ]

  const rows = contacts.map(c => [
    c.full_name, c.company, c.job_title, categoryOf(c), c.phone, c.phone_secondary,
    c.email, c.address, c.met_at, c.follow_up_date, c.is_favorite ? 'yes' : '',
    c.notes, c.created_at?.slice(0, 10),
  ])

  return [header, ...rows]
    .map(row => row.map(cell => csvCell(cell)).join(','))
    .join('\r\n')
}

function vEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
}

export function contactToVCard(c: Contact): string {
  const parts = c.full_name.trim().split(/\s+/)
  const last = parts.length > 1 ? parts[parts.length - 1] : ''
  const first = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0] || ''
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${vEscape(last)};${vEscape(first)};;;`,
    `FN:${vEscape(c.full_name)}`,
  ]

  if (c.company) lines.push(`ORG:${vEscape(c.company)}`)
  if (c.job_title) lines.push(`TITLE:${vEscape(c.job_title)}`)
  if (c.phone) lines.push(`TEL;TYPE=WORK,VOICE:${vEscape(c.phone)}`)
  if (c.phone_secondary) lines.push(`TEL;TYPE=CELL:${vEscape(c.phone_secondary)}`)
  if (c.email) lines.push(`EMAIL;TYPE=INTERNET:${vEscape(c.email)}`)
  if (c.address) lines.push(`ADR;TYPE=WORK:;;${vEscape(c.address)};;;;`)
  if (c.category) lines.push(`CATEGORIES:${vEscape(c.category)}`)
  if (c.notes) lines.push(`NOTE:${vEscape(c.notes)}`)

  lines.push('END:VCARD')

  return lines.join('\r\n')
}

function safeName(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'contact'
}

export function downloadCsv(contacts: Contact[]) {
  // BOM so Excel reads umlauts correctly
  download('contacts.csv', '\ufeff' + contactsToCsv(contacts), 'text/csv;charset=utf-8')
}

export function downloadVCard(contact: Contact) {
  download(`${safeName(contact.full_name)}.vcf`, contactToVCard(contact) + '\r\n', 'text/vcard;charset=utf-8')
}

export function downloadAllVCards(contacts: Contact[]) {
  download(
    'contacts.vcf',
    contacts.map(contactToVCard).join('\r\n') + '\r\n',
    'text/vcard;charset=utf-8'
  )
}
