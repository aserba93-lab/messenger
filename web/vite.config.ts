import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const webRoot = dirname(fileURLToPath(import.meta.url))

/** Установщик Electron открывает index.html как file:// — пути к assets должны быть относительными. */
const electronBuild = process.env.ELECTRON_BUILD === '1' || process.env.ELECTRON_BUILD === 'true'

function gitShort(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8', cwd: repoRoot }).trim()
  } catch {
    return 'unknown'
  }
}

/** Пишет dist/build-info.json — откройте https://домен/build-info.json после деплоя, чтобы увидеть, что реально отдаёт nginx. */
function buildInfoPlugin(): Plugin {
  return {
    name: 'build-info-json',
    closeBundle() {
      const builtAt = new Date().toISOString()
      const gitSha = gitShort()
      const outDir = join(webRoot, 'dist')
      const payload = {
        builtAt,
        gitSha,
        hint: 'Сравните gitSha с «git log -1» на сервере. Если здесь старое — nginx/CDN отдаёт не тот dist.',
      }
      writeFileSync(join(outDir, 'build-info.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: electronBuild ? './' : '/',
  plugins: [react(), buildInfoPlugin()],
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __GIT_SHA__: JSON.stringify(gitShort()),
  },
})
