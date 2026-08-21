import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// The production index.html carries a strict CSP meta tag. The Vite dev
// server needs an inline react-refresh preamble and a WebSocket for HMR,
// neither of which survives `script-src 'self'`. This plugin only runs for
// the dev server (`apply: 'serve'`) and relaxes that meta tag in place; the
// production build keeps the strict tag untouched.
function relaxCspInDev(): Plugin {
  return {
    name: 'relax-csp-in-dev',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/,
        '<meta http-equiv="Content-Security-Policy" content=' +
          '"default-src \'self\'; script-src \'self\' \'unsafe-inline\'; ' +
          'style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; ' +
          'connect-src \'self\' ws: http: https:; object-src \'none\'">',
      )
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), relaxCspInDev()],
})
