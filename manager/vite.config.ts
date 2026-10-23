import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// A SPA é servida pelo Express em /manager (ver contrato "Manager").
// Em desenvolvimento, as chamadas para /sessions vão para o bridge local.
export default defineConfig({
  base: '/manager/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/sessions': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Separa as dependências em blocos estáveis, que o navegador mantém em cache entre versões.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          radix: [
            '@radix-ui/react-alert-dialog',
            '@radix-ui/react-checkbox',
            '@radix-ui/react-dialog',
            '@radix-ui/react-label',
            '@radix-ui/react-select',
            '@radix-ui/react-slot',
            '@radix-ui/react-switch',
            '@radix-ui/react-tabs',
          ],
          data: ['@tanstack/react-query', 'react-hook-form', '@hookform/resolvers', 'zod'],
        },
      },
    },
  },
})
