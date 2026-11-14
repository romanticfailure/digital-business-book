
import { useEffect, useRef, useState, type FormEvent, type ChangeEvent, type CSSProperties } from 'react'
import {
  BookOpen, Mail, Lock, ArrowRight, Loader2,
  Search, Plus, LogOut, Pencil, Trash2, X,
  ScanLine, Camera, ImagePlus
} from 'lucide-react'
import { recognizeBusinessCard } from './ocr'
import { supabase } from './supabase'
import './App.css'
import './animations.css'

type Contact = {
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
}

const emptyForm = {
  full_name: '',
  company: '',
  job_title: '',
  phone: '',
  email: '',
  address: '',
  notes: '',
}

// The camera option only makes sense on phones and tablets. On a computer the
// browser would just open the file explorer, so we show a message instead.
const canUseCamera =
  typeof navigator !== 'undefined' &&
  (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    // iPadOS reports itself as a Mac, but has a touch screen
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1))

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
    /\b(geschÃ¤ftsfÃ¼hrer(?:in)?|geschaeftsfuehrer(?:in)?|geschÃ¤ftsleitung|inhaber(?:in)?|ceo|coo|cto|cfo|manager(?:in)?|director|managing director|sales manager|account manager|project manager|marketing manager|vertrieb|verkauf|leiter(?:in)?|abteilungsleiter(?:in)?|entwickler(?:in)?|engineer|consultant|berater(?:in)?|designer(?:in)?|assistant|assistent(?:in)?|sekretÃ¤r(?:in)?|sekretaer(?:in)?|owner|founder|partner|techniker(?:in)?|meister(?:in)?|monteur(?:in)?|handwerker(?:in)?)\b/i

  const job_title = lines.find(line =>
    jobPattern.test(line)
  ) || ''

  const companyPattern =
    /\b(gmbh|gmbh\s*&\s*co\.?\s*kg|ag|ug|haftungsbeschrÃ¤nkt|haftungsbeschraenkt|kg|ohg|gbr|e\.?k\.?|ltd|llc|inc|corp|corporation|company|group|solutions|consulting|services|industrie|technik|bau|logistik|automotive|systems)\b/i

  const excluded =
    /email|e-mail|telefon|phone|mobile|mobil|tel\.?|fax|www\.|https?:|@|kontakt|contact/i

  const companyLine = lines.find(line =>
    companyPattern.test(line) &&
    !excluded.test(line)
  ) || ''

  const addressPattern =
    /\b(strasse|straÃŸe|str\.|street|road|avenue|platz|weg|allee|gasse|ring|boulevard|blvd)\b/i

  const addressLine = lines.find(line =>
    addressPattern.test(line) ||
    /\b\d{5}\s+[A-ZÃ„Ã–Ãœ]/i.test(line)
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
        /^[A-ZÃ„Ã–Ãœ][a-zÃ¤Ã¶Ã¼ÃŸ-]+(?:\s+[A-ZÃ„Ã–Ãœ][a-zÃ¤Ã¶Ã¼ÃŸ-]+)+$/.test(line)
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
  const properName = /^[A-ZÃ„Ã–Ãœ][a-zÃ¤Ã¶Ã¼ÃŸ-]+(?:\s+[A-ZÃ„Ã–Ãœ][a-zÃ¤Ã¶Ã¼ÃŸ-]+)+$/.test(data.full_name)

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
  const [form, setForm] = useState(emptyForm)
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

    setContacts(data || [])
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
      setMessage(error instanceof Error ? error.message : 'Something went wrong')
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
      const contactData = {
        ...form,
        user_id: session.user.id,
      }

      const result = editingId
        ? await supabase
            .from('contacts')
            .update(contactData)
            .eq('id', editingId)
        : await supabase
            .from('contacts')
            .insert(contactData)

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

  const filteredContacts = contacts.filter(contact => {
    const query = search.toLowerCase()

    return [
      contact.full_name,
      contact.company,
      contact.job_title,
      contact.email,
      contact.phone,
    ].some(value => value?.toLowerCase().includes(query))
  })

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

        {message && <div className="message dashboard-message">{message}</div>}

        {filteredContacts.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon"><BookOpen size={28} /></div>
            <h2>{search ? 'No contacts found' : 'Your book is empty'}</h2>
            <p>
              {search
                ? 'Try another search.'
                : 'Add your first contact to start building your address book.'}
            </p>
            {!search && (
              <button className="add-btn" onClick={openNewContact}>
                <Plus size={18} />
                Add your first contact
              </button>
            )}
          </div>
        ) : (
          <div className="contact-grid">
            {filteredContacts.map((contact, index) => (
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

                <div className="contact-details">
                  {contact.email && <p><Mail size={15} /> {contact.email}</p>}
                  {contact.phone && <p><span className="detail-phone">TEL</span> {contact.phone}</p>}
                  {contact.address && <p><span className="detail-phone">LOC</span> {contact.address}</p>}
                </div>

                {contact.notes && <p className="contact-notes">{contact.notes}</p>}
              </article>
            ))}
          </div>
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

              <label>Phone</label>
              <input className="form-input" value={form.phone}
                onChange={e => setForm({ ...form, phone: e.target.value })}
                placeholder="+49 ..." />

              <label>Email</label>
              <input className="form-input" type="email" value={form.email}
                onChange={e => setForm({ ...form, email: e.target.value })}
                placeholder="name@example.com" />

              <label>Address</label>
              <input className="form-input" value={form.address}
                onChange={e => setForm({ ...form, address: e.target.value })}
                placeholder="Address" />

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

