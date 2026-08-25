/**
 * Authenticated calls to the gateway's own API.
 *
 * The key lives in sessionStorage, not localStorage or a cookie: it should die with
 * the tab, and a cookie would be sent on every request including the unauthenticated
 * payer-facing ones.
 */
const KEY_STORE = 'gobiz.adminKey'

export const useApiKey = () => useState<string>('apiKey', () => '')

export function useApi() {
  const apiKey = useApiKey()

  /** Restore the key after a reload. Client-only; there is no SSR here. */
  const restore = () => {
    apiKey.value = sessionStorage.getItem(KEY_STORE) || ''
    return apiKey.value
  }

  const remember = (key: string) => {
    apiKey.value = key
    sessionStorage.setItem(KEY_STORE, key)
  }

  const forget = () => {
    apiKey.value = ''
    sessionStorage.removeItem(KEY_STORE)
  }

  async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(path, {
      method,
      headers: {
        'X-API-Key': apiKey.value,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    const json = await res.json().catch(() => ({}) as any)
    if (res.status === 401) {
      forget()
      throw new Error('API key ditolak')
    }
    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
    return json.data as T
  }

  return { apiKey, api, restore, remember, forget }
}

const idr = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 })

export const rp = (n: number | null | undefined) =>
  n == null ? '—' : `Rp ${idr.format(n)}`

export const num = (n: number | null | undefined) =>
  n == null ? '—' : idr.format(n)

export const clock = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'medium' }) : '—'
