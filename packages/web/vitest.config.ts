import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/i18n/setupAct.ts'],
    deps: {
      optimizer: {
        web: {
          include: ['react', 'react-dom', 'react-dom/client'],
        },
      },
    },
  },
});

