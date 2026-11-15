import { useMemo, useState } from 'react'
import { Building2, Minus, Pencil, Plus, RotateCcw } from 'lucide-react'
import { UNCATEGORIZED } from './categories'
import { categoryOf, type Contact } from './contacts'
import { MAP_HEIGHT, MAP_WIDTH, buildGraph, layoutGraph } from './graph'

// Muted tones that fit the brown palette of the site, one per topic.
const TOPIC_COLORS = ['#795d40', '#6f7f5c', '#a07a4a', '#5f7482', '#9a5f4f', '#7d6a8a', '#8a8a4f', '#4f7a72']
const NEUTRAL = '#a99a86'

function topicColor(name: string): string {
  if (name === UNCATEGORIZED) return NEUTRAL

  let hash = 0

  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0

  return TOPIC_COLORS[hash % TOPIC_COLORS.length]
}

function shorten(text: string, max = 18): string {
  return text.length > max ? `${text.slice(0, max - 1)}...` : text
}

type Props = {
  contacts: Contact[]
  linksReady: boolean
  onEdit: (contact: Contact) => void
}

export default function RelationMap({ contacts, linksReady, onEdit }: Props) {
  const [selected, setSelected] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)

  const { nodes, edges } = useMemo(() => {
    const graph = buildGraph(contacts)

    return { nodes: layoutGraph(graph.nodes, graph.edges), edges: graph.edges }
  }, [contacts])

  const byId = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes])
  const topics = useMemo(
    () => [...new Set(contacts.map(categoryOf))].sort(),
    [contacts]
  )

  // A selection can point to a contact that was deleted in the meantime
  const active = selected && byId.has(selected) ? selected : null

  const neighbors = new Set<string>()

  if (active) {
    neighbors.add(active)

    for (const edge of edges) {
      if (edge.from === active) neighbors.add(edge.to)
      if (edge.to === active) neighbors.add(edge.from)
    }
  }

  const dim = (id: string) => (active && !neighbors.has(id) ? 0.18 : 1)
  const edgeDim = (from: string, to: string) =>
    active && from !== active && to !== active ? 0.1 : 1

  const selectedNode = active ? byId.get(active) : undefined
  const selectedContact = selectedNode?.contact
  const introducedBy = selectedContact?.introduced_by
    ? byId.get(selectedContact.introduced_by)?.label
    : ''
  const introduced = active
    ? edges
        .filter(edge => edge.kind === 'intro' && edge.from === active)
        .map(edge => byId.get(edge.to)?.label)
        .filter(Boolean)
    : []
  const colleagues = selectedContact
    ? nodes
        .filter(
          node =>
            node.kind === 'person' &&
            node.id !== active &&
            !!selectedContact.company &&
            node.contact?.company?.trim().toLowerCase() === selectedContact.company.trim().toLowerCase()
        )
        .map(node => node.label)
    : []

  const hasLinks = edges.length > 0

  // Zooming shrinks the visible area around the middle of the map
  const viewWidth = MAP_WIDTH / zoom
  const viewHeight = MAP_HEIGHT / zoom
  const viewBox = `${(MAP_WIDTH - viewWidth) / 2} ${(MAP_HEIGHT - viewHeight) / 2} ${viewWidth} ${viewHeight}`

  return (
    <div className="relation-map">
      <div className="map-toolbar">
        <div className="map-legend">
          <span><i className="legend-line" /> Introduced</span>
          <span><i className="legend-line dotted" /> Same company</span>
          {topics.slice(0, 8).map(topic => (
            <span key={topic}><i className="legend-dot" style={{ background: topicColor(topic) }} /> {topic}</span>
          ))}
        </div>

        <div className="map-zoom">
          <button onClick={() => setZoom(value => Math.max(0.6, +(value - 0.2).toFixed(1)))} title="Zoom out">
            <Minus size={15} />
          </button>
          <button onClick={() => setZoom(value => Math.min(2.4, +(value + 0.2).toFixed(1)))} title="Zoom in">
            <Plus size={15} />
          </button>
          <button onClick={() => { setZoom(1); setSelected(null) }} title="Reset">
            <RotateCcw size={15} />
          </button>
        </div>
      </div>

      <div className="map-canvas">
        <svg viewBox={viewBox} role="img" aria-label="Map of connections between your contacts" onClick={() => setSelected(null)}>
          <defs>
            <marker id="map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill="#987653" />
            </marker>
          </defs>

          {edges.map(edge => {
            const a = byId.get(edge.from)
            const b = byId.get(edge.to)

            if (!a || !b) return null

            return (
              <line
                key={`${edge.kind}-${edge.from}-${edge.to}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={edge.kind === 'intro' ? '#987653' : '#c9bba7'}
                strokeWidth={edge.kind === 'intro' ? 1.8 : 1.3}
                strokeDasharray={edge.kind === 'company' ? '2 5' : undefined}
                strokeLinecap="round"
                markerEnd={edge.kind === 'intro' ? 'url(#map-arrow)' : undefined}
                opacity={edgeDim(edge.from, edge.to)}
              />
            )
          })}

          {nodes.map(node => {
            const isActive = node.id === active
            const color = node.contact ? topicColor(categoryOf(node.contact)) : '#876746'

            return (
              <g
                key={node.id}
                className="map-node"
                opacity={dim(node.id)}
                transform={`translate(${node.x} ${node.y})`}
                onClick={event => {
                  event.stopPropagation()
                  setSelected(node.id === active ? null : node.id)
                }}
              >
                {node.kind === 'company' ? (
                  <rect x={-11} y={-11} width={22} height={22} rx={6} fill="#fffdf9" stroke="#876746" strokeWidth={2} />
                ) : (
                  <circle r={isActive ? 15 : 12} fill={color} stroke="#fffdf9" strokeWidth={3} />
                )}
                {node.contact?.is_favorite && <circle r={4} cy={-15} fill="#c9a45c" stroke="#fffdf9" strokeWidth={1.5} />}
                <text y={node.kind === 'company' ? 27 : 29} textAnchor="middle" className={node.kind === 'company' ? 'map-label company' : 'map-label'}>
                  {shorten(node.label)}
                </text>
              </g>
            )
          })}
        </svg>

        {!hasLinks && (
          <div className="map-hint">
            No connections yet. Open a contact and choose who introduced them, or give people the same company name.
            {!linksReady && ' (The introduced-by field needs the database update from supabase/contact-links.sql.)'}
          </div>
        )}
      </div>

      <div className="map-details">
        {selectedContact ? (
          <>
            <div className="map-details-head">
              <strong>{selectedContact.full_name}</strong>
              <button className="tool-btn" onClick={() => onEdit(selectedContact)}>
                <Pencil size={14} /> Edit
              </button>
            </div>
            <p>{[selectedContact.job_title, selectedContact.company, selectedContact.category].filter(Boolean).join(' - ') || 'No further details'}</p>
            {introducedBy && <p><span>Introduced by</span> {introducedBy}</p>}
            {introduced.length > 0 && <p><span>Introduced</span> {introduced.join(', ')}</p>}
            {colleagues.length > 0 && <p><span>Same company</span> {colleagues.join(', ')}</p>}
            {!introducedBy && introduced.length === 0 && colleagues.length === 0 && (
              <p>No connections for this contact yet.</p>
            )}
          </>
        ) : selectedNode ? (
          <>
            <div className="map-details-head"><strong><Building2 size={15} /> {selectedNode.label}</strong></div>
            <p>{[...neighbors].filter(id => id !== selectedNode.id).map(id => byId.get(id)?.label).join(', ')}</p>
          </>
        ) : (
          <p>Click a person or company to see their connections.</p>
        )}
      </div>
    </div>
  )
}
