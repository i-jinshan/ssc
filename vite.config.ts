import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { lotteryProxyPlugin } from './server/vite-plugin';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  if (env.LOTTERY_PROXY) {
    process.env.LOTTERY_PROXY = env.LOTTERY_PROXY;
  }

  return {
    plugins: [react(), lotteryProxyPlugin()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    optimizeDeps: {
      exclude: ['lucide-react'],
    },
    ssr: {
      noExternal: ['undici'],
    },
  };
});
