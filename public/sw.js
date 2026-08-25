/* Offline support: after the first visit the whole editor works with no
 * connection — ROMs are local files, so nothing else needs the network.
 *
 * Strategy differs by request kind, and the split matters:
 *
 *   - Navigations (index.html) are NETWORK-FIRST. index.html names the
 *     content-hashed asset bundles, so serving a stale copy pins the app
 *     to an old release forever. A cache-first index left every deploy
 *     invisible until the user reloaded twice — a real bug, not theory.
 *   - Hashed assets are CACHE-FIRST. Their URL changes whenever their
 *     content does, so a cached hit can never be stale.
 *
 * Falling back to cache on a failed navigation keeps offline working.
 */
const CACHE = 'global-rom-editor-v2'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (e) =>
  e.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))
      await self.clients.claim()
    })(),
  ),
)

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return

  const isNavigation = e.request.mode === 'navigate' || url.pathname.endsWith('.html')

  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      if (isNavigation) {
        try {
          const res = await fetch(e.request)
          if (res.ok) cache.put(e.request, res.clone())
          return res
        } catch {
          return (await cache.match(e.request)) ?? (await cache.match('./')) ?? Response.error()
        }
      }

      const cached = await cache.match(e.request)
      if (cached) return cached
      const res = await fetch(e.request)
      if (res.ok) cache.put(e.request, res.clone())
      return res
    }),
  )
})
