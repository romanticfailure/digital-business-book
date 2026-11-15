
import { useEffect, useRef, useState, type FormEvent, type ChangeEvent, type CSSProperties } from 'react'
import {
  BookOpen, Mail, Lock, ArrowRight, Loader2,
  Search, Plus, LogOut, Pencil, Trash2, X,
  ScanLine, Camera, ImagePlus,
  Star, Download, Phone, Tag, CalendarClock, Sparkles
} from 'lucide-react'
import { recognizeBusinessCard } from './ocr'
import { supabase } from './supabase'
import './App.css'
import './animations.css'
import './features.css'
import RelationMap from './RelationMap'
import { DEFAULT_CATEGORIES, normalizeCategory, suggestCategory } from './categories'
import {
  SORT_LABELS, categoryOf, contactText, countByCategory, emptyForm,
  findDuplicate, followUpState, formatDate, groupByCategory, isSortMode, sortContacts,
  type Contact, type ContactForm, type SortMode
} from './contacts'
import { downloadAllVCards, downloadCsv, downloadVCard } from './exportContacts'

const FILTER_ALL = '__all'
const FILTER_FAVORITES = '__favorites'
const FILTER_FOLLOW_UP = '__follow_up'

function readStored(key: string): string {
  try {
    return window.localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage can be blocked: the choice just is not remembered
  }
}

// The camera option only makes sense on phones and tablets. On a computer the
// browser would just open the file explorer, so we show a message instead.
const canUseCamera =
  typeof navigator !== 'undefined' &&
  (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    // iPadOS reports itself as a Mac, but has a touch screen
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1))

// Note: German letters (umlauts and the sharp s) in the regular expressions
// below are written as unicode escape sequences instead of the literal
// characters, on purpose. That keeps this file plain ASCII, so an editor that
// saves it in the wrong encoding cannot corrupt them.
function extractContactData(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line.length > 1)

  const email =
    text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || ''

  const website =
    lines.find(line => /www\.|https?:\/\//i.test(line)) || ''

  const jobPattern =
    /\b(gesch\u00e4ftsf\u00fchrer(?:in)?|geschaeftsfuehrer(?:in)?|gesch\u00e4ftsleitung|inhaber(?:in)?|ceo|coo|cto|cfo|manager(?:in)?|director|managing director|sales manager|account manager|project manager|marketing manager|vertrieb|verkauf|leiter(?:in)?|abteilungsleiter(?:in)?|entwickler(?:in)?|engineer|consultant|berater(?:in)?|designer(?:in)?|assistant|assistent(?:in)?|sekret\u00e4r(?:in)?|sekretaer(?:in)?|owner|founder|partner|techniker(?:in)?|meister(?:in)?|monteur(?:in)?|handwerker(?:in)?)\b/i

  const job_title = lines.find(line =>
    jobPattern.test(line)
  ) || ''

  const companyPattern =
    /\b(gmbh|gmbh\s*&\s*co\.?\s*kg|ag|ug|haftungsbeschr\u00e4nkt|haftungsbeschraenkt|kg|ohg|gbr|e\.?k\.?|ltd|llc|inc|corp|corporation|company|group|solutions|consulting|services|industrie|technik|bau|logistik|automotive|systems)\b/i

  const excluded =
    /email|e-mail|telefon|phone|mobile|mobil|tel\.?|fax|www\.|https?:|@|kontakt|contact/i

  const companyLine = lines.find(line =>
    companyPattern.test(line) &&
    !excluded.test(line)
  ) || ''

  const addressPattern =
    /\b(strasse|stra\u00dfe|str\.|street|road|avenue|platz|weg|allee|gasse|ring|boulevard|blvd)\b/i

  const addressLine = lines.find(line =>
    addressPattern.test(line) ||
    /\b\d{5}\s+[A-Z\u00c4\u00d6\u00dc]/i.test(line)
  ) || ''

  const phoneCandidates = lines.filter(line =>
    /(?:\+49|0049|0\d{2,})[\s()./-]*\d[\d\s()./-]{4,}/.test(line) ||
    /(?:tel|phone|mobil|mobile|fax)\s*[:.]?/i.test(line)
  )

  const phoneLine =
    phoneCandidates.find(line =>
      /(?:tel|phone|mobil|mobile)/i.test(line)
    ) || phoneCandidates[0] || ''

  const phoneMatch = phoneLine.match(
    /(?:\+49|0049|0)\s*[\d\s()./-]{6,}\d/
  )

  const phone = phoneMatch
    ? phoneMatch[0].replace(/[^\d+]/g, '').replace(/^0049/, '+49')
    : ''

  const cleanLines = lines.filter(line =>
    line.length >= 4 &&
    line.length <= 55 &&
    !excluded.test(line) &&
    !companyPattern.test(line) &&
    !jobPattern.test(line) &&
    !addressPattern.test(line) &&
    !/\d/.test(line) &&
    !/@/.test(line)
  )

  const nameLine =
    cleanLines.find(line => {
      const words = line.split(/\s+/)
      return (
        words.length >= 2 &&
        words.length <= 4 &&
        /^[A-Z\u00c4\u00d6\u00dc][a-z\u00e4\u00f6\u00fc\u00df-]+(?:\s+[A-Z\u00c4\u00d6\u00dc][a-z\u00e4\u00f6\u00fc\u00df-]+)+$/.test(line)
      )
    }) ||
    cleanLines[0] ||
    ''

  let company = companyLine

  if (!company && job_title) {
    const jobIndex = lines.indexOf(job_title)

    const nearby = [
      lines[jobIndex - 1],
      lines[jobIndex + 1],
    ].filter(Boolean)

    company = nearby.find(line =>
      line !== nameLine &&
      line !== addressLine &&
      line !== phoneLine &&
      !excluded.test(line) &&
      !jobPattern.test(line) &&
      !/\d/.test(line) &&
      line.length >= 3 &&
      line.length <= 65
    ) || ''
  }

  return {
    full_name: nameLine,
    company,
    job_title,
    phone,
    email,
    address: addressLine,
    notes: website ? `Website: ${website}` : '',
  }
}

