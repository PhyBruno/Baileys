import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSignalSessionEntry, silenceSignalSessionDump } from '../signalLogFilter.js'

// Mesmo nome de classe que a libsignal usa; valores sintéticos.
class SessionEntry {
  constructor() {
    this.registrationId = 1
    this.currentRatchet = { rootKey: Buffer.from('chave-sintetica') }
  }
}

function fakeConsole() {
  const calls = []
  const make = (method) => (...args) => calls.push([method, ...args])
  return { calls, info: make('info'), warn: make('warn'), log: make('log'), error: make('error') }
}

test('isSignalSessionEntry reconhece só o SessionEntry', () => {
  assert.equal(isSignalSessionEntry(new SessionEntry()), true)
  assert.equal(isSignalSessionEntry({ registrationId: 1 }), false)
  assert.equal(isSignalSessionEntry('Closing session:'), false)
  assert.equal(isSignalSessionEntry(null), false)
  assert.equal(isSignalSessionEntry(undefined), false)
})

test('descarta info e warn que carregam um SessionEntry', () => {
  const target = fakeConsole()
  silenceSignalSessionDump(target)

  target.info('Closing session:', new SessionEntry())
  target.info('Opening session:', new SessionEntry())
  target.info('Removing old closed session:', new SessionEntry())
  target.warn('Session already closed', new SessionEntry())

  assert.deepEqual(target.calls, [])
})

test('mensagens sem SessionEntry passam intactas', () => {
  const target = fakeConsole()
  silenceSignalSessionDump(target)

  target.warn('Closing open session in favor of incoming prekey bundle')
  target.info('conectado', { id: 1 })
  target.error('erro real', new SessionEntry())

  assert.deepEqual(target.calls, [
    ['warn', 'Closing open session in favor of incoming prekey bundle'],
    ['info', 'conectado', { id: 1 }],
    // console.error não é filtrado: erro nunca pode sumir em silêncio.
    ['error', 'erro real', new SessionEntry()]
  ])
})

test('chamar duas vezes não empilha o filtro', () => {
  const target = fakeConsole()
  silenceSignalSessionDump(target)
  const depoisDaPrimeira = target.info
  silenceSignalSessionDump(target)

  assert.equal(target.info, depoisDaPrimeira)
  target.info('uma vez só')
  assert.deepEqual(target.calls, [['info', 'uma vez só']])
})
