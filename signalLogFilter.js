// A libsignal (dependência do baileys) imprime o SessionEntry INTEIRO no stdout
// a cada sessão aberta, fechada ou removida (console.info "Closing session:",
// "Opening session:", "Removing old closed session:" e o console.warn
// "Session already closed"). O objeto traz chaves privadas (ephemeralKeyPair
// .privKey), a rootKey e as chainKeys da sessão Signal — material que não pode
// ir parar em agregador de logs. Aqui a chamada inteira é descartada quando
// qualquer argumento é um SessionEntry; o resto do console passa intacto.
//
// A libsignal resolve `console` em tempo de chamada, então patchar depois dos
// imports basta. Compara pelo nome do construtor porque a classe não é
// exportada pela lib.

const PATCHED = Symbol.for('whatsapp-bridge.signalLogFilter')
const METHODS = ['info', 'warn', 'log']

export function isSignalSessionEntry(value) {
  return value != null && typeof value === 'object' && value.constructor?.name === 'SessionEntry'
}

export function silenceSignalSessionDump(target = console) {
  for (const method of METHODS) {
    const original = target[method]
    if (typeof original !== 'function' || original[PATCHED]) continue

    const filtered = (...args) => {
      if (args.some(isSignalSessionEntry)) return
      return original.apply(target, args)
    }
    filtered[PATCHED] = true
    target[method] = filtered
  }
}
