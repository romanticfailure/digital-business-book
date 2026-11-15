import type { Contact } from './contacts'

export type GraphNode = {
  id: string
  kind: 'person' | 'company'
  label: string
  contact?: Contact
  x: number
  y: number
}

export type GraphEdge = {
  from: string
  to: string
  kind: 'intro' | 'company'
}

export const MAP_WIDTH = 1000
export const MAP_HEIGHT = 620

const companyKey = (company: string) => company.trim().toLowerCase().replace(/\s+/g, ' ')

// People are nodes. Companies with two or more people become a hub node.
// "intro" edges point from the person who introduced to the person introduced.
export function buildGraph(contacts: Contact[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const ids = new Set(contacts.map(contact => contact.id))
  const byCompany = new Map<string, { label: string; members: Contact[] }>()

  for (const contact of contacts) {
    nodes.push({ id: contact.id, kind: 'person', label: contact.full_name, contact, x: 0, y: 0 })

    if (contact.introduced_by && contact.introduced_by !== contact.id && ids.has(contact.introduced_by)) {
      edges.push({ from: contact.introduced_by, to: contact.id, kind: 'intro' })
    }

    const company = contact.company?.trim()

    if (company) {
      const key = companyKey(company)
      const entry = byCompany.get(key) ?? { label: company, members: [] }

      entry.members.push(contact)
      byCompany.set(key, entry)
    }
  }

  for (const [key, entry] of byCompany) {
    if (entry.members.length < 2) continue

    const id = `company:${key}`

    nodes.push({ id, kind: 'company', label: entry.label, x: 0, y: 0 })

    for (const member of entry.members) {
      edges.push({ from: id, to: member.id, kind: 'company' })
    }
  }

  return { nodes, edges }
}

// Force layout: everything pushes apart, links pull together, a weak pull to
// the middle keeps separate groups on screen. Deterministic, no randomness.
export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  const count = nodes.length

  if (count === 0) return nodes

  const cx = MAP_WIDTH / 2
  const cy = MAP_HEIGHT / 2
  const radius = Math.min(MAP_WIDTH, MAP_HEIGHT) * 0.38
  const index = new Map<string, number>()

  const pos = nodes.map((node, i) => {
    index.set(node.id, i)
    const angle = (i / count) * Math.PI * 2

    return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius }
  })

  const links = edges
    .map(edge => [index.get(edge.from), index.get(edge.to)] as const)
    .filter((pair): pair is readonly [number, number] => pair[0] !== undefined && pair[1] !== undefined)

  const ideal = Math.max(40, Math.min(110, Math.sqrt((MAP_WIDTH * MAP_HEIGHT) / count) * 0.7))
  const rounds = count > 150 ? 120 : 300

  for (let round = 0; round < rounds; round++) {
    const cooling = 1 - round / rounds
    const step = ideal * 0.35 * cooling + 0.5
    const move = pos.map(() => ({ x: 0, y: 0 }))

    for (let a = 0; a < count; a++) {
      for (let b = a + 1; b < count; b++) {
        let dx = pos[a].x - pos[b].x
        let dy = pos[a].y - pos[b].y

        // Two nodes on the same spot are pushed apart in a fixed direction
        if (dx === 0 && dy === 0) {
          dx = ((a + b) % 2 ? 1 : -1) * 0.01
          dy = 0.01
        }

        const dist = Math.hypot(dx, dy)
        const force = (ideal * ideal) / dist
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force

        move[a].x += fx
        move[a].y += fy
        move[b].x -= fx
        move[b].y -= fy
      }
    }

    for (const [a, b] of links) {
      const dx = pos[a].x - pos[b].x
      const dy = pos[a].y - pos[b].y
      const dist = Math.hypot(dx, dy) || 0.01
      const force = (dist * dist) / ideal
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force

      move[a].x -= fx
      move[a].y -= fy
      move[b].x += fx
      move[b].y += fy
    }

    for (let i = 0; i < count; i++) {
      move[i].x += (cx - pos[i].x) * 0.6
      move[i].y += (cy - pos[i].y) * 0.6

      const length = Math.hypot(move[i].x, move[i].y) || 1
      const limited = Math.min(length, step)

      pos[i].x = Math.min(MAP_WIDTH - 60, Math.max(60, pos[i].x + (move[i].x / length) * limited))
      pos[i].y = Math.min(MAP_HEIGHT - 40, Math.max(40, pos[i].y + (move[i].y / length) * limited))
    }
  }

  return nodes.map((node, i) => ({ ...node, x: pos[i].x, y: pos[i].y }))
}
