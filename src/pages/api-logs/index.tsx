import { Fragment, useCallback, useEffect, useState } from 'react'

interface ApiLogRow {
  id: number
  direction: 'inbound' | 'outbound'
  ts: number
  method: string
  path: string
  query: string | null
  status: number
  duration_ms: number
  ip: string | null
  content_type: string | null
  req_body: string | null
  res_body: string | null
  error: string | null
}

interface LogResponse {
  rows: ApiLogRow[]
  total: number
  limit: number
  offset: number
}

const PAGE_SIZE = 50

const statusColor = (status: number): string => {
  if (status >= 500) return '#c0392b'
  if (status >= 400) return '#d68910'
  if (status >= 300) return '#2471a3'
  if (status >= 200) return '#1e8449'
  return '#555'
}

const prettify = (text: string | null): string => {
  if (!text) return ''
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

const cell: React.CSSProperties = {
  padding: '6px 10px',
  borderBottom: '1px solid #eee',
  textAlign: 'left',
  whiteSpace: 'nowrap',
}

export default function ApiLogs() {
  const [data, setData] = useState<LogResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [page, setPage] = useState(0)

  // Filters (applied form). `draft` holds in-progress input until "Apply".
  const [direction, setDirection] = useState('')
  const [method, setMethod] = useState('')
  const [path, setPath] = useState('')
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const params = new URLSearchParams()
      params.set('limit', String(PAGE_SIZE))
      params.set('offset', String(page * PAGE_SIZE))
      if (direction) params.set('direction', direction)
      if (method) params.set('method', method)
      if (path) params.set('path', path)
      if (status) params.set('status', status)
      if (q) params.set('q', q)
      const res = await fetch(`/api/logs?${params.toString()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData((await res.json()) as LogResponse)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [page, direction, method, path, status, q])

  useEffect(() => {
    void load()
  }, [load])

  const applyFilters = (e: React.FormEvent) => {
    e.preventDefault()
    setPage(0)
    void load()
  }

  const rows = data?.rows ?? []
  const total = data?.total ?? 0
  const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1)

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 20, maxWidth: 1200, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>API Logs</h1>
      <p style={{ color: '#666', marginTop: 0, fontSize: 13 }}>
        {total.toLocaleString()} request{total === 1 ? '' : 's'} logged
      </p>

      <form onSubmit={applyFilters} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
        <select value={direction} onChange={(e) => setDirection(e.target.value)} style={{ padding: 6 }}>
          <option value="">All traffic</option>
          <option value="inbound">Inbound (→ /api)</option>
          <option value="outbound">Outbound (→ Bubble)</option>
        </select>
        <select value={method} onChange={(e) => setMethod(e.target.value)} style={{ padding: 6 }}>
          <option value="">All methods</option>
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <input placeholder="path contains…" value={path} onChange={(e) => setPath(e.target.value)} style={{ padding: 6 }} />
        <input placeholder="status" value={status} onChange={(e) => setStatus(e.target.value)} style={{ padding: 6, width: 80 }} />
        <input placeholder="search bodies…" value={q} onChange={(e) => setQ(e.target.value)} style={{ padding: 6, flex: 1, minWidth: 160 }} />
        <button type="submit" style={{ padding: '6px 14px' }}>Apply</button>
        <button type="button" onClick={() => void load()} style={{ padding: '6px 14px' }}>Refresh</button>
      </form>

      {err && <div style={{ color: '#c0392b', marginBottom: 12 }}>Error: {err}</div>}
      {loading && <div style={{ color: '#666', marginBottom: 12 }}>Loading…</div>}

      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
        <thead>
          <tr style={{ background: '#fafafa' }}>
            <th style={cell}>Time</th>
            <th style={cell}>Dir</th>
            <th style={cell}>Method</th>
            <th style={{ ...cell, whiteSpace: 'normal' }}>Path</th>
            <th style={cell}>Status</th>
            <th style={cell}>Duration</th>
            <th style={cell}>IP</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Fragment key={r.id}>
              <tr
                onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                style={{ cursor: 'pointer', background: expanded === r.id ? '#f0f6ff' : undefined }}
              >
                <td style={cell}>{new Date(r.ts).toLocaleString()}</td>
                <td style={cell}>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: '1px 6px',
                      borderRadius: 3,
                      color: r.direction === 'outbound' ? '#6c3483' : '#1f618d',
                      background: r.direction === 'outbound' ? '#f4ecf7' : '#eaf2f8',
                    }}
                  >
                    {r.direction === 'outbound' ? '↗ out' : '↘ in'}
                  </span>
                </td>
                <td style={{ ...cell, fontWeight: 600 }}>{r.method}</td>
                <td style={{ ...cell, whiteSpace: 'normal', fontFamily: 'monospace' }}>
                  {r.path}{r.query ? <span style={{ color: '#999' }}>?{r.query}</span> : null}
                </td>
                <td style={{ ...cell, color: statusColor(r.status), fontWeight: 600 }}>{r.status}</td>
                <td style={cell}>{r.duration_ms} ms</td>
                <td style={cell}>{r.ip ?? '—'}</td>
              </tr>
              {expanded === r.id && (
                <tr>
                  <td colSpan={7} style={{ padding: 16, background: '#fbfbfb', borderBottom: '1px solid #eee' }}>
                    {r.error && (
                      <Section title="Error" body={r.error} color="#c0392b" />
                    )}
                    <Section title="Request body" body={prettify(r.req_body)} />
                    <Section title="Response body" body={prettify(r.res_body)} />
                    <div style={{ fontSize: 12, color: '#888' }}>content-type: {r.content_type ?? '—'}</div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {!loading && rows.length === 0 && (
            <tr><td colSpan={7} style={{ ...cell, color: '#888', textAlign: 'center' }}>No logs.</td></tr>
          )}
        </tbody>
      </table>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 14 }}>
        <button disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))} style={{ padding: '6px 14px' }}>← Prev</button>
        <span style={{ fontSize: 13, color: '#666' }}>Page {page + 1} of {maxPage + 1}</span>
        <button disabled={page >= maxPage} onClick={() => setPage((p) => p + 1)} style={{ padding: '6px 14px' }}>Next →</button>
      </div>
    </div>
  )
}

function Section({ title, body, color }: { title: string; body: string; color?: string }) {
  if (!body) return null
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: color ?? '#444', marginBottom: 4 }}>{title}</div>
      <pre
        style={{
          margin: 0,
          padding: 10,
          background: '#fff',
          border: '1px solid #eee',
          borderRadius: 4,
          maxHeight: 320,
          overflow: 'auto',
          fontSize: 12,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: color ?? '#333',
        }}
      >
        {body}
      </pre>
    </div>
  )
}
