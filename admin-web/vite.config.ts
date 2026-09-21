import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

export default defineConfig({
  base: '/velotradex/',
  plugins: [
    vue(),
    AutoImport({
      resolvers: [ElementPlusResolver()],
    }),
    Components({
      resolvers: [ElementPlusResolver()],
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vue-vendor': ['vue', 'vue-router', 'pinia'],
          'element-plus': ['element-plus'],
          'echarts': ['echarts/core'],
        }
      }
    }
  },
  server: {
    proxy: {
      '/ct-api': {
        target: process.env.CLOUD_URL || 'http://localhost:3010',
        rewrite: (path) => path.replace(/^\/ct-api/, '/api'),
        changeOrigin: true
      }
    }
  }
})
