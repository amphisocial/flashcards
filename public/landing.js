(async () => {
  const { state, $, openAuth, initCommon, setStatus } = window.AppCommon;

  const startFree = () => {
    if (state.user) { window.location.href = '/app'; }
    else { openAuth('signup'); }
  };
  $('#ctaStart')?.addEventListener('click', startFree);
  $('#ctaStart2')?.addEventListener('click', startFree);
  // Founding-30 application: same entry point (signup), tagged so we can
  // route these signups to the teacher onboarding later.
  $('#ctaFounding')?.addEventListener('click', () => {
    try { sessionStorage.setItem('founding30', '1'); } catch (_) {}
    startFree();
  });

  await initCommon();

  const params = new URLSearchParams(window.location.search);
  if (params.has('login') && !state.user) {
    openAuth(params.get('login') === '0' ? 'signup' : 'login');
  }
  if (params.has('googleError')) {
    setStatus(`Google sign-in failed: ${params.get('googleError')}`, 'error');
    params.delete('googleError');
    const rest = params.toString();
    window.history.replaceState({}, '', rest ? `${window.location.pathname}?${rest}` : window.location.pathname);
  }
})();
