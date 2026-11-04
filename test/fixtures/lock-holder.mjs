import fs from 'node:fs'
import { Ledger } from '../../src/core/ledger.js'

const [root, readyFile] = process.argv.slice(2)
const ledger = new Ledger({ root })
try {
  await ledger.open()
  fs.writeFileSync(readyFile, JSON.stringify({ ok: true, pid: process.pid }))
  process.stdout.write(`${JSON.stringify({ ok: true, pid: process.pid })}\n`)
} catch (error) {
  fs.writeFileSync(readyFile, JSON.stringify({ ok: false, code: error.code ?? 'error' }))
  process.stdout.write(`${JSON.stringify({ ok: false, code: error.code ?? 'error' })}\n`)
  process.exit(1)
}

const timer = setInterval(() => undefined, 1000)
process.on('SIGTERM', async () => {
  clearInterval(timer)
  await ledger.close()
  process.exit(0)
})
process.on('SIGINT', async () => {
  clearInterval(timer)
  await ledger.close()
  process.exit(0)
})