// Rates how much contact information a recognized text holds. The scanner uses
// it to pick the best of several recognition attempts.
function contactSignal(text: string) {
  const data = extractContactData(text)
  const properName = /^[A-Z\u00c4\u00d6\u00dc][a-z\u00e4\u00f6\u00fc\u00df-]+(?:\s+[A-Z\u00c4\u00d6\u00dc][a-z\u00e4\u00f6\u00fc\u00df-]+)+$/.test(data.full_name)

  return (
    (data.email ? 3 : 0) +
    (data.phone ? 2 : 0) +
    (properName ? 2 : data.full_name ? 0.5 : 0) +
    (data.company ? 1 : 0) +
    (data.job_title ? 1 : 0) +
    (data.address ? 1 : 0)
  )
}

function App() {
  const [session, setSession] = useState<any>(null)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  const [contacts, setContacts] = useState<Contact[]>([])
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ContactForm>(emptyForm)
  const [extrasReady, setExtrasReady] = useState(true)
  const [linksReady, setLinksReady] = useState(true)
  const [view, setView] = useState<'book' | 'map'>('book')
  const [activeFilter, setActiveFilter] = useState(FILTER_ALL)
  const [sortMode, setSortMode] = useState<SortMode>(() => {
    const stored = readStored('book-sort')

    return isSortMode(stored) ? stored : 'newest'
  })
  const [groupView, setGroupView] = useState(() => readStored('book-group') !== 'off')
  const [sorting, setSorting] = useState(false)
  const [saving, setSaving] = useState(false)

  const [showScanner, setShowScanner] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scanMessage, setScanMessage] = useState('')
  const [scanProgress, setScanProgress] = useState(0)

  const uploadRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
    })

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, newSession) => {
        setSession(newSession)
      }
    )

    return () => listener.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (session?.user) {
      loadContacts()
    } else {
      setContacts([])
    }
  }, [session])

  async function loadContacts() {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) {
      setMessage(error.message)
      return
    }

    const rows = (data || []) as Contact[]

    // Rows of a database without the update have no topic column at all
    if (rows.length > 0) {
      setExtrasReady('category' in rows[0])
    } else {
      const probe = await supabase.from('contacts').select('category').limit(1)

      setExtrasReady(!probe.error)
    }

    // Same check for the introduced-by column of the relationship map
    if (rows.length > 0) {
      setLinksReady('introduced_by' in rows[0])
    } else {
      const probe = await supabase.from('contacts').select('introduced_by').limit(1)

      setLinksReady(!probe.error)
    }

    setContacts(rows)
  }

  async function handleAuth(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setMessage('')

    try {
      if (mode === 'register') {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: 'https://romanticfailure.github.io/digital-business-book/',
          },
        })

        if (error) throw error

        setMessage(
          data.session
            ? 'Account created!'
            : 'Check your email and confirm your registration.'
        )
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        })

        if (error) throw error
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''

      setMessage(
        /email not confirmed/i.test(reason)
          ? 'Your email is not confirmed yet. Open the confirmation link we sent you, then sign in.'
          : reason || 'Something went wrong'
      )
    } finally {
      setLoading(false)
    }
  }

  function openNewContact() {
    setEditingId(null)
    setForm(emptyForm)
    setShowForm(true)
  }

  function openEditContact(contact: Contact) {
    setEditingId(contact.id)
    setForm({
      full_name: contact.full_name || '',
      company: contact.company || '',
      job_title: contact.job_title || '',
      phone: contact.phone || '',
      email: contact.email || '',
      address: contact.address || '',
      notes: contact.notes || '',
      category: contact.category || '',
      phone_secondary: contact.phone_secondary || '',
      met_at: contact.met_at || '',
      follow_up_date: contact.follow_up_date || '',
      introduced_by: contact.introduced_by || '',
    })
    setShowForm(true)
  }

  async function scanBusinessCard(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    if (!file.type.startsWith('image/')) {
      setScanMessage('Please choose an image file.')
      e.target.value = ''
      return
    }

    setScanning(true)
    setScanProgress(0)
    setScanMessage('Preparing...')

    try {
      const recognizedText = await recognizeBusinessCard(
        file,
        setScanProgress,
        setScanMessage,
        contactSignal
      )

      if (!recognizedText.trim()) {
        throw new Error('No text was found on the photo. Try a sharper photo with good lighting.')
      }

      const extracted = extractContactData(recognizedText)
      const nothingFound = !extracted.full_name && !extracted.email && !extracted.phone

      setEditingId(null)
      setForm({
        ...emptyForm,
        ...extracted,
        category: suggestCategory(recognizedText),
        // Nothing could be sorted into fields: keep the raw text so it is not lost
        notes: nothingFound ? recognizedText.trim().slice(0, 600) : extracted.notes,
      })

      setShowScanner(false)
      setShowForm(true)
      setMessage(
        nothingFound
          ? 'Contact details could not be detected automatically. The recognized text was added to the notes, please fill in the fields.'
          : 'Details recognized. Please review them and correct if needed.'
      )
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : typeof error === 'string' ? error : ''

      setScanMessage(reason || 'Could not recognize the business card. Please try again.')
    } finally {
      setScanning(false)
      setScanProgress(0)
      e.target.value = ''
    }
  }

  async function saveContact(e: FormEvent) {
    e.preventDefault()
    if (!session?.user) return

    setSaving(true)
    setMessage('')

    try {
      const duplicate = findDuplicate(contacts, form, editingId)

      if (
        duplicate &&
        !window.confirm(`"${duplicate.full_name}" looks like a contact you already have. Save anyway?`)
      ) {
        return
      }

      const { category, phone_secondary, met_at, follow_up_date, introduced_by, ...basics } = form
      const extras = {
        category: normalizeCategory(category, knownCategories) || null,
        phone_secondary,
        met_at,
        follow_up_date: follow_up_date || null,
      }

      const write = (data: Record<string, unknown>) =>
        editingId
          ? supabase.from('contacts').update(data).eq('id', editingId)
          : supabase.from('contacts').insert(data)

      const link = { introduced_by: introduced_by && introduced_by !== editingId ? introduced_by : null }

      let result = await write({
        ...basics,
        ...(extrasReady ? extras : {}),
        ...(linksReady ? link : {}),
        user_id: session.user.id,
      })

      // The link column is missing: save without it first
      if (result.error && linksReady && /introduced_by/i.test(result.error.message)) {
        setLinksReady(false)
        result = await write({
          ...basics,
          ...(extrasReady ? extras : {}),
          user_id: session.user.id,
        })
      }

      // The database update was not run yet: save the basics so nothing is lost
      if (result.error && extrasReady && /category|is_favorite|phone_secondary|met_at|follow_up_date|schema cache/i.test(result.error.message)) {
        setExtrasReady(false)
        result = await write({ ...basics, user_id: session.user.id })
      }

      if (result.error) throw result.error

      setShowForm(false)
      setEditingId(null)
      setForm(emptyForm)
      await loadContacts()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save the contact')
    } finally {
      setSaving(false)
    }
  }

  async function deleteContact(id: string) {
    if (!window.confirm('Delete this contact?')) return

    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('id', id)

    if (error) {
      setMessage(error.message)
      return
    }

    await loadContacts()
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  async function toggleFavorite(contact: Contact) {
    const { error } = await supabase
      .from('contacts')
      .update({ is_favorite: !contact.is_favorite })
      .eq('id', contact.id)

    if (error) {
      setMessage(error.message)
      return
    }

    await loadContacts()
  }

  // Gives a topic to every contact that has none, based on the words on its card
  async function autoSortContacts() {
    const targets = contacts
      .filter(contact => !contact.category?.trim())
      .map(contact => ({ contact, topic: suggestCategory(contactText(contact)) }))
      .filter(item => item.topic)

    if (targets.length === 0) {
      setMessage('No new topics could be detected. Open a contact and choose a topic by hand.')
      return
    }

    setSorting(true)
    setMessage('')

    const results = await Promise.all(
      targets.map(({ contact, topic }) =>
        supabase.from('contacts').update({ category: topic }).eq('id', contact.id)
      )
    )
    const failed = results.filter(result => result.error).length

    await loadContacts()
    setSorting(false)
    setMessage(
      failed
        ? `Sorted ${targets.length - failed} contacts, ${failed} could not be updated.`
        : `Sorted ${targets.length} contacts by topic.`
    )
  }

  const knownCategories = [
    ...new Set([
      ...DEFAULT_CATEGORIES,
      ...contacts.map(contact => contact.category?.trim() || '').filter(Boolean),
    ]),
  ]

  const needsFollowUp = (contact: Contact) => {
    const state = followUpState(contact.follow_up_date)

    return state === 'overdue' || state === 'today' || state === 'soon'
  }

  const filteredContacts = contacts.filter(contact => {
    const query = search.trim().toLowerCase()

    const matchesSearch =
      !query ||
      [
        contact.full_name,
        contact.company,
        contact.job_title,
        contact.email,
        contact.phone,
        contact.phone_secondary,
        contact.category,
        contact.met_at,
        contact.notes,
      ].some(value => value?.toLowerCase().includes(query))

    if (!matchesSearch) return false
    if (activeFilter === FILTER_ALL) return true
    if (activeFilter === FILTER_FAVORITES) return !!contact.is_favorite
    if (activeFilter === FILTER_FOLLOW_UP) return needsFollowUp(contact)

    return categoryOf(contact) === activeFilter
  })

  const visibleContacts = sortContacts(filteredContacts, sortMode)
  const groups = extrasReady && groupView ? groupByCategory(visibleContacts) : null
  const topicCounts = countByCategory(contacts)
  const favoriteCount = contacts.filter(contact => contact.is_favorite).length
  const followUpCount = contacts.filter(needsFollowUp).length
  const uncategorizedCount = contacts.filter(contact => !contact.category?.trim()).length

  function renderCard(contact: Contact, index: number) {
    const state = followUpState(contact.follow_up_date)
    const phoneLink = (value: string) => `tel:${value.replace(/[^\d+]/g, '')}`

    return (
      <article
        className="contact-card"
        key={contact.id}
        style={{ '--i': index } as CSSProperties}
      >
        <div className="contact-card-top">
          <div className="contact-avatar">
            {contact.full_name.charAt(0).toUpperCase()}
          </div>
          <div className="contact-actions">
            {extrasReady && (
              <button
                className={contact.is_favorite ? 'favorite-btn active' : 'favorite-btn'}
                onClick={() => toggleFavorite(contact)}
                title={contact.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
              >
                <Star size={16} />
              </button>
            )}
            <button onClick={() => openEditContact(contact)} title="Edit">
              <Pencil size={16} />
            </button>
            <button onClick={() => deleteContact(contact.id)} title="Delete">
              <Trash2 size={16} />
            </button>
          </div>
        </div>

        <h3>{contact.full_name}</h3>
        {contact.job_title && <p className="contact-role">{contact.job_title}</p>}
        {contact.company && <p className="contact-company">{contact.company}</p>}

        {(contact.category || state === 'overdue' || state === 'today' || state === 'soon') && (
          <div className="card-badges">
            {contact.category && (
              <button
                className="topic-badge"
                onClick={() => setActiveFilter(contact.category as string)}
                title="Show this topic only"
              >
                <Tag size={12} /> {contact.category}
              </button>
            )}
            {state && state !== 'later' && (
              <span className={`followup-badge ${state}`}>
                <CalendarClock size={12} />
                {state === 'overdue' ? 'Overdue: ' : state === 'today' ? 'Today: ' : 'Follow up: '}
                {formatDate(contact.follow_up_date)}
              </span>
            )}
          </div>
        )}

        <div className="contact-details">
          {contact.email && <p><Mail size={15} /> {contact.email}</p>}
          {contact.phone && <p><span className="detail-phone">TEL</span> {contact.phone}</p>}
          {contact.phone_secondary && <p><span className="detail-phone">TEL</span> {contact.phone_secondary}</p>}
          {contact.address && <p><span className="detail-phone">LOC</span> {contact.address}</p>}
          {contact.met_at && <p><span className="detail-phone">MET</span> {contact.met_at}</p>}
        </div>

        {contact.notes && <p className="contact-notes">{contact.notes}</p>}

        <div className="card-footer">
          <span className="card-date">
            {state === 'later' ? `Follow up ${formatDate(contact.follow_up_date)}` : `Added ${formatDate(contact.created_at)}`}
          </span>
          <div className="quick-actions">
            {contact.email && (
              <a href={`mailto:${contact.email}`} title="Send email"><Mail size={15} /></a>
            )}
            {contact.phone && (
              <a href={phoneLink(contact.phone)} title="Call"><Phone size={15} /></a>
            )}
            <button onClick={() => downloadVCard(contact)} title="Save to phone contacts (vCard)">
              <Download size={15} />
            </button>
          </div>
        </div>
      </article>
    )
  }

  if (!session) {
    return (
      <main className="auth-page">
        <nav className="topbar">
          <a className="brand" href="#">
            <span className="brand-icon"><BookOpen size={21} /></span>
            <span>digital<span className="brand-light">book</span></span>
          </a>
          <span className="top-note">YOUR PERSONAL CONTACT SPACE</span>
        </nav>

        <section className="auth-layout">
          <div className="intro">
            <div className="eyebrow">
              <span className="status-dot" />
              YOUR CONTACTS, ORGANIZED
            </div>

            <h1>
              Every connection
              <br />
              <span>starts somewhere.</span>
            </h1>

            <p className="intro-text">
              Your personal space for business contacts.
              Scan, save and organize every connection
              in one beautiful place.
            </p>

            <div className="feature-list">
              <div><BookOpen size={18} /> Your own digital address book</div>
              <div><Mail size={18} /> All contacts in one place</div>
              <div><Lock size={18} /> Private and secure storage</div>
            </div>
          </div>

          <div className="auth-card">
            <div className="card-heading" key={mode}>
              <span className="card-label">WELCOME</span>
              <h2>{mode === 'login' ? 'Welcome back' : 'Create account'}</h2>
              <p>
                {mode === 'login'
                  ? 'Sign in to access your contacts.'
                  : 'Start building your personal contact book.'}
              </p>
            </div>

            <div className="tabs">
              <button
                className={mode === 'login' ? 'tab active' : 'tab'}
                onClick={() => { setMode('login'); setMessage('') }}
                type="button"
              >
                Sign in
              </button>
              <button
                className={mode === 'register' ? 'tab active' : 'tab'}
                onClick={() => { setMode('register'); setMessage('') }}
                type="button"
              >
                Register
              </button>
            </div>

            <form onSubmit={handleAuth}>
              <label>Email address</label>
              <div className="input-wrap">
                <Mail size={18} />
                <input
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                />
              </div>

              <label>Password</label>
              <div className="input-wrap">
                <Lock size={18} />
                <input
                  type="password"
                  placeholder="At least 8 characters"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  minLength={8}
                  required
                />
              </div>

              {message && <div className="message">{message}</div>}

              <button className="submit-btn" disabled={loading}>
                {loading
                  ? <Loader2 className="spin" size={19} />
                  : <>{mode === 'login' ? 'Sign in' : 'Create account'} <ArrowRight size={18} /></>}
              </button>
            </form>

            <p className="terms">
              By continuing, you agree to use Digital Book responsibly.
            </p>
          </div>
        </section>

        <footer>
          <span>DIGITAL BUSINESS BOOK</span>
          <span>YOUR CONNECTIONS MATTER.</span>
        </footer>
      </main>
    )
  }

  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <a className="brand" href="#">
          <span className="brand-icon"><BookOpen size={21} /></span>
          <span>digital<span className="brand-light">book</span></span>
        </a>

        <div className="account-area">
          <span>{session.user.email}</span>
          <button className="logout-btn" onClick={signOut}>
            <LogOut size={17} />
            <span>Sign out</span>
          </button>
        </div>
      </header>

      <section className="dashboard-content">
        <div className="dashboard-heading">
          <div>
            <span className="card-label">YOUR PERSONAL SPACE</span>
            <h1>My contacts</h1>
            <p>Your connections, all in one place.</p>
          </div>

          <div className="dashboard-buttons">
            <button className="add-btn scan-open-btn" onClick={() => {
              setScanMessage('')
              setShowScanner(true)
            }}>
              <ScanLine size={18} />
              Scan business card
            </button>

            <button className="add-btn" onClick={openNewContact}>
              <Plus size={18} />
              Add contact
            </button>
          </div>
        </div>

        <div className="contacts-toolbar">
          <div className="search-box">
            <Search size={19} />
            <input
              placeholder="Search by name, company or email..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          <span className="contacts-count" key={contacts.length}>
            {contacts.length} contacts
          </span>
        </div>

        {contacts.length > 0 && (
          <div className="view-switch">
            <button className={view === 'book' ? 'active' : ''} onClick={() => setView('book')}>Book</button>
            <button className={view === 'map' ? 'active' : ''} onClick={() => setView('map')}>Connections map</button>
          </div>
        )}

        {view === 'book' && contacts.length > 0 && (
          <div className="tools-row">
            <label className="sort-control">
              <span>Sort</span>
              <select
                value={sortMode}
                onChange={e => {
                  const value = e.target.value

                  if (isSortMode(value)) {
                    setSortMode(value)
                    writeStored('book-sort', value)
                  }
                }}
              >
                {(Object.keys(SORT_LABELS) as SortMode[]).map(mode => (
                  <option key={mode} value={mode}>{SORT_LABELS[mode]}</option>
                ))}
              </select>
            </label>

            {extrasReady && (
              <label className="group-toggle">
                <input
                  type="checkbox"
                  checked={groupView}
                  onChange={e => {
                    setGroupView(e.target.checked)
                    writeStored('book-group', e.target.checked ? 'on' : 'off')
                  }}
                />
                <span>Group by topic</span>
              </label>
            )}

            <div className="tools-spacer" />

            {extrasReady && uncategorizedCount > 0 && (
              <button className="tool-btn" onClick={autoSortContacts} disabled={sorting}>
                {sorting ? <Loader2 className="spin" size={15} /> : <Sparkles size={15} />}
                Auto-sort by topic ({uncategorizedCount})
              </button>
            )}
            <button className="tool-btn" onClick={() => downloadCsv(visibleContacts)}>
              <Download size={15} /> CSV
            </button>
            <button className="tool-btn" onClick={() => downloadAllVCards(visibleContacts)}>
              <Download size={15} /> vCard
            </button>
          </div>
        )}

        {view === 'book' && extrasReady && contacts.length > 0 && (
          <div className="filter-chips">
            <button
              className={activeFilter === FILTER_ALL ? 'chip active' : 'chip'}
              onClick={() => setActiveFilter(FILTER_ALL)}
            >
              All <span>{contacts.length}</span>
            </button>
            {favoriteCount > 0 && (
              <button
                className={activeFilter === FILTER_FAVORITES ? 'chip active' : 'chip'}
                onClick={() => setActiveFilter(FILTER_FAVORITES)}
              >
                Favorites <span>{favoriteCount}</span>
              </button>
            )}
            {followUpCount > 0 && (
              <button
                className={activeFilter === FILTER_FOLLOW_UP ? 'chip active' : 'chip'}
                onClick={() => setActiveFilter(FILTER_FOLLOW_UP)}
              >
                Follow-up <span>{followUpCount}</span>
              </button>
            )}
            {topicCounts.map(topic => (
              <button
                key={topic.name}
                className={activeFilter === topic.name ? 'chip active' : 'chip'}
                onClick={() => setActiveFilter(topic.name)}
              >
                {topic.name} <span>{topic.count}</span>
              </button>
            ))}
          </div>
        )}

        {message && <div className="message dashboard-message">{message}</div>}

        {!extrasReady && (
          <div className="message dashboard-message">
            Topics and extra card fields need a one-time database update. Run
            supabase/contact-extras.sql in the Supabase SQL Editor, then reload this page.
          </div>
        )}

        {view === 'map' && contacts.length > 0 ? (
          <RelationMap contacts={contacts} linksReady={linksReady} onEdit={openEditContact} />
        ) : visibleContacts.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon"><BookOpen size={28} /></div>
            <h2>{search || activeFilter !== FILTER_ALL ? 'No contacts found' : 'Your book is empty'}</h2>
            <p>
              {search || activeFilter !== FILTER_ALL
                ? 'Try another search or filter.'
                : 'Add your first contact to start building your address book.'}
            </p>
            {!search && activeFilter === FILTER_ALL && (
              <button className="add-btn" onClick={openNewContact}>
                <Plus size={18} />
                Add your first contact
              </button>
            )}
          </div>
        ) : (
          groups ? (
            groups.map(group => (
              <section className="topic-section" key={group.name}>
                <h2 className="topic-heading">
                  {group.name} <span>{group.items.length}</span>
                </h2>
                <div className="contact-grid">
                  {group.items.map(renderCard)}
                </div>
              </section>
            ))
          ) : (
            <div className="contact-grid">
              {visibleContacts.map(renderCard)}
            </div>
          )
        )}
      </section>

      {showScanner && (
        <div className="modal-overlay" onClick={() => !scanning && setShowScanner(false)}>
          <div className="contact-modal scanner-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <span className="card-label">DIGITAL SCANNER</span>
                <h2>Scan business card</h2>
              </div>
              <button
                className="close-btn"
                onClick={() => setShowScanner(false)}
                disabled={scanning}
              >
                <X size={20} />
              </button>
            </div>

            <p className="scanner-description">
              Take a photo of a business card or upload an existing image.
              The text will be recognized automatically.
            </p>

            <div className="scanner-options">
              <button
                className={canUseCamera ? 'scanner-option' : 'scanner-option unavailable'}
                onClick={() => {
                  if (!canUseCamera) {
                    setScanMessage('Taking a photo is not available on your device. Upload an existing image or open the site on your phone.')
                    return
                  }

                  cameraRef.current?.click()
                }}
                disabled={scanning}
              >
                <Camera size={25} />
                <strong>Open camera</strong>
                <span>{canUseCamera ? 'Take a photo now' : 'Available on mobile devices'}</span>
              </button>

              <button
                className="scanner-option"
                onClick={() => uploadRef.current?.click()}
                disabled={scanning}
              >
                <ImagePlus size={25} />
                <strong>Upload image</strong>
                <span>Choose a photo</span>
              </button>
            </div>

            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={scanBusinessCard}
            />

            <input
              ref={uploadRef}
              type="file"
              accept="image/*"
              hidden
              onChange={scanBusinessCard}
            />

            {scanning && (
              <div className="scanner-progress">
                <Loader2 className="spin" size={22} />
                <span>{scanMessage} {scanProgress > 0 ? `${scanProgress}%` : ''}</span>
                <div className="progress-track">
                  <div style={{ width: `${scanProgress}%` }} />
                </div>
              </div>
            )}

            {scanMessage && !scanning && (
              <div className="message scanner-error">{scanMessage}</div>
            )}
          </div>
        </div>
      )}

      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="contact-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <span className="card-label">CONTACT DETAILS</span>
                <h2>{editingId ? 'Edit contact' : 'New contact'}</h2>
              </div>
              <button className="close-btn" onClick={() => setShowForm(false)}>
                <X size={20} />
              </button>
            </div>

            <form onSubmit={saveContact}>
              <label>Full name *</label>
              <input
                className="form-input"
                value={form.full_name}
                onChange={e => setForm({ ...form, full_name: e.target.value })}
                placeholder="John Smith"
                required
              />

              <div className="form-row">
                <div>
                  <label>Company</label>
                  <input className="form-input" value={form.company}
                    onChange={e => setForm({ ...form, company: e.target.value })}
                    placeholder="Company name" />
                </div>
                <div>
                  <label>Job title</label>
                  <input className="form-input" value={form.job_title}
                    onChange={e => setForm({ ...form, job_title: e.target.value })}
                    placeholder="Position" />
                </div>
              </div>

              <div className="form-row">
                <div>
                  <label>Phone</label>
                  <input className="form-input" value={form.phone}
                    onChange={e => setForm({ ...form, phone: e.target.value })}
                    placeholder="+49 ..." />
                </div>
                <div>
                  <label>Second phone</label>
                  <input className="form-input" value={form.phone_secondary}
                    onChange={e => setForm({ ...form, phone_secondary: e.target.value })}
                    placeholder="Mobile or fax" />
                </div>
              </div>

              <label>Email</label>
              <input className="form-input" type="email" value={form.email}
                onChange={e => setForm({ ...form, email: e.target.value })}
                placeholder="name@example.com" />

              <label>Address</label>
              <input className="form-input" value={form.address}
                onChange={e => setForm({ ...form, address: e.target.value })}
                placeholder="Address" />

              {extrasReady && (
                <>
                  <label>Topic</label>
                  <input className="form-input" list="topic-options" value={form.category}
                    onChange={e => setForm({ ...form, category: e.target.value })}
                    placeholder="Doors, Windows, Sport, Work..." />
                  <datalist id="topic-options">
                    {knownCategories.map(name => <option key={name} value={name} />)}
                  </datalist>

                  <div className="form-row">
                    <div>
                      <label>Met at</label>
                      <input className="form-input" value={form.met_at}
                        onChange={e => setForm({ ...form, met_at: e.target.value })}
                        placeholder="Trade fair, event..." />
                    </div>
                    <div>
                      <label>Follow-up date</label>
                      <input className="form-input" type="date" value={form.follow_up_date}
                        onChange={e => setForm({ ...form, follow_up_date: e.target.value })} />
                    </div>
                  </div>
                </>
              )}

              {linksReady && (
                <>
                  <label>Introduced by</label>
                  <select className="form-input" value={form.introduced_by}
                    onChange={e => setForm({ ...form, introduced_by: e.target.value })}>
                    <option value="">Nobody / not set</option>
                    {[...contacts]
                      .filter(contact => contact.id !== editingId)
                      .sort((a, b) => a.full_name.localeCompare(b.full_name))
                      .map(contact => (
                        <option key={contact.id} value={contact.id}>{contact.full_name}</option>
                      ))}
                  </select>
                </>
              )}

              <label>Notes</label>
              <textarea className="form-input form-textarea" value={form.notes}
                onChange={e => setForm({ ...form, notes: e.target.value })}
                placeholder="Additional information..." />

              <button className="submit-btn modal-submit" disabled={saving}>
                {saving
                  ? <Loader2 className="spin" size={18} />
                  : <>{editingId ? 'Save changes' : 'Save contact'} <ArrowRight size={18} /></>}
              </button>
            </form>
          </div>
        </div>
      )}
    </main>
  )
}

export default App

