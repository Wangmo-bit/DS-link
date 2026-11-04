import fs from 'node:fs'
import path from 'node:path'
import { Ledger } from '../../src/core/ledger.js'

const [root, barrierFile, resultDir, index] = process.argv.slice(2)
while (!fs.existsSync(barrierFile)) await new Promise((resolve) => setTimeout(resolve, 5))

const resultFile = path.join(resultDir, `${index}.json`)
const ledger = new Ledger({ root })
try {
  await ledger.open()
  fs.writeFileSync(resultFile, JSON.stringify({ index, ok: true, pid: process.pid }))
} catch (error) {
  fs.writeFileSync(resultFile, JSON.stringify({ index, ok: false, code: error.code ?? 'error' }))
  process.exit(1)
}

const timer = setInterval(() => undefined, 1000)
const stop = async () => {
  clearInterval(timer)
  await ledger.close()
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
