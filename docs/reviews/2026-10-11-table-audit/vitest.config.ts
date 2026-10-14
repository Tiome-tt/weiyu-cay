import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', include: ['docs/reviews/2026-10-11-table-audit/unit.test.tsx'], testTimeout: 15000 },
})
