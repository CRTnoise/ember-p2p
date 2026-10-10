// records every engine call; stubs browser dialogs so flows can complete
(function () {
  window.__calls = []; window.__errs = []
  addEventListener('error', e => __errs.push(e.message)); addEventListener('unhandledrejection', e => __errs.push('rejection: ' + (e.reason && e.reason.message || e.reason)))
  for (const k of Object.keys(window.ember)) {
    const f = window.ember[k]
    if (typeof f === 'function' && !/^on[A-Z]/.test(k)) window.ember[k] = (...a) => { __calls.push({ k, a }); return f(...a) }
  }
  window.ember.getVideo = (...a) => { __calls.push({ k: 'getVideo', a }); return Promise.resolve({ ok: true, dataUrl: 'data:video/mp4;base64,AAAA' }) }
  window.confirm = () => true; window.prompt = () => ''
  try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async t => __calls.push({ k: 'clipboard', a: [t] }) } }) } catch {}
})()
